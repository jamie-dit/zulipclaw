export function normalizeZulipBaseUrl(raw?: string | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export function normalizeStreamName(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^#/, "");
}

export function normalizeTopic(raw?: string | null): string {
  const value = (raw ?? "").trim();
  return value;
}

export function normalizeEmojiName(raw?: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) {
    return "";
  }
  // Accept ":eyes:" style as well as "eyes".
  const stripped = value.replace(/^:/, "").replace(/:$/, "");
  return stripped.trim();
}

/**
 * Ensure a blank line exists before the first row of any markdown pipe table.
 *
 * Zulip's markdown parser requires a blank line before a pipe table for it to
 * render as a table. Without that blank line the raw pipes are displayed as-is.
 *
 * Rules:
 *  - A "table row" is a line whose trimmed form starts with `|`.
 *  - When a table row is preceded by a non-blank line that is NOT itself a
 *    table row, insert one blank line between them.
 *  - Consecutive table rows are left untouched.
 *  - Pipe characters inside fenced code blocks (``` or ~~~) are ignored.
 */
export function ensureBlankLineBeforeTables(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let insideCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track fenced code blocks (``` or ~~~)
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      insideCodeBlock = !insideCodeBlock;
      result.push(line);
      continue;
    }

    // Inside a code block — pass through unchanged
    if (insideCodeBlock) {
      result.push(line);
      continue;
    }

    const isTableRow = trimmed.startsWith("|");

    if (isTableRow && result.length > 0) {
      // Look at the previous non-empty output line to decide whether to insert
      // a blank line. We need to skip any trailing blank lines we already have.
      const prev = result[result.length - 1];
      const prevTrimmed = prev.trimStart();
      const prevIsBlank = prev.trim() === "";
      const prevIsTableRow = prevTrimmed.startsWith("|");

      if (!prevIsBlank && !prevIsTableRow) {
        result.push("");
      }
    }

    result.push(line);
  }

  return result.join("\n");
}
