import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./accounts.js";
import type { ZulipAuth } from "./client.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { normalizeStreamName } from "./normalize.js";
import { normalizeTopic } from "./normalize.js";
import { sendWithReactionButtons, type ReactionButtonOption } from "./reaction-buttons.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";
import { parseZulipTarget } from "./targets.js";
import { uploadZulipFile, resolveOutboundMedia } from "./uploads.js";

type ActionParams = Record<string, unknown>;

const CHANNEL_MUTATION_ACTIONS = ["channel-create", "channel-edit", "channel-delete"] as const;
type ChannelMutationAction = (typeof CHANNEL_MUTATION_ACTIONS)[number];

type ZulipActionConfig = {
  channelCreate?: boolean;
  channelEdit?: boolean;
  channelDelete?: boolean;
};

function resolveZulipActionConfig(
  cfg: unknown,
  accountId?: string | null,
): ZulipActionConfig | undefined {
  const openClawCfg = cfg as OpenClawConfig | undefined;
  const provider = openClawCfg?.channels?.zulip as
    | {
        actions?: ZulipActionConfig;
        accounts?: Record<string, { actions?: ZulipActionConfig }>;
      }
    | undefined;
  if (!provider) return undefined;

  const normalizedAccountId = typeof accountId === "string" ? accountId.trim().toLowerCase() : "";
  const accounts = provider.accounts;
  if (normalizedAccountId && accounts && typeof accounts === "object") {
    const accountEntry =
      accounts[accountId ?? ""] ??
      Object.entries(accounts).find(
        ([key]) => key.trim().toLowerCase() == normalizedAccountId,
      )?.[1];
    if (accountEntry) {
      return { ...provider.actions, ...accountEntry.actions };
    }
  }

  return provider.actions;
}

function isZulipActionEnabled(
  cfg: unknown,
  action: ChannelMutationAction,
  accountId?: string | null,
): boolean {
  const actions = resolveZulipActionConfig(cfg, accountId);
  switch (action) {
    case "channel-create":
      return actions?.channelCreate === true;
    case "channel-edit":
      return actions?.channelEdit === true;
    case "channel-delete":
      return actions?.channelDelete === true;
  }
}

function assertZulipActionEnabled(
  cfg: unknown,
  action: ChannelMutationAction,
  accountId?: string | null,
): void {
  if (isZulipActionEnabled(cfg, action, accountId)) return;
  throw new Error(
    `Zulip action ${action} is disabled. Enable channels.zulip.actions.${
      action === "channel-create"
        ? "channelCreate"
        : action === "channel-edit"
          ? "channelEdit"
          : "channelDelete"
    } to allow it.`,
  );
}

