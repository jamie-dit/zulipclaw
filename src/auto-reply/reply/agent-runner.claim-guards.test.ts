/**
 * Unit tests for the runtime claim guards in agent-runner.ts.
 *
 * Guards are reply-time validators that detect unsupported claims in the
 * assistant's reply text and append a transparent correction footnote.
 *
 * Two guards are covered:
 *   1. Stale sub-agent status claims  (hasStaleSubagentStatusClaim)
 *   2. Unsupported activity narration (hasUnsupportedActivityNarration)
 */
import { describe, expect, it } from "vitest";
import {
  hasStaleSubagentStatusClaim,
  hasUnsupportedActivityNarration,
  STALE_SUBAGENT_STATUS_NOTE,
  UNSUPPORTED_ACTIVITY_NOTE,
} from "./agent-runner.js";

// ---------------------------------------------------------------------------
// 1. Stale sub-agent status guard
// ---------------------------------------------------------------------------

describe("hasStaleSubagentStatusClaim", () => {
  it("returns true for 'it's still running' with no tool calls", () => {
    expect(hasStaleSubagentStatusClaim("The task, it's still running.", [])).toBe(true);
  });

  it("returns true for 'it is still running' with no tool calls", () => {
    expect(
      hasStaleSubagentStatusClaim("The sub-agent is still running in the background.", []),
    ).toBe(true);
  });

  it("returns true for 'the sub-agent is still running' with unrelated tools", () => {
    expect(
      hasStaleSubagentStatusClaim("The sub-agent is still running.", ["exec", "web_search"]),
    ).toBe(true);
  });

  it("returns true for 'hasn't finished yet'", () => {
    expect(hasStaleSubagentStatusClaim("The job hasn't finished yet.", [])).toBe(true);
  });

  it("returns true for 'has not finished yet'", () => {
    expect(hasStaleSubagentStatusClaim("It has not finished yet, please wait.", [])).toBe(true);
  });

  it("returns true for 'currently running' referring to a run", () => {
    expect(hasStaleSubagentStatusClaim("The process is currently running.", [])).toBe(true);
  });

  it("returns false when subagents tool was called (live check present)", () => {
    expect(hasStaleSubagentStatusClaim("The sub-agent is still running.", ["subagents"])).toBe(
      false,
    );
  });

  it("returns false when sessions_list was called (live check present)", () => {
    expect(hasStaleSubagentStatusClaim("The task is still running.", ["sessions_list"])).toBe(
      false,
    );
  });

  it("returns false for neutral text with no status claim", () => {
    expect(hasStaleSubagentStatusClaim("The sub-agent finished successfully.", [])).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasStaleSubagentStatusClaim("", [])).toBe(false);
  });

  it("returns false when the note is already present (idempotent)", () => {
    const text = `Some reply.\n\n${STALE_SUBAGENT_STATUS_NOTE}`;
    expect(hasStaleSubagentStatusClaim(text, [])).toBe(false);
  });

  it("does not match 'still running' in unrelated process context", () => {
    // Process tool output like "Process still running." should not trigger the guard
    // because the guard requires "it's/it is" or "sub-agent/task/etc" as subject.
    expect(hasStaleSubagentStatusClaim("Process still running.", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Unsupported activity narration guard
// ---------------------------------------------------------------------------

describe("hasUnsupportedActivityNarration", () => {
  it("returns true for 'I'm checking' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I'm checking the logs.", [])).toBe(true);
  });

  it("returns true for 'I am checking' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I am checking right now.", [])).toBe(true);
  });

  it("returns true for 'I'm tracing' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I'm tracing the issue.", [])).toBe(true);
  });

  it("returns true for 'I'm investigating' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I'm investigating the error.", [])).toBe(true);
  });

  it("returns true for 'I'm looking into it' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I'm looking into it right now.", [])).toBe(true);
  });

  it("returns true for 'checking now' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("Checking now, should have a result soon.", [])).toBe(
      true,
    );
  });

  it("returns true for 'I'm searching' with no tool calls", () => {
    expect(hasUnsupportedActivityNarration("I'm searching for the file.", [])).toBe(true);
  });

  it("returns false when exec was called (activity is backed)", () => {
    expect(hasUnsupportedActivityNarration("I'm checking the logs.", ["exec"])).toBe(false);
  });

  it("returns false when web_search was called (activity is backed)", () => {
    expect(hasUnsupportedActivityNarration("I'm searching the web.", ["web_search"])).toBe(false);
  });

  it("returns false when Read was called (activity is backed)", () => {
    expect(hasUnsupportedActivityNarration("I'm checking the file.", ["read"])).toBe(false);
  });

  it("returns false for 'I'm happy to help' (not an activity claim)", () => {
    expect(hasUnsupportedActivityNarration("I'm happy to help you with this.", [])).toBe(false);
  });

  it("returns false for 'I'm not sure' (not an activity claim)", () => {
    expect(hasUnsupportedActivityNarration("I'm not sure about this.", [])).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasUnsupportedActivityNarration("", [])).toBe(false);
  });

  it("returns false when the note is already present (idempotent)", () => {
    const text = `Some reply.\n\n${UNSUPPORTED_ACTIVITY_NOTE}`;
    expect(hasUnsupportedActivityNarration(text, [])).toBe(false);
  });

  it("does not trigger on passive description without present progressive", () => {
    // "I will check" is a future commitment, not a present-tense activity claim
    expect(hasUnsupportedActivityNarration("I will check on this for you.", [])).toBe(false);
  });
});
