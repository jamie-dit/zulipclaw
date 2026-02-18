/**
 * Session lifecycle management:
 *
 * 1. Auto-archive  — idle sessions moved to `archive/sessions.json`, transparently
 *                    restored on next access.
 * 2. TTL eviction  — cron/sub-agent sessions purged after a configurable TTL.
 * 3. Lazy-load LRU — in-memory LRU cache (max 20 entries) for on-demand session access.
 * 4. Session stats — aggregate counts, sizes, and last-access timestamps.
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../sessions/session-key-utils.js";
import { loadConfig } from "../config.js";
import type { SessionArchiveConfig, SessionEphemeralTtlConfig } from "../types.base.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/lifecycle");

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ARCHIVE_IDLE_DAYS = 30;
const DEFAULT_ARCHIVE_DIR = "archive";
const DEFAULT_EPHEMERAL_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================================
// Config resolution
// ============================================================================

function resolveArchiveConfig(): Required<SessionArchiveConfig> {
  let archive: SessionArchiveConfig | undefined;
  try {
    archive = loadConfig().session?.archive;
  } catch {
    // Config may not be available in tests.
  }
  return {
    idleDays: archive?.idleDays ?? DEFAULT_ARCHIVE_IDLE_DAYS,
    dir: archive?.dir ?? DEFAULT_ARCHIVE_DIR,
  };
}

function resolveEphemeralTtlConfig(): Required<SessionEphemeralTtlConfig> {
  let cfg: SessionEphemeralTtlConfig | undefined;
  try {
    cfg = loadConfig().session?.ephemeralTtl;
  } catch {
    // Config may not be available in tests.
  }
  return {
    ttlDays: cfg?.ttlDays ?? DEFAULT_EPHEMERAL_TTL_DAYS,
  };
}

// ============================================================================
// Archive path helpers
// ============================================================================

export function resolveArchivePath(storePath: string, archiveDir?: string): string {
  const dir = archiveDir ?? DEFAULT_ARCHIVE_DIR;
  return path.join(path.dirname(storePath), dir, path.basename(storePath));
}

function loadJsonStore(filePath: string): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, SessionEntry>;
    }
  } catch {
    // Missing or corrupt file — treat as empty.
  }
  return {};
}

async function saveJsonStore(filePath: string, store: Record<string, SessionEntry>): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    await fsPromises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fsPromises.rename(tmp, filePath);
  } finally {
    await fsPromises.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// ============================================================================
// Feature 1: Auto-archive
// ============================================================================

export type ArchiveIdleSessionsResult = {
  archived: number;
  archivePath: string;
};

/**
 * Move sessions that have been idle longer than `idleDays` from `store` into
 * the archive file next to `storePath`.  Mutates `store` in-place.
 *
 * @param store      In-memory session store (will be mutated).
 * @param storePath  On-disk path of sessions.json (used to derive archive path).
 * @param opts       Override config values (useful for tests).
 */
export async function archiveIdleSessions(
  store: Record<string, SessionEntry>,
  storePath: string,
  opts: { idleDays?: number; archiveDir?: string; nowMs?: number } = {},
): Promise<ArchiveIdleSessionsResult> {
  const idleDays = opts.idleDays ?? resolveArchiveConfig().idleDays;
  const archiveDir = opts.archiveDir ?? resolveArchiveConfig().dir;
  const cutoffMs = (opts.nowMs ?? Date.now()) - idleDays * MS_PER_DAY;
  const archivePath = resolveArchivePath(storePath, archiveDir);

  // Load existing archive so we can merge without losing previously archived entries.
  const archiveStore = loadJsonStore(archivePath);

  let archived = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    if (entry.updatedAt != null && entry.updatedAt < cutoffMs) {
      archiveStore[key] = entry;
      delete store[key];
      archived++;
    }
  }

  if (archived > 0) {
    await saveJsonStore(archivePath, archiveStore);
    log.info("archived idle sessions", { archived, idleDays, archivePath });
  }

  return { archived, archivePath };
}

/**
 * Restore a single session entry from the archive back into `store`.
 * Returns the restored entry, or `undefined` if not found in the archive.
 *
 * Does NOT persist changes to disk — caller must save the store and archive
 * afterwards (or call within `updateSessionStore`).
 */
export function restoreArchivedSession(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  archiveDir?: string;
}): SessionEntry | undefined {
  const { store, sessionKey, storePath, archiveDir } = params;
  const archivePath = resolveArchivePath(storePath, archiveDir ?? resolveArchiveConfig().dir);
  const archiveStore = loadJsonStore(archivePath);
  const entry = archiveStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  // Move back to active store.
  store[sessionKey] = entry;

  // Remove from archive (best-effort, fire-and-forget).
  delete archiveStore[sessionKey];
  saveJsonStore(archivePath, archiveStore).catch((err: unknown) => {
    log.warn("lifecycle: failed to update archive after restore: " + String(err));
  });

  log.info("restored archived session", { sessionKey });
  return entry;
}