type ZulipMessagesResponse = {
  result?: string;
  messages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type ZulipStreamsResponse = {
  result?: string;
  streams?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type ZulipUserResponse = {
  result?: string;
  user?: Record<string, unknown>;
  [key: string]: unknown;
};

type ZulipUserDirectoryEntry = Record<string, unknown> & {
  user_id?: number;
  email?: string;
  full_name?: string;
};

type ZulipUserDirectoryResponse = {
  result?: string;
  members?: ZulipUserDirectoryEntry[];
  users?: ZulipUserDirectoryEntry[];
  [key: string]: unknown;
};

function resolveAuth(
  cfg: unknown,
  accountId?: string | null,
): {
  auth: ZulipAuth;
  account: ReturnType<typeof resolveZulipAccount>;
} {
  const account = resolveZulipAccount({
    cfg: cfg as Parameters<typeof resolveZulipAccount>[0]["cfg"],
    accountId: accountId ?? undefined,
  });
  if (!account.baseUrl || !account.email || !account.apiKey) {
    throw new Error("Missing Zulip credentials");
  }
  return {
    auth: { baseUrl: account.baseUrl, email: account.email, apiKey: account.apiKey },
    account,
  };
}

function requireString(params: ActionParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required parameter: ${key}`);
  }
  return value.trim();
}

function optionalString(params: ActionParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return String(value);
  return value.trim() || undefined;
}

function optionalBoolean(params: ActionParams, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function optionalNumber(params: ActionParams, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function resolveLimit(params: ActionParams, fallback = 20): number {
  const value = optionalNumber(params, "limit") ?? optionalNumber(params, "numBefore") ?? fallback;
  return Math.max(1, Math.floor(value));
}

function resolveMemberLookupValue(params: ActionParams): string | undefined {
  const candidates = [
    optionalString(params, "target"),
    optionalString(params, "participant"),
    optionalString(params, "userId"),
    optionalString(params, "email"),
    optionalString(params, "user"),
    optionalString(params, "name"),
  ];
  return candidates.find((value) => typeof value === "string" && value.trim().length > 0);
}

function normalizeMemberLookupValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^zulip:/i.test(trimmed)) {
    return trimmed.replace(/^zulip:/i, "").trim() || undefined;
  }
  if (/^pm:/i.test(trimmed)) {
    return trimmed.replace(/^pm:/i, "").trim() || undefined;
  }
  return trimmed;
}

function getDirectoryCandidates(response: ZulipUserDirectoryResponse): ZulipUserDirectoryEntry[] {
  if (Array.isArray(response.members)) return response.members;
  if (Array.isArray(response.users)) return response.users;
  return [];
}

function scoreDirectoryCandidate(candidate: ZulipUserDirectoryEntry, lookup: string): number {
  const email = typeof candidate.email === "string" ? candidate.email.trim().toLowerCase() : "";
  const fullName =
    typeof candidate.full_name === "string" ? candidate.full_name.trim().toLowerCase() : "";
  const normalized = lookup.trim().toLowerCase();
  if (!normalized) return -1;
  if (email && email === normalized) return 100;
  if (fullName && fullName === normalized) return 95;
  const local = email.split("@")[0] || "";
  if (local && local === normalized) return 90;
  if (email && email.startsWith(normalized + "@")) return 85;
  if (fullName && fullName.startsWith(normalized)) return 80;
  if (fullName && fullName.includes(normalized)) return 70;
  if (email && email.includes(normalized)) return 60;
  return -1;
}

async function resolveMemberIdentifier(auth: ZulipAuth, params: ActionParams): Promise<string> {
  const rawLookup = resolveMemberLookupValue(params);
  const lookup = normalizeMemberLookupValue(rawLookup);
  if (!lookup || lookup.toLowerCase() === "me") {
    return "me";
  }
  if (/^\d+$/.test(lookup)) {
    return lookup;
  }
  if (lookup.includes("@")) {
    return lookup;
  }

  const directory = await zulipRequest<ZulipUserDirectoryResponse>({
    auth,
    method: "GET",
    path: "/api/v1/users",
  });
  const best = getDirectoryCandidates(directory)
    .map((candidate) => ({ candidate, score: scoreDirectoryCandidate(candidate, lookup) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)[0];
  const candidate = best?.candidate;
  if (candidate?.email && typeof candidate.email === "string") return candidate.email;
  if (typeof candidate?.user_id === "number" && Number.isFinite(candidate.user_id)) {
    return String(candidate.user_id);
  }
  return lookup;
}

function requireStreamTarget(
  params: ActionParams,
  accountDefaultTopic?: string,
): {
  stream: string;
  topic?: string;
  target: string;
} {
  const target = requireString(params, "target");
  const parsed = parseZulipTarget(target);
  if (!parsed) {
    throw new Error(`Invalid Zulip target: ${target}. Use stream:<name>#<topic>`);
  }
  const stream = normalizeStreamName(parsed.stream);
  const topic = normalizeTopic(parsed.topic) || normalizeTopic(accountDefaultTopic ?? "");
  if (!stream) throw new Error("Missing stream name");
  return { stream, topic, target };
}

async function listStreams(auth: ZulipAuth): Promise<Array<Record<string, unknown>>> {
  const response = await zulipRequest<ZulipStreamsResponse>({
    auth,
    method: "GET",
    path: "/api/v1/streams",
  });
  return Array.isArray(response.streams) ? response.streams : [];
}

async function resolveStreamId(params: {
  auth: ZulipAuth;
  stream?: string;
  streamId?: string | number;
}): Promise<number> {
  if (params.streamId !== undefined && params.streamId !== null) {
    const parsed = Number(params.streamId);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    throw new Error("Invalid streamId");
  }

  const streamName = normalizeStreamName(params.stream ?? "");
  if (!streamName) {
    throw new Error("Missing stream or streamId");
  }

  const streams = await listStreams(params.auth);
  const match = streams.find((stream) => {
    const name = typeof stream.name === "string" ? normalizeStreamName(stream.name) : "";
    return name === streamName;
  });
  const streamId = match && typeof match.stream_id === "number" ? match.stream_id : undefined;
  if (!streamId) {
    throw new Error(`Stream not found: ${streamName}`);
  }
  return streamId;
}

// -- Read --

async function handleRead(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth, account } = resolveAuth(cfg, accountId);
  const { stream, topic, target } = requireStreamTarget(params, account.defaultTopic);
  const numBefore = resolveLimit(params, 20);
  const narrow = [["stream", stream]];
  if (topic) narrow.push(["topic", topic]);

  const response = await zulipRequest<ZulipMessagesResponse>({
    auth,
    method: "GET",
    path: "/api/v1/messages",
    query: {
      anchor: "newest",
      num_before: numBefore,
      num_after: 0,
      narrow: JSON.stringify(narrow),
    },
  });

  return {
    ok: true,
    action: "read",
    target,
    count: Array.isArray(response.messages) ? response.messages.length : 0,
    messages: response.messages ?? [],
  };
}

