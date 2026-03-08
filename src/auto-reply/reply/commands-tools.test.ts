import { describe, expect, it, vi } from "vitest";
import { handleToolsCommand } from "./commands-tools.js";

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => [{ name: "todo" }, { name: "sessions_spawn" }, { name: "message" }],
}));

vi.mock("../../agents/todo-topic.js", () => ({
  getTodoTopicKey: () => "stream:test#topic",
  getActiveTodoSnapshot: () => "📋 Board (1/2 done)",
}));

describe("handleToolsCommand", () => {
  it("returns concise tools/debug output", async () => {
    const result = await handleToolsCommand(
      {
        ctx: {
          AccountId: undefined,
          OriginatingTo: "stream:test#topic",
          MessageThreadId: undefined,
        } as never,
        cfg: {} as never,
        command: {
          commandBodyNormalized: "/tools",
          isAuthorizedSender: true,
          senderId: "u1",
          channel: "zulip",
          to: "stream:test#topic",
        } as never,
        sessionKey: "agent:main:zulip:channel:test#topic",
        resolvedVerboseLevel: "on",
      } as never,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("🧰 Tools");
    expect(result?.reply?.text).toContain("message, sessions_spawn, todo");
    expect(result?.reply?.text).toContain("Verbose tool debug: summary");
    expect(result?.reply?.text).toContain("📋 Board");
  });
});
