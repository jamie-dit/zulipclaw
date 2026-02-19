import { dispatchChannelMessageAction } from "../channels/plugins/message-actions.js";
import { loadConfig } from "../config/config.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";

export type SubagentRelayDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type SubagentRelayRegistration = {
  runId: string;
  label?: string;
  model?: string;
  startedAt?: number;
  deliveryContext?: SubagentRelayDeliveryContext;
};

type RelayState = {
  runId: string;
  messageId?: string;
  label: string;
  model: string;
  toolLines: string[];
  startedAt: number;
  deliveryContext: {
    channel: string;
    to: string;
    accountId?: string;
  };
  editTimer?: NodeJS.Timeout;
  toolCount: number;
  status?: "running" | "ok" | "error";
};

const TOOL_EMOJI: Record<string, string> = {
  read: "📄",
  exec: "🔧",
  edit: "✏️",
  write: "📝",
  web_search: "🔍",
  web_fetch: "🌐",
  browser: "🖥️",
  message: "💬",
  memory_search: "🧠",
  sessions_spawn: "🧑‍💻",
};

const registrationsByRun = new Map<string, SubagentRelayRegistration>();
const relayByRun = new Map<string, RelayState>();
let listenerInitialized = false;

function resolveRelayConfig() {
  const cfg = loadConfig();
  const relay = cfg.agents?.defaults?.subagents?.relay;
  return {
    enabled: relay?.enabled ?? true,
    level: relay?.level ?? "tools",
  } as const;
}

function isRelayEnabled() {
  const cfg = resolveRelayConfig();
  if (!cfg.enabled) {
    return false;
  }
  return cfg.level === "tools" || cfg.level === "full" || cfg.level === "summary";
}

function normalizeDeliveryContext(ctx?: SubagentRelayDeliveryContext) {
  const channel = typeof ctx?.channel === "string" ? ctx.channel.trim().toLowerCase() : "";
  const to = typeof ctx?.to === "string" ? ctx.to.trim() : "";
  const accountId = typeof ctx?.accountId === "string" ? ctx.accountId.trim() : "";
  if (!channel || !to) {
    return undefined;
  }
  return {
    channel,
    to,
    accountId: accountId || undefined,
  };
}

function isSupportedZulipContext(ctx?: SubagentRelayDeliveryContext) {
  const normalized = normalizeDeliveryContext(ctx);
  if (!normalized) {
    return false;
  }
  if (normalized.channel !== "zulip") {
    return false;
  }
  return normalized.to.includes("#");
}

function truncate(value: string, max = 80) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

function readRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function formatReadDetail(args: Record<string, unknown>) {
  const rawPath =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    "(unknown path)";
  const start =
    typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : undefined;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined;
  if (start && limit && limit > 0) {
    const end = Math.max(start, start + Math.floor(limit) - 1);
    return `${rawPath} [lines ${Math.floor(start)}-${Math.floor(end)}]`;
  }
  if (start) {
    return `${rawPath} [from line ${Math.floor(start)}]`;
  }
  return rawPath;
}

function formatToolDetail(toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "read":
      return formatReadDetail(args);
    case "exec":
      return truncate(
        (typeof args.command === "string" && args.command) ||
          (typeof args.cmd === "string" && args.cmd) ||
          "(no command)",
      );
    case "edit":
    case "write": {
      const rawPath =
        (typeof args.path === "string" && args.path) ||
        (typeof args.file_path === "string" && args.file_path) ||
        "(unknown path)";
      return rawPath;
    }
    case "web_search":
      return truncate((typeof args.query === "string" && args.query) || "(no query)");
    case "web_fetch":
      return truncate((typeof args.url === "string" && args.url) || "(no url)");
    case "browser":
      return truncate((typeof args.action === "string" && args.action) || "(no action)");
    case "message": {
      const action = (typeof args.action === "string" && args.action) || "send";
      const target =
        (typeof args.target === "string" && args.target) ||
        (typeof args.to === "string" && args.to) ||
        "";
      return truncate(target ? `${action} ${target}` : action);
    }
    default:
      return "";
  }
}

