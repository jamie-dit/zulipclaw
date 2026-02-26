import { describe, expect, it } from "vitest";
import {
  ensureBlankLineBeforeTables,
  normalizeEmojiName,
  normalizeStreamName,
  normalizeTopic,
  normalizeZulipBaseUrl,
} from "./normalize.js";

describe("normalizeZulipBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeZulipBaseUrl("https://zulip.example.com/")).toBe("https://zulip.example.com");
  });

  it("returns undefined for empty input", () => {
    expect(normalizeZulipBaseUrl("")).toBeUndefined();
    expect(normalizeZulipBaseUrl(null)).toBeUndefined();
    expect(normalizeZulipBaseUrl(undefined)).toBeUndefined();
  });
});

describe("normalizeStreamName", () => {
  it("strips leading #", () => {
    expect(normalizeStreamName("#general")).toBe("general");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeStreamName("")).toBe("");
  });
});

describe("normalizeTopic", () => {
  it("trims whitespace", () => {
    expect(normalizeTopic("  hello  ")).toBe("hello");
  });
});

describe("normalizeEmojiName", () => {
  it("strips surrounding colons", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
  });

  it("leaves bare names alone", () => {
    expect(normalizeEmojiName("thumbs_up")).toBe("thumbs_up");
  });
});

describe("ensureBlankLineBeforeTables", () => {
  it("inserts a blank line when a table immediately follows text", () => {
    const input = [
      "Best International Prices:",
      "| Component | Supplier | Price |",
      "|-----------|----------|-------|",
      "| EPYC 9334 | Hashrate.no | $1,259 |",
    ].join("\n");

    const expected = [
      "Best International Prices:",
      "",
      "| Component | Supplier | Price |",
      "|-----------|----------|-------|",
      "| EPYC 9334 | Hashrate.no | $1,259 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("does not double-add a blank line when one already exists", () => {
    const input = [
      "Best International Prices:",
      "",
      "| Component | Supplier | Price |",
      "|-----------|----------|-------|",
      "| EPYC 9334 | Hashrate.no | $1,259 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("does not add a blank line when the table is at the start of the message", () => {
    const input = [
      "| Component | Supplier | Price |",
      "|-----------|----------|-------|",
      "| EPYC 9334 | Hashrate.no | $1,259 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("does not insert blank lines between consecutive table rows", () => {
    const input = ["Some text", "", "| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("handles multiple tables in one message", () => {
    const input = [
      "First table:",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Second table:",
      "| C | D |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");

    const expected = [
      "First table:",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Second table:",
      "",
      "| C | D |",
      "|---|---|",
      "| 3 | 4 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("handles bullet points followed by a table", () => {
    const input = [
      "Key points:",
      "- Point one",
      "- Point two",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");

    const expected = [
      "Key points:",
      "- Point one",
      "- Point two",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("does not affect pipe characters inside fenced code blocks (backticks)", () => {
    const input = [
      "Example:",
      "```",
      "some text",
      "| not | a | table |",
      "|-----|---|-------|",
      "```",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("does not affect pipe characters inside fenced code blocks (tildes)", () => {
    const input = [
      "Example:",
      "~~~",
      "some text",
      "| not | a | table |",
      "|-----|---|-------|",
      "~~~",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("resumes table detection after code blocks end", () => {
    const input = [
      "Code example:",
      "```",
      "| code | stuff |",
      "```",
      "Real table:",
      "| A | B |",
      "|---|---|",
    ].join("\n");

    const expected = [
      "Code example:",
      "```",
      "| code | stuff |",
      "```",
      "Real table:",
      "",
      "| A | B |",
      "|---|---|",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("handles empty content", () => {
    expect(ensureBlankLineBeforeTables("")).toBe("");
  });

  it("handles content with no tables", () => {
    const input = "Just some regular text\nwith multiple lines.";
    expect(ensureBlankLineBeforeTables(input)).toBe(input);
  });

  it("handles a header row immediately after a heading", () => {
    const input = ["## Results", "| Name | Score |", "|------|-------|", "| Alice | 95 |"].join(
      "\n",
    );

    const expected = [
      "## Results",
      "",
      "| Name | Score |",
      "|------|-------|",
      "| Alice | 95 |",
    ].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });

  it("handles indented table rows", () => {
    const input = ["Some text", "  | A | B |", "  |---|---|", "  | 1 | 2 |"].join("\n");

    const expected = ["Some text", "", "  | A | B |", "  |---|---|", "  | 1 | 2 |"].join("\n");

    expect(ensureBlankLineBeforeTables(input)).toBe(expected);
  });
});
