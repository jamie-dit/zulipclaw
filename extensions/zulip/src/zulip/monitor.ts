import crypto from "node:crypto";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import {
  isRelayRunRegistered,
  registerMainRelayRun,
  updateRelayRunModel,
} from "../../../../src/agents/subagent-relay.js";
import { getZulipRuntime } from "../runtime.js";
import {
  resolveZulipAccount,
  type ResolvedZulipAccount,
  type ResolvedZulipReactions,
  type ZulipReactionWorkflowStage,
} from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import type { ZulipHttpError } from "./client.js";
import { buildZulipUserAgent, zulipRequest } from "./client.js";
import { createDedupeCache } from "./dedupe.js";
import {
  buildZulipCheckpointId,
  clearZulipInFlightCheckpoint,
  isZulipCheckpointStale,
  loadZulipInFlightCheckpoints,
  markZulipCheckpointFailure,
  prepareZulipCheckpointForRecovery,
  type ZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_CHECKPOINT_VERSION,
  ZULIP_INFLIGHT_MAX_RETRY_COUNT,
  writeZulipInFlightCheckpoint,
} from "./inflight-checkpoints.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import {
  isZulipMessageAlreadyProcessed,
  loadZulipProcessedMessageState,
  markZulipMessageProcessed,
  type ZulipProcessedMessageState,
  writeZulipProcessedMessageState,
} from "./processed-message-state.js";
import { buildZulipQueuePlan, buildZulipRegisterNarrow } from "./queue-plan.js";
import {
  getReactionButtonSession,
  handleReactionEvent,
  startReactionButtonSessionCleanup,
  stopReactionButtonSessionCleanup,
} from "./reaction-buttons.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";
import { ToolProgressAccumulator } from "./tool-progress.js";
import { downloadZulipUploads, resolveOutboundMedia, uploadZulipFile } from "./uploads.js";

export type MonitorZulipOptions = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
  }) => void;
};

type ZulipRegisterResponse = {
  result: "success" | "error";
  msg?: string;
  queue_id?: string;
  last_event_id?: number;
};

type ZulipEventMessage = {
  id: number;
  type: string;
  sender_id: number;
  sender_full_name?: string;
  sender_email?: string;
  display_recipient?: string;
  stream_id?: number;
  subject?: string;
  content?: string;
  content_type?: string;
  timestamp?: number;
};

type ZulipReactionEvent = {
  id?: number;
  type: "reaction";
  op: "add" | "remove";
  message_id: number;
  emoji_name: string;
  emoji_code: string;
  user_id: number;
  user?: {
    email?: string;
    full_name?: string;
    user_id?: number;
  };
  message?: ZulipEventMessage;
};

type ZulipUpdateMessageEvent = {
  id?: number;
  type: "update_message";
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  stream_id?: number;
  orig_stream_id?: number;
};

type ZulipEvent = {
  id?: number;
  type?: string;
  message?: ZulipEventMessage;
  subject?: string;
  orig_subject?: string;
  topic?: string;
  orig_topic?: string;
  stream_id?: number;
  orig_stream_id?: number;
} & Partial<ZulipReactionEvent>;

type ZulipEventsResponse = {
  result: "success" | "error";
  msg?: string;
  events?: ZulipEvent[];
  last_event_id?: number;
};

type ZulipMeResponse = {
  result: "success" | "error";
  msg?: string;
  user_id?: number;
  email?: string;
  full_name?: string;
};

type ZulipMessageSource = "poll" | "catchup" | "freshness" | "recovery";

type ZulipTraceContext = {
  source: ZulipMessageSource;
  activeHandlers: number;
  waiterDepth: number;
};

type PreparedZulipMessage = {
  msg: ZulipEventMessage;
  source: ZulipMessageSource;
  stream: string;
  topic: string;
  content: string;
  isRecovery: boolean;
  queuedReactionStarted: boolean;
  reactionController: ReactionTransitionController | null;
  trace: ZulipTraceContext;
};

export const DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;
export const KEEPALIVE_INITIAL_DELAY_MS = 25_000;
export const KEEPALIVE_REPEAT_INTERVAL_MS = 60_000;
export const ZULIP_RECOVERY_NOTICE = "🔄 Gateway restarted - resuming the previous task now...";

function buildZulipTraceLog(params: {
  accountId: string;
  milestone: string;
  messageId?: number;
  stream?: string;
  topic?: string;
  sessionKey?: string;
  source?: ZulipMessageSource;
  activeHandlers?: number;
  waiterDepth?: number;
  extra?: Record<string, boolean | number | string | undefined>;
}): string {
  const fields: string[] = [`[zulip-trace][${params.accountId}]`, `milestone=${params.milestone}`];

  const pushField = (key: string, value: boolean | number | string | undefined) => {
    if (value === undefined) {
      return;
    }
    if (typeof value === "string") {
      fields.push(`${key}=${JSON.stringify(value)}`);
      return;
    }
    fields.push(`${key}=${String(value)}`);
  };

  pushField("source", params.source);
  pushField("messageId", params.messageId);
  pushField("stream", params.stream);
  pushField("topic", params.topic);
  pushField("sessionKey", params.sessionKey);
  pushField("activeHandlers", params.activeHandlers);
  pushField("waiterDepth", params.waiterDepth);
  for (const [key, value] of Object.entries(params.extra ?? {})) {
    pushField(key, value);
  }

  return fields.join(" ");
}

function buildMainRelayRunId(accountId: string, messageId: number): string {
  return `zulip-main:${accountId}:${messageId}`;
}

function formatKeepaliveElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${totalSeconds}s`;
  }
  if (seconds <= 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function buildKeepaliveMessageContent(elapsedMs: number): string {
  return `🔧 Still working... (${formatKeepaliveElapsed(elapsedMs)} elapsed)`;
}

export function startPeriodicKeepalive(params: {
  sendPing: (elapsedMs: number) => Promise<void>;
  initialDelayMs?: number;
  repeatIntervalMs?: number;
  now?: () => number;
}): () => void {
  const initialDelayMs = params.initialDelayMs ?? KEEPALIVE_INITIAL_DELAY_MS;
  const repeatIntervalMs = params.repeatIntervalMs ?? KEEPALIVE_REPEAT_INTERVAL_MS;
  const now = params.now ?? (() => Date.now());

  const startedAt = now();
  let stopped = false;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;

  const firePing = () => {
    if (stopped) {
      return;
    }
    void params.sendPing(Math.max(0, now() - startedAt)).catch(() => undefined);
  };

  const initialTimer = setTimeout(() => {
    firePing();
    if (stopped) {
      return;
    }
    repeatTimer = setInterval(() => {
      firePing();
    }, repeatIntervalMs);
    repeatTimer.unref?.();
  }, initialDelayMs);

  initialTimer.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(initialTimer);
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
  };
}

export function createBestEffortShutdownNoticeSender(params: {
  sendNotice: () => Promise<void>;
  log?: (message: string) => void;
}): () => void {
  let sent = false;
  return () => {
    if (sent) {
      return;
    }
    sent = true;
    void params.sendNotice().catch((err) => {
      params.log?.(`[zulip] shutdown notice failed: ${String(err)}`);
    });
  };
}

export function computeZulipMonitorBackoffMs(params: {
  attempt: number;
  status: number | null;
  retryAfterMs?: number;
}): number {
  const cappedAttempt = Math.max(1, Math.min(10, Math.floor(params.attempt)));
  // Zulip can rate-limit /events fairly aggressively on some deployments; prefer slower retries.
  const base = params.status === 429 ? 10_000 : 500;
  const max = params.status === 429 ? 120_000 : 30_000;
  const exp = Math.min(max, base * 2 ** Math.min(7, cappedAttempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.max(exp + jitter, params.retryAfterMs ?? 0, base);
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function waitForDispatcherIdleWithTimeout(params: {
  waitForIdle: () => Promise<void>;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const idlePromise = params.waitForIdle();
  try {
    const outcome = await Promise.race<"idle" | "timeout">([
      idlePromise.then(() => "idle"),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);

    if (outcome === "timeout") {
      params.onTimeout?.();
      // Avoid unhandled rejections after timeout while cleanup continues.
      idlePromise.catch(() => undefined);
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function extractZulipHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const value = (err as { status?: unknown }).status;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  const match = /Zulip API error \((\d{3})\):/.exec(String(err));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAuth(account: ResolvedZulipAccount): ZulipAuth {
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing zulip baseUrl/email/apiKey");
  }
  return {
    baseUrl: account.baseUrl,
    email: account.email,
    apiKey: account.apiKey,
    userAgent: buildZulipUserAgent(getZulipRuntime().version),
  };
}

function buildTopicKey(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  const encoded = encodeURIComponent(normalized);
  if (encoded.length <= 80) {
    return encoded;
  }
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 64)}~${digest}`;
}

function isZulipUpdateMessageEvent(event: ZulipEvent): event is ZulipUpdateMessageEvent {
  return event.type === "update_message";
}

