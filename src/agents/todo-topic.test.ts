import { describe, expect, it, beforeEach, vi } from "vitest";
import { _resetLifecycleForTests, scheduleSyncForList, DEBOUNCE_MS } from "./todo-lifecycle.js";
import { _resetForTests, createList, addItem, setBackingMessageId, getList } from "./todo-state.js";
import {
  getTodoTopicKey,
  getActiveTodoSnapshot,
  initializeTodoTopicSupport,
  maybeApplyTodoProgressFromSubagent,
  syncTodoBackingMessage,
  _resetTopicForTests,
} from "./todo-topic.js";

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-todo-topic",
}));

vi.mock("../infra/json-file.js", () => ({
  loadJsonFile: () => undefined,
  saveJsonFile: () => undefined,
}));

// Mock returns the real AgentToolResult<unknown> shape: { content: [...], details: { messageId } }
let sendCounter = 0;
const mockDispatch = vi.fn(async ({ action }: { action: string }) => {
  if (action === "send") {
    sendCounter++;
    return {
      content: [
        {
          type: "text",
          text: `{"ok":true,"action":"send","messageId":"backing-msg-${sendCounter}"}`,
        },
      ],
      details: { ok: true, action: "send", messageId: `backing-msg-${sendCounter}` },
    };
  }
  return {
    content: [{ type: "text", text: '{"ok":true}' }],
    details: { ok: true },
  };
});

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) => mockDispatch(args[0] as { action: string }),
}));

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));

