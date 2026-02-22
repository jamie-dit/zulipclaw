const CLAUDE_46_CONTEXT_WINDOW = 200_000;

const KNOWN_CONTEXT_WINDOW_OVERRIDES = new Map<string, number>([
  ["claude-opus-4-6", CLAUDE_46_CONTEXT_WINDOW],
  ["claude-opus-4.6", CLAUDE_46_CONTEXT_WINDOW],
  ["claude-sonnet-4-6", CLAUDE_46_CONTEXT_WINDOW],
  ["claude-sonnet-4.6", CLAUDE_46_CONTEXT_WINDOW],
  ["anthropic/claude-opus-4-6", CLAUDE_46_CONTEXT_WINDOW],
  ["anthropic/claude-opus-4.6", CLAUDE_46_CONTEXT_WINDOW],
  ["anthropic/claude-sonnet-4-6", CLAUDE_46_CONTEXT_WINDOW],
  ["anthropic/claude-sonnet-4.6", CLAUDE_46_CONTEXT_WINDOW],
]);

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

export function lookupKnownModelContextWindow(modelRef?: string): number | undefined {
  const raw = typeof modelRef === "string" ? modelRef.trim() : "";
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeLookupKey(raw);
  const direct = KNOWN_CONTEXT_WINDOW_OVERRIDES.get(normalized);
  if (direct !== undefined) {
    return direct;
  }

  const segments = normalized.split("/").filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    const suffix = segments.slice(i).join("/");
    const hit = KNOWN_CONTEXT_WINDOW_OVERRIDES.get(suffix);
    if (hit !== undefined) {
      return hit;
    }
  }

  return undefined;
}

export function applyKnownModelContextWindow(params: {
  provider?: string;
  modelId?: string;
  contextWindow?: number;
}): number | undefined {
  const provider = typeof params.provider === "string" ? params.provider.trim() : "";
  const normalizedProvider = provider.toLowerCase();
  const modelId = typeof params.modelId === "string" ? params.modelId.trim() : "";

  let known: number | undefined;
  if (!provider || normalizedProvider === "anthropic") {
    known = lookupKnownModelContextWindow(modelId);
  } else if (modelId.toLowerCase().startsWith("anthropic/")) {
    // For aggregator providers (e.g. openrouter) only trust explicit anthropic-prefixed ids.
    known = lookupKnownModelContextWindow(modelId);
  }

  const current =
    typeof params.contextWindow === "number" && Number.isFinite(params.contextWindow)
      ? Math.floor(params.contextWindow)
      : undefined;

  if (!known) {
    return current;
  }
  if (!current || current <= 0) {
    return known;
  }
  return Math.max(current, known);
}

export function applyKnownModelContextWindowToModel<
  T extends { provider?: string; id?: string; contextWindow?: number },
>(model: T): T {
  const nextContextWindow = applyKnownModelContextWindow({
    provider: typeof model.provider === "string" ? model.provider : undefined,
    modelId: typeof model.id === "string" ? model.id : undefined,
    contextWindow: model.contextWindow,
  });
  if (!nextContextWindow || nextContextWindow === model.contextWindow) {
    return model;
  }
  return {
    ...model,
    contextWindow: nextContextWindow,
  };
}

export const __testing = {
  KNOWN_CONTEXT_WINDOW_OVERRIDES,
};
