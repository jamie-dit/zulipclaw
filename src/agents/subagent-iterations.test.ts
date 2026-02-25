import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    spawnMock: vi.fn(),
    callGatewayMock: vi.fn(),
    sessionStore: {} as Record<string, Record<string, unknown>>,
  };
});

vi.mock("./subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => hoisted.callGatewayMock(...args),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    }),
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => hoisted.sessionStore),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-registry.js", () => ({
  isSubagentSessionRunActive: vi.fn(() => true),
  countActiveDescendantRuns: vi.fn(() => 0),
  resolveRequesterForChildSession: vi.fn(() => null),
}));

describe("subagent iteration support", () => {
  beforeEach(() => {
    hoisted.spawnMock.mockReset();
    hoisted.callGatewayMock.mockReset();
    hoisted.sessionStore = {};
  });

  it("passes maxIterations through sessions_spawn to spawnSubagentDirect", async () => {
    hoisted.spawnMock.mockResolvedValue({ status: "accepted", runId: "run-1" });

    const { createSessionsSpawnTool } = await import("./tools/sessions-spawn-tool.js");
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "zulip",
      agentTo: "stream:marcel#topic",
    });

    await tool.execute("call-1", {
      task: "do work",
      maxIterations: 20,
    });

    expect(hoisted.spawnMock).toHaveBeenCalledOnce();
    const [params] = hoisted.spawnMock.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(params.maxIterations).toBe(20);
  });

  it("includes iteration limit section in subagent system prompt when maxIterations is set", async () => {
    const { buildSubagentSystemPrompt } = await import("./subagent-announce.js");
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:child",
      task: "test",
      maxIterations: 12,
    });

    expect(prompt).toContain("## Iteration Limit");
    expect(prompt).toContain("You have a maximum of 12 agent turns to complete your task.");
    expect(prompt).toContain("The runtime will force-stop you at the limit");
  });

  it("does not include iteration limit section when maxIterations is omitted", async () => {
    const { buildSubagentSystemPrompt } = await import("./subagent-announce.js");
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:child",
      task: "test",
    });

    expect(prompt).not.toContain("## Iteration Limit");
  });

  it("adds completion metadata block with status and iterations", async () => {
    const agentCalls: Array<{ params?: Record<string, unknown> }> = [];
    hoisted.sessionStore = {
      "agent:main:subagent:child": {
        sessionId: "child-session",
        inputTokens: 30100,
        outputTokens: 15100,
        totalTokens: 45200,
      },
      "agent:main:main": {
        sessionId: "main-session",
        channel: "zulip",
        lastChannel: "zulip",
        lastTo: "stream:marcel#topic",
      },
    };
    hoisted.callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string; params?: Record<string, unknown> };
      if (typed.method === "agent") {
        agentCalls.push(typed);
        return { runId: "run-main", status: "ok" };
      }
      if (typed.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
        };
      }
      if (typed.method === "sessions.patch" || typed.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:child",
      childRunId: "run-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      roundOneReply: "findings",
      startedAt: 1000,
      endedAt: 3000,
      outcome: {
        status: "ok",
        iterationLimitReached: true,
        iterationsUsed: 5,
        maxIterations: 20,
      },
    });

    const messageRaw = agentCalls[0]?.params?.message;
    const message = typeof messageRaw === "string" ? messageRaw : JSON.stringify(messageRaw ?? "");
    expect(message).toContain("## Completion Metadata");
    expect(message).toContain("- Status: iteration_limit");
    expect(message).toContain("- Iterations used: 5/20");
    expect(message).toContain("- Duration:");
    expect(message).toContain("- Tokens:");
    expect(message).toContain("Stats: runtime");
  });

  it("includes concise completion metadata in direct completion-mode messages", async () => {
    const sendCalls: Array<{ params?: Record<string, unknown> }> = [];
    hoisted.sessionStore = {
      "agent:main:subagent:child": {
        sessionId: "child-session",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      "agent:main:main": {
        sessionId: "main-session",
      },
    };
    hoisted.callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string; params?: Record<string, unknown> };
      if (typed.method === "send") {
        sendCalls.push(typed);
        return { ok: true };
      }
      if (typed.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }],
        };
      }
      if (typed.method === "sessions.patch" || typed.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:child",
      childRunId: "run-child-completion",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "zulip", to: "stream:marcel#topic" },
      task: "task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      roundOneReply: "final answer",
      startedAt: 1000,
      endedAt: 3000,
      outcome: {
        status: "ok",
      },
      expectsCompletionMessage: true,
    });

    const messageRaw = sendCalls[0]?.params?.message;
    const message = typeof messageRaw === "string" ? messageRaw : JSON.stringify(messageRaw ?? "");
    expect(message).toContain("- Status: completed");
    expect(message).toContain("- Iterations:");
    expect(message).toContain("- Duration:");
    expect(message).toContain("- Tokens:");
    expect(message).not.toContain("## Completion Metadata");
  });

  it("shows iteration usage as unknown when maxIterations is not set", async () => {
    const agentCalls: Array<{ params?: Record<string, unknown> }> = [];
    hoisted.sessionStore = {
      "agent:main:subagent:child": {
        sessionId: "child-session",
      },
      "agent:main:main": {
        sessionId: "main-session",
        channel: "zulip",
        lastChannel: "zulip",
        lastTo: "stream:marcel#topic",
      },
    };
    hoisted.callGatewayMock.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string; params?: Record<string, unknown> };
      if (typed.method === "agent") {
        agentCalls.push(typed);
        return { runId: "run-main", status: "ok" };
      }
      if (typed.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }],
        };
      }
      if (typed.method === "sessions.patch" || typed.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:child",
      childRunId: "run-child-2",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "task",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      roundOneReply: "findings",
      startedAt: 1000,
      endedAt: 3000,
      outcome: {
        status: "ok",
      },
    });

    const messageRaw = agentCalls[0]?.params?.message;
    const message = typeof messageRaw === "string" ? messageRaw : JSON.stringify(messageRaw ?? "");
    expect(message).toContain("- Iterations used: unknown");
  });
});
