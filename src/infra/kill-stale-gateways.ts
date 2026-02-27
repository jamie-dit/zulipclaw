import fsSync from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { isGatewayArgv, readLinuxCmdline } from "./gateway-process-utils.js";

const gatewayLog = createSubsystemLogger("gateway");

const DEFAULT_KILL_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 200;

export type KillResult = {
  pid: number;
  signal: "SIGTERM" | "SIGKILL";
  killed: boolean;
};

export type KillStaleOptions = {
  /** Maximum time to wait for SIGTERM before escalating to SIGKILL. */
  killTimeoutMs?: number;
  /** Override platform for testing. */
  platform?: NodeJS.Platform;
  /** Override for isPidAlive (testing). */
  _isPidAlive?: (pid: number) => boolean;
  /** Override for reading /proc cmdline (testing). */
  _readCmdline?: (pid: number) => string[] | null;
  /** Override for reading /proc directory entries (testing). */
  _readProcPids?: () => number[];
  /** Override for process.kill (testing). */
  _kill?: (pid: number, signal: NodeJS.Signals) => void;
};

function readProcPids(): number[] {
  try {
    const entries = fsSync.readdirSync("/proc");
    const pids: number[] = [];
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (Number.isFinite(pid) && pid > 0 && String(pid) === entry) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scan for stale gateway processes and kill them.
 *
 * Only operates on Linux (reads /proc directly). On other platforms this is a
 * no-op and returns an empty array.
 *
 * @param ownPid - The PID of the current process (excluded from killing).
 * @param opts   - Optional overrides for timeouts and test injection.
 */
export async function killStaleGatewayProcesses(
  ownPid: number,
  opts: KillStaleOptions = {},
): Promise<KillResult[]> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") {
    return [];
  }

  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const checkAlive = opts._isPidAlive ?? isPidAlive;
  const getCmdline = opts._readCmdline ?? readLinuxCmdline;
  const getPids = opts._readProcPids ?? readProcPids;
  const kill = opts._kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  const allPids = getPids();
  const staleGatewayPids: number[] = [];

  for (const pid of allPids) {
    if (pid === ownPid) {
      continue;
    }
    const args = getCmdline(pid);
    if (args && isGatewayArgv(args)) {
      staleGatewayPids.push(pid);
    }
  }

  if (staleGatewayPids.length === 0) {
    return [];
  }

  gatewayLog.info(
    `found ${staleGatewayPids.length} stale gateway process(es): ${staleGatewayPids.join(", ")}`,
  );

  const results: KillResult[] = [];

  for (const pid of staleGatewayPids) {
    let result: KillResult;

    try {
      kill(pid, "SIGTERM");
      gatewayLog.info(`sent SIGTERM to stale gateway pid ${pid}`);
    } catch {
      // Process may have already exited between scan and kill
      gatewayLog.debug(`failed to send SIGTERM to pid ${pid} (already exited?)`);
      results.push({ pid, signal: "SIGTERM", killed: !checkAlive(pid) });
      continue;
    }

    // Poll for death up to killTimeoutMs
    const deadline = Date.now() + killTimeoutMs;
    let died = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (!checkAlive(pid)) {
        died = true;
        break;
      }
    }

    if (died) {
      gatewayLog.info(`stale gateway pid ${pid} exited after SIGTERM`);
      result = { pid, signal: "SIGTERM", killed: true };
    } else {
      // Escalate to SIGKILL
      try {
        kill(pid, "SIGKILL");
        gatewayLog.warn(`sent SIGKILL to stale gateway pid ${pid} (did not exit after SIGTERM)`);
      } catch {
        gatewayLog.debug(`failed to send SIGKILL to pid ${pid} (already exited?)`);
      }
      // Give a brief moment for SIGKILL to take effect
      await sleep(POLL_INTERVAL_MS);
      const finallyDead = !checkAlive(pid);
      result = { pid, signal: "SIGKILL", killed: finallyDead };
      if (finallyDead) {
        gatewayLog.info(`stale gateway pid ${pid} killed with SIGKILL`);
      } else {
        gatewayLog.error(`stale gateway pid ${pid} could not be killed`);
      }
    }

    results.push(result);
  }

  return results;
}
