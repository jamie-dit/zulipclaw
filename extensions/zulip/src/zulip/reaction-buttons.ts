import type { ZulipAuth } from "./client.js";
import { normalizeStreamName, normalizeTopic } from "./normalize.js";
import { addZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";

// Numbered emoji for reaction buttons: 1️⃣ through 9️⃣, then 🔟 for 10
const NUMBERED_EMOJIS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "keycap_ten",
];

export type ReactionButtonOption = {
  label: string;
  value: string;
};

export type ActiveReactionButtonSession = {
  messageId: number;
  stream: string;
  topic: string;
  options: ReactionButtonOption[];
  createdAt: number;
  timeoutMs: number;
};

export type ReactionButtonResult = {
  messageId: number;
  selectedOption?: ReactionButtonOption;
  selectedIndex?: number;
};

// In-memory store for active reaction button sessions
// Key: messageId (as string), Value: session info
const activeSessions = new Map<string, ActiveReactionButtonSession>();

// Cleanup interval for expired sessions
let cleanupInterval: ReturnType<typeof setInterval> | undefined;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default timeout

/**
 * Get the emoji name for a given option index (0-based)
 */
export function getReactionEmojiForIndex(index: number): string | undefined {
  if (index >= 0 && index < NUMBERED_EMOJIS.length) {
    return NUMBERED_EMOJIS[index];
  }
  return undefined;
}

/**
 * Get all emoji names for a given number of options
 */
export function getReactionEmojisForOptionCount(count: number): string[] {
  return NUMBERED_EMOJIS.slice(0, Math.min(count, NUMBERED_EMOJIS.length));
}

/**
 * Get the index from an emoji reaction name
 * Returns -1 if the emoji is not a numbered reaction button
 */
export function getIndexFromReactionEmoji(emojiName: string): number {
  const normalized = emojiName.replace(/:/g, "").toLowerCase();
  const index = NUMBERED_EMOJIS.indexOf(normalized);
  return index;
}

/**
 * Check if an emoji name is a valid reaction button emoji
 */
export function isReactionButtonEmoji(emojiName: string): boolean {
  return getIndexFromReactionEmoji(emojiName) >= 0;
}

/**
 * Format a message with reaction button options
 */
export function formatReactionButtonMessage(
  message: string,
  options: ReactionButtonOption[],
): string {
  const lines = [message];
  lines.push("");
  lines.push("**React with:**");
  options.forEach((option, index) => {
    const emoji = getReactionEmojiForIndex(index);
    if (emoji) {
      lines.push(`:${emoji}: ${option.label}`);
    }
  });
  return lines.join("\n");
}

/**
 * Start the cleanup interval for expired sessions
 * Should be called once during initialization
 */
export function startReactionButtonSessionCleanup(): void {
  if (cleanupInterval) {
    return;
  }
  cleanupInterval = setInterval(() => {
    cleanupExpiredSessions();
  }, 60_000); // Run every minute
  cleanupInterval.unref?.();
}

/**
 * Stop the cleanup interval
 */
export function stopReactionButtonSessionCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

/**
 * Remove expired sessions from the store
 */
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [key, session] of activeSessions.entries()) {
    if (now - session.createdAt > session.timeoutMs) {
      activeSessions.delete(key);
    }
  }
}

/**
 * Store a new reaction button session
 */
export function storeReactionButtonSession(session: ActiveReactionButtonSession): void {
  activeSessions.set(String(session.messageId), session);
}

/**
 * Get an active reaction button session by message ID
 */
export function getReactionButtonSession(
  messageId: number,
): ActiveReactionButtonSession | undefined {
  const session = activeSessions.get(String(messageId));
  if (!session) {
    return undefined;
  }
  // Check if expired
  if (Date.now() - session.createdAt > session.timeoutMs) {
    activeSessions.delete(String(messageId));
    return undefined;
  }
  return session;
}

/**
 * Remove a reaction button session
 */
export function removeReactionButtonSession(messageId: number): void {
  activeSessions.delete(String(messageId));
}

/**
 * Clear all reaction button sessions (useful for testing)
 */
export function clearAllReactionButtonSessions(): void {
  activeSessions.clear();
}

/**
 * Get count of active sessions (useful for debugging)
 */
export function getActiveReactionButtonSessionCount(): number {
  return activeSessions.size;
}

/**
 * Handle an incoming reaction event
 * Returns the result if it matches an active session and is from a user (not the bot)
 */
export function handleReactionEvent(params: {
  messageId: number;
  emojiName: string;
  userId: number;
  botUserId: number;
}): ReactionButtonResult | null {
  // Ignore reactions from the bot itself
  if (params.userId === params.botUserId) {
    return null;
  }

  // Check if this is a reaction button emoji
  const selectedIndex = getIndexFromReactionEmoji(params.emojiName);
  if (selectedIndex < 0) {
    return null;
  }

  // Check if there's an active session for this message
  const session = getReactionButtonSession(params.messageId);
  if (!session) {
    return null;
  }

  // Check if the index is valid for this session
  if (selectedIndex >= session.options.length) {
    return null;
  }

  // Return the result
  return {
    messageId: params.messageId,
    selectedOption: session.options[selectedIndex],
    selectedIndex,
  };
}

/**
 * Send a message with reaction buttons and track the session
 * This is the main helper to atomically send a message and add numbered reactions
 */
export async function sendWithReactionButtons(params: {
  auth: ZulipAuth;
  stream: string;
  topic: string;
  message: string;
  options: ReactionButtonOption[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ messageId: number; session: ActiveReactionButtonSession }> {
  const stream = normalizeStreamName(params.stream);
  const topic = normalizeTopic(params.topic);

  if (!stream) {
    throw new Error("Missing stream name");
  }

  if (params.options.length === 0) {
    throw new Error("At least one option is required for reaction buttons");
  }

  if (params.options.length > NUMBERED_EMOJIS.length) {
    throw new Error(
      `Too many options: ${params.options.length}. Maximum is ${NUMBERED_EMOJIS.length}.`,
    );
  }

  // Format the message with options
  const content = formatReactionButtonMessage(params.message, params.options);

  // Send the message
  const result = await sendZulipStreamMessage({
    auth: params.auth,
    stream,
    topic,
    content,
    abortSignal: params.abortSignal,
  });

  if (typeof result.id !== "number") {
    throw new Error("Failed to get message ID from send response");
  }

  const messageId = result.id;

  // Add numbered reactions atomically
  const emojis = getReactionEmojisForOptionCount(params.options.length);
  const reactionPromises = emojis.map((emojiName) =>
    addZulipReaction({
      auth: params.auth,
      messageId,
      emojiName,
      abortSignal: params.abortSignal,
    }).catch(() => {
      // Best effort - individual reaction failures shouldn't fail the whole operation
    }),
  );

  await Promise.all(reactionPromises);

  // Create and store the session
  const session: ActiveReactionButtonSession = {
    messageId,
    stream,
    topic,
    options: params.options,
    createdAt: Date.now(),
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  storeReactionButtonSession(session);

  // Ensure cleanup is running
  startReactionButtonSessionCleanup();

  return { messageId, session };
}