function formatToolLine(toolNameRaw: string, args: unknown) {
  const toolName = toolNameRaw.trim().toLowerCase();
  const emoji = TOOL_EMOJI[toolName] ?? "🔨";
  const detail = formatToolDetail(toolName, readRecord(args));
  const title = toolName.replaceAll("_", " ");
  if (!detail) {
    return `${emoji} ${title}`;
  }
  return `${emoji} ${title}: ${detail}`;
}

function formatElapsedShort(startedAt: number, now = Date.now()) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function escapeMarkdown(value: string) {
  return value.replace(/[*_`]/g, "\\$&");
}

function renderRelayMessage(state: RelayState) {
  const header = `🧑‍💻 **Sub-agent: ${escapeMarkdown(state.label)}** (${escapeMarkdown(state.model)})`;
  const lines: string[] = [header];
  for (const line of state.toolLines) {
    lines.push(`├ ${line}`);
  }
  const statusEmoji = state.status === "ok" ? "✅ " : state.status === "error" ? "❌ " : "";
  const callWord = state.toolCount === 1 ? "tool call" : "tool calls";
  lines.push(
    `└ ${statusEmoji}⏱️ ${formatElapsedShort(state.startedAt)} · ${state.toolCount} ${callWord}`,
  );
  return lines.join("\n");
}

function parseMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const data = result as { details?: unknown; content?: unknown };
  const details = data.details;
  if (details && typeof details === "object") {
    const id = (details as { messageId?: unknown }).messageId;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
    if (typeof id === "number" && Number.isFinite(id)) {
      return String(id);
    }
  }
  const content = Array.isArray(data.content) ? data.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as { messageId?: unknown };
      if (typeof parsed.messageId === "string" && parsed.messageId.trim()) {
        return parsed.messageId.trim();
      }
      if (typeof parsed.messageId === "number" && Number.isFinite(parsed.messageId)) {
        return String(parsed.messageId);
      }
    } catch {
      // ignore non-json content blocks
    }
  }
  return undefined;
}

async function sendRelayMessage(state: RelayState, message: string) {
  const cfg = loadConfig();
  const result = await dispatchChannelMessageAction({
    channel: "zulip",
    action: "send",
    cfg,
    accountId: state.deliveryContext.accountId,
    params: {
      channel: "zulip",
      target: state.deliveryContext.to,
      message,
      accountId: state.deliveryContext.accountId,
    },
    dryRun: false,
  });
  if (!result) {
    throw new Error("Zulip send action unavailable");
  }
  const messageId = parseMessageId(result);
  if (!messageId) {
    throw new Error("Zulip send relay returned no messageId");
  }
  state.messageId = messageId;
}

async function editRelayMessage(state: RelayState, message: string) {
  if (!state.messageId) {
    return sendRelayMessage(state, message);
  }
  const cfg = loadConfig();
  const result = await dispatchChannelMessageAction({
    channel: "zulip",
    action: "edit",
    cfg,
    accountId: state.deliveryContext.accountId,
    params: {
      channel: "zulip",
      messageId: state.messageId,
      message,
      accountId: state.deliveryContext.accountId,
    },
    dryRun: false,
  });
  if (!result) {
    throw new Error("Zulip edit action unavailable");
  }
}

async function flushRelayMessage(runId: string, options?: { finalize?: boolean }) {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }
  const message = renderRelayMessage(state);
  try {
    if (state.messageId) {
      await editRelayMessage(state, message);
    } else {
      await sendRelayMessage(state, message);
    }
  } catch (err) {
    defaultRuntime.log?.(`[warn] subagent relay flush failed for run ${runId}: ${String(err)}`);
  }
  if (options?.finalize) {
    if (state.editTimer) {
      clearTimeout(state.editTimer);
      state.editTimer = undefined;
    }
    relayByRun.delete(runId);
    registrationsByRun.delete(runId);
  }
}

function scheduleRelayFlush(runId: string) {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }
  if (state.editTimer) {
    return;
  }
  state.editTimer = setTimeout(() => {
    const current = relayByRun.get(runId);
    if (!current) {
      return;
    }
    current.editTimer = undefined;
    void flushRelayMessage(runId);
  }, 200);
  state.editTimer.unref?.();
}

function getOrCreateRelayState(runId: string): RelayState | undefined {
  const existing = relayByRun.get(runId);
  if (existing) {
    return existing;
  }
  const registration = registrationsByRun.get(runId);
  if (!registration || !isSupportedZulipContext(registration.deliveryContext)) {
    return undefined;
  }
  const deliveryContext = normalizeDeliveryContext(registration.deliveryContext);
  if (!deliveryContext) {
    return undefined;
  }
  const state: RelayState = {
    runId,
    label: registration.label?.trim() || "worker",
    model: registration.model?.trim() || "default",
    startedAt:
      typeof registration.startedAt === "number" && Number.isFinite(registration.startedAt)
        ? registration.startedAt
        : Date.now(),
    toolLines: [],
    deliveryContext,
    toolCount: 0,
    status: "running",
  };
  relayByRun.set(runId, state);
  return state;
}

function handleToolEvent(evt: AgentEventPayload) {
  if (!isRelayEnabled()) {
    return;
  }
  const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
  if (phase !== "start") {
    return;
  }
  const toolName = typeof evt.data?.name === "string" ? evt.data.name : "tool";
  const state = getOrCreateRelayState(evt.runId);
  if (!state) {
    return;
  }
  const args = evt.data?.args;
  const line = formatToolLine(toolName, args);
  state.toolLines.push(line);
  state.toolCount += 1;
  scheduleRelayFlush(evt.runId);
}

function handleLifecycleEvent(evt: AgentEventPayload) {
  const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
  if (phase === "start") {
    const registration = registrationsByRun.get(evt.runId);
    if (
      registration &&
      typeof evt.data?.startedAt === "number" &&
      Number.isFinite(evt.data.startedAt)
    ) {
      registration.startedAt = evt.data.startedAt;
      const state = relayByRun.get(evt.runId);
      if (state) {
        state.startedAt = evt.data.startedAt;
      }
    }
    return;
  }
  if (phase !== "end" && phase !== "error") {
    return;
  }
  const state = relayByRun.get(evt.runId);
  if (!state) {
    registrationsByRun.delete(evt.runId);
    return;
  }
  const failed = phase === "error" || evt.data?.aborted === true;
  state.status = failed ? "error" : "ok";
  void flushRelayMessage(evt.runId, { finalize: true });
}

export function initSubagentRelay() {
  if (listenerInitialized) {
    return;
  }
  listenerInitialized = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream === "tool") {
      handleToolEvent(evt);
      return;
    }
    if (evt.stream === "lifecycle") {
      handleLifecycleEvent(evt);
    }
  });
}

export function registerSubagentRelayRun(params: SubagentRelayRegistration) {
  const runId = params.runId?.trim();
  if (!runId || !isRelayEnabled()) {
    return;
  }
  if (!isSupportedZulipContext(params.deliveryContext)) {
    return;
  }
  registrationsByRun.set(runId, {
    runId,
    label: params.label,
    model: params.model,
    startedAt: params.startedAt,
    deliveryContext: normalizeDeliveryContext(params.deliveryContext),
  });
}

export function unregisterSubagentRelayRun(runId: string) {
  const key = runId.trim();
  if (!key) {
    return;
  }
  const state = relayByRun.get(key);
  if (state?.editTimer) {
    clearTimeout(state.editTimer);
  }
  relayByRun.delete(key);
  registrationsByRun.delete(key);
}
