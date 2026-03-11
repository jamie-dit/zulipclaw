import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolveForwardCompatModel } from "./model-forward-compat.js";

const baseModel = (): Model<Api> =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function createTemplateModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "anthropic-messages",
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<Api>;
}

function createOpenAITemplateModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 32_768,
  } as Model<Api>;
}

function createOpenAICodexTemplateModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  } as Model<Api>;
}

function createRegistry(models: Record<string, Model<Api>>): ModelRegistry {
  return {
    find(provider: string, modelId: string) {
      return models[`${provider}/${modelId}`] ?? null;
    },
  } as ModelRegistry;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectResolvedForwardCompat(
  model: Model<Api> | undefined,
  expected: { provider: string; id: string },
): void {
  expect(model?.id).toBe(expected.id);
  expect(model?.name).toBe(expected.id);
  expect(model?.provider).toBe(expected.provider);
}

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    expectSupportsDeveloperRoleForcedOff();
  });

  it("leaves non-zai models untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model<Api>);
    expect(normalized.compat).toBeUndefined();
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = { supportsDeveloperRole: false };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
  });
});

describe("isModernModelRef", () => {
  it("includes OpenAI gpt-5.4 variants in modern selection", () => {
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
  });

  it("includes opencode minimax variants in modern selection", () => {
    // ZulipClaw: opencode minimax models are included via the opencode/openrouter catch-all
    expect(isModernModelRef({ provider: "opencode", id: "minimax-m2.5" })).toBe(true);
  });

  it("keeps non-minimax opencode modern models", () => {
    expect(isModernModelRef({ provider: "opencode", id: "claude-opus-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "gemini-3-pro" })).toBe(true);
  });
});

describe("resolveForwardCompatModel", () => {
  it("resolves openai gpt-5.4 via gpt-5.2 template", () => {
    const registry = createRegistry({
      "openai/gpt-5.2": createOpenAITemplateModel("gpt-5.2"),
    });
    const model = resolveForwardCompatModel("openai", "gpt-5.4", registry);
    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("resolves openai gpt-5.4 without templates using normalized fallback defaults", () => {
    const registry = createRegistry({});

    const model = resolveForwardCompatModel("openai", "gpt-5.4", registry);

    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.reasoning).toBe(true);
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("resolves openai gpt-5.4-pro via template fallback", () => {
    const registry = createRegistry({
      "openai/gpt-5.2": createOpenAITemplateModel("gpt-5.2"),
    });
    const model = resolveForwardCompatModel("openai", "gpt-5.4-pro", registry);
    expectResolvedForwardCompat(model, { provider: "openai", id: "gpt-5.4-pro" });
    expect(model?.api).toBe("openai-responses");
    expect(model?.baseUrl).toBe("https://api.openai.com/v1");
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("resolves openai-codex gpt-5.4 via codex template fallback", () => {
    const registry = createRegistry({
      "openai-codex/gpt-5.2-codex": createOpenAICodexTemplateModel("gpt-5.2-codex"),
    });
    const model = resolveForwardCompatModel("openai-codex", "gpt-5.4", registry);
    expectResolvedForwardCompat(model, { provider: "openai-codex", id: "gpt-5.4" });
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(model?.contextWindow).toBe(272_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("resolves anthropic opus 4.6 via 4.5 template", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-opus-4-6", registry);
    expectResolvedForwardCompat(model, { provider: "anthropic", id: "claude-opus-4-6" });
  });

  it("resolves anthropic sonnet 4.6 dot variant with suffix", () => {
    const registry = createRegistry({
      "anthropic/claude-sonnet-4.5-20260219": createTemplateModel(
        "anthropic",
        "claude-sonnet-4.5-20260219",
      ),
    });
    const model = resolveForwardCompatModel("anthropic", "claude-sonnet-4.6-20260219", registry);
    expectResolvedForwardCompat(model, { provider: "anthropic", id: "claude-sonnet-4.6-20260219" });
  });

  it("does not resolve anthropic 4.6 fallback for other providers", () => {
    const registry = createRegistry({
      "anthropic/claude-opus-4-5": createTemplateModel("anthropic", "claude-opus-4-5"),
    });
    const model = resolveForwardCompatModel("openai", "claude-opus-4-6", registry);
    expect(model).toBeUndefined();
  });
});