function parseTopicRenameEvent(
  event: ZulipEvent,
): { fromTopic: string; toTopic: string; origStreamId?: number; newStreamId?: number } | undefined {
  if (!isZulipUpdateMessageEvent(event)) {
    return undefined;
  }

  const origStreamId = event.orig_stream_id;
  const newStreamId = event.stream_id;
  const isCrossStream =
    typeof origStreamId === "number" &&
    typeof newStreamId === "number" &&
    origStreamId !== newStreamId;

  const fromTopic = normalizeTopic(event.orig_topic ?? event.orig_subject);
  const toTopic = normalizeTopic(event.topic ?? event.subject);

  if (isCrossStream) {
    // For cross-stream moves, the topic name may or may not change.
    // If orig_topic is absent, the topic name stayed the same during the move.
    const effectiveFrom = fromTopic || toTopic;
    const effectiveTo = toTopic || fromTopic;
    if (!effectiveFrom || !effectiveTo) {
      return undefined;
    }
    return { fromTopic: effectiveFrom, toTopic: effectiveTo, origStreamId, newStreamId };
  }

  // Same-stream: require actual topic name change.
  if (!fromTopic || !toTopic) {
    return undefined;
  }

  if (buildTopicKey(fromTopic) === buildTopicKey(toTopic)) {
    return undefined;
  }

  return { fromTopic, toTopic };
}

function resolveCanonicalTopicSessionKey(params: {
  aliases: Map<string, string>;
  stream: string;
  topic: string;
}): { stream: string; topicKey: string } {
  const topicKey = buildTopicKey(params.topic);
  let compositeKey = `${params.stream}\0${topicKey}`;

  const visited = new Set<string>();
  const visitedOrder: string[] = [];

  while (true) {
    const next = params.aliases.get(compositeKey);
    if (!next || next === compositeKey || visited.has(compositeKey)) {
      break;
    }
    visited.add(compositeKey);
    visitedOrder.push(compositeKey);
    compositeKey = next;
  }

  // Path compression: point all intermediate aliases directly at the canonical key.
  if (visitedOrder.length > 0) {
    for (const alias of visitedOrder) {
      params.aliases.set(alias, compositeKey);
    }
  }

  const sepIdx = compositeKey.indexOf("\0");
  const stream = compositeKey.substring(0, sepIdx);
  const resolvedTopicKey = compositeKey.substring(sepIdx + 1);
  return { stream, topicKey: resolvedTopicKey };
}

function recordTopicRenameAlias(params: {
  aliases: Map<string, string>;
  fromStream: string;
  fromTopic: string;
  toStream: string;
  toTopic: string;
}): boolean {
  const fromTopic = normalizeTopic(params.fromTopic);
  const toTopic = normalizeTopic(params.toTopic);
  if (!fromTopic || !toTopic) {
    return false;
  }

  const fromResult = resolveCanonicalTopicSessionKey({
    aliases: params.aliases,
    stream: params.fromStream,
    topic: fromTopic,
  });
  const toResult = resolveCanonicalTopicSessionKey({
    aliases: params.aliases,
    stream: params.toStream,
    topic: toTopic,
  });

  const fromCompositeKey = `${fromResult.stream}\0${fromResult.topicKey}`;
  const toCompositeKey = `${toResult.stream}\0${toResult.topicKey}`;

  if (fromCompositeKey === toCompositeKey) {
    return false;
  }

  params.aliases.set(toCompositeKey, fromCompositeKey);
  return true;
}

function extractZulipTopicDirective(text: string): { topic?: string; text: string } {
  const raw = text ?? "";
  // Allow an agent to create/switch topics by prefixing a reply with:
  // [[zulip_topic: <topic>]]
  const match = /^\s*\[\[zulip_topic:\s*([^\]]+)\]\]\s*\n?/i.exec(raw);
  if (!match) {
    return { text: raw };
  }
  const topic = normalizeTopic(match[1]) || undefined;
  const nextText = raw.slice(match[0].length).trimStart();
  if (!topic) {
    return { text: nextText };
  }
  // Keep topics reasonably short (UI-friendly).
  const truncated = topic.length > 60 ? topic.slice(0, 60).trim() : topic;
  return { topic: truncated || topic, text: nextText };
}

async function fetchZulipMe(auth: ZulipAuth, abortSignal?: AbortSignal): Promise<ZulipMeResponse> {
  return await zulipRequest<ZulipMeResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users/me",
    abortSignal,
  });
}

async function fetchZulipSubscriptions(
  auth: ZulipAuth,
  abortSignal?: AbortSignal,
): Promise<Map<number, string>> {
  try {
    const res = await zulipRequest<{
      result: "success" | "error";
      subscriptions?: Array<{ stream_id: number; name: string }>;
    }>({
      auth,
      method: "GET",
      path: "/api/v1/users/me/subscriptions",
      abortSignal,
    });
    const map = new Map<number, string>();
    if (res.result === "success" && res.subscriptions) {
      for (const sub of res.subscriptions) {
        if (typeof sub.stream_id === "number" && sub.name) {
          map.set(sub.stream_id, sub.name);
        }
      }
    }
    return map;
  } catch {
    // Non-critical: stream ID resolution can also be populated from message events.
    return new Map<number, string>();
  }
}

async function registerQueue(params: {
  auth: ZulipAuth;
  stream: string;
  abortSignal?: AbortSignal;
}): Promise<{ queueId: string; lastEventId: number }> {
  const core = getZulipRuntime();
  const narrow = buildZulipRegisterNarrow(params.stream);
  const res = await zulipRequest<ZulipRegisterResponse>({
    auth: params.auth,
    method: "POST",
    path: "/api/v1/register",
    form: {
      event_types: JSON.stringify(["message", "reaction", "update_message"]),
      apply_markdown: "false",
      narrow,
    },
    abortSignal: params.abortSignal,
  });
  if (res.result !== "success" || !res.queue_id || typeof res.last_event_id !== "number") {
    throw new Error(res.msg || "Failed to register Zulip event queue");
  }
  core.logging
    .getChildLogger({ channel: "zulip" })
    .info(`[zulip] registered queue ${res.queue_id} (narrow=stream:${params.stream})`);
  return { queueId: res.queue_id, lastEventId: res.last_event_id };
}

async function pollEvents(params: {
  auth: ZulipAuth;
  queueId: string;
  lastEventId: number;
  abortSignal?: AbortSignal;
}): Promise<ZulipEventsResponse> {
  // Wrap the parent signal with a per-poll timeout so we don't hang forever
  // if the Zulip server goes unresponsive during long-poll.
  // Must exceed Zulip's server-side long-poll timeout (typically 90s) to avoid
  // unnecessary client-side aborts that trigger queue re-registration and risk
  // dropping messages in the gap between old and new queues.
  const POLL_TIMEOUT_MS = 120_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onTimeout = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  timer = setTimeout(onTimeout, POLL_TIMEOUT_MS);

  const onParentAbort = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  params.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await zulipRequest<ZulipEventsResponse>({
      auth: params.auth,
      method: "GET",
      path: "/api/v1/events",
      query: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
        // Be explicit: we want long-poll behavior to avoid tight polling loops that can trigger 429s.
        dont_block: false,
      },
      abortSignal: controller.signal,
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    params.abortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function shouldIgnoreMessage(params: {
  message: ZulipEventMessage;
  botUserId: number;
  streams: string[];
}): { ignore: boolean; reason?: string } {
  const msg = params.message;
  if (msg.sender_id === params.botUserId) {
    return { ignore: true, reason: "self" };
  }
  if (msg.type !== "stream") {
    return { ignore: true, reason: "dm" };
  }
  const stream = normalizeStreamName(msg.display_recipient);
  if (!stream) {
    return { ignore: true, reason: "missing-stream" };
  }
  if (params.streams.length > 0 && !params.streams.includes(stream)) {
    return { ignore: true, reason: "not-allowed-stream" };
  }
  return { ignore: false };
}

/**
 * Send a one-time "I only work in streams" reply to DM senders.
 * Uses a Set to avoid spamming the same sender repeatedly.
 */
async function replyToDm(params: {
  auth: ZulipAuth;
  senderId: number;
  dmNotifiedSenders: Set<number>;
  log?: (message: string) => void;
}): Promise<void> {
  if (params.dmNotifiedSenders.has(params.senderId)) {
    return;
  }
  params.dmNotifiedSenders.add(params.senderId);
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/messages",
      form: {
        type: "direct",
        to: JSON.stringify([params.senderId]),
        content:
          "👋 I only work in Zulip streams — mention me in a stream to chat! DMs are not supported.",
      },
    });
    params.log?.(`[zulip] sent DM redirect to user ${params.senderId}`);
  } catch (err) {
    params.log?.(`[zulip] failed to send DM redirect: ${String(err)}`);
  }
}

async function sendTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "start",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

async function stopTypingIndicator(params: {
  auth: ZulipAuth;
  streamId: number;
  topic: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    await zulipRequest({
      auth: params.auth,
      method: "POST",
      path: "/api/v1/typing",
      form: {
        op: "stop",
        type: "stream",
        stream_id: params.streamId,
        topic: params.topic,
      },
      abortSignal: params.abortSignal,
    });
  } catch {
    // Best effort — typing indicators are non-critical.
  }
}

async function bestEffortReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  op: "add" | "remove";
  emojiName: string;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const emojiName = params.emojiName;
  if (!emojiName) {
    return;
  }
  try {
    if (params.op === "add") {
      await addZulipReaction({
        auth: params.auth,
        messageId: params.messageId,
        emojiName,
        abortSignal: params.abortSignal,
        log: params.log,
      });
      return;
    }
    await removeZulipReaction({
      auth: params.auth,
      messageId: params.messageId,
      emojiName,
      abortSignal: params.abortSignal,
    });
  } catch (err) {
    params.log?.(`[zulip] reaction ${params.op} ${emojiName} failed: ${String(err)}`);
  }
}

