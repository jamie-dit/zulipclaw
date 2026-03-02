import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./agent.js";

describe("resolveFallbackRetryPrompt", () => {
  it("keeps the original body for the first attempt", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "original body",
        isFallbackRetry: false,
      }),
    ).toBe("original body");
  });

  it("uses the legacy continuation prompt on first fallback retry", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "original body",
        isFallbackRetry: true,
        fallbackRetryCount: 1,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });

  it("switches to compact continuation prompt after retry cap", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "original body",
        isFallbackRetry: true,
        fallbackRetryCount: 2,
      }),
    ).toBe("Continue the same unfinished task from the latest session context.");
  });
});
