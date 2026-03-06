import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReplyPrefixOptions: vi.fn(),
  getZulipRuntime: vi.fn(),
  resolveZulipAccount: vi.fn(),
  zulipRequest: vi.fn(),
  sendZulipStreamMessage: vi.fn(),
  downloadZulipUploads: vi.fn(),
  resolveOutboundMedia: vi.fn(),
  uploadZulipFile: vi.fn(),
  addZulipReaction: vi.fn(),
  removeZulipReaction: vi.fn(),
  buildZulipQueuePlan: vi.fn(),
  buildZulipRegisterNarrow: vi.fn(),
  loadZulipInFlightCheckpoints: vi.fn(),
  writeZulipInFlightCheckpoint: vi.fn(),
  clearZulipInFlightCheckpoint: vi.fn(),
  isZulipCheckpointStale: vi.fn(),
  prepareZulipCheckpointForRecovery: vi.fn(),
  markZulipCheckpointFailure: vi.fn(),
  buildZulipCheckpointId: vi.fn(),
  registerMainRelayRun: vi.fn(),
  isRelayRunRegistered: vi.fn(),
  updateRelayRunModel: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk")>();
  return {
    ...actual,
    createReplyPrefixOptions: mocks.createReplyPrefixOptions,
  };
});

vi.mock("../runtime.js", () => ({
  getZulipRuntime: mocks.getZulipRuntime,
}));

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: mocks.resolveZulipAccount,
}));

vi.mock("./client.js", () => ({
  zulipRequest: mocks.zulipRequest,
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: mocks.sendZulipStreamMessage,
  editZulipStreamMessage: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./uploads.js", () => ({
  downloadZulipUploads: mocks.downloadZulipUploads,
  resolveOutboundMedia: mocks.resolveOutboundMedia,
  uploadZulipFile: mocks.uploadZulipFile,
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: mocks.addZulipReaction,
  removeZulipReaction: mocks.removeZulipReaction,
}));

vi.mock("./queue-plan.js", () => ({
  buildZulipQueuePlan: mocks.buildZulipQueuePlan,
  buildZulipRegisterNarrow: mocks.buildZulipRegisterNarrow,
}));

vi.mock("./inflight-checkpoints.js", () => ({
  ZULIP_INFLIGHT_CHECKPOINT_VERSION: 1,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT: 25,
  loadZulipInFlightCheckpoints: mocks.loadZulipInFlightCheckpoints,
  writeZulipInFlightCheckpoint: mocks.writeZulipInFlightCheckpoint,
  clearZulipInFlightCheckpoint: mocks.clearZulipInFlightCheckpoint,
  isZulipCheckpointStale: mocks.isZulipCheckpointStale,
  prepareZulipCheckpointForRecovery: mocks.prepareZulipCheckpointForRecovery,
  markZulipCheckpointFailure: mocks.markZulipCheckpointFailure,
  buildZulipCheckpointId: mocks.buildZulipCheckpointId,
}));

vi.mock("../../../../src/agents/subagent-relay.js", () => ({
  registerMainRelayRun: mocks.registerMainRelayRun,
  isRelayRunRegistered: mocks.isRelayRunRegistered,
  updateRelayRunModel: mocks.updateRelayRunModel,
}));

import { monitorZulipProvider } from "./monitor.js";

