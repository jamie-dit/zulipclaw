import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { DelegationNudgeConfig } from "../config/types.tools.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { applyDelegationNudgeToToolResultMessage } from "./delegation-nudge.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    delegationNudge?: DelegationNudgeConfig;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
    ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        return hookRunner.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
    : undefined;

  const hasToolResultPersistHooks = hookRunner?.hasHooks("tool_result_persist") ?? false;
  const shouldApplyDelegationNudge = opts?.delegationNudge?.enabled === true;

  const transform =
    hasToolResultPersistHooks || shouldApplyDelegationNudge
      ? // oxlint-disable-next-line typescript/no-explicit-any
        (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
          let nextMessage = message;

          if (hasToolResultPersistHooks) {
            const out = hookRunner?.runToolResultPersist(
              {
                toolName: meta.toolName,
                toolCallId: meta.toolCallId,
                message: nextMessage,
                isSynthetic: meta.isSynthetic,
              },
              {
                agentId: opts?.agentId,
                sessionKey: opts?.sessionKey,
                toolName: meta.toolName,
                toolCallId: meta.toolCallId,
              },
            );
            nextMessage = out?.message ?? nextMessage;
          }

          if (shouldApplyDelegationNudge) {
            nextMessage = applyDelegationNudgeToToolResultMessage({
              message: nextMessage,
              sessionKey: opts?.sessionKey,
              config: opts?.delegationNudge,
              isSynthetic: meta.isSynthetic,
            });
          }

          return nextMessage;
        }
      : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