type ReactionTransitionController = {
  transition: (
    stage: ZulipReactionWorkflowStage,
    options?: { abortSignal?: AbortSignal; force?: boolean },
  ) => Promise<void>;
};

function resolveStageEmoji(params: {
  reactions: ResolvedZulipReactions;
  stage: ZulipReactionWorkflowStage;
}): string {
  if (params.reactions.workflow.enabled) {
    const stageEmoji = params.reactions.workflow.stages[params.stage];
    return stageEmoji ?? "";
  }
  switch (params.stage) {
    case "queued":
    case "processing":
    case "toolRunning":
    case "retrying":
      return params.reactions.onStart;
    case "success":
      return params.reactions.onSuccess;
    case "partialSuccess":
    case "failure":
      return params.reactions.onFailure;
    default:
      return "";
  }
}

function createReactionTransitionController(params: {
  auth: ZulipAuth;
  messageId: number;
  reactions: ResolvedZulipReactions;
  log?: (message: string) => void;
  now?: () => number;
}): ReactionTransitionController {
  const now = params.now ?? (() => Date.now());
  let activeEmoji = "";
  let activeStage: ZulipReactionWorkflowStage | null = null;
  let lastTransitionAt = 0;

  return {
    transition: async (stage, options) => {
      const emojiName = resolveStageEmoji({ reactions: params.reactions, stage });
      const force = options?.force === true;
      const workflow = params.reactions.workflow;

      if (workflow.enabled && !force) {
        if (activeStage === stage) {
          return;
        }
        if (workflow.minTransitionMs > 0 && lastTransitionAt > 0) {
          const elapsed = now() - lastTransitionAt;
          if (elapsed < workflow.minTransitionMs) {
            return;
          }
        }
      }

      if (!emojiName) {
        activeStage = stage;
        if (force) {
          lastTransitionAt = now();
        }
        return;
      }

      if (
        workflow.enabled &&
        workflow.replaceStageReaction &&
        activeEmoji &&
        activeEmoji !== emojiName
      ) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "remove",
          emojiName: activeEmoji,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
      }

      if (activeEmoji !== emojiName) {
        await bestEffortReaction({
          auth: params.auth,
          messageId: params.messageId,
          op: "add",
          emojiName,
          log: params.log,
          abortSignal: options?.abortSignal,
        });
        activeEmoji = emojiName;
      }

      activeStage = stage;
      lastTransitionAt = now();
    },
  };
}

function withWorkflowReactionStages<
  T extends {
    sendToolResult: (...args: unknown[]) => unknown;
    sendBlockReply: (...args: unknown[]) => unknown;
    sendFinalReply: (...args: unknown[]) => unknown;
  },
>(
  dispatcher: T,
  reactions: ResolvedZulipReactions,
  controller: ReactionTransitionController,
  abortSignal?: AbortSignal,
): T {
  return {
    ...dispatcher,
    sendToolResult: (...args: unknown[]) => {
      if (reactions.workflow.stages.toolRunning) {
        void controller.transition("toolRunning", { abortSignal });
      }
      return dispatcher.sendToolResult(...args);
    },
    sendBlockReply: (...args: unknown[]) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendBlockReply(...args);
    },
    sendFinalReply: (...args: unknown[]) => {
      if (reactions.workflow.stages.processing) {
        void controller.transition("processing", { abortSignal });
      }
      return dispatcher.sendFinalReply(...args);
    },
  };
}

async function deliverReply(params: {
  account: ResolvedZulipAccount;
  auth: ZulipAuth;
  stream: string;
  topic: string;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}) {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ channel: "zulip" });

  const topicDirective = extractZulipTopicDirective(params.payload.text ?? "");
  const topic = topicDirective.topic ?? params.topic;
  const text = topicDirective.text;
  const mediaUrls = (params.payload.mediaUrls ?? []).filter(Boolean);
  const mediaUrl = params.payload.mediaUrl?.trim();
  if (mediaUrl) {
    mediaUrls.unshift(mediaUrl);
  }

  const sendTextChunks = async (value: string) => {
    const chunks = core.channel.text.chunkMarkdownText(value, params.account.textChunkLimit);
    for (const chunk of chunks.length > 0 ? chunks : [value]) {
      if (!chunk) {
        continue;
      }
      const response = await sendZulipStreamMessage({
        auth: params.auth,
        stream: params.stream,
        topic,
        content: chunk,
        abortSignal: params.abortSignal,
      });
      // Delivery receipt verification: check message ID in response
      if (!response || typeof response.id !== "number") {
        logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
      }
    }
  };

  const trimmedText = text.trim();
  if (!trimmedText && mediaUrls.length === 0) {
    logger.debug(`[zulip] deliverReply: empty response (no text, no media) — skipping`);
    return;
  }
  if (mediaUrls.length === 0) {
    await sendTextChunks(text);
    return;
  }

  // Match core outbound behavior: treat text as a caption for the first media item.
  // If the caption is very long, send it as text chunks first to avoid exceeding limits.
  let caption = trimmedText;
  if (caption.length > params.account.textChunkLimit) {
    await sendTextChunks(text);
    caption = "";
  }

  for (const source of mediaUrls) {
    const resolved = await resolveOutboundMedia({
      cfg: params.cfg,
      accountId: params.account.accountId,
      mediaUrl: source,
    });
    const uploadedUrl = await uploadZulipFile({
      auth: params.auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
      abortSignal: params.abortSignal,
    });
    const content = caption ? `${caption}\n\n${uploadedUrl}` : uploadedUrl;
    const response = await sendZulipStreamMessage({
      auth: params.auth,
      stream: params.stream,
      topic,
      content,
      abortSignal: params.abortSignal,
    });
    // Delivery receipt verification: check message ID in response
    if (!response || typeof response.id !== "number") {
      logger.warn(`[zulip] sendZulipStreamMessage returned invalid or missing message ID`);
    }
    caption = "";
  }
}

