/**
 * Model pricing data for cost calculation.
 *
 * Prices are in USD per 1 million tokens.
 * Based on standard pricing from LiteLLM's pricing database.
 */

export type ModelPrice = {
  id: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ModelPriceMap = Record<string, ModelPrice>;

/**
 * Pricing data for common models.
 * Prices are approximate and should be updated periodically.
 */
export const MODEL_PRICING: ModelPriceMap = {
  // Claude Opus (Anthropic)
  "anthropic/claude-4-opus": {
    id: "anthropic/claude-4-opus",
    input: 15.0,
    output: 75.0,
  },
  "anthropic/claude-opus-4-1": {
    id: "anthropic/claude-opus-4-1",
    input: 15.0,
    output: 75.0,
  },
  "claude/opus": {
    id: "claude/opus",
    input: 15.0,
    output: 75.0,
  },
  "claude/opus-4.5": {
    id: "claude/opus-4.5",
    input: 15.0,
    output: 75.0,
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    input: 15.0,
    output: 75.0,
  },
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    input: 15.0,
    output: 75.0,
  },

  // Claude Sonnet (Anthropic)
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    input: 3.0,
    output: 15.0,
  },
  "anthropic/claude-sonnet-4-5": {
    id: "anthropic/claude-sonnet-4-5",
    input: 3.0,
    output: 15.0,
  },
  "anthropic/claude-sonnet-latest": {
    id: "anthropic/claude-sonnet-latest",
    input: 3.0,
    output: 15.0,
  },
  "claude/sonnet": {
    id: "claude/sonnet",
    input: 3.0,
    output: 15.0,
  },
  "claude/haiku": {
    id: "claude/haiku",
    input: 1.0,
    output: 5.0,
  },

  // GPT-5 (OpenAI)
  "openai/gpt-5": {
    id: "openai/gpt-5",
    input: 15.0,
    output: 60.0,
  },
  "openai/gpt-5.1": {
    id: "openai/gpt-5.1",
    input: 15.0,
    output: 60.0,
  },
  "openai/gpt-5.1-chat": {
    id: "openai/gpt-5.1-chat",
    input: 10.0,
    output: 50.0,
  },
  "openai/gpt-5-chat": {
    id: "openai/gpt-5-chat",
    input: 10.0,
    output: 50.0,
  },
  "openai/gpt-5-mini": {
    id: "openai/gpt-5-mini",
    input: 0.15,
    output: 0.60,
  },
  "openai/o3": {
    id: "openai/o3",
    input: 60.0,
    output: 240.0,
  },
  "openai/o4-mini-high": {
    id: "openai/o4-mini-high",
    input: 5.0,
    output: 20.0,
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    input: 15.0,
    output: 60.0,
  },

  // GPT-5 Codex
  "openai/gpt-5-codex": {
    id: "openai/gpt-5-codex",
    input: 5.0,
    output: 20.0,
  },
  "openai/gpt-5.1-codex": {
    id: "openai/gpt-5.1-codex",
    input: 5.0,
    output: 20.0,
  },

  // Gemini (Google)
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    input: 1.25,
    output: 5.0,
  },
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash",
    input: 0.075,
    output: 0.30,
  },
  "google/gemini-3-pro": {
    id: "google/gemini-3-pro",
    input: 1.25,
    output: 5.0,
  },
  "google/gemini-3-flash": {
    id: "google/gemini-3-flash",
    input: 0.075,
    output: 0.30,
  },
  "google/gemini-3.1-pro": {
    id: "google/gemini-3.1-pro",
    input: 1.25,
    output: 5.0,
  },
  "google/kimi-k2-thinking": {
    id: "google/kimi-k2-thinking",
    input: 0.5,
    output: 2.0,
  },
  "ai-studio/gemini-2.5-pro": {
    id: "ai-studio/gemini-2.5-pro",
    input: 1.25,
    output: 5.0,
  },
  "ai-studio/gemini-2.5-flash": {
    id: "ai-studio/gemini-2.5-flash",
    input: 0.075,
    output: 0.30,
  },
  "ai-studio/gemini-3-pro": {
    id: "ai-studio/gemini-3-pro",
    input: 1.25,
    output: 5.0,
  },

  // GLM (Cerebras / Z.AI)
  "cerebras/glm-4.6": {
    id: "cerebras/glm-4.6",
    input: 0.6,
    output: 0.6,
  },
  "cerebras/glm-4.7": {
    id: "cerebras/glm-4.7",
    input: 0.5,
    output: 0.5,
  },
  "z.ai/glm-4.6": {
    id: "z.ai/glm-4.6",
    input: 0.6,
    output: 0.6,
  },
  "z.ai/glm-4.7": {
    id: "z.ai/glm-4.7",
    input: 0.5,
    output: 0.5,
  },
  "cerebras/gpt-oss-120b": {
    id: "cerebras/gpt-oss-120b",
    input: 0.3,
    output: 0.3,
  },
  "hf:zai-org/GLM-4.7": {
    id: "hf:zai-org/GLM-4.7",
    input: 0.5,
    output: 0.5,
  },
  "hf:zai-org/GLM-4.6": {
    id: "hf:zai-org/GLM-4.6",
    input: 0.6,
    output: 0.6,
  },
  "hf:zai-org/GLM-4.5": {
    id: "hf:zai-org/GLM-4.5",
    input: 0.7,
    output: 0.7,
  },

  // DeepSeek (HuggingFace)
  "hf:deepseek-ai/DeepSeek-V3": {
    id: "hf:deepseek-ai/DeepSeek-V3",
    input: 0.14,
    output: 2.8,
  },
  "hf:deepseek-ai/DeepSeek-V3.1": {
    id: "hf:deepseek-ai/DeepSeek-V3.1",
    input: 0.14,
    output: 2.8,
  },
  "hf:deepseek-ai/DeepSeek-V3.1-Terminus": {
    id: "hf:deepseek-ai/DeepSeek-V3.1-Terminus",
    input: 0.14,
    output: 2.8,
  },
  "hf:deepseek-ai/DeepSeek-V3.2": {
    id: "hf:deepseek-ai/DeepSeek-V3.2",
    input: 0.14,
    output: 2.8,
  },
  "hf:deepseek-ai/DeepSeek-V3-0324": {
    id: "hf:deepseek-ai/DeepSeek-V3-0324",
    input: 0.14,
    output: 2.8,
  },
  "hf:deepseek-ai/DeepSeek-R1-0528": {
    id: "hf:deepseek-ai/DeepSeek-R1-0528",
    input: 0.55,
    output: 11.0,
  },

  // Kimi / Moonshot AI
  "synthetic/Kimi-K2-Thinking": {
    id: "synthetic/Kimi-K2-Thinking",
    input: 0.0,
    output: 0.0,
  },
  "hf:moonshotai/Kimi-K2.5": {
    id: "hf:moonshotai/Kimi-K2.5",
    input: 0.5,
    output: 2.0,
  },
  "hf:nvidia/Kimi-K2.5-NVFP4": {
    id: "hf:nvidia/Kimi-K2.5-NVFP4",
    input: 0.3,
    output: 0.3,
  },
  "hf:moonshotai/Kimi-K2-Thinking": {
    id: "hf:moonshotai/Kimi-K2-Thinking",
    input: 0.5,
    output: 2.0,
  },
  "hf:moonshotai/Kimi-K2-Instruct-0905": {
    id: "hf:moonshotai/Kimi-K2-Instruct-0905",
    input: 0.5,
    output: 2.0,
  },

  // MiniMax
  "synthetic/Kimi-K2.5": {
    id: "synthetic/Kimi-K2.5",
    input: 0.0,
    output: 0.0,
  },
  "synthetic/MiniMax-M2.1": {
    id: "synthetic/MiniMax-M2.1",
    input: 0.0,
    output: 0.0,
  },
  "hf:MiniMaxAI/MiniMax-M2.1": {
    id: "hf:MiniMaxAI/MiniMax-M2.1",
    input: 0.15,
    output: 0.6,
  },

  // Llama (Meta)
  "hf:meta-llama/Llama-3.3-70B-Instruct": {
    id: "hf:meta-llama/Llama-3.3-70B-Instruct",
    input: 0.3,
    output: 0.3,
  },
  "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
    id: "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    input: 0.15,
    output: 0.15,
  },

  // Qwen
  "hf:Qwen/Qwen3-235B-A22B-Instruct-2507": {
    id: "hf:Qwen/Qwen3-235B-A22B-Instruct-2507",
    input: 2.0,
    output: 2.0,
  },
  "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct": {
    id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
    input: 3.0,
    output: 3.0,
  },
  "hf:Qwen/Qwen3-VL-235B-A22B-Instruct": {
    id: "hf:Qwen/Qwen3-VL-235B-A22B-Instruct",
    input: 2.0,
    output: 2.0,
  },
  "hf:Qwen/Qwen3-235B-A22B-Thinking-2507": {
    id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    input: 2.0,
    output: 2.0,
  },

  // GPT-OSS
  "hf:openai/gpt-oss-120b": {
    id: "hf:openai/gpt-oss-120b",
    input: 0.3,
    output: 0.3,
  },

  // Synthetic models (test/dev - typically free or nominal cost)
  "synthetic/GLM-4.7": {
    id: "synthetic/GLM-4.7",
    input: 0.0,
    output: 0.0,
  },
  "synthetic/gpt-oss-120b": {
    id: "synthetic/gpt-oss-120b",
    input: 0.0,
    output: 0.0,
  },
  "synthetic/llama-3.1-abliterated": {
    id: "synthetic/llama-3.1-abliterated",
    input: 0.0,
    output: 0.0,
  },
  "synthetic/Kimi-K2.5-Nvidia": {
    id: "synthetic/Kimi-K2.5-Nvidia",
    input: 0.0,
    output: 0.0,
  },
  "synthetic/DeepSeek-V3.2": {
    id: "synthetic/DeepSeek-V3.2",
    input: 0.0,
    output: 0.0,
  },

  // Grok (xAI)
  "xai/grok-3": {
    id: "xai/grok-3",
    input: 5.0,
    output: 50.0,
  },
  "xai/grok-4": {
    id: "xai/grok-4",
    input: 5.0,
    output: 50.0,
  },
  "xai/grok-4-fast": {
    id: "xai/grok-4-fast",
    input: 2.5,
    output: 25.0,
  },
  "xai/grok-4-1-fast": {
    id: "xai/grok-4-1-fast",
    input: 2.5,
    output: 25.0,
  },
  "xai/grok-4-1-fast-reasoning": {
    id: "xai/grok-4-1-fast-reasoning",
    input: 5.0,
    output: 50.0,
  },
  "xai/grok-code-fast": {
    id: "xai/grok-code-fast",
    input: 2.5,
    output: 25.0,
  },

  // Fireworks models
  "fireworks/llama4-maverick": {
    id: "fireworks/llama4-maverick",
    input: 0.15,
    output: 0.15,
  },
  "fireworks/deepseek-v3": {
    id: "fireworks/deepseek-v3",
    input: 0.14,
    output: 2.8,
  },
  "fireworks/deepseek-r1": {
    id: "fireworks/deepseek-r1",
    input: 0.55,
    output: 11.0,
  },
  "fireworks/deepseek-v3.1": {
    id: "fireworks/deepseek-v3.1",
    input: 0.14,
    output: 2.8,
  },
  "fireworks/deepseek-v3.1-terminus": {
    id: "fireworks/deepseek-v3.1-terminus",
    input: 0.14,
    output: 2.8,
  },
  "fireworks/glm-4.5": {
    id: "fireworks/glm-4.5",
    input: 0.5,
    output: 0.5,
  },
  "fireworks/glm-4.6": {
    id: "fireworks/glm-4.6",
    input: 0.6,
    output: 0.6,
  },

  // Groq models
  "groq/llama-4-maverick": {
    id: "groq/llama-4-maverick",
    input: 0.15,
    output: 0.15,
  },
  "groq/gpt-oss-20b": {
    id: "groq/gpt-oss-20b",
    input: 0.1,
    output: 0.1,
  },
  "groq/gpt-oss-120b": {
    id: "groq/gpt-oss-120b",
    input: 0.3,
    output: 0.3,
  },

  // OpenRouter
  "openrouter/gemini-3-pro": {
    id: "openrouter/gemini-3-pro",
    input: 1.25,
    output: 5.0,
  },
  "openrouter/google/gemini-2.5-pro": {
    id: "openrouter/google/gemini-2.5-pro",
    input: 1.25,
    output: 5.0,
  },
  "openrouter/google/gemini-2.5-flash": {
    id: "openrouter/google/gemini-2.5-flash",
    input: 0.075,
    output: 0.30,
  },
  "openrouter/gpt-oss-120b": {
    id: "openrouter/gpt-oss-120b",
    input: 0.3,
    output: 0.3,
  },
  "openrouter/minimax-m2": {
    id: "openrouter/minimax-m2",
    input: 0.15,
    output: 0.6,
  },

  // Vertex AI variants
  "vertex_ai/claude-opus-4-5": {
    id: "vertex_ai/claude-opus-4-5",
    input: 15.0,
    output: 75.0,
  },

  // Embeddings (generally lower cost)
  "openai/text-embedding-3-small": {
    id: "openai/text-embedding-3-small",
    input: 0.02,
    output: 0.0,
  },
  "openai/text-embedding-3-large": {
    id: "openai/text-embedding-3-large",
    input: 0.13,
    output: 0.0,
  },
  "mistral/mistral-embed": {
    id: "mistral/mistral-embed",
    input: 0.02,
    output: 0.0,
  },
  "google/gemini-embedding-001": {
    id: "google/gemini-embedding-001",
    input: 0.01,
    output: 0.0,
  },

};

