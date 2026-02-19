import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKeepaliveMessageContent,
  createBestEffortShutdownNoticeSender,
  startPeriodicKeepalive,
} from "./monitor.js";

describe("monitor keepalive + shutdown helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends periodic keepalives after the initial delay", async () => {
    vi.useFakeTimers();

    const sendPing = vi.fn().mockResolvedValue(undefined);
    const stop = startPeriodicKeepalive({
      sendPing,
      initialDelayMs: 25_000,
      repeatIntervalMs: 60_000,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(sendPing).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendPing).toHaveBeenCalledTimes(1);
    expect(sendPing).toHaveBeenNthCalledWith(1, 25_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendPing).toHaveBeenCalledTimes(2);
    expect(sendPing).toHaveBeenNthCalledWith(2, 85_000);

    stop();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(sendPing).toHaveBeenCalledTimes(2);
  });

  it("builds concise keepalive copy with elapsed time", () => {
    expect(buildKeepaliveMessageContent(29_000)).toBe("🔧 Still working... (29s elapsed)");
    expect(buildKeepaliveMessageContent(120_000)).toBe("🔧 Still working... (2m elapsed)");
  });

  it("sends shutdown notice once and swallows errors", async () => {
    const sendNotice = vi.fn().mockRejectedValue(new Error("boom"));
    const log = vi.fn();

    const sendShutdownNoticeOnce = createBestEffortShutdownNoticeSender({ sendNotice, log });

    expect(() => {
      sendShutdownNoticeOnce();
      sendShutdownNoticeOnce();
    }).not.toThrow();

    await Promise.resolve();

    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("shutdown notice failed"));
  });
});
