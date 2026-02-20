import crypto from "node:crypto";
import type { DelegationNudgeConfig, ToolLoopDetectionConfig } from "../config/types.tools.js";
import { callGateway } from "../gateway/call.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { isPlainObject } from "../utils.js";
import {
  getDelegationNudgeCounter,
  hasDelegationNudgeAutoDelegated,
  incrementDelegationNudgeCounter,
  isDelegationNudgeFirstTurn,
  markDelegationNudgeAutoDelegated,
} from "./delegation-nudge.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  loopDetection?: ToolLoopDetectionConfig;
  delegationNudge?: DelegationNudgeConfig;
  delegationIsFirstTurn?: boolean;
  messageChannel?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  turnPrompt?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

const AUTO_DELEGATION_PROMPT_MAX_CHARS = 700;
const AUTO_DELEGATION_TOOL_ARGS_MAX_CHARS = 600;

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}

function summarizeToolParams(params: unknown): string {
  try {
    return truncateForPrompt(
      JSON.stringify(params ?? {}, null, 2),
      AUTO_DELEGATION_TOOL_ARGS_MAX_CHARS,
    );
  } catch {
    return '{"note":"unable to serialize tool params"}';
  }
}

function summarizeTurnPrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateForPrompt(trimmed, AUTO_DELEGATION_PROMPT_MAX_CHARS);
}

function resolveDelegationHardThreshold(params: {
  config: DelegationNudgeConfig;
  sessionKey?: string;
  contextFirstTurn?: boolean;
}): number {
  const normalHardThreshold = params.config.hardThreshold ?? 6;
  const firstTurnHardThreshold = params.config.firstTurnHardThreshold ?? 10;
  const isFirstTurn =
    isDelegationNudgeFirstTurn(params.sessionKey) || params.contextFirstTurn === true;
  if (!isFirstTurn) {
    return normalHardThreshold;
  }
  return Math.max(normalHardThreshold, firstTurnHardThreshold);
}

