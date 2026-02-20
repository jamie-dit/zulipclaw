import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ZulipAccountConfig, ZulipReactionConfig } from "../types.js";
import { normalizeEmojiName, normalizeStreamName, normalizeTopic } from "./normalize.js";

export type ZulipTokenSource = "env" | "config" | "none";
export type ZulipBaseUrlSource = "env" | "config" | "none";
export type ZulipEmailSource = "env" | "config" | "none";

export type ZulipReactionWorkflowStage =
  | "queued"
  | "processing"
  | "toolRunning"
  | "retrying"
  | "success"
  | "partialSuccess"
  | "failure";

export type ResolvedZulipReactionWorkflow = {
  enabled: boolean;
  replaceStageReaction: boolean;
  minTransitionMs: number;
  stages: {
    queued?: string;
    processing?: string;
    toolRunning?: string;
    retrying?: string;
    success: string;
    partialSuccess?: string;
    failure: string;
  };
};

export type ResolvedZulipGenericReactionCallback = {
  enabled: boolean;
  includeRemoveOps: boolean;
};

export type ResolvedZulipReactions = {
  enabled: boolean;
  onStart: string;
  onSuccess: string;
  onFailure: string;
  clearOnFinish: boolean;
  workflow: ResolvedZulipReactionWorkflow;
  genericCallback: ResolvedZulipGenericReactionCallback;
};

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl?: string;
  email?: string;
  apiKey?: string;
  baseUrlSource: ZulipBaseUrlSource;
  emailSource: ZulipEmailSource;
  apiKeySource: ZulipTokenSource;
  streams: string[];
  alwaysReply: boolean;
  defaultTopic: string;
  reactions: ResolvedZulipReactions;
  textChunkLimit: number;
  config: ZulipAccountConfig;
};

const DEFAULT_TOPIC = "general chat";
const DEFAULT_TEXT_CHUNK_LIMIT = 10_000;
const DEFAULT_ALWAYS_REPLY = true;

const DEFAULT_REACTIONS: ResolvedZulipReactions = {
  enabled: true,
  onStart: "eyes",
  onSuccess: "check",
  onFailure: "warning",
  clearOnFinish: true,
  workflow: {
    enabled: true,
    replaceStageReaction: true,
    minTransitionMs: 1500,
    stages: {
      queued: "eyes",
      processing: "eyes",
      success: "check",
      partialSuccess: "warning",
      failure: "warning",
    },
  },
  genericCallback: {
    enabled: false,
    includeRemoveOps: false,
  },
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.zulip?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = cfg.channels?.zulip?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function mergeZulipAccountConfig(cfg: OpenClawConfig, accountId: string): ZulipAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.zulip ?? {}) as ZulipAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function normalizeStreamAllowlist(streams?: string[]): string[] {
  const normalized = (streams ?? []).map((entry) => normalizeStreamName(entry)).filter(Boolean);
  return Array.from(new Set(normalized));
}

function resolveWorkflowMinTransitionMs(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_REACTIONS.workflow.minTransitionMs;
  }
  return Math.floor(raw);
}

function resolveReactions(config: ZulipReactionConfig | undefined): ResolvedZulipReactions {
  if (!config) {
    return DEFAULT_REACTIONS;
  }
  const enabled = config.enabled !== false;
  const onStart = normalizeEmojiName(config.onStart) || DEFAULT_REACTIONS.onStart;
  const onSuccess = normalizeEmojiName(config.onSuccess) || DEFAULT_REACTIONS.onSuccess;
  const onFailure = normalizeEmojiName(config.onFailure) || DEFAULT_REACTIONS.onFailure;
  const clearOnFinish = config.clearOnFinish !== false;

  const workflowStages = config.workflow?.stages;
  const workflow = {
    enabled: config.workflow?.enabled === true,
    replaceStageReaction: config.workflow?.replaceStageReaction !== false,
    minTransitionMs: resolveWorkflowMinTransitionMs(config.workflow?.minTransitionMs),
    stages: {
      queued: normalizeEmojiName(workflowStages?.queued) || onStart,
      processing: normalizeEmojiName(workflowStages?.processing) || onStart,
      toolRunning: normalizeEmojiName(workflowStages?.toolRunning) || undefined,
      retrying: normalizeEmojiName(workflowStages?.retrying) || undefined,
      success: normalizeEmojiName(workflowStages?.success) || onSuccess,
      partialSuccess: normalizeEmojiName(workflowStages?.partialSuccess) || onFailure,
      failure: normalizeEmojiName(workflowStages?.failure) || onFailure,
    },
  } satisfies ResolvedZulipReactionWorkflow;

  const genericCallback = {
    enabled: config.genericCallback?.enabled === true,
    includeRemoveOps: config.genericCallback?.includeRemoveOps === true,
  } satisfies ResolvedZulipGenericReactionCallback;

  return { enabled, onStart, onSuccess, onFailure, clearOnFinish, workflow, genericCallback };
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zulip?.enabled !== false;
  const merged = mergeZulipAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envUrl = allowEnv ? process.env.ZULIP_URL?.trim() : undefined;
  const envEmail = allowEnv ? process.env.ZULIP_EMAIL?.trim() : undefined;
  const envKey = allowEnv ? process.env.ZULIP_API_KEY?.trim() : undefined;

  const configUrl = merged.baseUrl?.trim();
  const configEmail = merged.email?.trim();
  const configKey = merged.apiKey?.trim();

  const baseUrl = (configUrl || envUrl)?.replace(/\/+$/, "") || undefined;
  const email = configEmail || envEmail || undefined;
  const apiKey = configKey || envKey || undefined;

  const baseUrlSource: ZulipBaseUrlSource = configUrl ? "config" : envUrl ? "env" : "none";
  const emailSource: ZulipEmailSource = configEmail ? "config" : envEmail ? "env" : "none";
  const apiKeySource: ZulipTokenSource = configKey ? "config" : envKey ? "env" : "none";

  const streams = normalizeStreamAllowlist(merged.streams);
  const alwaysReply = merged.alwaysReply !== false && DEFAULT_ALWAYS_REPLY;
  const defaultTopic = normalizeTopic(merged.defaultTopic) || DEFAULT_TOPIC;
  const reactions = resolveReactions(merged.reactions);
  const textChunkLimit =
    typeof merged.textChunkLimit === "number" ? merged.textChunkLimit : DEFAULT_TEXT_CHUNK_LIMIT;

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    email,
    apiKey,
    baseUrlSource,
    emailSource,
    apiKeySource,
    streams,
    alwaysReply,
    defaultTopic,
    reactions,
    textChunkLimit,
    config: merged,
  };
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
