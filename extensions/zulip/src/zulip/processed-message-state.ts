import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../../src/config/paths.js";

export const ZULIP_PROCESSED_MESSAGE_STATE_VERSION = 1;

export type ZulipProcessedMessageState = {
  version: number;
  accountId: string;
  updatedAtMs: number;
  streamWatermarks: Record<string, number>;
};

export function resolveZulipProcessedMessageStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "runtime", "zulip", "processed");
}

function toStateFileName(accountId: string): string {
  const safeAccountId = accountId.trim().replace(/[^a-zA-Z0-9:_-]/g, "_") || "default";
  return `${safeAccountId}.json`;
}

function toStatePath(params: {
  accountId: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateDir = params.stateDir ?? resolveZulipProcessedMessageStateDir(params.env);
  return path.join(stateDir, toStateFileName(params.accountId));
}

function createEmptyState(params: {
  accountId: string;
  nowMs?: number;
}): ZulipProcessedMessageState {
  return {
    version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
    accountId: params.accountId,
    updatedAtMs: params.nowMs ?? Date.now(),
    streamWatermarks: {},
  };
}

function isValidMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseState(params: {
  accountId: string;
  raw: string;
}): ZulipProcessedMessageState | undefined {
  const parsed = JSON.parse(params.raw) as ZulipProcessedMessageState;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  if (parsed.version !== ZULIP_PROCESSED_MESSAGE_STATE_VERSION) {
    return undefined;
  }
  if (typeof parsed.accountId !== "string" || parsed.accountId !== params.accountId) {
    return undefined;
  }
  if (typeof parsed.updatedAtMs !== "number" || !Number.isFinite(parsed.updatedAtMs)) {
    return undefined;
  }
  if (!parsed.streamWatermarks || typeof parsed.streamWatermarks !== "object") {
    return undefined;
  }

  const streamWatermarks: Record<string, number> = {};
  for (const [stream, messageId] of Object.entries(parsed.streamWatermarks)) {
    if (!stream || !isValidMessageId(messageId)) {
      continue;
    }
    streamWatermarks[stream] = Math.floor(messageId);
  }

  return {
    version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
    accountId: params.accountId,
    updatedAtMs: parsed.updatedAtMs,
    streamWatermarks,
  };
}

async function quarantineCorruptStateFile(filePath: string): Promise<void> {
  const corruptPath = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, corruptPath).catch(() => undefined);
}

export async function loadZulipProcessedMessageState(params: {
  accountId: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ZulipProcessedMessageState> {
  const filePath = toStatePath(params);
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return createEmptyState({ accountId: params.accountId });
  }

  try {
    const parsed = parseState({ accountId: params.accountId, raw });
    if (!parsed) {
      await quarantineCorruptStateFile(filePath);
      return createEmptyState({ accountId: params.accountId });
    }
    return parsed;
  } catch {
    await quarantineCorruptStateFile(filePath);
    return createEmptyState({ accountId: params.accountId });
  }
}

export async function writeZulipProcessedMessageState(params: {
  state: ZulipProcessedMessageState;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const state = {
    ...params.state,
    version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
    updatedAtMs: params.state.updatedAtMs,
  };
  const filePath = toStatePath({
    accountId: state.accountId,
    stateDir: params.stateDir,
    env: params.env,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

export function isZulipMessageAlreadyProcessed(params: {
  state: ZulipProcessedMessageState;
  stream: string;
  messageId: number;
}): boolean {
  if (!params.stream || !isValidMessageId(params.messageId)) {
    return false;
  }
  const watermark = params.state.streamWatermarks[params.stream];
  if (!isValidMessageId(watermark)) {
    return false;
  }
  return Math.floor(params.messageId) <= Math.floor(watermark);
}

export function markZulipMessageProcessed(params: {
  state: ZulipProcessedMessageState;
  stream: string;
  messageId: number;
  nowMs?: number;
}): { state: ZulipProcessedMessageState; updated: boolean } {
  if (!params.stream || !isValidMessageId(params.messageId)) {
    return { state: params.state, updated: false };
  }

  const messageId = Math.floor(params.messageId);
  const current = params.state.streamWatermarks[params.stream];
  if (isValidMessageId(current) && current >= messageId) {
    return { state: params.state, updated: false };
  }

  return {
    updated: true,
    state: {
      ...params.state,
      updatedAtMs: params.nowMs ?? Date.now(),
      streamWatermarks: {
        ...params.state.streamWatermarks,
        [params.stream]: messageId,
      },
    },
  };
}
