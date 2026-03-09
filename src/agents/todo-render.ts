/**
 * Rendering helpers for todo lists.
 *
 * Two modes:
 * 1. **Compact inline** – short summary for tool results / assistant replies.
 * 2. **Backing message** – richer Zulip markdown table, edited in-place.
 */

import type { TodoItem, TodoItemStatus, TodoList } from "./todo-state.js";

// ── Status emoji mapping ─────────────────────────────────────────────────────

const STATUS_EMOJI: Record<TodoItemStatus, string> = {
  pending: "⬜",
  "in-progress": "🔄",
  done: "✅",
  blocked: "🚫",
  cancelled: "❌",
};

// ── Compact inline render ────────────────────────────────────────────────────

/**
 * One-line per item, suitable for tool results and assistant messages.
 *
 * Example:
 * ```
 * 📋 Sprint tasks (3/5 done)
 *  ✅ Set up CI
 *  🔄 Write tests (assigned: subagent-abc)
 *  ⬜ Deploy to staging
 * ```
 */
export function renderCompact(list: TodoList): string {
  const doneCount = list.items.filter((i) => i.status === "done").length;
  const inProgressCount = list.items.filter((i) => i.status === "in-progress").length;
  const blockedCount = list.items.filter((i) => i.status === "blocked").length;
  const parts = [`${doneCount}/${list.items.length} done`];
  if (inProgressCount > 0) {
    parts.push(`${inProgressCount} active`);
  }
  if (blockedCount > 0) {
    parts.push(`${blockedCount} blocked`);
  }
  const header = `📋 ${list.title} (${parts.join(" · ")})`;

  if (list.items.length === 0) {
    return `${header}\n_No items yet._`;
  }

  const orderedItems = [...list.items].toSorted(
    (a, b) => statusOrder(a.status) - statusOrder(b.status),
  );
  const lines = orderedItems.slice(0, 6).map((item) => {
    const emoji = STATUS_EMOJI[item.status] ?? "⬜";
    const assigneeSuffix = item.assignee ? ` _(${item.assignee})_` : "";
    const notesSuffix = item.notes ? ` - ${truncate(item.notes, 40)}` : "";
    return ` ${emoji} ${item.title}${assigneeSuffix}${notesSuffix}`;
  });
  const remaining = orderedItems.length - lines.length;
  if (remaining > 0) {
    lines.push(` _+${remaining} more item(s)_`);
  }

  return `${header}\n${lines.join("\n")}`;
}

// ── Backing message render (Zulip markdown) ──────────────────────────────────

const ZULIP_MAX_CHARS = 10_000;
const COMPLETED_COLLAPSE_THRESHOLD = 0.7; // collapse completed items when >70% of char limit used

/**
 * Rich Zulip-format markdown table.
 *
 * Includes:
 * - Table header with Status, Item, Assignee, Notes
 * - Auto-collapse of completed items when approaching char limit
 * - Last-updated footer
 */
export function renderBackingMessage(list: TodoList): string {
  const doneCount = list.items.filter((i) => i.status === "done").length;
  const header = `## 📋 ${list.title}\n**${doneCount}/${list.items.length}** items done`;

  if (list.items.length === 0) {
    return `${header}\n\n_No items yet._`;
  }

  // Split items into active and completed.
  const active = list.items.filter((i) => i.status !== "done" && i.status !== "cancelled");
  const completed = list.items.filter((i) => i.status === "done" || i.status === "cancelled");

  // Render the table for active items first.
  let table = renderTable(active);
  let content = `${header}\n\n${table}`;

  // Check if we should collapse completed items.
  if (completed.length > 0) {
    const completedTable = renderTable(completed);
    const full = `${content}\n\n**Completed:**\n${completedTable}`;

    if (full.length > ZULIP_MAX_CHARS * COMPLETED_COLLAPSE_THRESHOLD) {
      // Collapse: just show count.
      content += `\n\n_${completed.length} completed item(s) collapsed._`;
    } else {
      content = full;
    }
  }

  // Use Zulip bold (*text*) for the footer instead of italic (_text_).
  // Zulip's italic parser can produce malformed output when the text between
  // underscores contains colons/periods from ISO timestamps.
  const ts = new Date(list.updatedAt)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
  const footer = `\n\n**Last updated:** ${ts}`;
  return content + footer;
}

function statusOrder(status: TodoItemStatus): number {
  switch (status) {
    case "in-progress":
      return 0;
    case "blocked":
      return 1;
    case "pending":
      return 2;
    case "done":
      return 3;
    case "cancelled":
      return 4;
    default:
      return 5;
  }
}

function renderTable(items: TodoItem[]): string {
  if (items.length === 0) {
    return "_None._";
  }

  const rows = items.map((item) => {
    const emoji = STATUS_EMOJI[item.status] ?? "⬜";
    const assignee = item.assignee ?? "-";
    const notes = truncate(item.notes ?? "-", 60);
    return `| ${emoji} | ${escapeCell(item.title)} | ${escapeCell(assignee)} | ${escapeCell(notes)} |`;
  });

  return ["| Status | Item | Assignee | Notes |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 3)}...`;
}
