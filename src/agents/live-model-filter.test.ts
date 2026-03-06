import { describe, expect, it } from "vitest";
import { isModernModelRef } from "./live-model-filter.js";

describe("isModernModelRef", () => {
  it("accepts openai-codex gpt-5.4", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
  });

  it("accepts openai-codex gpt-5.3-codex", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.3-codex" })).toBe(true);
  });

  it("accepts openai-codex gpt-5.3-codex-spark", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.3-codex-spark" })).toBe(true);
  });

  it("accepts openai-codex gpt-5.2-codex", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.2-codex" })).toBe(true);
  });

  it("rejects unknown openai-codex models", () => {
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-4.1-mini" })).toBe(false);
  });

  it("accepts gpt-5.4 via openrouter", () => {
    expect(isModernModelRef({ provider: "openrouter", id: "gpt-5.4" })).toBe(true);
  });

  it("rejects missing provider or id", () => {
    expect(isModernModelRef({ provider: "", id: "gpt-5.4" })).toBe(false);
    expect(isModernModelRef({ provider: "openai-codex", id: "" })).toBe(false);
  });
});
