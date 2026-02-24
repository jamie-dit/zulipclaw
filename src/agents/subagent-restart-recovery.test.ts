import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const spawnMock = vi.fn();
  const loadRegistryMock = vi.fn();
  const saveRegistryMock = vi.fn();
  const isRunActiveMock = vi.fn().mockReturnValue(false);
  return { callGatewayMock, spawnMock, loadRegistryMock, saveRegistryMock, isRunActiveMock };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("./subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: () => hoisted.loadRegistryMock(),
  saveSubagentRegistryToDisk: (runs: unknown) => hoisted.saveRegistryMock(runs),
}));

vi.mock("./subagent-registry.js", () => ({
  isSubagentSessionRunActive: (key: string) => hoisted.isRunActiveMock(key),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: () => {} },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child-1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "A sufficiently long task description that should qualify as resumable for testing purposes, meeting the 50 char minimum",
    cleanup: "keep" as const,
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 50_000,
    ...overrides,
  };
}

describe("subagent-restart-recovery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("detectOrphanedRuns", () => {
    it("returns runs that have no endedAt", async () => {
      const activeRun = makeRun({ runId: "active-1" });
      const completedRun = makeRun({ runId: "completed-1", endedAt: Date.now() - 10_000 });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("active-1", activeRun);
      registry.set("completed-1", completedRun);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      const { detectOrphanedRuns } = await import("./subagent-restart-recovery.js");
      const orphaned = detectOrphanedRuns();

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].runId).toBe("active-1");
    });

    it("ignores runs that never started", async () => {
      const unstartedRun = makeRun({ runId: "unstarted-1", startedAt: undefined });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("unstarted-1", unstartedRun);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      const { detectOrphanedRuns } = await import("./subagent-restart-recovery.js");
      const orphaned = detectOrphanedRuns();

      expect(orphaned).toHaveLength(0);
    });

    it("returns empty when registry is empty", async () => {
      hoisted.loadRegistryMock.mockReturnValue(new Map());

      const { detectOrphanedRuns } = await import("./subagent-restart-recovery.js");
      const orphaned = detectOrphanedRuns();

      expect(orphaned).toHaveLength(0);
    });
  });

  describe("runSubagentRestartRecovery", () => {
    it("returns empty when no orphaned runs", async () => {
      hoisted.loadRegistryMock.mockReturnValue(new Map());

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(0);
      expect(hoisted.spawnMock).not.toHaveBeenCalled();
    });

    it("re-spawns orphaned run with session history", async () => {
      const run = makeRun({
        runId: "orphan-1",
        label: "my-task",
        model: "anthropic/claude-opus-4-6",
        requesterOrigin: {
          channel: "zulip",
          to: "stream:marcel#infra",
          accountId: "default",
        },
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("orphan-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      // Mock session history response
      hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
        if ((opts as { method: string }).method === "chat.history") {
          return {
            messages: [
              { role: "assistant", content: "I created PR #42 and pushed changes." },
              { role: "assistant", content: "Now running tests..." },
            ],
          };
        }
        // send for Zulip summary
        if ((opts as { method: string }).method === "send") {
          return { ok: true };
        }
        return {};
      });

      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new-child",
        runId: "new-run-1",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("respawned");
      expect(outcomes[0].label).toBe("my-task");
      expect(outcomes[0].detail).toContain("continuing from previous progress");

      // Verify spawn was called with correct params
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
      const spawnParams = hoisted.spawnMock.mock.calls[0][0];
      expect(spawnParams.task).toContain("Resumed Task");
      expect(spawnParams.task).toContain("I created PR #42");
      expect(spawnParams.label).toBe("my-task-resumed");
      expect(spawnParams.model).toBe("anthropic/claude-opus-4-6");

      const spawnCtx = hoisted.spawnMock.mock.calls[0][1];
      expect(spawnCtx.agentChannel).toBe("zulip");
      expect(spawnCtx.agentTo).toBe("stream:marcel#infra");

      // Verify the old run was marked terminated
      expect(hoisted.saveRegistryMock).toHaveBeenCalled();
    });

    it("re-spawns from scratch when no history available", async () => {
      const run = makeRun({ runId: "orphan-2", label: "no-history-task" });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("orphan-2", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      // No session history
      hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
        if ((opts as { method: string }).method === "chat.history") {
          return { messages: [] };
        }
        return { ok: true };
      });

      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new-child-2",
        runId: "new-run-2",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("respawned");
      expect(outcomes[0].detail).toContain("from scratch");

      const spawnParams = hoisted.spawnMock.mock.calls[0][0];
      expect(spawnParams.task).toContain("Start the task from scratch");
    });

    it("skips tasks that are too short", async () => {
      const shortRun = makeRun({ runId: "short-1", task: "hi" });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("short-1", shortRun);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      hoisted.callGatewayMock.mockResolvedValue({ messages: [] });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("skipped");
      expect(outcomes[0].detail).toContain("trivial");
      expect(hoisted.spawnMock).not.toHaveBeenCalled();
    });

    it("handles spawn failure gracefully", async () => {
      const run = makeRun({ runId: "fail-1", label: "failing-task" });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("fail-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
        if ((opts as { method: string }).method === "chat.history") {
          return { messages: [] };
        }
        return { ok: true };
      });

      hoisted.spawnMock.mockResolvedValue({
        status: "error",
        error: "max children reached",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("skipped");
      expect(outcomes[0].detail).toContain("max children reached");
    });

    it("sends Zulip summary with outcomes", async () => {
      const run = makeRun({
        runId: "summary-1",
        label: "test-task",
        requesterOrigin: { channel: "zulip", to: "stream:marcel#infra" },
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("summary-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new",
        runId: "new",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      await runSubagentRestartRecovery();

      // Find the Zulip send call
      const sendCalls = hoisted.callGatewayMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as { method: string }).method === "send",
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);

      const sendParams = (sendCalls[0][0] as { params: Record<string, string> }).params;
      expect(sendParams.channel).toBe("zulip");
      expect(sendParams.to).toBe("stream:marcel#infra");
      expect(sendParams.message).toContain("Gateway restarted");
      expect(sendParams.message).toContain("test-task");
    });

    it("handles multiple orphaned runs", async () => {
      const run1 = makeRun({ runId: "multi-1", label: "task-a" });
      const run2 = makeRun({ runId: "multi-2", label: "task-b" });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("multi-1", run1);
      registry.set("multi-2", run2);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new",
        runId: "new",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(2);
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(2);
    });

    it("skips re-spawn when original session is still running", async () => {
      const run = makeRun({
        runId: "alive-1",
        label: "still-alive-task",
        childSessionKey: "agent:main:subagent:alive-child",
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("alive-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      // The original session is still active in the in-memory registry
      hoisted.isRunActiveMock.mockImplementation(
        (key: string) => key === "agent:main:subagent:alive-child",
      );

      hoisted.callGatewayMock.mockResolvedValue({ ok: true });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("still-running");
      expect(outcomes[0].label).toBe("still-alive-task");
      expect(outcomes[0].detail).toContain("still active");

      // Should NOT have called spawn
      expect(hoisted.spawnMock).not.toHaveBeenCalled();

      // Should NOT have marked as terminated (the run is still alive)
      const terminateCalls = hoisted.saveRegistryMock.mock.calls;
      expect(terminateCalls).toHaveLength(0);
    });

    it("re-spawns when original session is no longer running", async () => {
      const run = makeRun({
        runId: "dead-1",
        label: "dead-task",
        childSessionKey: "agent:main:subagent:dead-child",
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("dead-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      // The original session is NOT active (dead/completed)
      hoisted.isRunActiveMock.mockReturnValue(false);

      hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
        if ((opts as { method: string }).method === "chat.history") {
          return { messages: [] };
        }
        return { ok: true };
      });

      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new-child",
        runId: "new-run",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].action).toBe("respawned");
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    });

    it("handles mix of still-running and dead orphaned runs", async () => {
      const aliveRun = makeRun({
        runId: "mix-alive",
        label: "alive-task",
        childSessionKey: "agent:main:subagent:alive",
      });
      const deadRun = makeRun({
        runId: "mix-dead",
        label: "dead-task",
        childSessionKey: "agent:main:subagent:dead",
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("mix-alive", aliveRun);
      registry.set("mix-dead", deadRun);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      // Only the alive-child is active
      hoisted.isRunActiveMock.mockImplementation(
        (key: string) => key === "agent:main:subagent:alive",
      );

      hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
        if ((opts as { method: string }).method === "chat.history") {
          return { messages: [] };
        }
        return { ok: true };
      });

      hoisted.spawnMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:new",
        runId: "new",
      });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      const outcomes = await runSubagentRestartRecovery();

      expect(outcomes).toHaveLength(2);
      const aliveOutcome = outcomes.find((o) => o.runId === "mix-alive");
      const deadOutcome = outcomes.find((o) => o.runId === "mix-dead");

      expect(aliveOutcome?.action).toBe("still-running");
      expect(deadOutcome?.action).toBe("respawned");

      // Only one spawn call (for the dead run)
      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    });

    it("includes still-running in Zulip summary with correct icon", async () => {
      const run = makeRun({
        runId: "notify-1",
        label: "notified-task",
        childSessionKey: "agent:main:subagent:notify-child",
      });
      const registry = new Map<string, SubagentRunRecord>();
      registry.set("notify-1", run);
      hoisted.loadRegistryMock.mockReturnValue(registry);

      hoisted.isRunActiveMock.mockReturnValue(true);
      hoisted.callGatewayMock.mockResolvedValue({ ok: true });

      const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
      await runSubagentRestartRecovery();

      // Find the Zulip send call
      const sendCalls = hoisted.callGatewayMock.mock.calls.filter(
        (call: unknown[]) => (call[0] as { method: string }).method === "send",
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);

      const sendParams = (sendCalls[0][0] as { params: Record<string, string> }).params;
      expect(sendParams.message).toContain("✅");
      expect(sendParams.message).toContain("notified-task");
      expect(sendParams.message).toContain("still active");
    });
  });
});
