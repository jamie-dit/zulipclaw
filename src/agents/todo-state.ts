/**
 * Todo list state management with persistence and ownership model.
 *
 * Design:
 * - One active (unarchived) list per topic key.
 * - Main session owns all writes; sub-agents emit structured events
 *   (via their tool results) for the main session to ingest.
 * - Per-list serial queue prevents concurrent mutation races.
 * - State persisted to `<stateDir>/todo/lists.json` on every mutation.
 */

import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TodoItemStatus = "pending" | "in-progress" | "done" | "blocked" | "cancelled";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoItemStatus;
  assignee?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  lastAckAt?: number;
  lastAckBy?: string;
}

export interface TodoList {
  id: string;
  /** Scoping key – typically `stream:channel#topic`. */
  topicKey: string;
  title: string;
  ownerSessionKey: string;
  items: TodoItem[];
  archived: boolean;
  /** Zulip message ID of the backing message (for in-place edits). */
  backingMessageId?: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the last backing-message sync to Zulip. */
  lastSyncedAt?: number;
}

export type TodoListSummary = Pick<
  TodoList,
  "id" | "topicKey" | "title" | "archived" | "createdAt" | "updatedAt" | "backingMessageId"
> & {
  itemCount: number;
  doneCount: number;
  inProgressCount: number;
  blockedCount: number;
};

// ── Persistence ──────────────────────────────────────────────────────────────

const PERSIST_FILENAME = "todo/lists.json";

interface PersistedTodoState {
  version: 1;
  lists: Record<string, TodoList>;
}

function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), PERSIST_FILENAME);
}

// ── Store ────────────────────────────────────────────────────────────────────

const lists = new Map<string, TodoList>();

// Simple serial queue per list to prevent concurrent mutation.
const listLocks = new Map<string, Promise<void>>();

