import { describe, expect, it } from "vitest";
import {
  resolveMaxConcurrentPerSession,
  DEFAULT_MAX_CONCURRENT_PER_SESSION,
} from "./agent-limits.js";
import type { OpenClawConfig } from "./types.js";

describe("resolveMaxConcurrentPerSession", () => {
  it("returns default (1) when no config", () => {
    expect(resolveMaxConcurrentPerSession()).toBe(DEFAULT_MAX_CONCURRENT_PER_SESSION);
    expect(resolveMaxConcurrentPerSession(undefined)).toBe(1);
  });

  it("returns default when messages.queue not set", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfg)).toBe(1);
  });

  it("returns default when maxConcurrentPerSession not set", () => {
    const cfg = { messages: { queue: { mode: "followup" } } } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfg)).toBe(1);
  });

  it("returns configured value", () => {
    const cfg = {
      messages: { queue: { maxConcurrentPerSession: 3 } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfg)).toBe(3);
  });

  it("clamps to minimum of 1", () => {
    const cfg = {
      messages: { queue: { maxConcurrentPerSession: 0 } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfg)).toBe(1);

    const cfgNeg = {
      messages: { queue: { maxConcurrentPerSession: -5 } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfgNeg)).toBe(1);
  });

  it("floors fractional values", () => {
    const cfg = {
      messages: { queue: { maxConcurrentPerSession: 2.7 } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfg)).toBe(2);
  });

  it("treats NaN/Infinity as default", () => {
    const cfgNan = {
      messages: { queue: { maxConcurrentPerSession: NaN } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfgNan)).toBe(1);

    const cfgInf = {
      messages: { queue: { maxConcurrentPerSession: Infinity } },
    } as OpenClawConfig;
    expect(resolveMaxConcurrentPerSession(cfgInf)).toBe(1);
  });
});
