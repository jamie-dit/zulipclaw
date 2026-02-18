import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  archiveIdleSessions,
  clearSessionLRUForTest,
  evictEphemeralSessions,
  getSessionLazy,
  getSessionStats,
  resolveArchivePath,
  restoreArchivedSession,
  SessionLRUCache,
} from "./lifecycle.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt, ...overrides };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let fixtureRoot = "";
let fixtureCount = 0;

async function makeTmpDir(): Promise<string> {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

async function makeStorePath(
  dir: string,
  initial: Record<string, SessionEntry> = {},
): Promise<string> {
  const storePath = path.join(dir, "sessions.json");
  await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
  return storePath;
}

beforeAll(async () => {
  fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-test-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

afterEach(() => {
  clearSessionLRUForTest();
});

// ===========================================================================
// Feature 1: Auto-archive
// ===========================================================================

describe("archiveIdleSessions", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    storePath = await makeStorePath(tmpDir);
  });

  it("resolveArchivePath returns <storeDir>/archive/sessions.json by default", () => {
    expect(resolveArchivePath("/data/agents/main/sessions/sessions.json")).toBe(
      "/data/agents/main/sessions/archive/sessions.json",
    );
  });

  it("resolveArchivePath uses custom dir", () => {
    expect(resolveArchivePath("/data/sessions.json", "old")).toBe("/data/old/sessions.json");
  });

  it("moves idle entries to archive, leaves fresh entries in store", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      idle1: makeEntry(now - 31 * DAY_MS),
      idle2: makeEntry(now - 40 * DAY_MS),
      fresh: makeEntry(now - 5 * DAY_MS),
    };

    const result = await archiveIdleSessions(store, storePath, { idleDays: 30, nowMs: now });

    expect(result.archived).toBe(2);
    expect(store).not.toHaveProperty("idle1");
    expect(store).not.toHaveProperty("idle2");
    expect(store).toHaveProperty("fresh");

    // Verify the archive file on disk.
    const archiveContent = fs.readFileSync(result.archivePath, "utf-8");
    const archived = JSON.parse(archiveContent) as Record<string, SessionEntry>;
    expect(Object.keys(archived)).toHaveLength(2);
    expect(archived).toHaveProperty("idle1");
    expect(archived).toHaveProperty("idle2");
  });

  it("preserves existing archive entries (merge, not overwrite)", async () => {
    const now = Date.now();
    const archivePath = resolveArchivePath(storePath);
    await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
    await fsPromises.writeFile(
      archivePath,
      JSON.stringify({ existing: makeEntry(now - 60 * DAY_MS) }, null, 2),
      "utf-8",
    );

    const store: Record<string, SessionEntry> = {
      idle: makeEntry(now - 35 * DAY_MS),
    };

    await archiveIdleSessions(store, storePath, { idleDays: 30, nowMs: now });

    const archived = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
    expect(Object.keys(archived)).toHaveLength(2);
    expect(archived).toHaveProperty("existing");
    expect(archived).toHaveProperty("idle");
  });

  it("does nothing when all entries are fresh", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      fresh: makeEntry(now - 1 * DAY_MS),
    };

    const result = await archiveIdleSessions(store, storePath, { idleDays: 30, nowMs: now });

    expect(result.archived).toBe(0);
    expect(store).toHaveProperty("fresh");
    expect(fs.existsSync(result.archivePath)).toBe(false);
  });

  it("does not archive entries without updatedAt", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      noTs: { sessionId: crypto.randomUUID(), updatedAt: undefined as unknown as number },
    };

    const result = await archiveIdleSessions(store, storePath, { idleDays: 30, nowMs: now });

    expect(result.archived).toBe(0);
    expect(store).toHaveProperty("noTs");
  });
});

describe("restoreArchivedSession", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    storePath = await makeStorePath(tmpDir);
  });

  it("restores entry from archive back into store", async () => {
    const now = Date.now();
    const entry = makeEntry(now - 35 * DAY_MS);
    const archivePath = resolveArchivePath(storePath);
    await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
    await fsPromises.writeFile(
      archivePath,
      JSON.stringify({ "sess:archived": entry }, null, 2),
      "utf-8",
    );

    const store: Record<string, SessionEntry> = {};
    const restored = restoreArchivedSession({
      store,
      sessionKey: "sess:archived",
      storePath,
    });

    expect(restored).toBeDefined();
    expect(store["sess:archived"]).toBeDefined();
    expect(store["sess:archived"]?.sessionId).toBe(entry.sessionId);
  });

  it("returns undefined when session not in archive", () => {
    const store: Record<string, SessionEntry> = {};
    const restored = restoreArchivedSession({
      store,
      sessionKey: "nonexistent",
      storePath,
    });
    expect(restored).toBeUndefined();
    expect(store).not.toHaveProperty("nonexistent");
  });
});

