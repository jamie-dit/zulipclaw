import { describe, expect, it } from "vitest";
import {
  extractOriginTopic,
  extractProfileShortName,
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
          deliveryContext: { channel: "zulip", to: "stream:marcel#dreamit" },
        },
        "dreamit",
      );
      expect(msg).toContain("📍 dreamit");
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
      expect(extractOriginTopic("stream:marcel#dreamit")).toBe("dreamit");
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

  describe("extractProfileShortName", () => {
    it("extracts short name after colon", () => {
      expect(extractProfileShortName("anthropic:jason")).toBe("jason");
    });

    it("extracts default profile name", () => {
      expect(extractProfileShortName("anthropic:default")).toBe("default");
    });

    it("returns full string when no colon present", () => {
      expect(extractProfileShortName("jason")).toBe("jason");
    });

    it("handles multiple colons by splitting on first", () => {
      expect(extractProfileShortName("provider:name:extra")).toBe("name:extra");
    });

    it("handles empty string after colon", () => {
      expect(extractProfileShortName("anthropic:")).toBe("");
    });
  });

  describe("renderRelayMessage authProfile", () => {
    it("includes auth profile suffix after model name when set", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        authProfile: "jason",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 21,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("claude-opus-4-6 (jason)");
    });

    it("does not include profile suffix when authProfile is not set", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 5,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("claude-opus-4-6 ·");
      expect(msg).not.toContain("claude-opus-4-6 (");
    });

    it("does not include profile suffix when authProfile is undefined", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "claude-opus-4-6",
        authProfile: undefined,
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("(");
    });
  });

  describe("renderRelayMessage completionText", () => {
    it("includes completion text in a spoiler block when present", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "web-research",
        model: "anthropic/claude-sonnet-4-20250514",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "ok",
        lastUpdatedAt: 5_000,
        completionText: "Found 3 relevant articles about TypeScript patterns.",
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("spoiler Output");
      expect(msg).toContain("Found 3 relevant articles about TypeScript patterns.");
    });

    it("does not include output spoiler when completionText is absent", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-sonnet-4-20250514",
        toolLines: ["📄 read file.ts +0:01"],
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("spoiler Output");
    });

    it("truncates long completion text with ellipsis", () => {
      const longText = "A".repeat(2500);
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "research",
        model: "anthropic/claude-sonnet-4-20250514",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "ok",
        lastUpdatedAt: 5_000,
        completionText: longText,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("spoiler Output");
      expect(msg).toContain("_(truncated)_");
      expect(msg).not.toContain("A".repeat(2500));
    });

    it("does not include output spoiler when completionText is empty/whitespace", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-sonnet-4-20250514",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "ok",
        lastUpdatedAt: 5_000,
        completionText: "   ",
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("spoiler Output");
    });

    it("sanitizes triple backticks in completion text", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "research",
        model: "anthropic/claude-sonnet-4-20250514",
        toolLines: [],
        startedAt: 1_000,
        toolCount: 0,
        status: "ok",
        lastUpdatedAt: 5_000,
        completionText: "Here is code:\n```python\nprint('hi')\n```\nDone.",
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("spoiler Output");
      expect(msg).toContain("print('hi')");
      // Triple backticks inside should be broken with zero-width spaces
      const outputSpoiler = msg.split("spoiler Output")[1];
      expect(outputSpoiler).not.toContain("```python");
    });
  });
});
