import { describe, expect, it, vi } from "vitest";

// Mock dependencies to isolate the unit under test.
vi.mock("../../config/sessions.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(({ sessionKey }: { sessionKey: string }) => sessionKey),
  resolveAgentMainSessionKey: vi.fn(() => "agent:main:main"),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("./config.js", () => ({
  resolveSandboxConfigForAgent: vi.fn(() => ({
    mode: "off",
    scope: "agent",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/sandbox",
    docker: { network: "none", capDrop: ["ALL"] },
    browser: { enabled: false },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 12, maxAgeDays: 7 },
  })),
}));

vi.mock("./tool-policy.js", () => ({
  resolveSandboxToolPolicyForAgent: vi.fn(() => ({
    allow: [],
    deny: [],
    sources: {
      allow: { source: "default", key: "" },
      deny: { source: "default", key: "" },
    },
  })),
}));

import { resolveSandboxRuntimeStatus } from "./runtime-status.js";

describe("resolveSandboxRuntimeStatus with forceSandbox", () => {
  it("returns sandboxed=false when mode is off and forceSandbox is not set", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: undefined,
      sessionKey: "agent:main:subagent:test-uuid",
    });
    expect(result.sandboxed).toBe(false);
  });

  it("returns sandboxed=true when forceSandbox is true even with mode=off", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: undefined,
      sessionKey: "agent:main:subagent:test-uuid",
      forceSandbox: true,
    });
    expect(result.sandboxed).toBe(true);
  });

  it("returns sandboxed=true when forceSandbox is true and sessionKey is empty", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: undefined,
      sessionKey: "",
      forceSandbox: true,
    });
    // forceSandbox overrides even without a session key
    expect(result.sandboxed).toBe(true);
  });

  it("does not force sandbox when forceSandbox is false", () => {
    const result = resolveSandboxRuntimeStatus({
      cfg: undefined,
      sessionKey: "agent:main:subagent:test-uuid",
      forceSandbox: false,
    });
    expect(result.sandboxed).toBe(false);
  });
});