// ===========================================================================
// Feature 2: TTL eviction
// ===========================================================================

describe("evictEphemeralSessions", () => {
  it("removes expired sub-agent sessions", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:abc123": makeEntry(now - 8 * DAY_MS),
      "agent:main:subagent:fresh": makeEntry(now - 1 * DAY_MS),
      "agent:main:normal": makeEntry(now - 8 * DAY_MS),
    };

    const result = evictEphemeralSessions(store, { ttlDays: 7, nowMs: now });

    expect(result.evicted).toBe(1);
    expect(store).not.toHaveProperty("agent:main:subagent:abc123");
    expect(store).toHaveProperty("agent:main:subagent:fresh");
    // Normal (non-ephemeral) sessions are NOT evicted even if old.
    expect(store).toHaveProperty("agent:main:normal");
  });

  it("removes expired cron sessions", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job1": makeEntry(now - 10 * DAY_MS),
      "agent:main:cron:job2:run:uuid-1": makeEntry(now - 1 * DAY_MS),
    };

    const result = evictEphemeralSessions(store, { ttlDays: 7, nowMs: now });

    expect(result.evicted).toBe(1);
    expect(store).not.toHaveProperty("agent:main:cron:job1");
    expect(store).toHaveProperty("agent:main:cron:job2:run:uuid-1");
  });

  it("evicts nothing when all ephemeral sessions are fresh", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:new": makeEntry(now - 1 * DAY_MS),
    };

    const result = evictEphemeralSessions(store, { ttlDays: 7, nowMs: now });
    expect(result.evicted).toBe(0);
  });

  it("leaves non-ephemeral sessions untouched regardless of age", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:zulip:channel:marcel:topic:general": makeEntry(now - 100 * DAY_MS),
    };

    const result = evictEphemeralSessions(store, { ttlDays: 7, nowMs: now });
    expect(result.evicted).toBe(0);
    expect(store).toHaveProperty("agent:main:zulip:channel:marcel:topic:general");
  });
});

// ===========================================================================
// Feature 3: Lazy-load LRU
// ===========================================================================

describe("SessionLRUCache", () => {
  it("stores and retrieves entries", () => {
    const lru = new SessionLRUCache(5);
    const entry = makeEntry(Date.now());
    lru.set("key1", entry);
    expect(lru.get("key1")).toEqual(entry);
  });

  it("evicts least-recently-used entry when over capacity", () => {
    const lru = new SessionLRUCache(3);
    lru.set("a", makeEntry(1));
    lru.set("b", makeEntry(2));
    lru.set("c", makeEntry(3));
    lru.set("d", makeEntry(4)); // should evict "a" (LRU)

    expect(lru.size).toBe(3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBeDefined();
    expect(lru.get("c")).toBeDefined();
    expect(lru.get("d")).toBeDefined();
  });

  it("access refreshes recency (MRU moves to front)", () => {
    const lru = new SessionLRUCache(3);
    lru.set("a", makeEntry(1));
    lru.set("b", makeEntry(2));
    lru.set("c", makeEntry(3));
    lru.get("a"); // "a" is now MRU
    lru.set("d", makeEntry(4)); // "b" should be evicted (now LRU)

    expect(lru.get("a")).toBeDefined();
    expect(lru.get("b")).toBeUndefined();
  });

  it("records lastAccessedAt timestamps", () => {
    const lru = new SessionLRUCache(5);
    const before = Date.now();
    lru.set("k", makeEntry(1));
    const after = Date.now();
    const ts = lru.lastAccessedAt("k");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("delete removes entry", () => {
    const lru = new SessionLRUCache(5);
    lru.set("x", makeEntry(1));
    expect(lru.delete("x")).toBe(true);
    expect(lru.get("x")).toBeUndefined();
    expect(lru.delete("x")).toBe(false);
  });

  it("clear empties the cache", () => {
    const lru = new SessionLRUCache(5);
    lru.set("a", makeEntry(1));
    lru.set("b", makeEntry(2));
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get("a")).toBeUndefined();
  });

  it("keys() returns keys most-recent-first", () => {
    const lru = new SessionLRUCache(5);
    lru.set("a", makeEntry(1));
    lru.set("b", makeEntry(2));
    lru.set("c", makeEntry(3));
    expect(lru.keys()).toEqual(["c", "b", "a"]);
    lru.get("a"); // refresh "a"
    expect(lru.keys()).toEqual(["a", "c", "b"]);
  });
});

describe("getSessionLazy", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    storePath = await makeStorePath(tmpDir);
  });

  it("returns entry from store on first access (LRU miss)", () => {
    const entry = makeEntry(Date.now());
    const store: Record<string, SessionEntry> = { "sess:a": entry };

    const result = getSessionLazy({ store, storePath, sessionKey: "sess:a" });
    expect(result?.sessionId).toBe(entry.sessionId);
  });

  it("returns entry from LRU on second access (LRU hit)", () => {
    const entry = makeEntry(Date.now());
    const store: Record<string, SessionEntry> = { "sess:b": entry };

    getSessionLazy({ store, storePath, sessionKey: "sess:b" }); // populates LRU
    delete store["sess:b"]; // simulate store mutation

    // Should still return from LRU.
    const result = getSessionLazy({ store, storePath, sessionKey: "sess:b" });
    expect(result?.sessionId).toBe(entry.sessionId);
  });

  it("returns undefined when session not in store or archive", () => {
    const store: Record<string, SessionEntry> = {};
    const result = getSessionLazy({ store, storePath, sessionKey: "missing" });
    expect(result).toBeUndefined();
  });

  it("restores and returns entry from archive when not in main store", async () => {
    const now = Date.now();
    const entry = makeEntry(now - 35 * DAY_MS);
    const archivePath = resolveArchivePath(storePath);
    await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
    await fsPromises.writeFile(
      archivePath,
      JSON.stringify({ "sess:archived": entry }, null, 2),
      "utf-8",
    );

    const store: Record<string, SessionEntry> = {};
    const result = getSessionLazy({ store, storePath, sessionKey: "sess:archived" });
    expect(result?.sessionId).toBe(entry.sessionId);
    // Entry should now be restored into active store.
    expect(store["sess:archived"]).toBeDefined();
  });
});

