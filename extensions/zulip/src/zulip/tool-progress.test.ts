import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => {
  return {
    zulipRequest: vi.fn(async () => ({ result: "success" })),
    zulipRequestWithRetry: vi.fn(async () => ({ result: "success", id: 12345 })),
  };
});

import type { ZulipAuth } from "./client.js";
import { zulipRequestWithRetry } from "./client.js";
import { formatClockTime, ToolProgressAccumulator } from "./tool-progress.js";

function makeAuth(): ZulipAuth {
  return {
    baseUrl: "https://zulip.example",
    email: "bot@zulip.example",
    apiKey: "fake-key",
  };
}

function makeAccumulator(overrides?: { log?: (m: string) => void; name?: string }) {
  return new ToolProgressAccumulator({
    auth: makeAuth(),
    stream: "test-stream",
    topic: "test-topic",
    name: overrides?.name,
    log: overrides?.log,
  });
}

describe("formatClockTime", () => {
  it("returns a formatted time string", () => {
    // Use a fixed date for determinism
    const ts = new Date("2026-02-22T19:58:00").getTime();
    const result = formatClockTime(ts);
    // Should contain hour and minute, e.g. "7:58 PM"
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });

  it("handles invalid timestamps gracefully", () => {
    const result = formatClockTime(NaN);
    // Should still return a time string (from Date.now() fallback)
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });
});