describe("monitorZulipProvider backpressure acknowledgements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerMainRelayRun.mockReturnValue(false);
    mocks.isRelayRunRegistered.mockReturnValue(false);
    mocks.updateRelayRunModel.mockImplementation(() => undefined);
    mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
    mocks.isZulipCheckpointStale.mockReturnValue(false);
    mocks.prepareZulipCheckpointForRecovery.mockImplementation(
      ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
    );
    mocks.markZulipCheckpointFailure.mockImplementation(
      ({ checkpoint }: { checkpoint: Record<string, unknown> }) => checkpoint,
    );
    mocks.buildZulipCheckpointId.mockImplementation(
      ({ accountId, messageId }: { accountId: string; messageId: number }) =>
        `${accountId}:${messageId}`,
    );
    mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
    mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
  });

  it("sends the queued reaction before a saturated handler pool frees a slot", async () => {
    const pendingDispatches = new Map<number, () => void>();
    const dispatchStarted: number[] = [];
    let resolveAckForQueuedMessage: (() => void) | null = null;
    const ackForQueuedMessage = new Promise<void>((resolve) => {
      resolveAckForQueuedMessage = resolve;
    });

    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => undefined),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };

    const dispatchReplyFromConfig = vi.fn(async ({ ctx }: { ctx: { MessageSid?: string } }) => {
      const messageId = Number(ctx.MessageSid);
      dispatchStarted.push(messageId);
      await new Promise<void>((resolve) => {
        pendingDispatches.set(messageId, resolve);
      });
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    const runtime = {
      logging: {
        getChildLogger: vi.fn(() => logger),
      },
      channel: {
        text: {
          chunkMarkdownText: vi.fn((text: string) => [text]),
        },
        activity: {
          record: vi.fn(),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            sessionKey: "session-key",
            agentId: "agent-1",
            accountId: "acc-1",
          })),
        },
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
        reply: {
          formatInboundEnvelope: vi.fn(({ body }: { body: string }) => body),
          finalizeInboundContext: vi.fn((ctx: object) => ctx),
          createReplyDispatcherWithTyping: vi.fn(() => ({
            dispatcher,
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          })),
          resolveHumanDelayConfig: vi.fn(() => ({ mode: "off" })),
          dispatchReplyFromConfig,
        },
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
    };

    mocks.getZulipRuntime.mockReturnValue(runtime);
    mocks.createReplyPrefixOptions.mockReturnValue({ onModelSelected: undefined });
    mocks.resolveZulipAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://zulip.example.com",
      email: "bot@zulip.example.com",
      apiKey: "api-key",
      streams: ["marcel"],
      defaultTopic: "general",
      alwaysReply: true,
      textChunkLimit: 10_000,
      reactions: {
        enabled: true,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
        workflow: {
          enabled: false,
          stages: {
            queued: "eyes",
            processing: "eyes",
            toolRunning: "eyes",
            retrying: "eyes",
            success: "check",
            partialSuccess: "warning",
            failure: "warning",
          },
        },
        genericCallback: {
          enabled: false,
          includeRemoveOps: false,
        },
      },
    });

    mocks.buildZulipQueuePlan.mockReturnValue([{ stream: "marcel" }]);
    mocks.buildZulipRegisterNarrow.mockReturnValue(JSON.stringify([["stream", "marcel"]]));
    mocks.downloadZulipUploads.mockResolvedValue([]);

    let eventsPollCount = 0;
    mocks.zulipRequest.mockImplementation(
      async ({
        path,
        method,
        abortSignal,
      }: {
        path: string;
        method: string;
        abortSignal?: AbortSignal;
      }) => {
        if (path === "/api/v1/users/me") {
          return { result: "success", user_id: 9 };
        }
        if (path === "/api/v1/register") {
          return { result: "success", queue_id: "queue-1", last_event_id: 100 };
        }
        if (path === "/api/v1/events" && method === "DELETE") {
          return { result: "success" };
        }
        if (path === "/api/v1/events") {
          eventsPollCount += 1;
          if (eventsPollCount === 1) {
            return {
              result: "success",
              events: Array.from({ length: 21 }, (_, index) => ({
                id: 101 + index,
                message: {
                  id: 1001 + index,
                  type: "stream",
                  sender_id: 55,
                  sender_full_name: "Tester",
                  display_recipient: "marcel",
                  stream_id: 42,
                  subject: "general",
                  content: `hello ${index + 1}`,
                  timestamp: Math.floor(Date.now() / 1000),
                },
              })),
            };
          }
          return await new Promise<never>((_, reject) => {
            const onAbort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (abortSignal?.aborted) {
              onAbort();
              return;
            }
            abortSignal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (path === "/api/v1/typing") {
          return { result: "success" };
        }
        return { result: "success" };
      },
    );

    mocks.addZulipReaction.mockImplementation(async ({ messageId }: { messageId: number }) => {
      if (messageId === 1021) {
        resolveAckForQueuedMessage?.();
      }
      return { result: "success" };
    });
    mocks.removeZulipReaction.mockResolvedValue({ result: "success" });
    mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 991 });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await ackForQueuedMessage;
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        const sawWaitLog = logger.debug.mock.calls.some(([message]) =>
          String(message).includes('milestone=handler_wait_start source="poll" messageId=1021'),
        );
        if (sawWaitLog) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > 1_000) {
          reject(new Error("handler wait trace log timeout"));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });

    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(20);
    expect(dispatchStarted).not.toContain(1021);
    expect(mocks.addZulipReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 1021,
        emojiName: "eyes",
      }),
    );
    expect(
      logger.debug.mock.calls.some(([message]) =>
        String(message).includes('milestone=handler_wait_start source="poll" messageId=1021'),
      ),
    ).toBe(true);

    for (const resolve of pendingDispatches.values()) {
      resolve();
    }

    monitor.stop();
    await (monitor as unknown as { done: Promise<void> }).done;
  });
});