// -- Search --

async function handleSearch(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth, account } = resolveAuth(cfg, accountId);
  const { stream, target } = requireStreamTarget(params, account.defaultTopic);
  const queryText = requireString(params, "query");
  const numBefore = resolveLimit(params, 20);

  const response = await zulipRequest<ZulipMessagesResponse>({
    auth,
    method: "GET",
    path: "/api/v1/messages",
    query: {
      anchor: "newest",
      num_before: numBefore,
      num_after: 0,
      narrow: JSON.stringify([
        ["stream", stream],
        ["search", queryText],
      ]),
    },
  });

  return {
    ok: true,
    action: "search",
    target,
    query: queryText,
    count: Array.isArray(response.messages) ? response.messages.length : 0,
    messages: response.messages ?? [],
  };
}

// -- Channel List --

async function handleChannelList(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const includePublic = optionalBoolean(params, "includePublic");
  const includeWebPublic = optionalBoolean(params, "includeWebPublic");
  const response = await zulipRequest<ZulipStreamsResponse>({
    auth,
    method: "GET",
    path: "/api/v1/streams",
    query: {
      include_public: includePublic,
      include_web_public: includeWebPublic,
    },
  });

  return {
    ok: true,
    action: "channel-list",
    count: Array.isArray(response.streams) ? response.streams.length : 0,
    streams: response.streams ?? [],
  };
}

// -- Channel Create --

async function handleChannelCreate(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const name = requireString(params, "name");
  const description = optionalString(params, "description");
  const isPrivate = optionalBoolean(params, "isPrivate");

  const subscription: Record<string, unknown> = { name };
  if (description) subscription.description = description;
  if (isPrivate !== undefined) subscription.is_private = isPrivate;

  await zulipRequestWithRetry({
    auth,
    method: "POST",
    path: "/api/v1/users/me/subscriptions",
    form: {
      subscriptions: JSON.stringify([subscription]),
    },
    retry: { maxRetries: 3 },
  });

  return { ok: true, action: "channel-create", name, description, isPrivate };
}

// -- Channel Edit --

function resolveChannelStreamLookup(params: ActionParams): {
  stream?: string;
  streamId?: string | number;
} {
  const target = optionalString(params, "target");
  const parsedTarget = target ? parseZulipTarget(target) : null;
  return {
    stream:
      parsedTarget?.stream ?? optionalString(params, "name") ?? optionalString(params, "stream"),
    streamId: optionalString(params, "streamId") ?? optionalNumber(params, "streamId"),
  };
}

