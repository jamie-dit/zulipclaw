import crypto from "node:crypto";
import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  type SessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { resolveResponseUsageMode, type VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveBlockStreamingCoalescing } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import {
  auditPostCompactionReads,
  extractReadPaths,
  formatAuditWarning,
  readSessionMessages,
} from "./post-compaction-audit.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { enqueueFollowupRun, type FollowupRun, type QueueSettings } from "./queue.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;
const UNSCHEDULED_REMINDER_NOTE =
  "Note: I did not schedule a reminder in this turn, so this will not trigger automatically.";
const REMINDER_COMMITMENT_PATTERNS: RegExp[] = [
  /\b(?:i\s*['']?ll|i will)\s+(?:make sure to\s+)?(?:remember|remind|ping|follow up|follow-up|check back|circle back)\b/i,
  /\b(?:i\s*['']?ll|i will)\s+(?:set|create|schedule)\s+(?:a\s+)?reminder\b/i,
];

function hasUnbackedReminderCommitment(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  if (normalized.includes(UNSCHEDULED_REMINDER_NOTE.toLowerCase())) {
    return false;
  }
  return REMINDER_COMMITMENT_PATTERNS.some((pattern) => pattern.test(text));
}

function appendUnscheduledReminderNote(payloads: ReplyPayload[]): ReplyPayload[] {
  let appended = false;
  return payloads.map((payload) => {
    if (appended || payload.isError || typeof payload.text !== "string") {
      return payload;
    }
    if (!hasUnbackedReminderCommitment(payload.text)) {
      return payload;
    }
    appended = true;
    const trimmed = payload.text.trimEnd();
    return {
      ...payload,
      text: `${trimmed}\n\n${UNSCHEDULED_REMINDER_NOTE}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Runtime claim guards
//
// These detect reply text that makes unsupported claims – i.e. claims that
// cannot be true given the tool calls actually made in the current turn – and
// append a correction footnote.  The approach mirrors the existing
// `hasUnbackedReminderCommitment` pattern: never block delivery, just append
// a transparent advisory so the user (and any follow-up turns) have accurate
// context.
//
// Two claim families are covered:
//
//   1. Stale sub-agent status  – "it's still running", "still in progress", etc.
//      when subagents(action=list) was not called this turn.
//
//   2. Unsupported present-tense activity narration – "I'm checking",
//      "I'm tracing", "I'm looking into it now", etc. when no tool call
//      plausibly backs the claim (e.g. exec, web_search, browser, etc. were
//      not called).
//
// Extension point: add new pattern arrays and guard functions here to cover
// additional claim families.  Each guard should follow the three-step shape:
//   (a) detect: boolean function over (text, calledToolNames)
//   (b) correct note: a short, neutral factual note to append
//   (c) apply: map over payloads, append note to first matching payload
// ---------------------------------------------------------------------------

/**
 * Tool names that constitute evidence of a live sub-agent status check.
 * A reply that claims a sub-agent is running/active is only valid when one of
 * these tools was called with action=list (or equivalent) in the same turn.
 *
 * We do not inspect the `action` argument here – presence of the tool name is
 * sufficient as a conservative signal, keeping the check cheap.
 */
const SUBAGENT_STATUS_CHECK_TOOLS = new Set(["subagents", "sessions_list"]);

/**
 * Phrases that assert a sub-agent (or background task) is currently running
 * without having been verified by a live tool call.
 */
const STALE_SUBAGENT_STATUS_PATTERNS: RegExp[] = [
  // "the sub-agent is still running / it's still running / it is still running"
  /\b(?:it(?:'s|\s+is)|the\s+(?:sub-?agent|task|job|run|process|agent)\s+is)\s+still\s+running\b/i,
  // "still in progress" (referring to a background operation)
  /\b(?:sub-?agent|task|job|run)\s+(?:is\s+)?still\s+in\s+progress\b/i,
  // "hasn't finished yet" / "not done yet"
  /\b(?:hasn'?t|has\s+not)\s+finished\s+yet\b/i,
  // "currently running" (in context: the sub-agent / it is currently running)
  /\b(?:it(?:'s|\s+is)|the\s+(?:sub-?agent|task|job|run|process)\s+(?:is\s+)?)\s*currently\s+running\b/i,
  // "is still active" referring to a run
  /\b(?:sub-?agent|task|job|run|process)\s+is\s+still\s+active\b/i,
];

/** Correction note appended when a stale status claim is detected. */
export const STALE_SUBAGENT_STATUS_NOTE =
  "Note: I did not check live sub-agent status this turn (`subagents(action=list)` was not called). The status above is based on context from a previous turn and may be stale.";

/**
 * Returns true when the reply text contains a stale sub-agent status claim
 * AND the subagents/sessions_list tool was not called in the same turn.
 *
 * Exported for unit testing.
 */
export function hasStaleSubagentStatusClaim(text: string, calledToolNames: string[]): boolean {
  if (!text.trim()) {
    return false;
  }
  // If the note was already appended (e.g. by block-streaming), skip.
  if (text.includes(STALE_SUBAGENT_STATUS_NOTE)) {
    return false;
  }
  // If a live check was performed, the claim is backed by evidence.
  const checkedLive = calledToolNames.some((t) => SUBAGENT_STATUS_CHECK_TOOLS.has(t));
  if (checkedLive) {
    return false;
  }
  return STALE_SUBAGENT_STATUS_PATTERNS.some((p) => p.test(text));
}

/**
 * Tool names that constitute evidence for present-tense activity narration.
 * These are tools that involve active fetching/searching/checking work.
 */
const ACTIVITY_EVIDENCE_TOOLS = new Set([
  "exec",
  "web_search",
  "web_fetch",
  "web_research",
  "browser",
  "image",
  "nodes",
  "Read",
  "Edit",
  "Write",
]);

/**
 * Present-tense activity narration patterns that claim the assistant is
 * currently doing something that has no backing tool call.
 *
 * These are intentionally narrow – first-person present-progressive + action
 * verb – to minimise false positives on legitimate text like "I'm happy to
 * help" or "I'm not sure".
 */
const ACTIVITY_NARRATION_PATTERNS: RegExp[] = [
  // "I'm checking / I am checking"
  /\bI(?:'m|\s+am)\s+(?:currently\s+)?(?:checking|verifying|inspecting|scanning)\b/i,
  // "I'm tracing / tracking / monitoring"
  /\bI(?:'m|\s+am)\s+(?:currently\s+)?(?:tracing|tracking|monitoring|watching)\b/i,
  // "I'm searching / fetching / querying"
  /\bI(?:'m|\s+am)\s+(?:currently\s+)?(?:searching|fetching|querying|looking\s+up)\b/i,
  // "I'm investigating / I'm looking into it now"
  /\bI(?:'m|\s+am)\s+(?:currently\s+)?(?:investigating|looking\s+into(?:\s+it(?:\s+now)?)?)\b/i,
  // "checking now / investigating now / verifying now"
  /\b(?:checking|investigating|verifying|tracing|searching|fetching)\s+now\b/i,
];

/** Correction note appended when unsupported activity narration is detected. */
export const UNSUPPORTED_ACTIVITY_NOTE =
  "Note: No tool call backing the above activity was made in this turn.";

/**
 * Returns true when the reply text contains unsupported present-tense activity
 * narration AND no activity-evidence tool was called in the same turn.
 *
 * Exported for unit testing.
 */
export function hasUnsupportedActivityNarration(text: string, calledToolNames: string[]): boolean {
  if (!text.trim()) {
    return false;
  }
  // If the note was already appended, skip.
  if (text.includes(UNSUPPORTED_ACTIVITY_NOTE)) {
    return false;
  }
  // If any activity-evidence tool was called, the narration is plausibly backed.
  const hasEvidence = calledToolNames.some((t) => ACTIVITY_EVIDENCE_TOOLS.has(t));
  if (hasEvidence) {
    return false;
  }
  return ACTIVITY_NARRATION_PATTERNS.some((p) => p.test(text));
}

function appendClaimGuardNotes(
  payloads: ReplyPayload[],
  calledToolNames: string[],
): ReplyPayload[] {
  let staleSubagentNoteAppended = false;
  let activityNoteAppended = false;

  return payloads.map((payload) => {
    if (payload.isError || typeof payload.text !== "string") {
      return payload;
    }
    const text = payload.text;
    let result = text;

    if (!staleSubagentNoteAppended && hasStaleSubagentStatusClaim(text, calledToolNames)) {
      result = `${result.trimEnd()}\n\n${STALE_SUBAGENT_STATUS_NOTE}`;
      staleSubagentNoteAppended = true;
    }

    if (!activityNoteAppended && hasUnsupportedActivityNarration(result, calledToolNames)) {
      result = `${result.trimEnd()}\n\n${UNSUPPORTED_ACTIVITY_NOTE}`;
      activityNoteAppended = true;
    }

    return result === text ? payload : { ...payload, text: result };
  });
}

// Track sessions pending post-compaction read audit (Layer 3)
const pendingPostCompactionAudits = new Map<string, boolean>();

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    typing,
    mode: typingMode,
    isHeartbeat,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    sessionKey,
    storePath,
    resolvedVerboseLevel,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;

  const replyToChannel =
    sessionCtx.OriginatingChannel ??
    ((sessionCtx.Surface ?? sessionCtx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveBlockStreamingCoalescing(
          cfg,
          sessionCtx.Provider,
          sessionCtx.AccountId,
          blockReplyChunking,
        )
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
          coalescing: blockReplyCoalescing,
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
        })
      : null;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({ updatedAt }),
      });
    }
  };

  if (shouldSteer && isStreaming) {
    const steered = queueEmbeddedPiMessage(followupRun.run.sessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  if (isActive && (shouldFollowup || resolvedQueue.mode === "steer")) {
    enqueueFollowupRun(queueKey, followupRun, resolvedQueue);
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  await typingSignals.signalRunStart();

  activeSessionEntry = await runMemoryFlushIfNeeded({
    cfg,
    followupRun,
    sessionCtx,
    opts,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    isHeartbeat,
  });

  const runFollowupTurn = createFollowupRunner({
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
  });

  let responseUsageLine: string | undefined;
  type SessionResetOptions = {
    failureLabel: string;
    buildLogMessage: (nextSessionId: string) => string;
    cleanupTranscripts?: boolean;
  };
  const resetSession = async ({
    failureLabel,
    buildLogMessage,
    cleanupTranscripts,
  }: SessionResetOptions): Promise<boolean> => {
    if (!sessionKey || !activeSessionStore || !storePath) {
      return false;
    }
    const prevEntry = activeSessionStore[sessionKey] ?? activeSessionEntry;
    if (!prevEntry) {
      return false;
    }
    const prevSessionId = cleanupTranscripts ? prevEntry.sessionId : undefined;
    const nextSessionId = crypto.randomUUID();
    const nextEntry: SessionEntry = {
      ...prevEntry,
      sessionId: nextSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      abortedLastRun: false,
    };
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const nextSessionFile = resolveSessionTranscriptPath(
      nextSessionId,
      agentId,
      sessionCtx.MessageThreadId,
    );
    nextEntry.sessionFile = nextSessionFile;
    activeSessionStore[sessionKey] = nextEntry;
    try {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = nextEntry;
      });
    } catch (err) {
      defaultRuntime.error(
        `Failed to persist session reset after ${failureLabel} (${sessionKey}): ${String(err)}`,
      );
    }
    followupRun.run.sessionId = nextSessionId;
    followupRun.run.sessionFile = nextSessionFile;
    activeSessionEntry = nextEntry;
    activeIsNewSession = true;
    defaultRuntime.error(buildLogMessage(nextSessionId));
    if (cleanupTranscripts && prevSessionId) {
      const transcriptCandidates = new Set<string>();
      const resolved = resolveSessionFilePath(prevSessionId, prevEntry, { agentId });
      if (resolved) {
        transcriptCandidates.add(resolved);
      }
      transcriptCandidates.add(resolveSessionTranscriptPath(prevSessionId, agentId));
      for (const candidate of transcriptCandidates) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
    return true;
  };
  const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "compaction failure",
      buildLogMessage: (nextSessionId) =>
        `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
    });
  const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
    resetSession({
      failureLabel: "role ordering conflict",
      buildLogMessage: (nextSessionId) =>
        `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
      cleanupTranscripts: true,
    });
  try {
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      commandBody,
      followupRun,
      sessionCtx,
      opts,
      typingSignals,
      blockReplyPipeline,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      applyReplyToMode,
      shouldEmitToolResult,
      shouldEmitToolOutput,
      pendingToolTasks,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat,
      sessionKey,
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore,
      storePath,
      resolvedVerboseLevel,
    });

    if (runOutcome.kind === "final") {
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const { runResult, fallbackProvider, fallbackModel, directlySentBlockKeys } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCompleted } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          storePath,
          sessionKey,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.sessionId?.trim()
      : undefined;
    const contextTokensUsed =
      agentCfgContextTokens ??
      lookupContextTokens(modelUsed) ??
      activeSessionEntry?.contextTokens ??
      DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      storePath,
      sessionKey,
      usage,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      promptTokens,
      modelUsed,
      providerUsed,
      contextTokensUsed,
      systemPromptReport: runResult.meta?.systemPromptReport,
      cliSessionId,
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = buildReplyPayloads({
      payloads: payloadArray,
      isHeartbeat,
      didLogHeartbeatStrip,
      blockStreamingEnabled,
      blockReplyPipeline,
      directlySentBlockKeys,
      replyToMode,
      replyToChannel,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      originatingTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
      accountId: sessionCtx.AccountId,
    });
    const { replyPayloads } = payloadResult;
    didLogHeartbeatStrip = payloadResult.didLogHeartbeatStrip;

    if (replyPayloads.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const calledToolNames = runResult.calledToolNames ?? [];
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    const reminderGuardedPayloads =
      hasReminderCommitment && successfulCronAdds === 0
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;
    // Apply runtime claim guards: stale sub-agent status and unsupported
    // activity narration. These append a transparent correction footnote when
    // the reply makes claims that are not backed by tool calls in this turn.
    const guardedReplyPayloads = appendClaimGuardNotes(reminderGuardedPayloads, calledToolNames);

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        provider: providerUsed,
        model: modelUsed,
        config: cfg,
      });
      const costUsd = estimateUsageCost({ usage, cost: costConfig });
      emitDiagnosticEvent({
        type: "model.usage",
        sessionKey,
        sessionId: followupRun.run.sessionId,
        channel: replyToChannel,
        provider: providerUsed,
        model: modelUsed,
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          promptTokens,
          total: totalTokens,
        },
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            provider: providerUsed,
            model: modelUsed,
            config: cfg,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        usage,
        showCost,
        costConfig,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session ${sessionKey}`;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    // If verbose is enabled and this is a new session, prepend a session hint.
    let finalPayloads = guardedReplyPayloads;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    if (autoCompactionCompleted) {
      const count = await incrementRunCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey,
        storePath,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        contextTokensUsed,
      });

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = process.cwd();
        readPostCompactionContext(workspaceDir)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            }
          })
          .catch(() => {
            // Silent failure - post-compaction context is best-effort
          });

        // Set pending audit flag for Layer 3 (post-compaction read audit)
        pendingPostCompactionAudits.set(sessionKey, true);
      }

      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        finalPayloads = [{ text: `🧹 Auto-compaction complete${suffix}.` }, ...finalPayloads];
      }
    }
    if (verboseEnabled && activeIsNewSession) {
      finalPayloads = [{ text: `🧭 New session: ${followupRun.run.sessionId}` }, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    // Post-compaction read audit (Layer 3)
    if (sessionKey && pendingPostCompactionAudits.get(sessionKey)) {
      pendingPostCompactionAudits.delete(sessionKey); // Delete FIRST - one-shot only
      try {
        const sessionFile = activeSessionEntry?.sessionFile;
        if (sessionFile) {
          const messages = readSessionMessages(sessionFile);
          const readPaths = extractReadPaths(messages);
          const workspaceDir = process.cwd();
          const audit = auditPostCompactionReads(readPaths, workspaceDir);
          if (!audit.passed) {
            enqueueSystemEvent(formatAuditWarning(audit.missingPatterns), { sessionKey });
          }
        }
      } catch {
        // Silent failure - audit is best-effort
      }
    }

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } finally {
    blockReplyPipeline?.stop();
    typing.markRunComplete();
  }
}
