import { describe, expect, it, beforeEach, vi } from "vitest";
import { _resetLifecycleForTests } from "./todo-lifecycle.js";
import { _resetForTests, createList, addItem, setBackingMessageId, getList } from "./todo-state.js";
import {
  getTodoTopicKey,
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

const mockDispatch = vi.fn(async ({ action }: { action: string }) =>
  action === "send" ? { payload: { messageId: "backing-msg-1" } } : { payload: {} },
);

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) => mockDispatch(args[0] as { action: string }),
}));

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));

describe("todo-topic", () => {
  beforeEach(() => {
    _resetForTests();
    _resetLifecycleForTests();
    _resetTopicForTests();
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
      // Use a counter to produce unique message IDs
      let msgCounter = 0;
      mockDispatch.mockImplementation(async ({ action }: { action: string }) =>
        action === "send" ? { payload: { messageId: `msg-${++msgCounter}` } } : { payload: {} },
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
});
