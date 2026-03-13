import { describe, expect, it } from "vitest";

function applyCompactionAbortHandling(params: {
  yieldDetected: boolean;
  aborted: boolean;
  err: unknown;
}): { aborted: boolean; promptErrorSet: boolean } {
  let { aborted } = params;
  let promptError: unknown = null;
  const err = params.err;
  const isRunnerAbortError = (value: unknown): value is Error => {
    return value instanceof Error && value.name === "AbortError";
  };

  const yieldCompactionAbort =
    params.yieldDetected &&
    isRunnerAbortError(err) &&
    err instanceof Error &&
    err.cause === "sessions_yield";

  if (yieldCompactionAbort) {
    aborted = false;
  } else if (isRunnerAbortError(err)) {
    if (!promptError) {
      promptError = err;
    }
  } else {
    throw err;
  }

  return { aborted, promptErrorSet: Boolean(promptError) };
}

describe("runEmbeddedAttempt yield abort handling", () => {
  it("treats compaction abort from sessions_yield as graceful", () => {
    const err = new Error("aborted", { cause: "sessions_yield" });
    err.name = "AbortError";

    const result = applyCompactionAbortHandling({
      yieldDetected: true,
      aborted: true,
      err,
    });

    expect(result).toEqual({ aborted: false, promptErrorSet: false });
  });

  it("keeps non-yield aborts marked as aborted", () => {
    const err = new Error("aborted", { cause: "manual_stop" });
    err.name = "AbortError";

    const result = applyCompactionAbortHandling({
      yieldDetected: false,
      aborted: true,
      err,
    });

    expect(result).toEqual({ aborted: true, promptErrorSet: true });
  });
});
