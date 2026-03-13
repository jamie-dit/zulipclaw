import { describe, expect, it } from "vitest";
import { normalizeFastMode } from "./thinking.js";

describe("normalizeFastMode", () => {
  it("returns true for boolean true", () => {
    expect(normalizeFastMode(true)).toBe(true);
  });

  it("returns false for boolean false", () => {
    expect(normalizeFastMode(false)).toBe(false);
  });

  it("returns undefined for null/undefined", () => {
    expect(normalizeFastMode(null)).toBeUndefined();
    expect(normalizeFastMode(undefined)).toBeUndefined();
    expect(normalizeFastMode("")).toBeUndefined();
  });

  it("normalizes truthy strings", () => {
    for (const val of ["on", "true", "yes", "1", "enable", "enabled", "fast"]) {
      expect(normalizeFastMode(val)).toBe(true);
      expect(normalizeFastMode(val.toUpperCase())).toBe(true);
    }
  });

  it("normalizes falsy strings", () => {
    for (const val of ["off", "false", "no", "0", "disable", "disabled", "normal"]) {
      expect(normalizeFastMode(val)).toBe(false);
      expect(normalizeFastMode(val.toUpperCase())).toBe(false);
    }
  });

  it("returns undefined for unrecognized strings", () => {
    expect(normalizeFastMode("maybe")).toBeUndefined();
    expect(normalizeFastMode("turbo")).toBeUndefined();
  });
});
