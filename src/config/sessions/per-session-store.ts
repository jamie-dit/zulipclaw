/**
 * Per-session file storage implementation.
 *
 * Architecture:
 *   agents/main/sessions/
 *     index.json           # Lightweight: sessionKey → {sessionId, updatedAt, sessionFile?}
 *     data/
 *       <sessionId>.json   # Full SessionEntry for that session
 *
 * Migration: on first load, if sessions.json exists but index.json does not,
 * the monolithic store is automatically split into per-session files.
 *
 * Locking:
 *   - Per-session operations (updateSessionDataEntry) lock only data/<sessionId>.json
 *   - Index updates use a short-lived lock on index.json
 *   - Full-store operations (saveFullStore) lock index.json and write everything
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadSnapshot } from "./skills-snapshot-store.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/per-session-store");

// ============================================================================
// Path helpers
// ============================================================================

export function resolveIndexPath(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "index.json");
}

export function resolveDataDir(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "data");
}

export function resolveSessionDataPath(storePath: string, sessionId: string): string {
  return path.join(resolveDataDir(storePath), `${sessionId}.json`);
}

// ============================================================================
// Index types
// ============================================================================

export type SessionIndexEntry = {
  sessionId: string;
  updatedAt: number;
  /** Optional relative path hint for the transcript/session file (not the data file). */
  sessionFile?: string;
};

export type SessionIndex = Record<string, SessionIndexEntry>;

// ============================================================================
// Per-session cache
// ============================================================================

type PerSessionCacheEntry = {
  entry: SessionEntry;
  loadedAt: number;
  mtimeMs?: number;
};

const PER_SESSION_CACHE = new Map<string, PerSessionCacheEntry>();
const PER_SESSION_CACHE_TTL_MS = 45_000;

function getFileMtimeMsSync(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

async function getFileMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

export function invalidatePerSessionCache(dataPath: string): void {
  PER_SESSION_CACHE.delete(dataPath);
}

export function clearPerSessionCacheForTest(): void {
  PER_SESSION_CACHE.clear();
}

/**
 * Remove all per-session layout files for a given storePath.
 * This includes index.json and the data/ subdirectory.
 * Safe to call even if files don't exist.
 * Only applies to canonical sessions.json stores.
 */
export async function removePerSessionLayoutFiles(storePath: string): Promise<void> {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) !== "sessions.json") {
    return;
  }
  const indexPath = resolveIndexPath(storePath);
  const dataDir = resolveDataDir(storePath);
  await Promise.all([
    fsp.rm(indexPath, { force: true }).catch(() => undefined),
    fsp.rm(dataDir, { recursive: true, force: true }).catch(() => undefined),
  ]);
  // Also clear the per-session cache for this store.
  for (const key of PER_SESSION_CACHE.keys()) {
    if (key.startsWith(dataDir)) {
      PER_SESSION_CACHE.delete(key);
    }
  }
}

function isPerSessionCacheValid(entry: PerSessionCacheEntry): boolean {
  return Date.now() - entry.loadedAt <= PER_SESSION_CACHE_TTL_MS;
}

// ============================================================================
// Atomic write helper
// ============================================================================

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fsp.rename(tmp, filePath);
    try {
      await fsp.chmod(filePath, 0o600);
    } catch {
      // Best-effort chmod after rename.
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return; // Directory removed under us (e.g., test cleanup).
    }
    throw err;
  }
}

// ============================================================================
// Index load / save
// ============================================================================

export function loadIndex(storePath: string): SessionIndex {
  const indexPath = resolveIndexPath(storePath);
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionIndex;
    }
  } catch {
    // Missing or corrupt index — start fresh.
  }
  return {};
}

export async function saveIndex(storePath: string, index: SessionIndex): Promise<void> {
  const indexPath = resolveIndexPath(storePath);
  await atomicWriteJson(indexPath, index);
}

/**
 * Merge a single index entry into the existing index atomically.
 * Uses a short-lived lock on index.json to avoid concurrent overwrites.
 */
export async function upsertIndexEntry(
  storePath: string,
  sessionKey: string,
  entry: SessionIndexEntry,
): Promise<void> {
  const indexPath = resolveIndexPath(storePath);
  const lock = await acquireSessionWriteLock({
    sessionFile: indexPath,
    timeoutMs: 10_000,
    staleMs: 30_000,
  });
  try {
    const index = loadIndex(storePath);
    index[sessionKey] = entry;
    await saveIndex(storePath, index);
  } finally {
    await lock.release().catch(() => undefined);
  }
}

// ============================================================================
// Session data load / save
// ============================================================================

export function loadSessionData(dataPath: string): SessionEntry | undefined {
  // Check cache first.
  const cached = PER_SESSION_CACHE.get(dataPath);
  if (cached && isPerSessionCacheValid(cached)) {
    const currentMtime = getFileMtimeMsSync(dataPath);
    if (currentMtime === cached.mtimeMs) {
      return structuredClone(cached.entry);
    }
    invalidatePerSessionCache(dataPath);
  }

  try {
    const raw = fs.readFileSync(dataPath, "utf-8");
    if (!raw.trim()) {
      return undefined;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entry = parsed as SessionEntry;
    const mtime = getFileMtimeMsSync(dataPath);
    PER_SESSION_CACHE.set(dataPath, {
      entry: structuredClone(entry),
      loadedAt: Date.now(),
      mtimeMs: mtime,
    });
    return structuredClone(entry);
  } catch {
    return undefined;
  }
}

export async function saveSessionData(dataPath: string, entry: SessionEntry): Promise<void> {
  invalidatePerSessionCache(dataPath);
  await atomicWriteJson(dataPath, entry);
  // Update cache after save.
  const mtime = await getFileMtimeMs(dataPath);
  PER_SESSION_CACHE.set(dataPath, {
    entry: structuredClone(entry),
    loadedAt: Date.now(),
    mtimeMs: mtime,
  });
}

// ============================================================================
// Full store load (builds Record<string, SessionEntry> from index + data files)
// ============================================================================

/**
 * Check whether the per-session layout exists for a given storePath.
 *
 * Only enables per-session layout for canonical `sessions.json` stores.
 * Arbitrary `.json` files used in tests or custom stores stay on the
 * legacy monolithic path to avoid cross-file index.json collisions when
 * multiple store files share the same parent directory (e.g. /tmp/).
 */
export function isPerSessionLayoutPresent(storePath: string): boolean {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) !== "sessions.json") {
    return false;
  }
  const indexPath = resolveIndexPath(storePath);
  return fs.existsSync(indexPath);
}

