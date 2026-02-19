import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { DelegationNudgeConfig } from "../config/types.tools.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

const turnToolCallCounts = new Map<string, number>();
const MAX_TRACKED_SESSIONS = 1024;
const DELEGATION_NUDGE_MARKER = "⚠️ DELEGATION NUDGE:";

function normalizeSessionKey(sessionKey?: string): string | undefined {
  const normalized = sessionKey?.trim();
  return normalized || undefined;
}

function shouldApplyDelegationNudge(params: {
  sessionKey?: string;
  config?: DelegationNudgeConfig;
}): boolean {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey || !params.config?.enabled) {
    return false;
  }
  return !isSubagentSessionKey(sessionKey) && !isCronSessionKey(sessionKey);
}

function trimCounterMapIfNeeded(): void {
  if (turnToolCallCounts.size <= MAX_TRACKED_SESSIONS) {
    return;
  }
  const oldest = turnToolCallCounts.keys().next().value;
  if (oldest) {
    turnToolCallCounts.delete(oldest);
  }
}

function hasDelegationNudge(content: unknown): boolean {
  if (typeof content === "string") {
    return content.includes(DELEGATION_NUDGE_MARKER);
  }
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" && text.includes(DELEGATION_NUDGE_MARKER);
  });
}

function appendTextToToolResultMessage(message: AgentMessage, appendText: string): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }

  const messageRecord = message as unknown as Record<string, unknown>;
  const content = messageRecord.content;

  if (hasDelegationNudge(content)) {
    return message;
  }

  if (typeof content === "string") {
    return {
      ...messageRecord,
      content: `${content}${appendText}`,
    } as AgentMessage;
  }

  if (Array.isArray(content)) {
    const nextContent = [...content];
    let lastTextIndex = -1;

    for (let i = 0; i < nextContent.length; i += 1) {
      const block = nextContent[i];
      if (!block || typeof block !== "object") {
        continue;
      }
      if ((block as { type?: unknown }).type === "text") {
        lastTextIndex = i;
      }
    }

    if (lastTextIndex >= 0) {
      const block = nextContent[lastTextIndex];
      if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        const text = typeof record.text === "string" ? record.text : "";
        nextContent[lastTextIndex] = {
          ...record,
          text: `${text}${appendText}`,
        };
      }
    } else {
      nextContent.push({
        type: "text",
        text: appendText.trimStart(),
      });
    }

    return {
      ...messageRecord,
      content: nextContent,
    } as AgentMessage;
  }

  return {
    ...messageRecord,
    content: [{ type: "text", text: appendText.trimStart() }],
  } as AgentMessage;
}

export function resetDelegationNudgeCounter(sessionKey?: string): void {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return;
  }
  turnToolCallCounts.delete(key);
}

export function incrementDelegationNudgeCounter(sessionKey?: string): number {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return 0;
  }
  const next = (turnToolCallCounts.get(key) ?? 0) + 1;
  turnToolCallCounts.set(key, next);
  trimCounterMapIfNeeded();
  return next;
}

export function getDelegationNudgeCounter(sessionKey?: string): number {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return 0;
  }
  return turnToolCallCounts.get(key) ?? 0;
}

export function applyDelegationNudgeToToolResultMessage(params: {
  message: AgentMessage;
  sessionKey?: string;
  config?: DelegationNudgeConfig;
  isSynthetic?: boolean;
}): AgentMessage {
  if (params.isSynthetic || !shouldApplyDelegationNudge(params)) {
    return params.message;
  }

  const toolCallCount = getDelegationNudgeCounter(params.sessionKey);
  const softThreshold = params.config?.softThreshold ?? 3;
  const hardThreshold = params.config?.hardThreshold ?? 6;

  if (toolCallCount < softThreshold || toolCallCount >= hardThreshold) {
    return params.message;
  }

  const nudge =
    `\n\n${DELEGATION_NUDGE_MARKER} You have made ${toolCallCount} tool calls in this turn. ` +
    "You SHOULD delegate remaining work to a sub-agent using sessions_spawn. " +
    "Direct tool use in the main session should be minimal.";

  return appendTextToToolResultMessage(params.message, nudge);
}

export const __testing = {
  turnToolCallCounts,
};
