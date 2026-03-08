import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sweepAutoArchive,
  scheduleSyncForList,
  registerSyncCallback,
  _resetLifecycleForTests,
  DEBOUNCE_MS,
  MAX_COALESCE_MS,
  AUTO_ARCHIVE_DELAY_MS,
} from "./todo-lifecycle.js";
import { _resetForTests as resetState, createList, addItem, completeItem } from "./todo-state.js";

// Mock persistence and runtime.
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-todo-lifecycle",
}));

vi.mock("../infra/json-file.js", () => {
  let stored: unknown = undefined;
  return {
    loadJsonFile: () => stored,
    saveJsonFile: (_path: string, data: unknown) => {
      stored = data;
    },
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

describe("todo-lifecycle", () => {
  beforeEach(() => {
    resetState();
    _resetLifecycleForTests();
  });

  afterEach(() => {
    resetState();
    _resetLifecycleForTests();
  });

  describe("sweepAutoArchive", () => {
    it("does not archive lists with active items", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      await addItem(list.id, { title: "Active" });

      const archived = sweepAutoArchive(Date.now() + AUTO_ARCHIVE_DELAY_MS + 1);
      expect(archived).toEqual([]);
    });

    it("does not archive if updated recently", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Task" });
      await completeItem(list.id, item.id);

      // Sweep at the same time - should not archive (needs 1h).
      const archived = sweepAutoArchive(Date.now());
      expect(archived).toEqual([]);
    });

    it("archives lists where all items done for >1 hour", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Task" });
      await completeItem(list.id, item.id);

      // Sweep with time advanced past auto-archive delay.
      const archived = sweepAutoArchive(Date.now() + AUTO_ARCHIVE_DELAY_MS + 1);
      expect(archived).toContain(list.id);
    });

    it("skips empty lists", async () => {
      await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const archived = sweepAutoArchive(Date.now() + AUTO_ARCHIVE_DELAY_MS + 1);
      expect(archived).toEqual([]);
    });
  });

  describe("sync debounce", () => {
    it("debounces rapid sync calls", async () => {
      const syncCb = vi.fn().mockResolvedValue(undefined);
      registerSyncCallback(syncCb);

      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      // Set a backing message ID so sync actually fires.
      const { setBackingMessageId } = await import("./todo-state.js");
      setBackingMessageId(list.id, "msg-1");

      // Schedule 3 syncs in rapid succession.
      scheduleSyncForList(list.id);
      scheduleSyncForList(list.id);
      scheduleSyncForList(list.id);

      // Immediately after scheduling, callback should not have fired.
      expect(syncCb).not.toHaveBeenCalled();

      // Wait for debounce to expire.
      await vi.waitFor(
        () => {
          expect(syncCb).toHaveBeenCalledTimes(1);
        },
        { timeout: DEBOUNCE_MS + 500 },
      );
    });

    it("forces sync after max coalesce time", async () => {
      const syncCb = vi.fn().mockResolvedValue(undefined);
      registerSyncCallback(syncCb);

      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const { setBackingMessageId } = await import("./todo-state.js");
      setBackingMessageId(list.id, "msg-1");

      // Schedule a sync, then keep re-scheduling faster than DEBOUNCE_MS.
      scheduleSyncForList(list.id);

      // Simulate rapid re-schedules up to MAX_COALESCE_MS.
      const start = Date.now();
      const interval = setInterval(() => {
        if (Date.now() - start > MAX_COALESCE_MS + 500) {
          clearInterval(interval);
          return;
        }
        scheduleSyncForList(list.id);
      }, 100);

      // Wait for the forced sync to fire.
      await vi.waitFor(
        () => {
          expect(syncCb).toHaveBeenCalled();
        },
        { timeout: MAX_COALESCE_MS + 2000 },
      );

      clearInterval(interval);
    });

    it("does not fire sync without a callback registered", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const { setBackingMessageId } = await import("./todo-state.js");
      setBackingMessageId(list.id, "msg-1");

      // No callback registered - should not throw.
      scheduleSyncForList(list.id);

      // Wait for debounce to expire.
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      // No error should occur.
    });
  });
});
