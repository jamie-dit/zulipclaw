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
};

/**
 * Accumulates tool call progress lines into a single Zulip message
 * that is created on the first tool call and edited on subsequent ones.
 *
 * Each line has a clock-time timestamp prefix.
 * Edits are debounced to avoid excessive API calls during rapid-fire tool use.
 */
export type ToolProgressStatus = "running" | "success" | "error";

const STATUS_EMOJI: Record<ToolProgressStatus, string> = {
  running: "🔄",
  success: "✅",
  error: "❌",
};

export class ToolProgressAccumulator {
  private lines: string[] = [];
  private messageId: number | undefined;
  private editTimer: NodeJS.Timeout | undefined;
  private flushInFlight: Promise<void> | undefined;
  private finalized = false;
  private status: ToolProgressStatus = "running";
  private readonly params: ToolProgressParams;

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
   */
  addLine(text: string): void {
    if (this.finalized) {
      return;
    }
    const timestamp = formatClockTime(Date.now());
    this.lines.push(`[${timestamp}] ${text}`);
    this.scheduleFlush();
  }

  /**
   * Append a keepalive/heartbeat line to the accumulated message.
   */
  addHeartbeat(elapsedMs: number): void {
    if (this.finalized || this.lines.length === 0) {
      return;
    }
    // Don't add heartbeat lines - just trigger a flush to update the message.
    // The footer will show the latest "updated at" time.
    this.scheduleFlush();
  }

  /**
   * Sanitize text for inclusion inside a triple-backtick code fence.
   * Breaks up runs of 3+ backticks with zero-width spaces so they
   * don't prematurely close the fence.
   */
  private static sanitizeForCodeFence(text: string): string {
    return text.replace(/`{3,}/g, (match) => match.split("").join("\u200B"));
  }

  /**
   * Render the accumulated message content wrapped in a Zulip spoiler
   * block with a metadata header.
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
    const sanitizedLines = this.lines.map((line) =>
      ToolProgressAccumulator.sanitizeForCodeFence(line),
    );
    return `${header}\n\n\`\`\`spoiler Tool calls\n${sanitizedLines.join("\n")}\n\`\`\``;
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
