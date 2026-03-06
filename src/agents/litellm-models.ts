import type { ModelDefinitionConfig } from "../config/types.models.js";

export const LITELLM_PUBLIC_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
export const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;

// Default cost when not specified (set to 0 as LiteLLM handles actual billing)
export const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Default context window and max tokens when not specified
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;

// LiteLLM API response types
interface LiteLLMModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface LiteLLMModelsResponse {
  object: "list";
  data: LiteLLMModel[];
}

// LiteLLM catalog entry from public JSON
interface LiteLLMCatalogEntry {
  litellm_provider?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_function_calling?: boolean;
  supports_prompt_caching?: boolean;
}

type LiteLLMCatalog = Record<string, LiteLLMCatalogEntry>;

/**
 * Build a ModelDefinitionConfig from a model ID and optional catalog entry.
 */
export function buildLiteLLMModelDefinition(
  modelId: string,
  catalogEntry?: LiteLLMCatalogEntry,
): ModelDefinitionConfig {
  const lowerId = modelId.toLowerCase();

  // Determine capabilities from model ID patterns and catalog
  const isReasoning =
    catalogEntry?.supports_reasoning === true ||
    lowerId.includes("thinking") ||
    lowerId.includes("reason") ||
    lowerId.includes("r1") ||
    lowerId.includes("opus") ||
    lowerId.includes("claude-4");

  const hasVision =
    catalogEntry?.supports_vision === true ||
    lowerId.includes("vision") ||
    lowerId.includes("gpt-4o") ||
    lowerId.includes("claude");

  // Convert costs from $/token to $/million tokens
  const inputCost = catalogEntry?.input_cost_per_token
    ? catalogEntry.input_cost_per_token * 1_000_000
    : LITELLM_DEFAULT_COST.input;

  const outputCost = catalogEntry?.output_cost_per_token
    ? catalogEntry.output_cost_per_token * 1_000_000
    : LITELLM_DEFAULT_COST.output;

  const cacheReadCost = catalogEntry?.cache_read_input_token_cost
    ? catalogEntry.cache_read_input_token_cost * 1_000_000
    : LITELLM_DEFAULT_COST.cacheRead;

  const cacheWriteCost = catalogEntry?.cache_creation_input_token_cost
    ? catalogEntry.cache_creation_input_token_cost * 1_000_000
    : LITELLM_DEFAULT_COST.cacheWrite;

  // Use catalog values or defaults
  const contextWindow =
    catalogEntry?.max_input_tokens ||
    catalogEntry?.max_tokens ||
    LITELLM_DEFAULT_CONTEXT_WINDOW;

  const maxTokens =
    catalogEntry?.max_output_tokens ||
    catalogEntry?.max_tokens ||
    LITELLM_DEFAULT_MAX_TOKENS;

  return {
    id: modelId,
    name: modelId,
    reasoning: isReasoning,
    input: hasVision ? ["text", "image"] : ["text"],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
    },
    contextWindow,
    maxTokens,
  };
}

/**
 * Fetch the LiteLLM public catalog with model metadata.
 */
export async function fetchLiteLLMCatalog(): Promise<LiteLLMCatalog> {
  try {
    const response = await fetch(LITELLM_PUBLIC_CATALOG_URL, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[litellm-models] Failed to fetch catalog: HTTP ${response.status}`,
      );
      return {};
    }

    const data = (await response.json()) as LiteLLMCatalog;
    return data;
  } catch (error) {
    console.warn(
      `[litellm-models] Failed to fetch catalog: ${String(error)}`,
    );
    return {};
  }
}

/**
 * Discover models from LiteLLM instance and enrich with catalog metadata.
 */
export async function discoverLiteLLMModels(
  baseUrl: string = LITELLM_BASE_URL,
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return [];
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");

  try {
    // Fetch models from LiteLLM instance
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${trimmedBaseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(
        `[litellm-models] Failed to discover models: HTTP ${response.status}`,
      );
      return [];
    }

    const data = (await response.json()) as LiteLLMModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      console.warn("[litellm-models] No models found from API");
      return [];
    }

    // Fetch catalog for metadata enrichment
    const catalog = await fetchLiteLLMCatalog();

    // Build model definitions
    const models: ModelDefinitionConfig[] = [];
    for (const apiModel of data.data) {
      const catalogEntry = catalog[apiModel.id];
      models.push(buildLiteLLMModelDefinition(apiModel.id, catalogEntry));
    }

    return models;
  } catch (error) {
    console.warn(
      `[litellm-models] Discovery failed: ${String(error)}`,
    );
    return [];
  }
}
