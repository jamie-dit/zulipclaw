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

import { monitorZulipProvider } from "./monitor.js";

describe("monitorZulipProvider cleanup race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("waits for dispatcher idle before cleanup so final reply is not aborted", async () => {
    const markDispatchIdle = vi.fn();
    const markComplete = vi.fn();

    let queuedDeliver: ((payload: { text?: string }) => Promise<void>) | null = null;
    let sendChain: Promise<void> = Promise.resolve();

    const waitForIdle = vi.fn(() => sendChain);

    const dispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn((payload: { text?: string }) => {
        sendChain = sendChain.then(async () => {
          // Explicit microtask boundary makes the cleanup race deterministic.
          await Promise.resolve();
          if (queuedDeliver) {
            await queuedDeliver(payload);
          }
        });
        return true;
      }),
      waitForIdle,
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 1 })),
      markComplete,
    };

    const dispatchReplyFromConfig = vi.fn(
      async ({ dispatcher: d }: { dispatcher: typeof dispatcher }) => {
        d.sendFinalReply({ text: "Final reply" });
      },
    );

    const runtime = {
      logging: {
        getChildLogger: vi.fn(() => ({
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        })),
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
          createReplyDispatcherWithTyping: vi.fn(
            ({ deliver }: { deliver: (payload: { text?: string }) => Promise<void> }) => {
              queuedDeliver = deliver;
              return {
                dispatcher,
                replyOptions: {},
                markDispatchIdle,
              };
            },
          ),
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
        enabled: false,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        clearOnFinish: true,
      },
    });

    mocks.buildZulipQueuePlan.mockReturnValue([{ stream: "marcel" }]);
    mocks.buildZulipRegisterNarrow.mockReturnValue(JSON.stringify([["stream", "marcel"]]));

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
              events: [
                {
                  id: 101,
                  message: {
                    id: 777,
                    type: "stream",
                    sender_id: 55,
                    sender_full_name: "Tester",
                    display_recipient: "marcel",
                    stream_id: 42,
                    subject: "general",
                    content: "hello",
                    timestamp: Math.floor(Date.now() / 1000),
                  },
                },
              ],
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

    let firstSendOutcome: "resolved" | "aborted" | null = null;
    let resolveFirstSendDone: (() => void) | null = null;
    const firstSendDone = new Promise<void>((resolve) => {
      resolveFirstSendDone = resolve;
    });

    mocks.sendZulipStreamMessage.mockImplementation(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        try {
          await new Promise<void>((innerResolve, innerReject) => {
            const onAbort = () => {
              clearTimeout(timer);
              abortSignal?.removeEventListener("abort", onAbort);
              const err = new Error("aborted");
              err.name = "AbortError";
              innerReject(err);
            };

            const timer = setTimeout(() => {
              abortSignal?.removeEventListener("abort", onAbort);
              innerResolve();
            }, 25);

            if (abortSignal?.aborted) {
              onAbort();
              return;
            }
            abortSignal?.addEventListener("abort", onAbort, { once: true });
          });

          if (firstSendOutcome == null) {
            firstSendOutcome = "resolved";
            resolveFirstSendDone?.();
          }
          return { result: "success", id: 991 };
        } catch (err) {
          if (firstSendOutcome == null) {
            firstSendOutcome = "aborted";
            resolveFirstSendDone?.();
          }
          throw err;
        }
      },
    );

    mocks.downloadZulipUploads.mockResolvedValue([]);
    mocks.resolveOutboundMedia.mockResolvedValue({
      buffer: Buffer.from(""),
      contentType: "image/png",
      filename: "x.png",
    });
    mocks.uploadZulipFile.mockResolvedValue("https://zulip.example.com/user_uploads/file.png");

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await firstSendDone;

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;

    expect(markComplete).toHaveBeenCalledTimes(1);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(markDispatchIdle).toHaveBeenCalledTimes(1);
    expect(mocks.sendZulipStreamMessage).toHaveBeenCalled();
    expect(firstSendOutcome).toBe("resolved");

    // Regression assertion: if cleanup aborts too early, sendZulipStreamMessage would reject
    // with AbortError before waitForIdle settles and firstSendOutcome would be "aborted".
  });
});
