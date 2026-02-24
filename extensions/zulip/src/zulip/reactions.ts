import type { ZulipApiSuccess, ZulipAuth } from "./client.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { normalizeEmojiName } from "./normalize.js";

const UNICODE_EMOJI_NAME_MAP: Record<string, string[]> = {
  "👍": ["thumbs_up", "+1"],
  "👎": ["thumbs_down", "-1"],
  "✅": ["check", "white_check_mark"],
  "❌": ["x", "cross_mark"],
  "❤️": ["heart"],
  "❤": ["heart"],
  "🔥": ["fire"],
  "🎉": ["tada", "party_popper"],
  "😂": ["joy"],
  "😄": ["smile"],
  "👏": ["clap"],
  "🙏": ["pray", "folded_hands"],
  "🤔": ["thinking", "thinking_face"],
  "👀": ["eyes"],
};

const EMOJI_DIRECTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const emojiDirectoryCache = new Map<string, { expiresAt: number; names: Set<string> }>();

function normalizeUnicodeEmoji(raw: string): string {
  return raw.replace(/\uFE0F/g, "");
}

export function resolveEmojiNameCandidates(raw?: string | null): string[] {
  const normalized = normalizeEmojiName(raw);
  if (!normalized) {
    return [];
  }

  const strippedUnicode = normalizeUnicodeEmoji(normalized);
  const mapped =
    UNICODE_EMOJI_NAME_MAP[normalized] ??
    UNICODE_EMOJI_NAME_MAP[strippedUnicode] ??
    UNICODE_EMOJI_NAME_MAP[(raw ?? "").trim()] ??
    [];

  const direct = normalizeEmojiName(strippedUnicode);
  const candidates = [...mapped, normalized, direct].filter(Boolean);
  return Array.from(new Set(candidates));
}

function getEmojiCacheKey(auth: ZulipAuth): string {
  return `${auth.baseUrl}::${auth.email}`;
}

function collectEmojiNames(mapLike: unknown, target: Set<string>) {
  if (!mapLike || typeof mapLike !== "object") {
    return;
  }
  for (const [name, value] of Object.entries(mapLike as Record<string, unknown>)) {
    const normalized = normalizeEmojiName(name);
    if (normalized) {
      target.add(normalized);
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const aliases = (value as { aliases?: unknown }).aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias !== "string") {
          continue;
        }
        const normalizedAlias = normalizeEmojiName(alias);
        if (normalizedAlias) {
          target.add(normalizedAlias);
        }
      }
    }
  }
}

async function getAvailableEmojiNames(
  auth: ZulipAuth,
  abortSignal?: AbortSignal,
): Promise<Set<string> | null> {
  const cacheKey = getEmojiCacheKey(auth);
  const cached = emojiDirectoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.names;
  }

  try {
    const response = await zulipRequest<Record<string, unknown>>({
      auth,
      method: "GET",
      path: "/api/v1/emoji",
      abortSignal,
    });
    const names = new Set<string>();
    collectEmojiNames(response?.emoji, names);
    collectEmojiNames(response?.realm_emoji, names);
    if (names.size > 0) {
      emojiDirectoryCache.set(cacheKey, {
        expiresAt: Date.now() + EMOJI_DIRECTORY_CACHE_TTL_MS,
        names,
      });
      return names;
    }
  } catch {
    // Best effort only; fallback attempts still run without this directory.
  }

  return null;
}

function isUnknownEmojiError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 400 && /emoji/i.test(message)) {
    return true;
  }
  return /emoji/i.test(message) && /(invalid|unknown|not found|does not exist)/i.test(message);
}

export async function addZulipReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  emojiName: string;
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<ZulipApiSuccess> {
  const candidates = resolveEmojiNameCandidates(params.emojiName);
  if (candidates.length === 0) {
    throw new Error("Missing emoji_name");
  }

  const availableNames = await getAvailableEmojiNames(params.auth, params.abortSignal);
  let candidatesToTry = candidates;

  if (availableNames) {
    const supported = candidates.filter((candidate) => availableNames.has(candidate));
    if (supported.length === 0) {
      params.log?.(
        `[zulip] reaction emoji "${params.emojiName}" not available in this realm; skipping reaction add.`,
      );
      return { result: "success", msg: "skipped unavailable emoji" };
    }
    candidatesToTry = supported;
  }

  let lastUnknownError: unknown;
  for (const emojiName of candidatesToTry) {
    try {
      return await zulipRequestWithRetry<ZulipApiSuccess>({
        auth: params.auth,
        method: "POST",
        path: `/api/v1/messages/${params.messageId}/reactions`,
        form: {
          emoji_name: emojiName,
        },
        retry: {
          maxRetries: 2,
          baseDelayMs: 1000,
          maxDelayMs: 10_000,
        },
        abortSignal: params.abortSignal,
      });
    } catch (err) {
      if (isUnknownEmojiError(err)) {
        lastUnknownError = err;
        continue;
      }
      throw err;
    }
  }

  params.log?.(
    `[zulip] failed to resolve a valid reaction emoji for "${params.emojiName}"; skipping reaction add (${String(lastUnknownError ?? "unknown emoji")}).`,
  );
  return { result: "success", msg: "skipped unresolved emoji" };
}

export async function removeZulipReaction(params: {
  auth: ZulipAuth;
  messageId: number;
  emojiName: string;
  abortSignal?: AbortSignal;
}): Promise<ZulipApiSuccess> {
  const emojiName = resolveEmojiNameCandidates(params.emojiName)[0] ?? "";
  if (!emojiName) {
    throw new Error("Missing emoji_name");
  }
  return await zulipRequestWithRetry<ZulipApiSuccess>({
    auth: params.auth,
    method: "DELETE",
    path: `/api/v1/messages/${params.messageId}/reactions`,
    // Zulip's DELETE endpoints are not guaranteed to accept request bodies.
    // Send identifiers as query params so reactions reliably clear.
    query: {
      emoji_name: emojiName,
    },
    retry: {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
    },
    abortSignal: params.abortSignal,
  });
}
