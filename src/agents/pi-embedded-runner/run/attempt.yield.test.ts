import { describe, expect, it } from "vitest";

/**
 * Simulates the compaction-wait guard in runEmbeddedAttempt.
 *
 * When `yieldAborted` is true the compaction wait is skipped entirely
 * (the abort controller is already signalled so abortable() would
 * immediately reject).  This avoids setting a spurious promptError
 * that the caller would treat as a real failure.
 */
function simulateCompactionWaitGuard(params: {
  yieldAborted: boolean;
  aborted: boolean;
  err: unknown;
}): { aborted: boolean; promptErrorSet: boolean; compactionWaitSkipped: boolean } {
  let { aborted } = params;
  let promptError: unknown = null;
  const isRunnerAbortError = (value: unknown): value is Error => {
    return value instanceof Error && value.name === "AbortError";
  };

  if (params.yieldAborted) {
    // Compaction wait is skipped entirely — no error to handle.
    return { aborted, promptErrorSet: false, compactionWaitSkipped: true };
  }

  // Non-yield path: compaction wait runs and may throw.
  const err = params.err;
  if (isRunnerAbortError(err)) {
    if (!promptError) {
      promptError = err;
    }
  } else {
    throw err;
  }

  return { aborted, promptErrorSet: Boolean(promptError), compactionWaitSkipped: false };
}

describe("runEmbeddedAttempt yield abort handling", () => {
  it("skips compaction wait when yieldAborted is true", () => {
    const result = simulateCompactionWaitGuard({
      yieldAborted: true,
      aborted: false,
      err: null, // no error because compaction wait is never called
    });

    expect(result).toEqual({
      aborted: false,
      promptErrorSet: false,
      compactionWaitSkipped: true,
    });
  });

  it("keeps non-yield aborts marked as aborted with promptError", () => {
    const err = new Error("aborted", { cause: "manual_stop" });
    err.name = "AbortError";

    const result = simulateCompactionWaitGuard({
      yieldAborted: false,
      aborted: true,
      err,
    });

    expect(result).toEqual({
      aborted: true,
      promptErrorSet: true,
      compactionWaitSkipped: false,
    });
  });

  it("propagates non-abort errors in compaction wait", () => {
    const err = new TypeError("unexpected error");

    expect(() =>
      simulateCompactionWaitGuard({
        yieldAborted: false,
        aborted: false,
        err,
      }),
    ).toThrow("unexpected error");
  });
});
