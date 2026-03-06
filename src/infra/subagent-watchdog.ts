/**
 * Sub-agent Watchdog
 *
 * Native gateway module for monitoring sub-agent runs without spawning LLM sessions.
 * Replaces the need for external watchdog-cron jobs that check "are sub-agents alive?"
 *
 * Features:
 * - Monitors active sub-agent runs via subagent-registry
 * - Detects stuck/silent runs (no progress within configured threshold)
 * - Sends status pings to requester sessions via native outbound delivery
 * - Zero LLM tokens - pure TypeScript logic
 */

import { loadConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../config/sessions.js";
import {
  countActiveDescendantRuns,
  getRunsSnapshotForRead,
  type SubagentRunRecord,
} from "../agents/subagent-registry.js";
import { defaultRuntime } from "../runtime.js";
import { logWarn } from "../logger.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SubagentWatchdogConfig } from "../config/types.js";

const WATCHDOG_INTERVAL_MS = 60_000; // Check every minute
const DEFAULT_SILENT_THRESHOLD_MS = 10 * 60_000; // 10 minutes without progress
const DEFAULT_STUCK_THRESHOLD_MS = 30 * 60_000; // 30 minutes total runtime

let watchdogTimer: NodeJS.Timeout | null = null;
let lastCheckAt = 0;

// Track runs we've already pinged to avoid spam
const pingedRuns = new Map<string, number>();
const PING_COOLDOWN_MS = 5 * 60_000; // Don't ping same run more than every 5 minutes

function resolveWatchdogConfig(cfg: OpenClawConfig): Required<SubagentWatchdogConfig> {
  const watchdog = cfg.agents?.defaults?.subagents?.watchdog;
  return {
    enabled: watchdog?.enabled ?? true,
    checkIntervalMinutes: Math.max(1, Math.floor(watchdog?.checkIntervalMinutes ?? 1)),
    silentThresholdMinutes: Math.max(1, Math.floor(watchdog?.silentThresholdMinutes ?? 10)),
    stuckThresholdMinutes: Math.max(5, Math.floor(watchdog?.stuckThresholdMinutes ?? 30)),
    enableStatusPings: watchdog?.enableStatusPings ?? true,
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function buildStatusPing(params: {
  run: SubagentRunRecord;
  activeDescendants: number;
  silentMs: number;
  totalMs: number;
  isStuck: boolean;
}): string {
  const { run, activeDescendants, silentMs, totalMs, isStuck } = params;
  const label = run.label ? ` "${run.label}"` : "";
  const lines: string[] = [];

  if (isStuck) {
    lines.push(`⏱️ **Sub-agent${label} appears stuck**`);
  } else {
    lines.push(`⏱️ **Sub-agent${label} running**`);
  }

  lines.push(`• Run ID: \`${run.runId.slice(0, 8)}\``);
  lines.push(`• Duration: ${formatDuration(totalMs)}`);

  if (silentMs > 0) {
    lines.push(`• Silent for: ${formatDuration(silentMs)}`);
  }

  if (activeDescendants > 0) {
    lines.push(`• Active descendants: ${activeDescendants}`);
  }

  if (run.iterationsUsed !== undefined && run.maxIterations !== undefined) {
    lines.push(`• Iterations: ${run.iterationsUsed}/${run.maxIterations}`);
  } else if (run.iterationsUsed !== undefined) {
    lines.push(`• Iterations: ${run.iterationsUsed}`);
  }

  if (isStuck) {
    lines.push(`\n💡 Consider: **steer**, **kill**, or checking logs`);
  }

  return lines.join("\n");
}

async function sendStatusPing(params: {
  cfg: OpenClawConfig;
  run: SubagentRunRecord;
  message: string;
}): Promise<void> {
  const { cfg, run, message } = params;

  // Only ping if we have delivery context
  const deliveryContext = run.requesterOrigin;
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return;
  }

  // Respect cooldown
  const lastPinged = pingedRuns.get(run.runId) ?? 0;
  const now = Date.now();
  if (now - lastPinged < PING_COOLDOWN_MS) {
    return;
  }
  pingedRuns.set(run.runId, now);

  // Clean up old entries periodically
  if (pingedRuns.size > 1000) {
    for (const [runId, timestamp] of pingedRuns.entries()) {
      if (now - timestamp > PING_COOLDOWN_MS * 2) {
        pingedRuns.delete(runId);
      }
    }
  }

  try {
    const agentId = resolveAgentIdFromSessionKey(run.requesterSessionKey) ?? "main";
    const identity = await resolveAgentOutboundIdentity({
      cfg,
      agentId,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
    });

    await deliverOutboundPayloads({
      cfg,
      agentId,
      payloads: [{ text: message }],
      identity,
      deliveryContext,
    });

    defaultRuntime.log?.(
      `[subagent-watchdog] Pinged ${run.runId.slice(0, 8)} in ${deliveryContext.channel}#${deliveryContext.to}`
    );
  } catch (err) {
    logWarn(`[subagent-watchdog] Failed to send ping for ${run.runId}: ${String(err)}`);
  }
}

/** @internal exported for testing */
export function __checkRunHealthForTest(params: {
  run: SubagentRunRecord;
  now: number;
  config: Required<SubagentWatchdogConfig>;
}): { isSilent: boolean; isStuck: boolean; silentMs: number; totalMs: number } {
  return checkRunHealth(params);
}

/** @internal exported for testing */
export function __resolveWatchdogConfigForTest(cfg: OpenClawConfig): Required<SubagentWatchdogConfig> {
  return resolveWatchdogConfig(cfg);
}

/** @internal exported for testing */
export function __getPingedRunsForTest(): Map<string, number> {
  return pingedRuns;
}

function checkRunHealth(params: {
  run: SubagentRunRecord;
  now: number;
  config: Required<SubagentWatchdogConfig>;
}): { isSilent: boolean; isStuck: boolean; silentMs: number; totalMs: number } {
  const { run, now, config } = params;

  const silentThresholdMs = config.silentThresholdMinutes * 60_000;
  const stuckThresholdMs = config.stuckThresholdMinutes * 60_000;

  const startedAt = run.startedAt ?? run.createdAt;
  const totalMs = now - startedAt;

  // For active runs, "silent" means no progress updates
  // We use iterationsUsed as a proxy for progress if available
  // Otherwise we check if the run has been going too long
  const silentMs = Math.max(0, totalMs - (run.iterationsUsed ?? 0) * 30_000);

  const isStuck = totalMs > stuckThresholdMs;
  const isSilent = silentMs > silentThresholdMs && totalMs > silentThresholdMs;

  return { isSilent, isStuck, silentMs, totalMs };
}

async function runWatchdogCheck(): Promise<void> {
  const cfg = loadConfig();
  const config = resolveWatchdogConfig(cfg);

  if (!config.enabled) {
    return;
  }

  const now = Date.now();
  lastCheckAt = now;

  const runs = getRunsSnapshotForRead();
  if (runs.size === 0) {
    return;
  }

  // Group runs by requester session for summary reporting
  const runsByRequester = new Map<string, SubagentRunRecord[]>();
  const activeRuns: Array<{
    run: SubagentRunRecord;
    health: ReturnType<typeof checkRunHealth>;
    descendants: number;
  }> = [];

  for (const run of runs.values()) {
    // Skip completed runs
    if (typeof run.endedAt === "number") {
      continue;
    }

    const health = checkRunHealth({ run, now, config });
    const descendants = countActiveDescendantRuns(run.childSessionKey);

    activeRuns.push({ run, health, descendants });

    // Group by requester
    const existing = runsByRequester.get(run.requesterSessionKey) ?? [];
    existing.push(run);
    runsByRequester.set(run.requesterSessionKey, existing);

    // Send individual pings for stuck or very silent runs
    if (config.enableStatusPings && (health.isStuck || (health.isSilent && health.silentMs > 15 * 60_000))) {
      const message = buildStatusPing({
        run,
        activeDescendants: descendants,
        silentMs: health.silentMs,
        totalMs: health.totalMs,
        isStuck: health.isStuck,
      });

      void sendStatusPing({ cfg, run, message });
    }
  }

  // Log summary for operators
  if (activeRuns.length > 0) {
    const stuckCount = activeRuns.filter((r) => r.health.isStuck).length;
    const silentCount = activeRuns.filter((r) => r.health.isSilent && !r.health.isStuck).length;

    if (stuckCount > 0 || silentCount > 0) {
      defaultRuntime.log?.(
        `[subagent-watchdog] ${activeRuns.length} active runs, ${stuckCount} stuck, ${silentCount} silent`
      );
    }
  }
}

export function startSubagentWatchdog(): void {
  if (watchdogTimer) {
    return;
  }

  const cfg = loadConfig();
  const config = resolveWatchdogConfig(cfg);

  if (!config.enabled) {
    defaultRuntime.log?.("[subagent-watchdog] Disabled via config");
    return;
  }

  const intervalMs = config.checkIntervalMinutes * 60_000;

  // Run initial check after a short delay to let bootstrap complete
  watchdogTimer = setTimeout(() => {
    void runWatchdogCheck();

    // Then start regular interval
    watchdogTimer = setInterval(() => {
      void runWatchdogCheck();
    }, intervalMs);

    if (watchdogTimer.unref) {
      watchdogTimer.unref();
    }
  }, 10_000);

  defaultRuntime.log?.(
    `[subagent-watchdog] Started (interval: ${config.checkIntervalMinutes}min, silent: ${config.silentThresholdMinutes}min, stuck: ${config.stuckThresholdMinutes}min)`
  );
}

export function stopSubagentWatchdog(): void {
  if (!watchdogTimer) {
    return;
  }
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  defaultRuntime.log?.("[subagent-watchdog] Stopped");
}

export function getSubagentWatchdogStatus(): {
  running: boolean;
  lastCheckAt: number;
  pingedRunsCount: number;
} {
  return {
    running: watchdogTimer !== null,
    lastCheckAt,
    pingedRunsCount: pingedRuns.size,
  };
}

// Note: startSubagentWatchdog() is called explicitly from server-startup.ts
// during gateway boot. No auto-start on module load.
