import { dispatchChannelMessageAction } from "../channels/plugins/message-actions.js";
import { loadConfig } from "../config/config.js";
import {
  registerSyncCallback,
  scheduleSyncForList,
  startLifecycleSweeper,
} from "./todo-lifecycle.js";
import { renderBackingMessage, renderCompact } from "./todo-render.js";
import {
  type TodoList,
  applySubagentProgressEvent,
  findActiveListByTopic,
  getList,
  getAllLists,
  loadFromDisk,
  recoverAfterRestart,
  setBackingMessageId,
} from "./todo-state.js";
import { normalizeToolName } from "./tool-policy.js";

let initialized = false;

function isZulipTopicKey(value: string): boolean {
  return /^stream:[^#]+#.+$/i.test(value.trim());
}

export function parseTopicKey(topicKey: string): { stream: string; topic: string } | null {
  const trimmed = topicKey.trim();
  if (!isZulipTopicKey(trimmed)) {
    return null;
  }
  const body = trimmed.slice("stream:".length);
  const index = body.indexOf("#");
  if (index <= 0 || index >= body.length - 1) {
    return null;
  }
  return {
    stream: body.slice(0, index).trim(),
    topic: body.slice(index + 1).trim(),
  };
}

// ── Concurrency guard for backing-message creation ───────────────────────────
//
// Prevents duplicate backing messages when multiple mutations fire
// near-simultaneously for the same list (e.g., create + add in quick
// succession). Only one in-flight send per list is allowed; concurrent
// callers wait on the same promise.

const backingMessageInflight = new Map<string, Promise<string | undefined>>();

async function ensureBackingMessage(list: TodoList): Promise<string | undefined> {
  // Fast path: already have a backing message.
  if (list.backingMessageId) {
    return list.backingMessageId;
  }

  // Check if another call is already creating one for this list.
  const inflight = backingMessageInflight.get(list.id);
  if (inflight) {
    return inflight;
  }

  const promise = createBackingMessage(list);
  backingMessageInflight.set(list.id, promise);

  try {
    return await promise;
  } finally {
    backingMessageInflight.delete(list.id);
  }
}

async function createBackingMessage(list: TodoList): Promise<string | undefined> {
  // Re-check after acquiring the slot (another caller may have finished).
  if (list.backingMessageId) {
    return list.backingMessageId;
  }

  const topic = parseTopicKey(list.topicKey);
  if (!topic) {
    return undefined;
  }

  // Send the real rendered content immediately instead of a placeholder.
  // This avoids a visible "Preparing todo board..." card that then gets
  // edited moments later.
  const content = renderBackingMessage(list);

  const cfg = loadConfig();
  const result = await dispatchChannelMessageAction({
    channel: "zulip",
    action: "send",
    cfg,
    accountId: undefined,
    params: {
      channel: "zulip",
      target: `stream:${topic.stream}#${topic.topic}`,
      message: content,
    },
    dryRun: false,
  });
  // dispatchChannelMessageAction returns AgentToolResult<unknown> whose shape is
  // { content: [...], details: { ok, action, messageId } }.  Extract messageId
  // from `details` (the real property), falling back to the legacy `payload` path
  // that the original code expected but which never actually existed at runtime.
  const raw = result as Record<string, unknown> | null | undefined;
  const details = raw?.details as Record<string, unknown> | undefined;
  const payload = raw?.payload as Record<string, unknown> | undefined;
  const rawId = details?.messageId ?? payload?.messageId;
  const messageId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
  if (!messageId) {
    return undefined;
  }
  setBackingMessageId(list.id, messageId);
  return messageId;
}

async function syncBackingMessage(
  listId: string,
  content: string,
  messageId: string,
): Promise<void> {
  const list = getList(listId);
  const topic = list ? parseTopicKey(list.topicKey) : null;
  if (!topic) {
    return;
  }

  const cfg = loadConfig();

  // Delete the old backing message (best-effort - it may already be gone).
  try {
    await dispatchChannelMessageAction({
      channel: "zulip",
      action: "delete",
      cfg,
      accountId: undefined,
      params: {
        channel: "zulip",
        messageId,
      },
      dryRun: false,
    });
  } catch {
    // Old message may already be gone - that's fine.
  }

  // Send a new message at the bottom of the topic.
  const result = await dispatchChannelMessageAction({
    channel: "zulip",
    action: "send",
    cfg,
    accountId: undefined,
    params: {
      channel: "zulip",
      target: `stream:${topic.stream}#${topic.topic}`,
      message: content,
    },
    dryRun: false,
  });

  // Extract the new message ID and update state.
  const raw = result as Record<string, unknown> | null | undefined;
  const details = raw?.details as Record<string, unknown> | undefined;
  const payload = raw?.payload as Record<string, unknown> | undefined;
  const rawId = details?.messageId ?? payload?.messageId;
  const newMessageId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
  if (newMessageId && list) {
    setBackingMessageId(list.id, newMessageId);
  }
}

export async function syncTodoBackingMessage(list: TodoList): Promise<void> {
  if (!parseTopicKey(list.topicKey)) {
    return;
  }
  const messageId = await ensureBackingMessage(list);
  if (!messageId) {
    return;
  }
  // Re-read the list in case it was mutated between the ensure call and now.
  const fresh = getList(list.id);
  if (!fresh) {
    return;
  }
  scheduleSyncForList(list.id);
}

export function getTodoTopicKey(params: {
  sessionKey?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}): string | undefined {
  const to = params.agentTo?.trim();
  if (to && isZulipTopicKey(to)) {
    return to;
  }
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey?.includes("#")) {
    const idx = sessionKey.indexOf("#");
    const prefix = sessionKey.slice(0, idx);
    const topic = sessionKey.slice(idx + 1).trim();
    const channelMarker = ":zulip:channel:";
    const markerIdx = prefix.indexOf(channelMarker);
    if (markerIdx >= 0) {
      const stream = prefix.slice(markerIdx + channelMarker.length).trim();
      if (stream && topic) {
        return `stream:${stream}#${topic}`;
      }
    }
  }
  const thread = typeof params.agentThreadId === "string" ? params.agentThreadId.trim() : "";
  if (to && /^stream:/i.test(to) && thread) {
    return `${to}#${thread}`;
  }
  return undefined;
}

