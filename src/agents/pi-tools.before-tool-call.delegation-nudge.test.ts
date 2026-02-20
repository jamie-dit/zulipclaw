import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyDelegationNudgeToToolResultMessage,
  incrementDelegationNudgeCounter,
  resetDelegationNudgeCounter,
  startDelegationNudgeTurn,
} from "./delegation-nudge.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

const { mockCallGateway } = vi.hoisted(() => ({
  mockCallGateway: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js");
vi.mock("./subagent-spawn.js");
vi.mock("../gateway/call.js", () => ({
  callGateway: mockCallGateway,
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockSpawnSubagentDirect = vi.mocked(spawnSubagentDirect);

function asSerializedMessage(message: unknown): string {
  return JSON.stringify(message);
}

describe("delegation nudge hard-threshold behavior", () => {
  beforeEach(() => {
    const hookRunner = {
      hasHooks: vi.fn(() => false),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    mockSpawnSubagentDirect.mockReset();
    mockCallGateway.mockReset();
    resetDiagnosticSessionStateForTest();
  });

  it("uses firstTurnHardThreshold for the first depth-0 turn", async () => {
    const sessionKey = "agent:main:zulip:channel:first-turn";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: true });

    for (let i = 0; i < 9; i += 1) {
      const result = await runBeforeToolCallHook({
        toolName: "read",
        params: { path: `/tmp/${i}.txt` },
        ctx: {
          agentId: "main",
          sessionKey,
          delegationNudge: {
            enabled: true,
            hardThreshold: 6,
            firstTurnHardThreshold: 10,
            exemptTools: [],
          },
        },
      });
      expect(result.blocked).toBe(false);
    }

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/blocked.txt" },
      ctx: {
        agentId: "main",
        sessionKey,
        delegationNudge: {
          enabled: true,
          hardThreshold: 6,
          firstTurnHardThreshold: 10,
          exemptTools: [],
        },
      },
    });

    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.blocked ? blocked.reason : "").toContain("(10/10)");
  });

  it("keeps normal-turn hardThreshold unchanged", async () => {
    const sessionKey = "agent:main:zulip:channel:normal-turn";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    for (let i = 0; i < 5; i += 1) {
      const result = await runBeforeToolCallHook({
        toolName: "read",
        params: { path: `/tmp/${i}.txt` },
        ctx: {
          agentId: "main",
          sessionKey,
          delegationNudge: {
            enabled: true,
            hardThreshold: 6,
            firstTurnHardThreshold: 10,
            exemptTools: [],
          },
        },
      });
      expect(result.blocked).toBe(false);
    }

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/blocked.txt" },
      ctx: {
        agentId: "main",
        sessionKey,
        delegationNudge: {
          enabled: true,
          hardThreshold: 6,
          firstTurnHardThreshold: 10,
          exemptTools: [],
        },
      },
    });

    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.blocked ? blocked.reason : "").toContain("(6/6)");
  });

  it("emits delegation nudge only at every 10th tool call (10, 20)", () => {
    const sessionKey = "agent:main:zulip:channel:nudge-cadence";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const baseMessage = {
      role: "toolResult",
      content: "Tool result",
    };

    for (let i = 0; i < 9; i += 1) {
      incrementDelegationNudgeCounter(sessionKey);
      const message = applyDelegationNudgeToToolResultMessage({
        message: baseMessage,
        sessionKey,
        config: {
          enabled: true,
          softThreshold: 3,
          hardThreshold: 100,
        },
      });
      expect(asSerializedMessage(message)).not.toContain("⚠️ DELEGATION NUDGE:");
    }

    incrementDelegationNudgeCounter(sessionKey);
    const atTen = applyDelegationNudgeToToolResultMessage({
      message: baseMessage,
      sessionKey,
      config: {
        enabled: true,
        softThreshold: 3,
        hardThreshold: 100,
      },
    });
    expect(asSerializedMessage(atTen)).toContain("⚠️ DELEGATION NUDGE:");
    expect(asSerializedMessage(atTen)).toContain("Total tool calls in this turn: 10");

    incrementDelegationNudgeCounter(sessionKey);
    const atEleven = applyDelegationNudgeToToolResultMessage({
      message: baseMessage,
      sessionKey,
      config: {
        enabled: true,
        softThreshold: 3,
        hardThreshold: 100,
      },
    });
    expect(asSerializedMessage(atEleven)).not.toContain("⚠️ DELEGATION NUDGE:");

    for (let i = 0; i < 9; i += 1) {
      incrementDelegationNudgeCounter(sessionKey);
    }
    const atTwenty = applyDelegationNudgeToToolResultMessage({
      message: baseMessage,
      sessionKey,
      config: {
        enabled: true,
        softThreshold: 3,
        hardThreshold: 100,
      },
    });
    expect(asSerializedMessage(atTwenty)).toContain("⚠️ DELEGATION NUDGE:");
    expect(asSerializedMessage(atTwenty)).toContain("Total tool calls in this turn: 20");
  });

  it("auto-delegates when readiness checks pass", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate-pass";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    mockSpawnSubagentDirect.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:auto-child",
      runId: "run-1",
    });
    mockCallGateway.mockResolvedValue({ ok: true, result: { id: "msg-1" } });

    const ctx = {
      agentId: "main",
      sessionKey,
      messageChannel: "zulip",
      messageTo: "stream:marcel#zulipclaw review",
      messageThreadId: "zulipclaw review",
      turnPrompt: "Please finish implementing the requested changes.",
      delegationNudge: {
        enabled: true,
        hardThreshold: 2,
        firstTurnHardThreshold: 10,
        exemptTools: [],
      },
    };

    const first = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/1.txt" },
      ctx,
    });
    expect(first.blocked).toBe(false);

    const second = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/2.txt" },
      ctx,
    });
    expect(second).toMatchObject({ blocked: true });
    expect(second.blocked ? second.reason : "").toContain(
      "Auto-delegation started in child session agent:main:subagent:auto-child",
    );

    expect(mockSpawnSubagentDirect).toHaveBeenCalledTimes(1);
    expect(mockCallGateway).toHaveBeenCalledTimes(1);

    const [spawnParams] = mockSpawnSubagentDirect.mock.calls[0] ?? [];
    expect(spawnParams?.task).toContain("Plan (short step-by-step)");
    expect(spawnParams?.task).toContain("Task checklist (actionable items)");
    expect(spawnParams?.task).toContain(`Parent session key: ${sessionKey}`);
    expect(spawnParams?.task).toContain("Triggering parent tool: read");
    expect(spawnParams?.task).toContain("Intended tool params");
    expect(spawnParams?.task).toContain("Latest requester prompt excerpt");
    expect(spawnParams?.task).toContain("Recent parent tool-call summary");
    expect(spawnParams?.task).toContain("Completion/reporting requirement");
  });

  it("blocks auto-delegation when readiness checks fail", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate-fail-readiness";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/1.txt" },
      ctx: {
        agentId: "main",
        sessionKey,
        messageChannel: "zulip",
        messageTo: "stream:marcel#zulipclaw review",
        messageThreadId: "zulipclaw review",
        turnPrompt: "   ",
        delegationNudge: {
          enabled: true,
          hardThreshold: 1,
          firstTurnHardThreshold: 10,
          exemptTools: [],
        },
      },
    });

    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.blocked ? blocked.reason : "").toContain("Auto-delegation gate failed");
    expect(blocked.blocked ? blocked.reason : "").toContain("turn prompt is empty");
    expect(mockSpawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("rejects malformed Zulip stream targets during auto-delegation readiness checks", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate-fail-target";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/1.txt" },
      ctx: {
        agentId: "main",
        sessionKey,
        messageChannel: "zulip",
        messageTo: "stream:marcel",
        messageThreadId: "zulipclaw review",
        turnPrompt: "Continue task",
        delegationNudge: {
          enabled: true,
          hardThreshold: 1,
          firstTurnHardThreshold: 10,
          exemptTools: [],
        },
      },
    });

    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.blocked ? blocked.reason : "").toContain("Auto-delegation gate failed");
    expect(blocked.blocked ? blocked.reason : "").toContain("must include a topic");
    expect(mockSpawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("returns manual block reason when auto-delegation gate fails", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate-fail-manual";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const state = getDiagnosticSessionState({ sessionKey, sessionId: "main" });
    state.toolLoopWarningBuckets = new Map([["warn:key", 1]]);

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/1.txt" },
      ctx: {
        agentId: "main",
        sessionKey,
        messageChannel: "zulip",
        messageTo: "stream:marcel#zulipclaw review",
        messageThreadId: "zulipclaw review",
        turnPrompt: "Continue task",
        delegationNudge: {
          enabled: true,
          hardThreshold: 1,
          firstTurnHardThreshold: 10,
          exemptTools: [],
        },
      },
    });

    expect(blocked).toMatchObject({ blocked: true });
    expect(blocked.blocked ? blocked.reason : "").toContain("Auto-delegation gate failed");
    expect(blocked.blocked ? blocked.reason : "").toContain("active loop diagnostics");
    expect(blocked.blocked ? blocked.reason : "").toContain(
      "Manual delegation required: use sessions_spawn",
    );
    expect(mockSpawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("does not apply first-turn limits to subagent sessions", async () => {
    const sessionKey = "agent:main:subagent:123";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: true });

    for (let i = 0; i < 12; i += 1) {
      const result = await runBeforeToolCallHook({
        toolName: "read",
        params: { path: `/tmp/${i}.txt` },
        ctx: {
          agentId: "main",
          sessionKey,
          delegationNudge: {
            enabled: true,
            hardThreshold: 2,
            firstTurnHardThreshold: 10,
            exemptTools: [],
          },
        },
      });
      expect(result.blocked).toBe(false);
    }
  });

  afterEach(() => {
    resetDelegationNudgeCounter("agent:main:zulip:channel:first-turn");
    resetDelegationNudgeCounter("agent:main:zulip:channel:normal-turn");
    resetDelegationNudgeCounter("agent:main:zulip:channel:nudge-cadence");
    resetDelegationNudgeCounter("agent:main:zulip:channel:auto-delegate-pass");
    resetDelegationNudgeCounter("agent:main:zulip:channel:auto-delegate-fail-readiness");
    resetDelegationNudgeCounter("agent:main:zulip:channel:auto-delegate-fail-target");
    resetDelegationNudgeCounter("agent:main:zulip:channel:auto-delegate-fail-manual");
    resetDelegationNudgeCounter("agent:main:subagent:123");
    resetDiagnosticSessionStateForTest();
  });
});
