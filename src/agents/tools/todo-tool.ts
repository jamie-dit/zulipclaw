/**
 * Todo list tool for structured task tracking within Zulip topics.
 *
 * Actions: create, add, update, complete, delete, archive, list.
 *
 * Ownership model:
 * - Main session can perform all actions.
 * - Sub-agents can only update/complete items assigned to them.
 * - Sub-agents wanting to add items should emit structured events
 *   for the main session to ingest (returned as tool guidance).
 */

import { Type } from "@sinclair/typebox";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { scheduleSyncForList } from "../todo-lifecycle.js";
import { renderCompact } from "../todo-render.js";
import {
  type TodoItemStatus,
  createList,
  addItem,
  updateItem,
  completeItem,
  deleteItem,
  archiveList,
  findActiveListByTopic,
  getList,
  getAllLists,
  summariseList,
  checkOwnership,
} from "../todo-state.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const TODO_ACTIONS = ["create", "add", "update", "complete", "delete", "archive", "list"] as const;
const TODO_STATUSES: TodoItemStatus[] = ["pending", "in-progress", "done", "blocked", "cancelled"];

const TodoToolSchema = Type.Object({
  action: stringEnum(TODO_ACTIONS),
  /** Topic key for scoping (e.g. "stream:marcel-zulipclaw#todo list tracking"). Required for create/list. */
  topicKey: Type.Optional(Type.String()),
  /** List ID. Required for add/update/complete/delete/archive. Auto-resolved from topicKey if omitted. */
  listId: Type.Optional(Type.String()),
  /** Title for the list (create) or item (add). */
  title: Type.Optional(Type.String()),
  /** Item ID. Required for update/complete/delete. */
  itemId: Type.Optional(Type.String()),
  /** New status for update action. */
  status: Type.Optional(optionalStringEnum(TODO_STATUSES as unknown as readonly string[])),
  /** Assignee session key for item. */
  assignee: Type.Optional(Type.String()),
  /** Notes for item. */
  notes: Type.Optional(Type.String()),
  /** If true, include archived lists in list output. */
  includeArchived: Type.Optional(Type.Boolean()),
});

export type TodoToolOptions = {
  agentSessionKey?: string;
};

