/**
 * Post-restart recovery for sub-agent runs that were interrupted by a gateway restart.
 *
 * After the gateway restarts, the sub-agent registry is restored from disk.
 * Runs that were still active (no `endedAt`) when the gateway stopped are now orphaned
 * because their sessions no longer exist. This module detects those orphaned runs,
 * attempts to read their session history to gauge progress, and re-spawns resumable
 * tasks with context about what was already done.
 *
 * Called from `server.impl.ts` as a fire-and-forget step after `initSubagentRegistry()`.
 */

import { dispatchChannelMessageAction } from "../channels/plugins/message-actions.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { defaultRuntime } from "../runtime.js";
import { isEmbeddedPiRunActive } from "./pi-embedded-runner.js";
import type { SubagentRunRecord } from "./subagent-registry.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

/** Result of inspecting the last session message to detect completion. */
export type LastMessageCompletionCheck = {
  likelyComplete: boolean;
  reason: string;
};

/** Lightweight summary of a single orphaned run's recovery outcome. */
export type RecoveryOutcome = {
  runId: string;
  label: string;
  action: "respawned" | "skipped" | "still-running";
  detail: string;
};

function normalizeToolName(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function summarizeToolActivity(toolNames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`);
  return parts.join(", ");
}

/**
 * Read the last few assistant messages from a session to summarise progress.
 * Returns an empty array when the session is gone or history is unreadable.
 */
export async function readSessionProgressSummary(
  sessionKey: string,
): Promise<{ hasHistory: boolean; progressSummary: string }> {
  try {
    const result = await callGateway<{ messages: Array<Record<string, unknown>> }>({
      method: "chat.history",
      params: { sessionKey, limit: 30 },
      timeoutMs: 10_000,
    });

    const messages = Array.isArray(result?.messages) ? result.messages : [];
    if (messages.length === 0) {
      return { hasHistory: false, progressSummary: "" };
    }

    // Extract the last few assistant messages to understand what was accomplished.
    const assistantMessages = messages
      .filter((m) => typeof m.role === "string" && m.role === "assistant")
      .slice(-5);

    if (assistantMessages.length === 0) {
      return {
        hasHistory: true,
        progressSummary: "Session existed but no assistant output found.",
      };
    }

    const summaryParts: string[] = [];
    const toolNames: string[] = [];
    for (const msg of assistantMessages) {
      const content = msg.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") {
            textParts.push(b.text);
          }
          if (b.type === "toolCall") {
            const toolName = normalizeToolName(b.name ?? b.toolName ?? b.tool);
            if (toolName) {
              toolNames.push(toolName);
            }
          }
        }
        text = textParts.join("\n");
      }
      if (text.trim()) {
        // Truncate individual messages to keep the summary reasonable.
        const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        summaryParts.push(truncated);
      }
    }

    return {
      hasHistory: true,
      progressSummary:
        summaryParts.length > 0
          ? summaryParts.join("\n---\n")
          : toolNames.length > 0
            ? `Session had no assistant text. Recent tool activity: ${summarizeToolActivity(toolNames)}.`
          : "Session existed but assistant messages had no text content.",
    };
  } catch {
    return { hasHistory: false, progressSummary: "" };
  }
}

/**
 * Inspect the last message in a sub-agent session to determine whether the
 * task was likely completed before the gateway died.
 *
 * Heuristic:
 * - Last message is assistant text with no toolCall blocks → likely complete
 * - Last message has pending tool calls → still running
 * - Last message is a toolResult / user message / empty → still running
 *
 * Returns `likelyComplete: false` when chat.history is unavailable.
 */
export async function checkLastMessageCompletion(
  sessionKey: string,
): Promise<LastMessageCompletionCheck> {
  try {
    const result = await callGateway<{ messages: Array<Record<string, unknown>> }>({
      method: "chat.history",
      params: { sessionKey, limit: 5 },
      timeoutMs: 10_000,
    });

    const messages = Array.isArray(result?.messages) ? result.messages : [];
    if (messages.length === 0) {
      return { likelyComplete: false, reason: "no messages in session" };
    }

    const lastMsg = messages[messages.length - 1];
    const role = lastMsg?.role as string | undefined;

    if (role !== "assistant") {
      return {
        likelyComplete: false,
        reason: `last message role is "${String(role)}", not assistant`,
      };
    }

    // Check content for tool call blocks
    const content = lastMsg?.content;
    if (Array.isArray(content)) {
      const hasToolCall = content.some(
        (block: unknown) =>
          block !== null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "toolCall",
      );
      if (hasToolCall) {
        return {
          likelyComplete: false,
          reason: "last assistant message contains tool calls (still executing)",
        };
      }
    }

    // Last message is pure assistant text - likely the final response
    return {
      likelyComplete: true,
      reason: "last message is assistant text with no pending tool calls",
    };
  } catch {
    return { likelyComplete: false, reason: "failed to read session history" };
  }
}

/**
 * Check whether a session actually has a live agent run in the gateway.
 *
 * After a restart, `initSubagentRegistry()` loads all runs (including orphaned ones)
 * from disk into the in-memory registry. Checking the in-memory `subagentRuns` Map
 * for entries without `endedAt` would always return true for orphaned runs — a
 * false positive. Instead, this function checks the gateway's embedded PI runner
 * which tracks genuinely active agent loops. After a restart, no embedded runs are
 * active so this correctly returns false for all orphaned sessions.
 */
export function isSessionRunActuallyAlive(childSessionKey: string): boolean {
  try {
    const { entry } = loadSessionEntry(childSessionKey);
    if (!entry?.sessionId) {
      return false;
    }
    return isEmbeddedPiRunActive(entry.sessionId);
  } catch {
    // If the session entry can't be loaded, the session is gone.
    return false;
  }
}

/**
 * Detect orphaned runs from the persisted registry.
 * An orphaned run is one that had no `endedAt` at persist time — meaning it was
 * still in-flight when the gateway shut down.
 */
export function detectOrphanedRuns(): SubagentRunRecord[] {
  const persisted = loadSubagentRegistryFromDisk();
  const orphaned: SubagentRunRecord[] = [];
  persisted.forEach((entry) => {
    // No endedAt means it was still running when the gateway died.
    if (typeof entry.endedAt !== "number" && typeof entry.startedAt === "number") {
      orphaned.push(entry);
    }
  });
  return orphaned;
}

/**
 * Mark an orphaned run as terminated in the persisted registry so it isn't
 * picked up again on subsequent restarts.
 */
export function markRunTerminatedInRegistry(runId: string): void {
  const persisted = loadSubagentRegistryFromDisk();
  const entry = persisted.get(runId);
  if (!entry) {
    return;
  }
  const now = Date.now();
  entry.endedAt = now;
  entry.outcome = { status: "error", error: "killed-by-restart" };
  entry.cleanupHandled = true;
  entry.cleanupCompletedAt = now;
  entry.suppressAnnounceReason = "killed";
  saveSubagentRegistryToDisk(persisted);
}

/** Check whether a task looks like it involves creating a PR or pushing code. */
export function taskLooksResumable(task: string): boolean {
  // Tasks that are pure investigations, coding, or multi-step workflows are generally resumable.
  // Very short or trivial tasks are less worth re-spawning.
  if (task.length < 50) {
    return false;
  }
  return true;
}

const RESUMED_TASK_HEADER = "## Resumed Task (auto-recovery after gateway restart)";
const ORIGINAL_TASK_MARKER = "\n### Original Task\n";

function unwrapNestedResumedTask(task: string): string {
  let current = task.trim();
  for (let i = 0; i < 8; i += 1) {
    if (!current.startsWith(RESUMED_TASK_HEADER)) {
      break;
    }
    const markerIndex = current.indexOf(ORIGINAL_TASK_MARKER);
    if (markerIndex < 0) {
      break;
    }
    current = current.slice(markerIndex + ORIGINAL_TASK_MARKER.length).trim();
  }
  return current || task.trim();
}

export function buildResumptionTask(original: SubagentRunRecord, progressSummary: string): string {
  const originalTask = unwrapNestedResumedTask(original.task);
  const label = original.label || original.runId;

  const sections = [
    `## Resumed Task (auto-recovery after gateway restart)`,
    "",
    `This task was originally running as sub-agent \`${label}\` but was interrupted by a gateway restart.`,
    "",
  ];

  if (progressSummary) {
    sections.push(
      "### Previous Progress",
      "The previous session made some progress before being killed. Here is a summary of the last assistant messages:",
      "",
      "```",
      progressSummary,
      "```",
      "",
      "**Continue from where the previous session left off.** Do not repeat completed work. If the task involved a PR that was already created, check its status and continue from there.",
      "",
    );
  } else {
    sections.push(
      "### Previous Progress",
      "No session history was recoverable - the session may not have made significant progress.",
      "**Start the task from scratch.**",
      "",
    );
  }

  sections.push("### Original Task", "", originalTask);

  return sections.join("\n");
}