/**
 * Load the full session store from per-session files.
 * Reads index.json, then loads each session's data file.
 * Missing/corrupt data files are skipped gracefully.
 */
export function loadStoreFromPerSessionFiles(
  storePath: string,
  opts: { skipCache?: boolean } = {},
): Record<string, SessionEntry> {
  const index = loadIndex(storePath);
  const dataDir = resolveDataDir(storePath);
  const store: Record<string, SessionEntry> = {};

  for (const [sessionKey, indexEntry] of Object.entries(index)) {
    if (!indexEntry?.sessionId) {
      continue;
    }
    const dataPath = path.join(dataDir, `${indexEntry.sessionId}.json`);
    if (opts.skipCache) {
      invalidatePerSessionCache(dataPath);
    }
    const entry = loadSessionData(dataPath);
    if (entry) {
      store[sessionKey] = entry;
    }
  }

  // Hydrate content-addressed skillsSnapshot refs back to inline snapshots.
  // (Same as the monolithic load path in store.ts.)
  for (const entry of Object.values(store)) {
    if (!entry || entry.skillsSnapshot || !entry.skillsSnapshotRef) {
      continue;
    }
    try {
      const snapshot = loadSnapshot(storePath, entry.skillsSnapshotRef);
      if (snapshot) {
        entry.skillsSnapshot = snapshot;
      }
    } catch {
      // Best-effort: snapshot file may not exist yet.
    }
  }

  return store;
}

// ============================================================================
// Full store save (writes all session data files + index)
// ============================================================================

/**
 * Save the full session store to per-session files.
 * Writes each session to its own data file, then writes index.json.
 * Called inside an existing lock (does NOT acquire its own lock).
 */
export async function saveStoreToPerSessionFiles(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  const dataDir = resolveDataDir(storePath);
  await fsp.mkdir(dataDir, { recursive: true });

  const index: SessionIndex = {};

  await Promise.all(
    Object.entries(store).map(async ([sessionKey, entry]) => {
      if (!entry?.sessionId) {
        return;
      }
      const dataPath = path.join(dataDir, `${entry.sessionId}.json`);
      await saveSessionData(dataPath, entry);
      index[sessionKey] = {
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt ?? 0,
        sessionFile: entry.sessionFile,
      };
    }),
  );

  await saveIndex(storePath, index);
}

// ============================================================================
// Migration: monolithic sessions.json → per-session layout
// ============================================================================

/**
 * Migrate from the monolithic sessions.json format to per-session files.
 * Safe to call multiple times — skips migration if index.json already exists.
 * Returns the number of sessions migrated (or 0 if no migration needed).
 */
export async function migrateFromMonolithic(
  storePath: string,
  monolithicStore: Record<string, SessionEntry>,
): Promise<number> {
  // Only migrate canonical sessions.json stores.
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) !== "sessions.json") {
    return 0;
  }

  const indexPath = resolveIndexPath(storePath);

  // Already migrated.
  if (fs.existsSync(indexPath)) {
    return 0;
  }

  const entries = Object.entries(monolithicStore);
  if (entries.length === 0) {
    // Write empty index to signal migration complete.
    await saveIndex(storePath, {});
    return 0;
  }

  log.info("migrating monolithic session store to per-session files", {
    sessions: entries.length,
    storePath: path.basename(path.dirname(storePath)),
  });

  await saveStoreToPerSessionFiles(storePath, monolithicStore);

  log.info("migration complete", { sessions: entries.length });
  return entries.length;
}

// ============================================================================
// Per-session lock + update
// ============================================================================

/**
 * Update a single session entry using per-session file locking.
 * Only locks/reads/writes the single session data file.
 * Also upserts the index entry (uses short index lock).
 */
export async function updateSessionDataEntry(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  merge: (existing: SessionEntry | undefined, patch: Partial<SessionEntry>) => SessionEntry;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, sessionId, merge, createIfMissing = false } = params;
  const dataPath = resolveSessionDataPath(storePath, sessionId);

  const lock = await acquireSessionWriteLock({
    sessionFile: dataPath,
    timeoutMs: 10_000,
    staleMs: 30_000,
  });

  try {
    const existing = loadSessionData(dataPath);

    if (!existing && !createIfMissing) {
      return null;
    }

    const patch = await params.update(existing ?? ({ sessionId, updatedAt: 0 } as SessionEntry));
    if (!patch) {
      return existing ?? null;
    }

    const next = merge(existing, patch);
    await saveSessionData(dataPath, next);

    // Update the index entry (lightweight).
    await upsertIndexEntry(storePath, sessionKey, {
      sessionId: next.sessionId,
      updatedAt: next.updatedAt ?? 0,
      sessionFile: next.sessionFile,
    });

    return next;
  } finally {
    await lock.release().catch(() => undefined);
  }
}
