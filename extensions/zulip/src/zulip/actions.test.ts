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

  it("lists the added actions", () => {
    expect(zulipMessageActions.listActions()).toEqual(
      expect.arrayContaining([
        "read",
        "search",
        "channel-list",
        "channel-create",
        "channel-edit",
        "channel-delete",
        "member-info",
        "pin",
        "unpin",
      ]),
    );
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
    expect(result.details).toMatchObject({ action: "read", count: 1 });
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

  it("lists streams", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      streams: [{ stream_id: 7, name: "marcel-ai" }],
    });

    const result = await zulipMessageActions.handleAction({
      action: "channel-list",
      params: {},
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/streams" }),
    );
    expect(result.details).toMatchObject({ action: "channel-list", count: 1 });
  });

  it("creates a stream", async () => {
    await zulipMessageActions.handleAction({
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
  });

  it("edits a stream by resolving stream id from name", async () => {
    vi.mocked(zulipRequest).mockResolvedValueOnce({
      result: "success",
      streams: [{ stream_id: 12, name: "marcel-ai" }],
    });

    await zulipMessageActions.handleAction({
      action: "channel-edit",
      params: { name: "marcel-ai", newName: "marcel-bot", description: "updated" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/streams" }),
    );
    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/streams/12",
        form: {
          new_name: "marcel-bot",
          description: "updated",
          is_private: undefined,
        },
      }),
    );
  });

  it("deletes a stream by explicit streamId", async () => {
    await zulipMessageActions.handleAction({
      action: "channel-delete",
      params: { streamId: 22 },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/api/v1/streams/22" }),
    );
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

  it("pins a message using starred flag", async () => {
    await zulipMessageActions.handleAction({
      action: "pin",
      params: { messageId: "123" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/messages/flags",
        form: {
          messages: "[123]",
          op: "add",
          flag: "starred",
        },
      }),
    );
  });

  it("unpins a message using starred flag", async () => {
    await zulipMessageActions.handleAction({
      action: "unpin",
      params: { messageId: "123" },
      cfg,
      accountId: "default",
    } as never);

    expect(zulipRequestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/v1/messages/flags",
        form: {
          messages: "[123]",
          op: "remove",
          flag: "starred",
        },
      }),
    );
  });
});
