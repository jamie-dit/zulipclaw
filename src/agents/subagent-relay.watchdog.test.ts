import { describe, expect, it } from "vitest";
import {
  computeWatchdogTimeoutMs,
  resolveWatchdogStatusEmoji,
  WATCHDOG_DEFAULT_TIMEOUT_MS,
  WATCHDOG_NUDGE_FOLLOWUP_MS,
} from "./subagent-relay.js";

describe("subagent-relay watchdog", () => {
  describe("computeWatchdogTimeoutMs", () => {
    it("returns default timeout for regular tools", () => {
      expect(computeWatchdogTimeoutMs("read", { path: "/tmp/file.txt" })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
      expect(computeWatchdogTimeoutMs("write", { path: "/tmp/file.txt" })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
      expect(computeWatchdogTimeoutMs("edit", { path: "/tmp/file.txt" })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
      expect(computeWatchdogTimeoutMs("web_search", { query: "hello" })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
    });

    it("returns default timeout for exec with short timeout", () => {
      expect(computeWatchdogTimeoutMs("exec", { command: "ls", timeout: 30 })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
    });

    it("returns default timeout for exec with no timeout", () => {
      expect(computeWatchdogTimeoutMs("exec", { command: "ls" })).toBe(WATCHDOG_DEFAULT_TIMEOUT_MS);
    });

    it("extends timeout for exec with long timeout (> 5 min)", () => {
      // 10 minute timeout → 10 min + 1 min buffer = 11 min
      const result = computeWatchdogTimeoutMs("exec", { command: "pnpm test", timeout: 600 });
      expect(result).toBe(600_000 + 60_000);
    });

    it("extends timeout for exec with exactly 5 min timeout", () => {
      // 300s = exactly 5 min = exactly WATCHDOG_DEFAULT_TIMEOUT_MS
      // Not > default, so should be default
      const result = computeWatchdogTimeoutMs("exec", { command: "test", timeout: 300 });
      expect(result).toBe(WATCHDOG_DEFAULT_TIMEOUT_MS);
    });

    it("extends timeout for exec with timeout just over 5 min", () => {
      const result = computeWatchdogTimeoutMs("exec", { command: "test", timeout: 301 });
      expect(result).toBe(301_000 + 60_000);
    });

    it("returns extended timeout for process action", () => {
      expect(computeWatchdogTimeoutMs("process", { action: "poll" })).toBe(10 * 60_000);
    });

    it("returns extended timeout for process with long poll timeout", () => {
      // 15 minute poll timeout → max(10 min, 15 min + 1 min buffer) = 16 min
      const result = computeWatchdogTimeoutMs("process", { action: "poll", timeout: 900_000 });
      expect(result).toBe(900_000 + 60_000);
    });

    it("returns extended timeout for sessions_spawn", () => {
      expect(computeWatchdogTimeoutMs("sessions_spawn", { task: "do something" })).toBe(
        30 * 60_000,
      );
    });

    it("returns extended timeout for subagents", () => {
      expect(computeWatchdogTimeoutMs("subagents", { action: "list" })).toBe(30 * 60_000);
    });

    it("handles case-insensitive tool names", () => {
      expect(computeWatchdogTimeoutMs("Exec", { command: "test", timeout: 600 })).toBe(
        600_000 + 60_000,
      );
      expect(computeWatchdogTimeoutMs("PROCESS", { action: "poll" })).toBe(10 * 60_000);
      expect(computeWatchdogTimeoutMs("Sessions_Spawn", { task: "x" })).toBe(30 * 60_000);
    });

    it("handles tool names with whitespace", () => {
      expect(computeWatchdogTimeoutMs("  exec  ", { command: "test", timeout: 600 })).toBe(
        600_000 + 60_000,
      );
    });

    it("handles invalid timeout values gracefully", () => {
      expect(computeWatchdogTimeoutMs("exec", { command: "ls", timeout: NaN })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
      expect(computeWatchdogTimeoutMs("exec", { command: "ls", timeout: Infinity })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
      expect(computeWatchdogTimeoutMs("exec", { command: "ls", timeout: -100 })).toBe(
        WATCHDOG_DEFAULT_TIMEOUT_MS,
      );
    });

    it("handles empty args", () => {
      expect(computeWatchdogTimeoutMs("exec", {})).toBe(WATCHDOG_DEFAULT_TIMEOUT_MS);
    });
  });

  describe("resolveWatchdogStatusEmoji", () => {
    it("returns empty string for active status", () => {
      expect(resolveWatchdogStatusEmoji("active")).toBe("");
    });

    it("returns ⏳ for nudged status", () => {
      expect(resolveWatchdogStatusEmoji("nudged")).toBe(" ⏳");
    });

    it("returns ⚠️ for frozen status", () => {
      expect(resolveWatchdogStatusEmoji("frozen")).toBe(" ⚠️");
    });

    it("returns empty string for undefined", () => {
      expect(resolveWatchdogStatusEmoji(undefined)).toBe("");
    });
  });

  describe("WATCHDOG_NUDGE_FOLLOWUP_MS", () => {
    it("is 2 minutes", () => {
      expect(WATCHDOG_NUDGE_FOLLOWUP_MS).toBe(2 * 60_000);
    });
  });

  describe("WATCHDOG_DEFAULT_TIMEOUT_MS", () => {
    it("is 5 minutes", () => {
      expect(WATCHDOG_DEFAULT_TIMEOUT_MS).toBe(5 * 60_000);
    });
  });
});
