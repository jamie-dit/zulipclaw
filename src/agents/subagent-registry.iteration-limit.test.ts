import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

let lifecycleHandler:
  | ((evt: { stream?: string; runId: string; data?: { phase?: string } }) => void)
  | undefined;

const continuationResolvers: Array<() => void> = [];
const continuationMessages: string[] = [];

const callGatewayMock = vi.fn(async (request: unknown) => {
  const typed = request as { method?: string; params?: Record<string, unknown> };
  if (typed.method === "agent.wait") {
    return new Promise<unknown>(() => undefined);
  }
  if (typed.method === "chat.history") {
    return {
      messages: [{ role: "assistant" }],
    };
  }
  if (typed.method === "agent") {
    const message = typeof typed.params?.message === "string" ? typed.params.message : "";
    if (message.includes("[System] Iteration limit reached")) {
      continuationMessages.push(message);
      return new Promise((resolve) => {
        continuationResolvers.push(() => resolve({ runId: "run-final" }));
      });
    }
    return { runId: "run-generic" };
  }
  return {};
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (request: unknown) => callGatewayMock(request),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent iteration-limit continuation guard", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeEach(async () => {
    callGatewayMock.mockClear();
    announceSpy.mockClear();
    continuationResolvers.length = 0;
    continuationMessages.length = 0;
    lifecycleHandler = undefined;
    mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  const flush = async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  it("schedules the forced final-turn continuation at most once across duplicate completion events", async () => {
    mod.registerSubagentRun({
      runId: "run-initial",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do work",
      cleanup: "keep",
      maxIterations: 1,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-initial",
      data: { phase: "end" },
    });
    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-initial",
      data: { phase: "end" },
    });

    await flush();
    expect(continuationMessages).toHaveLength(1);

    continuationResolvers[0]?.();
    await flush();

    const runsAfterReplacement = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runsAfterReplacement).toHaveLength(1);
    expect(runsAfterReplacement[0]?.runId).toBe("run-final");
    expect(runsAfterReplacement[0]?.iterationLimitFinalTurnRequested).toBe(true);
    expect(runsAfterReplacement[0]?.iterationLimitContinuationScheduled).toBe(true);

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-final",
      data: { phase: "end" },
    });
    await flush();

    expect(continuationMessages).toHaveLength(1);
    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as {
      childRunId?: string;
      outcome?: { iterationLimitReached?: boolean };
    };
    expect(announce.childRunId).toBe("run-final");
    expect(announce.outcome?.iterationLimitReached).toBe(true);
  });
});
