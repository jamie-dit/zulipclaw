import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => {
  return {
    zulipRequest: vi.fn(async () => ({ result: "success", emoji: { eyes: {}, thumbs_up: {} } })),
    zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
  };
});

import type { ZulipAuth } from "./client.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { addZulipReaction, removeZulipReaction, resolveEmojiNameCandidates } from "./reactions.js";

function makeAuth(id = "default"): ZulipAuth {
  return {
    baseUrl: "https://zulip.example",
    email: `bot+${id}@zulip.example`,
    apiKey: "not-a-real-key",
  };
}

describe("resolveEmojiNameCandidates", () => {
  it("maps common unicode emoji to deterministic Zulip names", () => {
    expect(resolveEmojiNameCandidates("👍")).toEqual(["thumbs_up", "+1", "👍"]);
    expect(resolveEmojiNameCandidates("✅")).toEqual(["check", "white_check_mark", "✅"]);
  });
});

describe("removeZulipReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends emoji_name as query params", async () => {
    await removeZulipReaction({
      auth: makeAuth("remove"),
      messageId: 123,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/api/v1/messages/123/reactions",
        query: { emoji_name: "eyes" },
      }),
    );
  });
});

describe("addZulipReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends emoji_name as form params", async () => {
    await addZulipReaction({
      auth: makeAuth("add-basic"),
      messageId: 456,
      emojiName: ":eyes:",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/messages/456/reactions",
        form: { emoji_name: "eyes" },
      }),
    );
  });

  it("maps unicode emoji to Zulip emoji names when available", async () => {
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { thumbs_up: {} },
    });

    await addZulipReaction({
      auth: makeAuth("add-map"),
      messageId: 789,
      emojiName: "👍",
    });

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        form: { emoji_name: "thumbs_up" },
      }),
    );
  });

  it("skips unavailable emoji without throwing", async () => {
    const log = vi.fn();
    vi.mocked(zulipRequest).mockResolvedValue({
      result: "success",
      emoji: { eyes: {} },
    });

    await expect(
      addZulipReaction({
        auth: makeAuth("add-skip"),
        messageId: 999,
        emojiName: "🤷",
        log,
      }),
    ).resolves.toMatchObject({ result: "success" });

    expect(zulipRequestWithRetry).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not available in this realm/i));
  });

  it("tries mapped fallbacks when emoji directory lookup is unavailable", async () => {
    vi.mocked(zulipRequest).mockRejectedValueOnce(new Error("directory unavailable"));
    vi.mocked(zulipRequestWithRetry).mockImplementation(async ({ form }) => {
      const emojiName = (form as { emoji_name: string }).emoji_name;
      if (emojiName === "thumbs_up") {
        const err = new Error("Zulip API error (400): Invalid emoji name");
        (err as { status?: number }).status = 400;
        throw err;
      }
      return { result: "success" };
    });

    await addZulipReaction({
      auth: makeAuth("add-fallback"),
      messageId: 1000,
      emojiName: "👍",
    });

    const triedEmojiNames = vi
      .mocked(zulipRequestWithRetry)
      .mock.calls.map(([arg]) => (arg.form as { emoji_name: string }).emoji_name);
    expect(triedEmojiNames).toContain("thumbs_up");
    expect(triedEmojiNames).toContain("+1");
  });
});