describe("ToolProgressAccumulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(zulipRequestWithRetry).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hasContent is false when empty", () => {
    const acc = makeAccumulator();
    expect(acc.hasContent).toBe(false);
    expect(acc.hasSentMessage).toBe(false);
  });

  it("hasContent is true after adding a line", () => {
    const acc = makeAccumulator();
    acc.addLine("🔧 exec: ls -la");
    expect(acc.hasContent).toBe(true);
  });

  it("sends a new message on first flush", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValueOnce({ result: "success", id: 999 });

    const acc = makeAccumulator({ name: "Marcel" });
    acc.addLine("🔧 exec: ls -la");
    await acc.flush();

    expect(zulipRequestWithRetry).toHaveBeenCalledTimes(1);
    const call = vi.mocked(zulipRequestWithRetry).mock.calls[0]![0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v1/messages");
    expect(call.form?.type).toBe("stream");
    expect(call.form?.to).toBe("test-stream");
    expect(call.form?.topic).toBe("test-topic");
    // Content should contain the tool line with a timestamp inside a spoiler
    const content = String(call.form?.content ?? "");
    expect(content).toContain("🔧 exec: ls -la");
    expect(content).toMatch(/\[\d{1,2}:\d{2}\s*(AM|PM)\]/);
    // Should have spoiler block
    expect(content).toContain("```spoiler Tool calls");
    expect(content).toMatch(/```$/);
    // Should have header with name and count
    expect(content).toContain("🛠️ **`Marcel`**");
    expect(content).toContain("1 tool call");
    expect(content).toContain("updated");
    expect(acc.hasSentMessage).toBe(true);
    expect(acc.sentMessageId).toBe(999);
  });

  it("edits the message on subsequent flushes", async () => {
    vi.mocked(zulipRequestWithRetry)
      .mockResolvedValueOnce({ result: "success", id: 999 }) // send
      .mockResolvedValueOnce({ result: "success" }); // edit

    const acc = makeAccumulator({ name: "Marcel" });
    acc.addLine("🔧 exec: ls -la");
    await acc.flush();

    acc.addLine("📖 read: /path/to/file.ts");
    await acc.flush();

    expect(zulipRequestWithRetry).toHaveBeenCalledTimes(2);
    const editCall = vi.mocked(zulipRequestWithRetry).mock.calls[1]![0];
    expect(editCall.method).toBe("PATCH");
    expect(editCall.path).toBe("/api/v1/messages/999");
    const content = String(editCall.form?.content ?? "");
    expect(content).toContain("🔧 exec: ls -la");
    expect(content).toContain("📖 read: /path/to/file.ts");
    // Header should show updated count
    expect(content).toContain("2 tool calls");
  });

  it("debounces rapid edits", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 100 });

    const acc = makeAccumulator();
    acc.addLine("🔧 exec: cmd1");
    acc.addLine("🔧 exec: cmd2");
    acc.addLine("🔧 exec: cmd3");

    // No API calls yet (debouncing)
    expect(zulipRequestWithRetry).not.toHaveBeenCalled();

    // Advance past debounce interval
    await vi.advanceTimersByTimeAsync(400);

    // Should have sent ONE message with all three lines
    expect(zulipRequestWithRetry).toHaveBeenCalledTimes(1);
    const content = String(vi.mocked(zulipRequestWithRetry).mock.calls[0]![0].form?.content ?? "");
    expect(content).toContain("cmd1");
    expect(content).toContain("cmd2");
    expect(content).toContain("cmd3");
    // Header should show 3 tool calls
    expect(content).toContain("3 tool calls");
  });

  it("finalize cancels debounce and does a final flush", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 200 });

    const acc = makeAccumulator();
    acc.addLine("🔧 exec: cmd1");
    // Don't wait for debounce

    await acc.finalize();

    expect(zulipRequestWithRetry).toHaveBeenCalledTimes(1);
    expect(acc.hasContent).toBe(true);
  });

  it("ignores addLine after finalization", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 200 });

    const acc = makeAccumulator();
    acc.addLine("🔧 exec: cmd1");
    await acc.finalize();

    const callCount = vi.mocked(zulipRequestWithRetry).mock.calls.length;
    acc.addLine("🔧 exec: cmd2");
    // No additional flush should be triggered
    await vi.advanceTimersByTimeAsync(1000);
    expect(zulipRequestWithRetry).toHaveBeenCalledTimes(callCount);
  });

  it("does nothing when finalized with no content", async () => {
    const acc = makeAccumulator();
    await acc.finalize();
    expect(zulipRequestWithRetry).not.toHaveBeenCalled();
  });

  it("dispose cancels pending flush without sending", async () => {
    const acc = makeAccumulator();
    acc.addLine("🔧 exec: cmd1");
    acc.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(zulipRequestWithRetry).not.toHaveBeenCalled();
  });

  it("logs errors on flush failure", async () => {
    vi.mocked(zulipRequestWithRetry).mockRejectedValueOnce(new Error("network error"));
    const log = vi.fn();

    const acc = makeAccumulator({ log });
    acc.addLine("🔧 exec: failing-cmd");
    await acc.flush();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("tool progress flush failed"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network error"));
  });

  it("multiple lines each get a timestamp prefix inside spoiler", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 300 });

    const acc = makeAccumulator({ name: "TestBot" });
    acc.addLine("🔧 exec: cmd1");
    acc.addLine("📖 read: file.ts");
    await acc.flush();

    const content = String(vi.mocked(zulipRequestWithRetry).mock.calls[0]![0].form?.content ?? "");
    // Extract lines inside the spoiler block
    const spoilerMatch = content.match(/```spoiler Tool calls\n([\s\S]*?)\n```/);
    expect(spoilerMatch).not.toBeNull();
    const spoilerContent = spoilerMatch![1]!;
    const lines = spoilerContent.split("\n");
    expect(lines).toHaveLength(2);
    // Each line starts with a timestamp
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{1,2}:\d{2}\s*(AM|PM)\]/);
    }
  });

  it("uses 'Agent' as default name when none provided", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 400 });

    const acc = makeAccumulator();
    acc.addLine("🔧 exec: test");
    await acc.flush();

    const content = String(vi.mocked(zulipRequestWithRetry).mock.calls[0]![0].form?.content ?? "");
    expect(content).toContain("**`Agent`**");
  });

  it("sanitizes triple backticks in tool lines", async () => {
    vi.mocked(zulipRequestWithRetry).mockResolvedValue({ result: "success", id: 500 });

    const acc = makeAccumulator({ name: "Marcel" });
    acc.addLine("🔧 exec: echo ```hello```");
    await acc.flush();

    const content = String(vi.mocked(zulipRequestWithRetry).mock.calls[0]![0].form?.content ?? "");
    // The spoiler block should not be broken by the backticks in the tool line.
    // The sanitizer inserts zero-width spaces between consecutive backticks.
    const spoilerMatch = content.match(/```spoiler Tool calls\n([\s\S]*?)\n```$/);
    expect(spoilerMatch).not.toBeNull();
    // The inner content should NOT contain raw triple backticks
    const inner = spoilerMatch![1]!;
    expect(inner).not.toMatch(/`{3}/);
  });
});
