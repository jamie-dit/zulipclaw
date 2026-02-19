import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDispatcherIdleWithTimeout } from "./monitor.js";

describe("waitForDispatcherIdleWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when dispatcher becomes idle before timeout", async () => {
    vi.useFakeTimers();

    const onTimeout = vi.fn();
    const waitForIdle = vi.fn(async () => {
      await Promise.resolve();
    });

    await waitForDispatcherIdleWithTimeout({ waitForIdle, timeoutMs: 100, onTimeout });

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("continues cleanup after timeout when dispatcher never becomes idle", async () => {
    vi.useFakeTimers();

    const onTimeout = vi.fn();
    const waitForIdle = vi.fn(() => new Promise<void>(() => {}));

    const pending = waitForDispatcherIdleWithTimeout({ waitForIdle, timeoutMs: 100, onTimeout });

    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
