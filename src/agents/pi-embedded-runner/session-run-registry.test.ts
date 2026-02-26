import { describe, expect, it, afterEach } from "vitest";
import {
  registerSessionRun,
  unregisterSessionRun,
  listSiblingRuns,
  cancelSessionRun,
  cancelAllSessionRuns,
  getActiveRunCount,
  resetSessionRunRegistryForTest,
} from "./session-run-registry.js";

afterEach(() => {
  resetSessionRunRegistryForTest();
});

function makeHandle(runId: string, sessionKey: string, prompt = "test prompt") {
  return {
    runId,
    sessionKey,
    abortController: new AbortController(),
    startedAt: Date.now(),
    prompt,
  };
}

describe("session run registry", () => {
  it("registers and unregisters runs", () => {
    const handle = makeHandle("run-1", "session-a");
    registerSessionRun(handle);
    expect(getActiveRunCount("session-a")).toBe(1);

    unregisterSessionRun("session-a", "run-1");
    expect(getActiveRunCount("session-a")).toBe(0);
  });

  it("lists sibling runs excluding own runId", () => {
    const h1 = makeHandle("run-1", "session-a", "prompt 1");
    const h2 = makeHandle("run-2", "session-a", "prompt 2");
    const h3 = makeHandle("run-3", "session-a", "prompt 3");
    registerSessionRun(h1);
    registerSessionRun(h2);
    registerSessionRun(h3);

    const siblings = listSiblingRuns("session-a", "run-2");
    expect(siblings).toHaveLength(2);
    expect(siblings.map((s) => s.runId).toSorted()).toEqual(["run-1", "run-3"]);
  });

  it("returns empty array for unknown session", () => {
    expect(listSiblingRuns("nonexistent")).toEqual([]);
  });

  it("cancels a specific run by runId", () => {
    const handle = makeHandle("run-1", "session-a");
    registerSessionRun(handle);

    expect(handle.abortController.signal.aborted).toBe(false);
    const cancelled = cancelSessionRun("session-a", "run-1");
    expect(cancelled).toBe(true);
    expect(handle.abortController.signal.aborted).toBe(true);
  });

  it("returns false when cancelling already-aborted run", () => {
    const handle = makeHandle("run-1", "session-a");
    registerSessionRun(handle);
    handle.abortController.abort();

    const cancelled = cancelSessionRun("session-a", "run-1");
    expect(cancelled).toBe(false);
  });

  it("returns false when cancelling nonexistent run", () => {
    expect(cancelSessionRun("session-a", "run-1")).toBe(false);
  });

  it("cancels all runs in a session except excluded", () => {
    const h1 = makeHandle("run-1", "session-a");
    const h2 = makeHandle("run-2", "session-a");
    const h3 = makeHandle("run-3", "session-a");
    registerSessionRun(h1);
    registerSessionRun(h2);
    registerSessionRun(h3);

    const count = cancelAllSessionRuns("session-a", "run-2");
    expect(count).toBe(2);
    expect(h1.abortController.signal.aborted).toBe(true);
    expect(h2.abortController.signal.aborted).toBe(false);
    expect(h3.abortController.signal.aborted).toBe(true);
  });

  it("isolates runs by session key", () => {
    const hA = makeHandle("run-1", "session-a");
    const hB = makeHandle("run-2", "session-b");
    registerSessionRun(hA);
    registerSessionRun(hB);

    expect(getActiveRunCount("session-a")).toBe(1);
    expect(getActiveRunCount("session-b")).toBe(1);
    expect(listSiblingRuns("session-a", "run-1")).toEqual([]);
    expect(listSiblingRuns("session-b", "run-2")).toEqual([]);
  });

  it("cleanup removes session entry when last run is unregistered", () => {
    const handle = makeHandle("run-1", "session-a");
    registerSessionRun(handle);
    unregisterSessionRun("session-a", "run-1");
    // No error on double-unregister
    unregisterSessionRun("session-a", "run-1");
    expect(getActiveRunCount("session-a")).toBe(0);
  });
});