function withListLock<T>(listId: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = listLocks.get(listId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain going but don't leak errors to the queue itself.
  listLocks.set(
    listId,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

let nextItemCounter = 1;

function generateItemId(): string {
  return `item-${Date.now()}-${nextItemCounter++}`;
}

function generateListId(): string {
  return `list-${Date.now()}-${nextItemCounter++}`;
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/** Debounce persistence writes to avoid I/O on every mutation. */
const PERSIST_DEBOUNCE_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistDirty = false;

function persistImmediate(): void {
  persistDirty = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const data: PersistedTodoState = {
    version: 1,
    lists: Object.fromEntries(lists),
  };
  saveJsonFile(resolveStatePath(), data);
}

function persist(): void {
  persistDirty = true;
  if (persistTimer) {
    return;
  } // already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistDirty) {
      try {
        persistImmediate();
      } catch {
        // Non-fatal: next mutation will retry persistence.
      }
    }
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer.unref) {
    persistTimer.unref();
  }
}

export function loadFromDisk(): void {
  const raw = loadJsonFile(resolveStatePath());
  if (!raw || typeof raw !== "object") {
    return;
  }
  const state = raw as Partial<PersistedTodoState>;
  if (state.version !== 1 || !state.lists) {
    return;
  }
  lists.clear();
  for (const [id, list] of Object.entries(state.lists)) {
    if (list && typeof list === "object" && list.id) {
      lists.set(id, list);
    }
  }
}

// ── Query helpers ────────────────────────────────────────────────────────────

/** Find the active (non-archived) list for a given topic key. */
export function findActiveListByTopic(topicKey: string): TodoList | undefined {
  for (const list of lists.values()) {
    if (list.topicKey === topicKey && !list.archived) {
      return list;
    }
  }
  return undefined;
}

export function getList(listId: string): TodoList | undefined {
  return lists.get(listId);
}

export function getAllLists(): TodoList[] {
  return [...lists.values()];
}

export function summariseList(list: TodoList): TodoListSummary {
  return {
    id: list.id,
    topicKey: list.topicKey,
    title: list.title,
    archived: list.archived,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    itemCount: list.items.length,
    doneCount: list.items.filter((i) => i.status === "done").length,
    inProgressCount: list.items.filter((i) => i.status === "in-progress").length,
    blockedCount: list.items.filter((i) => i.status === "blocked").length,
    backingMessageId: list.backingMessageId,
  };
}

// ── Ownership check ──────────────────────────────────────────────────────────

export type OwnershipResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Check whether a session key is authorised to mutate a list.
 *
 * Rules:
 * - The list owner (main session) can do anything.
 * - A sub-agent can only update/complete items assigned to them.
 * - For "add", only the owner is allowed.
 */
export function checkOwnership(
  list: TodoList,
  sessionKey: string,
  action: "add" | "update" | "complete" | "delete",
  itemId?: string,
): OwnershipResult {
  // Owner can do everything.
  if (sessionKey === list.ownerSessionKey) {
    return { allowed: true };
  }

  // Sub-agents cannot add or delete items.
  if (action === "add" || action === "delete") {
    return {
      allowed: false,
      reason: `Only the list owner can ${action} items. Emit a structured event for the main session to process.`,
    };
  }

  // For update/complete, sub-agents can only modify their assigned items.
  if (itemId) {
    const item = list.items.find((i) => i.id === itemId);
    if (item && item.assignee === sessionKey) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason:
      "Sub-agents can only update/complete items assigned to them. Emit a structured event for the main session to process.",
  };
}

// ── Mutations (all go through serial queue + persist) ────────────────────────

export async function createList(params: {
  topicKey: string;
  title: string;
  ownerSessionKey: string;
}): Promise<TodoList> {
  const existing = findActiveListByTopic(params.topicKey);
  if (existing) {
    throw new Error(
      `An active todo list already exists for topic "${params.topicKey}" (id: ${existing.id}). Archive it first.`,
    );
  }

  const id = generateListId();
  const now = Date.now();
  const list: TodoList = {
    id,
    topicKey: params.topicKey,
    title: params.title,
    ownerSessionKey: params.ownerSessionKey,
    items: [],
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  lists.set(id, list);
  persist();
  return list;
}

export async function addItem(
  listId: string,
  params: { title: string; assignee?: string; notes?: string },
): Promise<TodoItem> {
  return withListLock(listId, () => {
    const list = lists.get(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }
    if (list.archived) {
      throw new Error(`Todo list ${listId} is archived`);
    }

    const now = Date.now();
    const item: TodoItem = {
      id: generateItemId(),
      title: params.title,
      status: "pending",
      assignee: params.assignee,
      notes: params.notes,
      createdAt: now,
      updatedAt: now,
    };
    list.items.push(item);
    list.updatedAt = now;
    persist();
    return item;
  });
}

export async function updateItem(
  listId: string,
  itemId: string,
  patch: {
    title?: string;
    status?: TodoItemStatus;
    assignee?: string;
    notes?: string;
    lastAckAt?: number;
    lastAckBy?: string;
  },
): Promise<TodoItem> {
  return withListLock(listId, () => {
    const list = lists.get(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }
    if (list.archived) {
      throw new Error(`Todo list ${listId} is archived`);
    }

    const item = list.items.find((i) => i.id === itemId);
    if (!item) {
      throw new Error(`Item ${itemId} not found in list ${listId}`);
    }

    const now = Date.now();
    if (patch.title !== undefined) {
      item.title = patch.title;
    }
    if (patch.status !== undefined) {
      item.status = patch.status;
    }
    if (patch.assignee !== undefined) {
      item.assignee = patch.assignee;
    }
    if (patch.notes !== undefined) {
      item.notes = patch.notes;
    }
    if (patch.lastAckAt !== undefined) {
      item.lastAckAt = patch.lastAckAt;
    }
    if (patch.lastAckBy !== undefined) {
      item.lastAckBy = patch.lastAckBy;
    }
    item.updatedAt = now;
    list.updatedAt = now;
    persist();
    return item;
  });
}

export async function completeItem(
  listId: string,
  itemId: string,
  notes?: string,
  ack?: { at?: number; by?: string },
): Promise<TodoItem> {
  return updateItem(listId, itemId, {
    status: "done",
    ...(notes !== undefined ? { notes } : {}),
    ...(ack?.at !== undefined ? { lastAckAt: ack.at } : {}),
    ...(ack?.by !== undefined ? { lastAckBy: ack.by } : {}),
  });
}

export async function deleteItem(listId: string, itemId: string): Promise<void> {
  return withListLock(listId, () => {
    const list = lists.get(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }
    if (list.archived) {
      throw new Error(`Todo list ${listId} is archived`);
    }

    const idx = list.items.findIndex((i) => i.id === itemId);
    if (idx === -1) {
      throw new Error(`Item ${itemId} not found in list ${listId}`);
    }

    list.items.splice(idx, 1);
    list.updatedAt = Date.now();
    persist();
  });
}

export async function archiveList(listId: string): Promise<TodoList> {
  return withListLock(listId, () => {
    const list = lists.get(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }
    if (list.archived) {
      throw new Error(`Todo list ${listId} is already archived`);
    }

    list.archived = true;
    list.updatedAt = Date.now();
    persist();
    return list;
  });
}

export function setBackingMessageId(listId: string, messageId: string): void {
  const list = lists.get(listId);
  if (list) {
    list.backingMessageId = messageId;
    persist();
  }
}

export function setLastSyncedAt(listId: string, ts: number): void {
  const list = lists.get(listId);
  if (list) {
    list.lastSyncedAt = ts;
    // No persist needed - lastSyncedAt is transient/derived.
  }
}

export function resolveItemByAssignee(list: TodoList, assignee: string): TodoItem | undefined {
  return list.items.find((item) => item.assignee === assignee && item.status !== "done");
}

export async function applySubagentProgressEvent(params: {
  topicKey: string;
  assignee: string;
  event:
    | {
        type: "todo-progress";
        itemId?: string;
        status?: TodoItemStatus;
        notes?: string;
        title?: string;
      }
    | { type: "todo-complete"; itemId?: string; notes?: string }
    | { type: "todo-ack"; itemId?: string; notes?: string };
}): Promise<{ list: TodoList; item: TodoItem } | null> {
  const list = findActiveListByTopic(params.topicKey);
  if (!list) {
    return null;
  }

  const targetItem =
    (params.event.itemId
      ? list.items.find((item) => item.id === params.event.itemId)
      : undefined) ?? resolveItemByAssignee(list, params.assignee);
  if (!targetItem) {
    return null;
  }

  const now = Date.now();
  if (params.event.type === "todo-complete") {
    const item = await completeItem(list.id, targetItem.id, params.event.notes, {
      at: now,
      by: params.assignee,
    });
    return { list, item };
  }

  const status =
    params.event.type === "todo-ack"
      ? "in-progress"
      : (params.event.status ??
        (targetItem.status === "pending" ? "in-progress" : targetItem.status));
  const title = "title" in params.event ? params.event.title : undefined;
  const item = await updateItem(list.id, targetItem.id, {
    ...(title !== undefined ? { title } : {}),
    ...(params.event.notes !== undefined ? { notes: params.event.notes } : {}),
    status,
    lastAckAt: now,
    lastAckBy: params.assignee,
  });
  return { list, item };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * After a gateway restart, mark in-progress items whose assignee is
 * no longer active as "blocked" with a recovery note.
 */
export function recoverAfterRestart(activeSessionKeys: Set<string>): number {
  let recovered = 0;
  for (const list of lists.values()) {
    if (list.archived) {
      continue;
    }
    for (const item of list.items) {
      if (item.status === "in-progress" && item.assignee && !activeSessionKeys.has(item.assignee)) {
        item.status = "blocked";
        item.notes = (item.notes ? `${item.notes} | ` : "") + "status unknown after restart";
        item.updatedAt = Date.now();
        recovered++;
      }
    }
  }
  if (recovered > 0) {
    persist();
  }
  return recovered;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Flush any pending debounced persist immediately. */
export function _flushPersistForTests(): void {
  if (persistDirty) {
    persistImmediate();
  }
}

export function _resetForTests(): void {
  lists.clear();
  listLocks.clear();
  nextItemCounter = 1;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistDirty = false;
}
