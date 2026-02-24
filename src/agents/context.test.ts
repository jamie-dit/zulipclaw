import { describe, expect, it } from "vitest";
import {
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  lookupContextTokens,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-extensions/session-manager-runtime-registry.js";

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when duplicate model ids are discovered", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "claude-sonnet-4-5", contextWindow: 1_000_000 },
        { id: "claude-sonnet-4-5", contextWindow: 200_000 },
      ],
    });

    expect(cache.get("claude-sonnet-4-5")).toBe(200_000);
  });

  it("upgrades discovered Claude 4.6 model context windows to 200k", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "claude-opus-4-6", contextWindow: 100_000 },
        { id: "claude-sonnet-4-6", contextWindow: 100_000 },
      ],
    });

    expect(cache.get("claude-opus-4-6")).toBe(200_000);
    expect(cache.get("claude-sonnet-4-6")).toBe(200_000);
  });
});

describe("applyConfiguredContextWindows", () => {
  it("overrides discovered cache values with explicit models.providers contextWindow", () => {
    const cache = new Map<string, number>([["anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", contextWindow: 150_000 },
              { id: "bad/model", contextWindow: 0 },
              { id: "", contextWindow: 300_000 },
            ],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });
});

describe("lookupContextTokens", () => {
  it("falls back to known 200k context windows for Claude 4.6 ids", () => {
    expect(lookupContextTokens("claude-opus-4-6")).toBe(200_000);
    expect(lookupContextTokens("anthropic/claude-sonnet-4-6")).toBe(200_000);
  });
});

describe("createSessionManagerRuntimeRegistry", () => {
  it("stores, reads, and clears values by object identity", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    const key = {};
    expect(registry.get(key)).toBeNull();
    registry.set(key, { value: 1 });
    expect(registry.get(key)).toEqual({ value: 1 });
    registry.set(key, null);
    expect(registry.get(key)).toBeNull();
  });

  it("ignores non-object keys", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    registry.set(null, { value: 1 });
    registry.set(123, { value: 1 });
    expect(registry.get(null)).toBeNull();
    expect(registry.get(123)).toBeNull();
  });
});