function buildAutoDelegationTask(args: {
  toolName: string;
  params: unknown;
  sessionKey?: string;
  turnPrompt?: string;
}): string {
  const promptSummary = summarizeTurnPrompt(args.turnPrompt);
  const sections = [
    "Continue the active requester task from the parent session.",
    args.sessionKey ? `Parent session: ${args.sessionKey}` : undefined,
    `Parent hit the delegation hard tool-call limit while calling tool: ${args.toolName}`,
    `Intended tool params:\n${summarizeToolParams(args.params)}`,
    promptSummary ? `Latest requester prompt excerpt:\n${promptSummary}` : undefined,
    "Complete the task and report back to the requester session.",
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return sections.join("\n\n");
}

async function sendAutoDelegationNotice(args: {
  ctx: HookContext;
  childSessionKey: string;
  toolName: string;
  toolCallCount: number;
  hardThreshold: number;
}): Promise<void> {
  if (!args.ctx.messageChannel || !args.ctx.messageTo) {
    return;
  }

  const threadId =
    args.ctx.messageThreadId !== undefined && args.ctx.messageThreadId !== null
      ? String(args.ctx.messageThreadId)
      : undefined;

  const message =
    `🤖 Auto-delegation started after tool limit (${args.toolCallCount}/${args.hardThreshold}). ` +
    `Attempted tool: ${args.toolName}. Child session: ${args.childSessionKey}.`;

  await callGateway({
    method: "send",
    params: {
      channel: args.ctx.messageChannel,
      to: args.ctx.messageTo,
      accountId: args.ctx.agentAccountId,
      threadId,
      sessionKey: args.ctx.sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    },
    timeoutMs: 10_000,
  });
}

async function autoDelegateOnHardLimit(args: {
  ctx: HookContext;
  toolName: string;
  params: unknown;
  toolCallCount: number;
  hardThreshold: number;
}): Promise<{ delegated: boolean; childSessionKey?: string }> {
  const sessionKey = args.ctx.sessionKey;
  if (!sessionKey || hasDelegationNudgeAutoDelegated(sessionKey)) {
    return { delegated: false };
  }
  const marked = markDelegationNudgeAutoDelegated(sessionKey);
  if (!marked) {
    return { delegated: false };
  }

  const task = buildAutoDelegationTask({
    toolName: args.toolName,
    params: args.params,
    sessionKey,
    turnPrompt: args.ctx.turnPrompt,
  });

  try {
    const result = await spawnSubagentDirect(
      {
        task,
        label: `Auto delegation (${args.toolName})`,
        cleanup: "keep",
        expectsCompletionMessage: true,
      },
      {
        agentSessionKey: sessionKey,
        agentChannel: args.ctx.messageChannel,
        agentAccountId: args.ctx.agentAccountId,
        agentTo: args.ctx.messageTo,
        agentThreadId: args.ctx.messageThreadId,
        agentGroupId: args.ctx.groupId ?? null,
        agentGroupChannel: args.ctx.groupChannel ?? null,
        agentGroupSpace: args.ctx.groupSpace ?? null,
        requesterAgentIdOverride: args.ctx.agentId,
      },
    );

    if (result.status !== "accepted" || !result.childSessionKey) {
      return { delegated: false };
    }

    try {
      await sendAutoDelegationNotice({
        ctx: args.ctx,
        childSessionKey: result.childSessionKey,
        toolName: args.toolName,
        toolCallCount: args.toolCallCount,
        hardThreshold: args.hardThreshold,
      });
    } catch (notifyErr) {
      log.warn(
        `delegation nudge auto-notice failed: session=${sessionKey} tool=${args.toolName} error=${String(notifyErr)}`,
      );
    }

    return { delegated: true, childSessionKey: result.childSessionKey };
  } catch (err) {
    log.warn(
      `delegation nudge auto-delegation failed: session=${sessionKey} tool=${args.toolName} error=${String(err)}`,
    );
    return { delegated: false };
  }
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { recordToolCallOutcome } = await import("./tool-loop-detection.js");
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { logToolLoopAction } = await import("../logging/diagnostic.js");
    const { detectToolCallLoop, recordToolCall } = await import("./tool-loop-detection.js");

    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);

    // Delegation nudge hard block (per-turn counter)
    if (
      args.ctx.delegationNudge?.enabled &&
      !isSubagentSessionKey(args.ctx.sessionKey) &&
      !isCronSessionKey(args.ctx.sessionKey)
    ) {
      const config = args.ctx.delegationNudge;
      const hardThreshold = resolveDelegationHardThreshold({
        config,
        sessionKey: args.ctx.sessionKey,
        contextFirstTurn: args.ctx.delegationIsFirstTurn,
      });
      const exemptTools = new Set(
        config.exemptTools ?? [
          "sessions_spawn",
          "subagents",
          "message",
          "session_status",
          "memory_search",
          "memory_get",
          "tts",
          "cron",
        ],
      );

      const toolCallCount = incrementDelegationNudgeCounter(args.ctx.sessionKey);
      const effectiveToolCallCount =
        toolCallCount > 0 ? toolCallCount : getDelegationNudgeCounter(args.ctx.sessionKey);

      if (effectiveToolCallCount >= hardThreshold && !exemptTools.has(toolName)) {
        const autoDelegation = await autoDelegateOnHardLimit({
          ctx: args.ctx,
          toolName,
          params,
          toolCallCount: effectiveToolCallCount,
          hardThreshold,
        });

        const reason = autoDelegation.delegated
          ? `BLOCKED: Tool call limit exceeded (${effectiveToolCallCount}/${hardThreshold}). Auto-delegation started in child session ${autoDelegation.childSessionKey}. Continue via that child session.`
          : `BLOCKED: Tool call limit exceeded (${effectiveToolCallCount}/${hardThreshold}). You MUST use sessions_spawn to delegate this work to a sub-agent. Only delegation tools (sessions_spawn, subagents, message) are allowed.`;
        log.error(`Delegation nudge blocking ${toolName}: ${reason}`);
        return {
          blocked: true,
          reason,
        };
      }
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
