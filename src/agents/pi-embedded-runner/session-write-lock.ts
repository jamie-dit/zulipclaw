/**
 * Per-session async mutex for serializing transcript writes.
 *
 * With concurrent followup runs writing to the same session transcript,
 * two runs could append simultaneously causing corruption. This module
 * provides a simple promise-chain mutex keyed by session key.
 */

const sessionWriteLocks = new Map<string, Promise<void>>();

/**
 * Execute `fn` while holding the write lock for `key`.
 * Guarantees that only one write runs at a time per session key.
 * If the previous holder rejects, the next holder still runs.
 */
export function withSessionWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionWriteLocks.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  // Store a void-resolving version so the chain never rejects for the next waiter.
  sessionWriteLocks.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/**
 * Returns the number of active lock keys (for diagnostics/tests).
 */
export function getSessionWriteLockCount(): number {
  return sessionWriteLocks.size;
}

/**
 * Clear all locks (for testing only).
 */
export function resetSessionWriteLocksForTest(): void {
  sessionWriteLocks.clear();
}
