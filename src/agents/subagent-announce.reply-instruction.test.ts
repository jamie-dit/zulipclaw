import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { buildAnnounceReplyInstruction } from "./subagent-announce.js";

describe("buildAnnounceReplyInstruction", () => {
  describe("main-agent path (non-subagent, no remaining runs)", () => {
    it("returns a user-delivery instruction", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 0,
        requesterIsSubagent: false,
        announceType: "subagent task",
      });
      expect(result).toContain("user delivery");
      expect(result).toContain("Convert the result above into your normal assistant voice");
    });

    it("does NOT include a NO_REPLY escape hatch", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 0,
        requesterIsSubagent: false,
        announceType: "subagent task",
      });
      expect(result).not.toContain(SILENT_REPLY_TOKEN);
      expect(result.toUpperCase()).not.toContain("NO_REPLY");
    });

    it("does NOT include a NO_REPLY escape hatch for cron jobs either", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 0,
        requesterIsSubagent: false,
        announceType: "cron job",
      });
      expect(result).not.toContain(SILENT_REPLY_TOKEN);
    });
  });

  describe("expectsCompletionMessage path", () => {
    it("returns a delivery instruction without NO_REPLY", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 0,
        requesterIsSubagent: false,
        announceType: "subagent task",
        expectsCompletionMessage: true,
      });
      expect(result).toContain("user delivery");
      expect(result).not.toContain(SILENT_REPLY_TOKEN);
    });
  });

  describe("requester-is-subagent path", () => {
    it("allows NO_REPLY for sub-agent orchestration updates (duplicate guard is valid here)", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 0,
        requesterIsSubagent: true,
        announceType: "subagent task",
      });
      expect(result).toContain(SILENT_REPLY_TOKEN);
    });
  });

  describe("remaining active runs path", () => {
    it("does not mention NO_REPLY when other runs are still active", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 2,
        requesterIsSubagent: false,
        announceType: "subagent task",
      });
      expect(result).toContain("2 active subagent runs");
      expect(result).not.toContain(SILENT_REPLY_TOKEN);
    });

    it("uses singular form for one remaining run", () => {
      const result = buildAnnounceReplyInstruction({
        remainingActiveSubagentRuns: 1,
        requesterIsSubagent: false,
        announceType: "subagent task",
      });
      expect(result).toContain("1 active subagent run");
    });
  });
});
