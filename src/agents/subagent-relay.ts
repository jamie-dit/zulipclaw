import path from "node:path";
import { dispatchChannelMessageAction } from "../channels/plugins/message-actions.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import { defaultRuntime } from "../runtime.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { extractToolResultText } from "./pi-embedded-subscribe.tools.js";
import {
  buildResumptionTask,
  readSessionProgressSummary,
  taskLooksResumable,
} from "./subagent-restart-recovery.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";

/**
 * ZulipClaw fork note:
 * This relay is intentionally Zulip-only (stream/topic targets) and is not
 * intended as a multi-platform formatting relay.
 */
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
  /** Child session key — used by the watchdog to steer idle sub-agents. */
  childSessionKey?: string;
  /** True when this sub-agent run is known to execute in the sandbox. */
  sandboxed?: boolean;
};

export type WatchdogStatus = "active" | "nudged" | "frozen";

export type ToolEntry = {
  line: string;
  name: string;
  startedAtMs?: number;
  completedAtMs?: number;
  resultText?: string;
  isError?: boolean;
};

export type RelayState = {
  runId: string;
  messageId?: string;
  /** Message ID of the mirrored relay message, if mirrorTopic is configured. */
  mirrorMessageId?: string;
  label: string;
  model: string;
  /** Auth profile short name (e.g. "jason") shown when provider has multiple profiles. */
  authProfile?: string;
  /** True when this run executes in the sandbox. */
  sandboxed?: boolean;
  toolEntries: ToolEntry[];
  /** toolCallId -> index within toolEntries; transient in-memory map only. */
  pendingToolCallIds: Map<string, number>;
  startedAt: number;
  deliveryContext: {
    channel: string;
    to: string;
    accountId?: string;
  };
  editTimer?: NodeJS.Timeout;
  toolCount: number;
  status?: "running" | "ok" | "error";
  lastUpdatedAt: number;
  /** Sub-agent's final text output, populated at completion for the relay card. */
  completionText?: string;
  /** Watchdog fields */
  watchdogTimer?: NodeJS.Timeout;
  watchdogFollowUpTimer?: NodeJS.Timeout;
  watchdogStatus?: WatchdogStatus;
  watchdogNudgedAt?: number;
  lastToolName?: string;
  lastToolArgs?: Record<string, unknown>;
  /** When the run was re-spawned, stores the new label for display in the relay message. */
  respawnedAs?: string;
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

/** Default watchdog idle timeout: 5 minutes. */
export const WATCHDOG_DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Follow-up timeout after nudge: 2 minutes. */
export const WATCHDOG_NUDGE_FOLLOWUP_MS = 2 * 60_000;
/** Buffer added to long exec timeouts. */
const WATCHDOG_EXEC_BUFFER_MS = 60_000;
/** Extended timeout for process polling actions. */
const WATCHDOG_PROCESS_TIMEOUT_MS = 10 * 60_000;
/** Extended timeout for sessions_spawn/subagents (waiting for child). */
const WATCHDOG_SPAWN_TIMEOUT_MS = 30 * 60_000;
/** Maximum number of watchdog respawns per task lineage. */
const WATCHDOG_MAX_RESPAWN_COUNT = 2;
/** Debounce delay for writing mirror state to disk. */
const MIRROR_STATE_SAVE_DEBOUNCE_MS = 500;

const registrationsByRun = new Map<string, SubagentRelayRegistration>();
const relayByRun = new Map<string, RelayState>();
let listenerInitialized = false;

// ---------------------------------------------------------------------------
// Mirror state persistence
// ---------------------------------------------------------------------------

/** Minimal entry persisted to disk so we can edit the mirror message after restart. */
export type PersistedMirrorEntry = {
  mirrorMessageId: string;
  label: string;
  originTopic?: string;
  mirrorTopic: string;
};

type PersistedMirrorFile = {
  version: 1;
  entries: Record<string, PersistedMirrorEntry>;
};

/** In-memory shadow of the persisted entries (avoids reading on every write). */
let persistedMirrorEntries: Record<string, PersistedMirrorEntry> = {};
let mirrorStateSaveTimer: NodeJS.Timeout | undefined;

/** Map of runId → mirrorMessageId restored during startup recovery for still-alive runs. */
const recoveredMirrorMessageIds = new Map<string, string>();

export function resolveMirrorStatePath(): string {
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, "relay", "mirror-state.json");
}

async function loadMirrorStateFromDisk(): Promise<Record<string, PersistedMirrorEntry>> {
  const filePath = resolveMirrorStatePath();
  const { value } = await readJsonFileWithFallback<PersistedMirrorFile | null>(filePath, null);
  if (!value || typeof value !== "object" || value.version !== 1) {
    return {};
  }
  const entries = value.entries;
  if (!entries || typeof entries !== "object") {
    return {};
  }
  return entries;
}

async function writeMirrorStateToDisk(): Promise<void> {
  try {
    const filePath = resolveMirrorStatePath();
    const payload: PersistedMirrorFile = {
      version: 1,
      entries: persistedMirrorEntries,
    };
    await writeJsonFileAtomically(filePath, payload);
  } catch (err) {
    defaultRuntime.log?.(`[warn] subagent relay: failed to persist mirror state: ${String(err)}`);
  }
}

function scheduleMirrorStateSave(): void {
  if (mirrorStateSaveTimer) {
    return;
  }
  mirrorStateSaveTimer = setTimeout(() => {
    mirrorStateSaveTimer = undefined;
    void writeMirrorStateToDisk();
  }, MIRROR_STATE_SAVE_DEBOUNCE_MS);
  mirrorStateSaveTimer.unref?.();
}

function upsertMirrorEntry(runId: string, entry: PersistedMirrorEntry): void {
  persistedMirrorEntries[runId] = entry;
  scheduleMirrorStateSave();
}

function removeMirrorEntry(runId: string): void {
  if (!(runId in persistedMirrorEntries)) {
    return;
  }
  delete persistedMirrorEntries[runId];
  scheduleMirrorStateSave();
}

function renderStaleMirrorMessage(entry: PersistedMirrorEntry): string {
  const originSuffix = entry.originTopic ? ` · 📍 ${entry.originTopic}` : "";
  return `❌ **\`${entry.label}\`** · stale (gateway restarted)${originSuffix}\n\n\`\`\`spoiler Tool calls\n(no data — recovered after restart)\n\`\`\``;
}

