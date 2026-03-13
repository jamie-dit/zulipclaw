import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfiguredFastMode, resolveFastModeParam, resolveFastModeState } from "./fast-mode.js";

describe("resolveFastModeParam", () => {
  it("returns undefined for empty/missing params", () => {
    expect(resolveFastModeParam(undefined)).toBeUndefined();
    expect(resolveFastModeParam({})).toBeUndefined();
  });

  it("resolves fastMode from params", () => {
    expect(resolveFastModeParam({ fastMode: true })).toBe(true);
    expect(resolveFastModeParam({ fastMode: "on" })).toBe(true);
    expect(resolveFastModeParam({ fastMode: "off" })).toBe(false);
  });

  it("resolves fast_mode alias", () => {
    expect(resolveFastModeParam({ fast_mode: true })).toBe(true);
    expect(resolveFastModeParam({ fast_mode: "on" })).toBe(true);
  });
});

describe("resolveConfiguredFastMode", () => {
  it("returns false when no config model", () => {
    expect(resolveConfiguredFastMode({ cfg: undefined, provider: "openai", model: "gpt-5" })).toBe(false);
  });

  it("reads fastMode from model config", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: { fastMode: true },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveConfiguredFastMode({ cfg, provider: "openai", model: "gpt-5" })).toBe(true);
  });
});

describe("resolveFastModeState", () => {
  it("defaults to disabled", () => {
    const state = resolveFastModeState({
      cfg: undefined,
      provider: "openai",
      model: "gpt-5",
    });
    expect(state).toEqual({ enabled: false, source: "default" });
  });

  it("prefers session override", () => {
    const state = resolveFastModeState({
      cfg: undefined,
      provider: "openai",
      model: "gpt-5",
      sessionEntry: { fastMode: true },
    });
    expect(state).toEqual({ enabled: true, source: "session" });
  });

  it("falls back to config", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: { fastMode: "on" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const state = resolveFastModeState({
      cfg,
      provider: "openai",
      model: "gpt-5",
    });
    expect(state).toEqual({ enabled: true, source: "config" });
  });
});
