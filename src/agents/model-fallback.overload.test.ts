import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback.js";

function makeOverloadCfg(overloadFallback: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: ["openai/gpt-4.1-mini"],
          overloadFallback,
        },
      },
    },
  } as OpenClawConfig;
}

function makeOverloadCfgNoFallbacks(overloadFallback: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-sonnet-4-6",
          overloadFallback,
        },
      },
    },
  } as OpenClawConfig;
}

function makeOverloadError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function makeFailoverOverloadError(provider: string, model: string): FailoverError {
  return new FailoverError("overloaded_error", {
    reason: "overloaded",
    provider,
    model,
    status: 529,
  });
}

describe("runWithModelFallback – overload fallback", () => {
  it("uses overloadFallback model on 529 overloaded error", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.overloadFallbackUsed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("uses overloadFallback model on 503 service unavailable", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(503, "service unavailable"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.overloadFallbackUsed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("uses overloadFallback on Anthropic overloaded_error message", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeFailoverOverloadError("anthropic", "claude-sonnet-4-6"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.overloadFallbackUsed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("does not cascade overload fallback (max 1 retry)", async () => {
    const cfg = makeOverloadCfgNoFallbacks("openai-codex/gpt-5.4");
    const overloadErr1 = makeOverloadError(529, "overloaded");
    const overloadErr2 = makeOverloadError(529, "still overloaded");
    const run = vi
      .fn()
      .mockRejectedValueOnce(overloadErr1)
      .mockRejectedValueOnce(overloadErr2)
      .mockResolvedValueOnce("should not reach");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      }),
    ).rejects.toThrow();

    // Primary + overload fallback = 2 calls, no cascade
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not use overloadFallback when not configured", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    } as OpenClawConfig;
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok");

    // Without overloadFallback and no regular fallbacks, it should throw
    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        run,
      }),
    ).rejects.toThrow();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("sets overloadFallbackUsed=true only when overload fallback succeeds", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.overloadFallbackUsed).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tries overload fallback before regular fallback chain on overload", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok from overload fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from overload fallback");
    expect(result.overloadFallbackUsed).toBe(true);
    // Should NOT have tried the regular fallback (openai/gpt-4.1-mini)
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("falls through to regular fallbacks when overload fallback also fails", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockRejectedValueOnce(
        Object.assign(new Error("overload fallback auth error"), { status: 401 }),
      )
      .mockResolvedValueOnce("ok from regular fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from regular fallback");
    expect(result.overloadFallbackUsed).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
    // Call order: primary -> overload fallback -> regular fallback
    expect(run.mock.calls[0]?.[0]).toBe("anthropic");
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
    expect(run.mock.calls[2]?.[0]).toBe("openai");
    expect(run.mock.calls[2]?.[1]).toBe("gpt-4.1-mini");
  });

  it("does not inject overload fallback on non-overload errors", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("auth error"), { status: 401 }))
      .mockResolvedValueOnce("ok from regular fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from regular fallback");
    expect(result.overloadFallbackUsed).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    // Should use regular fallback, not overload fallback
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("moves overload fallback to front when it appears later in the fallback chain", async () => {
    // overloadFallback is gpt-4.1-mini, which is ALSO a regular fallback.
    // On overload, it should be moved to be tried immediately (not after other fallbacks).
    const cfg = makeOverloadCfg("openai/gpt-4.1-mini");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok from overload model (was regular fallback)");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from overload model (was regular fallback)");
    // primary + moved-to-front overload fallback = 2 calls total
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");
  });

  it("prioritises overload fallback over regular fallbacks when overload fallback appears further in the chain", async () => {
    // fallbacks: ["openai/gpt-4.1-mini", "openai-codex/gpt-5.4"], overloadFallback: "openai-codex/gpt-5.4"
    // On overload of primary, gpt-5.4 should jump ahead of gpt-4.1-mini.
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-4.1-mini", "openai-codex/gpt-5.4"],
            overloadFallback: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok from gpt-5.4");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from gpt-5.4");
    expect(result.overloadFallbackUsed).toBe(true);
    // primary overloads → gpt-5.4 moved to front → tried next (not gpt-4.1-mini)
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("records overload attempts in the attempts array", async () => {
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason).toBe("overloaded");
    expect(result.attempts[0]?.provider).toBe("anthropic");
    expect(result.attempts[0]?.model).toBe("claude-sonnet-4-6");
  });

  it("skips overload fallback when it is not in the model allowlist", async () => {
    // Config with an allowlist (agents.defaults.models) that does NOT include the overload fallback
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-4.1-mini"],
            overloadFallback: "openai-codex/gpt-5.4",
          },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-4.1-mini": {},
            // Note: openai-codex/gpt-5.4 is NOT in the allowlist
          },
        },
      },
    } as OpenClawConfig;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok from regular fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from regular fallback");
    expect(result.overloadFallbackUsed).toBeUndefined();
    // Should go primary -> regular fallback (NOT overload fallback)
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-4.1-mini");

    // Should have logged a warning about the allowlist skip
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped: not in configured model allowlist"),
    );
    warnSpy.mockRestore();
  });

  it("uses overload fallback when it IS in the model allowlist", async () => {
    // Config with an allowlist that includes the overload fallback
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["openai/gpt-4.1-mini"],
            overloadFallback: "openai-codex/gpt-5.4",
          },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-4.1-mini": {},
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    } as OpenClawConfig;

    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok from overload fallback");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok from overload fallback");
    expect(result.overloadFallbackUsed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });

  it("uses overload fallback when no allowlist is configured (no models map)", async () => {
    // Config without agents.defaults.models - no allowlist enforcement
    const cfg = makeOverloadCfg("openai-codex/gpt-5.4");
    const run = vi
      .fn()
      .mockRejectedValueOnce(makeOverloadError(529, "overloaded"))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.overloadFallbackUsed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe("openai-codex");
    expect(run.mock.calls[1]?.[1]).toBe("gpt-5.4");
  });
});
