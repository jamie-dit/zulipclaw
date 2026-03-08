import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  zulipRequest: vi.fn(async () => ({ result: "success" })),
  zulipRequestWithRetry: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: vi.fn(async () => ({ id: 999 })),
}));

vi.mock("./reaction-buttons.js", () => ({
  sendWithReactionButtons: vi.fn(async () => ({ messageId: 888 })),
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: vi.fn(async () => ({ result: "success" })),
  removeZulipReaction: vi.fn(async () => ({ result: "success" })),
}));

vi.mock("./uploads.js", () => ({
  resolveOutboundMedia: vi.fn(),
  uploadZulipFile: vi.fn(),
}));

import { zulipMessageActions } from "./actions.js";
import { zulipRequest, zulipRequestWithRetry } from "./client.js";
import { sendWithReactionButtons } from "./reaction-buttons.js";
import { addZulipReaction, removeZulipReaction } from "./reactions.js";
import { sendZulipStreamMessage } from "./send.js";

const cfg: OpenClawConfig = {
  channels: {
    zulip: {
      enabled: true,
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "key",
      streams: ["marcel-ai"],
      defaultTopic: "general chat",
    },
  },
};

describe("zulipMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the supported actions without fake pin actions", () => {
    expect(zulipMessageActions.listActions()).toEqual(
      expect.arrayContaining([
        "send",
        "sendWithReactions",
        "edit",
        "delete",
        "react",
        "read",
        "search",
        "channel-list",
        "channel-create",
        "channel-edit",
        "channel-delete",
        "member-info",
      ]),
    );
    expect(zulipMessageActions.listActions()).not.toEqual(
      expect.arrayContaining(["pin", "unpin", "list-pins"]),
    );
  });

  it("exposes the intended public action list without pin actions", () => {
    const actions = zulipMessageActions.listActions();
    expect(actions).toContain("react");
    expect(actions).toContain("channel-delete");
    expect(actions).not.toContain("pin");
    expect(actions).not.toContain("unpin");
    expect(actions).not.toContain("list-pins");
  });

  it("reads messages from a stream topic", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      messages: [{ id: 1, content: "hello" }],
    });

    const result = await zulipMessageActions.handleAction({
      action: "read",
      params: { target: "stream:marcel-ai#deploy", limit: 5 },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/messages",
        query: {
          anchor: "newest",
          num_before: 5,
          num_after: 0,
          narrow: JSON.stringify([
            ["stream", "marcel-ai"],
            ["topic", "deploy"],
          ]),
        },
      }),
    );
    expect(result.details).toMatchObject({
      action: "read",
      count: 1,
      target: "stream:marcel-ai#deploy",
    });
  });

  it("uses the account default topic when reading a bare stream target", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({ result: "success", messages: [] });

    await zulipMessageActions.handleAction({
      action: "read",
      params: { target: "stream:marcel-ai" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          narrow: JSON.stringify([
            ["stream", "marcel-ai"],
            ["topic", "general chat"],
          ]),
        }),
      }),
    );
  });

  it("searches messages within a stream", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      messages: [{ id: 2, content: "match" }],
    });

    const result = await zulipMessageActions.handleAction({
      action: "search",
      params: { target: "stream:marcel-ai", query: "deploy failed", limit: 10 },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/messages",
        query: {
          anchor: "newest",
          num_before: 10,
          num_after: 0,
          narrow: JSON.stringify([
            ["stream", "marcel-ai"],
            ["search", "deploy failed"],
          ]),
        },
      }),
    );
    expect(result.details).toMatchObject({ action: "search", query: "deploy failed", count: 1 });
  });

  it("lists streams with includePublic/includeWebPublic flags", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      streams: [{ stream_id: 7, name: "marcel-ai" }],
    });

    const result = await zulipMessageActions.handleAction({
      action: "channel-list",
      params: { includePublic: false, includeWebPublic: true },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/v1/streams",
        query: { include_public: false, include_web_public: true },
      }),
    );
    expect(result.details).toMatchObject({ action: "channel-list", count: 1 });
  });

  it("creates a stream", async () => {
    const result = await zulipMessageActions.handleAction({
      action: "channel-create",
      params: { name: "new-stream", description: "desc", isPrivate: true },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/users/me/subscriptions",
        form: {
          subscriptions: JSON.stringify([
            { name: "new-stream", description: "desc", is_private: true },
          ]),
        },
      }),
    );
    expect(result.details).toMatchObject({
      action: "channel-create",
      name: "new-stream",
      isPrivate: true,
    });
  });

  it("edits a stream by resolving stream id from name", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      streams: [{ stream_id: 12, name: "marcel-ai" }],
    });

    const result = await zulipMessageActions.handleAction({
      action: "channel-edit",
      params: {
        name: "marcel-ai",
        newName: "marcel-bot",
        description: "updated",
        isPrivate: false,
      },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/streams/12",
        form: {
          new_name: "marcel-bot",
          description: "updated",
          is_private: false,
        },
      }),
    );
    expect(result.details).toMatchObject({ action: "channel-edit", streamId: 12 });
  });

  it("edits a stream directly by explicit streamId", async () => {
    await zulipMessageActions.handleAction({
      action: "channel-edit",
      params: { streamId: 22, description: "changed" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/streams/22",
        form: {
          new_name: undefined,
          description: "changed",
          is_private: undefined,
        },
      }),
    );
  });

  it("rejects channel-edit when no changes are provided", async () => {
    await expect(
      zulipMessageActions.handleAction({
        action: "channel-edit",
        params: { streamId: 22 },
        cfg,
        accountId: "default",
      } as never),
    ).rejects.toThrow("No channel updates provided");
  });

  it("deletes a stream by explicit streamId", async () => {
    const result = await zulipMessageActions.handleAction({
      action: "channel-delete",
      params: { streamId: 22 },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/api/v1/streams/22" }),
    );
    expect(result.details).toMatchObject({ action: "channel-delete", streamId: 22 });
  });

  it("fetches member info for self by default", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      user: { user_id: 42, full_name: "Marcel" },
    });

    const result = await zulipMessageActions.handleAction({
      action: "member-info",
      params: {},
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/users/me" }),
    );
    expect(result.details).toMatchObject({ action: "member-info", user: { user_id: 42 } });
  });

  it("fetches member info for an explicit email", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      user: { email: "jamie@example.com" },
    });

    await zulipMessageActions.handleAction({
      action: "member-info",
      params: { email: "jamie@example.com" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/users/jamie%40example.com" }),
    );
  });

  it("accepts target for member info lookups", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      user: { email: "jamie@example.com" },
    });

    await zulipMessageActions.handleAction({
      action: "member-info",
      params: { target: "jamie@example.com" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/users/jamie%40example.com" }),
    );
  });

  it("resolves participant names through the Zulip user directory", async () => {
    vi.mocked(zulipRequest)
      .mockResolvedValueOnce({
        result: "success",
        members: [
          { user_id: 42, email: "marcel@example.com", full_name: "Marcel" },
          { user_id: 99, email: "jamie@example.com", full_name: "Jamie" },
        ],
      })
      .mockResolvedValueOnce({
        result: "success",
        user: { user_id: 99, email: "jamie@example.com", full_name: "Jamie" },
      });

    const result = await zulipMessageActions.handleAction({
      action: "member-info",
      params: { participant: "Jamie" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "GET", path: "/api/v1/users" }),
    );
    expect(zulipRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "GET", path: "/api/v1/users/jamie%40example.com" }),
    );
    expect(result.details).toMatchObject({
      action: "member-info",
      requested: "Jamie",
      resolvedUserId: "jamie@example.com",
      user: { user_id: 99 },
    });
  });

  it("adds a reaction", async () => {
    const result = await zulipMessageActions.handleAction({
      action: "react",
      params: { messageId: "123", emoji: "eyes" },
      cfg,
      accountId: "default",
    } as never);

    expect(addZulipReaction).toHaveBeenCalledWith({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "key",
      },
      messageId: 123,
      emojiName: "eyes",
    });
    expect(result.details).toMatchObject({
      action: "react",
      messageId: "123",
      emoji: "eyes",
      remove: false,
    });
  });

  it("removes a reaction when remove=true", async () => {
    await zulipMessageActions.handleAction({
      action: "react",
      params: { messageId: "123", emoji: "eyes", remove: true },
      cfg,
      accountId: "default",
    } as never);

    expect(removeZulipReaction).toHaveBeenCalledWith({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "key",
      },
      messageId: 123,
      emojiName: "eyes",
    });
  });

  it("sends a stream message", async () => {
    const result = await zulipMessageActions.handleAction({
      action: "send",
      params: { target: "stream:marcel-ai#deploy", message: "ship it" },
      cfg,
      accountId: "default",
    } as never);

    expect(sendZulipStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ stream: "marcel-ai", topic: "deploy", content: "ship it" }),
    );
    expect(result.details).toMatchObject({ action: "send", messageId: "999" });
  });

  it("sends a message with reaction buttons", async () => {
    const result = await zulipMessageActions.handleAction({
      action: "sendWithReactions",
      params: {
        target: "stream:marcel-ai#deploy",
        message: "Pick one",
        options: ["One", { label: "Two", value: "two" }],
        timeoutMs: 1234,
      },
      cfg,
      accountId: "default",
    } as never);

    expect(sendWithReactionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "marcel-ai",
        topic: "deploy",
        message: "Pick one",
        timeoutMs: 1234,
        options: [
          { label: "One", value: "One" },
          { label: "Two", value: "two" },
        ],
      }),
    );
    expect(result.details).toMatchObject({ action: "sendWithReactions", messageId: "888" });
  });

  it("keeps the public action list aligned with the supported Zulip surface", () => {
    expect(zulipMessageActions.listActions()).toContain("send");
    expect(zulipMessageActions.listActions()).toContain("member-info");
    expect(zulipMessageActions.listActions()).not.toContain("pin");
    expect(zulipMessageActions.listActions()).not.toContain("unpin");
    expect(zulipMessageActions.listActions()).not.toContain("list-pins");
  });
});
