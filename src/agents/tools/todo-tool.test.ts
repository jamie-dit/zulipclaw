import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetLifecycleForTests } from "../todo-lifecycle.js";
import { _resetForTests } from "../todo-state.js";
import { createTodoTool } from "./todo-tool.js";

// Mock persistence.
vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-todo-tool",
}));

vi.mock("../../infra/json-file.js", () => {
  let stored: unknown = undefined;
  return {
    loadJsonFile: () => stored,
    saveJsonFile: (_path: string, data: unknown) => {
      stored = data;
    },
  };
});

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("todo-tool", () => {
  const mainTool = createTodoTool({ agentSessionKey: "main-session" });
  const subTool = createTodoTool({ agentSessionKey: "sub-agent-1" });

  beforeEach(() => {
    _resetForTests();
    _resetLifecycleForTests();
  });

  afterEach(() => {
    _resetForTests();
    _resetLifecycleForTests();
  });

  async function exec(tool: typeof mainTool, params: Record<string, unknown>) {
    const result = await tool.execute("call-1", params);
    return parseResult(result as { content: Array<{ text: string }> });
  }

  describe("create action", () => {
    it("creates a new todo list", async () => {
      const result = await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Sprint Tasks",
      });
      expect(result.ok).toBe(true);
      expect(result.action).toBe("create");
      expect(result.list.title).toBe("Sprint Tasks");
      expect(result.list.itemCount).toBe(0);
    });

    it("rejects duplicate active list for same topic", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "First",
      });
      await expect(
        exec(mainTool, {
          action: "create",
          topicKey: "stream:test#topic",
          title: "Second",
        }),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe("add action", () => {
    it("adds an item to a list", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const result = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Do something",
        notes: "Important",
      });
      expect(result.ok).toBe(true);
      expect(result.item.title).toBe("Do something");
      expect(result.item.status).toBe("pending");
    });

    it("sub-agent cannot add items", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const result = await exec(subTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Sub-agent task",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Only the list owner");
    });
  });

  describe("update action", () => {
    it("owner can update any item", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
        assignee: "sub-agent-1",
      });
      const result = await exec(mainTool, {
        action: "update",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
        status: "in-progress",
      });
      expect(result.ok).toBe(true);
      expect(result.item.status).toBe("in-progress");
    });

    it("sub-agent can update their assigned item", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
        assignee: "sub-agent-1",
      });
      const result = await exec(subTool, {
        action: "update",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
        notes: "Working on it",
      });
      expect(result.ok).toBe(true);
      expect(result.item.notes).toBe("Working on it");
    });

    it("sub-agent cannot update unassigned items", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
      });
      const result = await exec(subTool, {
        action: "update",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
        notes: "Not my task",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Sub-agents can only");
    });
  });

  describe("complete action", () => {
    it("completes an item", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
      });
      const result = await exec(mainTool, {
        action: "complete",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
        notes: "Done!",
      });
      expect(result.ok).toBe(true);
      expect(result.item.status).toBe("done");
    });
  });

  describe("delete action", () => {
    it("deletes an item", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
      });
      const result = await exec(mainTool, {
        action: "delete",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
      });
      expect(result.ok).toBe(true);
      expect(result.itemId).toBe(addResult.item.id);
    });

    it("sub-agent cannot delete items", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Task A",
      });
      const result = await exec(subTool, {
        action: "delete",
        topicKey: "stream:test#topic",
        itemId: addResult.item.id,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Only the list owner");
    });
  });

  describe("archive action", () => {
    it("archives a list", async () => {
      const createResult = await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const result = await exec(mainTool, {
        action: "archive",
        listId: createResult.list.id,
      });
      expect(result.ok).toBe(true);
      expect(result.list.archived).toBe(true);
    });

    it("sub-agent cannot archive", async () => {
      const createResult = await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      const result = await exec(subTool, {
        action: "archive",
        listId: createResult.list.id,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Only the list owner");
    });
  });

  describe("list action", () => {
    it("lists all active lists", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic1",
        title: "Tasks 1",
      });
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic2",
        title: "Tasks 2",
      });
      const result = await exec(mainTool, { action: "list" });
      expect(result.ok).toBe(true);
      expect(result.lists).toHaveLength(2);
    });

    it("lists items for a specific topic", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Item A",
      });
      const result = await exec(mainTool, {
        action: "list",
        topicKey: "stream:test#topic",
      });
      expect(result.ok).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.render).toContain("Item A");
    });

    it("returns empty for unknown topic", async () => {
      const result = await exec(mainTool, {
        action: "list",
        topicKey: "stream:unknown#topic",
      });
      expect(result.ok).toBe(true);
      expect(result.lists).toEqual([]);
    });

    it("resolves list by topicKey for add/update", async () => {
      await exec(mainTool, {
        action: "create",
        topicKey: "stream:test#topic",
        title: "Tasks",
      });
      // Add using topicKey (no explicit listId).
      const addResult = await exec(mainTool, {
        action: "add",
        topicKey: "stream:test#topic",
        title: "Auto-resolved",
      });
      expect(addResult.ok).toBe(true);
      expect(addResult.item.title).toBe("Auto-resolved");
    });
  });
});
