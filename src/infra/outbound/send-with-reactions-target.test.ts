import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

describe("sendWithReactions target plumbing", () => {
  const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
    jsonResult({ ok: true, params }),
  );

  const plugin: ChannelPlugin = {
    id: "testchat",
    meta: {
      id: "testchat",
      label: "Test Chat",
      selectionLabel: "Test Chat",
      docsPath: "/channels/testchat",
      blurb: "sendWithReactions target plumbing test plugin",
    },
    capabilities: { chatTypes: ["channel"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isConfigured: () => true,
    },
    actions: {
      listActions: () => ["sendWithReactions"],
      supportsAction: ({ action }) => action === "sendWithReactions",
      handleAction,
    },
  };

  const cfg = {
    channels: {
      testchat: {
        enabled: true,
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin,
        },
      ]),
    );
    handleAction.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.clearAllMocks();
  });

  it("accepts target and maps it to to", async () => {
    await runMessageAction({
      cfg,
      action: "sendWithReactions",
      params: {
        channel: "testchat",
        target: "channel:test-room",
        message: "Pick one",
        options: ["A", "B"],
      },
      dryRun: false,
    });

    const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
      | { params: Record<string, unknown> }
      | undefined;
    expect(ctx?.params.to).toBe("channel:test-room");
  });

  it("keeps legacy to compatibility", async () => {
    await runMessageAction({
      cfg,
      action: "sendWithReactions",
      params: {
        channel: "testchat",
        to: "channel:test-room",
        message: "Pick one",
        options: ["A", "B"],
      },
      dryRun: false,
    });

    const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
      | { params: Record<string, unknown> }
      | undefined;
    expect(ctx?.params.to).toBe("channel:test-room");
  });
});
