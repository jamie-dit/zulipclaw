import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("./client.js", () => {
  return {
    zulipRequest: vi.fn(async () => ({ result: "success" })),
    zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
  };
});

vi.mock("./reactions.js", () => {
  return {
    addZulipReaction: vi.fn(async () => ({ result: "success" })),
    removeZulipReaction: vi.fn(async () => ({ result: "success" })),
  };
});

vi.mock("./send.js", () => {
  return {
    sendZulipStreamMessage: vi.fn(async () => ({ result: "success", id: 12345 })),
    editZulipStreamMessage: vi.fn(async () => ({ result: "success" })),
  };
});

import type { ZulipAuth } from "./client.js";
import {
  getReactionEmojiForIndex,
  getReactionEmojisForOptionCount,
  getIndexFromReactionEmoji,
  isReactionButtonEmoji,
  formatReactionButtonMessage,
  handleReactionEvent,
  sendWithReactionButtons,
  storeReactionButtonSession,
  getReactionButtonSession,
  removeReactionButtonSession,
  clearAllReactionButtonSessions,
  getActiveReactionButtonSessionCount,
  startReactionButtonSessionCleanup,
  stopReactionButtonSessionCleanup,
  cleanupExpiredSessions,
  type ReactionButtonOption,
} from "./reaction-buttons.js";
import { addZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";

describe("reaction-buttons", () => {
  const mockAuth: ZulipAuth = {
    baseUrl: "https://zulip.example",
    email: "bot@zulip.example",
    apiKey: "not-a-real-key",
  };

  beforeEach(() => {
    clearAllReactionButtonSessions();
    stopReactionButtonSessionCleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopReactionButtonSessionCleanup();
  });

  describe("getReactionEmojiForIndex", () => {
    it("returns correct emoji for indices 0-9", () => {
      expect(getReactionEmojiForIndex(0)).toBe("one");
      expect(getReactionEmojiForIndex(1)).toBe("two");
      expect(getReactionEmojiForIndex(9)).toBe("keycap_ten");
    });

    it("returns undefined for out-of-range indices", () => {
      expect(getReactionEmojiForIndex(-1)).toBeUndefined();
      expect(getReactionEmojiForIndex(10)).toBeUndefined();
      expect(getReactionEmojiForIndex(100)).toBeUndefined();
    });
  });

  describe("getReactionEmojisForOptionCount", () => {
    it("returns correct emojis for given count", () => {
      expect(getReactionEmojisForOptionCount(3)).toEqual(["one", "two", "three"]);
      expect(getReactionEmojisForOptionCount(5)).toEqual(["one", "two", "three", "four", "five"]);
    });

    it("returns all emojis for count 10", () => {
      expect(getReactionEmojisForOptionCount(10)).toHaveLength(10);
    });

    it("caps at 10 emojis", () => {
      expect(getReactionEmojisForOptionCount(15)).toHaveLength(10);
    });
  });

  describe("getIndexFromReactionEmoji", () => {
    it("returns correct index for numbered emojis", () => {
      expect(getIndexFromReactionEmoji("one")).toBe(0);
      expect(getIndexFromReactionEmoji(":two:")).toBe(1);
      expect(getIndexFromReactionEmoji("keycap_ten")).toBe(9);
    });

    it("returns -1 for non-numbered emojis", () => {
      expect(getIndexFromReactionEmoji("eyes")).toBe(-1);
      expect(getIndexFromReactionEmoji("check")).toBe(-1);
      expect(getIndexFromReactionEmoji("")).toBe(-1);
    });
  });

  describe("isReactionButtonEmoji", () => {
    it("returns true for numbered emojis", () => {
      expect(isReactionButtonEmoji("one")).toBe(true);
      expect(isReactionButtonEmoji(":two:")).toBe(true);
      expect(isReactionButtonEmoji("keycap_ten")).toBe(true);
    });

    it("returns false for non-numbered emojis", () => {
      expect(isReactionButtonEmoji("eyes")).toBe(false);
      expect(isReactionButtonEmoji("check")).toBe(false);
    });
  });

  describe("formatReactionButtonMessage", () => {
    it("formats message with options", () => {
      const options: ReactionButtonOption[] = [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ];
      const result = formatReactionButtonMessage("Confirm?", options);

      expect(result).toContain("Confirm?");
      expect(result).toContain("**React with:**");
      expect(result).toContain(":one: Yes");
      expect(result).toContain(":two: No");
    });

    it("handles empty options", () => {
      const result = formatReactionButtonMessage("Confirm?", []);
      expect(result).toContain("Confirm?");
    });
  });

  describe("session management", () => {
    it("stores and retrieves sessions", () => {
      const session = {
        messageId: 123,
        stream: "test-stream",
        topic: "test-topic",
        options: [{ label: "A", value: "a" }],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      };

      storeReactionButtonSession(session);
      const retrieved = getReactionButtonSession(123);

      expect(retrieved).toEqual(session);
    });

    it("returns undefined for non-existent sessions", () => {
      const retrieved = getReactionButtonSession(999);
      expect(retrieved).toBeUndefined();
    });

    it("removes sessions", () => {
      const session = {
        messageId: 123,
        stream: "test-stream",
        topic: "test-topic",
        options: [{ label: "A", value: "a" }],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      };

      storeReactionButtonSession(session);
      removeReactionButtonSession(123);

      const retrieved = getReactionButtonSession(123);
      expect(retrieved).toBeUndefined();
    });

    it("clears all sessions", () => {
      storeReactionButtonSession({
        messageId: 1,
        stream: "s1",
        topic: "t1",
        options: [],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      });
      storeReactionButtonSession({
        messageId: 2,
        stream: "s2",
        topic: "t2",
        options: [],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      });

      expect(getActiveReactionButtonSessionCount()).toBe(2);
      clearAllReactionButtonSessions();
      expect(getActiveReactionButtonSessionCount()).toBe(0);
    });

    it("returns expired sessions as undefined", () => {
      const session = {
        messageId: 123,
        stream: "test-stream",
        topic: "test-topic",
        options: [{ label: "A", value: "a" }],
        createdAt: Date.now() - 1000, // 1 second ago
        timeoutMs: 100, // 100ms timeout
      };

      storeReactionButtonSession(session);
      const retrieved = getReactionButtonSession(123);

      expect(retrieved).toBeUndefined();
    });

    it("cleans up expired sessions", () => {
      storeReactionButtonSession({
        messageId: 1,
        stream: "s1",
        topic: "t1",
        options: [],
        createdAt: Date.now() - 1000,
        timeoutMs: 100,
      });
      storeReactionButtonSession({
        messageId: 2,
        stream: "s2",
        topic: "t2",
        options: [],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      });

      expect(getActiveReactionButtonSessionCount()).toBe(2);
      cleanupExpiredSessions();
      expect(getActiveReactionButtonSessionCount()).toBe(1);
      expect(getReactionButtonSession(1)).toBeUndefined();
      expect(getReactionButtonSession(2)).toBeDefined();
    });
  });

  describe("handleReactionEvent", () => {
    const botUserId = 100;

    beforeEach(() => {
      storeReactionButtonSession({
        messageId: 123,
        stream: "test-stream",
        topic: "test-topic",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
        createdAt: Date.now(),
        timeoutMs: 300_000,
      });
    });

    it("returns null for bot's own reactions", () => {
      const result = handleReactionEvent({
        messageId: 123,
        emojiName: "one",
        userId: botUserId,
        botUserId,
      });
      expect(result).toBeNull();
    });

    it("returns null for non-reaction-button emojis", () => {
      const result = handleReactionEvent({
        messageId: 123,
        emojiName: "eyes",
        userId: 200,
        botUserId,
      });
      expect(result).toBeNull();
    });

    it("returns null for unknown message IDs", () => {
      const result = handleReactionEvent({
        messageId: 999,
        emojiName: "one",
        userId: 200,
        botUserId,
      });
      expect(result).toBeNull();
    });

    it("returns result for valid user reaction", () => {
      const result = handleReactionEvent({
        messageId: 123,
        emojiName: "one",
        userId: 200,
        botUserId,
      });

      expect(result).not.toBeNull();
      expect(result?.messageId).toBe(123);
      expect(result?.selectedIndex).toBe(0);
      expect(result?.selectedOption).toEqual({ label: "Yes", value: "yes" });
    });

    it("returns correct option for different indices", () => {
      const result = handleReactionEvent({
        messageId: 123,
        emojiName: "two",
        userId: 200,
        botUserId,
      });

      expect(result?.selectedIndex).toBe(1);
      expect(result?.selectedOption).toEqual({ label: "No", value: "no" });
    });

    it("returns null for index out of range", () => {
      // Session only has 2 options, requesting index 5 (emoji :six:)
      const result = handleReactionEvent({
        messageId: 123,
        emojiName: "six",
        userId: 200,
        botUserId,
      });
      expect(result).toBeNull();
    });
  });

  describe("sendWithReactionButtons", () => {
    it("sends message and adds reactions", async () => {
      vi.mocked(sendZulipStreamMessage).mockResolvedValueOnce({
        result: "success",
        id: 54321,
      });

      const options: ReactionButtonOption[] = [
        { label: "Option 1", value: "opt1" },
        { label: "Option 2", value: "opt2" },
      ];

      const result = await sendWithReactionButtons({
        auth: mockAuth,
        stream: "test-stream",
        topic: "test-topic",
        message: "Choose an option:",
        options,
      });

      expect(result.messageId).toBe(54321);
      expect(sendZulipStreamMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "test-stream",
          topic: "test-topic",
        }),
      );
      expect(addZulipReaction).toHaveBeenCalledTimes(2);
      expect(addZulipReaction).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 54321, emojiName: "one" }),
      );
      expect(addZulipReaction).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 54321, emojiName: "two" }),
      );
    });

    it("throws error if stream is missing", async () => {
      await expect(
        sendWithReactionButtons({
          auth: mockAuth,
          stream: "",
          topic: "test-topic",
          message: "Choose:",
          options: [{ label: "A", value: "a" }],
        }),
      ).rejects.toThrow("Missing stream name");
    });

    it("throws error if options are empty", async () => {
      await expect(
        sendWithReactionButtons({
          auth: mockAuth,
          stream: "test-stream",
          topic: "test-topic",
          message: "Choose:",
          options: [],
        }),
      ).rejects.toThrow("At least one option is required");
    });

    it("throws error if too many options", async () => {
      const options = Array.from({ length: 11 }, (_, i) => ({
        label: `Option ${i}`,
        value: `opt${i}`,
      }));

      await expect(
        sendWithReactionButtons({
          auth: mockAuth,
          stream: "test-stream",
          topic: "test-topic",
          message: "Choose:",
          options,
        }),
      ).rejects.toThrow("Too many options");
    });

    it("stores session after sending", async () => {
      vi.mocked(sendZulipStreamMessage).mockResolvedValueOnce({
        result: "success",
        id: 12345,
      });

      const options: ReactionButtonOption[] = [{ label: "Yes", value: "yes" }];

      await sendWithReactionButtons({
        auth: mockAuth,
        stream: "test-stream",
        topic: "test-topic",
        message: "Confirm?",
        options,
        timeoutMs: 600_000,
      });

      const session = getReactionButtonSession(12345);
      expect(session).toBeDefined();
      expect(session?.stream).toBe("test-stream");
      expect(session?.topic).toBe("test-topic");
      expect(session?.options).toEqual(options);
      expect(session?.timeoutMs).toBe(600_000);
    });

    it("handles reaction failures gracefully", async () => {
      vi.mocked(sendZulipStreamMessage).mockResolvedValueOnce({
        result: "success",
        id: 12345,
      });
      vi.mocked(addZulipReaction).mockRejectedValueOnce(new Error("Rate limited"));

      const options: ReactionButtonOption[] = [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ];

      // Should not throw even if reactions fail
      await expect(
        sendWithReactionButtons({
          auth: mockAuth,
          stream: "test-stream",
          topic: "test-topic",
          message: "Choose:",
          options,
        }),
      ).resolves.toBeDefined();
    });

    it("throws if message ID is missing from response", async () => {
      vi.mocked(sendZulipStreamMessage).mockResolvedValueOnce({
        result: "success",
        // missing id
      });

      await expect(
        sendWithReactionButtons({
          auth: mockAuth,
          stream: "test-stream",
          topic: "test-topic",
          message: "Choose:",
          options: [{ label: "A", value: "a" }],
        }),
      ).rejects.toThrow("Failed to get message ID");
    });
  });

  describe("cleanup", () => {
    it("starts and stops cleanup interval without error", () => {
      // Should not throw when starting cleanup
      expect(() => startReactionButtonSessionCleanup()).not.toThrow();
      // Should not throw when stopping cleanup
      expect(() => stopReactionButtonSessionCleanup()).not.toThrow();
    });

    it("prevents multiple intervals from starting", () => {
      // Starting multiple times should not throw
      expect(() => {
        startReactionButtonSessionCleanup();
        startReactionButtonSessionCleanup();
      }).not.toThrow();
      stopReactionButtonSessionCleanup();
    });
  });
});