export async function monitorZulipProvider(
  opts: MonitorZulipOptions,
): Promise<{ stop: () => void }> {
  const core = getZulipRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveZulipAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (message: string) => core.logging.getChildLogger().info(message),
    error: (message: string) => core.logging.getChildLogger().error(message),
    exit: () => {
      throw new Error("Runtime exit not available");
    },
  };

  const logger = core.logging.getChildLogger({ channel: "zulip", accountId: account.accountId });

  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error(`Zulip credentials missing for account "${account.accountId}"`);
  }
  if (!account.streams.length) {
    throw new Error(
      `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
    );
  }

  const auth = buildAuth(account);
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  let stopped = false;
  const stop = () => {
    stopped = true;
    abortController.abort();
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });

  const run = async () => {
    // Start reaction button session cleanup
    startReactionButtonSessionCleanup();

    const me = await fetchZulipMe(auth, abortSignal);
    if (me.result !== "success" || typeof me.user_id !== "number") {
      throw new Error(me.msg || "Failed to fetch Zulip bot identity");
    }
    const botUserId = me.user_id;
    const botDisplayName = me.full_name?.trim() || "Agent";
    logger.warn(`[zulip-debug][${account.accountId}] bot user_id=${botUserId}`);

    // Dedupe cache prevents reprocessing messages after queue re-registration or reconnect.
    const dedupe = createDedupeCache({ ttlMs: 5 * 60 * 1000, maxSize: 500 });

    // Durable message watermark state prevents duplicate processing across restarts.
    let processedMessageState: ZulipProcessedMessageState = await loadZulipProcessedMessageState({
      accountId: account.accountId,
    });
    let processedMessageWriteChain: Promise<void> = Promise.resolve();
    const persistProcessedMessageState = () => {
      processedMessageWriteChain = processedMessageWriteChain
        .catch(() => undefined)
        .then(async () => {
          await writeZulipProcessedMessageState({ state: processedMessageState });
        })
        .catch((err) => {
          runtime.error?.(
            `[zulip:${account.accountId}] failed to persist processed-message state: ${String(err)}`,
          );
        });
      return processedMessageWriteChain;
    };

    // Track DM senders we've already notified to avoid spam.
    const dmNotifiedSenders = new Set<number>();
    // Topic-rename alias map: composite keys "stream\0topicKey" -> canonical "stream\0topicKey".
    // Supports both same-stream renames and cross-stream topic moves.
    const topicAliases = new Map<string, string>();
    // Stream ID -> stream name mapping for resolving cross-stream move events.
    const streamIdToName = await fetchZulipSubscriptions(auth, abortSignal);

    const logTrace = (params: {
      milestone: string;
      messageId?: number;
      stream?: string;
      topic?: string;
      sessionKey?: string;
      source?: ZulipMessageSource;
      activeHandlers?: number;
      waiterDepth?: number;
      extra?: Record<string, boolean | number | string | undefined>;
    }) => {
      logger.debug?.(
        buildZulipTraceLog({
          accountId: account.accountId,
          ...params,
        }),
      );
    };

    const sendQueuedReaction = async (params: {
      msg: ZulipEventMessage;
      stream: string;
      topic: string;
      source: ZulipMessageSource;
      trace: ZulipTraceContext;
    }): Promise<{
      queuedReactionStarted: boolean;
      reactionController: ReactionTransitionController | null;
    }> => {
      const reactions = account.reactions;
      if (!reactions.enabled) {
        return { queuedReactionStarted: false, reactionController: null };
      }

      logTrace({
        milestone: "queued_reaction_start",
        source: params.source,
        messageId: params.msg.id,
        stream: params.stream,
        topic: params.topic,
        activeHandlers: params.trace.activeHandlers,
        waiterDepth: params.trace.waiterDepth,
      });

      if (reactions.workflow.enabled) {
        const reactionController = createReactionTransitionController({
          auth,
          messageId: params.msg.id,
          reactions,
          log: (message) => logger.debug?.(message),
        });
        await reactionController.transition("queued", { abortSignal });
        logTrace({
          milestone: "queued_reaction_done",
          source: params.source,
          messageId: params.msg.id,
          stream: params.stream,
          topic: params.topic,
          activeHandlers: params.trace.activeHandlers,
          waiterDepth: params.trace.waiterDepth,
          extra: { reactionMode: "workflow" },
        });
        return { queuedReactionStarted: true, reactionController };
      }

      await bestEffortReaction({
        auth,
        messageId: params.msg.id,
        op: "add",
        emojiName: reactions.onStart,
        log: (message) => logger.debug?.(message),
        abortSignal,
      });
      logTrace({
        milestone: "queued_reaction_done",
        source: params.source,
        messageId: params.msg.id,
        stream: params.stream,
        topic: params.topic,
        activeHandlers: params.trace.activeHandlers,
        waiterDepth: params.trace.waiterDepth,
        extra: { reactionMode: "classic" },
      });
      return { queuedReactionStarted: true, reactionController: null };
    };

    const prepareMessageForHandling = async (params: {
      msg: ZulipEventMessage;
      source: ZulipMessageSource;
      activeHandlers: number;
      waiterDepth: number;
      recoveryCheckpoint?: ZulipInFlightCheckpoint;
    }): Promise<PreparedZulipMessage | undefined> => {
      const { msg } = params;
      if (typeof msg.id !== "number") {
        return undefined;
      }
      if (dedupe.check(String(msg.id))) {
        return undefined;
      }

      const ignore = shouldIgnoreMessage({ message: msg, botUserId, streams: account.streams });
      if (ignore.ignore) {
        return undefined;
      }

      const isRecovery = Boolean(params.recoveryCheckpoint);
      const stream = normalizeStreamName(msg.display_recipient);
      const topic = normalizeTopic(msg.subject) || account.defaultTopic;
      const content = msg.content ?? "";
      if (!stream) {
        return undefined;
      }
      if (
        !isRecovery &&
        isZulipMessageAlreadyProcessed({ state: processedMessageState, stream, messageId: msg.id })
      ) {
        logger.debug?.(
          `[zulip:${account.accountId}] skip already-processed message ${msg.id} (${stream}) from durable watermark`,
        );
        return undefined;
      }
      if (!content.trim() && !content.includes("/user_uploads/")) {
        return undefined;
      }

      const trace: ZulipTraceContext = {
        source: params.source,
        activeHandlers: params.activeHandlers,
        waiterDepth: params.waiterDepth,
      };
      logTrace({
        milestone: "event_seen",
        source: params.source,
        messageId: msg.id,
        stream,
        topic,
        activeHandlers: params.activeHandlers,
        waiterDepth: params.waiterDepth,
      });

      if (isRecovery) {
        logger.warn(
          `[zulip:${account.accountId}] replaying recovery checkpoint for message ${msg.id} (${stream}#${topic})`,
        );
      }

      const queuedReaction = isRecovery
        ? { queuedReactionStarted: false, reactionController: null }
        : await sendQueuedReaction({
            msg,
            stream,
            topic,
            source: params.source,
            trace,
          });

      return {
        msg,
        source: params.source,
        stream,
        topic,
        content,
        isRecovery,
        queuedReactionStarted: queuedReaction.queuedReactionStarted,
        reactionController: queuedReaction.reactionController,
        trace,
      };
    };

    const handleMessage = async (
      prepared: PreparedZulipMessage,
      messageOptions?: { recoveryCheckpoint?: ZulipInFlightCheckpoint },
    ) => {
      const msg = prepared.msg;
      const stream = prepared.stream;
      const topic = prepared.topic;
      const content = prepared.content;
      const isRecovery = prepared.isRecovery;

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });
      opts.statusSink?.({ lastInboundAt: Date.now() });

      // Per-handler delivery signal: allows reply delivery to complete even if the monitor
      // is stopping (e.g. gateway restart). Without this, in-flight HTTP calls to Zulip get
      // aborted immediately, wasting the LLM tokens already spent generating the response.
      const DELIVERY_GRACE_MS = 10_000;
      const DELIVERY_TIMEOUT_MS = 1_200_000;
      const deliveryController = new AbortController();
      const deliverySignal = deliveryController.signal;
      const deliveryTimer = setTimeout(() => {
        if (!deliveryController.signal.aborted) deliveryController.abort();
      }, DELIVERY_TIMEOUT_MS);
      const onMainAbortForDelivery = () => {
        // Give in-flight deliveries a grace period to finish before hard abort
        setTimeout(() => {
          if (!deliveryController.signal.aborted) deliveryController.abort();
        }, DELIVERY_GRACE_MS);
      };
      abortSignal.addEventListener("abort", onMainAbortForDelivery, { once: true });

      const sendShutdownNoticeOnce = createBestEffortShutdownNoticeSender({
        sendNotice: async () => {
          await sendZulipStreamMessage({
            auth,
            stream,
            topic,
            content:
              "♻️ Gateway restart in progress - reconnecting now. If this turn is interrupted, please resend in a moment.",
            abortSignal: deliverySignal,
          });
        },
        log: (message) => logger.debug?.(message),
      });
      const onMainAbortShutdownNotice = () => {
        sendShutdownNoticeOnce();
      };
      abortSignal.addEventListener("abort", onMainAbortShutdownNotice, { once: true });
      if (abortSignal.aborted) {
        onMainAbortShutdownNotice();
      }

      const reactions = account.reactions;
      let reactionController = prepared.reactionController;
      if (!prepared.queuedReactionStarted) {
        const queuedReaction = await sendQueuedReaction({
          msg,
          stream,
          topic,
          source: prepared.source,
          trace: prepared.trace,
        });
        reactionController = queuedReaction.reactionController ?? reactionController;
      }
      if (!reactionController && reactions.enabled && reactions.workflow.enabled) {
        reactionController = createReactionTransitionController({
          auth,
          messageId: msg.id,
          reactions,
          log: (m) => logger.debug?.(m),
        });
      }

      // Typing indicator refresh: Zulip expires typing indicators after ~15s server-side
      let typingRefreshInterval: ReturnType<typeof setInterval> | undefined;

      // Send typing indicator while the agent processes, and refresh every 10s.
      if (typeof msg.stream_id === "number") {
        sendTypingIndicator({ auth, streamId: msg.stream_id, topic, abortSignal }).catch(
          () => undefined,
        );
        typingRefreshInterval = setInterval(() => {
          sendTypingIndicator({ auth, streamId: msg.stream_id, topic, abortSignal }).catch(
            () => undefined,
          );
        }, 10_000);
      }

      const inboundUploads = await downloadZulipUploads({
        cfg,
        accountId: account.accountId,
        auth,
        content,
        abortSignal,
      });
      const mediaPaths = inboundUploads.map((entry) => entry.path);
      const mediaUrls = inboundUploads.map((entry) => entry.url);
      const mediaTypes = inboundUploads.map((entry) => entry.contentType ?? "");

      // Strip downloaded upload URLs from the content so the native image loader
      // doesn't try to open raw /user_uploads/... paths as local files.
      let cleanedContent = content;
      for (const upload of inboundUploads) {
        // Replace both the full URL and any relative /user_uploads/ path variants.
        cleanedContent = cleanedContent.replaceAll(upload.url, upload.placeholder);
        try {
          const urlObj = new URL(upload.url);
          cleanedContent = cleanedContent.replaceAll(urlObj.pathname, upload.placeholder);
        } catch {
          // Ignore URL parse errors.
        }
      }

      // Now that uploads are resolved, bail if there's truly nothing to process:
      // no text content AND no media attachments.
      if (!cleanedContent.trim() && inboundUploads.length === 0) {
        return;
      }

      // Populate stream ID -> name mapping from message events as a fallback.
      if (typeof msg.stream_id === "number" && stream) {
        streamIdToName.set(msg.stream_id, stream);
      }
      // Resolve canonical stream + topic for session continuity across renames and cross-stream moves.
      const { stream: canonicalStream, topicKey: canonicalTopicKey } =
        resolveCanonicalTopicSessionKey({
          aliases: topicAliases,
          stream,
          topic,
        });
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zulip",
        accountId: account.accountId,
        peer: { kind: "channel", id: canonicalStream },
      });
      const baseSessionKey = route.sessionKey;
      const sessionKey = `${baseSessionKey}:topic:${canonicalTopicKey}`;
      logTrace({
        milestone: "handler_start",
        source: prepared.source,
        messageId: msg.id,
        stream,
        topic,
        sessionKey,
        activeHandlers: prepared.trace.activeHandlers,
        waiterDepth: prepared.trace.waiterDepth,
      });

      const to = `stream:${stream}#${topic}`;
      const from = `zulip:channel:${stream}`;
      const senderName =
        msg.sender_full_name?.trim() || msg.sender_email?.trim() || String(msg.sender_id);

      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
      const cleanedForMentions = content.replace(/@\*\*([^*]+)\*\*/g, "@$1");
      const wasMentioned = core.channel.mentions.matchesMentionPatterns(
        cleanedForMentions,
        mentionRegexes,
      );

      const body = core.channel.reply.formatInboundEnvelope({
        channel: "Zulip",
        from: `${stream} (${topic || account.defaultTopic})`,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        body: `${cleanedContent}\n[zulip message id: ${msg.id} stream: ${stream} topic: ${topic}]`,
        chatType: "channel",
        sender: { name: senderName, id: String(msg.sender_id) },
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: cleanedContent,
        CommandBody: cleanedContent,
        From: from,
        To: to,
        SessionKey: sessionKey,
        AccountId: route.accountId,
        ChatType: "channel",
        ThreadLabel: topic,
        MessageThreadId: topic,
        ConversationLabel: `${stream}#${topic}`,
        GroupSubject: stream,
        GroupChannel: `#${stream}`,
        GroupSystemPrompt: account.alwaysReply
          ? "Always reply to every message in this Zulip stream/topic. If a full response isn't needed, acknowledge briefly in 1 short sentence. To start a new topic, prefix your reply with: [[zulip_topic: <topic>]]"
          : undefined,
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        SenderName: senderName,
        SenderId: String(msg.sender_id),
        MessageSid: String(msg.id),
        WasMentioned: wasMentioned,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: to,
        Timestamp: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
        MediaPath: mediaPaths[0],
        MediaUrl: mediaUrls[0],
        MediaType: mediaTypes[0],
        MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
        MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
        MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
        CommandAuthorized: true,
      });

      const nowMs = Date.now();
      let checkpoint: ZulipInFlightCheckpoint = messageOptions?.recoveryCheckpoint
        ? prepareZulipCheckpointForRecovery({
            checkpoint: messageOptions.recoveryCheckpoint,
            nowMs,
          })
        : {
            version: ZULIP_INFLIGHT_CHECKPOINT_VERSION,
            checkpointId: buildZulipCheckpointId({
              accountId: account.accountId,
              messageId: msg.id,
            }),
            accountId: account.accountId,
            stream,
            topic,
            messageId: msg.id,
            senderId: String(msg.sender_id),
            senderName,
            senderEmail: msg.sender_email,
            cleanedContent,
            body,
            sessionKey,
            from,
            to,
            wasMentioned,
            streamId: msg.stream_id,
            timestampMs: typeof msg.timestamp === "number" ? msg.timestamp * 1000 : undefined,
            mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
            mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
            mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
            retryCount: 0,
          };
      try {
        await writeZulipInFlightCheckpoint({ checkpoint });
      } catch (err) {
        runtime.error?.(`[zulip] failed to persist in-flight checkpoint: ${String(err)}`);
      }

      const mainRelayRunId = buildMainRelayRunId(account.accountId, msg.id);
      let mainRelayRegistered = false;
      let mainRelayModel = "default";

      const { onModelSelected: originalOnModelSelected, ...prefixOptions } =
        createReplyPrefixOptions({
          cfg,
          agentId: route.agentId,
          channel: "zulip",
          accountId: account.accountId,
        });
      const onModelSelected = (ctx: { model: string; provider?: string; thinkLevel?: string }) => {
        originalOnModelSelected(ctx);
        if (ctx.model) {
          mainRelayModel = ctx.model;
          toolProgress.setModel(ctx.model);
          updateRelayRunModel(mainRelayRunId, ctx.model);
        }
      };

      const isMainRelayActive = () => mainRelayRegistered && isRelayRunRegistered(mainRelayRunId);

      let successfulDeliveries = 0;
      let firstOutboundLogged = false;
      const toolProgress = new ToolProgressAccumulator({
        auth,
        stream,
        topic,
        name: botDisplayName,
        abortSignal: deliverySignal,
        log: (m) => logger.debug?.(m),
      });
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          ...prefixOptions,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload: ReplyPayload, info?: { kind: string }) => {
            const kind = info?.kind;
            // Batch tool result summaries into a single message that gets edited.
            // Only batch text-only tool payloads; media payloads go through normally.
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            if (kind === "tool" && !hasMedia && payload.text?.trim()) {
              if (isMainRelayActive()) {
                // Main relay renders structured tool calls via AgentEvent stream.
                return;
              }
              if (!firstOutboundLogged) {
                firstOutboundLogged = true;
                logTrace({
                  milestone: "first_outbound",
                  source: prepared.source,
                  messageId: msg.id,
                  stream,
                  topic,
                  sessionKey,
                  activeHandlers: prepared.trace.activeHandlers,
                  waiterDepth: prepared.trace.waiterDepth,
                  extra: { kind: kind ?? "tool" },
                });
              }
              toolProgress.addLine(payload.text.trim());
              // Count as a successful delivery since the accumulator handles send/edit.
              successfulDeliveries += 1;
              opts.statusSink?.({ lastOutboundAt: Date.now() });
              core.channel.activity.record({
                channel: "zulip",
                accountId: account.accountId,
                direction: "outbound",
                at: Date.now(),
              });
              return;
            }

            // Finalize the accumulated tool progress before sending non-tool replies,
            // so the batched tool message appears above the block/final reply.
            if (kind !== "tool" && toolProgress.hasContent) {
              await toolProgress.finalize();
            }

            if (!firstOutboundLogged) {
              firstOutboundLogged = true;
              logTrace({
                milestone: "first_outbound",
                source: prepared.source,
                messageId: msg.id,
                stream,
                topic,
                sessionKey,
                activeHandlers: prepared.trace.activeHandlers,
                waiterDepth: prepared.trace.waiterDepth,
                extra: { kind: kind ?? "reply" },
              });
            }

            // Use deliverySignal (not abortSignal) so in-flight replies survive
            // monitor shutdown with a grace period instead of being killed instantly.
            await deliverReply({
              account,
              auth,
              stream,
              topic,
              payload,
              cfg,
              abortSignal: deliverySignal,
            });
            successfulDeliveries += 1;
            opts.statusSink?.({ lastOutboundAt: Date.now() });
            core.channel.activity.record({
              channel: "zulip",
              accountId: account.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
          onError: (err) => {
            runtime.error?.(`zulip reply failed: ${String(err)}`);
          },
        });
      const dispatchDriver = reactionController
        ? withWorkflowReactionStages(dispatcher, reactions, reactionController, abortSignal)
        : dispatcher;

      const stopKeepalive = startPeriodicKeepalive({
        sendPing: async (elapsedMs) => {
          if (isMainRelayActive()) {
            return;
          }
          // If tool progress has an active batched message, update it with
          // a heartbeat instead of sending a separate keepalive message.
          if (toolProgress.hasContent) {
            toolProgress.addHeartbeat(elapsedMs);
            return;
          }
          await sendZulipStreamMessage({
            auth,
            stream,
            topic,
            content: buildKeepaliveMessageContent(elapsedMs),
            abortSignal: deliverySignal,
          });
        },
      });

      mainRelayRegistered =
        registerMainRelayRun({
          runId: mainRelayRunId,
          label: botDisplayName,
          model: mainRelayModel,
          deliveryContext: {
            channel: "zulip",
            to,
            accountId: account.accountId,
          },
        }) || mainRelayRegistered;

      let ok = false;
      let lastDispatchError: unknown;
      const MAX_DISPATCH_RETRIES = 2;
      try {
        for (let attempt = 0; attempt <= MAX_DISPATCH_RETRIES; attempt++) {
          try {
            if (reactionController) {
              await reactionController.transition("processing", { abortSignal });
            }
            logTrace({
              milestone: "dispatch_start",
              source: prepared.source,
              messageId: msg.id,
              stream,
              topic,
              sessionKey,
              activeHandlers: prepared.trace.activeHandlers,
              waiterDepth: prepared.trace.waiterDepth,
              extra: { attempt: attempt + 1 },
            });
            await core.channel.reply.dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg,
              dispatcher: dispatchDriver,
              replyOptions: {
                ...replyOptions,
                runId: mainRelayRunId,
                disableBlockStreaming: true,
                onModelSelected,
                onAgentRunStart: (runId: string) => {
                  replyOptions.onAgentRunStart?.(runId);
                  const registered = registerMainRelayRun({
                    runId,
                    label: botDisplayName,
                    model: mainRelayModel,
                    deliveryContext: {
                      channel: "zulip",
                      to,
                      accountId: account.accountId,
                    },
                  });
                  mainRelayRegistered = registered || mainRelayRegistered;
                },
              },
            });
            ok = true;
            lastDispatchError = undefined;
            logTrace({
              milestone: "dispatch_done",
              source: prepared.source,
              messageId: msg.id,
              stream,
              topic,
              sessionKey,
              activeHandlers: prepared.trace.activeHandlers,
              waiterDepth: prepared.trace.waiterDepth,
              extra: { ok: true, attempt: attempt + 1 },
            });
            break;
          } catch (err) {
            ok = false;
            lastDispatchError = err;
            const isRetryable =
              attempt < MAX_DISPATCH_RETRIES &&
              !(err instanceof Error && err.name === "AbortError");
            if (isRetryable) {
              if (reactionController) {
                await reactionController.transition("retrying", { abortSignal });
              }
              runtime.error?.(
                `zulip dispatch failed (attempt ${attempt + 1}/${MAX_DISPATCH_RETRIES + 1}, retrying in 2s): ${String(err)}`,
              );
              await sleep(2000, abortSignal).catch(() => undefined);
              continue;
            }
            opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
            runtime.error?.(`zulip dispatch failed: ${String(err)}`);
            logTrace({
              milestone: "dispatch_done",
              source: prepared.source,
              messageId: msg.id,
              stream,
              topic,
              sessionKey,
              activeHandlers: prepared.trace.activeHandlers,
              waiterDepth: prepared.trace.waiterDepth,
              extra: { ok: false, attempt: attempt + 1 },
            });
          }
        }
      } finally {
        // Ensure all queued outbound sends are flushed before cleanup.
        dispatcher.markComplete();
        try {
          await waitForDispatcherIdleWithTimeout({
            waitForIdle: () => dispatcher.waitForIdle(),
            timeoutMs: DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS,
            onTimeout: () => {
              logger.warn(
                `[zulip] dispatcher.waitForIdle timed out after ${DEFAULT_DISPATCH_WAIT_FOR_IDLE_TIMEOUT_MS}ms; continuing cleanup`,
              );
            },
          });
        } finally {
          markDispatchIdle();
          // Finalize any remaining tool progress (best-effort final edit).
          // Use finalizeWithError() on failure so the header shows ❌ instead of ✅.
          const finalizePromise = ok ? toolProgress.finalize() : toolProgress.finalizeWithError();
          await finalizePromise.catch((err) => {
            logger.debug?.(`[zulip] tool progress finalize failed: ${String(err)}`);
          });
          // Clean up periodic keepalive timers.
          stopKeepalive();
          // Clean up typing refresh interval (before stopTypingIndicator)
          clearInterval(typingRefreshInterval);
          // Clean up delivery abort controller listener/timer (do not hard-abort here).
          clearTimeout(deliveryTimer);
          abortSignal.removeEventListener("abort", onMainAbortForDelivery);
          abortSignal.removeEventListener("abort", onMainAbortShutdownNotice);

          // Stop typing indicator now that the reply has been sent.
          if (typeof msg.stream_id === "number") {
            stopTypingIndicator({
              auth,
              streamId: msg.stream_id,
              topic,
              abortSignal: deliverySignal,
            }).catch(() => undefined);
          }

          // Visible failure message: post an actual user-visible message when dispatch fails
          if (ok === false) {
            try {
              await sendZulipStreamMessage({
                auth,
                stream,
                topic,
                content:
                  "⚠️ I ran into an error processing your message — please try again. (Error has been logged)",
                abortSignal: deliverySignal,
              });
            } catch {
              // Best effort — if this fails, at least the reaction emoji will show the failure
            }
          }

          // Use deliverySignal for final reactions so they can still be posted
          // during graceful shutdown (the grace period covers these too).
          if (reactions.enabled) {
            if (reactionController) {
              const finalStage: ZulipReactionWorkflowStage = ok
                ? "success"
                : successfulDeliveries > 0
                  ? "partialSuccess"
                  : "failure";
              await reactionController.transition(finalStage, {
                abortSignal: deliverySignal,
                force: true,
              });
            } else {
              if (reactions.clearOnFinish) {
                await bestEffortReaction({
                  auth,
                  messageId: msg.id,
                  op: "remove",
                  emojiName: reactions.onStart,
                  log: (m) => logger.debug?.(m),
                  abortSignal: deliverySignal,
                });
              }
              const finalEmoji = ok ? reactions.onSuccess : reactions.onFailure;
              await bestEffortReaction({
                auth,
                messageId: msg.id,
                op: "add",
                emojiName: finalEmoji,
                log: (m) => logger.debug?.(m),
                abortSignal: deliverySignal,
              });
            }
          }

          try {
            if (ok) {
              await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId });

              const markedProcessed = markZulipMessageProcessed({
                state: processedMessageState,
                stream,
                messageId: msg.id,
              });
              if (markedProcessed.updated) {
                processedMessageState = markedProcessed.state;
                await persistProcessedMessageState();
              }
            } else {
              checkpoint = markZulipCheckpointFailure({
                checkpoint,
                error: lastDispatchError ?? "dispatch failed",
              });
              await writeZulipInFlightCheckpoint({ checkpoint });
            }
          } catch (err) {
            runtime.error?.(`[zulip] failed to update in-flight checkpoint: ${String(err)}`);
          }
          logTrace({
            milestone: "cleanup_done",
            source: prepared.source,
            messageId: msg.id,
            stream,
            topic,
            sessionKey,
            activeHandlers: prepared.trace.activeHandlers,
            waiterDepth: prepared.trace.waiterDepth,
            extra: { ok, successfulDeliveries },
          });
        }
      }
    };

    const resumedCheckpointIds = new Set<string>();

    const reactionMessageContexts = new Map<
      number,
      {
        stream: string;
        topic: string;
        capturedAt: number;
      }
    >();
    const REACTION_MESSAGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
    const REACTION_MESSAGE_CONTEXT_MAX = 1_000;

    const normalizeReactionSourceFromMessage = (message?: ZulipEventMessage) => {
      if (!message) {
        return null;
      }
      if (message.type && message.type !== "stream") {
        return null;
      }
      const stream = normalizeStreamName(
        typeof message.display_recipient === "string" ? message.display_recipient : "",
      );
      const topic = normalizeTopic(message.subject) || account.defaultTopic;
      if (!stream || !topic) {
        return null;
      }
      return { stream, topic };
    };

    const rememberReactionMessageContext = (message: ZulipEventMessage) => {
      if (typeof message.id !== "number") {
        return;
      }
      const source = normalizeReactionSourceFromMessage(message);
      if (!source) {
        return;
      }
      reactionMessageContexts.set(message.id, {
        ...source,
        capturedAt: Date.now(),
      });
      if (reactionMessageContexts.size > REACTION_MESSAGE_CONTEXT_MAX) {
        for (const [messageId] of reactionMessageContexts) {
          reactionMessageContexts.delete(messageId);
          if (reactionMessageContexts.size <= REACTION_MESSAGE_CONTEXT_MAX) {
            break;
          }
        }
      }
    };

    const resolveReactionSource = (reactionEvent: ZulipReactionEvent) => {
      const fromEvent = normalizeReactionSourceFromMessage(reactionEvent.message);
      if (fromEvent) {
        reactionMessageContexts.set(reactionEvent.message_id, {
          ...fromEvent,
          capturedAt: Date.now(),
        });
        return fromEvent;
      }

      const cached = reactionMessageContexts.get(reactionEvent.message_id);
      if (!cached) {
        return null;
      }
      if (Date.now() - cached.capturedAt > REACTION_MESSAGE_CONTEXT_TTL_MS) {
        reactionMessageContexts.delete(reactionEvent.message_id);
        return null;
      }
      return { stream: cached.stream, topic: cached.topic };
    };

    const toReactionCommandToken = (emojiName: string) => {
      const normalized = emojiName
        .trim()
        .toLowerCase()
        .replace(/^:/, "")
        .replace(/:$/, "")
        .replace(/[^a-z0-9_+-]+/g, "_")
        .replace(/^_+|_+$/g, "");
      return normalized || "emoji";
    };

    const dispatchSyntheticReactionContext = (params: {
      stream: string;
      topic: string;
      body: string;
      rawBody: string;
      commandBody: string;
      sessionKeySuffix: string;
      userId: number;
      userName: string;
      messageSid: string;
      systemPrompt: string;
      errorLabel: string;
    }) => {
      const target = `stream:${params.stream}#${params.topic}`;
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: params.body,
        RawBody: params.rawBody,
        CommandBody: params.commandBody,
        From: `zulip:user:${params.userId}`,
        To: target,
        SessionKey: `zulip:${account.accountId}:reaction:${params.sessionKeySuffix}`,
        AccountId: account.accountId,
        ChatType: "channel",
        ThreadLabel: params.topic,
        MessageThreadId: params.topic,
        ConversationLabel: `${params.stream}#${params.topic}`,
        GroupSubject: params.stream,
        GroupChannel: `#${params.stream}`,
        GroupSystemPrompt: params.systemPrompt,
        Provider: "zulip" as const,
        Surface: "zulip" as const,
        SenderName: params.userName,
        SenderId: String(params.userId),
        MessageSid: params.messageSid,
        WasMentioned: true,
        OriginatingChannel: "zulip" as const,
        OriginatingTo: target,
        Timestamp: Date.now(),
        CommandAuthorized: true,
      });

      void core.channel.reply
        .dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher: {
            sendToolResult: () => Promise.resolve(),
            sendBlockReply: async (payload: ReplyPayload) => {
              if (payload.text) {
                await sendZulipStreamMessage({
                  auth,
                  stream: params.stream,
                  topic: params.topic,
                  content: payload.text,
                  abortSignal,
                });
              }
            },
            sendFinalReply: async (payload: ReplyPayload) => {
              if (payload.text) {
                await sendZulipStreamMessage({
                  auth,
                  stream: params.stream,
                  topic: params.topic,
                  content: payload.text,
                  abortSignal,
                });
              }
            },
            markComplete: () => {},
            waitForIdle: () => Promise.resolve(),
          },
          replyOptions: {
            disableBlockStreaming: true,
          },
        })
        .catch((err) => {
          logger.error?.(`[zulip] ${params.errorLabel} dispatch failed: ${String(err)}`);
        });
    };

    // Handler for reaction events (reaction buttons + optional generic callbacks)
    const handleReaction = (reactionEvent: ZulipReactionEvent) => {
      if (typeof reactionEvent.message_id !== "number") {
        return;
      }

      const result =
        reactionEvent.op === "add"
          ? handleReactionEvent({
              messageId: reactionEvent.message_id,
              emojiName: reactionEvent.emoji_name,
              userId: reactionEvent.user_id,
              botUserId,
            })
          : null;

      if (result) {
        logger.info(
          `[zulip:${account.accountId}] reaction button clicked: messageId=${result.messageId}, index=${result.selectedIndex}, value=${result.selectedOption?.value}`,
        );

        core.channel.activity.record({
          channel: "zulip",
          accountId: account.accountId,
          direction: "inbound",
          at: Date.now(),
        });

        const buttonSession = getReactionButtonSession(result.messageId);
        const source = buttonSession
          ? { stream: buttonSession.stream, topic: buttonSession.topic }
          : resolveReactionSource(reactionEvent);

        if (!source?.stream || !source.topic) {
          logger.debug?.(
            `[zulip:${account.accountId}] reaction button ignored: unresolved source for message ${result.messageId}`,
          );
          return;
        }

        const buttonPayload = {
          type: "reaction_button_click" as const,
          messageId: result.messageId,
          selectedIndex: result.selectedIndex,
          selectedOption: result.selectedOption,
          userId: reactionEvent.user_id,
          userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
        };

        dispatchSyntheticReactionContext({
          stream: source.stream,
          topic: source.topic,
          body: `[zulip reaction button click: messageId=${result.messageId}, option="${result.selectedOption?.label}" (${result.selectedOption?.value})]`,
          rawBody: JSON.stringify(buttonPayload),
          commandBody: `reaction_button_${result.selectedIndex}`,
          sessionKeySuffix: String(result.messageId),
          userId: reactionEvent.user_id,
          userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
          messageSid: `reaction-button-${result.messageId}-${Date.now()}`,
          systemPrompt:
            "A user clicked a reaction button on a previous message. Respond to their selection.",
          errorLabel: "reaction button",
        });
        return;
      }

      if (!account.reactions.genericCallback.enabled) {
        return;
      }
      if (reactionEvent.user_id === botUserId) {
        return;
      }
      if (reactionEvent.op === "remove" && !account.reactions.genericCallback.includeRemoveOps) {
        return;
      }

      const source = resolveReactionSource(reactionEvent);
      if (!source?.stream || !source.topic) {
        logger.debug?.(
          `[zulip:${account.accountId}] generic reaction ignored: unresolved source for message ${reactionEvent.message_id}`,
        );
        return;
      }

      if (account.streams.length > 0 && !account.streams.includes(source.stream)) {
        return;
      }

      core.channel.activity.record({
        channel: "zulip",
        accountId: account.accountId,
        direction: "inbound",
        at: Date.now(),
      });

      const normalizedEmojiToken = toReactionCommandToken(reactionEvent.emoji_name);
      const genericPayload = {
        type: "reaction_event" as const,
        op: reactionEvent.op,
        emojiName: reactionEvent.emoji_name,
        emojiCode: reactionEvent.emoji_code,
        messageId: reactionEvent.message_id,
        userId: reactionEvent.user_id,
        userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
      };

      dispatchSyntheticReactionContext({
        stream: source.stream,
        topic: source.topic,
        body: `[zulip reaction ${reactionEvent.op}: messageId=${reactionEvent.message_id}, emoji="${reactionEvent.emoji_name}"]`,
        rawBody: JSON.stringify(genericPayload),
        commandBody: `reaction_${reactionEvent.op}_${normalizedEmojiToken}`,
        sessionKeySuffix: `${reactionEvent.message_id}:${reactionEvent.op}:${normalizedEmojiToken}`,
        userId: reactionEvent.user_id,
        userName: reactionEvent.user?.full_name ?? String(reactionEvent.user_id),
        messageSid: `reaction-generic-${reactionEvent.message_id}-${Date.now()}`,
        systemPrompt:
          "A user added or removed a reaction in this topic. Treat this as an inbound signal and respond only if helpful.",
        errorLabel: "generic reaction",
      });
    };

    const replayPendingCheckpoints = async () => {
      const checkpoints = await loadZulipInFlightCheckpoints({ accountId: account.accountId });
      for (const checkpoint of checkpoints) {
        if (resumedCheckpointIds.has(checkpoint.checkpointId)) {
          continue;
        }
        resumedCheckpointIds.add(checkpoint.checkpointId);

        if (checkpoint.retryCount >= ZULIP_INFLIGHT_MAX_RETRY_COUNT) {
          logger.warn(
            `[zulip:${account.accountId}] dropping exhausted in-flight checkpoint ${checkpoint.checkpointId} (retryCount=${checkpoint.retryCount})`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        if (isZulipCheckpointStale({ checkpoint })) {
          logger.warn(
            `[zulip:${account.accountId}] skipping stale in-flight checkpoint ${checkpoint.checkpointId}`,
          );
          await clearZulipInFlightCheckpoint({ checkpointId: checkpoint.checkpointId }).catch(
            () => undefined,
          );
          continue;
        }

        await sendZulipStreamMessage({
          auth,
          stream: checkpoint.stream,
          topic: checkpoint.topic,
          content: ZULIP_RECOVERY_NOTICE,
          abortSignal,
        }).catch((err) => {
          logger.warn(
            `[zulip:${account.accountId}] failed to send recovery notice for ${checkpoint.checkpointId}: ${String(err)}`,
          );
        });

        const syntheticMessage: ZulipEventMessage = {
          id: checkpoint.messageId,
          type: "stream",
          sender_id: Number(checkpoint.senderId) || 0,
          sender_full_name: checkpoint.senderName,
          sender_email: checkpoint.senderEmail,
          display_recipient: checkpoint.stream,
          stream_id: checkpoint.streamId,
          subject: checkpoint.topic,
          content: checkpoint.cleanedContent,
          timestamp:
            typeof checkpoint.timestampMs === "number"
              ? Math.floor(checkpoint.timestampMs / 1000)
              : undefined,
        };

        try {
          const prepared = await prepareMessageForHandling({
            msg: syntheticMessage,
            source: "recovery",
            activeHandlers: 0,
            waiterDepth: 0,
            recoveryCheckpoint: checkpoint,
          });
          if (!prepared) {
            continue;
          }
          await handleMessage(prepared, { recoveryCheckpoint: checkpoint });
        } catch (err) {
          runtime.error?.(
            `[zulip:${account.accountId}] recovery replay failed for ${checkpoint.checkpointId}: ${String(err)}`,
          );
          const failedCheckpoint = markZulipCheckpointFailure({ checkpoint, error: err });
          await writeZulipInFlightCheckpoint({ checkpoint: failedCheckpoint }).catch(
            () => undefined,
          );
        }
      }
    };

    const pollStreamQueue = async (stream: string) => {
      let queueId = "";
      let lastEventId = -1;
      let retry = 0;
      let stage: "register" | "poll" | "handle" = "register";

      // Backpressure: limit concurrent message handlers to prevent unbounded pile-up.
      // Set high enough to handle many active topics simultaneously — each handler holds
      // its slot for the full agent turn (which can take 30-120s with Opus + tools).
      // A low limit (e.g. 5) causes messages to queue behind long-running turns.
      const MAX_CONCURRENT_HANDLERS = 20;
      let activeHandlers = 0;
      const handlerWaiters: Array<() => void> = [];

      const throttledHandleMessage = async (msg: ZulipEventMessage, source: ZulipMessageSource) => {
        const prepared = await prepareMessageForHandling({
          msg,
          source,
          activeHandlers,
          waiterDepth: handlerWaiters.length,
        });
        if (!prepared) {
          return;
        }

        if (activeHandlers >= MAX_CONCURRENT_HANDLERS) {
          logTrace({
            milestone: "handler_wait_start",
            source,
            messageId: msg.id,
            stream: prepared.stream,
            topic: prepared.topic,
            activeHandlers,
            waiterDepth: handlerWaiters.length + 1,
          });
          await new Promise<void>((resolve) => handlerWaiters.push(resolve));
        }
        activeHandlers++;
        try {
          prepared.trace.activeHandlers = activeHandlers;
          prepared.trace.waiterDepth = handlerWaiters.length;
          await handleMessage(prepared);
        } finally {
          activeHandlers--;
          const next = handlerWaiters.shift();
          if (next) next();
        }
      };

      // Freshness checker: periodically verify we haven't missed messages during
      // long-poll gaps, queue re-registrations, or silent connection drops.
      // Fetches the 5 most recent messages via REST and processes any with IDs
      // higher than the last one we saw through the event queue.
      let lastSeenMsgId = 0;
      const FRESHNESS_INTERVAL_MS = 30_000;
      const freshnessTimer = setInterval(async () => {
        if (stopped || abortSignal.aborted || lastSeenMsgId === 0) return;
        try {
          const recent = await zulipRequest<{ result: string; messages?: ZulipEventMessage[] }>({
            auth,
            method: "GET",
            path: "/api/v1/messages",
            query: {
              anchor: "newest",
              num_before: 5,
              num_after: 0,
              narrow: JSON.stringify([["stream", stream]]),
              apply_markdown: "false",
            },
            abortSignal,
          });
          if (recent.result === "success" && recent.messages) {
            let caught = 0;
            for (const msg of recent.messages) {
              if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                caught++;
                lastSeenMsgId = msg.id;
                throttledHandleMessage(msg, "freshness").catch((err) => {
                  runtime.error?.(`zulip: freshness catchup failed: ${String(err)}`);
                });
              }
            }
            if (caught > 0) {
              logger.warn(
                `[zulip:${account.accountId}] freshness checker recovered ${caught} missed message(s) in stream "${stream}"`,
              );
            }
          }
        } catch {
          // Best effort — freshness check is non-critical.
        }
      }, FRESHNESS_INTERVAL_MS);

      while (!stopped && !abortSignal.aborted) {
        try {
          if (!queueId) {
            stage = "register";
            const wasReregistration = lastEventId !== -1;
            const reg = await registerQueue({ auth, stream, abortSignal });
            queueId = reg.queueId;
            lastEventId = reg.lastEventId;

            // Issue 5: recover messages lost during queue gap on re-registration.
            if (wasReregistration) {
              try {
                const recent = await zulipRequest<{
                  result: string;
                  messages?: ZulipEventMessage[];
                }>({
                  auth,
                  method: "GET",
                  path: "/api/v1/messages",
                  query: {
                    anchor: "newest",
                    num_before: 10,
                    num_after: 0,
                    narrow: JSON.stringify([["stream", stream]]),
                    apply_markdown: "false",
                  },
                  abortSignal,
                });
                if (recent.result === "success" && recent.messages) {
                  for (const msg of recent.messages) {
                    // Track highest ID for freshness checker.
                    if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
                      lastSeenMsgId = msg.id;
                    }
                    // dedupe.check skips already-processed messages
                    throttledHandleMessage(msg, "catchup").catch((err) => {
                      runtime.error?.(`zulip: catchup message failed: ${String(err)}`);
                    });
                  }
                }
              } catch (catchupErr) {
                logger.debug?.(
                  `[zulip:${account.accountId}] catchup fetch failed: ${String(catchupErr)}`,
                );
              }
            }
          }

          stage = "poll";
          logger.warn(
            `[zulip-debug][${account.accountId}] polling events (queue=${queueId.slice(0, 8)}, lastEventId=${lastEventId}, stream=${stream})`,
          );
          const events = await pollEvents({ auth, queueId, lastEventId, abortSignal });
          if (events.result !== "success") {
            throw new Error(events.msg || "Zulip events poll failed");
          }

          const list = events.events ?? [];
          // Update lastEventId from individual event IDs. The /api/v1/events
          // response does NOT include a top-level last_event_id field — only
          // /api/v1/register does. Without this, lastEventId stays at -1 forever,
          // causing every poll to replay ALL events since queue registration.
          for (const evt of list) {
            if (typeof evt.id === "number" && evt.id > lastEventId) {
              lastEventId = evt.id;
            }
          }

          logger.warn(
            `[zulip-debug][${account.accountId}] poll returned ${list.length} events (messages: ${list.filter((e) => e.message).length}, lastEventId=${lastEventId})`,
          );

          for (const evt of list) {
            const rename = parseTopicRenameEvent(evt);
            if (!rename) {
              continue;
            }

            let fromStream: string;
            let toStream: string;
            if (rename.origStreamId !== undefined && rename.newStreamId !== undefined) {
              // Cross-stream move: resolve stream IDs to names.
              const origName = streamIdToName.get(rename.origStreamId);
              const newName = streamIdToName.get(rename.newStreamId);
              if (!origName || !newName) {
                logger.debug?.(
                  `[zulip:${account.accountId}] cross-stream move: could not resolve stream IDs (orig=${rename.origStreamId}, new=${rename.newStreamId})`,
                );
                continue;
              }
              // Only track moves between streams we monitor.
              if (!account.streams.includes(origName) || !account.streams.includes(newName)) {
                continue;
              }
              fromStream = origName;
              toStream = newName;
            } else {
              // Same-stream topic rename.
              fromStream = stream;
              toStream = stream;
            }

            const mapped = recordTopicRenameAlias({
              aliases: topicAliases,
              fromStream,
              fromTopic: rename.fromTopic,
              toStream,
              toTopic: rename.toTopic,
            });
            if (mapped) {
              if (fromStream !== toStream) {
                logger.info(
                  `[zulip:${account.accountId}] mapped cross-stream topic move: "${toStream}#${rename.toTopic}" -> "${fromStream}#${rename.fromTopic}"`,
                );
              } else {
                logger.info(
                  `[zulip:${account.accountId}] mapped topic rename alias for stream "${stream}": "${rename.toTopic}" -> "${rename.fromTopic}"`,
                );
              }
            }
          }

          const messages = list
            .map((evt) => evt.message)
            .filter((m): m is ZulipEventMessage => Boolean(m));

          for (const msg of messages) {
            rememberReactionMessageContext(msg);
          }

          // Track highest message ID for freshness checker gap detection.
          for (const msg of messages) {
            if (typeof msg.id === "number" && msg.id > lastSeenMsgId) {
              lastSeenMsgId = msg.id;
            }
          }

          for (const msg of messages) {
            const ignore = shouldIgnoreMessage({
              message: msg,
              botUserId,
              streams: account.streams,
            });
            logger.warn(
              `[zulip-debug][${account.accountId}] event msg id=${msg.id} topic="${msg.subject}" sender=${msg.sender_id} ignore=${ignore.ignore}${ignore.reason ? ` (${ignore.reason})` : ""}`,
            );
          }

          // Handle reaction events
          const reactionEvents = list
            .filter((evt): evt is ZulipEvent & ZulipReactionEvent => evt.type === "reaction")
            .map((evt) => evt as ZulipReactionEvent);

          for (const reactionEvent of reactionEvents) {
            try {
              handleReaction(reactionEvent);
            } catch (err) {
              logger.debug?.(
                `[zulip:${account.accountId}] reaction handling failed: ${String(err)}`,
              );
            }
          }

          // Issue 2: handle DMs by sending a redirect notice.
          const dmMessages = messages.filter(
            (m) => m.type !== "stream" && m.sender_id !== botUserId,
          );
          for (const dm of dmMessages) {
            if (typeof dm.sender_id === "number") {
              logger.debug?.(`[zulip:${account.accountId}] ignoring DM from user ${dm.sender_id}`);
              replyToDm({
                auth,
                senderId: dm.sender_id,
                dmNotifiedSenders,
                log: (m) => logger.debug?.(m),
              }).catch(() => undefined);
            }
          }

          // Defensive throttle: if Zulip responds immediately without any message payloads (e.g.
          // heartbeat-only events, proxies, or aggressive server settings), avoid a tight loop that can
          // hit 429s.
          if (messages.length === 0 && reactionEvents.length === 0) {
            const jitterMs = Math.floor(Math.random() * 250);
            await sleep(2000 + jitterMs, abortSignal).catch(() => undefined);
            retry = 0;
            continue;
          }

          stage = "handle";
          for (const msg of messages) {
            // Use throttled handler with backpressure (max concurrent limit)
            throttledHandleMessage(msg, "poll").catch((err) => {
              runtime.error?.(`zulip: message processing failed: ${String(err)}`);
            });
            // Small stagger between starting each message for natural pacing
            await sleep(200, abortSignal).catch(() => undefined);
          }

          retry = 0;
        } catch (err) {
          // FIX: Only break if explicitly stopped, NOT on abort
          // Abort errors (timeouts) should trigger queue re-registration
          if (stopped) {
            break;
          }

          const status = extractZulipHttpStatus(err);
          const retryAfterMs = (err as ZulipHttpError).retryAfterMs;

          // FIX: Always clear queueId on ANY error to force re-registration
          // This prevents stuck queues when fetch times out or aborts
          queueId = "";

          // Detect timeout/abort errors specifically for better logging
          const isAbortError =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.message?.includes("aborted") ||
              err.message?.includes("timeout") ||
              err.message?.includes("ETIMEDOUT"));

          if (isAbortError) {
            logger.warn(
              `[zulip:${account.accountId}] poll timeout/abort detected (stream=${stream}, stage=${stage}): ${String(err)} - forcing queue re-registration`,
            );
          }

          retry += 1;
          const backoffMs = computeZulipMonitorBackoffMs({
            attempt: retry,
            status,
            retryAfterMs,
          });
          logger.warn(
            `[zulip:${account.accountId}] monitor error (stream=${stream}, stage=${stage}, attempt=${retry}): ${String(err)} (retry in ${backoffMs}ms)`,
          );
          await sleep(backoffMs, abortSignal).catch(() => undefined);
        }
      }

      // Clean up freshness checker interval.
      clearInterval(freshnessTimer);

      // Issue 4: clean up the server-side event queue on shutdown.
      if (queueId) {
        try {
          await zulipRequest({
            auth,
            method: "DELETE",
            path: "/api/v1/events",
            form: { queue_id: queueId },
          });
        } catch {
          // Best effort — server will expire it anyway.
        }
      }
    };

    await replayPendingCheckpoints();

    const plan = buildZulipQueuePlan(account.streams);
    if (plan.length === 0) {
      throw new Error(
        `Zulip streams allowlist missing for account "${account.accountId}" (set channels.zulip.streams)`,
      );
    }
    await Promise.all(plan.map((entry) => pollStreamQueue(entry.stream)));
  };

  const done = run()
    .catch((err) => {
      if (abortSignal.aborted || stopped) {
        return;
      }
      opts.statusSink?.({ lastError: err instanceof Error ? err.message : String(err) });
      runtime.error?.(`[zulip:${account.accountId}] monitor crashed: ${String(err)}`);
    })
    .finally(() => {
      // Clean up reaction button sessions
      stopReactionButtonSessionCleanup();
      logger.warn(`[zulip-debug][${account.accountId}] stopped`);
    });

  return { stop, done };
}
