import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type { CronJob, CronRunOutcome, CronRunStatus, CronRunTelemetry } from "../types.js";
import {
  computeJobNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of the per-provider / per-agent timeouts to prevent one stuck job
 * from wedging the entire cron lane.
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
  abortSignal?: AbortSignal,
): Promise<
  CronRunOutcome & CronRunTelemetry & { delivered?: boolean; deliveryAttempted?: boolean }
> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: timeoutErrorMessage(),
  });
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  if (job.sessionTarget === "main") {
    const text = resolveJobPayloadTextForMain(job);
    if (!text) {
      const kind = job.payload.kind;
      return {
        status: "skipped",
        error:
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
      };
    }
    state.deps.enqueueSystemEvent(text, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
      const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        heartbeatResult = await state.deps.runHeartbeatOnce({
          reason,
          agentId: job.agentId,
          sessionKey: job.sessionKey,
        });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          state.deps.requestHeartbeatNow({
            reason,
            agentId: job.agentId,
            sessionKey: job.sessionKey,
          });
          return { status: "ok", summary: text };
        }
        await delay(retryDelayMs);
      }

      if (heartbeatResult.status === "ran") {
        return { status: "ok", summary: text };
      } else if (heartbeatResult.status === "skipped") {
        return { status: "skipped", error: heartbeatResult.reason, summary: text };
      } else {
        return { status: "error", error: heartbeatResult.reason, summary: text };
      }
    } else {
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
      return { status: "ok", summary: text };
    }
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
  });

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }

  // Post a short summary back to the main session only when announce
  // delivery was requested and we are confident no outbound delivery path
  // ran. If delivery was attempted but final ack is uncertain, suppress the
  // main summary to avoid duplicate user-facing sends.
  // See: https://github.com/openclaw/openclaw/issues/15692
  const summaryText = res.summary?.trim();
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const suppressMainSummary =
    res.status === "error" && res.errorKind === "delivery-target" && deliveryPlan.requested;
  if (
    summaryText &&
    deliveryPlan.requested &&
    !res.delivered &&
    res.deliveryAttempted !== true &&
    !suppressMainSummary
  ) {
    const prefix = "Cron";
    const label =
      res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    state.deps.enqueueSystemEvent(label, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
<<<<<<< HEAD
=======
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
>>>>>>> b37dc42240 (fix(cron): suppress fallback summary after attempted announce delivery)
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

/**
 * Execute a job. This version is used by the `run` command and other
 * places that need the full execution with state updates.
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  _nowMs: number,
  _opts: { forced: boolean },
) {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

  let coreResult: {
    status: CronRunStatus;
  } & CronRunOutcome &
    CronRunTelemetry;
  try {
    coreResult = await executeJobCore(state, job);
  } catch (err) {
    coreResult = { status: "error", error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    startedAt,
    endedAt,
  });

  emitJobFinished(state, job, coreResult, startedAt);

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  emit(state, {
    jobId: job.id,
    action: "finished",
    status: result.status,
    error: result.error,
    summary: result.summary,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  });
}

export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  state.deps.enqueueSystemEvent(text);
  if (opts.mode === "now") {
    state.deps.requestHeartbeatNow({ reason: "wake" });
  }
  return { ok: true } as const;
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
