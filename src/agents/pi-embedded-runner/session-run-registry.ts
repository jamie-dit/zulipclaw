/**
 * Per-session run registry for tracking concurrent runs.
 *
 * When maxConcurrentPerSession > 1, multiple runs can execute in parallel
 * within the same session. This registry tracks active runs per session
 * so sibling runs can discover and cancel each other.
 */

import { diagnosticLogger as diag } from "../../logging/diagnostic.js";

export type SessionRunHandle = {
  runId: string;
  sessionKey: string;
  abortController: AbortController;
  startedAt: number;
  prompt: string;
};

/**
 * Map<sessionKey, Map<runId, SessionRunHandle>>
 */
const sessionRuns = new Map<string, Map<string, SessionRunHandle>>();

export function registerSessionRun(handle: SessionRunHandle): void {
  let runs = sessionRuns.get(handle.sessionKey);
  if (!runs) {
    runs = new Map();
    sessionRuns.set(handle.sessionKey, runs);
  }
  runs.set(handle.runId, handle);
  diag.debug(
    `session-run-registry: registered runId=${handle.runId} sessionKey=${handle.sessionKey} active=${runs.size}`,
  );
}

export function unregisterSessionRun(sessionKey: string, runId: string): void {
  const runs = sessionRuns.get(sessionKey);
  if (!runs) {
    return;
  }
  runs.delete(runId);
  if (runs.size === 0) {
    sessionRuns.delete(sessionKey);
  }
  diag.debug(
    `session-run-registry: unregistered runId=${runId} sessionKey=${sessionKey} remaining=${runs?.size ?? 0}`,
  );
}

/**
 * List active sibling runs for a session (excluding the caller's own runId).
 */
export function listSiblingRuns(sessionKey: string, excludeRunId?: string): SessionRunHandle[] {
  const runs = sessionRuns.get(sessionKey);
  if (!runs) {
    return [];
  }
  const result: SessionRunHandle[] = [];
  for (const handle of runs.values()) {
    if (handle.runId !== excludeRunId) {
      result.push(handle);
    }
  }
  return result;
}

/**
 * Cancel a specific run by runId within a session.
 * Returns true if the run was found and aborted.
 */
export function cancelSessionRun(sessionKey: string, runId: string): boolean {
  const runs = sessionRuns.get(sessionKey);
  if (!runs) {
    return false;
  }
  const handle = runs.get(runId);
  if (!handle) {
    return false;
  }
  if (handle.abortController.signal.aborted) {
    return false;
  }
  handle.abortController.abort("cancelled by sibling run");
  diag.info(`session-run-registry: cancelled runId=${runId} sessionKey=${sessionKey}`);
  return true;
}

/**
 * Cancel all active runs in a session (optionally excluding one).
 * Returns the number of runs cancelled.
 */
export function cancelAllSessionRuns(sessionKey: string, excludeRunId?: string): number {
  const runs = sessionRuns.get(sessionKey);
  if (!runs) {
    return 0;
  }
  let cancelled = 0;
  for (const handle of runs.values()) {
    if (handle.runId === excludeRunId) {
      continue;
    }
    if (handle.abortController.signal.aborted) {
      continue;
    }
    handle.abortController.abort("cancelled by sibling run");
    cancelled++;
  }
  if (cancelled > 0) {
    diag.info(
      `session-run-registry: cancelled ${cancelled} runs in sessionKey=${sessionKey} (excluding=${excludeRunId ?? "none"})`,
    );
  }
  return cancelled;
}

/**
 * Get count of active runs for a session.
 */
export function getActiveRunCount(sessionKey: string): number {
  return sessionRuns.get(sessionKey)?.size ?? 0;
}

/**
 * Clear all registries (for testing).
 */
export function resetSessionRunRegistryForTest(): void {
  sessionRuns.clear();
}
