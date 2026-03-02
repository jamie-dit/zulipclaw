import { describe, expect, it } from "vitest";
import {
  countToolCallsFromHistory,
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

    it("renders Thoughts history below Tool calls with local timestamps and newest last", () => {
      const longThoughtLine = `${"A".repeat(180)} tail-marker`;
      const thoughtTsA = Date.UTC(2026, 2, 2, 14, 31, 0);
      const thoughtTsB = Date.UTC(2026, 2, 2, 14, 32, 0);
      const expectedA = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(thoughtTsA));
      const expectedB = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(thoughtTsB));

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
            ts: thoughtTsA,
          },
          { text: longThoughtLine, ts: thoughtTsB },
        ],
        lastUpdatedAt: 5_000,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      const toolCallsIdx = msg.indexOf("```spoiler Tool calls");
      const thoughtsIdx = msg.indexOf("```spoiler Thoughts");
      const firstThoughtIdx = msg.indexOf(
        `> [${expectedA}] Analyzing the file structure to determine the safest patch path.`,
      );
      const secondThoughtIdx = msg.indexOf(`> [${expectedB}] ${longThoughtLine}`);

      expect(toolCallsIdx).toBeGreaterThanOrEqual(0);
      expect(thoughtsIdx).toBeGreaterThan(toolCallsIdx);
      expect(firstThoughtIdx).toBeGreaterThan(thoughtsIdx);
      expect(secondThoughtIdx).toBeGreaterThan(firstThoughtIdx);
      expect(msg).toContain("tail-marker");
      expect(msg).not.toContain("_💭");
    });

    it("falls back to an empty Thoughts placeholder when no thought is captured", () => {
      const msg = renderRelayMessage({
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

      expect(msg).toContain("```spoiler Thoughts");
      expect(msg).toContain("> _(no thoughts yet)_");
    });

    it("renders legacy currentThought fallback with a local timestamp prefix", () => {
      const lastUpdatedAt = Date.UTC(2026, 2, 2, 15, 10, 0);
      const expected = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(lastUpdatedAt));

      const msg = renderRelayMessage({
        runId: "test-run",
        label: "legacy-thought",
        model: "anthropic/claude-opus-4-6",
        toolEntries: [],
        pendingToolCallIds: new Map(),
        startedAt: 1_000,
        toolCount: 0,
        status: "running",
        currentThought: "legacy captured thought",
        lastUpdatedAt,
        deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      });

      expect(msg).toContain(`> [${expected}] legacy captured thought`);
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
});
