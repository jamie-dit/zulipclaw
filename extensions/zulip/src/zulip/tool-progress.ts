import type { ZulipAuth } from "./client.js";
import { editZulipStreamMessage, sendZulipStreamMessage } from "./send.js";

/**
 * Format a timestamp as clock time (e.g. "7:58 PM").
 */
export function formatClockTime(ts: number): string {
  const safeTs = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(safeTs));
  } catch {
    const date = new Date(safeTs);
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const suffix = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    return `${hour12}:${minutes} ${suffix}`;
  }
}

/**
 * Extract the tool type from a formatted tool line.
 *
 * Lines come in as e.g. "📋 Todo: add \"Write notes\"" or "🔧 exec: ls -la".
 * We extract the label (e.g. "Todo", "exec") to build a summary.
 */
export function extractToolType(lineText: string): string | undefined {
  // Strip leading emoji sequences including ZWJ compound emoji (e.g. 🧑‍🔧)
  // and variation selectors, then any trailing whitespace.
  const withoutEmoji = lineText.replace(
    /^(?:[\p{Emoji_Presentation}\p{Emoji}\uFE0E\uFE0F\u200D])+\s*/u,
    "",
  );
  // Take the part before the first colon
  const colonIndex = withoutEmoji.indexOf(":");
  if (colonIndex <= 0) {
    return undefined;
  }
  const label = withoutEmoji.slice(0, colonIndex).trim().toLowerCase();
  return label || undefined;
}

/**
 * Build a compact summary of tool types used.
 *
 * Example: "todo: add \"Write notes\", exec ×3, read ×2"
 *
 * For todo tools specifically, shows the first action detail.
 * For other tools, shows the count if > 1.
 */
