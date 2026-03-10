import { describe, expect, it } from "vitest";
import {
  countToolCallsFromHistory,
  extractOriginTopic,
  extractProfileShortName,
  extractRelayMessageText,
  formatRelayFooter,
  formatRelayUpdatedTime,
  formatToolElapsed,
  formatToolLine,
  renderRelayMessage,
  sanitizeForCodeFence,
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
        toolEntries: [{ line: "📄 read file.ts +0:01", name: "read" }],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
          toolEntries: [],
          pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("📍");
    });

    it("includes sandbox badge in header when run is sandboxed", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "web-research",
        model: "anthropic/claude-opus-4-6",
        sandboxed: true,
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("🔒 sandbox");
    });

    it("shows context usage in header when usage + context window are available", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "ctx-test",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        contextUsedTokens: 45_123,
        contextWindowTokens: 200_000,
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("45k/200k ctx");
    });

    it("does not render Thoughts spoiler even when thought history is present", () => {
      const longThoughtLine = `${"A".repeat(180)} tail-marker`;

      const msg = renderRelayMessage({
        runId: "test-run",
        label: "thinking-test",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [{ line: "[+0:01] 📄 read: /tmp/a.ts", name: "read" }],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "running",
        thinkingSnippet: "Analyzing the file structure to determine the safest patch path...",
        thoughtHistory: [
          {
            text: "Analyzing the file structure to determine the safest patch path.",
            ts: Date.UTC(2026, 2, 2, 14, 31, 0),
          },
          { text: longThoughtLine, ts: Date.UTC(2026, 2, 2, 14, 32, 0) },
        ],
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("```spoiler Tool calls");
      expect(msg).not.toContain("```spoiler Thoughts");
      expect(msg).not.toContain("tail-marker");
      expect(msg).not.toContain("_💭");
    });

    it("does not render Thoughts spoiler for empty or legacy thought values", () => {
      const noThoughtMsg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      const legacyThoughtMsg = renderRelayMessage({
        runId: "test-run",
        label: "legacy-thought",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        currentThought: "legacy captured thought",
        lastUpdatedAt: Date.UTC(2026, 2, 2, 15, 10, 0),
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(noThoughtMsg).not.toContain("```spoiler Thoughts");
      expect(noThoughtMsg).not.toContain("> _(no thoughts yet)_");
      expect(legacyThoughtMsg).not.toContain("```spoiler Thoughts");
      expect(legacyThoughtMsg).not.toContain("legacy captured thought");
    });

    it("includes estimated context usage when only thoughtHistory is present", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "ctx-thought-history",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        thoughtHistory: [{ text: "checking implementation details", ts: Date.now() }],
        contextWindowTokens: 200_000,
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("/200k ctx");
    });

    it("renders one-level nested child tool lines under sessions_spawn entries", () => {
      const childState = {
        runId: "child-run",
        label: "child-task",
        model: "anthropic/claude-sonnet-4-20250514",
        toolEntries: [
          { line: "[+0:01] 📄 read: /tmp/child.ts", name: "read" },
          { line: "[+0:02] 🔧 exec: pnpm test", name: "exec" },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 2_000,
        toolCount: 2,
        status: "running",
        lastUpdatedAt: 6_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      };

      const msg = renderRelayMessage(
        {
          runId: "parent-run",
          label: "parent-task",
          model: "anthropic/claude-opus-4-6",
          toolEntries: [
            {
              line: "[+0:03] 🧑‍💻 sessions spawn: do child work",
              name: "sessions_spawn",
              childRunId: "child-run",
            },
          ],
          pendingToolCallIds: new Map(),
          startedAt: 1_000,
          toolCount: 1,
          status: "running",
          lastUpdatedAt: 5_000,
          deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
        },
        undefined,
        {
          resolveChildState: (runId) => (runId === "child-run" ? childState : undefined),
        },
      );

      expect(msg).toContain("↳ 🔄 child-task");
      expect(msg).toContain("[+0:01] 📄 read: /tmp/child.ts");
      expect(msg).toContain("[+0:02] 🔧 exec: pnpm test");
    });

    it("renders nested spoiler per tool result with tool name heading", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📄 read: /tmp/file.txt",
            name: "read",
            resultText: "file contents",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).toContain("[+0:01] 📄 read: /tmp/file.txt");
      expect(msg).toContain("```spoiler read\nfile contents\n```");
    });

    it("truncates nested tool result text at 1000 chars", () => {
      const longResult = "A".repeat(1200);
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 🔧 exec: cat huge.log",
            name: "exec",
            resultText: longResult,
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("```spoiler exec");
      expect(msg).toContain("_(truncated)_");
      expect(msg).not.toContain(longResult);
    });

    it("shows running indicator only on the last pending tool call", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📄 read: /tmp/a.ts",
            name: "read",
            resultText: "done",
          },
          {
            line: "[+0:02] 🔧 exec: npm test",
            name: "exec",
          },
          {
            line: "[+0:03] 🔍 web search: nested spoilers",
            name: "web_search",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 3,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("[+0:03] 🔍 web search: nested spoilers ⏳");
      expect(msg).toContain("[+0:02] 🔧 exec: npm test");
      expect(msg).not.toContain("[+0:02] 🔧 exec: npm test ⏳");
    });

    it("hides running indicator once no pending tool calls remain", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 🔧 exec: npm test",
            name: "exec",
            resultText: "ok",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).not.toContain("⏳");
    });

    it("shows per-tool duration in spoiler heading (seconds and minutes)", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 🔧 exec: echo hi",
            name: "exec",
            startedAtMs: 1_000,
            completedAtMs: 2_200,
            resultText: "ok",
          },
          {
            line: "[+0:02] 📄 read: /tmp/a.ts",
            name: "read",
            startedAtMs: 1_000,
            completedAtMs: 73_000,
            resultText: "content",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 2,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("```spoiler exec (1.2s)");
      expect(msg).toContain("```spoiler read (1m12s)");
    });

    it("shows footer summary by tool type for 3+ tool calls", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          { line: "[+0:01] 📄 read: /tmp/a.ts", name: "read" },
          { line: "[+0:02] 📄 read: /tmp/b.ts", name: "read" },
          { line: "[+0:03] ✏️ edit: /tmp/a.ts", name: "edit" },
          { line: "[+0:04] 🔧 exec: npm test", name: "exec" },
          { line: "[+0:05] 🔍 web search: relay ux", name: "web_search" },
          { line: "[+0:06] 🔨 custom", name: "custom_tool" },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 6,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("📄 2 reads · ✏️ 1 edit · 🔧 1 exec · 🔍 1 search · 🔨 1 other");
    });

    it("does not show footer summary for fewer than 3 tool calls", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          { line: "[+0:01] 📄 read: /tmp/a.ts", name: "read" },
          { line: "[+0:02] 🔧 exec: npm test", name: "exec" },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 2,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).not.toContain("reads ·");
      expect(msg).not.toContain("execs");
    });

    it("groups consecutive reads across different files", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📄 read: /tmp/a.ts",
            name: "read",
            resultText: "a-content",
          },
          {
            line: "[+0:02] 📄 read: /tmp/b.ts",
            name: "read",
            resultText: "b-content",
          },
          {
            line: "[+0:03] 🔧 exec: npm test",
            name: "exec",
            resultText: "ok",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 3,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("[+0:01] 📄 read (2 files)");
      expect(msg).toContain("```spoiler read (2 files)");
      expect(msg).toContain("**/tmp/a.ts**");
      expect(msg).toContain("**/tmp/b.ts**");
      expect(msg).not.toContain("[+0:02] 📄 read: /tmp/b.ts");
    });

    it("does not group reads when the same file is paginated", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📄 read: /tmp/a.ts [lines 1-100]",
            name: "read",
            resultText: "chunk-1",
          },
          {
            line: "[+0:02] 📄 read: /tmp/a.ts [lines 101-200]",
            name: "read",
            resultText: "chunk-2",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 2,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("[+0:01] 📄 read: /tmp/a.ts [lines 1-100]");
      expect(msg).toContain("[+0:02] 📄 read: /tmp/a.ts [lines 101-200]");
      expect(msg).not.toContain("read (2 files)");
    });

    it("does not group reads when a non-read entry breaks the sequence", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📄 read: /tmp/a.ts",
            name: "read",
            resultText: "a-content",
          },
          {
            line: "[+0:02] 🔧 exec: npm test",
            name: "exec",
            resultText: "ok",
          },
          {
            line: "[+0:03] 📄 read: /tmp/b.ts",
            name: "read",
            resultText: "b-content",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 3,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).not.toContain("read (2 files)");
      expect(msg).toContain("[+0:01] 📄 read: /tmp/a.ts");
      expect(msg).toContain("[+0:03] 📄 read: /tmp/b.ts");
    });

    it("renders edit diff block before the result confirmation", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] ✏️ edit: /tmp/file.ts",
            name: "edit",
            editDiff: { oldText: "const a = 1;", newText: "const a = 2;" },
            resultText: "Successfully replaced text in /tmp/file.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("```diff");
      expect(msg).toContain("- const a = 1;");
      expect(msg).toContain("+ const a = 2;");
      const diffIdx = msg.indexOf("```diff");
      const resultIdx = msg.indexOf("Successfully replaced text in /tmp/file.ts");
      expect(diffIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThan(diffIdx);
    });

    it("renders write preview content before result confirmation", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] 📝 write: /tmp/file.ts",
            name: "write",
            writePreview: "console.log('hello');",
            resultText: "Successfully wrote 21 bytes to /tmp/file.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("**Content** (21 bytes):");
      expect(msg).toContain("console.log('hello');");
      expect(msg).toContain("Successfully wrote 21 bytes to /tmp/file.ts");
    });

    it("prefixes each line correctly for multi-line edit diffs", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] ✏️ edit: /tmp/file.ts",
            name: "edit",
            editDiff: { oldText: "line-1\nline-2", newText: "line-a\nline-b" },
            resultText: "Successfully replaced text in /tmp/file.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain("- line-1\n- line-2");
      expect(msg).toContain("+ line-a\n+ line-b");
    });

    it("truncates long edit and write previews at 500 chars", () => {
      const longOld = "o".repeat(700);
      const longNew = "n".repeat(700);
      const longWrite = "w".repeat(700);
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] ✏️ edit: /tmp/file.ts",
            name: "edit",
            editDiff: { oldText: longOld, newText: longNew },
            resultText: "Successfully replaced text in /tmp/file.ts",
          },
          {
            line: "[+0:02] 📝 write: /tmp/file.ts",
            name: "write",
            writePreview: longWrite,
            resultText: "Successfully wrote 700 bytes to /tmp/file.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 2,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain(`- ${"o".repeat(500)}`);
      expect(msg).toContain(`+ ${"n".repeat(500)}`);
      expect(msg).not.toContain(`- ${"o".repeat(501)}`);
      expect(msg).not.toContain(`+ ${"n".repeat(501)}`);

      expect(msg).toContain("**Content** (500 bytes):");
      expect(msg).toContain("_(truncated)_");
      expect(msg).toContain("w".repeat(500));
      expect(msg).not.toContain("w".repeat(501));
    });

    it("does not render edit/write previews when args are missing", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [
          {
            line: "[+0:01] ✏️ edit: /tmp/file.ts",
            name: "edit",
            resultText: "Successfully replaced text in /tmp/file.ts",
          },
          {
            line: "[+0:02] 📝 write: /tmp/file.ts",
            name: "write",
            resultText: "Successfully wrote 42 bytes to /tmp/file.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 2,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).not.toContain("```diff");
      expect(msg).not.toContain("**Content** (");
      expect(msg).toContain("Successfully replaced text in /tmp/file.ts");
      expect(msg).toContain("Successfully wrote 42 bytes to /tmp/file.ts");
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

  describe("countToolCallsFromHistory", () => {
    it("counts toolResult and tool messages", () => {
      const count = countToolCallsFromHistory([
        { role: "assistant", content: "start" },
        { role: "toolResult", toolCallId: "call-1", content: "result" },
        { role: "tool", id: "tool-2", content: "tool payload" },
      ]);
      expect(count).toBe(2);
    });

    it("de-duplicates entries with the same tool call id", () => {
      const count = countToolCallsFromHistory([
        { role: "tool", id: "dup-1", content: "call payload" },
        { role: "toolResult", toolCallId: "dup-1", content: "call result" },
        { role: "toolResult", toolUseId: "dup-1", content: "duplicate format" },
      ]);
      expect(count).toBe(1);
    });
  });

  describe("renderRelayMessage authProfile", () => {
    it("includes auth profile suffix after model name when set", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "worker",
        model: "anthropic/claude-opus-4-6",
        authProfile: "jason",
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      expect(msg).not.toContain("claude-opus-4-6 (");
    });
  });

  describe("renderRelayMessage completionText", () => {
    it("includes completion text in a spoiler block when present", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "web-research",
        model: "anthropic/claude-sonnet-4-20250514",
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
        toolEntries: [{ line: "📄 read file.ts +0:01", name: "read" }],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
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
        toolEntries: [],
        pendingToolCallIds: new Map(),
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

  describe("sanitizeForCodeFence", () => {
    it("breaks up triple backticks with zero-width spaces", () => {
      expect(sanitizeForCodeFence("```python")).not.toContain("```");
      expect(sanitizeForCodeFence("```python")).toContain("\u200B");
    });

    it("neutralizes markdown heading at line start", () => {
      expect(sanitizeForCodeFence("# Heading")).toContain("\u200B#");
      expect(sanitizeForCodeFence("## Sub")).toContain("\u200B##");
      expect(sanitizeForCodeFence("### Third")).toContain("\u200B###");
    });

    it("neutralizes unordered list markers at line start", () => {
      expect(sanitizeForCodeFence("- item")).toContain("\u200B-");
      expect(sanitizeForCodeFence("* item")).toContain("\u200B*");
      expect(sanitizeForCodeFence("+ item")).toContain("\u200B+");
    });

    it("neutralizes blockquote markers at line start", () => {
      expect(sanitizeForCodeFence("> quoted")).toContain("\u200B>");
    });

    it("neutralizes ordered list markers at line start", () => {
      expect(sanitizeForCodeFence("1. item")).toContain("\u200B1.");
      expect(sanitizeForCodeFence("42. item")).toContain("\u200B42.");
    });

    it("neutralizes horizontal rule patterns at line start", () => {
      expect(sanitizeForCodeFence("---")).toContain("\u200B");
      expect(sanitizeForCodeFence("***")).toContain("\u200B");
      expect(sanitizeForCodeFence("___")).toContain("\u200B");
    });

    it("preserves leading indentation before the markdown token", () => {
      // Indented list items still get the ZWS before the marker, not before the whitespace
      const result = sanitizeForCodeFence("  - item");
      expect(result).toContain("  \u200B-");
      expect(result).not.toContain("\u200B  -");
    });

    it("does not modify plain prose text", () => {
      const plain = "Just some plain text without markdown.";
      expect(sanitizeForCodeFence(plain)).toBe(plain);
    });

    it("handles multi-line input (each line sanitized independently)", () => {
      const input = "normal text\n# Heading\n- item\n> quote\nmore text";
      const result = sanitizeForCodeFence(input);
      const lines = result.split("\n");
      expect(lines[0]).toBe("normal text");
      expect(lines[1]).toContain("\u200B#");
      expect(lines[2]).toContain("\u200B-");
      expect(lines[3]).toContain("\u200B>");
      expect(lines[4]).toBe("more text");
    });
  });

  describe("extractRelayMessageText", () => {
    it("returns undefined for non-string, non-array input", () => {
      expect(extractRelayMessageText(null)).toBeUndefined();
      expect(extractRelayMessageText(undefined)).toBeUndefined();
      expect(extractRelayMessageText(42)).toBeUndefined();
      expect(extractRelayMessageText({})).toBeUndefined();
    });

    it("returns trimmed string for plain string input", () => {
      expect(extractRelayMessageText("  Hello world  ")).toBe("Hello world");
    });

    it("returns undefined for empty/whitespace string input", () => {
      expect(extractRelayMessageText("   ")).toBeUndefined();
      expect(extractRelayMessageText("")).toBeUndefined();
    });

    it("extracts text from content array with text blocks", () => {
      const content = [
        { type: "text", text: "Line one" },
        { type: "text", text: "Line two" },
      ];
      expect(extractRelayMessageText(content)).toBe("Line one\nLine two");
    });

    it("skips non-text blocks (e.g. tool_use blocks)", () => {
      const content = [
        { type: "text", text: "Commentary before tool call" },
        { type: "tool_use", id: "call_123", name: "exec", input: { command: "ls" } },
      ];
      expect(extractRelayMessageText(content)).toBe("Commentary before tool call");
    });

    it("strips downgraded [Tool Call:] text from string content", () => {
      const raw =
        'I will run a command.\n[Tool Call: exec (ID: call_123)]\nArguments: {"command": "ls -la"}\n';
      const result = extractRelayMessageText(raw);
      expect(result).not.toContain("[Tool Call:");
      expect(result).not.toContain('"command"');
      expect(result).toContain("I will run a command.");
    });

    it("strips downgraded [Tool Call:] text from text blocks in content array", () => {
      const content = [
        {
          type: "text",
          text: 'Checking files.\n[Tool Call: read (ID: call_456)]\nArguments: {"path": "/etc/hosts"}\n',
        },
      ];
      const result = extractRelayMessageText(content);
      expect(result).not.toContain("[Tool Call:");
      expect(result).not.toContain('"path"');
      expect(result).toContain("Checking files.");
    });

    it("returns undefined when all content is stripped downgraded tool calls", () => {
      const content = [
        {
          type: "text",
          text: '[Tool Call: exec (ID: call_789)]\nArguments: {"command": "whoami"}',
        },
      ];
      expect(extractRelayMessageText(content)).toBeUndefined();
    });
  });

  describe("renderRelayMessage spoiler markdown sanitization", () => {
    it("sanitizes markdown heading in tool result inside spoiler", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "agent",
        model: "anthropic/claude-sonnet-4-20250514",
        toolEntries: [
          {
            line: "[+0:01] 📖 read: /tmp/file.md",
            name: "read",
            resultText: "# Title\nSome content",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      // The result text inside the spoiler should have the heading neutralized
      const toolCallsSpoiler = msg.split("```spoiler Tool calls")[1];
      expect(toolCallsSpoiler).not.toMatch(/^# Title/m);
      expect(toolCallsSpoiler).toContain("\u200B#");
    });

    it("sanitizes unordered list in tool result inside spoiler", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "agent",
        model: "anthropic/claude-sonnet-4-20250514",
        toolEntries: [
          {
            line: "[+0:01] 🔧 exec: ls",
            name: "exec",
            resultText: "- file1.ts\n- file2.ts\n- file3.ts",
          },
        ],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 1,
        status: "ok",
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      const toolCallsSpoiler = msg.split("```spoiler Tool calls")[1];
      expect(toolCallsSpoiler).not.toMatch(/^- file/m);
      expect(toolCallsSpoiler).toContain("\u200B-");
    });

    it("sanitizes markdown heading in completion text inside Output spoiler", () => {
      const msg = renderRelayMessage({
        runId: "test-run",
        label: "research",
        model: "anthropic/claude-sonnet-4-20250514",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "ok",
        lastUpdatedAt: 5_000,
        completionText: "## Results\n- Item 1\n- Item 2\n> Note: done",
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });
      const outputSpoiler = msg.split("spoiler Output")[1];
      expect(outputSpoiler).not.toMatch(/^## Results/m);
      expect(outputSpoiler).not.toMatch(/^- Item/m);
      expect(outputSpoiler).not.toMatch(/^> Note/m);
      expect(outputSpoiler).toContain("\u200B##");
      expect(outputSpoiler).toContain("\u200B-");
      expect(outputSpoiler).toContain("\u200B>");
    });
  });
});
