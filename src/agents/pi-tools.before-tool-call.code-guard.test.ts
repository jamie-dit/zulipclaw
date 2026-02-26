import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("./subagent-spawn.js");
vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("code guard integration in before-tool-call hook", () => {
  beforeEach(() => {
    const hookRunner = {
      hasHooks: vi.fn(() => false),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    resetDiagnosticSessionStateForTest();
  });

  it("blocks code file write from main session in block mode", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "export const x = 1;" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toContain("BLOCKED");
      expect(result.reason).toContain("sessions_spawn");
    }
  });

  it("blocks code file edit from main session in block mode", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "edit",
      params: {
        file_path: "/src/index.ts",
        old_string: "const x = 1;\nconst y = 2;",
        new_string: "const x = 2;\nconst y = 3;",
      },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(true);
  });

  it("allows code file write from sub-agent session", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "export const x = 1;" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:subagent:test-uuid",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows code file write from cron session", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "export const x = 1;" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:cron:daily-check",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows non-code file edits from main session", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/docs/README.md", content: "# Docs" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows single-line fixes from main session in block mode", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "edit",
      params: {
        file_path: "/src/index.ts",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows read tool even with code guard enabled", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/src/index.ts" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block when code guard is disabled", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: false,
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block when no code guard config is provided", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows exempt paths in block mode", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { file_path: "/src/test/helper.ts", content: "test code" },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
          exemptPaths: ["**/test/**"],
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block apply_patch to non-code file", async () => {
    const patch = `--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1,3 +1,3 @@
-old text
+new text`;
    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { patch },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks apply_patch to code file in block mode", async () => {
    const patch = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
-old code
+new code`;
    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { patch },
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:zulip:channel:test#topic",
        codeGuard: {
          enabled: true,
          mode: "block",
        },
      },
    });
    expect(result.blocked).toBe(true);
  });
});