// ============================================================================
// Feature 2: TTL eviction for ephemeral (cron / sub-agent) sessions
// ============================================================================

export type EvictEphemeralSessionsResult = {
  evicted: number;
};

/**
 * Purge cron and sub-agent session entries that are older than `ttlDays`.
 * Detection: key matches `isCronSessionKey` OR `isSubagentSessionKey`.
 * Mutates `store` in-place.
 */
export function evictEphemeralSessions(
  store: Record<string, SessionEntry>,
  opts: { ttlDays?: number; nowMs?: number } = {},
): EvictEphemeralSessionsResult {
  const ttlDays = opts.ttlDays ?? resolveEphemeralTtlConfig().ttlDays;
  const cutoffMs = (opts.nowMs ?? Date.now()) - ttlDays * MS_PER_DAY;

  let evicted = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const isEphemeral = isCronSessionKey(key) || isSubagentSessionKey(key);
    if (!isEphemeral) {
      continue;
    }
    const updatedAt = entry.updatedAt ?? 0;
    if (updatedAt < cutoffMs) {
      delete store[key];
      evicted++;
    }
  }

  if (evicted > 0) {
    log.info("evicted ephemeral sessions", { evicted, ttlDays });
  }
  return { evicted };
}

// ============================================================================
// Feature 3: Lazy-load LRU cache for session entries
// ============================================================================

const LRU_MAX_SIZE = 20;

type LRUNode<V> = {
  key: string;
  value: V;
  prev: LRUNode<V> | null;
  next: LRUNode<V> | null;
};

/**
 * Simple doubly-linked-list LRU cache.
 * Head = most-recently used, Tail = least-recently used (eviction candidate).
 */
export class SessionLRUCache {
  private readonly maxSize: number;
  private readonly map = new Map<string, LRUNode<SessionEntry>>();
  private head: LRUNode<SessionEntry> | null = null;
  private tail: LRUNode<SessionEntry> | null = null;
  /** Timestamp of last access per key (epoch ms). */
  private readonly accessedAt = new Map<string, number>();

  constructor(maxSize = LRU_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.map.size;
  }

  /** Returns all keys currently in the LRU (most-recent first). */
  keys(): string[] {
    const keys: string[] = [];
    let node = this.head;
    while (node) {
      keys.push(node.key);
      node = node.next;
    }
    return keys;
  }

  get(key: string): SessionEntry | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }
    this._moveToHead(node);
    this.accessedAt.set(key, Date.now());
    return node.value;
  }

  set(key: string, entry: SessionEntry): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = entry;
      this._moveToHead(existing);
      this.accessedAt.set(key, Date.now());
      return;
    }
    const node: LRUNode<SessionEntry> = { key, value: entry, prev: null, next: null };
    this.map.set(key, node);
    this._addToHead(node);
    this.accessedAt.set(key, Date.now());
    if (this.map.size > this.maxSize) {
      this._evictTail();
    }
  }

  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) {
      return false;
    }
    this._removeNode(node);
    this.map.delete(key);
    this.accessedAt.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.accessedAt.clear();
    this.head = null;
    this.tail = null;
  }

  /** Returns the last-access timestamp (epoch ms) for a key, or undefined. */
  lastAccessedAt(key: string): number | undefined {
    return this.accessedAt.get(key);
  }

  private _addToHead(node: LRUNode<SessionEntry>): void {
    node.next = this.head;
    node.prev = null;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }

  private _removeNode(node: LRUNode<SessionEntry>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private _moveToHead(node: LRUNode<SessionEntry>): void {
    if (node === this.head) {
      return;
    }
    this._removeNode(node);
    this._addToHead(node);
  }

  private _evictTail(): void {
    if (!this.tail) {
      return;
    }
    const evicted = this.tail;
    this._removeNode(evicted);
    this.map.delete(evicted.key);
    this.accessedAt.delete(evicted.key);
  }
}

/**
 * Global LRU cache shared across callers within the same process.
 * Keyed by `${storePath}::${sessionKey}`.
 */
const GLOBAL_LRU = new SessionLRUCache(LRU_MAX_SIZE);

/** Composite cache key. */
function lruKey(storePath: string, sessionKey: string): string {
  return `${storePath}::${sessionKey}`;
}

