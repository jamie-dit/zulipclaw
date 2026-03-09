import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _flushPersistForTests,
  _resetForTests,
  addItem,
  archiveList,
  checkOwnership,
  completeItem,
  createList,
  deleteItem,
  findActiveListByTopic,
  getAllLists,
  getList,
  hasActiveListsWithPendingItems,
  loadFromDisk,
  recoverAfterRestart,
  setBackingMessageId,
  summariseList,
  updateItem,
} from "./todo-state.js";

// Mock persistence so tests don't hit disk.
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-todo",
}));

vi.mock("../infra/json-file.js", () => {
  let stored: unknown = undefined;
  return {
    loadJsonFile: () => stored,
    saveJsonFile: (_path: string, data: unknown) => {
      stored = data;
    },
    _getStored: () => stored,
    _setStored: (v: unknown) => {
      stored = v;
    },
  };
});

describe("todo-state", () => {
  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  describe("createList", () => {
    it("creates a new list for a topic", async () => {
      const list = await createList({
        topicKey: "stream:test#topic",
        title: "Sprint tasks",
        ownerSessionKey: "main-session",
      });
      expect(list.id).toBeTruthy();
      expect(list.title).toBe("Sprint tasks");
      expect(list.topicKey).toBe("stream:test#topic");
      expect(list.ownerSessionKey).toBe("main-session");
      expect(list.items).toEqual([]);
      expect(list.archived).toBe(false);
    });

    it("rejects creating a second active list for the same topic", async () => {
      await createList({
        topicKey: "stream:test#topic",
        title: "First",
        ownerSessionKey: "main",
      });
      await expect(
        createList({
          topicKey: "stream:test#topic",
          title: "Second",
          ownerSessionKey: "main",
        }),
      ).rejects.toThrow(/already exists/);
    });

    it("allows creating a new list after archiving the old one", async () => {
      const first = await createList({
        topicKey: "stream:test#topic",
        title: "First",
        ownerSessionKey: "main",
      });
      await archiveList(first.id);
      const second = await createList({
        topicKey: "stream:test#topic",
        title: "Second",
        ownerSessionKey: "main",
      });
      expect(second.id).not.toBe(first.id);
    });
  });

  describe("addItem", () => {
    it("adds an item to a list", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Do something" });
      expect(item.title).toBe("Do something");
      expect(item.status).toBe("pending");

      const updated = getList(list.id);
      expect(updated?.items).toHaveLength(1);
    });

    it("rejects adding to an archived list", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      await archiveList(list.id);
      await expect(addItem(list.id, { title: "Nope" })).rejects.toThrow(/archived/);
    });

    it("rejects adding to a non-existent list", async () => {
      await expect(addItem("fake-id", { title: "Nope" })).rejects.toThrow(/not found/);
    });
  });

  describe("updateItem", () => {
    it("updates item fields", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Task" });
      const updated = await updateItem(list.id, item.id, {
        status: "in-progress",
        notes: "Working on it",
      });
      expect(updated.status).toBe("in-progress");
      expect(updated.notes).toBe("Working on it");
      expect(updated.title).toBe("Task");
    });

    it("rejects updating a non-existent item", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      await expect(updateItem(list.id, "fake-item", { status: "done" })).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe("completeItem", () => {
    it("marks an item as done", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Task" });
      const completed = await completeItem(list.id, item.id, "All done!");
      expect(completed.status).toBe("done");
      expect(completed.notes).toBe("All done!");
    });
  });

  describe("deleteItem", () => {
    it("removes an item from the list", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, { title: "Task" });
      await deleteItem(list.id, item.id);
      expect(getList(list.id)?.items).toHaveLength(0);
    });
  });

  describe("archiveList", () => {
    it("archives a list", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const archived = await archiveList(list.id);
      expect(archived.archived).toBe(true);
    });

    it("rejects double-archiving", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      await archiveList(list.id);
      await expect(archiveList(list.id)).rejects.toThrow(/already archived/);
    });
  });

  describe("findActiveListByTopic", () => {
    it("finds the active list for a topic", async () => {
      const list = await createList({
        topicKey: "stream:test#topic",
        title: "T",
        ownerSessionKey: "main",
      });
      const found = findActiveListByTopic("stream:test#topic");
      expect(found?.id).toBe(list.id);
    });

    it("returns undefined for an archived topic", async () => {
      const list = await createList({
        topicKey: "stream:test#topic",
        title: "T",
        ownerSessionKey: "main",
      });
      await archiveList(list.id);
      expect(findActiveListByTopic("stream:test#topic")).toBeUndefined();
    });
  });

  describe("summariseList", () => {
    it("returns a summary with counts", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      await addItem(list.id, { title: "A" });
      const item2 = await addItem(list.id, { title: "B" });
      await completeItem(list.id, item2.id);

      const summary = summariseList(getList(list.id)!);
      expect(summary.itemCount).toBe(2);
      expect(summary.doneCount).toBe(1);
    });
  });

  describe("checkOwnership", () => {
    it("allows owner to do everything", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      expect(checkOwnership(list, "main", "add").allowed).toBe(true);
      expect(checkOwnership(list, "main", "delete").allowed).toBe(true);
      expect(checkOwnership(list, "main", "update").allowed).toBe(true);
    });

    it("blocks sub-agent from adding", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const result = checkOwnership(list, "sub-agent-1", "add");
      expect(result.allowed).toBe(false);
    });

    it("allows sub-agent to update their assigned item", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, {
        title: "Task",
        assignee: "sub-agent-1",
      });
      const result = checkOwnership(getList(list.id)!, "sub-agent-1", "update", item.id);
      expect(result.allowed).toBe(true);
    });

    it("blocks sub-agent from updating unassigned item", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, {
        title: "Task",
        assignee: "sub-agent-2",
      });
      const result = checkOwnership(getList(list.id)!, "sub-agent-1", "update", item.id);
      expect(result.allowed).toBe(false);
    });
  });

  describe("recoverAfterRestart", () => {
    it("marks orphaned in-progress items as blocked", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, {
        title: "Working",
        assignee: "dead-session",
      });
      await updateItem(list.id, item.id, { status: "in-progress" });

      const recovered = recoverAfterRestart(new Set(["main"]));
      expect(recovered).toBe(1);

      const updatedItem = getList(list.id)!.items[0];
      expect(updatedItem.status).toBe("blocked");
      expect(updatedItem.notes).toContain("status unknown after restart");
    });

    it("does not touch items with active assignees", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      const item = await addItem(list.id, {
        title: "Working",
        assignee: "active-session",
      });
      await updateItem(list.id, item.id, { status: "in-progress" });

      const recovered = recoverAfterRestart(new Set(["main", "active-session"]));
      expect(recovered).toBe(0);
    });
  });

  describe("persistence round-trip", () => {
    it("persists and reloads state", async () => {
      await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });

      // Flush debounced persist before round-trip.
      _flushPersistForTests();

      // Reset in-memory and reload from "disk" (mocked).
      const allBefore = getAllLists();
      expect(allBefore).toHaveLength(1);

      _resetForTests();
      expect(getAllLists()).toHaveLength(0);

      loadFromDisk();
      const allAfter = getAllLists();
      expect(allAfter).toHaveLength(1);
      expect(allAfter[0].title).toBe("T");
    });
  });

  describe("setBackingMessageId", () => {
    it("sets the backing message ID on a list", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });
      setBackingMessageId(list.id, "zulip-msg-123");
      expect(getList(list.id)?.backingMessageId).toBe("zulip-msg-123");
    });
  });

  describe("concurrent mutations", () => {
    it("handles concurrent adds without losing items", async () => {
      const list = await createList({
        topicKey: "t",
        title: "T",
        ownerSessionKey: "main",
      });

      // Fire multiple concurrent adds.
      const results = await Promise.all([
        addItem(list.id, { title: "A" }),
        addItem(list.id, { title: "B" }),
        addItem(list.id, { title: "C" }),
      ]);

      expect(results).toHaveLength(3);
      expect(getList(list.id)?.items).toHaveLength(3);
    });
  });

  describe("hasActiveListsWithPendingItems", () => {
    it("returns false when no lists exist", () => {
      expect(hasActiveListsWithPendingItems()).toBe(false);
    });

    it("returns false for empty lists", async () => {
      await createList({ topicKey: "t", title: "T", ownerSessionKey: "main" });
      expect(hasActiveListsWithPendingItems()).toBe(false);
    });

    it("returns true when a list has pending items", async () => {
      const list = await createList({ topicKey: "t", title: "T", ownerSessionKey: "main" });
      await addItem(list.id, { title: "Task" });
      expect(hasActiveListsWithPendingItems()).toBe(true);
    });

    it("returns true when a list has in-progress items", async () => {
      const list = await createList({ topicKey: "t", title: "T", ownerSessionKey: "main" });
      const item = await addItem(list.id, { title: "Task" });
      await updateItem(list.id, item.id, { status: "in-progress" });
      expect(hasActiveListsWithPendingItems()).toBe(true);
    });

    it("returns false when all items are done", async () => {
      const list = await createList({ topicKey: "t", title: "T", ownerSessionKey: "main" });
      const item = await addItem(list.id, { title: "Task" });
      await completeItem(list.id, item.id);
      expect(hasActiveListsWithPendingItems()).toBe(false);
    });

    it("returns false for archived lists with pending items", async () => {
      const list = await createList({ topicKey: "t", title: "T", ownerSessionKey: "main" });
      await addItem(list.id, { title: "Task" });
      await archiveList(list.id);
      expect(hasActiveListsWithPendingItems()).toBe(false);
    });
  });
});
