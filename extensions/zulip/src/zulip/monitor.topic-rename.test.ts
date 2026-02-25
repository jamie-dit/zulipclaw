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
  loadZulipProcessedMessageState: vi.fn(),
  writeZulipProcessedMessageState: vi.fn(),
  isZulipMessageAlreadyProcessed: vi.fn(),
  markZulipMessageProcessed: vi.fn(),
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

vi.mock("./processed-message-state.js", () => ({
  loadZulipProcessedMessageState: mocks.loadZulipProcessedMessageState,
  writeZulipProcessedMessageState: mocks.writeZulipProcessedMessageState,
  isZulipMessageAlreadyProcessed: mocks.isZulipMessageAlreadyProcessed,
  markZulipMessageProcessed: mocks.markZulipMessageProcessed,
}));

import { monitorZulipProvider } from "./monitor.js";

type ZulipEventMessage = {
  id: number;
  type: "stream";
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  timestamp?: number;
};

type ZulipQueueEvent = {
  id: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  stream_id?: number;
  orig_stream_id?: number;
};

type ContextPayload = {
  SessionKey?: string;
  To?: string;
  MessageSid?: string;
};

function waitForCondition(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("condition timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createHarness(events: ZulipQueueEvent[]) {
  const dispatchReplyFromConfig = vi.fn(async () => undefined);
  const registerForms: Array<Record<string, unknown>> = [];

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
        chunkMarkdownText: vi.fn((value: string) => [value]),
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
          dispatcher: {
            sendToolResult: vi.fn(() => true),
            sendBlockReply: vi.fn(() => true),
            sendFinalReply: vi.fn(() => true),
            waitForIdle: vi.fn(async () => undefined),
            getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
            markComplete: vi.fn(),
          },
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
      enabled: false,
      onStart: "eyes",
      onSuccess: "check",
      onFailure: "warning",
      clearOnFinish: true,
    },
  });

  mocks.buildZulipQueuePlan.mockReturnValue([{ stream: "marcel" }]);
  mocks.buildZulipRegisterNarrow.mockReturnValue(JSON.stringify([["stream", "marcel"]]));
  mocks.downloadZulipUploads.mockResolvedValue([]);
  mocks.resolveOutboundMedia.mockResolvedValue({
    buffer: Buffer.from(""),
    contentType: "image/png",
    filename: "x.png",
  });
  mocks.uploadZulipFile.mockResolvedValue("https://zulip.example.com/user_uploads/file.png");
  mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 99 });

  mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
  mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
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
  mocks.loadZulipProcessedMessageState.mockResolvedValue({
    version: 1,
    accountId: "default",
    updatedAtMs: 0,
    streamWatermarks: {},
  });
  mocks.writeZulipProcessedMessageState.mockResolvedValue(undefined);
  mocks.isZulipMessageAlreadyProcessed.mockImplementation(
    ({
      state,
      stream,
      messageId,
    }: {
      state: { streamWatermarks?: Record<string, number> };
      stream: string;
      messageId: number;
    }) => {
      const watermark = state.streamWatermarks?.[stream];
      return typeof watermark === "number" && messageId <= watermark;
    },
  );
  mocks.markZulipMessageProcessed.mockImplementation(
    ({
      state,
      stream,
      messageId,
    }: {
      state: Record<string, unknown>;
      stream: string;
      messageId: number;
    }) => {
      const watermarks = {
        ...(state.streamWatermarks as Record<string, number> | undefined),
      };
      const current = watermarks[stream] ?? 0;
      if (messageId <= current) {
        return { state, updated: false };
      }
      return {
        updated: true,
        state: {
          ...state,
          streamWatermarks: {
            ...watermarks,
            [stream]: messageId,
          },
          updatedAtMs: Date.now(),
        },
      };
    },
  );

  let pollCount = 0;
  mocks.zulipRequest.mockImplementation(
    async ({
      path,
      method,
      form,
      abortSignal,
    }: {
      path: string;
      method?: string;
      form?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      if (path === "/api/v1/users/me") {
        return { result: "success", user_id: 9 };
      }
      if (path === "/api/v1/register") {
        registerForms.push(form ?? {});
        return { result: "success", queue_id: "queue-1", last_event_id: 100 };
      }
      if (path === "/api/v1/events" && method === "DELETE") {
        return { result: "success" };
      }
      if (path === "/api/v1/events") {
        pollCount += 1;
        if (pollCount === 1) {
          return { result: "success", events };
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

  return { dispatchReplyFromConfig, registerForms };
}

function makeMessage(messageId: number, topic: string): ZulipEventMessage {
  return {
    id: messageId,
    type: "stream",
    sender_id: 55,
    sender_full_name: "Tester",
    display_recipient: "marcel",
    stream_id: 42,
    subject: topic,
    content: "hello",
    timestamp: Math.floor(Date.now() / 1000),
  };
}

describe("monitorZulipProvider topic rename session continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to update_message events and creates rename aliases", async () => {
    const { dispatchReplyFromConfig, registerForms } = createHarness([
      {
        id: 101,
        type: "update_message",
        orig_subject: "alpha",
        subject: "beta",
      },
      {
        id: 102,
        message: makeMessage(9001, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const registerForm = registerForms[0];
    const eventTypes = JSON.parse(String(registerForm?.event_types ?? "[]")) as string[];
    expect(eventTypes).toContain("update_message");

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    expect(ctx.SessionKey).toBe("session-key:topic:alpha");
    expect(ctx.To).toBe("stream:marcel#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("keeps the same session key for messages after a topic rename", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        message: makeMessage(9001, "alpha"),
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "alpha",
        subject: "beta",
      },
      {
        id: 103,
        message: makeMessage(9002, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = dispatchReplyFromConfig.mock.calls.map(
      ([arg]) => (arg as { ctx: ContextPayload }).ctx,
    );
    const first = contexts.find((ctx) => ctx.MessageSid === "9001");
    const second = contexts.find((ctx) => ctx.MessageSid === "9002");

    expect(first?.SessionKey).toBe("session-key:topic:alpha");
    expect(second?.SessionKey).toBe("session-key:topic:alpha");
    expect(second?.To).toBe("stream:marcel#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("resolves chained topic renames to the original canonical session key", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        type: "update_message",
        orig_topic: "alpha",
        topic: "beta",
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "beta",
        subject: "gamma",
      },
      {
        id: 103,
        message: makeMessage(9003, "gamma"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    expect(ctx.SessionKey).toBe("session-key:topic:alpha");
    expect(ctx.To).toBe("stream:marcel#gamma");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("ignores non-rename update_message events", async () => {
    const { dispatchReplyFromConfig } = createHarness([
      {
        id: 101,
        type: "update_message",
        subject: "beta",
      },
      {
        id: 102,
        type: "update_message",
        orig_subject: "beta",
        subject: "beta",
      },
      {
        id: 103,
        message: makeMessage(9004, "beta"),
      },
    ]);

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    expect(ctx.SessionKey).toBe("session-key:topic:beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });
});

// --- Cross-stream topic move tests ---

function makeMessageForStream(
  messageId: number,
  topic: string,
  streamName: string,
  streamId: number,
): ZulipEventMessage {
  return {
    id: messageId,
    type: "stream",
    sender_id: 55,
    sender_full_name: "Tester",
    display_recipient: streamName,
    stream_id: streamId,
    subject: topic,
    content: "hello",
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function createCrossStreamHarness(streamEvents: Record<string, ZulipQueueEvent[]>) {
  const dispatchReplyFromConfig = vi.fn(async () => undefined);

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
        chunkMarkdownText: vi.fn((value: string) => [value]),
      },
      activity: {
        record: vi.fn(),
      },
      routing: {
        // Return different session keys per stream so cross-stream resolution is testable.
        resolveAgentRoute: vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `session-key-${peer.id}`,
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
          dispatcher: {
            sendToolResult: vi.fn(() => true),
            sendBlockReply: vi.fn(() => true),
            sendFinalReply: vi.fn(() => true),
            waitForIdle: vi.fn(async () => undefined),
            getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
            markComplete: vi.fn(),
          },
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

  const streams = Object.keys(streamEvents);
  mocks.resolveZulipAccount.mockReturnValue({
    accountId: "default",
    baseUrl: "https://zulip.example.com",
    email: "bot@zulip.example.com",
    apiKey: "api-key",
    streams,
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

  mocks.buildZulipQueuePlan.mockReturnValue(streams.map((s) => ({ stream: s })));
  mocks.buildZulipRegisterNarrow.mockImplementation((s: string) => JSON.stringify([["stream", s]]));
  mocks.downloadZulipUploads.mockResolvedValue([]);
  mocks.resolveOutboundMedia.mockResolvedValue({
    buffer: Buffer.from(""),
    contentType: "image/png",
    filename: "x.png",
  });
  mocks.uploadZulipFile.mockResolvedValue("https://zulip.example.com/user_uploads/file.png");
  mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 99 });

  mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
  mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
  mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
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
  mocks.loadZulipProcessedMessageState.mockResolvedValue({
    version: 1,
    accountId: "default",
    updatedAtMs: 0,
    streamWatermarks: {},
  });
  mocks.writeZulipProcessedMessageState.mockResolvedValue(undefined);
  mocks.isZulipMessageAlreadyProcessed.mockImplementation(
    ({
      state,
      stream,
      messageId,
    }: {
      state: { streamWatermarks?: Record<string, number> };
      stream: string;
      messageId: number;
    }) => {
      const watermark = state.streamWatermarks?.[stream];
      return typeof watermark === "number" && messageId <= watermark;
    },
  );
  mocks.markZulipMessageProcessed.mockImplementation(
    ({
      state,
      stream,
      messageId,
    }: {
      state: Record<string, unknown>;
      stream: string;
      messageId: number;
    }) => {
      const watermarks = {
        ...(state.streamWatermarks as Record<string, number> | undefined),
      };
      const current = watermarks[stream] ?? 0;
      if (messageId <= current) {
        return { state, updated: false };
      }
      return {
        updated: true,
        state: {
          ...state,
          streamWatermarks: {
            ...watermarks,
            [stream]: messageId,
          },
          updatedAtMs: Date.now(),
        },
      };
    },
  );

  const subscriptions = [
    { stream_id: 42, name: "marcel" },
    { stream_id: 99, name: "marcel-dreamit" },
  ];

  let queueCounter = 0;
  const queueToStream = new Map<string, string>();
  const streamPollCounts = new Map<string, number>();

  mocks.zulipRequest.mockImplementation(
    async ({
      path,
      method,
      form,
      query,
      abortSignal,
    }: {
      path: string;
      method?: string;
      form?: Record<string, unknown>;
      query?: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }) => {
      if (path === "/api/v1/users/me") {
        return { result: "success", user_id: 9 };
      }
      if (path === "/api/v1/users/me/subscriptions") {
        return { result: "success", subscriptions };
      }
      if (path === "/api/v1/register") {
        queueCounter++;
        const queueId = `queue-${queueCounter}`;
        const narrow = JSON.parse(String(form?.narrow ?? "[]")) as string[][];
        const streamName = narrow[0]?.[1] ?? "unknown";
        queueToStream.set(queueId, streamName);
        return { result: "success", queue_id: queueId, last_event_id: 100 };
      }
      if (path === "/api/v1/events" && method === "DELETE") {
        return { result: "success" };
      }
      if (path === "/api/v1/events") {
        const queueId = String(query?.queue_id ?? "");
        const streamName = queueToStream.get(queueId) ?? "";
        const count = (streamPollCounts.get(streamName) ?? 0) + 1;
        streamPollCounts.set(streamName, count);
        if (count === 1) {
          return { result: "success", events: streamEvents[streamName] ?? [] };
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
      if (path === "/api/v1/messages" && method === "GET") {
        return { result: "success", messages: [] };
      }
      return { result: "success" };
    },
  );

  return { dispatchReplyFromConfig };
}

describe("monitorZulipProvider cross-stream topic move session continuity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maintains session key from original stream after cross-stream move", async () => {
    const { dispatchReplyFromConfig } = createCrossStreamHarness({
      marcel: [
        {
          id: 101,
          message: makeMessageForStream(9001, "alpha", "marcel", 42),
        },
      ],
      "marcel-dreamit": [
        {
          id: 201,
          type: "update_message",
          subject: "alpha",
          stream_id: 99,
          orig_stream_id: 42,
        },
        {
          id: 202,
          message: makeMessageForStream(9002, "alpha", "marcel-dreamit", 99),
        },
      ],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = dispatchReplyFromConfig.mock.calls.map(
      ([arg]) => (arg as { ctx: ContextPayload }).ctx,
    );
    const first = contexts.find((ctx) => ctx.MessageSid === "9001");
    const second = contexts.find((ctx) => ctx.MessageSid === "9002");

    // Both messages should use the original stream's session key.
    expect(first?.SessionKey).toBe("session-key-marcel:topic:alpha");
    expect(second?.SessionKey).toBe("session-key-marcel:topic:alpha");
    // But replies should go to the actual current stream.
    expect(second?.To).toBe("stream:marcel-dreamit#alpha");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("handles cross-stream move + topic rename in same event", async () => {
    const { dispatchReplyFromConfig } = createCrossStreamHarness({
      marcel: [
        {
          id: 101,
          message: makeMessageForStream(9001, "alpha", "marcel", 42),
        },
      ],
      "marcel-dreamit": [
        {
          id: 201,
          type: "update_message",
          orig_subject: "alpha",
          subject: "beta",
          stream_id: 99,
          orig_stream_id: 42,
        },
        {
          id: 202,
          message: makeMessageForStream(9002, "beta", "marcel-dreamit", 99),
        },
      ],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 2);

    const contexts = dispatchReplyFromConfig.mock.calls.map(
      ([arg]) => (arg as { ctx: ContextPayload }).ctx,
    );
    const first = contexts.find((ctx) => ctx.MessageSid === "9001");
    const second = contexts.find((ctx) => ctx.MessageSid === "9002");

    // Both should resolve back to the original stream's session key with original topic.
    expect(first?.SessionKey).toBe("session-key-marcel:topic:alpha");
    expect(second?.SessionKey).toBe("session-key-marcel:topic:alpha");
    expect(second?.To).toBe("stream:marcel-dreamit#beta");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("handles cross-stream move followed by topic rename in new stream", async () => {
    const { dispatchReplyFromConfig } = createCrossStreamHarness({
      marcel: [],
      "marcel-dreamit": [
        // First: cross-stream move (topic "alpha" from marcel to marcel-dreamit)
        {
          id: 201,
          type: "update_message",
          subject: "alpha",
          stream_id: 99,
          orig_stream_id: 42,
        },
        // Then: topic rename within new stream (alpha -> gamma)
        {
          id: 202,
          type: "update_message",
          orig_subject: "alpha",
          subject: "gamma",
        },
        {
          id: 203,
          message: makeMessageForStream(9003, "gamma", "marcel-dreamit", 99),
        },
      ],
    });

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    // Should chain: gamma -> alpha (same-stream rename in marcel-dreamit) -> alpha in marcel (cross-stream)
    expect(ctx.SessionKey).toBe("session-key-marcel:topic:alpha");
    expect(ctx.To).toBe("stream:marcel-dreamit#gamma");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });

  it("does not create cross-stream alias when stream IDs cannot be resolved", async () => {
    // Use a harness where the subscriptions don't include the orig stream
    const dispatchReplyFromConfig = vi.fn(async () => undefined);

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
          chunkMarkdownText: vi.fn((value: string) => [value]),
        },
        activity: {
          record: vi.fn(),
        },
        routing: {
          resolveAgentRoute: vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
            sessionKey: `session-key-${peer.id}`,
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
            dispatcher: {
              sendToolResult: vi.fn(() => true),
              sendBlockReply: vi.fn(() => true),
              sendFinalReply: vi.fn(() => true),
              waitForIdle: vi.fn(async () => undefined),
              getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
              markComplete: vi.fn(),
            },
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
      streams: ["marcel-dreamit"],
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
    mocks.buildZulipQueuePlan.mockReturnValue([{ stream: "marcel-dreamit" }]);
    mocks.buildZulipRegisterNarrow.mockImplementation((s: string) =>
      JSON.stringify([["stream", s]]),
    );
    mocks.downloadZulipUploads.mockResolvedValue([]);
    mocks.sendZulipStreamMessage.mockResolvedValue({ result: "success", id: 99 });
    mocks.loadZulipInFlightCheckpoints.mockResolvedValue([]);
    mocks.writeZulipInFlightCheckpoint.mockResolvedValue(undefined);
    mocks.clearZulipInFlightCheckpoint.mockResolvedValue(undefined);
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
    mocks.loadZulipProcessedMessageState.mockResolvedValue({
      version: 1,
      accountId: "default",
      updatedAtMs: 0,
      streamWatermarks: {},
    });
    mocks.writeZulipProcessedMessageState.mockResolvedValue(undefined);
    mocks.isZulipMessageAlreadyProcessed.mockImplementation(
      ({
        state,
        stream,
        messageId,
      }: {
        state: { streamWatermarks?: Record<string, number> };
        stream: string;
        messageId: number;
      }) => {
        const watermark = state.streamWatermarks?.[stream];
        return typeof watermark === "number" && messageId <= watermark;
      },
    );
    mocks.markZulipMessageProcessed.mockImplementation(
      ({
        state,
        stream,
        messageId,
      }: {
        state: Record<string, unknown>;
        stream: string;
        messageId: number;
      }) => {
        const watermarks = {
          ...(state.streamWatermarks as Record<string, number> | undefined),
        };
        const current = watermarks[stream] ?? 0;
        if (messageId <= current) {
          return { state, updated: false };
        }
        return {
          updated: true,
          state: {
            ...state,
            streamWatermarks: {
              ...watermarks,
              [stream]: messageId,
            },
            updatedAtMs: Date.now(),
          },
        };
      },
    );

    let pollCount = 0;
    mocks.zulipRequest.mockImplementation(
      async ({
        path,
        method,
        abortSignal,
      }: {
        path: string;
        method?: string;
        abortSignal?: AbortSignal;
      }) => {
        if (path === "/api/v1/users/me") {
          return { result: "success", user_id: 9 };
        }
        // Subscriptions only know about marcel-dreamit (stream_id 99), NOT marcel (42).
        if (path === "/api/v1/users/me/subscriptions") {
          return {
            result: "success",
            subscriptions: [{ stream_id: 99, name: "marcel-dreamit" }],
          };
        }
        if (path === "/api/v1/register") {
          return { result: "success", queue_id: "queue-1", last_event_id: 100 };
        }
        if (path === "/api/v1/events" && method === "DELETE") {
          return { result: "success" };
        }
        if (path === "/api/v1/events") {
          pollCount += 1;
          if (pollCount === 1) {
            return {
              result: "success",
              events: [
                {
                  id: 201,
                  type: "update_message",
                  subject: "alpha",
                  stream_id: 99,
                  orig_stream_id: 42,
                },
                {
                  id: 202,
                  message: makeMessageForStream(9002, "alpha", "marcel-dreamit", 99),
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

    const monitor = await monitorZulipProvider({
      config: {} as never,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    });

    await waitForCondition(() => dispatchReplyFromConfig.mock.calls.length >= 1);

    const ctx = (dispatchReplyFromConfig.mock.calls[0]?.[0] as { ctx: ContextPayload }).ctx;
    // Cross-stream alias was NOT created (orig stream ID 42 not resolvable).
    // So the message uses the actual stream (marcel-dreamit) session key.
    expect(ctx.SessionKey).toBe("session-key-marcel-dreamit:topic:alpha");

    monitor.stop();
    await (monitor as { done: Promise<void> }).done;
  });
});