async function handleChannelEdit(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const streamId = await resolveStreamId({
    auth,
    ...resolveChannelStreamLookup(params),
  });

  const form: Record<string, string | number | boolean | undefined> = {
    new_name: optionalString(params, "newName"),
    description: optionalString(params, "description"),
    is_private: optionalBoolean(params, "isPrivate"),
  };
  const hasChanges = Object.values(form).some((value) => value !== undefined);
  if (!hasChanges) {
    throw new Error("No channel updates provided");
  }

  await zulipRequestWithRetry({
    auth,
    method: "PATCH",
    path: `/api/v1/streams/${streamId}`,
    form,
    retry: { maxRetries: 3 },
  });

  return { ok: true, action: "channel-edit", streamId, updates: form };
}

// -- Channel Delete --

async function handleChannelDelete(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const streamId = await resolveStreamId({
    auth,
    ...resolveChannelStreamLookup(params),
  });

  await zulipRequest({
    auth,
    method: "DELETE",
    path: `/api/v1/streams/${streamId}`,
  });

  return { ok: true, action: "channel-delete", streamId };
}

// -- Member Info --

async function handleMemberInfo(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const userId = await resolveMemberIdentifier(auth, params);
  const response = await zulipRequest<ZulipUserResponse>({
    auth,
    method: "GET",
    path: userId === "me" ? "/api/v1/users/me" : `/api/v1/users/${encodeURIComponent(userId)}`,
  });

  return {
    ok: true,
    action: "member-info",
    requested: resolveMemberLookupValue(params) ?? "me",
    resolvedUserId: userId,
    user: response.user ?? response,
  };
}

// -- Edit --

async function handleEdit(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  const message = requireString(params, "message");
  await zulipRequestWithRetry({
    auth,
    method: "PATCH",
    path: `/api/v1/messages/${encodeURIComponent(messageId)}`,
    form: { content: message },
    retry: { maxRetries: 3 },
  });
  return { ok: true, action: "edit", messageId };
}

// -- Delete --

async function handleDelete(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  await zulipRequest({
    auth,
    method: "DELETE",
    path: `/api/v1/messages/${encodeURIComponent(messageId)}`,
  });
  return { ok: true, action: "delete", messageId };
}

// -- React --

async function handleReact(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth } = resolveAuth(cfg, accountId);
  const messageId = requireString(params, "messageId");
  const emoji = requireString(params, "emoji");
  const remove = params.remove === true;
  if (remove) {
    await removeZulipReaction({ auth, messageId: Number(messageId), emojiName: emoji });
  } else {
    await addZulipReaction({ auth, messageId: Number(messageId), emojiName: emoji });
  }
  return { ok: true, action: "react", messageId, emoji, remove };
}

// -- Send --

async function handleSend(params: ActionParams, cfg: unknown, accountId?: string | null) {
  const { auth, account } = resolveAuth(cfg, accountId);
  const target = requireString(params, "target");
  const message = optionalString(params, "message");
  const mediaUrl = optionalString(params, "media") ?? optionalString(params, "mediaUrl");

  const parsed = parseZulipTarget(target);
  if (!parsed) {
    throw new Error(`Invalid Zulip target: ${target}. Use stream:<name>#<topic>`);
  }
  const stream = normalizeStreamName(parsed.stream);
  const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
  if (!stream) throw new Error("Missing stream name");

  let uploadedUrl: string | undefined;
  if (mediaUrl) {
    const resolved = await resolveOutboundMedia({
      cfg: cfg as Parameters<typeof resolveOutboundMedia>[0]["cfg"],
      accountId: account.accountId,
      mediaUrl,
    });
    uploadedUrl = await uploadZulipFile({
      auth,
      buffer: resolved.buffer,
      contentType: resolved.contentType,
      filename: resolved.filename ?? "attachment",
    });
  }

  const content = [message, uploadedUrl].filter(Boolean).join("\n\n");
  if (!content) throw new Error("Nothing to send (no message or media)");

  const result = await sendZulipStreamMessage({ auth, stream, topic, content });
  return { ok: true, action: "send", messageId: String(result.id ?? "unknown") };
}

// -- Send With Reactions --

