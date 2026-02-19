import { describe, expect, it } from "vitest";
import { formatToolElapsed } from "./subagent-relay.js";

describe("subagent-relay", () => {
  describe("formatToolElapsed", () => {
    it("formats 0 seconds as +0:00", () => {
      expect(formatToolElapsed(1000, 1000)).toBe("+0:00");
    });

    it("formats 5 seconds as +0:05", () => {
      expect(formatToolElapsed(1000, 6000)).toBe("+0:05");
    });

    it("formats 65 seconds as +1:05", () => {
      expect(formatToolElapsed(1000, 66000)).toBe("+1:05");
    });

    it("formats 3661 seconds as +1:01:01", () => {
      expect(formatToolElapsed(1000, 3662000)).toBe("+1:01:01");
    });

    it("clamps negative elapsed time to +0:00", () => {
      expect(formatToolElapsed(10000, 1000)).toBe("+0:00");
    });

    it("does not emit NaN for invalid timestamps", () => {
      expect(formatToolElapsed(Number.NaN as unknown as number, 1000)).toBe("+0:00");
      expect(formatToolElapsed(1000, Number.NaN as unknown as number)).toBe("+0:00");
      expect(
        formatToolElapsed(undefined as unknown as number, undefined as unknown as number),
      ).toBe("+0:00");
    });
  });
});
