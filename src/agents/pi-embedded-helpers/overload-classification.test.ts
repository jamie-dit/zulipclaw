import { describe, expect, it } from "vitest";
import { classifyFailoverReason, isOverloadHttpError } from "./errors.js";

describe("isOverloadHttpError", () => {
  it("returns true for 503 status", () => {
    expect(isOverloadHttpError("503 Service Unavailable")).toBe(true);
  });

  it("returns true for 529 status", () => {
    expect(isOverloadHttpError("529 overloaded")).toBe(true);
  });

  it("returns false for 500 internal server error", () => {
    expect(isOverloadHttpError("500 Internal Server Error")).toBe(false);
  });

  it("returns false for 502 bad gateway", () => {
    expect(isOverloadHttpError("502 Bad Gateway")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isOverloadHttpError("")).toBe(false);
  });

  it("returns false for non-HTTP error", () => {
    expect(isOverloadHttpError("some random error")).toBe(false);
  });
});

describe("classifyFailoverReason – overloaded classification", () => {
  it("classifies 503 as overloaded", () => {
    expect(classifyFailoverReason("503 Service Unavailable")).toBe("overloaded");
  });

  it("classifies 529 as overloaded", () => {
    expect(classifyFailoverReason("529 overloaded")).toBe("overloaded");
  });

  it("classifies overloaded_error pattern as overloaded", () => {
    expect(classifyFailoverReason('{"type":"overloaded_error"}')).toBe("overloaded");
  });

  it("classifies overloaded text as overloaded", () => {
    expect(classifyFailoverReason("overloaded")).toBe("overloaded");
  });

  it("still classifies 500 as timeout (transient)", () => {
    expect(classifyFailoverReason("500 Internal Server Error")).toBe("timeout");
  });

  it("still classifies 502 as timeout (transient)", () => {
    expect(classifyFailoverReason("502 Bad Gateway")).toBe("timeout");
  });

  it("still classifies rate limit as rate_limit", () => {
    expect(classifyFailoverReason("rate limit exceeded")).toBe("rate_limit");
  });
});
