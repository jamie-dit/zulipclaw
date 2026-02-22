import { describe, expect, it } from "vitest";
import {
  buildCompletionDeliveryMessage,
  sanitizeForCodeFence,
  sanitizeInlineCodeName,
} from "./subagent-announce.js";

describe("sanitizeForCodeFence", () => {
  it("returns plain text unchanged", () => {
    expect(sanitizeForCodeFence("hello world")).toBe("hello world");
  });

  it("leaves single and double backticks untouched", () => {
    expect(sanitizeForCodeFence("`single`")).toBe("`single`");
    expect(sanitizeForCodeFence("``double``")).toBe("``double``");
  });

  it("breaks triple backticks with zero-width spaces", () => {
    const result = sanitizeForCodeFence("```python\nprint('hi')\n```");
    expect(result).not.toContain("```");
    expect(result).toContain("`\u200B`\u200B`");
    // Should preserve surrounding text
    expect(result).toContain("python");
    expect(result).toContain("print('hi')");
  });

  it("breaks runs of more than 3 backticks", () => {
    const result = sanitizeForCodeFence("````four````");
    expect(result).not.toContain("````");
    expect(result).toContain("`\u200B`\u200B`\u200B`");
  });

  it("handles multiple code fences in one string", () => {
    const input = "```js\ncode1\n```\ntext\n```py\ncode2\n```";
    const result = sanitizeForCodeFence(input);
    // No unbroken triple backticks should remain
    const withoutZws = result.replace(/\u200B/g, "");
    // After removing zero-width spaces, the original backticks are still there
    expect(withoutZws).toContain("```");
    // But the actual result should have them broken
    expect(result).not.toMatch(/`{3,}/);
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeForCodeFence("")).toBe("");
  });
});

describe("sanitizeInlineCodeName", () => {
  it("returns name without backticks unchanged", () => {
    expect(sanitizeInlineCodeName("worker-1")).toBe("worker-1");
  });

  it("strips backticks from name", () => {
    expect(sanitizeInlineCodeName("te`st")).toBe("test");
  });

  it("strips multiple backticks", () => {
    expect(sanitizeInlineCodeName("`na``me`")).toBe("name");
  });

  it("handles name that is entirely backticks", () => {
    expect(sanitizeInlineCodeName("```")).toBe("");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeInlineCodeName("")).toBe("");
  });
});

describe("buildCompletionDeliveryMessage", () => {
  it("uses subagentName as the header label", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "All done",
      subagentName: "fix-exec-summary",
    });
    expect(result).toContain("Sub-agent `fix-exec-summary`");
    expect(result).not.toContain("Sub-agent `main`");
  });

  it("shows header only when findings are empty", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "",
      subagentName: "worker-1",
    });
    expect(result).toBe("✅ **Sub-agent `worker-1`** finished");
  });

  it("shows header only when findings are (no output)", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "(no output)",
      subagentName: "worker-1",
    });
    expect(result).toBe("✅ **Sub-agent `worker-1`** finished");
  });

  it("includes spoiler block when findings are present", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "Found 3 issues",
      subagentName: "audit-task",
    });
    expect(result).toContain("Sub-agent `audit-task`");
    expect(result).toContain("```spoiler Sub-agent output");
    expect(result).toContain("Found 3 issues");
  });

  it("sanitizes backticks in subagentName", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "done",
      subagentName: "te`st`name",
    });
    expect(result).toContain("Sub-agent `testname`");
  });

  it("sanitizes triple backticks in findings", () => {
    const result = buildCompletionDeliveryMessage({
      findings: "```python\nprint('hi')\n```",
      subagentName: "code-task",
    });
    // Triple backticks in findings should be broken with zero-width spaces
    expect(result).toContain("Sub-agent `code-task`");
    // The findings section should not contain raw triple backticks (except the spoiler fence)
    const spoilerStart = result.indexOf("```spoiler");
    const spoilerEnd = result.lastIndexOf("```");
    const findingsSection = result.substring(
      spoilerStart + "```spoiler Sub-agent output\n".length,
      spoilerEnd,
    );
    expect(findingsSection).not.toMatch(/`{3,}/);
  });
});