function shouldFallbackToFreshSession(error?: string): boolean {
  const text = (error || "").toLowerCase();
  if (!text.includes("session")) {
    return false;
  }
  return (
    text.includes("not found") ||
    text.includes("missing") ||
    text.includes("invalid") ||
    text.includes("unknown")
  );
}

async function spawnRecoveredSubagentRun(params: {
  run: SubagentRunRecord;
  label: string;
  task: string;
}): Promise<{ result: Awaited<ReturnType<typeof spawnSubagentDirect>>; reusedSession: boolean }> {
  const baseParams = {
    task: params.task,
    label: `${params.label}-resumed`,
    model: params.run.model,
    cleanup: params.run.cleanup,
    runTimeoutSeconds: params.run.runTimeoutSeconds,
    expectsCompletionMessage: params.run.expectsCompletionMessage,
  } as const;
  const spawnCtx = {
    agentSessionKey: params.run.requesterSessionKey,
    agentChannel: params.run.requesterOrigin?.channel,
    agentAccountId: params.run.requesterOrigin?.accountId,
    agentTo: params.run.requesterOrigin?.to,
    agentThreadId: params.run.requesterOrigin?.threadId,
  } as const;

  const reusedResult = await spawnSubagentDirect(
    {
      ...baseParams,
      reuseChildSessionKey: params.run.childSessionKey,
    },
    spawnCtx,
  );
  if (reusedResult.status === "accepted" || !shouldFallbackToFreshSession(reusedResult.error)) {
    return { result: reusedResult, reusedSession: true };
  }

  const freshResult = await spawnSubagentDirect(baseParams, spawnCtx);
  return { result: freshResult, reusedSession: false };
}

