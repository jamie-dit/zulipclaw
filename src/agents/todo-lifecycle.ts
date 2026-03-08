/**
 * Todo list lifecycle management.
 *
 * - Auto-archive: lists where all items are done/cancelled for >1 hour.
 * - Debounced backing-message sync to avoid Zulip edit storms.
 * - Stale list pruning (archived >7 days).
 */

import { defaultRuntime } from "../runtime.js";
import { renderBackingMessage } from "./todo-render.js";
import { getAllLists, archiveList, getList, setLastSyncedAt } from "./todo-state.js";

// ── Auto-archive ─────────────────────────────────────────────────────────────

const AUTO_ARCHIVE_DELAY_MS = 60 * 60 * 1000; // 1 hour
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sweep all lists and auto-archive those where every item is
 * done/cancelled and `updatedAt` is older than the archive delay.
 *
 * Returns list IDs that were archived.
 */
export function sweepAutoArchive(nowMs: number = Date.now()): string[] {
  const archived: string[] = [];
  for (const list of getAllLists()) {
    if (list.archived) {
      continue;
    }
    if (list.items.length === 0) {
      continue;
    }

    const allDone = list.items.every((i) => i.status === "done" || i.status === "cancelled");
    if (!allDone) {
      continue;
    }

    if (nowMs - list.updatedAt >= AUTO_ARCHIVE_DELAY_MS) {
      void archiveList(list.id).catch((err) => {
        defaultRuntime.log?.(
          `[warn] todo auto-archive failed for list ${list.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      archived.push(list.id);
    }
  }
  return archived;
}

/**
 * Remove archived lists older than the prune age.
 * Returns how many were removed.
 *
 * NOTE: This modifies state directly - should only be called from
 * a lifecycle sweep, not from tool actions.
 */
export function pruneStaleArchived(nowMs: number = Date.now()): number {
  // We access the internal store through getAllLists and use the IDs
  // to remove from the map - but since we don't export the map,
  // pruning must be done through the state module. For now, we
  // just report what would be pruned; actual deletion can be added
  // when the state module exposes a delete function.
  let count = 0;
  for (const list of getAllLists()) {
    if (list.archived && nowMs - list.updatedAt >= PRUNE_AGE_MS) {
      count++;
    }
  }
  return count;
}

// ── Debounced backing-message sync ───────────────────────────────────────────

/**
 * Debounce configuration for backing-message edits.
 * - DEBOUNCE_MS: minimum gap between edits to the same backing message.
 * - MAX_COALESCE_MS: maximum time to hold changes before forcing a sync.
 */
const DEBOUNCE_MS = 2_000;
const MAX_COALESCE_MS = 5_000;

type SyncCallback = (listId: string, content: string, messageId: string) => Promise<void>;

interface PendingSync {
  listId: string;
  /** Timer handle for the debounce delay. */
  timer: ReturnType<typeof setTimeout>;
  /** When the first un-synced mutation happened. */
  firstPendingAt: number;
}

const pendingSyncs = new Map<string, PendingSync>();

let _syncCallback: SyncCallback | null = null;

/**
 * Register the callback that actually edits the Zulip backing message.
 * Must be called once during gateway startup before any syncs fire.
 */
export function registerSyncCallback(cb: SyncCallback): void {
  _syncCallback = cb;
}

/**
 * Schedule a backing-message sync for a list.
 * Debounces rapid mutations; forces sync after MAX_COALESCE_MS.
 */
export function scheduleSyncForList(listId: string): void {
  const existing = pendingSyncs.get(listId);
  const now = Date.now();

  if (existing) {
    clearTimeout(existing.timer);
    // If we've been coalescing too long, force immediate sync.
    if (now - existing.firstPendingAt >= MAX_COALESCE_MS) {
      pendingSyncs.delete(listId);
      void executeSyncForList(listId);
      return;
    }
  }

  const firstPendingAt = existing?.firstPendingAt ?? now;
  const timer = setTimeout(() => {
    pendingSyncs.delete(listId);
    void executeSyncForList(listId);
  }, DEBOUNCE_MS);

  pendingSyncs.set(listId, { listId, timer, firstPendingAt });
}

async function executeSyncForList(listId: string): Promise<void> {
  if (!_syncCallback) {
    return;
  }

  const list = getList(listId);
  if (!list || !list.backingMessageId) {
    return;
  }

  const content = renderBackingMessage(list);
  try {
    await _syncCallback(listId, content, list.backingMessageId);
    setLastSyncedAt(listId, Date.now());
  } catch {
    // Sync failure is non-fatal; next mutation will retry.
  }
}

// ── Lifecycle timer ──────────────────────────────────────────────────────────

let lifecycleTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic lifecycle sweep (auto-archive + prune). */
export function startLifecycleSweeper(intervalMs: number = 5 * 60 * 1000): void {
  stopLifecycleSweeper();
  lifecycleTimer = setInterval(() => {
    sweepAutoArchive();
    pruneStaleArchived();
  }, intervalMs);
  // Don't hold the process open.
  if (lifecycleTimer.unref) {
    lifecycleTimer.unref();
  }
}

export function stopLifecycleSweeper(): void {
  if (lifecycleTimer) {
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetLifecycleForTests(): void {
  stopLifecycleSweeper();
  for (const pending of pendingSyncs.values()) {
    clearTimeout(pending.timer);
  }
  pendingSyncs.clear();
  _syncCallback = null;
}

export { DEBOUNCE_MS, MAX_COALESCE_MS, AUTO_ARCHIVE_DELAY_MS, PRUNE_AGE_MS };
