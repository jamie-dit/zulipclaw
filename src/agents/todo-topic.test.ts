import { describe, expect, it, beforeEach, vi } from "vitest";
import { _resetLifecycleForTests } from "./todo-lifecycle.js";
import { _resetForTests, createList, addItem } from "./todo-state.js";
import { getTodoTopicKey, maybeApplyTodoProgressFromSubagent } from "./todo-topic.js";

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-todo-topic",
}));

vi.mock("../infra/json-file.js", () => ({
  loadJsonFile: () => undefined,
  saveJsonFile: () => undefined,
}));

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: vi.fn(async ({ action }: { action: string }) =>
    action === "send" ? { payload: { messageId: "123" } } : { payload: {} },
  ),
}));

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));

describe("todo-topic", () => {
  beforeEach(() => {
    _resetForTests();
    _resetLifecycleForTests();
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
});
