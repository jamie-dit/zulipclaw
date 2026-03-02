import { describe, expect, it } from "vitest";
import {
  classifySubagentFailure,
  resolveFailureMetadataLabel,
  resolveSubagentOutcomeStatusLabel,
} from "./subagent-outcome.js";

describe("subagent outcome classification", () => {
  it("classifies wait/lifecycle timeout as run_timeout", () => {
    expect(classifySubagentFailure({ status: "timeout" })).toBe("run_timeout");
  });

  it("classifies aggregated model timeout errors as model_attempt_timeout", () => {
    const error =
      "All models failed (2): openai/gpt-5: Request timed out after 120000ms (timeout) | synthetic/gpt-5: Request timed out after 120000ms (timeout)";
    expect(classifySubagentFailure({ status: "error", error })).toBe("model_attempt_timeout");
  });

  it("classifies aborted/cancelled errors as aborted_by_cancel", () => {
    expect(
      classifySubagentFailure({
        status: "error",
        error: "AbortError: Request was aborted while waiting for tool result",
      }),
    ).toBe("aborted_by_cancel");
  });

  it("formats user-facing status labels with timeout source details", () => {
    expect(
      resolveSubagentOutcomeStatusLabel({
        status: "error",
        error: "All models failed (1): openai/gpt-5: Request timed out after 120000ms (timeout)",
      }),
    ).toContain("model attempt timed out");

    expect(resolveSubagentOutcomeStatusLabel({ status: "timeout" })).toContain("run timeout");
    expect(
      resolveSubagentOutcomeStatusLabel({
        status: "error",
        error: "Request was aborted",
      }),
    ).toContain("cancelled");
  });

  it("emits metadata labels for classified failures", () => {
    expect(resolveFailureMetadataLabel({ status: "timeout" })).toBe("run_timeout");
    expect(resolveFailureMetadataLabel({ status: "error", error: "Request was aborted" })).toBe(
      "aborted_by_cancel",
    );
  });
});