/**
 * Called once at startup: loads persisted mirror entries, checks if runs are
 * still alive, edits stale messages to ❌, and re-populates recovered IDs for
 * still-active runs.  Best-effort — never throws.
 */
export async function recoverMirrorState(): Promise<void> {
  try {
    const entries = await loadMirrorStateFromDisk();
    persistedMirrorEntries = { ...entries };
    const runIds = Object.keys(entries);
    if (runIds.length === 0) {
      return;
    }

    defaultRuntime.log?.(
      `[info] subagent relay: recovering ${runIds.length} stale mirror entr${runIds.length === 1 ? "y" : "ies"}`,
    );

    let changed = false;
    let recoveredCount = 0;
    let cleanedCount = 0;

    for (const runId of runIds) {
      const entry = entries[runId];
      if (!entry) {
        continue;
      }
      // Check if run is still active
      const alive = await checkSubagentAlive(runId);
      if (alive) {
        // Still running — store the message ID so getOrCreateRelayState can restore it
        recoveredMirrorMessageIds.set(runId, entry.mirrorMessageId);
        recoveredCount += 1;
        defaultRuntime.log?.(
          `[info] subagent relay: run ${runId} still alive, restored mirrorMessageId`,
        );
        continue;
      }
      // Dead — mark the mirror message as stale
      defaultRuntime.log?.(
        `[info] subagent relay: run ${runId} is dead, editing mirror message to ❌`,
      );
      try {
        const cfg = loadConfig();
        const staleText = renderStaleMirrorMessage(entry);
        await dispatchChannelMessageAction({
          channel: "zulip",
          action: "edit",
          cfg,
          accountId: undefined,
          params: {
            channel: "zulip",
            messageId: entry.mirrorMessageId,
            message: staleText,
          },
          dryRun: false,
        });
      } catch (editErr) {
        defaultRuntime.log?.(
          `[warn] subagent relay: failed to edit stale mirror message for run ${runId}: ${String(editErr)}`,
        );
      }
      // Always remove from persisted state regardless of edit success
      delete persistedMirrorEntries[runId];
      cleanedCount += 1;
      changed = true;
    }

    if (changed) {
      await writeMirrorStateToDisk();
    }

    defaultRuntime.log?.(
      `[info] subagent relay: recovery complete — ${recoveredCount} run(s) still active, ${cleanedCount} stale entr${cleanedCount === 1 ? "y" : "ies"} cleaned up`,
    );
  } catch (err) {
    defaultRuntime.log?.(`[warn] subagent relay: recoverMirrorState failed: ${String(err)}`);
  }
}

function resolveRelayConfig() {
  const cfg = loadConfig();
  const relay = cfg.agents?.defaults?.subagents?.relay;
  return {
    enabled: relay?.enabled ?? true,
    level: relay?.level ?? "tools",
    mirrorTopic: relay?.mirrorTopic,
  } as const;
}

/**
 * Extract the topic name from a stream:STREAM_NAME#TOPIC delivery target.
 * Returns undefined if the format does not match.
 */
