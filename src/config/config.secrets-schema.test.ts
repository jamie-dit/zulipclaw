import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config secret refs schema", () => {
  it("accepts openai-codex-responses as a model api value", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [{ id: "gpt-5.3-codex", name: "gpt-5.3-codex" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid secret ref id", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "bad id with spaces" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
      ).toBe(true);
    }
  });
});