describe("todo-topic", () => {
  beforeEach(() => {
    _resetForTests();
    _resetLifecycleForTests();
    _resetTopicForTests();
    sendCounter = 0;
    mockDispatch.mockClear();
  });

  it("derives topic key from session key", () => {
    expect(
      getTodoTopicKey({
        sessionKey: "agent:main:zulip:channel:marcel-zulipclaw#todo list tracking",
      }),
    ).toBe("stream:marcel-zulipclaw#todo list tracking");
  });

  it("applies subagent ack/progress events to assigned item", async () => {
    const list = await createList({
      topicKey: "stream:marcel-zulipclaw#todo list tracking",
      title: "Board",
      ownerSessionKey: "main",
    });
    const item = await addItem(list.id, { title: "Implement", assignee: "agent:sub:1" });

    const result = await maybeApplyTodoProgressFromSubagent({
      sessionKey: "agent:sub:1",
      agentTo: "stream:marcel-zulipclaw#todo list tracking",
      text: `done\n\n\`\`\`json\n${JSON.stringify({ type: "todo_progress", itemId: item.id, status: "in-progress", notes: "working" })}\n\`\`\``,
    });

    expect(result.applied).toBe(true);
    expect(result.summary).toContain("working");
  });

  it("rejects subagent progress for items not assigned to them", async () => {
    const list = await createList({
      topicKey: "stream:marcel-zulipclaw#todo list tracking",
      title: "Board",
      ownerSessionKey: "main",
    });
    const item = await addItem(list.id, { title: "Implement", assignee: "agent:sub:1" });

    // Sub-agent 2 tries to modify sub-agent 1's item by specifying its ID
    const result = await maybeApplyTodoProgressFromSubagent({
      sessionKey: "agent:sub:2",
      agentTo: "stream:marcel-zulipclaw#todo list tracking",
      text: `done\n\n\`\`\`json\n${JSON.stringify({ type: "todo_progress", itemId: item.id, status: "done", notes: "hijacked" })}\n\`\`\``,
    });

    expect(result.applied).toBe(false);
  });

  describe("backing message creation", () => {
    it("creates a backing message with real content (no placeholder)", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Test Board",
        ownerSessionKey: "main",
      });

      await syncTodoBackingMessage(list);

      // Verify a message was sent
      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBe(1);

      // Verify the message content is real (not a placeholder)
      const sentParams = sendCalls[0][0] as { params?: { message?: string } };
      expect(sentParams.params?.message).not.toContain("Preparing todo board");
      expect(sentParams.params?.message).toContain("Test Board");
    });

    it("does not create a duplicate message when called concurrently", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Test Board",
        ownerSessionKey: "main",
      });

      // Fire two syncs concurrently
      await Promise.all([syncTodoBackingMessage(list), syncTodoBackingMessage(list)]);

      // Only one backing message should have been created
      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBe(1);
    });

    it("reuses existing backingMessageId without sending a new message", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Test Board",
        ownerSessionKey: "main",
      });
      setBackingMessageId(list.id, "existing-msg-42");

      await syncTodoBackingMessage(list);

      // No send should occur (already have a backing message)
      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBe(0);
    });

    it("stores the backing message ID after creation", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Test Board",
        ownerSessionKey: "main",
      });

      await syncTodoBackingMessage(list);

      const updated = getList(list.id);
      expect(updated?.backingMessageId).toBe("backing-msg-1");
    });

    it("extracts messageId from details (AgentToolResult shape)", async () => {
      // Regression: the original code looked for result.payload.messageId
      // but the real dispatch returns { content: [...], details: { messageId } }
      mockDispatch.mockImplementationOnce(async () => ({
        content: [{ type: "text", text: '{"ok":true,"messageId":"real-msg-42"}' }],
        details: { ok: true, action: "send", messageId: "real-msg-42" },
      }));

      const list = await createList({
        topicKey: "stream:regression#test",
        title: "Regression Board",
        ownerSessionKey: "main",
      });

      await syncTodoBackingMessage(list);

      const updated = getList(list.id);
      expect(updated?.backingMessageId).toBe("real-msg-42");
    });
  });

  describe("concurrent sync safety", () => {
    it("three concurrent syncs for same list produce exactly one send", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Board",
        ownerSessionKey: "main",
      });

      await Promise.all([
        syncTodoBackingMessage(list),
        syncTodoBackingMessage(list),
        syncTodoBackingMessage(list),
      ]);

      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBe(1);
    });

    it("sequential syncs for different lists each create their own message", async () => {
      // Use a counter to produce unique message IDs (real AgentToolResult shape)
      let msgCounter = 0;
      mockDispatch.mockImplementation(async ({ action }: { action: string }) =>
        action === "send"
          ? {
              content: [{ type: "text", text: `{"ok":true,"messageId":"msg-${++msgCounter}"}` }],
              details: { ok: true, action: "send", messageId: `msg-${msgCounter}` },
            }
          : {
              content: [{ type: "text", text: '{"ok":true}' }],
              details: { ok: true },
            },
      );

      const list1 = await createList({
        topicKey: "stream:s1#t1",
        title: "Board 1",
        ownerSessionKey: "main",
      });
      const list2 = await createList({
        topicKey: "stream:s2#t2",
        title: "Board 2",
        ownerSessionKey: "main",
      });

      await syncTodoBackingMessage(list1);
      await syncTodoBackingMessage(list2);

      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBe(2);

      expect(getList(list1.id)?.backingMessageId).toBe("msg-1");
      expect(getList(list2.id)?.backingMessageId).toBe("msg-2");
    });
  });

  describe("repost (delete + send) on sync", () => {
    it("deletes old message and sends new one when syncing", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Repost Board",
        ownerSessionKey: "main",
      });
      setBackingMessageId(list.id, "old-msg-99");

      // Initialize topic support which registers the sync callback
      initializeTodoTopicSupport();

      // Trigger a sync via the lifecycle debounce mechanism
      scheduleSyncForList(list.id);

      // Wait for debounce to fire
      await vi.waitFor(
        () => {
          const deleteCalls = mockDispatch.mock.calls.filter(
            (c) => (c[0] as { action: string }).action === "delete",
          );
          expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: DEBOUNCE_MS + 1000 },
      );

      // Verify: delete was called with the old message ID
      const deleteCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "delete",
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
      const deleteParams = deleteCalls[0][0] as { params?: { messageId?: string } };
      expect(deleteParams.params?.messageId).toBe("old-msg-99");

      // Verify: send was called to create a new message
      const sendCalls = mockDispatch.mock.calls.filter(
        (c) => (c[0] as { action: string }).action === "send",
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);

      // Verify: backing message ID was updated to the new message
      const updated = getList(list.id);
      expect(updated?.backingMessageId).not.toBe("old-msg-99");
      expect(updated?.backingMessageId).toBeTruthy();
    });

    it("still sends new message even if delete fails", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#test-topic",
        title: "Resilient Board",
        ownerSessionKey: "main",
      });
      setBackingMessageId(list.id, "gone-msg-404");

      // Make delete throw but send succeed
      mockDispatch.mockImplementation(async ({ action }: { action: string }) => {
        if (action === "delete") {
          throw new Error("Message not found");
        }
        if (action === "send") {
          return {
            content: [{ type: "text", text: '{"ok":true,"messageId":"new-msg-1"}' }],
            details: { ok: true, action: "send", messageId: "new-msg-1" },
          };
        }
        return { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } };
      });

      initializeTodoTopicSupport();
      scheduleSyncForList(list.id);

      await vi.waitFor(
        () => {
          const sendCalls = mockDispatch.mock.calls.filter(
            (c) => (c[0] as { action: string }).action === "send",
          );
          expect(sendCalls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: DEBOUNCE_MS + 1000 },
      );

      const updated = getList(list.id);
      expect(updated?.backingMessageId).toBe("new-msg-1");
    });
  });

  describe("getActiveTodoSnapshot", () => {
    it("returns a compact snapshot for an active list", async () => {
      const list = await createList({
        topicKey: "stream:test-stream#todo-topic",
        title: "My Tasks",
        ownerSessionKey: "main",
      });
      await addItem(list.id, { title: "Write tests" });
      await addItem(list.id, { title: "Fix bug" });

      const snapshot = getActiveTodoSnapshot("stream:test-stream#todo-topic");
      expect(snapshot).toContain("My Tasks");
      expect(snapshot).toContain("Write tests");
      expect(snapshot).toContain("Fix bug");
    });

    it("returns undefined for topics without active lists", () => {
      const snapshot = getActiveTodoSnapshot("stream:none#nothing");
      expect(snapshot).toBeUndefined();
    });

    it("returns undefined when topicKey is undefined", () => {
      const snapshot = getActiveTodoSnapshot(undefined);
      expect(snapshot).toBeUndefined();
    });
  });
});
