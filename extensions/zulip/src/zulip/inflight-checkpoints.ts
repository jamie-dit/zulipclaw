import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../../src/config/paths.js";

export const ZULIP_INFLIGHT_CHECKPOINT_VERSION = 1;
export const ZULIP_INFLIGHT_MAX_AGE_MS = 30 * 60 * 1000;
export const ZULIP_INFLIGHT_MAX_RETRY_COUNT = 25;

export type ZulipInFlightCheckpoint = {
  version: number;
  checkpointId: string;
  accountId: string;
  stream: string;
  topic: string;
  messageId: number;
  senderId: string;
  senderName: string;
  senderEmail?: string;
  cleanedContent: string;
  body: string;
  sessionKey: string;
  from: string;
  to: string;
  wasMentioned: boolean;
  streamId?: number;
  timestampMs?: number;
  mediaUrls?: string[];
  mediaTypes?: string[];
  mediaPaths?: string[];
  createdAtMs: number;
  updatedAtMs: number;
  retryCount: number;
  lastRecoveryAttemptAtMs?: number;
  lastError?: string;
};

export function resolveZulipInFlightCheckpointDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "runtime", "zulip", "inflight");
}

export function buildZulipCheckpointId(params: { accountId: string; messageId: number }): string {
  return `${params.accountId}:${params.messageId}`;
}

function toCheckpointFileName(checkpointId: string): string {
  return `${checkpointId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.json`;
}

function toCheckpointPath(params: {
  checkpointDir?: string;
  checkpointId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const dir = params.checkpointDir ?? resolveZulipInFlightCheckpointDir(params.env);
  return path.join(dir, toCheckpointFileName(params.checkpointId));
}

export function isZulipCheckpointStale(params: {
  checkpoint: ZulipInFlightCheckpoint;
  nowMs?: number;
  maxAgeMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const maxAgeMs = params.maxAgeMs ?? ZULIP_INFLIGHT_MAX_AGE_MS;
  return nowMs - params.checkpoint.updatedAtMs > maxAgeMs;
}

export function prepareZulipCheckpointForRecovery(params: {
  checkpoint: ZulipInFlightCheckpoint;
  nowMs?: number;
  lastError?: string;
}): ZulipInFlightCheckpoint {
  const nowMs = params.nowMs ?? Date.now();
  return {
    ...params.checkpoint,
    retryCount: Math.min(
      ZULIP_INFLIGHT_MAX_RETRY_COUNT,
      Math.max(0, params.checkpoint.retryCount) + 1,
    ),
    lastRecoveryAttemptAtMs: nowMs,
    updatedAtMs: nowMs,
    lastError: params.lastError ?? params.checkpoint.lastError,
  };
}

export function markZulipCheckpointFailure(params: {
  checkpoint: ZulipInFlightCheckpoint;
  error: unknown;
  nowMs?: number;
}): ZulipInFlightCheckpoint {
  const nowMs = params.nowMs ?? Date.now();
  return {
    ...params.checkpoint,
    updatedAtMs: nowMs,
    lastError: String(params.error),
  };
}

export async function writeZulipInFlightCheckpoint(params: {
  checkpoint: ZulipInFlightCheckpoint;
  checkpointDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = toCheckpointPath({
    checkpointDir: params.checkpointDir,
    checkpointId: params.checkpoint.checkpointId,
    env: params.env,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(params.checkpoint, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export async function clearZulipInFlightCheckpoint(params: {
  checkpointId: string;
  checkpointDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = toCheckpointPath({
    checkpointDir: params.checkpointDir,
    checkpointId: params.checkpointId,
    env: params.env,
  });
  await fs.rm(filePath, { force: true });
}

export async function loadZulipInFlightCheckpoints(params?: {
  accountId?: string;
  checkpointDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ZulipInFlightCheckpoint[]> {
  const checkpointDir = params?.checkpointDir ?? resolveZulipInFlightCheckpointDir(params?.env);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(checkpointDir);
  } catch {
    return [];
  }

  const checkpoints: ZulipInFlightCheckpoint[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(checkpointDir, entry), "utf8");
      const parsed = JSON.parse(raw) as ZulipInFlightCheckpoint;
      if (
        !parsed ||
        parsed.version !== ZULIP_INFLIGHT_CHECKPOINT_VERSION ||
        typeof parsed.checkpointId !== "string" ||
        typeof parsed.accountId !== "string" ||
        typeof parsed.messageId !== "number" ||
        !Number.isFinite(parsed.messageId) ||
        typeof parsed.stream !== "string" ||
        typeof parsed.topic !== "string" ||
        typeof parsed.cleanedContent !== "string" ||
        typeof parsed.body !== "string" ||
        typeof parsed.sessionKey !== "string" ||
        typeof parsed.from !== "string" ||
        typeof parsed.to !== "string" ||
        typeof parsed.createdAtMs !== "number" ||
        !Number.isFinite(parsed.createdAtMs) ||
        typeof parsed.updatedAtMs !== "number" ||
        !Number.isFinite(parsed.updatedAtMs) ||
        typeof parsed.retryCount !== "number" ||
        !Number.isFinite(parsed.retryCount)
      ) {
        continue;
      }
      if (params?.accountId && parsed.accountId !== params.accountId) {
        continue;
      }
      checkpoints.push(parsed);
    } catch {
      // Ignore malformed checkpoint files and continue.
    }
  }

  checkpoints.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
  return checkpoints;
}