function buildZulipSummaryMessage(outcomes: RecoveryOutcome[]): string {
  if (outcomes.length === 0) {
    return "🔄 **Gateway restarted** - no sub-agents were running at shutdown.";
  }

  const lines = [`🔄 **Gateway restarted.** ${outcomes.length} sub-agent(s) were running:`];
  lines.push("");

  const OUTCOME_ICONS: Record<RecoveryOutcome["action"], string> = {
    respawned: "🔁",
    "still-running": "✅",
    skipped: "⏭️",
  };

  for (const outcome of outcomes) {
    const icon = OUTCOME_ICONS[outcome.action] ?? "❓";
    lines.push(`- ${icon} \`${outcome.label}\` - ${outcome.detail}`);
  }

  return lines.join("\n");
}

/**
 * Send a notification to the requester's delivery context (e.g. Zulip topic)
 * informing them that their sub-agent was interrupted and re-spawned.
 * Best-effort: never throws.
 */
async function sendRequesterNotification(run: SubagentRunRecord, newLabel: string): Promise<void> {
  const channel = run.requesterOrigin?.channel || run.requesterDeliveryContext?.channel;
  const to = run.requesterOrigin?.to || run.requesterDeliveryContext?.to;
  const accountId = run.requesterOrigin?.accountId || run.requesterDeliveryContext?.accountId;
  const label = run.label || run.runId.slice(0, 12);

  if (!channel || !to) {
    defaultRuntime.log?.(
      `[info] subagent restart recovery: no requester delivery context for ${label}, skipping requester notification`,
    );
    return;
  }

  const message = `⚡ Sub-agent \`${label}\` was interrupted by a gateway restart and has been re-spawned as \`${newLabel}\`. It will continue where the previous run left off.`;

  try {
    const cfg = loadConfig();
    await dispatchChannelMessageAction({
      channel,
      action: "send",
      cfg,
      accountId: accountId || undefined,
      params: {
        channel,
        target: to,
        message,
        accountId: accountId || undefined,
      },
      dryRun: false,
    });
  } catch (err) {
    defaultRuntime.log?.(
      `[warn] subagent restart recovery: failed to send requester notification for ${label}: ${String(err)}`,
    );
  }
}

