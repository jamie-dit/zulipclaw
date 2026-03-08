import { dispatchChannelMessageAction } from "../channels/plugins/message-actions.js";
import { loadConfig } from "../config/config.js";
import { registerSyncCallback, scheduleSyncForList } from "./todo-lifecycle.js";
import { renderCompact } from "./todo-render.js";
import {
  type TodoList,
  applySubagentProgressEvent,
  findActiveListByTopic,
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

function parseTopicKey(topicKey: string): { stream: string; topic: string } | null {
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

async function ensureBackingMessage(list: TodoList): Promise<string | undefined> {
  if (list.backingMessageId) {
    return list.backingMessageId;
  }
  const topic = parseTopicKey(list.topicKey);
  if (!topic) {
    return undefined;
  }
  const cfg = loadConfig();
  const result = await dispatchChannelMessageAction({
    channel: "zulip",
    action: "send",
    cfg,
    accountId: undefined,
    params: {
      channel: "zulip",
      target: `stream:${topic.stream}#${topic.topic}`,
      message: `## 📋 ${list.title}\n\n_Preparing todo board..._`,
    },
    dryRun: false,
  });
  const messageId =
    result && typeof result === "object" && "payload" in result
      ? String((result as { payload?: { messageId?: string | number } }).payload?.messageId ?? "")
      : "";
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
  const cfg = loadConfig();
  await dispatchChannelMessageAction({
    channel: "zulip",
    action: "edit",
    cfg,
    accountId: undefined,
    params: {
      channel: "zulip",
      messageId,
      message: content,
    },
    dryRun: false,
  });
}

export async function syncTodoBackingMessage(list: TodoList): Promise<void> {
  if (!parseTopicKey(list.topicKey)) {
    return;
  }
  const messageId = await ensureBackingMessage(list);
  if (!messageId) {
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
  const activeSessionKeys = new Set(params?.activeSessionKeys ?? []);
  recoverAfterRestart(activeSessionKeys);
  for (const list of getAllLists()) {
    void syncTodoBackingMessage(list);
  }
}