async function handleSendWithReactions(
  params: ActionParams,
  cfg: unknown,
  accountId?: string | null,
) {
  const { auth, account } = resolveAuth(cfg, accountId);
  const target = requireString(params, "target");
  const message = requireString(params, "message");
  const optionsRaw = params.options;
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 5 * 60 * 1000; // 5 minutes default

  const parsed = parseZulipTarget(target);
  if (!parsed) {
    throw new Error(`Invalid Zulip target: ${target}. Use stream:<name>#<topic>`);
  }
  const stream = normalizeStreamName(parsed.stream);
  const topic = normalizeTopic(parsed.topic) || account.defaultTopic;
  if (!stream) throw new Error("Missing stream name");

  // Parse options
  let options: ReactionButtonOption[];
  if (Array.isArray(optionsRaw)) {
    options = optionsRaw
      .map((opt) => {
        if (typeof opt === "string") {
          return { label: opt, value: opt };
        }
        if (opt && typeof opt === "object") {
          const label = (opt as Record<string, unknown>).label;
          const value = (opt as Record<string, unknown>).value;
          if (typeof label === "string") {
            return { label, value: typeof value === "string" ? value : label };
          }
        }
        return null;
      })
      .filter((opt): opt is ReactionButtonOption => opt !== null);
  } else {
    throw new Error("options must be an array of strings or {label, value} objects");
  }

  if (options.length === 0) {
    throw new Error("At least one option is required");
  }

  const result = await sendWithReactionButtons({
    auth,
    stream,
    topic,
    message,
    options,
    timeoutMs,
  });

  return {
    ok: true,
    action: "sendWithReactions",
    messageId: String(result.messageId),
    options: options.map((opt, idx) => ({ index: idx, label: opt.label, value: opt.value })),
  };
}

// -- Adapter --

const BASE_ACTIONS = [
  "send",
  "sendWithReactions",
  "edit",
  "delete",
  "react",
  "read",
  "search",
  "channel-list",
  "member-info",
] as const;

export const zulipMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg, accountId }) => {
    const actions = [...BASE_ACTIONS];
    if (isZulipActionEnabled(cfg, "channel-create", accountId)) actions.push("channel-create");
    if (isZulipActionEnabled(cfg, "channel-edit", accountId)) actions.push("channel-edit");
    if (isZulipActionEnabled(cfg, "channel-delete", accountId)) actions.push("channel-delete");
    return actions;
  },
  supportsAction: ({ action, cfg, accountId }) => {
    if ((BASE_ACTIONS as readonly string[]).includes(action)) return true;
    return (CHANNEL_MUTATION_ACTIONS as readonly string[]).includes(action)
      ? isZulipActionEnabled(cfg, action as ChannelMutationAction, accountId)
      : false;
  },
  extractToolSend: ({ args }) => {
    const target = args.target ?? args.to;
    if (typeof target !== "string" || !target.trim()) return null;
    return { to: target.trim(), accountId: (args.accountId as string) ?? undefined };
  },
  handleAction: async (ctx): Promise<AgentToolResult<unknown>> => {
    const { action, params, cfg, accountId } = ctx;
    let result: unknown;
    switch (action) {
      case "send":
        result = await handleSend(params, cfg, accountId);
        break;
      case "sendWithReactions":
        result = await handleSendWithReactions(params, cfg, accountId);
        break;
      case "edit":
        result = await handleEdit(params, cfg, accountId);
        break;
      case "delete":
        result = await handleDelete(params, cfg, accountId);
        break;
      case "react":
        result = await handleReact(params, cfg, accountId);
        break;
      case "read":
        result = await handleRead(params, cfg, accountId);
        break;
      case "search":
        result = await handleSearch(params, cfg, accountId);
        break;
      case "channel-list":
        result = await handleChannelList(params, cfg, accountId);
        break;
      case "channel-create":
        assertZulipActionEnabled(cfg, "channel-create", accountId);
        result = await handleChannelCreate(params, cfg, accountId);
        break;
      case "channel-edit":
        assertZulipActionEnabled(cfg, "channel-edit", accountId);
        result = await handleChannelEdit(params, cfg, accountId);
        break;
      case "channel-delete":
        assertZulipActionEnabled(cfg, "channel-delete", accountId);
        result = await handleChannelDelete(params, cfg, accountId);
        break;
      case "member-info":
        result = await handleMemberInfo(params, cfg, accountId);
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  },
};
