import { describe, expect, it } from "vitest";
import { renderCompact, renderBackingMessage } from "./todo-render.js";
import type { TodoList } from "./todo-state.js";

function makeTodoList(overrides?: Partial<TodoList>): TodoList {
  return {
    id: "list-1",
    topicKey: "stream:test#topic",
    title: "Sprint Tasks",
    ownerSessionKey: "main",
    items: [],
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("todo-render", () => {
  describe("renderCompact", () => {
    it("renders an empty list", () => {
      const list = makeTodoList();
      const result = renderCompact(list);
      expect(result).toContain("📋 Sprint Tasks (0/0 done)");
      expect(result).toContain("No items yet");
    });

    it("renders items with status emoji", () => {
      const list = makeTodoList({
        items: [
          {
            id: "i1",
            title: "Set up CI",
            status: "done",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: "i2",
            title: "Write tests",
            status: "in-progress",
            assignee: "sub-abc",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: "i3",
            title: "Deploy",
            status: "pending",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = renderCompact(list);
      expect(result).toContain("1/3 done");
      expect(result).toContain("✅ Set up CI");
      expect(result).toContain("🔄 Write tests _(sub-abc)_");
      expect(result).toContain("⬜ Deploy");
    });

    it("renders blocked and cancelled items", () => {
      const list = makeTodoList({
        items: [
          {
            id: "i1",
            title: "Blocked task",
            status: "blocked",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: "i2",
            title: "Cancelled task",
            status: "cancelled",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = renderCompact(list);
      expect(result).toContain("🚫 Blocked task");
      expect(result).toContain("❌ Cancelled task");
    });
  });

  describe("renderBackingMessage", () => {
    it("renders an empty list", () => {
      const list = makeTodoList();
      const result = renderBackingMessage(list);
      expect(result).toContain("## 📋 Sprint Tasks");
      expect(result).toContain("0/0");
      expect(result).toContain("No items yet");
    });

    it("renders a table with items", () => {
      const list = makeTodoList({
        items: [
          {
            id: "i1",
            title: "Task A",
            status: "pending",
            notes: "First task",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: "i2",
            title: "Task B",
            status: "done",
            assignee: "sub-1",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = renderBackingMessage(list);
      expect(result).toContain("| Status | Item | Assignee | Notes |");
      expect(result).toContain("| ⬜ | Task A | - | First task |");
      expect(result).toContain("Completed:");
      expect(result).toContain("| ✅ | Task B | sub-1 | - |");
      expect(result).toContain("Last updated:");
    });

    it("escapes pipe characters in cell values", () => {
      const list = makeTodoList({
        items: [
          {
            id: "i1",
            title: "Task | with pipe",
            status: "pending",
            notes: "note | here",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = renderBackingMessage(list);
      expect(result).toContain("Task \\| with pipe");
      expect(result).toContain("note \\| here");
    });

    it("truncates long notes", () => {
      const longNote = "x".repeat(100);
      const list = makeTodoList({
        items: [
          {
            id: "i1",
            title: "Task",
            status: "pending",
            notes: longNote,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = renderBackingMessage(list);
      // Note should be truncated to ~60 chars.
      expect(result).toContain("...");
      // The full 100-char string should not appear.
      expect(result).not.toContain(longNote);
    });
  });
});
