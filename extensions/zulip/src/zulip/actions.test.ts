import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zulipMessageActions } from "./actions.js";

const requestMock = vi.fn();
const requestWithRetryMock = vi.fn();

vi.mock("./accounts.js", () => ({
  resolveZulipAccount: vi.fn(() => ({
    accountId: "default",
    baseUrl: "https://zulip.example.com",
    email: "bot@example.com",
    apiKey: "test-key",
    defaultTopic: "general",
  })),
}));

vi.mock("./client.js", () => ({
  zulipRequest: (...args: unknown[]) => requestMock(...args),
  zulipRequestWithRetry: (...args: unknown[]) => requestWithRetryMock(...args),
}));

vi.mock("./reactions.js", () => ({
  addZulipReaction: vi.fn(),
  removeZulipReaction: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendZulipStreamMessage: vi.fn(),
}));

vi.mock("./uploads.js", () => ({
  uploadZulipFile: vi.fn(),
  resolveOutboundMedia: vi.fn(),
}));

vi.mock("./reaction-buttons.js", () => ({
  sendWithReactionButtons: vi.fn(),
}));

describe("zulip channel-edit/channel-delete target parsing", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestWithRetryMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("channel-edit accepts target stream form", async () => {
    requestMock.mockResolvedValueOnce({
      streams: [{ name: "marcel-canary-actions-bf4d6e", stream_id: 18 }],
    });
    requestWithRetryMock.mockResolvedValueOnce({ result: "success" });

    const result = await zulipMessageActions.handleAction({
      action: "channel-edit",
      params: {
        target: "stream:marcel-canary-actions-bf4d6e#whatever",
        newName: "marcel-canary-actions-bf4d6e-renamed",
      },
      cfg: {},
      accountId: undefined,
    } as never);

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/v1/streams" }),
    );
    expect(requestWithRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        path: "/api/v1/streams/18",
        form: expect.objectContaining({ new_name: "marcel-canary-actions-bf4d6e-renamed" }),
      }),
    );
    expect(result).toMatchObject({ details: { ok: true, action: "channel-edit", streamId: 18 } });
  });

  it("channel-delete accepts target stream form", async () => {
    requestMock
      .mockResolvedValueOnce({ streams: [{ name: "marcel-canary-actions-bf4d6e", stream_id: 18 }] })
      .mockResolvedValueOnce({ result: "success" });

    const result = await zulipMessageActions.handleAction({
      action: "channel-delete",
      params: {
        target: "stream:marcel-canary-actions-bf4d6e#whatever",
      },
      cfg: {},
      accountId: undefined,
    } as never);

    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "DELETE", path: "/api/v1/streams/18" }),
    );
    expect(result).toMatchObject({ details: { ok: true, action: "channel-delete", streamId: 18 } });
  });

  it("channel-delete accepts streamId as a string from channel-list output", async () => {
    requestMock.mockResolvedValueOnce({ result: "success" });

    const result = await zulipMessageActions.handleAction({
      action: "channel-delete",
      params: {
        streamId: "18",
      },
      cfg: {},
      accountId: undefined,
    } as never);

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/api/v1/streams/18" }),
    );
    expect(result).toMatchObject({ details: { ok: true, action: "channel-delete", streamId: 18 } });
  });
});
