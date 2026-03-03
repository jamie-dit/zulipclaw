/**
 * Tests for the requester notification feature in restart recovery.
 * When a sub-agent is re-spawned after a gateway restart, the requester
 * topic should receive a notification in addition to the infra summary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const spawnMock = vi.fn();
  const loadRegistryMock = vi.fn();
  const saveRegistryMock = vi.fn();
  const loadSessionEntryMock = vi.fn();
  const isEmbeddedPiRunActiveMock = vi.fn().mockReturnValue(false);
  const dispatchChannelMessageActionMock = vi.fn();
  const loadConfigMock = vi.fn();
  const markRelayRunRespawnedMock = vi.fn();
  return {
    callGatewayMock,
    spawnMock,
    loadRegistryMock,
    saveRegistryMock,
    loadSessionEntryMock,
    isEmbeddedPiRunActiveMock,
    dispatchChannelMessageActionMock,
    loadConfigMock,
    markRelayRunRespawnedMock,
  };
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

vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: (key: string) => hoisted.loadSessionEntryMock(key),
}));

vi.mock("./pi-embedded-runner.js", () => ({
  isEmbeddedPiRunActive: (sessionId: string) => hoisted.isEmbeddedPiRunActiveMock(sessionId),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: () => {} },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => hoisted.loadConfigMock(),
}));

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) =>
    hoisted.dispatchChannelMessageActionMock(...args),
}));

// Mock the dynamic import of subagent-relay for markRelayRunRespawned
vi.mock("./subagent-relay.js", () => ({
  markRelayRunRespawned: (...args: unknown[]) => hoisted.markRelayRunRespawnedMock(...args),
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

describe("restart recovery requester notification", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends a notification to the requester topic when a run is re-spawned", async () => {
    const run = makeRun({
      runId: "orphan-notify",
      label: "notify-task",
      model: "anthropic/claude-opus-4-6",
      requesterOrigin: {
        channel: "zulip",
        to: "stream:marcel#my-work-topic",
        accountId: "default",
      },
      requesterDeliveryContext: {
        channel: "zulip",
        to: "stream:marcel#my-work-topic",
        accountId: "default",
      },
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("orphan-notify", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-1" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);

    hoisted.loadConfigMock.mockReturnValue({});

    hoisted.callGatewayMock.mockImplementation((opts: Record<string, unknown>) => {
      const params = opts.params as Record<string, unknown> | undefined;
      if ((opts as { method: string }).method === "chat.history") {
        if (params?.limit === 5) {
          // For checkLastMessageCompletion: last message has tool calls (still running)
          return {
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Working on the PR..." },
                  { type: "toolCall", toolName: "exec", args: { command: "git push" } },
                ],
              },
            ],
          };
        }
        return {
          messages: [{ role: "assistant", content: "Working on the PR..." }],
        };
      }
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

    hoisted.dispatchChannelMessageActionMock.mockResolvedValue({ ok: true });

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    const outcomes = await runSubagentRestartRecovery();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("respawned");

    // Verify the requester topic notification was sent via dispatchChannelMessageAction
    expect(hoisted.dispatchChannelMessageActionMock).toHaveBeenCalled();
    const dispatchCall = hoisted.dispatchChannelMessageActionMock.mock.calls[0][0];
    expect(dispatchCall.channel).toBe("zulip");
    expect(dispatchCall.action).toBe("send");
    expect(dispatchCall.params.target).toBe("stream:marcel#my-work-topic");
    expect(dispatchCall.params.message).toContain("⚡");
    expect(dispatchCall.params.message).toContain("notify-task");
    expect(dispatchCall.params.message).toContain("notify-task-resumed");
    expect(dispatchCall.params.message).toContain("gateway restart");

    // Recovery spawn must preserve requester session key linkage.
    const spawnCtx = hoisted.spawnMock.mock.calls[0][1];
    expect(spawnCtx.agentSessionKey).toBe("agent:main:main");
    expect(spawnCtx.agentTo).toBe("stream:marcel#my-work-topic");
  });

  it("sends Zulip infra summary AND requester notification (both)", async () => {
    const run = makeRun({
      runId: "both-notify",
      label: "dual-notify-task",
      model: "anthropic/claude-opus-4-6",
      requesterOrigin: {
        channel: "zulip",
        to: "stream:marcel#specific-topic",
        accountId: "default",
      },
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("both-notify", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-2" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);
    hoisted.loadConfigMock.mockReturnValue({});

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

    hoisted.dispatchChannelMessageActionMock.mockResolvedValue({ ok: true });

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    await runSubagentRestartRecovery();

    // Infra summary sent via callGateway (send method)
    const sendCalls = hoisted.callGatewayMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const infraParams = (sendCalls[0][0] as { params: Record<string, string> }).params;
    expect(infraParams.to).toBe("stream:marcel#infra");

    // Requester notification sent via dispatchChannelMessageAction
    expect(hoisted.dispatchChannelMessageActionMock).toHaveBeenCalled();
    const requesterCall = hoisted.dispatchChannelMessageActionMock.mock.calls[0][0];
    expect(requesterCall.params.target).toBe("stream:marcel#specific-topic");
  });

  it("skips requester notification when no delivery context available", async () => {
    const run = makeRun({
      runId: "no-context",
      label: "no-context-task",
      // No requesterOrigin or requesterDeliveryContext
      requesterOrigin: undefined,
      requesterDeliveryContext: undefined,
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("no-context", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-3" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);
    hoisted.loadConfigMock.mockReturnValue({});

    hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
    hoisted.spawnMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:new",
      runId: "new",
    });

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    await runSubagentRestartRecovery();

    // dispatchChannelMessageAction should NOT have been called (no delivery context)
    expect(hoisted.dispatchChannelMessageActionMock).not.toHaveBeenCalled();
  });

  it("calls markRelayRunRespawned to update old relay message", async () => {
    const run = makeRun({
      runId: "relay-update",
      label: "relay-task",
      requesterOrigin: {
        channel: "zulip",
        to: "stream:marcel#topic",
        accountId: "default",
      },
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("relay-update", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-4" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);
    hoisted.loadConfigMock.mockReturnValue({});

    hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
    hoisted.spawnMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:new",
      runId: "new",
    });

    hoisted.dispatchChannelMessageActionMock.mockResolvedValue({ ok: true });

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    await runSubagentRestartRecovery();

    // Verify markRelayRunRespawned was called with the old runId and new label
    expect(hoisted.markRelayRunRespawnedMock).toHaveBeenCalledWith(
      "relay-update",
      "relay-task-resumed",
    );
  });

  it("does not call requester notification or relay update when spawn fails", async () => {
    const run = makeRun({
      runId: "fail-notify",
      label: "fail-task",
      requesterOrigin: {
        channel: "zulip",
        to: "stream:marcel#topic",
      },
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("fail-notify", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-5" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);
    hoisted.loadConfigMock.mockReturnValue({});

    hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
    hoisted.spawnMock.mockResolvedValue({
      status: "error",
      error: "max children reached",
    });

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    await runSubagentRestartRecovery();

    // Neither requester notification nor relay update should be called
    expect(hoisted.dispatchChannelMessageActionMock).not.toHaveBeenCalled();
    expect(hoisted.markRelayRunRespawnedMock).not.toHaveBeenCalled();
  });

  it("continues if requester notification fails (best-effort)", async () => {
    const run = makeRun({
      runId: "notify-fail",
      label: "notify-fail-task",
      requesterOrigin: {
        channel: "zulip",
        to: "stream:marcel#topic",
        accountId: "default",
      },
    });
    const registry = new Map<string, SubagentRunRecord>();
    registry.set("notify-fail", run);
    hoisted.loadRegistryMock.mockReturnValue(registry);

    hoisted.loadSessionEntryMock.mockReturnValue({ entry: { sessionId: "uuid-6" } });
    hoisted.isEmbeddedPiRunActiveMock.mockReturnValue(false);
    hoisted.loadConfigMock.mockReturnValue({});

    hoisted.callGatewayMock.mockResolvedValue({ messages: [], ok: true });
    hoisted.spawnMock.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:new",
      runId: "new",
    });

    // Make requester notification fail
    hoisted.dispatchChannelMessageActionMock.mockRejectedValue(new Error("Zulip send failed"));

    const { runSubagentRestartRecovery } = await import("./subagent-restart-recovery.js");
    const outcomes = await runSubagentRestartRecovery();

    // Should still report success despite notification failure
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].action).toBe("respawned");
  });
});