export async function maybeApplyTodoProgressFromSubagent(params: {
  sessionKey?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  text?: string;
}): Promise<{ applied: boolean; summary?: string }> {
  const topicKey = getTodoTopicKey(params);
  if (!topicKey) {
    return { applied: false };
  }
  const list = findActiveListByTopic(topicKey);
  if (!list) {
    return { applied: false };
  }
  const text = params.text?.trim();
  if (!text) {
    return { applied: false };
  }

  const event = extractTodoEvent(text);
  if (!event) {
    return { applied: false };
  }

  const assignee = params.sessionKey?.trim();
  if (!assignee) {
    return { applied: false };
  }

  const applied = await applySubagentProgressEvent({ topicKey, assignee, event });
  if (!applied) {
    return { applied: false };
  }
  await syncTodoBackingMessage(applied.list);
  return {
    applied: true,
    summary: renderCompact(applied.list),
  };
}

export function getActiveTodoSnapshot(topicKey?: string): string | undefined {
  if (!topicKey) {
    return undefined;
  }
  const list = findActiveListByTopic(topicKey);
  return list ? renderCompact(list) : undefined;
}

function extractTodoEvent(text: string):
  | { type: "todo-ack"; itemId?: string; notes?: string }
  | {
      type: "todo-progress";
      itemId?: string;
      status?: TodoList["items"][number]["status"];
      notes?: string;
      title?: string;
    }
  | { type: "todo-complete"; itemId?: string; notes?: string }
  | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of matches) {
    const body = match[1]?.trim();
    if (!body) {
      continue;
    }
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const type = normalizeToolName(typeof parsed.type === "string" ? parsed.type : "");
      if (type === "todo_ack") {
        return {
          type: "todo-ack",
          itemId: typeof parsed.itemId === "string" ? parsed.itemId : undefined,
          notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
        };
      }
      if (type === "todo_progress") {
        const status = typeof parsed.status === "string" ? parsed.status : undefined;
        return {
          type: "todo-progress",
          itemId: typeof parsed.itemId === "string" ? parsed.itemId : undefined,
          notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
          title: typeof parsed.title === "string" ? parsed.title : undefined,
          status:
            status === "pending" ||
            status === "in-progress" ||
            status === "done" ||
            status === "blocked" ||
            status === "cancelled"
              ? status
              : undefined,
        };
      }
      if (type === "todo_complete") {
        return {
          type: "todo-complete",
          itemId: typeof parsed.itemId === "string" ? parsed.itemId : undefined,
          notes: typeof parsed.notes === "string" ? parsed.notes : undefined,
        };
      }
    } catch {
      // ignore invalid JSON blocks
    }
  }
  return null;
}

export function initializeTodoTopicSupport(params?: {
  activeSessionKeys?: Iterable<string>;
}): void {
  if (initialized) {
    return;
  }
  initialized = true;
  loadFromDisk();
  registerSyncCallback(syncBackingMessage);
  startLifecycleSweeper();
  const activeSessionKeys = new Set(params?.activeSessionKeys ?? []);
  recoverAfterRestart(activeSessionKeys);
  // Only sync active (non-archived) lists that already have a backing message.
  // Archived lists don't need their backing message refreshed, and lists
  // without a backingMessageId will get one created on the next mutation.
  for (const list of getAllLists()) {
    if (!list.archived && list.backingMessageId) {
      void syncTodoBackingMessage(list);
    }
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetTopicForTests(): void {
  initialized = false;
  backingMessageInflight.clear();
}
