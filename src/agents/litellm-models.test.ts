import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildLiteLLMModelDefinition,
  discoverLiteLLMModels,
  fetchLiteLLMCatalog,
  LITELLM_DEFAULT_COST,
  LITELLM_DEFAULT_CONTEXT_WINDOW,
  LITELLM_DEFAULT_MAX_TOKENS,
} from "./litellm-models.js";

describe("litellm-models", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    global.fetch = vi.fn();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  describe("buildLiteLLMModelDefinition", () => {
    it("builds a basic model definition with defaults", () => {
      const model = buildLiteLLMModelDefinition("gpt-4");

      expect(model.id).toBe("gpt-4");
      expect(model.name).toBe("gpt-4");
      expect(model.input).toEqual(["text"]);
      expect(model.reasoning).toBe(false);
      expect(model.cost).toEqual(LITELLM_DEFAULT_COST);
      expect(model.contextWindow).toBe(LITELLM_DEFAULT_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(LITELLM_DEFAULT_MAX_TOKENS);
    });

    it("detects reasoning models from ID patterns", () => {
      const reasoningModel = buildLiteLLMModelDefinition("claude-opus-4");
      expect(reasoningModel.reasoning).toBe(true);

      const thinkingModel = buildLiteLLMModelDefinition("deepseek-r1");
      expect(thinkingModel.reasoning).toBe(true);

      const regularModel = buildLiteLLMModelDefinition("gpt-3.5");
      expect(regularModel.reasoning).toBe(false);
    });

    it("detects vision models from ID patterns", () => {
      const visionModel = buildLiteLLMModelDefinition("gpt-4o");
      expect(visionModel.input).toContain("image");

      const claudeModel = buildLiteLLMModelDefinition("claude-3");
      expect(claudeModel.input).toContain("image");

      const textModel = buildLiteLLMModelDefinition("text-model");
      expect(textModel.input).toEqual(["text"]);
    });

    it("converts costs from per-token to per-million-tokens", () => {
      const catalogEntry = {
        input_cost_per_token: 5e-6, // $0.000005 per token
        output_cost_per_token: 1.5e-5, // $0.000015 per token
        cache_creation_input_token_cost: 2.5e-6,
        cache_read_input_token_cost: 5e-7,
      };

      const model = buildLiteLLMModelDefinition("gpt-4", catalogEntry);

      expect(model.cost.input).toBe(5); // $5 per million tokens
      expect(model.cost.output).toBe(15); // $15 per million tokens
      expect(model.cost.cacheWrite).toBe(2.5);
      expect(model.cost.cacheRead).toBe(0.5);
    });

    it("uses catalog metadata for context window and max tokens", () => {
      const catalogEntry = {
        max_input_tokens: 200000,
        max_output_tokens: 4096,
      };

      const model = buildLiteLLMModelDefinition("claude-3", catalogEntry);

      expect(model.contextWindow).toBe(200000);
      expect(model.maxTokens).toBe(4096);
    });

    it("uses catalog capability flags over ID heuristics", () => {
      const catalogEntry = {
        supports_reasoning: true,
        supports_vision: true,
      };

      const model = buildLiteLLMModelDefinition("generic-model", catalogEntry);

      expect(model.reasoning).toBe(true);
      expect(model.input).toContain("image");
    });
  });

  describe("fetchLiteLLMCatalog", () => {
    it("returns empty object on fetch failure", async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error("Network error"));

      const catalog = await fetchLiteLLMCatalog();

      expect(catalog).toEqual({});
    });

    it("returns empty object on HTTP error", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const catalog = await fetchLiteLLMCatalog();

      expect(catalog).toEqual({});
    });

    it("returns parsed catalog on success", async () => {
      const mockCatalog = {
        "gpt-4": {
          litellm_provider: "openai",
          max_input_tokens: 8192,
          input_cost_per_token: 3e-6,
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCatalog),
      } as Response);

      const catalog = await fetchLiteLLMCatalog();

      expect(catalog["gpt-4"]).toBeDefined();
      expect(catalog["gpt-4"].litellm_provider).toBe("openai");
    });
  });

  describe("discoverLiteLLMModels", () => {
    it("returns empty array in test environment", async () => {
      process.env.VITEST = "true";

      const models = await discoverLiteLLMModels();

      expect(models).toEqual([]);
    });

    it("returns empty array when LiteLLM API fails", async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error("Connection refused"));

      const models = await discoverLiteLLMModels("http://localhost:4000");

      expect(models).toEqual([]);
    });

    it("returns empty array when LiteLLM returns no models", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ object: "list", data: [] }),
      } as Response);

      const models = await discoverLiteLLMModels("http://localhost:4000");

      expect(models).toEqual([]);
    });

    it("discovers models and enriches with catalog data", async () => {
      const mockModelsResponse = {
        object: "list" as const,
        data: [
          { id: "gpt-4", object: "model" as const, created: 1677649963, owned_by: "openai" },
          { id: "claude-3-opus", object: "model" as const, created: 1677649963, owned_by: "anthropic" },
        ],
      };

      const mockCatalog = {
        "gpt-4": {
          litellm_provider: "openai",
          max_input_tokens: 8192,
          max_output_tokens: 4096,
          input_cost_per_token: 3e-6,
          output_cost_per_token: 6e-6,
          supports_vision: true,
        },
        "claude-3-opus": {
          litellm_provider: "anthropic",
          max_input_tokens: 200000,
          max_output_tokens: 4096,
          input_cost_per_token: 1.5e-5,
          output_cost_per_token: 7.5e-5,
          supports_reasoning: true,
          supports_vision: true,
        },
      };

      // First call: /v1/models, Second call: catalog
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockModelsResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockCatalog),
        } as Response);

      const models = await discoverLiteLLMModels("http://localhost:4000");

      expect(models).toHaveLength(2);

      // Check GPT-4
      const gpt4 = models.find((m) => m.id === "gpt-4");
      expect(gpt4).toBeDefined();
      expect(gpt4?.contextWindow).toBe(8192);
      expect(gpt4?.maxTokens).toBe(4096);
      expect(gpt4?.cost.input).toBe(3); // 3e-6 * 1M
      expect(gpt4?.input).toContain("image");

      // Check Claude
      const claude = models.find((m) => m.id === "claude-3-opus");
      expect(claude).toBeDefined();
      expect(claude?.contextWindow).toBe(200000);
      expect(claude?.reasoning).toBe(true);
      expect(claude?.cost.output).toBe(75); // 7.5e-5 * 1M
    });

    it("uses authorization header when apiKey is provided", async () => {
      const mockResponse = {
        object: "list" as const,
        data: [{ id: "test-model", object: "model" as const, created: 1677649963, owned_by: "test" }],
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response);

      await discoverLiteLLMModels("http://localhost:4000", "test-api-key");

      const calls = vi.mocked(global.fetch).mock.calls;
      expect(calls[0][1]?.headers).toEqual({
        Authorization: "Bearer test-api-key",
      });
    });

    it("strips trailing slashes from baseUrl", async () => {
      const mockResponse = {
        object: "list" as const,
        data: [{ id: "test-model", object: "model" as const, created: 1677649963, owned_by: "test" }],
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        } as Response);

      await discoverLiteLLMModels("http://localhost:4000///");

      const calls = vi.mocked(global.fetch).mock.calls;
      expect(calls[0][0]).toBe("http://localhost:4000/v1/models");
    });
  });
});