/**
 * Fallback pricing for unknown models.
 */
export const DEFAULT_FALLBACK_PRICING: ModelPrice = {
  id: "default",
  input: 2.0,
  output: 8.0,
};

/**
 * Get pricing for a specific model ID.
 * Returns undefined if the model is not found.
 */
export function getModelPricing(modelId: string): ModelPrice | undefined {
  // Direct lookup
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try without provider prefix for known patterns
  const patterns: Array<[string, string]> = [
    ["anthropic/", ""],
    ["openai/", ""],
    ["google/", ""],
    ["cerebras/", ""],
    ["xai/", ""],
    ["fireworks/", ""],
    ["groq/", ""],
    ["ai-studio/", ""],
    ["openrouter/", ""],
    ["vertex_ai/", ""],
    ["claude/", ""],
    ["z.ai/", ""],
    ["synthetic/", ""],  // synthetic provider wraps other models - strip prefix
  ];

  for (const [prefix, replacement] of patterns) {
    if (modelId.startsWith(prefix)) {
      const baseId = replacement + modelId.slice(prefix.length);
      if (MODEL_PRICING[baseId]) {
        return MODEL_PRICING[baseId];
      }
    }
  }

  return undefined;
}

/**
 * Get pricing for a model with fallback.
 * Returns a fallback pricing entry if the model is not found.
 */
export function getModelPricingWithFallback(modelId: string): ModelPrice {
  const pricing = getModelPricing(modelId);
  if (pricing) {
    return pricing;
  }

  // Return default fallback
  return {
    id: modelId,
    input: DEFAULT_FALLBACK_PRICING.input,
    output: DEFAULT_FALLBACK_PRICING.output,
    cacheRead: DEFAULT_FALLBACK_PRICING.cacheRead,
    cacheWrite: DEFAULT_FALLBACK_PRICING.cacheWrite,
  };
}

/**
 * Check if pricing is effectively zero.
 */
export function isZeroPricing(pricing: ModelPrice): boolean {
  return pricing.input === 0 && pricing.output === 0 &&
    (pricing.cacheRead ?? 0) === 0 && (pricing.cacheWrite ?? 0) === 0;
}