export function createTodoTool(opts?: TodoToolOptions): AnyAgentTool {
  return {
    label: "Todo",
    name: "todo",
    description:
      "Manage todo lists for tracking tasks within Zulip topics. " +
      "Actions: create (new list for a topic), add (item to list), " +
      "update (item status/title/notes), complete (mark item done), " +
      "delete (remove item), archive (close list), list (show all lists or items in a list). " +
      "One active list per topic. Main session owns writes; sub-agents can only update/complete their assigned items.",
    parameters: TodoToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const sessionKey = opts?.agentSessionKey ?? "unknown";

      switch (action) {
        case "create":
          return handleCreate(params, sessionKey);
        case "add":
          return handleAdd(params, sessionKey);
        case "update":
          return handleUpdate(params, sessionKey);
        case "complete":
          return handleComplete(params, sessionKey);
        case "delete":
          return handleDelete(params, sessionKey);
        case "archive":
          return handleArchive(params, sessionKey);
        case "list":
          return handleList(params);
        default:
          throw new Error(`Unknown todo action: ${action}`);
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveListId(params: Record<string, unknown>): string {
  const explicit = readStringParam(params, "listId");
  if (explicit) {
    return explicit;
  }

  const topicKey = readStringParam(params, "topicKey");
  if (topicKey) {
    const list = findActiveListByTopic(topicKey);
    if (list) {
      return list.id;
    }
    throw new Error(`No active todo list found for topic "${topicKey}". Use action=create first.`);
  }

  throw new Error("Either listId or topicKey is required.");
}

// ── Action handlers ──────────────────────────────────────────────────────────

async function handleCreate(params: Record<string, unknown>, sessionKey: string) {
  const topicKey = readStringParam(params, "topicKey", { required: true });
  const title = readStringParam(params, "title", { required: true });

  const list = await createList({ topicKey, title, ownerSessionKey: sessionKey });
  return jsonResult({
    ok: true,
    action: "create",
    list: summariseList(list),
    render: renderCompact(list),
  });
}

async function handleAdd(params: Record<string, unknown>, sessionKey: string) {
  const listId = resolveListId(params);
  const title = readStringParam(params, "title", { required: true });
  const assignee = readStringParam(params, "assignee");
  const notes = readStringParam(params, "notes");

  const list = getList(listId);
  if (!list) {
    throw new Error(`Todo list ${listId} not found`);
  }

  const ownership = checkOwnership(list, sessionKey, "add");
  if (!ownership.allowed) {
    return jsonResult({
      ok: false,
      action: "add",
      error: ownership.reason,
      hint: "Sub-agents should return a structured event like: { type: 'todo-request', action: 'add', title, notes }",
    });
  }

  const item = await addItem(listId, { title, assignee, notes });
  scheduleSyncForList(listId);

  return jsonResult({
    ok: true,
    action: "add",
    item,
    render: renderCompact(list),
  });
}

async function handleUpdate(params: Record<string, unknown>, sessionKey: string) {
  const listId = resolveListId(params);
  const itemId = readStringParam(params, "itemId", { required: true });
  const status = readStringParam(params, "status") as TodoItemStatus | undefined;
  const title = readStringParam(params, "title");
  const assignee = readStringParam(params, "assignee");
  const notes = readStringParam(params, "notes");

  const list = getList(listId);
  if (!list) {
    throw new Error(`Todo list ${listId} not found`);
  }

  const ownership = checkOwnership(list, sessionKey, "update", itemId);
  if (!ownership.allowed) {
    return jsonResult({
      ok: false,
      action: "update",
      error: ownership.reason,
      hint: "Emit a structured event: { type: 'todo-progress', itemId, status, notes }",
    });
  }

  const item = await updateItem(listId, itemId, { title, status, assignee, notes });
  scheduleSyncForList(listId);

  return jsonResult({
    ok: true,
    action: "update",
    item,
    render: renderCompact(list),
  });
}

async function handleComplete(params: Record<string, unknown>, sessionKey: string) {
  const listId = resolveListId(params);
  const itemId = readStringParam(params, "itemId", { required: true });
  const notes = readStringParam(params, "notes");

  const list = getList(listId);
  if (!list) {
    throw new Error(`Todo list ${listId} not found`);
  }

  const ownership = checkOwnership(list, sessionKey, "complete", itemId);
  if (!ownership.allowed) {
    return jsonResult({
      ok: false,
      action: "complete",
      error: ownership.reason,
      hint: "Emit a structured event: { type: 'todo-complete', itemId, notes }",
    });
  }

  const item = await completeItem(listId, itemId, notes);
  scheduleSyncForList(listId);

  return jsonResult({
    ok: true,
    action: "complete",
    item,
    render: renderCompact(list),
  });
}

async function handleDelete(params: Record<string, unknown>, sessionKey: string) {
  const listId = resolveListId(params);
  const itemId = readStringParam(params, "itemId", { required: true });

  const list = getList(listId);
  if (!list) {
    throw new Error(`Todo list ${listId} not found`);
  }

  const ownership = checkOwnership(list, sessionKey, "delete", itemId);
  if (!ownership.allowed) {
    return jsonResult({
      ok: false,
      action: "delete",
      error: ownership.reason,
    });
  }

  await deleteItem(listId, itemId);
  scheduleSyncForList(listId);

  return jsonResult({
    ok: true,
    action: "delete",
    itemId,
    render: renderCompact(list),
  });
}

async function handleArchive(params: Record<string, unknown>, sessionKey: string) {
  const listId = resolveListId(params);

  const list = getList(listId);
  if (!list) {
    throw new Error(`Todo list ${listId} not found`);
  }

  // Only owner can archive.
  if (sessionKey !== list.ownerSessionKey) {
    return jsonResult({
      ok: false,
      action: "archive",
      error: "Only the list owner can archive a list.",
    });
  }

  const archived = await archiveList(listId);
  return jsonResult({
    ok: true,
    action: "archive",
    list: summariseList(archived),
  });
}

async function handleList(params: Record<string, unknown>) {
  const topicKey = readStringParam(params, "topicKey");
  const listId = readStringParam(params, "listId");
  const includeArchived = params.includeArchived === true;

  // If a specific list is requested, return its full state.
  if (listId) {
    const list = getList(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }
    return jsonResult({
      ok: true,
      action: "list",
      list: summariseList(list),
      items: list.items,
      render: renderCompact(list),
    });
  }

  // If topic is specified, find the active list for it.
  if (topicKey) {
    const list = findActiveListByTopic(topicKey);
    if (!list) {
      return jsonResult({
        ok: true,
        action: "list",
        lists: [],
        message: `No active todo list for topic "${topicKey}".`,
      });
    }
    return jsonResult({
      ok: true,
      action: "list",
      list: summariseList(list),
      items: list.items,
      render: renderCompact(list),
    });
  }

  // Otherwise, return all lists (optionally including archived).
  const all = getAllLists().filter((l) => includeArchived || !l.archived);
  return jsonResult({
    ok: true,
    action: "list",
    lists: all.map(summariseList),
  });
}
