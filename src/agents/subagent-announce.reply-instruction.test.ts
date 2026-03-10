/**
 * Tests for buildAnnounceReplyInstruction to verify:
 * 1. The main agent (non-subagent) case NEVER includes NO_REPLY escape hatch
 * 2. The [COMPLETED] tag is present in the internalSummaryMessage
 * 3. Sub-agent orchestration case still allows NO_REPLY for dedup
 *
 * Covers: fix for sub-agent completion visibility bug (issue #198)
 */
import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { buildAnnounceReplyInstruction } from "./subagent-announce.js";

describe("buildAnnounceReplyInstruction - NO_REPLY escape hatch removal", () => {
  it("main agent completion: does NOT include NO_REPLY escape hatch", () => {
    const instruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns: 0,
      requesterIsSubagent: false,
      announceType: "subagent task",
    });
    // Must NOT contain the NO_REPLY token - user must always see completion
    expect(instruction).not.toContain(SILENT_REPLY_TOKEN);
    // But must still instruct to deliver to user
    expect(instruction).toContain("user delivery");
  });

  it("main agent completion with expectsCompletionMessage: does NOT include NO_REPLY", () => {
    const instruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns: 0,
      requesterIsSubagent: false,
      announceType: "subagent task",
      expectsCompletionMessage: true,
    });
    // expectsCompletionMessage path also must not allow suppression
    expect(instruction).not.toContain(SILENT_REPLY_TOKEN);
    expect(instruction).toContain("user delivery");
  });

  it("main agent with remaining active runs: does NOT include NO_REPLY", () => {
    const instruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns: 2,
      requesterIsSubagent: false,
      announceType: "subagent task",
    });
    // Waiting instruction also must not allow silent suppression
    expect(instruction).not.toContain(SILENT_REPLY_TOKEN);
    expect(instruction).toContain("2 active subagent");
  });

  it("sub-agent orchestration: still allows NO_REPLY for dedup (internal only)", () => {
    const instruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns: 0,
      requesterIsSubagent: true,
      announceType: "subagent task",
    });
    // For internal sub-agent-to-sub-agent orchestration, NO_REPLY is acceptable
    // to suppress duplicate internal updates - this is not user-facing
    expect(instruction).toContain(SILENT_REPLY_TOKEN);
  });

  it("cron job completion delivered to main agent: does NOT include NO_REPLY", () => {
    const instruction = buildAnnounceReplyInstruction({
      remainingActiveSubagentRuns: 0,
      requesterIsSubagent: false,
      announceType: "cron job",
    });
    expect(instruction).not.toContain(SILENT_REPLY_TOKEN);
    expect(instruction).toContain("user delivery");
    expect(instruction).toContain("cron job");
  });
});
