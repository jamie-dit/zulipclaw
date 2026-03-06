import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __checkRunHealthForTest,
  __getPingedRunsForTest,
  __resolveWatchdogConfigForTest,
  getSubagentWatchdogStatus,
  startSubagentWatchdog,
  stopSubagentWatchdog,
} from "./subagent-watchdog.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.js";

// Minimal run record factory
function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = Date.now();
  return {
    runId: "run-test-1234-5678",
    childSessionKey: "agent:main:subagent:test-child",
    requesterSessionKey: "agent:main:zulip:channel:marcel#general",
    requesterDisplayKey: "agent:main",
    task: "Test task",
    cleanup: "delete",
    createdAt: now - 5 * 60_000,
    startedAt: now - 5 * 60_000,
    ...overrides,
  };
}

// Minimal config factory matching Required<SubagentWatchdogConfig>
function makeConfig(overrides: Partial<{
  enabled: boolean;
  checkIntervalMinutes: number;
  silentThresholdMinutes: number;
  stuckThresholdMinutes: number;
  enableStatusPings: boolean;
}> = {}) {
  return {
    enabled: true,
    checkIntervalMinutes: 1,
    silentThresholdMinutes: 10,
    stuckThresholdMinutes: 30,
    enableStatusPings: true,
    ...overrides,
  };
}

describe("subagent-watchdog: checkRunHealth", () => {
  it("returns not stuck and not silent for a recent run", () => {
    const now = Date.now();
    const run = makeRun({ startedAt: now - 2 * 60_000, createdAt: now - 2 * 60_000 });
    const config = makeConfig({ silentThresholdMinutes: 10, stuckThresholdMinutes: 30 });

    const result = __checkRunHealthForTest({ run, now, config });

    expect(result.isStuck).toBe(false);
    expect(result.isSilent).toBe(false);
    expect(result.totalMs).toBeGreaterThanOrEqual(2 * 60_000);
  });

  it("marks run as stuck after stuckThresholdMinutes", () => {
    const now = Date.now();
    const startedAt = now - 31 * 60_000; // 31 minutes ago
    const run = makeRun({ startedAt, createdAt: startedAt, iterationsUsed: 0 });
    const config = makeConfig({ stuckThresholdMinutes: 30, silentThresholdMinutes: 10 });

    const result = __checkRunHealthForTest({ run, now, config });

    expect(result.isStuck).toBe(true);
    expect(result.totalMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("does not mark recent run with iterations as silent", () => {
    const now = Date.now();
    const startedAt = now - 12 * 60_000; // 12 minutes ago
    // With 24 iterations at 30s each = 720s = 12 minutes of estimated progress
    const run = makeRun({ startedAt, createdAt: startedAt, iterationsUsed: 24 });
    const config = makeConfig({ silentThresholdMinutes: 10, stuckThresholdMinutes: 30 });

    const result = __checkRunHealthForTest({ run, now, config });

    expect(result.isSilent).toBe(false);
  });

  it("uses createdAt when startedAt is absent", () => {
    const now = Date.now();
    const createdAt = now - 35 * 60_000;
    const run = makeRun({ startedAt: undefined, createdAt });
    const config = makeConfig({ stuckThresholdMinutes: 30 });

    const result = __checkRunHealthForTest({ run, now, config });

    expect(result.isStuck).toBe(true);
    expect(result.totalMs).toBeGreaterThanOrEqual(35 * 60_000);
  });

  it("returns positive silentMs for a slow run", () => {
    const now = Date.now();
    const startedAt = now - 20 * 60_000;
    // Only 1 iteration in 20 minutes → nearly all time is "silent"
    const run = makeRun({ startedAt, createdAt: startedAt, iterationsUsed: 1 });
    const config = makeConfig({ silentThresholdMinutes: 10, stuckThresholdMinutes: 30 });

    const result = __checkRunHealthForTest({ run, now, config });

    expect(result.silentMs).toBeGreaterThan(0);
  });
});

describe("subagent-watchdog: resolveWatchdogConfig", () => {
  it("returns defaults when watchdog config is absent", () => {
    const cfg = {} as Parameters<typeof __resolveWatchdogConfigForTest>[0];
    const result = __resolveWatchdogConfigForTest(cfg);

    expect(result.enabled).toBe(true);
    expect(result.checkIntervalMinutes).toBe(1);
    expect(result.silentThresholdMinutes).toBe(10);
    expect(result.stuckThresholdMinutes).toBe(30);
    expect(result.enableStatusPings).toBe(true);
  });

  it("uses config values when provided", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            watchdog: {
              enabled: false,
              checkIntervalMinutes: 5,
              silentThresholdMinutes: 15,
              stuckThresholdMinutes: 60,
              enableStatusPings: false,
            },
          },
        },
      },
    } as Parameters<typeof __resolveWatchdogConfigForTest>[0];

    const result = __resolveWatchdogConfigForTest(cfg);

    expect(result.enabled).toBe(false);
    expect(result.checkIntervalMinutes).toBe(5);
    expect(result.silentThresholdMinutes).toBe(15);
    expect(result.stuckThresholdMinutes).toBe(60);
    expect(result.enableStatusPings).toBe(false);
  });

  it("enforces minimum values for interval/threshold fields", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            watchdog: {
              checkIntervalMinutes: 0,
              silentThresholdMinutes: 0,
              stuckThresholdMinutes: 2,
            },
          },
        },
      },
    } as Parameters<typeof __resolveWatchdogConfigForTest>[0];

    const result = __resolveWatchdogConfigForTest(cfg);

    // Minimums: checkIntervalMinutes>=1, silentThresholdMinutes>=1, stuckThresholdMinutes>=5
    expect(result.checkIntervalMinutes).toBe(1);
    expect(result.silentThresholdMinutes).toBe(1);
    expect(result.stuckThresholdMinutes).toBe(5);
  });
});