// ===========================================================================
// Feature 4: Session stats
// ===========================================================================

describe("getSessionStats", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  it("returns zeroed stats for empty store and no file", () => {
    storePath = path.join(tmpDir, "sessions.json");
    const stats = getSessionStats({}, storePath);
    expect(stats.activeCount).toBe(0);
    expect(stats.ephemeralCount).toBe(0);
    expect(stats.archivedCount).toBe(0);
    expect(stats.storeSizeBytes).toBe(0);
    expect(stats.archiveSizeBytes).toBe(0);
    expect(stats.lruCachedCount).toBe(0);
  });

  it("counts active and ephemeral sessions", () => {
    const now = Date.now();
    storePath = path.join(tmpDir, "sessions.json");
    const store: Record<string, SessionEntry> = {
      "agent:main:zulip:direct": makeEntry(now),
      "agent:main:subagent:abc": makeEntry(now),
      "agent:main:cron:job1": makeEntry(now),
    };

    const stats = getSessionStats(store, storePath);
    expect(stats.activeCount).toBe(3);
    expect(stats.ephemeralCount).toBe(2);
  });

  it("reflects archived count from on-disk archive", async () => {
    storePath = await makeStorePath(tmpDir);
    const archivePath = resolveArchivePath(storePath);
    await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
    await fsPromises.writeFile(
      archivePath,
      JSON.stringify({
        old1: makeEntry(Date.now() - 40 * DAY_MS),
        old2: makeEntry(Date.now() - 50 * DAY_MS),
      }),
      "utf-8",
    );

    const stats = getSessionStats({}, storePath);
    expect(stats.archivedCount).toBe(2);
    expect(stats.archiveSizeBytes).toBeGreaterThan(0);
  });

  it("includes LRU cache stats for this store", () => {
    storePath = path.join(tmpDir, "sessions.json");
    const entry = makeEntry(Date.now());
    const store: Record<string, SessionEntry> = { "sess:x": entry };

    getSessionLazy({ store, storePath, sessionKey: "sess:x" }); // populates LRU

    const stats = getSessionStats(store, storePath);
    expect(stats.lruCachedCount).toBe(1);
    expect(stats.lastAccessTimes["sess:x"]).toBeGreaterThan(0);
  });

  it("includes updatedAt times per key", () => {
    const now = Date.now();
    storePath = path.join(tmpDir, "sessions.json");
    const store: Record<string, SessionEntry> = {
      "sess:a": makeEntry(now - 1000),
      "sess:b": makeEntry(now - 2000),
    };

    const stats = getSessionStats(store, storePath);
    expect(stats.updatedAtTimes["sess:a"]).toBe(now - 1000);
    expect(stats.updatedAtTimes["sess:b"]).toBe(now - 2000);
  });
});
