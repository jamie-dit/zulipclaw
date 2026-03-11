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

/**
 * Compute the Levenshtein edit-distance between two strings.
 * Used internally to detect near-miss stream name hallucinations.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j] ?? 0) + 1, // deletion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length] ?? 0;
}

/**
 * Canonicalize a stream name against a list of known configured streams.
 *
 * If the candidate stream is in the list (case-insensitive), the canonical
 * (configured) casing is returned unchanged.
 *
 * If the candidate is NOT in the list but is within `maxDistance` edits of
 * exactly one configured stream, that stream's canonical name is returned.
 * This guards against LLM typos/hallucinations (e.g. "marvel-dreamit" →
 * "marcel-dreamit").
 *
 * If no close-enough match exists, the original candidate is returned so that
 * existing behaviour (deliver to whatever stream was specified) is preserved.
 *
 * @param candidate   The stream name to check (already stripped of "#" prefix).
 * @param knownStreams The `streams` list from the resolved Zulip account config.
 * @param maxDistance Maximum edit distance to consider a "close" match (default 2).
 * @returns           `{ name, corrected }` — name is the (possibly corrected) stream
 *                    name; corrected is true when a substitution was made.
 */
export function canonicalizeStreamName(
  candidate: string,
  knownStreams: string[],
  maxDistance = 2,
): { name: string; corrected: boolean } {
  if (!candidate || knownStreams.length === 0) {
    return { name: candidate, corrected: false };
  }

  const lower = candidate.toLowerCase();

  // 1. Exact case-insensitive match — return canonical casing.
  const exact = knownStreams.find((s) => s.toLowerCase() === lower);
  if (exact !== undefined) {
    const corrected = exact !== candidate;
    return { name: exact, corrected };
  }

  // 2. Find the closest configured stream within the distance threshold.
  let bestName: string | undefined;
  let bestDist = Infinity;
  for (const known of knownStreams) {
    const dist = levenshtein(lower, known.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestName = known;
    }
  }

  if (bestDist <= maxDistance && bestName !== undefined) {
    return { name: bestName, corrected: true };
  }

  // 3. No close match — leave as-is to preserve backward compatibility.
  return { name: candidate, corrected: false };
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
