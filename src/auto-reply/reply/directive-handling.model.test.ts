import { describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineDirectives } from "./directive-handling.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";

const authMocks = vi.hoisted(() => ({
  store: {
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        token: "oauth-token-value",
        expires: Date.now() + 60_000,
      },
    },
    usageStats: {
      "openai-codex:default": {
        cooldownUntil: Date.now() + 5 * 60_000,
        failureCounts: { rate_limit: 6 },
      },
    },
  },
}));

// Mock dependencies for directive handling persistence.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn((store: typeof authMocks.store, profileId: string) => {
    const until = store.usageStats?.[profileId]?.cooldownUntil;
    return typeof until === "number" && until > Date.now();
  }),
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
  resolveAuthStorePathForDisplay: vi.fn(() => "/tmp/agent/auth-profiles.json"),
}));

vi.mock("../../agents/model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => authMocks.store),
  getCustomProviderApiKey: vi.fn(() => undefined),
  resolveAuthProfileOrder: vi.fn(({ provider }: { provider: string }) =>
    Object.keys(authMocks.store.profiles).filter(
      (profileId) => authMocks.store.profiles[profileId]?.provider === provider,
    ),
  ),
  resolveEnvApiKey: vi.fn(() => null),
}));

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

describe("/model chat UX", () => {
  it("shows summary for /model with no args", async () => {
    const directives = parseInlineDirectives("/model");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const reply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-5",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelCatalog: [],
      resetModelOverride: false,
    });

    expect(reply?.text).toContain("Current:");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("auto-applies closest match for typos", () => {
    const directives = parseInlineDirectives("/model anthropic/claud-opus-4-5");
    const cfg = { commands: { text: true } } as unknown as OpenClawConfig;

    const resolved = resolveModelSelectionFromDirective({
      directives,
      cfg,
      agentDir: "/tmp/agent",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys: new Set(["anthropic/claude-opus-4-5"]),
      allowedModelCatalog: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      provider: "anthropic",
    });

    expect(resolved.modelSelection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      isDefault: true,
    });
    expect(resolved.errorText).toBeUndefined();
  });

  it("shows actual last-run drift and cooldown reason in /model status", async () => {
    const directives = parseInlineDirectives("/model status");

    const reply = await maybeHandleModelDirectiveInfo({
      directives,
      cfg: {
        commands: { text: true },
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": { alias: "gpt54" },
            },
          },
        },
      } as unknown as OpenClawConfig,
      agentDir: "/tmp/agent",
      activeAgentId: "main",
      sessionEntry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        modelProvider: "synthetic",
        model: "Kimi-K2.5-NVFP4",
      },
      provider: "openai-codex",
      model: "gpt-5.4",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: {
        byAlias: new Map([["gpt54", "openai-codex/gpt-5.4"]]),
        byKey: new Map([["openai-codex/gpt-5.4", ["gpt54"]]]),
      },
      allowedModelCatalog: [{ provider: "openai-codex", id: "gpt-5.4" }],
      resetModelOverride: false,
    });

    expect(reply?.text).toContain("Current: openai-codex/gpt-5.4");
    expect(reply?.text).toContain("Actual last run: synthetic/Kimi-K2.5-NVFP4");
    expect(reply?.text).toContain("cooldown");
    expect(reply?.text).toContain("failure rate_limit x6");
  });
});

describe("handleDirectiveOnly model persist behavior (fixes #1435)", () => {
  const allowedModelKeys = new Set(["anthropic/claude-opus-4-5", "openai/gpt-4o"]);
  const allowedModelCatalog = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  ];
  const sessionKey = "agent:main:dm:1";
  const storePath = "/tmp/sessions.json";

  type HandleParams = Parameters<typeof handleDirectiveOnly>[0];

  function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
    return {
      sessionId: "s1",
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  function createHandleParams(overrides: Partial<HandleParams>): HandleParams {
    const entryOverride = overrides.sessionEntry;
    const storeOverride = overrides.sessionStore;
    const entry = entryOverride ?? createSessionEntry();
    const store = storeOverride ?? ({ [sessionKey]: entry } as const);
    const { sessionEntry: _ignoredEntry, sessionStore: _ignoredStore, ...rest } = overrides;

    return {
      cfg: baseConfig(),
      directives: rest.directives ?? parseInlineDirectives(""),
      sessionKey,
      storePath,
      elevatedEnabled: false,
      elevatedAllowed: false,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: baseAliasIndex(),
      allowedModelKeys,
      allowedModelCatalog,
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label) => `Switched to ${label}`,
      ...rest,
      sessionEntry: entry,
      sessionStore: store,
    };
  }

  it("shows success message when session state is available", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text).toContain("Model set to");
    expect(result?.text).toContain("openai/gpt-4o");
    expect(result?.text).not.toContain("failed");
  });

  it("shows no model message when no /model directive", async () => {
    const directives = parseInlineDirectives("hello world");
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
      }),
    );

    expect(result?.text ?? "").not.toContain("Model set to");
    expect(result?.text ?? "").not.toContain("failed");
  });

  it("persists thinkingLevel=off (does not clear)", async () => {
    const directives = parseInlineDirectives("/think off");
    const sessionEntry = createSessionEntry({ thinkingLevel: "low" });
    const sessionStore = { [sessionKey]: sessionEntry };
    const result = await handleDirectiveOnly(
      createHandleParams({
        directives,
        sessionEntry,
        sessionStore,
      }),
    );

    expect(result?.text ?? "").not.toContain("failed");
    expect(sessionEntry.thinkingLevel).toBe("off");
    expect(sessionStore["agent:main:dm:1"]?.thinkingLevel).toBe("off");
  });
});
