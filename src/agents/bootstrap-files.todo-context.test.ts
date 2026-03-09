import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { _resetLifecycleForTests } from "./todo-lifecycle.js";
import { _resetForTests as resetTodoState, createList, addItem } from "./todo-state.js";
import { _resetTopicForTests } from "./todo-topic.js";

// Mock persistence
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-bootstrap-todo",
}));

vi.mock("../infra/json-file.js", () => ({
  loadJsonFile: () => undefined,
  saveJsonFile: () => undefined,
}));

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: vi.fn(async () => ({
    content: [{ type: "text", text: '{"ok":true}' }],
    details: { ok: true },
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

// Also mock paths explicitly to ensure STATE_DIR is available
vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveStateDir: () => "/tmp/openclaw-test-bootstrap-todo",
  };
});

// Mock the workspace file loader to return minimal bootstrap files
vi.mock("./workspace.js", () => ({
  loadWorkspaceBootstrapFiles: async () => [],
  filterBootstrapFilesForSession: (files: unknown[]) => files,
  loadExtraBootstrapFiles: async () => [],
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_SOUL_FILENAME: "SOUL.md",
  DEFAULT_TOOLS_FILENAME: "TOOLS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  DEFAULT_USER_FILENAME: "USER.md",
  DEFAULT_HEARTBEAT_FILENAME: "HEARTBEAT.md",
  DEFAULT_BOOTSTRAP_FILENAME: "BOOTSTRAP.md",
  DEFAULT_MEMORY_FILENAME: "MEMORY.md",
  DEFAULT_MEMORY_ALT_FILENAME: "memory.md",
}));

// Mock bootstrap hooks (no-op)
vi.mock("./bootstrap-hooks.js", () => ({
  applyBootstrapHookOverrides: async (params: { files: unknown[] }) => params.files,
}));

describe("bootstrap-files todo context injection", () => {
  beforeEach(() => {
    resetTodoState();
    _resetTopicForTests();
    _resetLifecycleForTests();
  });

  afterEach(() => {
    resetTodoState();
    _resetTopicForTests();
    _resetLifecycleForTests();
  });

  it("injects todo snapshot when session has active todo list", async () => {
    // Create an active todo list for a Zulip topic
    const list = await createList({
      topicKey: "stream:marcel-zulipclaw#todo list tracking",
      title: "Sprint Tasks",
      ownerSessionKey: "main",
    });
    await addItem(list.id, { title: "Write tests" });
    await addItem(list.id, { title: "Fix bug" });

    const result = await resolveBootstrapContextForRun({
      workspaceDir: "/tmp/fake-workspace",
      sessionKey: "agent:main:zulip:channel:marcel-zulipclaw#todo list tracking",
    });

    const todoContext = result.contextFiles.find((f) => f.path === "Active Todo List");
    expect(todoContext).toBeDefined();
    expect(todoContext?.content).toContain("Sprint Tasks");
    expect(todoContext?.content).toContain("Write tests");
    expect(todoContext?.content).toContain("Fix bug");
  });

  it("does not inject when no active todo list exists for the topic", async () => {
    const result = await resolveBootstrapContextForRun({
      workspaceDir: "/tmp/fake-workspace",
      sessionKey: "agent:main:zulip:channel:marcel-zulipclaw#some topic",
    });

    const todoContext = result.contextFiles.find((f) => f.path === "Active Todo List");
    expect(todoContext).toBeUndefined();
  });

  it("does not inject for sessions without a topic key", async () => {
    // Create a list but use a session key that doesn't map to a topic
    await createList({
      topicKey: "stream:test#test",
      title: "Board",
      ownerSessionKey: "main",
    });

    const result = await resolveBootstrapContextForRun({
      workspaceDir: "/tmp/fake-workspace",
      sessionKey: "agent:main:telegram:dm:12345",
    });

    const todoContext = result.contextFiles.find((f) => f.path === "Active Todo List");
    expect(todoContext).toBeUndefined();
  });

  it("does not inject for archived todo lists", async () => {
    const { archiveList } = await import("./todo-state.js");
    const list = await createList({
      topicKey: "stream:marcel-zulipclaw#archived topic",
      title: "Old Board",
      ownerSessionKey: "main",
    });
    await addItem(list.id, { title: "Old task" });
    await archiveList(list.id);

    const result = await resolveBootstrapContextForRun({
      workspaceDir: "/tmp/fake-workspace",
      sessionKey: "agent:main:zulip:channel:marcel-zulipclaw#archived topic",
    });

    const todoContext = result.contextFiles.find((f) => f.path === "Active Todo List");
    expect(todoContext).toBeUndefined();
  });
});
