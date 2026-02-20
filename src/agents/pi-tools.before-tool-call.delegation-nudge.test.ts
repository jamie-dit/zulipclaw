import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resetDelegationNudgeCounter, startDelegationNudgeTurn } from "./delegation-nudge.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

const { mockCallGateway } = vi.hoisted(() => ({
  mockCallGateway: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js");
vi.mock("../gateway/call.js", () => ({
  callGateway: mockCallGateway,
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("delegation nudge hard-threshold behavior", () => {
  beforeEach(() => {
    const hookRunner = {
      hasHooks: vi.fn(() => false),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    mockCallGateway.mockReset();
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

  it("returns an explicit manual-delegation block message at hard limit", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const ctx = {
      agentId: "main",
      sessionKey,
      messageChannel: "zulip",
      messageTo: "stream:marcel#zulipclaw",
      messageThreadId: "zulipclaw",
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
      "Manual delegation required: use sessions_spawn to delegate this work to a sub-agent.",
    );
    expect(second.blocked ? second.reason : "").toContain("(2/2)");
  });

  it("does not create an implicit auto-delegation run on hard-limit breach", async () => {
    const sessionKey = "agent:main:zulip:channel:auto-delegate";
    startDelegationNudgeTurn({ sessionKey, isFirstTurn: false });

    const ctx = {
      agentId: "main",
      sessionKey,
      messageChannel: "zulip",
      messageTo: "stream:marcel#zulipclaw",
      messageThreadId: "zulipclaw",
      delegationNudge: {
        enabled: true,
        hardThreshold: 1,
        firstTurnHardThreshold: 10,
        exemptTools: [],
      },
    };

    const blocked = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/1.txt" },
      ctx,
    });
    expect(blocked).toMatchObject({ blocked: true });
    expect(mockCallGateway).not.toHaveBeenCalled();
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
    resetDelegationNudgeCounter("agent:main:zulip:channel:auto-delegate");
    resetDelegationNudgeCounter("agent:main:subagent:123");
  });
});
