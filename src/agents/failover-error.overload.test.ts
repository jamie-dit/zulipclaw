import { describe, expect, it } from "vitest";
import { resolveFailoverReasonFromError, resolveFailoverStatus } from "./failover-error.js";

describe("failover-error – overloaded reason", () => {
  describe("resolveFailoverStatus", () => {
    it("returns 529 for overloaded reason", () => {
      expect(resolveFailoverStatus("overloaded")).toBe(529);
    });

    it("returns 429 for rate_limit reason", () => {
      expect(resolveFailoverStatus("rate_limit")).toBe(429);
    });
  });

  describe("resolveFailoverReasonFromError", () => {
    it("returns overloaded for status 503", () => {
      const err = Object.assign(new Error("service unavailable"), { status: 503 });
      expect(resolveFailoverReasonFromError(err)).toBe("overloaded");
    });

    it("returns overloaded for status 529", () => {
      const err = Object.assign(new Error("overloaded"), { status: 529 });
      expect(resolveFailoverReasonFromError(err)).toBe("overloaded");
    });

    it("returns rate_limit for status 429", () => {
      const err = Object.assign(new Error("rate limited"), { status: 429 });
      expect(resolveFailoverReasonFromError(err)).toBe("rate_limit");
    });

    it("returns auth for status 401", () => {
      const err = Object.assign(new Error("unauthorized"), { status: 401 });
      expect(resolveFailoverReasonFromError(err)).toBe("auth");
    });
  });
});
