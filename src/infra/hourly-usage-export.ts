import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
} from "../gateway/session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";

const HOUR_MS = 60 * 60 * 1000;

export type UsageProvenance = "reported" | "reported_zero" | "missing_usage";

export type UsageRecord = {
  timestampMs: number;
  sessionKey: string;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  provenance: UsageProvenance;
};

export type UsageDiagnostics = {
  reportedRecords: number;
  reportedZeroRecords: number;
  missingUsageRecords: number;
};

export type HourlyUsageCsvRow = {
  timestamp_hour: string;
  session_key: string;
  model: string;
  model_provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd?: number;
};

type SessionMapEntry = {
  key: string;
  model?: string;
  provider?: string;
};

type SessionLookup = {
  byAgentAndSessionId: Map<string, SessionMapEntry>;
  byAgentAndFileBase: Map<string, SessionMapEntry>;
};

export type ResolvedHourSelection = {
  mode: "single" | "range" | "all-hours";
  fromHour: Date;
  toHour: Date;
  hours: Date[];
};

export function formatHourStartIso(date: Date): string {
  const normalized = new Date(date);
  normalized.setUTCMinutes(0, 0, 0);
  return normalized.toISOString().slice(0, 19) + "Z";
}

export function derivePreviousHourStart(now: Date = new Date()): Date {
  const ms = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - HOUR_MS;
  return new Date(ms);
}

