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

import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.js";
import { isSubagentSessionRunActive } from "./subagent-registry.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

/** Lightweight summary of a single orphaned run's recovery outcome. */
export type RecoveryOutcome = {
  runId: string;
  label: string;
  action: "respawned" | "skipped" | "still-running";
  detail: string;
};

/**
 * Read the last few assistant messages from a session to summarise progress.
 * Returns an empty array when the session is gone or history is unreadable.
 */
async function readSessionProgressSummary(
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
    for (const msg of assistantMessages) {
      const content = msg.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((block: unknown) => {
            const b = block as Record<string, unknown>;
            return typeof b?.text === "string";
          })
          .map((block: unknown) => (block as { text: string }).text)
          .join("\n");
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
          : "Session existed but assistant messages had no text content.",
    };
  } catch {
    return { hasHistory: false, progressSummary: "" };
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
function markRunTerminatedInRegistry(runId: string): void {
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
function taskLooksResumable(task: string): boolean {
  // Tasks that are pure investigations, coding, or multi-step workflows are generally resumable.
  // Very short or trivial tasks are less worth re-spawning.
  if (task.length < 50) {
    return false;
  }
  return true;
}

function buildResumptionTask(original: SubagentRunRecord, progressSummary: string): string {
  const originalTask = original.task;
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
 * Send a summary to Zulip. Uses the outbound delivery system via callGateway
 * so it works from the gateway process context.
 *
 * The target is intentionally hardcoded to match the infra notification routing
 * convention. If this needs to be configurable in the future, it should be
 * pulled from the OpenClaw config under a dedicated restart-recovery section.
 */
async function sendZulipSummary(message: string): Promise<void> {
  try {
    await callGateway({
      method: "send",
      params: {
        channel: "zulip",
        to: "stream:marcel#infra",
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
      // Check if the original session's run is still active in the in-memory registry.
      // After a restart, `initSubagentRegistry()` restores runs from disk and
      // `resumeSubagentRun()` re-attaches watchers for still-alive sessions.
      // If the run is still active there, re-spawning would create a duplicate.
      if (isSubagentSessionRunActive(run.childSessionKey)) {
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
      const result = await spawnSubagentDirect(
        {
          task: resumptionTask,
          label: `${label}-resumed`,
          model: run.model,
          cleanup: run.cleanup,
          runTimeoutSeconds: run.runTimeoutSeconds,
          expectsCompletionMessage: run.expectsCompletionMessage,
        },
        {
          agentChannel: run.requesterOrigin?.channel,
          agentAccountId: run.requesterOrigin?.accountId,
          agentTo: run.requesterOrigin?.to,
          agentThreadId: run.requesterOrigin?.threadId,
        },
      );

      if (result.status === "accepted") {
        const progressNote = hasHistory
          ? "re-spawned, continuing from previous progress"
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
