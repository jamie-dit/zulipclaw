import { describe, expect, it } from "vitest";
import {
  MESSAGE_ACTION_TARGET_MODE,
  actionHasTarget,
  actionRequiresTarget,
} from "./message-action-spec.js";

describe("message action search target semantics", () => {
  it("marks search as a target-taking action", () => {
    expect(MESSAGE_ACTION_TARGET_MODE.search).toBe("to");
    expect(actionRequiresTarget("search")).toBe(true);
  });

  it("treats mapped to values as satisfying search target requirements", () => {
    expect(actionHasTarget("search", { to: "general" })).toBe(true);
    expect(actionHasTarget("search", { to: "" })).toBe(false);
  });
});