export function extractOriginTopic(to: string): string | undefined {
  const hashIdx = to.indexOf("#");
  if (hashIdx < 0) {
    return undefined;
  }
  const topic = to.slice(hashIdx + 1).trim();
  return topic || undefined;
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

export function formatToolElapsed(startedAt: number, ts: number) {
  const hasValidTs = typeof ts === "number" && Number.isFinite(ts);
  const safeTs = hasValidTs ? ts : Date.now();

  let safeStartedAt =
    typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0
      ? startedAt
      : safeTs;

  if (!hasValidTs) {
    safeStartedAt = safeTs;
  }

  const totalSeconds = Math.max(0, Math.floor((safeTs - safeStartedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `+${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `+${Math.floor(totalSeconds / 60)}:${String(seconds).padStart(2, "0")}`;
}

export function formatToolLine(toolNameRaw: string, args: unknown, startedAt: number, ts: number) {
  const toolName = toolNameRaw.trim().toLowerCase();
  const emoji = TOOL_EMOJI[toolName] ?? "🔨";
  const detail = formatToolDetail(toolName, readRecord(args));
  const title = toolName.replaceAll("_", " ");

  // Guard against invalid timestamps - use current time if ts is invalid
  const validTs = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  const stamp = `[${formatToolElapsed(startedAt, validTs)}]`;

  if (!detail) {
    return `${stamp} ${emoji} ${title}`;
  }
  return `${stamp} ${emoji} ${title}: ${detail}`;
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

export function formatRelayUpdatedTime(ts: number) {
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

export function formatRelayFooter(
  params: Pick<RelayState, "startedAt" | "toolCount" | "status" | "lastUpdatedAt">,
  now = Date.now(),
) {
  const callWord = params.toolCount === 1 ? "tool call" : "tool calls";
  return `⏱️ ${formatElapsedShort(params.startedAt, now)} · ${params.toolCount} ${callWord} · updated ${formatRelayUpdatedTime(params.lastUpdatedAt)}`;
}

/**
 * Sanitize text for inclusion inside a triple-backtick code fence.
 * Breaks up runs of 3+ backticks with zero-width spaces so they
 * don't prematurely close the fence.
 */
function sanitizeForCodeFence(text: string): string {
  return text.replace(/`{3,}/g, (match) => match.split("").join("\u200B"));
}

/**
 * Truncate text at a markdown-safe boundary (prefer line breaks, close open code fences).
 */
function truncateMarkdownSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const breakpoint = lastNewline > maxChars * 0.3 ? lastNewline : maxChars;
  let preview = text.slice(0, breakpoint);
  // Close any unclosed code fences (odd count of triple-backtick sequences).
  const fenceCount = (preview.match(/`{3,}/g) || []).length;
  if (fenceCount % 2 !== 0) {
    preview += "\n```";
  }
  return preview;
}

const RELAY_STATUS_EMOJI: Record<string, string> = {
  running: "🔄",
  ok: "✅",
  error: "❌",
};

export function resolveWatchdogStatusEmoji(watchdogStatus?: WatchdogStatus): string {
  switch (watchdogStatus) {
    case "nudged":
      return " ⏳";
    case "frozen":
      return " ⚠️";
    default:
      return "";
  }
}

/**
 * Extract the short profile label from a full profileId.
 * e.g. "anthropic:jason" → "jason", "anthropic:default" → "default"
 */
export function extractProfileShortName(profileId: string): string {
  const colonIdx = profileId.indexOf(":");
  if (colonIdx < 0) {
    return profileId;
  }
  return profileId.slice(colonIdx + 1);
}

/** Maximum characters of completion text to embed in the relay message. */
const RELAY_COMPLETION_TEXT_MAX_CHARS = 2000;
/** Maximum characters of per-tool result text to embed in nested spoiler blocks. */
const RELAY_TOOL_RESULT_MAX_CHARS = 1000;

const RELAY_SUMMARY_ORDER = [
  "read",
  "edit",
  "write",
  "exec",
  "web_search",
  "web_fetch",
  "browser",
  "message",
  "memory_search",
  "sessions_spawn",
] as const;

function extractReadPathFromLine(line: string): string | undefined {
  const marker = " read: ";
  const markerIdx = line.indexOf(marker);
  if (markerIdx < 0) {
    return undefined;
  }
  const detail = line.slice(markerIdx + marker.length).trim();
  if (!detail) {
    return undefined;
  }
  const withoutRange = detail.replace(/\s+\[(?:lines\s+\d+-\d+|from line\s+\d+)\]$/i, "").trim();
  return withoutRange || undefined;
}

function formatToolDuration(startedAtMs?: number, completedAtMs?: number): string | undefined {
  if (
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof completedAtMs !== "number" ||
    !Number.isFinite(completedAtMs)
  ) {
    return undefined;
  }
  const elapsedMs = Math.max(0, completedAtMs - startedAtMs);
  if (elapsedMs >= 60_000) {
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds}s`;
  }
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function normalizeEditDiffField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseEditDiffFromResult(resultText: string): string | undefined {
  const trimmed = resultText.trim();
  if (!trimmed) {
    return undefined;
  }

  const looksLikeDiff =
    /(^|\n)[+-]\s+/m.test(trimmed) ||
    trimmed.includes("```diff") ||
    (trimmed.includes("\n-") && trimmed.includes("\n+"));
  if (looksLikeDiff) {
    return trimmed;
  }

  const candidates = [trimmed];
  const jsonFenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFenceMatch?.[1]) {
    candidates.push(jsonFenceMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const oldValue =
        normalizeEditDiffField(parsed.old_string) ??
        normalizeEditDiffField(parsed.oldText) ??
        normalizeEditDiffField(parsed.old);
      const newValue =
        normalizeEditDiffField(parsed.new_string) ??
        normalizeEditDiffField(parsed.newText) ??
        normalizeEditDiffField(parsed.new);
      if (oldValue && newValue) {
        return `- ${oldValue}\n+ ${newValue}`;
      }
    } catch {
      // fall through to regex parsing
    }
  }

  const oldMatch = trimmed.match(/old(?:_string|Text)?\s*[:=]\s*(.+)/i);
  const newMatch = trimmed.match(/new(?:_string|Text)?\s*[:=]\s*(.+)/i);
  if (oldMatch?.[1] && newMatch?.[1]) {
    const oldValue = oldMatch[1].trim().replace(/^['"`]|['"`]$/g, "");
    const newValue = newMatch[1].trim().replace(/^['"`]|['"`]$/g, "");
    if (oldValue && newValue) {
      return `- ${oldValue}\n+ ${newValue}`;
    }
  }

  return undefined;
}

function renderToolResultText(entry: ToolEntry): string | undefined {
  const base = entry.resultText?.trim();
  if (!base) {
    return undefined;
  }
  if (entry.name.trim().toLowerCase() !== "edit") {
    return base;
  }
  return parseEditDiffFromResult(base) ?? base;
}

function findLastPendingEntryIndex(entries: ToolEntry[], status?: RelayState["status"]): number {
  if (status !== "running") {
    return -1;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const resultText = entries[i]?.resultText?.trim();
    if (!resultText) {
      return i;
    }
  }
  return -1;
}

function formatToolSummaryLabel(toolName: string, count: number): string {
  switch (toolName) {
    case "read":
      return count === 1 ? "read" : "reads";
    case "edit":
      return count === 1 ? "edit" : "edits";
    case "write":
      return count === 1 ? "write" : "writes";
    case "exec":
      return count === 1 ? "exec" : "execs";
    case "web_search":
      return count === 1 ? "search" : "searches";
    case "web_fetch":
      return count === 1 ? "fetch" : "fetches";
    case "browser":
      return count === 1 ? "browser" : "browsers";
    case "message":
      return count === 1 ? "message" : "messages";
    case "memory_search":
      return count === 1 ? "memory search" : "memory searches";
    case "sessions_spawn":
      return count === 1 ? "spawn" : "spawns";
    case "other":
      return count === 1 ? "other" : "others";
    default:
      return count === 1 ? toolName : `${toolName}s`;
  }
}

function renderToolSummaryLine(entries: ToolEntry[], toolCount: number): string | undefined {
  if (toolCount < 3) {
    return undefined;
  }

  const counts = new Map<string, number>();
  let otherCount = 0;
  const knownNames = new Set<string>(RELAY_SUMMARY_ORDER);

  for (const entry of entries) {
    const normalized = entry.name.trim().toLowerCase();
    if (knownNames.has(normalized)) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    } else {
      otherCount += 1;
    }
  }

  const segments: string[] = [];
  for (const toolName of RELAY_SUMMARY_ORDER) {
    const count = counts.get(toolName) ?? 0;
    if (count <= 0) {
      continue;
    }
    const emoji = TOOL_EMOJI[toolName] ?? "🔨";
    const label = formatToolSummaryLabel(toolName, count);
    segments.push(`${emoji} ${count} ${label}`);
  }
  if (otherCount > 0) {
    segments.push(`🔨 ${otherCount} ${formatToolSummaryLabel("other", otherCount)}`);
  }

  return segments.length > 0 ? segments.join(" · ") : undefined;
}

function buildToolSpoilerTitle(entry: ToolEntry): string {
  const toolName = entry.name.replace(/\s+/g, " ").trim() || "tool";
  const duration = formatToolDuration(entry.startedAtMs, entry.completedAtMs);
  if (!duration) {
    return toolName;
  }
  return `${toolName} (${duration})`;
}

function extractToolLineStamp(line: string): string {
  const match = line.match(/^\[[^\]]+\]/);
  return match?.[0] ?? "[+0:00]";
}

function renderRelayMessageToolLines(state: RelayState): string[] {
  const toolCallLines: string[] = [];
  const pendingIndex = findLastPendingEntryIndex(state.toolEntries, state.status);

  for (let i = 0; i < state.toolEntries.length; i += 1) {
    const entry = state.toolEntries[i];
    if (!entry) {
      continue;
    }

    const toolName = entry.name.trim().toLowerCase();

    if (toolName === "read") {
      let end = i;
      while (
        end + 1 < state.toolEntries.length &&
        state.toolEntries[end + 1]?.name.trim().toLowerCase() === "read"
      ) {
        end += 1;
      }

      const runLength = end - i + 1;
      if (runLength >= 2) {
        const runEntries = state.toolEntries.slice(i, end + 1);
        const runPaths = runEntries.map((candidate) => extractReadPathFromLine(candidate.line));
        const allPathsPresent = runPaths.every((value) => Boolean(value));
        const uniquePathCount = new Set(runPaths.filter((value): value is string => Boolean(value)))
          .size;
        const isGroupable = allPathsPresent && uniquePathCount === runEntries.length;

        if (isGroupable) {
          const groupStamp = extractToolLineStamp(runEntries[0]?.line ?? "");
          const groupHasPending = runEntries.some((_, idx) => i + idx === pendingIndex);
          const groupLine = `${groupStamp} ${TOOL_EMOJI.read ?? "📄"} read (${runEntries.length} files)${groupHasPending ? " ⏳" : ""}`;
          toolCallLines.push(sanitizeForCodeFence(groupLine));

          const groupHasError = runEntries.some((candidate) => candidate.isError === true);
          const groupTitle = `${groupHasError ? "❌ " : ""}read (${runEntries.length} files)`;
          toolCallLines.push(`\`\`\`spoiler ${groupTitle}`);

          for (let groupIdx = 0; groupIdx < runEntries.length; groupIdx += 1) {
            const groupEntry = runEntries[groupIdx];
            const filePath = runPaths[groupIdx] ?? "(unknown path)";
            const resultText = renderToolResultText(groupEntry);
            toolCallLines.push(`**${sanitizeForCodeFence(filePath)}**`);
            if (resultText) {
              const truncated =
                resultText.length > RELAY_TOOL_RESULT_MAX_CHARS
                  ? `${truncateMarkdownSafe(resultText, RELAY_TOOL_RESULT_MAX_CHARS)}\n\n_(truncated)_`
                  : resultText;
              toolCallLines.push(sanitizeForCodeFence(truncated));
            } else if (state.status === "running" && i + groupIdx === pendingIndex) {
              toolCallLines.push("_(pending)_");
            } else {
              toolCallLines.push("_(no result)_");
            }
            if (groupIdx < runEntries.length - 1) {
              toolCallLines.push("");
            }
          }

          toolCallLines.push("```");
          i = end;
          continue;
        }
      }
    }

    const pendingSuffix = i === pendingIndex ? " ⏳" : "";
    toolCallLines.push(`${sanitizeForCodeFence(entry.line)}${pendingSuffix}`);

    const resultText = renderToolResultText(entry);
    if (resultText) {
      const truncated =
        resultText.length > RELAY_TOOL_RESULT_MAX_CHARS
          ? `${truncateMarkdownSafe(resultText, RELAY_TOOL_RESULT_MAX_CHARS)}\n\n_(truncated)_`
          : resultText;
      const safeResult = sanitizeForCodeFence(truncated);
      const spoilerTitle = buildToolSpoilerTitle(entry);
      toolCallLines.push(`\`\`\`spoiler ${spoilerTitle}`);
      toolCallLines.push(safeResult);
      toolCallLines.push("```");
    }
  }

  return toolCallLines;
}

export function renderRelayMessage(state: RelayState, originTopic?: string) {
  const callWord = state.toolCount === 1 ? "tool call" : "tool calls";
  const updatedTime = formatRelayUpdatedTime(state.lastUpdatedAt);
  const emoji = RELAY_STATUS_EMOJI[state.status ?? "running"] ?? "🔄";
  const watchdogEmoji = resolveWatchdogStatusEmoji(state.watchdogStatus);
  const modelShort = state.model.includes("/") ? state.model.split("/").pop() : state.model;
  const profileSuffix = state.authProfile ? ` (${state.authProfile})` : "";
  const sandboxSuffix = state.sandboxed ? " · 🔒 sandbox" : "";
  const originSuffix = originTopic ? ` · 📍 ${originTopic}` : "";
  const respawnSuffix = state.respawnedAs ? ` · ⚡ re-spawned as \`${state.respawnedAs}\`` : "";
  const header = `${emoji} **\`${state.label}\`**${sandboxSuffix} · ${modelShort}${profileSuffix} · ${state.toolCount} ${callWord} · updated ${updatedTime}${watchdogEmoji}${originSuffix}${respawnSuffix}`;
  const summaryLine = renderToolSummaryLine(state.toolEntries, state.toolCount);
  const toolCallLines = renderRelayMessageToolLines(state);

  const headerWithSummary = summaryLine ? `${header}\n${summaryLine}` : header;

  const sections = [
    `${headerWithSummary}\n\n\`\`\`spoiler Tool calls\n${toolCallLines.join("\n")}\n\`\`\``,
  ];

  // Append sub-agent completion output when available (populated at lifecycle end).
  const completionText = state.completionText?.trim();
  if (completionText) {
    const truncated =
      completionText.length > RELAY_COMPLETION_TEXT_MAX_CHARS
        ? `${truncateMarkdownSafe(completionText, RELAY_COMPLETION_TEXT_MAX_CHARS)}\n\n_(truncated)_`
        : completionText;
    const safeText = sanitizeForCodeFence(truncated);
    sections.push(`\`\`\`spoiler Output\n${safeText}\n\`\`\``);
  }

  return sections.join("\n\n");
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

/**
 * Validate that a mirrorTopic string is in the expected stream:X#Y format.
 * Returns false for empty strings or strings missing the '#' topic separator.
 */
function isValidMirrorTarget(mirrorTarget: string): boolean {
  return typeof mirrorTarget === "string" && mirrorTarget.includes("#");
}

/**
 * Send a new relay message to the mirror topic (best-effort: never throws).
 * On success, sets state.mirrorMessageId.
 */
async function sendMirrorRelayMessage(
  state: RelayState,
  mirrorTarget: string,
  message: string,
): Promise<void> {
  if (!isValidMirrorTarget(mirrorTarget)) {
    defaultRuntime.log?.(
      `[warn] subagent relay mirror: invalid mirrorTopic format "${mirrorTarget}" (expected stream:X#Y)`,
    );
    return;
  }
  try {
    const cfg = loadConfig();
    const result = await dispatchChannelMessageAction({
      channel: "zulip",
      action: "send",
      cfg,
      accountId: state.deliveryContext.accountId,
      params: {
        channel: "zulip",
        target: mirrorTarget,
        message,
        accountId: state.deliveryContext.accountId,
      },
      dryRun: false,
    });
    if (!result) {
      return;
    }
    const messageId = parseMessageId(result);
    if (messageId) {
      state.mirrorMessageId = messageId;
      // Persist so we can edit/clean up the mirror message after a restart
      const originTopic = extractOriginTopic(state.deliveryContext.to);
      upsertMirrorEntry(state.runId, {
        mirrorMessageId: messageId,
        label: state.label,
        originTopic,
        mirrorTopic: mirrorTarget,
      });
    }
  } catch (err) {
    defaultRuntime.log?.(
      `[warn] subagent relay mirror send failed for run ${state.runId}: ${String(err)}`,
    );
  }
}

/**
 * Edit the existing mirror relay message (best-effort: never throws).
 * Falls back to sending a new message if no mirrorMessageId exists or if edit fails.
 * Resets mirrorMessageId on failure to allow recovery on the next flush.
 */
async function editMirrorRelayMessage(
  state: RelayState,
  mirrorTarget: string,
  message: string,
): Promise<void> {
  if (!state.mirrorMessageId) {
    return sendMirrorRelayMessage(state, mirrorTarget, message);
  }
  try {
    const cfg = loadConfig();
    const result = await dispatchChannelMessageAction({
      channel: "zulip",
      action: "edit",
      cfg,
      accountId: state.deliveryContext.accountId,
      params: {
        channel: "zulip",
        messageId: state.mirrorMessageId,
        message,
        accountId: state.deliveryContext.accountId,
      },
      dryRun: false,
    });
    if (!result) {
      defaultRuntime.log?.(
        `[warn] subagent relay mirror edit returned no result for run ${state.runId}, will retry as send`,
      );
      // Reset so next flush attempts a fresh send instead of a failing edit
      state.mirrorMessageId = undefined;
      return sendMirrorRelayMessage(state, mirrorTarget, message);
    }
  } catch (err) {
    defaultRuntime.log?.(
      `[warn] subagent relay mirror edit failed for run ${state.runId}: ${String(err)}, will retry as send`,
    );
    // Reset so next flush attempts a fresh send instead of a failing edit
    state.mirrorMessageId = undefined;
    await sendMirrorRelayMessage(state, mirrorTarget, message);
  }
}

async function flushRelayMessage(runId: string, options?: { finalize?: boolean }) {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }
  state.lastUpdatedAt = Date.now();
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

  // Mirror relay: best-effort, never blocks primary
  const { mirrorTopic } = resolveRelayConfig();
  if (mirrorTopic) {
    const originTopic = extractOriginTopic(state.deliveryContext.to);
    const mirrorMessage = renderRelayMessage(state, originTopic);
    if (state.mirrorMessageId) {
      await editMirrorRelayMessage(state, mirrorTopic, mirrorMessage);
    } else {
      await sendMirrorRelayMessage(state, mirrorTopic, mirrorMessage);
    }
  }

  if (options?.finalize) {
    if (state.editTimer) {
      clearTimeout(state.editTimer);
      state.editTimer = undefined;
    }
    clearWatchdog(state);
    // Clean up the persisted mirror entry now that the run has completed cleanly
    removeMirrorEntry(runId);
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
  const startedAt =
    typeof registration.startedAt === "number" && Number.isFinite(registration.startedAt)
      ? registration.startedAt
      : Date.now();
  const state: RelayState = {
    runId,
    label: registration.label?.trim() || "worker",
    model: registration.model?.trim() || "default",
    sandboxed: registration.sandboxed === true,
    startedAt,
    toolEntries: [],
    pendingToolCallIds: new Map<string, number>(),
    deliveryContext,
    toolCount: 0,
    status: "running",
    lastUpdatedAt: startedAt,
  };

  // Restore mirrorMessageId from startup recovery if available
  const recoveredMirrorId = recoveredMirrorMessageIds.get(runId);
  if (recoveredMirrorId) {
    state.mirrorMessageId = recoveredMirrorId;
    recoveredMirrorMessageIds.delete(runId);
  }

  relayByRun.set(runId, state);
  return state;
}

// ---------------------------------------------------------------------------
// Watchdog: detect frozen sub-agents
// ---------------------------------------------------------------------------

/**
 * Compute the watchdog timeout for a given tool call based on smart exclusions.
 *
 * Long-running `exec` commands, `process` polling, and sub-agent spawning
 * all get extended timeouts instead of the default 5 minutes.
 */
export function computeWatchdogTimeoutMs(toolName: string, args: Record<string, unknown>): number {
  const normalizedName = toolName.trim().toLowerCase();

  // exec with explicit timeout > 5 minutes → extend to match
  if (normalizedName === "exec") {
    const timeout =
      typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 0;
    const timeoutMs = timeout * 1000;
    if (timeoutMs > WATCHDOG_DEFAULT_TIMEOUT_MS) {
      return timeoutMs + WATCHDOG_EXEC_BUFFER_MS;
    }
  }

  // process actions (polling background processes) → 10 min
  if (normalizedName === "process") {
    const pollTimeout =
      typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 0;
    if (pollTimeout > 0) {
      return Math.max(WATCHDOG_PROCESS_TIMEOUT_MS, pollTimeout + WATCHDOG_EXEC_BUFFER_MS);
    }
    return WATCHDOG_PROCESS_TIMEOUT_MS;
  }

  // sessions_spawn or subagents → waiting for child sub-agent
  if (normalizedName === "sessions_spawn" || normalizedName === "subagents") {
    return WATCHDOG_SPAWN_TIMEOUT_MS;
  }

  return WATCHDOG_DEFAULT_TIMEOUT_MS;
}

function clearWatchdog(state: RelayState): void {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = undefined;
  }
  if (state.watchdogFollowUpTimer) {
    clearTimeout(state.watchdogFollowUpTimer);
    state.watchdogFollowUpTimer = undefined;
  }
}

async function steerSubagent(runId: string, message: string): Promise<boolean> {
  try {
    const registration = registrationsByRun.get(runId);
    const childSessionKey = registration?.childSessionKey?.trim();
    if (!childSessionKey) {
      defaultRuntime.log?.(`[watchdog] Cannot steer run ${runId}: no child session key`);
      return false;
    }

    const idempotencyKey = `watchdog-${runId}-${Date.now()}`;
    await callGateway({
      method: "agent",
      params: {
        message,
        sessionKey: childSessionKey,
        idempotencyKey,
        deliver: false,
        channel: "internal",
        lane: "subagent",
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    return true;
  } catch (err) {
    defaultRuntime.log?.(
      `[watchdog] Failed to steer run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function checkSubagentAlive(runId: string): Promise<boolean> {
  try {
    const result = await callGateway<{ status?: string }>({
      method: "agent.wait",
      params: { runId, timeoutMs: 100 },
      timeoutMs: 5_000,
    });
    // If wait returns immediately with ok/error/timeout status, the agent has ended
    if (result?.status === "ok" || result?.status === "error" || result?.status === "timeout") {
      return false;
    }
    return true;
  } catch {
    // If the call fails, assume alive (don't false-positive)
    return true;
  }
}

async function sendWatchdogNotification(state: RelayState, message: string): Promise<void> {
  try {
    const cfg = loadConfig();
    await dispatchChannelMessageAction({
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
  } catch (err) {
    defaultRuntime.log?.(
      `[watchdog] Failed to send notification for run ${state.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Count the number of respawns in a label by counting `-respawned` suffixes.
 * e.g. "my-task" → 0, "my-task-respawned" → 1, "my-task-respawned-2" → 2
 */
export function countRespawnsInLabel(label: string): number {
  const respawnMatches = label.match(/-respawned(?:-(\d+))?$/);
  if (!respawnMatches) {
    return 0;
  }
  // "-respawned" = 1, "-respawned-2" = 2
  const suffix = respawnMatches[1];
  return suffix ? Number.parseInt(suffix, 10) : 1;
}

/**
 * Build the next respawned label from the current label.
 * "my-task" → "my-task-respawned", "my-task-respawned" → "my-task-respawned-2"
 */
export function buildRespawnedLabel(label: string): string {
  const count = countRespawnsInLabel(label);
  if (count === 0) {
    return `${label}-respawned`;
  }
  // Strip the current respawn suffix and add incremented one
  const base = label.replace(/-respawned(?:-\d+)?$/, "");
  return `${base}-respawned-${count + 1}`;
}

/**
 * Check whether watchdog respawn is enabled in config.
 * Default: true.
 */
function isWatchdogRespawnEnabled(): boolean {
  const cfg = loadConfig();
  const value = cfg.agents?.defaults?.subagents?.watchdogRespawn;
  if (typeof value === "boolean") {
    return value;
  }
  return true; // default enabled
}

/**
 * Attempt to re-spawn a dead sub-agent detected by the watchdog.
 * Returns the new label if respawned, or undefined if respawn was skipped/failed.
 */
async function attemptWatchdogRespawn(
  runId: string,
  state: RelayState,
): Promise<string | undefined> {
  // Import getter lazily to avoid circular dependency issues at module load time.
  // subagent-registry imports subagent-relay, so a top-level import would create a cycle.
  const { getSubagentRunRecord, markSubagentRunTerminated } =
    await import("./subagent-registry.js");

  if (!isWatchdogRespawnEnabled()) {
    defaultRuntime.log?.(
      `[watchdog] Respawn disabled by config for "${state.label}" (run ${runId})`,
    );
    return undefined;
  }

  const run = getSubagentRunRecord(runId);
  if (!run) {
    defaultRuntime.log?.(
      `[watchdog] No registry entry found for "${state.label}" (run ${runId}), cannot respawn`,
    );
    return undefined;
  }

  // Don't respawn if explicitly killed by user
  if (run.suppressAnnounceReason === "killed") {
    defaultRuntime.log?.(
      `[watchdog] Run "${state.label}" (run ${runId}) was explicitly killed, skipping respawn`,
    );
    return undefined;
  }

  // Check respawn count limit
  const currentLabel = run.label || state.label || "worker";
  const respawnCount = countRespawnsInLabel(currentLabel);
  if (respawnCount >= WATCHDOG_MAX_RESPAWN_COUNT) {
    defaultRuntime.log?.(
      `[watchdog] Run "${state.label}" (run ${runId}) has reached max respawn count (${respawnCount}/${WATCHDOG_MAX_RESPAWN_COUNT}), skipping`,
    );
    return undefined;
  }

  // Check if task is resumable
  if (!taskLooksResumable(run.task)) {
    defaultRuntime.log?.(
      `[watchdog] Task for "${state.label}" (run ${runId}) is too short to respawn`,
    );
    return undefined;
  }

  // Read session progress
  const { progressSummary } = await readSessionProgressSummary(run.childSessionKey);

  // Build resumption task
  const resumptionTask = buildResumptionTask(run, progressSummary);
  const newLabel = buildRespawnedLabel(currentLabel);

  // Mark old run as terminated
  markSubagentRunTerminated({
    runId: run.runId,
    reason: "died-watchdog",
  });

  try {
    const result = await spawnSubagentDirect(
      {
        task: resumptionTask,
        label: newLabel,
        model: run.model,
        cleanup: run.cleanup,
        runTimeoutSeconds: run.runTimeoutSeconds,
        expectsCompletionMessage: run.expectsCompletionMessage,
      },
      {
        agentChannel: run.requesterOrigin?.channel,
        agentAccountId: run.requesterOrigin?.accountId,
        agentTo: run.requesterOrigin?.to,
        agentThreadId: run.requesterOrigin?.threadId,
      },
    );

    if (result.status === "accepted") {
      defaultRuntime.log?.(
        `[watchdog] Re-spawned "${state.label}" as "${newLabel}" (new run: ${result.runId})`,
      );
      return newLabel;
    }

    defaultRuntime.log?.(
      `[watchdog] Failed to respawn "${state.label}": ${result.error || result.status}`,
    );
    return undefined;
  } catch (err) {
    defaultRuntime.log?.(
      `[watchdog] Error respawning "${state.label}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function onWatchdogFired(runId: string): Promise<void> {
  const state = relayByRun.get(runId);
  if (!state || state.status === "ok" || state.status === "error") {
    return;
  }

  defaultRuntime.log?.(
    `[watchdog] Idle timeout fired for sub-agent "${state.label}" (run ${runId})`,
  );

  // Check if the sub-agent is still alive
  const alive = await checkSubagentAlive(runId);

  if (!alive) {
    // Sub-agent is dead/timed out
    defaultRuntime.log?.(`[watchdog] Sub-agent "${state.label}" (run ${runId}) is dead`);

    // Attempt to re-spawn the dead sub-agent
    const newLabel = await attemptWatchdogRespawn(runId, state);

    if (newLabel) {
      // Re-spawned successfully — update relay message with respawn info
      state.watchdogStatus = "frozen";
      state.status = "error";
      state.respawnedAs = newLabel;
      void flushRelayMessage(runId, { finalize: true });
      await sendWatchdogNotification(
        state,
        `⚠️ **Watchdog**: Sub-agent \`${state.label}\` died and has been re-spawned as \`${newLabel}\`. Run: \`${runId}\``,
      );
      return;
    }

    // Respawn failed or was skipped — fall through to original notification behavior
    state.watchdogStatus = "frozen";
    state.status = "error";
    void flushRelayMessage(runId);
    await sendWatchdogNotification(
      state,
      `⚠️ **Watchdog**: Sub-agent \`${state.label}\` appears to have died (no tool calls for 5+ minutes, session not active). Run: \`${runId}\``,
    );
    return;
  }

  // Sub-agent is alive but idle → nudge it
  defaultRuntime.log?.(`[watchdog] Nudging idle sub-agent "${state.label}" (run ${runId})`);
  state.watchdogStatus = "nudged";
  state.watchdogNudgedAt = Date.now();
  void flushRelayMessage(runId);

  const steered = await steerSubagent(
    runId,
    "Watchdog: No tool calls in 5 minutes. Are you stuck? If waiting for something, describe what you're waiting for.",
  );

  if (!steered) {
    defaultRuntime.log?.(
      `[watchdog] Failed to steer sub-agent "${state.label}" (run ${runId}), notifying`,
    );
    state.watchdogStatus = "frozen";
    void flushRelayMessage(runId);
    await sendWatchdogNotification(
      state,
      `⚠️ **Watchdog**: Sub-agent \`${state.label}\` idle for 5+ minutes and could not be steered. Run: \`${runId}\``,
    );
    return;
  }

  // Set follow-up timer: if no activity within 2 more minutes, mark as frozen
  state.watchdogFollowUpTimer = setTimeout(() => {
    void onWatchdogFollowUpFired(runId);
  }, WATCHDOG_NUDGE_FOLLOWUP_MS);
  state.watchdogFollowUpTimer.unref?.();
}

async function onWatchdogFollowUpFired(runId: string): Promise<void> {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }

  // If there was activity since the nudge, the watchdog was already reset
  if (state.watchdogStatus !== "nudged") {
    return;
  }

  defaultRuntime.log?.(
    `[watchdog] Sub-agent "${state.label}" (run ${runId}) did not respond within 2 minutes of nudge`,
  );

  state.watchdogStatus = "frozen";
  void flushRelayMessage(runId);

  await sendWatchdogNotification(
    state,
    `🚨 **Watchdog**: Sub-agent \`${state.label}\` did not respond within 2 minutes after nudge. Likely frozen. Run: \`${runId}\``,
  );
}

function resetWatchdog(runId: string, toolName: string, args: Record<string, unknown>): void {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }

  // Clear any existing watchdog timers
  clearWatchdog(state);

  // Reset watchdog status if it was nudged/frozen (activity resumed)
  if (state.watchdogStatus === "nudged" || state.watchdogStatus === "frozen") {
    const wasNudgedOrFrozen = state.watchdogStatus;
    state.watchdogStatus = "active";
    if (wasNudgedOrFrozen) {
      defaultRuntime.log?.(`[watchdog] Sub-agent "${state.label}" (run ${runId}) resumed activity`);
    }
  } else {
    state.watchdogStatus = "active";
  }

  // Store last tool info for smart exclusion checks
  state.lastToolName = toolName;
  state.lastToolArgs = args;

  // Compute timeout and set new timer
  const timeoutMs = computeWatchdogTimeoutMs(toolName, args);
  state.watchdogTimer = setTimeout(() => {
    void onWatchdogFired(runId);
  }, timeoutMs);
  state.watchdogTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Tool and lifecycle event handlers
// ---------------------------------------------------------------------------

function handleAuthEvent(evt: AgentEventPayload) {
  if (!isRelayEnabled()) {
    return;
  }
  const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
  if (phase !== "resolved") {
    return;
  }
  const profileId = typeof evt.data?.profileId === "string" ? evt.data.profileId.trim() : "";
  if (!profileId) {
    return;
  }
  const state = getOrCreateRelayState(evt.runId);
  if (!state) {
    return;
  }
  state.authProfile = extractProfileShortName(profileId);
  // Flush to update the header with the profile name
  scheduleRelayFlush(evt.runId);
}

function handleToolEvent(evt: AgentEventPayload) {
  if (!isRelayEnabled()) {
    return;
  }
  const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
  if (phase !== "start" && phase !== "result") {
    return;
  }

  const state = getOrCreateRelayState(evt.runId);
  if (!state) {
    return;
  }

  if (phase === "start") {
    const toolName = typeof evt.data?.name === "string" ? evt.data.name : "tool";
    const args = evt.data?.args;
    const argsRecord = readRecord(args);
    const startedAt =
      typeof state.startedAt === "number" && Number.isFinite(state.startedAt)
        ? state.startedAt
        : Date.now();
    state.startedAt = startedAt;

    const line = formatToolLine(toolName, args, startedAt, evt.ts);
    const eventTs = typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : Date.now();
    const entry: ToolEntry = {
      line,
      name: toolName,
      startedAtMs: eventTs,
    };
    const entryIndex = state.toolEntries.push(entry) - 1;
    const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId.trim() : "";
    if (toolCallId) {
      state.pendingToolCallIds.set(toolCallId, entryIndex);
    }

    state.toolCount += 1;
    scheduleRelayFlush(evt.runId);

    // Reset watchdog timer on every tool call start
    resetWatchdog(evt.runId, toolName, argsRecord);
    return;
  }

  if (phase !== "result") {
    return;
  }

  const toolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId.trim() : "";
  if (!toolCallId) {
    return;
  }
  const entryIndex = state.pendingToolCallIds.get(toolCallId);
  if (entryIndex === undefined) {
    return;
  }
  const entry = state.toolEntries[entryIndex];
  if (!entry) {
    state.pendingToolCallIds.delete(toolCallId);
    return;
  }

  const resultText = extractToolResultText(evt.data?.result);
  if (resultText) {
    entry.resultText = resultText;
  }
  const eventTs = typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : Date.now();
  entry.completedAtMs = eventTs;
  entry.isError = evt.data?.isError === true;
  state.pendingToolCallIds.delete(toolCallId);
  scheduleRelayFlush(evt.runId);
}

/**
 * Best-effort extraction of readable text from a chat message payload.
 */
function extractRelayMessageText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = extractTextFromChatContent(content, {
    normalizeText: (t) => t.trim(),
    joinWith: "\n",
  });
  return text?.trim() ? text.trim() : undefined;
}

/**
 * Count tool calls from transcript messages.
 *
 * We de-duplicate by tool call ID when available because some transcripts can
 * include both tool and toolResult records for the same call.
 */
export function countToolCallsFromHistory(messages: Array<unknown>): number {
  let count = 0;
  const seenCallIds = new Set<string>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const msg = raw as {
      role?: unknown;
      toolCallId?: unknown;
      toolUseId?: unknown;
      id?: unknown;
    };
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role !== "toolResult" && role !== "tool") {
      continue;
    }

    const toolCallIdCandidates = [msg.toolCallId, msg.toolUseId, msg.id];
    const toolCallId = toolCallIdCandidates.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );

    if (toolCallId) {
      if (seenCallIds.has(toolCallId)) {
        continue;
      }
      seenCallIds.add(toolCallId);
    }

    count += 1;
  }

  return count;
}

/**
 * Read completion snapshot from a sub-agent's chat history.
 * Scans backwards for output text and counts tool calls from transcript data.
 * Best-effort: returns undefined fields on failure.
 */
async function readCompletionSnapshot(sessionKey: string): Promise<{
  text?: string;
  toolCount?: number;
}> {
  try {
    const history = await callGateway<{ messages?: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey, limit: 1000 },
      timeoutMs: 5_000,
    });
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const toolCount = countToolCallsFromHistory(messages);

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as { role?: string; content?: unknown } | undefined;
      if (!msg || typeof msg !== "object") {
        continue;
      }
      const role = msg.role;
      if (role !== "assistant" && role !== "toolResult" && role !== "tool") {
        continue;
      }
      const text = extractRelayMessageText(msg.content);
      if (text) {
        return { text, toolCount };
      }
    }

    return { toolCount };
  } catch {
    // Best-effort only
    return {};
  }
}

/**
 * Finalize the relay message with completion text from the sub-agent's output.
 * Reads the child session's history and includes the latest text in the relay
 * so users can see what the sub-agent produced.
 */
async function finalizeRelayWithOutput(runId: string): Promise<void> {
  const state = relayByRun.get(runId);
  if (!state) {
    return;
  }
  const registration = registrationsByRun.get(runId);
  if (registration?.childSessionKey) {
    const snapshot = await readCompletionSnapshot(registration.childSessionKey);
    if (snapshot.text) {
      state.completionText = snapshot.text;
    }
    if (typeof snapshot.toolCount === "number" && Number.isFinite(snapshot.toolCount)) {
      const recoveredCount = Math.max(0, Math.floor(snapshot.toolCount));
      if (recoveredCount > state.toolCount) {
        const missingCount = recoveredCount - state.toolCount;
        state.toolCount = recoveredCount;
        const callWord = missingCount === 1 ? "call" : "calls";
        state.toolEntries.push({
          line: `[recovered] ℹ️ ${missingCount} tool ${callWord} counted from transcript`,
          name: "recovered",
        });
      }
    }
  }
  await flushRelayMessage(runId, { finalize: true });
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
        state.lastUpdatedAt = evt.data.startedAt;
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
  // Clear watchdog — the run is finished
  clearWatchdog(state);
  state.watchdogStatus = undefined;

  const failed = phase === "error" || evt.data?.aborted === true;
  // Preserve "error" status if already set (e.g. by watchdog detecting a dead agent).
  // A lifecycle "end" event fired after watchdog detection should not overwrite the ❌.
  state.status = failed || state.status === "error" ? "error" : "ok";
  // Read the sub-agent's completion text before finalizing so the relay
  // message includes the actual output alongside tool call history.
  void finalizeRelayWithOutput(evt.runId);
}

export function initSubagentRelay() {
  if (listenerInitialized) {
    return;
  }
  listenerInitialized = true;

  // Recover stale mirror messages from before the last restart (best-effort)
  void recoverMirrorState();

  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream === "tool") {
      handleToolEvent(evt);
      return;
    }
    if (evt.stream === "auth") {
      handleAuthEvent(evt);
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
    childSessionKey: params.childSessionKey,
    sandboxed: params.sandboxed === true,
  });
}

export function unregisterSubagentRelayRun(runId: string) {
  const key = runId.trim();
  if (!key) {
    return;
  }
  const state = relayByRun.get(key);
  if (state) {
    if (state.editTimer) {
      clearTimeout(state.editTimer);
    }
    clearWatchdog(state);
  }
  relayByRun.delete(key);
  registrationsByRun.delete(key);
}

/**
 * Mark a relay run's message as re-spawned and flush the updated message.
 * Called after a dead sub-agent is re-spawned (by watchdog or restart recovery)
 * so the old relay message shows context about the continuation.
 */
export function markRelayRunRespawned(runId: string, newLabel: string): void {
  if (typeof runId !== "string" || !runId) {
    return;
  }
  const key = runId.trim();
  if (!key) {
    return;
  }
  const state = relayByRun.get(key);
  if (!state) {
    return;
  }
  state.respawnedAs = newLabel;
  state.status = "error";
  state.lastUpdatedAt = Date.now();
  void flushRelayMessage(key, { finalize: true });
}