/**
 * Get a session entry with lazy-load semantics:
 * 1. Check the in-process LRU cache.
 * 2. If missing, look up in the provided `store` map (already loaded from disk).
 * 3. If still missing, check the archive and restore if found.
 * 4. Populate the LRU on cache miss.
 *
 * Returns `undefined` when the session is not found anywhere.
 */
export function getSessionLazy(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  sessionKey: string;
  archiveDir?: string;
}): SessionEntry | undefined {
  const { store, storePath, sessionKey, archiveDir } = params;
  const cacheKey = lruKey(storePath, sessionKey);

  // 1. LRU hit.
  const cached = GLOBAL_LRU.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. Main store.
  let entry: SessionEntry | undefined = store[sessionKey];
  if (!entry) {
    // 3. Archive restore.
    const restored = restoreArchivedSession({ store, sessionKey, storePath, archiveDir });
    if (restored) {
      entry = restored;
    }
  }

  if (entry) {
    GLOBAL_LRU.set(cacheKey, entry);
    return entry;
  }

  return undefined;
}

/** Invalidate a specific key from the LRU (call after writes). */
export function invalidateSessionLRU(storePath: string, sessionKey: string): void {
  GLOBAL_LRU.delete(lruKey(storePath, sessionKey));
}

/** Clear the entire LRU (useful in tests). */
export function clearSessionLRUForTest(): void {
  GLOBAL_LRU.clear();
}

// ============================================================================
// Feature 4: Session stats
// ============================================================================

export type SessionStats = {
  /** Number of active (non-archived) sessions in the store. */
  activeCount: number;
  /** Number of ephemeral sessions (cron + sub-agent) in the active store. */
  ephemeralCount: number;
  /** Approximate size of sessions.json in bytes (0 if file not found). */
  storeSizeBytes: number;
  /** Approximate size of the archive file in bytes (0 if not found). */
  archiveSizeBytes: number;
  /** Number of entries in the archive. */
  archivedCount: number;
  /** Entries currently held in the process-local LRU cache for this store. */
  lruCachedCount: number;
  /**
   * Per-session last-access timestamp (epoch ms) from the LRU.
   * Only populated for sessions currently in the LRU.
   */
  lastAccessTimes: Record<string, number>;
  /**
   * Per-session `updatedAt` timestamp from the active store.
   */
  updatedAtTimes: Record<string, number>;
};

/**
 * Collect aggregate statistics about the session store.
 *
 * This is a synchronous helper — it reads file sizes via `fs.statSync`
 * (fast path, no JSON parsing of the archive file beyond what's already cached).
 */
export function getSessionStats(
  store: Record<string, SessionEntry>,
  storePath: string,
  opts: { archiveDir?: string } = {},
): SessionStats {
  const archivePath = resolveArchivePath(storePath, opts.archiveDir ?? resolveArchiveConfig().dir);

  // File sizes (best-effort; 0 on missing/error).
  let storeSizeBytes = 0;
  let archiveSizeBytes = 0;
  try {
    storeSizeBytes = fs.statSync(storePath).size;
  } catch {
    // file doesn't exist yet
  }
  try {
    archiveSizeBytes = fs.statSync(archivePath).size;
  } catch {
    // archive doesn't exist yet
  }

  // Archive entry count (load only the keys, no large JSON parsing overhead).
  const archiveStore = loadJsonStore(archivePath);
  const archivedCount = Object.keys(archiveStore).length;

  // Active / ephemeral counts.
  let activeCount = 0;
  let ephemeralCount = 0;
  const updatedAtTimes: Record<string, number> = {};
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    activeCount++;
    if (isCronSessionKey(key) || isSubagentSessionKey(key)) {
      ephemeralCount++;
    }
    if (entry.updatedAt != null) {
      updatedAtTimes[key] = entry.updatedAt;
    }
  }

  // LRU stats for this store.
  const storePrefix = `${storePath}::`;
  const lastAccessTimes: Record<string, number> = {};
  let lruCachedCount = 0;
  for (const cacheKey of GLOBAL_LRU.keys()) {
    if (cacheKey.startsWith(storePrefix)) {
      lruCachedCount++;
      const sessionKey = cacheKey.slice(storePrefix.length);
      const accessedAt = GLOBAL_LRU.lastAccessedAt(cacheKey);
      if (accessedAt != null) {
        lastAccessTimes[sessionKey] = accessedAt;
      }
    }
  }

  return {
    activeCount,
    ephemeralCount,
    storeSizeBytes,
    archiveSizeBytes,
    archivedCount,
    lruCachedCount,
    lastAccessTimes,
    updatedAtTimes,
  };
}