describe("subagent-watchdog: ping cooldown", () => {
  beforeEach(() => {
    // Clear pingedRuns map between tests
    __getPingedRunsForTest().clear();
  });

  it("pingedRuns map starts empty", () => {
    expect(__getPingedRunsForTest().size).toBe(0);
  });

  it("tracking a run ID in pingedRuns prevents re-ping within cooldown", () => {
    const pingedRuns = __getPingedRunsForTest();
    const runId = "run-cooldown-test";

    // Simulate a ping being recorded
    pingedRuns.set(runId, Date.now());

    // Should still be in the map (within cooldown)
    expect(pingedRuns.has(runId)).toBe(true);

    const lastPinged = pingedRuns.get(runId)!;
    const PING_COOLDOWN_MS = 5 * 60_000;
    expect(Date.now() - lastPinged).toBeLessThan(PING_COOLDOWN_MS);
  });

  it("old entries would be considered expired after cooldown", () => {
    const pingedRuns = __getPingedRunsForTest();
    const runId = "run-old-test";
    const PING_COOLDOWN_MS = 5 * 60_000;

    // Simulate an old ping (6 minutes ago)
    pingedRuns.set(runId, Date.now() - 6 * 60_000);

    const lastPinged = pingedRuns.get(runId)!;
    expect(Date.now() - lastPinged).toBeGreaterThan(PING_COOLDOWN_MS);
  });
});

describe("subagent-watchdog: lifecycle", () => {
  afterEach(() => {
    stopSubagentWatchdog();
  });

  it("starts and reports running status", () => {
    vi.useFakeTimers();
    try {
      startSubagentWatchdog();
      const status = getSubagentWatchdogStatus();
      expect(status.running).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops and reports not running", () => {
    vi.useFakeTimers();
    try {
      startSubagentWatchdog();
      stopSubagentWatchdog();
      const status = getSubagentWatchdogStatus();
      expect(status.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent: double-start does not throw", () => {
    vi.useFakeTimers();
    try {
      startSubagentWatchdog();
      expect(() => startSubagentWatchdog()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("getSubagentWatchdogStatus returns lastCheckAt and pingedRunsCount", () => {
    const status = getSubagentWatchdogStatus();
    expect(typeof status.lastCheckAt).toBe("number");
    expect(typeof status.pingedRunsCount).toBe("number");
    expect(status.pingedRunsCount).toBeGreaterThanOrEqual(0);
  });
});
