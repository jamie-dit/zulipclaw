import { describe, expect, it, afterEach } from "vitest";
import {
  withSessionWriteLock,
  getSessionWriteLockCount,
  resetSessionWriteLocksForTest,
} from "./session-write-lock.js";

afterEach(() => {
  resetSessionWriteLocksForTest();
});

describe("session write lock", () => {
  it("serializes concurrent writes to the same session key", async () => {
    const order: number[] = [];

    const write1 = withSessionWriteLock("session-a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return "first";
    });

    const write2 = withSessionWriteLock("session-a", async () => {
      order.push(2);
      return "second";
    });

    const [result1, result2] = await Promise.all([write1, write2]);

    expect(result1).toBe("first");
    expect(result2).toBe("second");
    // write1 must complete before write2 starts
    expect(order).toEqual([1, 2]);
  });

  it("allows parallel writes to different session keys", async () => {
    const order: string[] = [];

    const writeA = withSessionWriteLock("session-a", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("a");
    });

    const writeB = withSessionWriteLock("session-b", async () => {
      order.push("b");
    });

    await Promise.all([writeA, writeB]);

    // b should complete before a (no serialization between different keys)
    expect(order).toEqual(["b", "a"]);
  });

  it("continues even if a previous write rejects", async () => {
    const write1 = withSessionWriteLock("session-a", async () => {
      throw new Error("boom");
    });

    await expect(write1).rejects.toThrow("boom");

    const result = await withSessionWriteLock("session-a", async () => {
      return "recovered";
    });

    expect(result).toBe("recovered");
  });

  it("tracks lock count", async () => {
    expect(getSessionWriteLockCount()).toBe(0);

    const p = withSessionWriteLock("session-a", async () => {
      return 42;
    });

    // Lock is registered immediately
    expect(getSessionWriteLockCount()).toBe(1);

    await p;
    // After completion, lock chain still exists (as a resolved promise)
    expect(getSessionWriteLockCount()).toBe(1);

    resetSessionWriteLocksForTest();
    expect(getSessionWriteLockCount()).toBe(0);
  });
});