/**
 * Send a summary to Zulip. Uses the outbound delivery system via callGateway
 * so it works from the gateway process context.
 *
 * The target is read from config at `agents.defaults.subagents.restartRecovery.notifyTarget`.
 * When the target is not configured, the summary is silently skipped.
 */
async function sendZulipSummary(message: string): Promise<void> {
  const cfg = loadConfig();
  const target = cfg.agents?.defaults?.subagents?.restartRecovery?.notifyTarget;
  if (!target) {
    defaultRuntime.log?.(
      "[info] subagent restart recovery: no notifyTarget configured, skipping Zulip summary",
    );
    return;
  }
  try {
    await callGateway({
      method: "send",
      params: {
        channel: "zulip",
        to: target,
        message,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 15_000,
    });
  } catch (err) {
    defaultRuntime.log?.(
      `[warn] subagent restart recovery: failed to send Zulip summary: ${String(err)}`,
    );
  }
}

/**
 * Main recovery flow. Called once after gateway startup + registry init.
 *
 * 1. Detect orphaned runs from disk registry.
 * 2. For each, read session history to gauge progress.
 * 3. Re-spawn resumable tasks; mark non-resumable as terminated.
 * 4. Send a Zulip summary.
 */
export async function runSubagentRestartRecovery(): Promise<RecoveryOutcome[]> {
  const orphaned = detectOrphanedRuns();
  if (orphaned.length === 0) {
    return [];
  }

  defaultRuntime.log?.(
    `[info] subagent restart recovery: found ${orphaned.length} orphaned run(s)`,
  );

  const outcomes: RecoveryOutcome[] = [];

  for (const run of orphaned) {
    const label = run.label || run.runId.slice(0, 12);
    try {
      // Check if the session actually has a live agent run in the gateway's embedded
      // runner. The old `isSubagentSessionRunActive()` checked the in-memory registry
      // which is circular after restart — `initSubagentRegistry()` loads orphaned runs
      // into memory so they falsely appear active. This check queries the real embedded
      // PI runner state instead (empty after restart → all orphans correctly detected).
      if (isSessionRunActuallyAlive(run.childSessionKey)) {
        outcomes.push({
          runId: run.runId,
          label,
          action: "still-running",
          detail: "Original session still active, skipping re-spawn",
        });
        defaultRuntime.log?.(
          `[info] subagent restart recovery: ${label} still active in registry, skipping re-spawn`,
        );
        continue;
      }

      // --- Smart skip checks (cheapest first) ---

      // Check 1: Completion marker (cheap - just a field on the persisted record).
      // Written by the announce flow after reading sub-agent output. If present,
      // the sub-agent completed its work but the gateway died before lifecycle end.
      if (run.completionMarker?.completedAt) {
        markRunTerminatedInRegistry(run.runId);
        outcomes.push({
          runId: run.runId,
          label,
          action: "skipped",
          detail: `Task already completed (completion marker set at ${new Date(run.completionMarker.completedAt).toISOString()})`,
        });
        defaultRuntime.log?.(
          `[info] subagent restart recovery: ${label} has completion marker, skipping re-spawn`,
        );
        continue;
      }

      // Check 2: Last message heuristic (requires RPC to read session history).
      // If the last message is pure assistant text (no tool calls), the sub-agent
      // likely finished its work and was about to return.
      const lastMsgCheck = await checkLastMessageCompletion(run.childSessionKey);
      if (lastMsgCheck.likelyComplete) {
        markRunTerminatedInRegistry(run.runId);
        outcomes.push({
          runId: run.runId,
          label,
          action: "skipped",
          detail: `Task likely complete: ${lastMsgCheck.reason}`,
        });
        defaultRuntime.log?.(
          `[info] subagent restart recovery: ${label} last message indicates completion, skipping re-spawn`,
        );
        continue;
      }

      // --- End smart skip checks ---

      // Read session history to determine progress.
      const { hasHistory, progressSummary } = await readSessionProgressSummary(run.childSessionKey);

      // Mark the old run as terminated regardless of whether we re-spawn.
      markRunTerminatedInRegistry(run.runId);

      // If the run had already completed (endedAt would be set, but we already filtered),
      // or if the task is too trivial, skip re-spawning.
      if (!taskLooksResumable(run.task)) {
        outcomes.push({
          runId: run.runId,
          label,
          action: "skipped",
          detail: "Task too short/trivial to re-spawn",
        });
        continue;
      }

      // Build the resumption task with context.
      const resumptionTask = buildResumptionTask(run, progressSummary);

      // Re-spawn using the original requester context.
      const { result, reusedSession } = await spawnRecoveredSubagentRun({
        run,
        label,
        task: resumptionTask,
      });

      if (result.status === "accepted") {
        const newLabel = `${label}-resumed`;
        const progressNote = hasHistory
          ? reusedSession
            ? "re-spawned in-place, continuing from previous progress"
            : "re-spawned in new session, continuing from previous progress"
          : reusedSession
            ? "re-spawned in-place (no text history recoverable)"
            : "re-spawned from scratch (no history recoverable)";
        outcomes.push({
          runId: run.runId,
          label,
          action: "respawned",
          detail: progressNote,
        });
        defaultRuntime.log?.(
          `[info] subagent restart recovery: re-spawned ${label} as ${result.childSessionKey}`,
        );

        // Update the old relay message to show it was re-spawned.
        // Use dynamic import to avoid circular dependency (relay → restart-recovery → relay).
        try {
          const { markRelayRunRespawned } = await import("./subagent-relay.js");
          markRelayRunRespawned(run.runId, newLabel);
        } catch {
          // Best-effort: relay update failure shouldn't block recovery
        }

        // Notify the requester topic
        await sendRequesterNotification(run, newLabel);
      } else {
        outcomes.push({
          runId: run.runId,
          label,
          action: "skipped",
          detail: `Re-spawn failed: ${result.error || result.status}`,
        });
        defaultRuntime.log?.(
          `[warn] subagent restart recovery: failed to re-spawn ${label}: ${result.error || result.status}`,
        );
      }
    } catch (err) {
      outcomes.push({
        runId: run.runId,
        label,
        action: "skipped",
        detail: `Error during recovery: ${String(err)}`,
      });
      defaultRuntime.log?.(
        `[warn] subagent restart recovery: error recovering ${label}: ${String(err)}`,
      );
    }
  }

  // Send summary to Zulip.
  if (outcomes.length > 0) {
    const summaryMessage = buildZulipSummaryMessage(outcomes);
    await sendZulipSummary(summaryMessage);
  }

  return outcomes;
}