export function parseHourStart(value: string | undefined, now: Date = new Date()): Date {
  if (!value || !value.trim()) {
    return derivePreviousHourStart(now);
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid --hour value: ${value}`);
  }
  parsed.setUTCMinutes(0, 0, 0);
  return parsed;
}

export function iterateHourStartsInclusive(fromHour: Date, toHour: Date): Date[] {
  const fromMs = parseHourStart(fromHour.toISOString()).getTime();
  const toMs = parseHourStart(toHour.toISOString()).getTime();
  if (toMs < fromMs) {
    throw new Error("Invalid hour range: --to must be the same as or after --from.");
  }

  const hours: Date[] = [];
  for (let ts = fromMs; ts <= toMs; ts += HOUR_MS) {
    hours.push(new Date(ts));
  }
  return hours;
}

export function enforceMaxHoursPerRun(params: {
  hours: number;
  maxHours: number;
  force?: boolean;
}): void {
  const hours = Math.max(0, Math.trunc(params.hours));
  const maxHours = Math.trunc(params.maxHours);
  if (!Number.isFinite(maxHours) || maxHours <= 0) {
    throw new Error(`Invalid max-hours value: ${params.maxHours}`);
  }

  if (!params.force && hours > maxHours) {
    throw new Error(
      `Refusing to process ${hours} hours (max ${maxHours}). Use --force or lower the range.`,
    );
  }
}

export function resolveHourSelection(params: {
  hourStartIso?: string;
  fromIso?: string;
  toIso?: string;
  allHours?: boolean;
  discoveredFromHour?: Date;
  now?: Date;
}): ResolvedHourSelection {
  const now = params.now ?? new Date();
  const hourStartIso = params.hourStartIso?.trim();
  const fromIso = params.fromIso?.trim();
  const toIso = params.toIso?.trim();

  if (params.allHours) {
    if (hourStartIso || fromIso || toIso) {
      throw new Error("--all-hours cannot be combined with --hour, --from, or --to.");
    }
    if (!params.discoveredFromHour) {
      throw new Error("--all-hours could not discover transcript history to backfill.");
    }

    const fromHour = parseHourStart(params.discoveredFromHour.toISOString(), now);
    const toHour = derivePreviousHourStart(now);
    const hours = iterateHourStartsInclusive(fromHour, toHour);
    return {
      mode: "all-hours",
      fromHour,
      toHour,
      hours,
    };
  }

  if (hourStartIso && (fromIso || toIso)) {
    throw new Error("--hour cannot be combined with --from/--to.");
  }

  if (fromIso || toIso) {
    if (!fromIso || !toIso) {
      throw new Error("--from and --to must be provided together.");
    }
    const fromHour = parseHourStart(fromIso, now);
    const toHour = parseHourStart(toIso, now);
    const hours = iterateHourStartsInclusive(fromHour, toHour);
    return {
      mode: "range",
      fromHour,
      toHour,
      hours,
    };
  }

  const singleHour = parseHourStart(hourStartIso, now);
  return {
    mode: "single",
    fromHour: singleHour,
    toHour: singleHour,
    hours: [singleHour],
  };
}

async function discoverTranscriptTimestampBounds(filePath: string): Promise<{
  earliestMs: number;
  latestMs: number;
} | null> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let earliestMs: number | undefined;
  let latestMs: number | undefined;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const timestampMs = parseTimestampMs(parsed as Record<string, unknown>);
      if (!Number.isFinite(timestampMs)) {
        continue;
      }

      earliestMs = earliestMs === undefined ? timestampMs : Math.min(earliestMs, timestampMs);
      latestMs = latestMs === undefined ? timestampMs : Math.max(latestMs, timestampMs);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (earliestMs === undefined || latestMs === undefined) {
    return null;
  }

  return { earliestMs, latestMs };
}

export async function discoverTranscriptHourBounds(params?: {
  config?: OpenClawConfig;
}): Promise<{ earliestHour: Date; latestHour: Date } | undefined> {
  const config = params?.config ?? loadConfig();
  const agents = listAgentsForGateway(config).agents;

  let earliestMs: number | undefined;
  let latestMs: number | undefined;

  for (const agent of agents) {
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agent.id);
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(sessionsDir, entry.name);
      const bounds = await discoverTranscriptTimestampBounds(filePath);
      if (bounds) {
        earliestMs =
          earliestMs === undefined ? bounds.earliestMs : Math.min(earliestMs, bounds.earliestMs);
        latestMs = latestMs === undefined ? bounds.latestMs : Math.max(latestMs, bounds.latestMs);
        continue;
      }

      const stats = await fs.promises.stat(filePath).catch(() => null);
      const mtimeMs = stats?.mtimeMs;
      if (!Number.isFinite(mtimeMs)) {
        continue;
      }
      earliestMs = earliestMs === undefined ? mtimeMs : Math.min(earliestMs, mtimeMs);
      latestMs = latestMs === undefined ? mtimeMs : Math.max(latestMs, mtimeMs);
    }
  }

  if (earliestMs === undefined || latestMs === undefined) {
    return undefined;
  }

  return {
    earliestHour: parseHourStart(new Date(earliestMs).toISOString()),
    latestHour: parseHourStart(new Date(latestMs).toISOString()),
  };
}

function resolveModelIdentity(
  provider: string | undefined,
  model: string | undefined,
): {
  model: string;
  modelProvider: string;
} {
  const normalizedModel = model?.trim() || "unknown";
  const providerFromModel = normalizedModel.includes("/")
    ? normalizedModel.slice(0, normalizedModel.indexOf("/")).trim() || undefined
    : undefined;
  const normalizedProvider = provider?.trim() || providerFromModel || "unknown";

  if (normalizedModel.includes("/")) {
    return {
      model: normalizedModel,
      modelProvider: normalizedProvider,
    };
  }

  return {
    model: `${normalizedProvider}/${normalizedModel}`,
    modelProvider: normalizedProvider,
  };
}

function parseTimestampMs(entry: Record<string, unknown>): number | undefined {
  const entryTs = entry.timestamp;
  if (typeof entryTs === "string") {
    const parsed = Date.parse(entryTs);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const message = entry.message;
  if (message && typeof message === "object") {
    const messageTs = (message as Record<string, unknown>).timestamp;
    if (typeof messageTs === "number" && Number.isFinite(messageTs)) {
      return messageTs;
    }
  }
  return undefined;
}

function parseCostTotal(
  usageRaw: UsageLike | Record<string, unknown> | undefined,
): number | undefined {
  if (!usageRaw || typeof usageRaw !== "object") {
    return undefined;
  }

  const usageRecord = usageRaw as Record<string, unknown>;
  const direct = usageRecord.costUsd ?? usageRecord.cost_usd;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
    return direct;
  }

  const cost = usageRecord.cost;
  if (!cost || typeof cost !== "object") {
    return undefined;
  }

  const total = (cost as Record<string, unknown>).total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }

  return total;
}

function normalizeAgentKey(agentId: string, sessionId: string): string {
  return `${agentId}::${sessionId}`;
}

function deriveSessionIdFromFile(fileBase: string): string {
  const stem = fileBase.replace(/\.jsonl$/i, "");
  const topicSuffix = stem.indexOf("-topic-");
  return topicSuffix === -1 ? stem : stem.slice(0, topicSuffix);
}

function buildSessionLookup(config: OpenClawConfig): SessionLookup {
  const { store } = loadCombinedSessionStoreForGateway(config);
  const byAgentAndSessionId = new Map<string, SessionMapEntry>();
  const byAgentAndFileBase = new Map<string, SessionMapEntry>();
  const defaultAgentId = resolveDefaultAgentId(config);

  for (const [key, entry] of Object.entries(store)) {
    const parsed = parseAgentSessionKey(key);
    const agentId = parsed?.agentId ?? defaultAgentId;
    const mapEntry: SessionMapEntry = {
      key,
      model: entry.model?.trim() || entry.modelOverride?.trim() || undefined,
      provider: entry.modelProvider?.trim() || entry.providerOverride?.trim() || undefined,
    };

    if (entry.sessionId?.trim()) {
      byAgentAndSessionId.set(normalizeAgentKey(agentId, entry.sessionId.trim()), mapEntry);
    }

    if (entry.sessionFile?.trim()) {
      byAgentAndFileBase.set(
        normalizeAgentKey(agentId, path.basename(entry.sessionFile.trim())),
        mapEntry,
      );
    }
  }

  return { byAgentAndSessionId, byAgentAndFileBase };
}

function buildRecordKey(
  timestampMs: number,
  sessionKey: string,
  modelProvider: string,
  model: string,
): string {
  const hourMs = Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
  return `${hourMs}|${sessionKey}|${modelProvider}|${model}`;
}

export function summarizeUsageDiagnostics(records: UsageRecord[]): UsageDiagnostics {
  return records.reduce<UsageDiagnostics>(
    (summary, record) => {
      if (record.provenance === "reported") {
        summary.reportedRecords += 1;
      } else if (record.provenance === "reported_zero") {
        summary.reportedZeroRecords += 1;
      } else {
        summary.missingUsageRecords += 1;
      }
      return summary;
    },
    {
      reportedRecords: 0,
      reportedZeroRecords: 0,
      missingUsageRecords: 0,
    },
  );
}

export function aggregateUsageRecords(records: UsageRecord[]): HourlyUsageCsvRow[] {
  const grouped = new Map<
    string,
    {
      hourMs: number;
      sessionKey: string;
      model: string;
      modelProvider: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      costTotal: number;
      missingCost: boolean;
    }
  >();

  for (const record of records) {
    const key = buildRecordKey(
      record.timestampMs,
      record.sessionKey,
      record.modelProvider,
      record.model,
    );
    const hourMs = Math.floor(record.timestampMs / HOUR_MS) * HOUR_MS;
    const bucket = grouped.get(key) ?? {
      hourMs,
      sessionKey: record.sessionKey,
      model: record.model,
      modelProvider: record.modelProvider,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costTotal: 0,
      missingCost: false,
    };

    bucket.inputTokens += record.inputTokens;
    bucket.outputTokens += record.outputTokens;
    bucket.totalTokens += record.totalTokens;

    if (typeof record.costUsd === "number" && Number.isFinite(record.costUsd)) {
      bucket.costTotal += record.costUsd;
    } else {
      bucket.missingCost = true;
    }

    grouped.set(key, bucket);
  }

  return Array.from(grouped.values())
    .map((bucket) => ({
      timestamp_hour: formatHourStartIso(new Date(bucket.hourMs)),
      session_key: bucket.sessionKey,
      model: bucket.model,
      model_provider: bucket.modelProvider,
      input_tokens: bucket.inputTokens,
      output_tokens: bucket.outputTokens,
      total_tokens: bucket.totalTokens,
      cost_usd: bucket.missingCost ? undefined : bucket.costTotal,
    }))
    .toSorted((a, b) => {
      const hourCmp = a.timestamp_hour.localeCompare(b.timestamp_hour);
      if (hourCmp !== 0) {
        return hourCmp;
      }
      const sessionCmp = a.session_key.localeCompare(b.session_key);
      if (sessionCmp !== 0) {
        return sessionCmp;
      }
      const providerCmp = a.model_provider.localeCompare(b.model_provider);
      if (providerCmp !== 0) {
        return providerCmp;
      }
      return a.model.localeCompare(b.model);
    });
}

function escapeCsvCell(value: string | number | undefined): string {
  if (value === undefined) {
    return "";
  }
  const str = typeof value === "number" ? String(value) : value;
  if (!/[",\n]/.test(str)) {
    return str;
  }
  return `"${str.replaceAll('"', '""')}"`;
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) {
    return "";
  }
  const rounded = Number(cost.toFixed(8));
  if (!Number.isFinite(rounded)) {
    return "";
  }
  return rounded.toString();
}

