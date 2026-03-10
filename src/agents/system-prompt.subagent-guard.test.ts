/**
 * Tests for the sub-agent status guard in the system prompt.
 * Verifies that the exported guard constant (SUBAGENT_STATUS_GUARD_LINE)
 * contains the correct defensive instruction preventing the assistant from
 * claiming a sub-agent is still running without checking live status.
 *
 * Covers: fix for sub-agent completion visibility bug (issue #198)
 */
import { describe, expect, it } from "vitest";
import { SUBAGENT_STATUS_GUARD_LINE } from "./system-prompt.js";

describe("SUBAGENT_STATUS_GUARD_LINE - defensive status guard", () => {
  it("is a non-empty string", () => {
    expect(typeof SUBAGENT_STATUS_GUARD_LINE).toBe("string");
    expect(SUBAGENT_STATUS_GUARD_LINE.length).toBeGreaterThan(0);
  });

  it("instructs the assistant to check live status before claiming a sub-agent is running", () => {
    // Must reference the tool call required to verify status
    expect(SUBAGENT_STATUS_GUARD_LINE).toContain("subagents(action=list)");
  });

  it("references the [COMPLETED] tag as the durable completion signal", () => {
    // Must reference the [COMPLETED] tag added to internalSummaryMessage
    expect(SUBAGENT_STATUS_GUARD_LINE).toContain("[COMPLETED]");
    expect(SUBAGENT_STATUS_GUARD_LINE).toContain("[System Message]");
  });

  it("forbids claiming a sub-agent is still running without an explicit check", () => {
    // Must use a directive that prevents guessing status
    expect(SUBAGENT_STATUS_GUARD_LINE.toLowerCase()).toContain("never claim");
  });

  it("mentions that the COMPLETED tag in context is authoritative", () => {
    // The [COMPLETED] tag means a live API call is not needed
    const lower = SUBAGENT_STATUS_GUARD_LINE.toLowerCase();
    expect(lower).toMatch(/already finished|has already|already completed/);
  });
});