export function buildToolTypeSummary(
  toolTypeCounts: Map<string, number>,
  toolTypeDetails: Map<string, string>,
  maxTypes = 4,
): string {
  if (toolTypeCounts.size === 0) {
    return "";
  }

  // Sort by count descending, then alphabetically
  const sorted = [...toolTypeCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const segments: string[] = [];
  const shown = sorted.slice(0, maxTypes);
  const remaining = sorted.slice(maxTypes);

  for (const [type, count] of shown) {
    const detail = toolTypeDetails.get(type);
    if (detail) {
      // Show the latest detail for this tool type
      segments.push(count > 1 ? `${type} ×${count} (${detail})` : `${type}: ${detail}`);
    } else {
      segments.push(count > 1 ? `${type} ×${count}` : type);
    }
  }

  if (remaining.length > 0) {
    const otherCount = remaining.reduce((sum, [, c]) => sum + c, 0);
    segments.push(`+${otherCount} more`);
  }

  return segments.join(", ");
}

/**
 * Render lines with de-emphasized timestamps for rapid batched calls.
 *
 * When multiple lines share the same minute-level timestamp,
 * only the first line in that group shows the full timestamp.
 * Subsequent lines in the same minute show a minimal indent marker.
 */
export function renderLinesWithGroupedTimestamps(
  lines: Array<{ ts: string; text: string }>,
): string[] {
  if (lines.length === 0) return [];

  const result: string[] = [];
  let lastTs: string | undefined;

  for (const { ts, text } of lines) {
    if (ts === lastTs) {
      // Same minute - de-emphasize timestamp
      result.push(`  ├ ${text}`);
    } else {
      result.push(`[${ts}] ${text}`);
      lastTs = ts;
    }
  }

  return result;
}

export type ToolProgressParams = {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  /** Display name for the header (e.g. agent name or sub-agent label). */
  name?: string;
  /** Model identifier shown in the header (e.g. "claude-opus-4-6"). */
  model?: string;
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
  /** Enable debug logging for tool progress rendering. */
  debug?: boolean;
};

/**
 * Accumulates tool call progress lines into a single Zulip message
 * that is created on the first tool call and edited on subsequent ones.
 *
 * Each line has a clock-time timestamp prefix (de-emphasized for rapid calls).
 * Edits are debounced to avoid excessive API calls during rapid-fire tool use.
 */
export type ToolProgressStatus = "running" | "success" | "error";

const STATUS_EMOJI: Record<ToolProgressStatus, string> = {
  running: "🔄",
  success: "✅",
  error: "❌",
};

interface ToolProgressLine {
  ts: string;
  text: string;
  rawText: string; // original text before sanitization, for type extraction
}

export class ToolProgressAccumulator {
  private lines: ToolProgressLine[] = [];
  private messageId: number | undefined;
  private editTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> | undefined;
  private finalized = false;
  private status: ToolProgressStatus = "running";
  private params: ToolProgressParams;

  /** Track tool types for the summary header. */
  private toolTypeCounts = new Map<string, number>();
  /** Track latest detail per tool type for summary. */
  private toolTypeDetails = new Map<string, string>();

  /** Debounce interval for edits (ms). */
  private static readonly EDIT_DEBOUNCE_MS = 300;

  constructor(params: ToolProgressParams) {
    this.params = params;
  }

  /** Whether the accumulator has any content. */
  get hasContent(): boolean {
    return this.lines.length > 0;
  }

  /** Whether a message has been sent (has a message ID). */
  get hasSentMessage(): boolean {
    return this.messageId !== undefined;
  }

  /** The Zulip message ID of the batched message (if sent). */
  get sentMessageId(): number | undefined {
    return this.messageId;
  }

  /** Current status of this accumulator. */
  get currentStatus(): ToolProgressStatus {
    return this.status;
  }

  /**
   * Update the status (running/success/error). Does not trigger a flush;
   * the next scheduled or explicit flush will pick up the change.
   */
  setStatus(status: ToolProgressStatus): void {
    this.status = status;
  }

  /**
   * Set the model identifier shown in the header (e.g. "claude-opus-4-6").
   * Does not trigger a flush; the next scheduled or explicit flush will pick
   * up the change.
   */
  setModel(model: string): void {
    this.params = { ...this.params, model };
  }

  /**
   * Add a tool progress line. The line text should already be formatted
   * (e.g. "🔧 exec: ls -la"). A clock-time timestamp is prepended automatically.
   *
   * The tool type is extracted from the line text and tracked for the
   * summary header.
   */
  addLine(text: string): void {
    if (this.finalized) {
      return;
    }
    const timestamp = formatClockTime(Date.now());
    this.lines.push({ ts: timestamp, text, rawText: text });

    // Track tool types for the summary
    this.trackToolType(text);

    if (this.params.debug) {
      this.params.log?.(`[zulip:tool-progress:debug] addLine: ts=${timestamp} text=${text}`);
    }

    this.scheduleFlush();
  }

  /**
   * Extract and track tool type from line text.
   */
  private trackToolType(text: string): void {
    const type = extractToolType(text);
    if (!type) return;

    this.toolTypeCounts.set(type, (this.toolTypeCounts.get(type) ?? 0) + 1);

    // Extract detail: everything after "Type: " in the line (first line only)
    const withoutEmoji = text.replace(
      /^(?:[\p{Emoji_Presentation}\p{Emoji}\uFE0E\uFE0F\u200D])+\s*/u,
      "",
    );
    const colonIndex = withoutEmoji.indexOf(":");
    if (colonIndex >= 0) {
      // Take only the first line and truncate for the summary
      const rawDetail = withoutEmoji.slice(colonIndex + 1).trim();
      const firstLine = rawDetail.split(/\r?\n/)[0]?.trim();
      if (firstLine) {
        const detail = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        this.toolTypeDetails.set(type, detail);
      }
    }
  }

  /**
   * Append a keepalive/heartbeat line to the accumulated message.
   */
  addHeartbeat(_elapsedMs: number): void {
    if (this.finalized || this.lines.length === 0) {
      return;
    }
    // Don't add heartbeat lines - just trigger a flush to update the message.
    // The footer will show the latest "updated at" time.
    this.scheduleFlush();
  }

  /**
   * Sanitize text for inclusion inside a Zulip spoiler block.
   *
   * Zulip spoiler blocks (` ```spoiler Title `) render their content as
   * full markdown, NOT as a code block. This means line-start markdown can
   * still render inside the collapsed body unless we neutralize it.
   *
   * This method inserts zero-width spaces (\u200B) to neutralize:
   * - Runs of 3+ backticks (would close the spoiler fence prematurely)
   * - Heading syntax (`# `, `## `, etc.) at line start
   * - Unordered list markers (`- `, `+ `, `* `) at line start
   * - Blockquote markers (`> `) at line start
   * - Ordered list markers (`1. `, `2. `, etc.) at line start
   * - Horizontal rule patterns (`---`, `***`, `___` on their own line)
   */
  private static sanitizeForSpoiler(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        // Break up runs of 3+ backticks so they don't close the spoiler fence.
        let sanitized = line.replace(/`{3,}/g, (match) => match.split("").join("\u200B"));

        // Neutralize markdown constructs that only trigger at line start.
        // Preserve leading indentation; only prefix the markdown token with ZWS.
        sanitized = sanitized.replace(
          /^(\s*)(#{1,6}\s|[-+*]\s|>\s?|\d+\.\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/,
          "$1\u200B$2",
        );

        return sanitized;
      })
      .join("\n");
  }

  /**
   * Render the accumulated message content wrapped in a Zulip spoiler
   * block with a metadata header.
   *
   * The header includes:
   * - Status emoji
   * - Agent name and model
   * - Tool call count
   * - Summary of tool types used (collapsed spoiler title)
   * - Updated timestamp
   */
  private renderMessage(): string {
    const name = this.params.name || "Agent";
    const model = this.params.model;
    const modelSegment = model ? ` · ${model}` : "";
    const count = this.lines.length;
    const callWord = count === 1 ? "tool call" : "tool calls";
    const lastTimestamp = formatClockTime(Date.now());
    const emoji = STATUS_EMOJI[this.status] ?? "🔄";
    const header = `${emoji} **\`${name}\`**${modelSegment} · ${count} ${callWord} · updated ${lastTimestamp}`;

    // Build tool type summary for the spoiler title (must be single-line)
    const typeSummary = buildToolTypeSummary(this.toolTypeCounts, this.toolTypeDetails);
    const spoilerTitle = typeSummary ? typeSummary.replace(/[\r\n]+/g, " ").trim() : "Tool calls";

    // Render lines with grouped timestamps to reduce clutter
    const sanitizedLines = this.lines.map((line) => ({
      ts: line.ts,
      text: ToolProgressAccumulator.sanitizeForSpoiler(line.text),
    }));
    const renderedLines = renderLinesWithGroupedTimestamps(sanitizedLines);

    return `${header}\n\n\`\`\`spoiler ${spoilerTitle}\n${renderedLines.join("\n")}\n\`\`\``;
  }

  /**
   * Schedule a debounced flush (send or edit).
   */
  private scheduleFlush(): void {
    if (this.editTimer) {
      return; // Already scheduled
    }
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.flush();
    }, ToolProgressAccumulator.EDIT_DEBOUNCE_MS);
    this.editTimer.unref?.();
  }

  /**
   * Cancel any pending debounced flush.
   */
  private cancelScheduledFlush(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = undefined;
    }
  }

  /**
   * Immediately flush: send if no message yet, edit if message exists.
   */
  async flush(): Promise<void> {
    if (this.lines.length === 0) {
      return;
    }

    // Chain flushes to avoid concurrent send/edit races.
    const previousFlush = this.flushInFlight;
    const current = (async () => {
      if (previousFlush) {
        await previousFlush.catch(() => undefined);
      }
      const content = this.renderMessage();
      try {
        if (this.messageId) {
          await editZulipStreamMessage({
            auth: this.params.auth,
            messageId: this.messageId,
            content,
            abortSignal: this.params.abortSignal,
          });
        } else {
          const response = await sendZulipStreamMessage({
            auth: this.params.auth,
            stream: this.params.stream,
            topic: this.params.topic,
            content,
            abortSignal: this.params.abortSignal,
          });
          if (response?.id && typeof response.id === "number") {
            this.messageId = response.id;
          }
        }
      } catch (err) {
        this.params.log?.(
          `[zulip] tool progress flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    this.flushInFlight = current;
    await current;
  }

  /**
   * Finalize the accumulator: cancel debounced edits, set status to "success",
   * do a final flush, and mark as done. After finalization, no more lines can be added.
   */
  async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    this.status = "success";
    this.finalized = true;
    this.cancelScheduledFlush();
    if (this.lines.length > 0) {
      await this.flush();
    }
  }

  /**
   * Finalize with error status: cancel debounced edits, set status to "error",
   * do a final flush, and mark as done. If already finalized, updates the status
   * to "error" and re-flushes to update the displayed emoji.
   */
  async finalizeWithError(): Promise<void> {
    if (this.finalized) {
      // Already finalized but status may need updating (e.g. dispatch failed
      // after tool progress was flushed mid-turn).
      if (this.status !== "error" && this.lines.length > 0) {
        this.status = "error";
        await this.flush();
      }
      return;
    }
    this.status = "error";
    this.finalized = true;
    this.cancelScheduledFlush();
    if (this.lines.length > 0) {
      await this.flush();
    }
  }

  /**
   * Clean up without a final flush (e.g. on error/abort).
   */
  dispose(): void {
    this.finalized = true;
    this.cancelScheduledFlush();
  }
}