export function buildHourlyUsageCsv(rows: HourlyUsageCsvRow[]): string {
  const header = [
    "timestamp_hour",
    "session_key",
    "model_provider",
    "model",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_usd",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvCell(row.timestamp_hour),
        escapeCsvCell(row.session_key),
        escapeCsvCell(row.model_provider),
        escapeCsvCell(row.model),
        escapeCsvCell(row.input_tokens),
        escapeCsvCell(row.output_tokens),
        escapeCsvCell(row.total_tokens),
        escapeCsvCell(formatCost(row.cost_usd)),
      ].join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function collectUsageRecordsFromTranscriptFile(params: {
  filePath: string;
  sessionKey: string;
  defaultModel?: string;
  defaultProvider?: string;
  hourStartMs: number;
  hourEndMsExclusive: number;
  config: OpenClawConfig;
}): Promise<UsageRecord[]> {
  if (!fs.existsSync(params.filePath)) {
    return [];
  }

  const stream = fs.createReadStream(params.filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const records: UsageRecord[] = [];

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!parsedLine || typeof parsedLine !== "object") {
        continue;
      }

      const entry = parsedLine as Record<string, unknown>;
      const message = entry.message;
      if (!message || typeof message !== "object") {
        continue;
      }

      const timestampMs = parseTimestampMs(entry);
      if (timestampMs === undefined) {
        continue;
      }
      if (timestampMs < params.hourStartMs || timestampMs >= params.hourEndMsExclusive) {
        continue;
      }

      const messageRecord = message as Record<string, unknown>;
      const role = typeof messageRecord.role === "string" ? messageRecord.role : undefined;
      if (role !== "assistant") {
        continue;
      }

      const usageRaw =
        (messageRecord.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
      const usage = normalizeUsage(usageRaw);

      const rawProvider =
        (typeof messageRecord.provider === "string" ? messageRecord.provider : undefined) ??
        (typeof entry.provider === "string" ? entry.provider : undefined) ??
        params.defaultProvider;
      const rawModel =
        (typeof messageRecord.model === "string" ? messageRecord.model : undefined) ??
        (typeof entry.model === "string" ? entry.model : undefined) ??
        params.defaultModel;
      const identity = resolveModelIdentity(rawProvider, rawModel);

      let input = 0;
      let output = 0;
      let total = 0;
      let costUsd: number | undefined;
      let provenance: UsageProvenance = "missing_usage";

      if (usage) {
        input = usage.input ?? 0;
        output = usage.output ?? 0;
        const computedTotal =
          usage.total ?? input + output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        total = computedTotal > 0 ? computedTotal : 0;
        provenance = total > 0 ? "reported" : "reported_zero";

        costUsd = parseCostTotal(usageRaw);
        if (costUsd === undefined) {
          const costConfig = resolveModelCostConfig({
            provider: rawProvider,
            model: rawModel,
            config: params.config,
          });
          costUsd = estimateUsageCost({ usage, cost: costConfig });
        }
      }

      records.push({
        timestampMs,
        sessionKey: params.sessionKey,
        model: identity.model,
        modelProvider: identity.modelProvider,
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        costUsd,
        provenance,
      });
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return records;
}

export async function collectUsageRecordsForHour(params: {
  hourStart: Date;
  config?: OpenClawConfig;
}): Promise<UsageRecord[]> {
  const config = params.config ?? loadConfig();
  const lookup = buildSessionLookup(config);
  const hourStartMs = params.hourStart.getTime();
  const hourEndMsExclusive = hourStartMs + HOUR_MS;
  const agents = listAgentsForGateway(config).agents;
  const records: UsageRecord[] = [];

  for (const agent of agents) {
    const sessionsDir = resolveSessionTranscriptsDirForAgent(agent.id);
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(sessionsDir, entry.name);
      const stats = await fs.promises.stat(filePath).catch(() => null);
      if (!stats || stats.mtimeMs < hourStartMs) {
        continue;
      }

      const fileLookupKey = normalizeAgentKey(agent.id, entry.name);
      const sessionId = deriveSessionIdFromFile(entry.name);
      const sessionLookupKey = normalizeAgentKey(agent.id, sessionId);
      const mapped =
        lookup.byAgentAndFileBase.get(fileLookupKey) ??
        lookup.byAgentAndSessionId.get(sessionLookupKey);

      const sessionKey = mapped?.key ?? `agent:${agent.id}:${sessionId}`;
      const fileRecords = await collectUsageRecordsFromTranscriptFile({
        filePath,
        sessionKey,
        defaultModel: mapped?.model,
        defaultProvider: mapped?.provider,
        hourStartMs,
        hourEndMsExclusive,
        config,
      });
      records.push(...fileRecords);
    }
  }

  return records;
}

export async function exportHourlyUsageCsv(params?: {
  hourStart?: Date;
  hourStartIso?: string;
  now?: Date;
  config?: OpenClawConfig;
}): Promise<{
  hourStart: Date;
  hourStartIso: string;
  rows: HourlyUsageCsvRow[];
  csv: string;
  diagnostics: UsageDiagnostics;
}> {
  const hourStart =
    params?.hourStart ?? parseHourStart(params?.hourStartIso, params?.now ?? new Date());
  const records = await collectUsageRecordsForHour({ hourStart, config: params?.config });
  const rows = aggregateUsageRecords(records);
  const csv = buildHourlyUsageCsv(rows);
  const diagnostics = summarizeUsageDiagnostics(records);

  return {
    hourStart,
    hourStartIso: formatHourStartIso(hourStart),
    rows,
    csv,
    diagnostics,
  };
}

export type HelixUploadResult = {
  ok: true;
  importedRows: number;
  status: number;
};

export function resolveHelixIngestUrl(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.HELIX_USAGE_INGEST_URL?.trim();
  if (direct) {
    return direct;
  }

  const base =
    env.HELIX_USAGE_BASE_URL?.trim() || env.HELIX_BASE_URL?.trim() || env.HELIX_URL?.trim();
  if (!base) {
    throw new Error(
      "Missing Helix URL. Set HELIX_USAGE_INGEST_URL or HELIX_USAGE_BASE_URL/HELIX_BASE_URL.",
    );
  }

  return `${base.replace(/\/+$/, "")}/api/usage/zulipclaw/hourly`;
}

export async function uploadHourlyUsageCsv(params: {
  hourStartIso: string;
  csv: string;
  ingestUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<HelixUploadResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const ingestUrl = params.ingestUrl ?? resolveHelixIngestUrl();
  const token = params.token ?? process.env.HELIX_USAGE_INGEST_TOKEN?.trim();

  if (!token) {
    throw new Error("Missing HELIX_USAGE_INGEST_TOKEN.");
  }

  const response = await fetchImpl(ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, // Keep for backward compatibility
      "x-zulipclaw-ingest-key": token, // NEW: Helix managed key support
      "Content-Type": "text/csv; charset=utf-8",
      "X-Usage-Hour": params.hourStartIso,
    },
    body: params.csv,
  });

  let json: unknown = undefined;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    throw new Error(
      `Helix upload failed (${response.status}): ${typeof json === "object" ? JSON.stringify(json) : response.statusText}`,
    );
  }

  const body = json as { ok?: boolean; importedRows?: unknown } | undefined;
  if (!body?.ok) {
    throw new Error(`Unexpected Helix response: ${JSON.stringify(json)}`);
  }

  const importedRows =
    typeof body.importedRows === "number" && Number.isFinite(body.importedRows)
      ? body.importedRows
      : 0;

  return {
    ok: true,
    importedRows,
    status: response.status,
  };
}

export const __test = {
  parseTimestampMs,
  parseCostTotal,
  buildSessionLookup,
  deriveSessionIdFromFile,
  resolveModelIdentity,
};
