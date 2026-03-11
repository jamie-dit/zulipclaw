import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { DiscordProbe } from "../../discord/probe.js";
import type { DiscordTokenResolution } from "../../discord/token.js";
import type { IMessageProbe } from "../../imessage/probe.js";
import type { LineProbeResult } from "../../line/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { SignalProbe } from "../../signal/probe.js";
import type { SlackProbe } from "../../slack/probe.js";
import type { TelegramProbe } from "../../telegram/probe.js";
import type { TelegramTokenResolution } from "../../telegram/token.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { listChannelPluginCatalogEntries } from "./catalog.js";
import { resolveChannelConfigWrites } from "./config-writes.js";
import { loadChannelPlugin } from "./load.js";
import { loadChannelOutboundAdapter } from "./outbound/load.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "./types.js";
import type { BaseProbeResult, BaseTokenResolution } from "./types.js";

describe("channel plugin catalog", () => {
  it("includes external catalog entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-"));
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        entries: [
          {
            name: "@openclaw/demo-channel",
            openclaw: {
              channel: {
                id: "demo-channel",
                label: "Demo Channel",
                selectionLabel: "Demo Channel",
                docsPath: "/channels/demo-channel",
                blurb: "Demo entry",
                order: 999,
              },
              install: {
                npmSpec: "@openclaw/demo-channel",
              },
            },
          },
        ],
      }),
    );

    const ids = listChannelPluginCatalogEntries({ catalogPaths: [catalogPath] }).map(
      (entry) => entry.id,
    );
    expect(ids).toContain("demo-channel");
  });
});

const emptyRegistry = createTestRegistry([]);

const msteamsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "msteams", messageId: "m1" }),
  sendMedia: async () => ({ channel: "msteams", messageId: "m2" }),
};

const msteamsPlugin: ChannelPlugin = {
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Bot Framework; enterprise support.",
    aliases: ["teams"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  outbound: msteamsOutbound,
};

const registryWithMSTeams = createTestRegistry([
  { pluginId: "msteams", plugin: msteamsPlugin, source: "test" },
]);

describe("channel plugin loader", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("loads channel plugins from the active registry", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const plugin = await loadChannelPlugin("msteams");
    expect(plugin).toBe(msteamsPlugin);
  });

  it("loads outbound adapters from registered plugins", async () => {
    setActivePluginRegistry(registryWithMSTeams);
    const outbound = await loadChannelOutboundAdapter("msteams");
    expect(outbound).toBe(msteamsOutbound);
  });
});

describe("BaseProbeResult assignability", () => {
  it("TelegramProbe satisfies BaseProbeResult", () => {
    expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("DiscordProbe satisfies BaseProbeResult", () => {
    expectTypeOf<DiscordProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SlackProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("SignalProbe satisfies BaseProbeResult", () => {
    expectTypeOf<SignalProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("IMessageProbe satisfies BaseProbeResult", () => {
    expectTypeOf<IMessageProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("LineProbeResult satisfies BaseProbeResult", () => {
    expectTypeOf<LineProbeResult>().toMatchTypeOf<BaseProbeResult>();
  });
});

describe("BaseTokenResolution assignability", () => {
  it("TelegramTokenResolution satisfies BaseTokenResolution", () => {
    expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
  });

  it("DiscordTokenResolution satisfies BaseTokenResolution", () => {
    expectTypeOf<DiscordTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
  });
});

describe("resolveChannelConfigWrites", () => {
  it("defaults to allow when unset", () => {
    const cfg = {};
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(true);
  });

  it("blocks when channel config disables writes", () => {
    const cfg = { channels: { slack: { configWrites: false } } };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack" })).toBe(false);
  });

  it("account override wins over channel default", () => {
    const cfg = {
      channels: {
        slack: {
          configWrites: true,
          accounts: {
            work: { configWrites: false },
          },
        },
      },
    };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });

  it("matches account ids case-insensitively", () => {
    const cfg = {
      channels: {
        slack: {
          configWrites: true,
          accounts: {
            Work: { configWrites: false },
          },
        },
      },
    };
    expect(resolveChannelConfigWrites({ cfg, channelId: "slack", accountId: "work" })).toBe(false);
  });
});

// directory config-backed tests were removed (channels stripped in ZulipClaw fork)
