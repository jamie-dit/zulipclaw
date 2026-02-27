import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const SUBAGENT_KEY = "agent:main:subagent:test-uuid";
const MAIN_KEY = "agent:main:main";

function makeCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
      },
    },
  } as OpenClawConfig;
}

describe("sessions-patch sandbox fields", () => {
  it("sets forceSandbox=true on subagent session", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, forceSandbox: true },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.forceSandbox).toBe(true);
    }
  });

  it("rejects forceSandbox on non-subagent session", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: MAIN_KEY,
      patch: { key: MAIN_KEY, forceSandbox: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("subagent");
    }
  });

  it("clears forceSandbox with null", async () => {
    const store: Record<string, SessionEntry> = {
      [SUBAGENT_KEY]: { sessionId: "s1", updatedAt: 1, forceSandbox: true },
    };
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, forceSandbox: null },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.forceSandbox).toBeUndefined();
    }
  });

  it("sets sandboxWorkspaceAccess=ro", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxWorkspaceAccess: "ro" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.sandboxWorkspaceAccess).toBe("ro");
    }
  });

  it("sets sandboxWorkspaceAccess=none", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxWorkspaceAccess: "none" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.sandboxWorkspaceAccess).toBe("none");
    }
  });

  it("rejects invalid sandboxWorkspaceAccess", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxWorkspaceAccess: "invalid" as "ro" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("sandboxWorkspaceAccess");
    }
  });

  it("clears sandboxWorkspaceAccess with null", async () => {
    const store: Record<string, SessionEntry> = {
      [SUBAGENT_KEY]: { sessionId: "s1", updatedAt: 1, sandboxWorkspaceAccess: "ro" },
    };
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxWorkspaceAccess: null },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.sandboxWorkspaceAccess).toBeUndefined();
    }
  });

  it("sets sandboxNetworkRestrictions=true", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxNetworkRestrictions: true },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.sandboxNetworkRestrictions).toBe(true);
    }
  });

  it("clears sandboxNetworkRestrictions with null", async () => {
    const store: Record<string, SessionEntry> = {
      [SUBAGENT_KEY]: { sessionId: "s1", updatedAt: 1, sandboxNetworkRestrictions: true },
    };
    const res = await applySessionsPatchToStore({
      cfg: makeCfg(),
      store,
      storeKey: SUBAGENT_KEY,
      patch: { key: SUBAGENT_KEY, sandboxNetworkRestrictions: null },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.sandboxNetworkRestrictions).toBeUndefined();
    }
  });
});
