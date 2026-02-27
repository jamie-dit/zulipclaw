import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killStaleGatewayProcesses, type KillStaleOptions } from "./kill-stale-gateways.js";

describe("killStaleGatewayProcesses", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const OWN_PID = 1000;

  /** Build a cmdline that isGatewayArgv recognizes as a gateway process. */
  function gatewayArgs(): string[] {
    return ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway"];
  }

  /** Build a cmdline for a non-gateway process. */
  function otherArgs(): string[] {
    return ["/usr/bin/node", "/opt/app/server.js"];
  }

  function makeOpts(
    overrides: Partial<KillStaleOptions> & {
      pids?: Map<number, string[]>;
      aliveSet?: Set<number>;
      killSpy?: ReturnType<typeof vi.fn>;
    } = {},
  ): KillStaleOptions {
    const pids = overrides.pids ?? new Map<number, string[]>();
    const aliveSet = overrides.aliveSet ?? new Set<number>();
    const killSpy = overrides.killSpy ?? vi.fn();

    return {
      platform: "linux",
      killTimeoutMs: overrides.killTimeoutMs ?? 400,
      _readProcPids: () => [...pids.keys()],
      _readCmdline: (pid: number) => pids.get(pid) ?? null,
      _isPidAlive: (pid: number) => aliveSet.has(pid),
      _kill: killSpy,
      ...overrides,
    };
  }

  it("returns empty array on non-linux platforms", async () => {
    const results = await killStaleGatewayProcesses(OWN_PID, { platform: "darwin" });
    expect(results).toEqual([]);
  });

  it("returns empty array when no stale processes exist", async () => {
    const opts = makeOpts({ pids: new Map() });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);
    expect(results).toEqual([]);
  });

  it("never kills own PID", async () => {
    const killSpy = vi.fn();
    const pids = new Map<number, string[]>([
      [OWN_PID, gatewayArgs()],
      [2000, gatewayArgs()],
    ]);
    const aliveSet = new Set([OWN_PID, 2000]);

    const opts = makeOpts({
      pids,
      aliveSet,
      killSpy: killSpy.mockImplementation((pid: number) => {
        aliveSet.delete(pid);
      }),
    });

    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    // Should only have killed pid 2000
    expect(results).toHaveLength(1);
    expect(results[0].pid).toBe(2000);

    // Verify own PID was never passed to kill
    for (const call of killSpy.mock.calls) {
      expect(call[0]).not.toBe(OWN_PID);
    }
  });

  it("does not kill non-gateway processes", async () => {
    const killSpy = vi.fn();
    const pids = new Map<number, string[]>([
      [2000, otherArgs()],
      [3000, otherArgs()],
    ]);

    const opts = makeOpts({ pids, killSpy });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("kills gateway process cleanly with SIGTERM", async () => {
    const killSpy = vi.fn();
    const aliveSet = new Set([2000]);
    const pids = new Map<number, string[]>([[2000, gatewayArgs()]]);

    killSpy.mockImplementation((pid: number, signal: string) => {
      if (signal === "SIGTERM") {
        // Simulate process dying after SIGTERM
        aliveSet.delete(pid);
      }
    });

    const opts = makeOpts({ pids, aliveSet, killSpy });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ pid: 2000, signal: "SIGTERM", killed: true });
    expect(killSpy).toHaveBeenCalledWith(2000, "SIGTERM");
    // Should NOT have needed SIGKILL
    expect(killSpy).not.toHaveBeenCalledWith(2000, "SIGKILL");
  });

  it("escalates to SIGKILL when SIGTERM fails", async () => {
    const killSpy = vi.fn();
    const aliveSet = new Set([2000]);
    const pids = new Map<number, string[]>([[2000, gatewayArgs()]]);

    killSpy.mockImplementation((pid: number, signal: string) => {
      if (signal === "SIGKILL") {
        // Only SIGKILL works
        aliveSet.delete(pid);
      }
      // SIGTERM does nothing
    });

    const opts = makeOpts({ pids, aliveSet, killSpy, killTimeoutMs: 400 });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ pid: 2000, signal: "SIGKILL", killed: true });
    expect(killSpy).toHaveBeenCalledWith(2000, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(2000, "SIGKILL");
  });

  it("handles process that already exited between scan and kill", async () => {
    const killSpy = vi.fn();
    const aliveSet = new Set<number>();
    const pids = new Map<number, string[]>([[2000, gatewayArgs()]]);

    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const opts = makeOpts({ pids, aliveSet, killSpy });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toHaveLength(1);
    // Process wasn't alive, SIGTERM was attempted
    expect(results[0]).toEqual({ pid: 2000, signal: "SIGTERM", killed: true });
  });

  it("reports killed=false when process survives SIGKILL", async () => {
    const killSpy = vi.fn();
    // Process stays alive through everything
    const aliveSet = new Set([2000]);
    const pids = new Map<number, string[]>([[2000, gatewayArgs()]]);

    const opts = makeOpts({ pids, aliveSet, killSpy, killTimeoutMs: 400 });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ pid: 2000, signal: "SIGKILL", killed: false });
  });

  it("handles multiple stale gateway processes", async () => {
    const killSpy = vi.fn();
    const aliveSet = new Set([2000, 3000]);
    const pids = new Map<number, string[]>([
      [2000, gatewayArgs()],
      [3000, gatewayArgs()],
      [4000, otherArgs()], // Non-gateway, should be ignored
    ]);

    killSpy.mockImplementation((pid: number) => {
      aliveSet.delete(pid);
    });

    const opts = makeOpts({ pids, aliveSet, killSpy, killTimeoutMs: 400 });
    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.pid).toSorted((a, b) => a - b)).toEqual([2000, 3000]);
    expect(results.every((r) => r.killed)).toBe(true);

    // Verify non-gateway pid was never killed
    for (const call of killSpy.mock.calls) {
      expect(call[0]).not.toBe(4000);
    }
  });

  it("skips pids whose cmdline cannot be read", async () => {
    const killSpy = vi.fn();
    const pids = new Map<number, string[]>([[2000, gatewayArgs()]]);

    // Override _readCmdline to return null for all pids (simulating unreadable /proc)
    const opts = makeOpts({
      pids,
      killSpy,
      _readCmdline: () => null,
    });

    const results = await killStaleGatewayProcesses(OWN_PID, opts);

    expect(results).toEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
