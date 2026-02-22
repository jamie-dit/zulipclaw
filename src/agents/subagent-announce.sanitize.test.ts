import { describe, expect, it } from "vitest";
import { sanitizeForCodeFence, sanitizeInlineCodeName } from "./subagent-announce.js";

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
