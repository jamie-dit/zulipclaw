import { describe, expect, it } from "vitest";
import {
  extractOriginTopic,
  formatRelayFooter,
  formatRelayUpdatedTime,
  formatToolElapsed,
  formatToolLine,
  renderRelayMessage,
} from "./subagent-relay.js";

describe("subagent-relay", () => {
  describe("formatToolElapsed", () => {
    it("formats 0 seconds as +0:00", () => {
      expect(formatToolElapsed(1000, 1000)).toBe("+0:00");
    });

    it("formats 5 seconds as +0:05", () => {
      expect(formatToolElapsed(1000, 6000)).toBe("+0:05");
    });

    it("formats 65 seconds as +1:05", () => {
      expect(formatToolElapsed(1000, 66000)).toBe("+1:05");
    });

    it("formats 3661 seconds as +1:01:01", () => {
      expect(formatToolElapsed(1000, 3662000)).toBe("+1:01:01");
    });

    it("clamps negative elapsed time to +0:00", () => {
      expect(formatToolElapsed(10000, 1000)).toBe("+0:00");
    });

    it("does not emit NaN for invalid timestamps", () => {
      expect(formatToolElapsed(Number.NaN as unknown as number, 1000)).toBe("+0:00");
      expect(formatToolElapsed(1000, Number.NaN as unknown as number)).toBe("+0:00");
      expect(
        formatToolElapsed(undefined as unknown as number, undefined as unknown as number),
      ).toBe("+0:00");
    });
  });

  describe("formatToolLine", () => {
    it("renders bracketed elapsed prefix instead of italic markdown", () => {
      const line = formatToolLine("read", { path: "/tmp/file.txt" }, 1_000, 8_000);
      expect(line).toContain("[+0:07]");
      expect(line).not.toContain("_+0:07_");
    });

    it("keeps hour-style elapsed formatting in the bracket prefix", () => {
      const line = formatToolLine("exec", { command: "echo hi" }, 1_000, 3_662_000);
      expect(line.startsWith("[+1:01:01]")).toBe(true);
    });
  });

  describe("relay footer", () => {
    it("formats updated time in local timezone with concise time", () => {
      const ts = Date.UTC(2026, 1, 19, 8, 28, 0);
      const expected = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(ts));
      expect(formatRelayUpdatedTime(ts)).toBe(expected);
    });

    it("includes elapsed, tool count, and updated time", () => {
      const footer = formatRelayFooter(
        {
          startedAt: 1_000,
          toolCount: 5,
          status: "running",
          lastUpdatedAt: 8_000,
        },
        32_000,
      );
      expect(footer).toContain("⏱️ 31s · 5 tool calls · updated ");
      expect(footer).toMatch(/updated\s+\d{1,2}:\d{2}/);
    });
  });

  describe("renderRelayMessage", () => {
    it("includes short model name in header (strips provider prefix)", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "sync-configs",
        model: "anthropic/claude-opus-4-6",
        toolLines: ["📄 read file.ts +0:01"],
        startedAt: 1_000,
        toolCount: 1,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("claude-opus-4-6");
      expect(msg).not.toContain("anthropic/");
    });

    it("uses model name as-is when no provider prefix", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "quick-task",
        model: "claude-opus-4-6",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("claude-opus-4-6");
    });

    it("includes origin topic indicator when originTopic is provided", () => {
      const msg = renderRelayMessage(
        {
          runId: "test-run",
          label: "mirror-task",
          model: "anthropic/claude-opus-4-6",
          toolLines: [],
          startedAt: 1_000,
          toolCount: 0,
          status: "running",
          lastUpdatedAt: 5_000,
          deliveryContext: { channel: "zulip", to: "stream:marcel#dev-ops" },
        },
        "dev-ops",
      );
      expect(msg).toContain("📍 dev-ops");
    });

    it("does not include origin topic indicator when originTopic is not provided", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "no-mirror-task",
        model: "anthropic/claude-opus-4-6",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("📍");
    });
  });

  describe("extractOriginTopic", () => {
    it("extracts topic from stream:STREAM#TOPIC format", () => {
      expect(extractOriginTopic("stream:marcel#dev-ops")).toBe("dev-ops");
    });

    it("extracts topic with spaces and special chars", () => {
      expect(extractOriginTopic("stream:marcel#zulipclaw: sub-agent topic")).toBe(
        "zulipclaw: sub-agent topic",
      );
    });

    it("returns undefined when no hash present", () => {
      expect(extractOriginTopic("stream:marcel")).toBeUndefined();
    });

    it("returns undefined when topic part is empty after hash", () => {
      expect(extractOriginTopic("stream:marcel#")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(extractOriginTopic("")).toBeUndefined();
    });
  });
});
