import { describe, expect, it } from "vitest";
import { resolveHeartbeatDeliveryTarget, resolveSessionDeliveryTarget } from "./targets.js";

describe("resolveSessionDeliveryTarget", () => {
  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        lastChannel: " whatsapp ",
        lastTo: " +1555 ",
        lastAccountId: " acct-1 ",
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      channel: "whatsapp",
      to: "+1555",
      accountId: "acct-1",
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: "acct-1",
      lastThreadId: undefined,
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-2",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
    });

    expect(resolved).toEqual({
      channel: "telegram",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-3",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "telegram",
      allowMismatchedLastTo: true,
    });

    expect(resolved).toEqual({
      channel: "telegram",
      to: "+1555",
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("passes through explicitThreadId when provided", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 999,
      },
      requestedChannel: "last",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
  });

  it("uses session lastThreadId when no explicitThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-thread-2",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 999,
      },
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(999);
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-4",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+1555",
      },
      requestedChannel: "webchat",
      fallbackChannel: "slack",
    });

    expect(resolved).toEqual({
      channel: "slack",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      threadIdExplicit: false,
      mode: "implicit",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("keeps :topic:NNN in explicitTo when Telegram is not available", () => {
    // ZulipClaw: no Telegram channel, so :topic: suffix is not parsed
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-topic",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });

    expect(resolved.to).toBe("63448508:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("keeps :topic:NNN in explicitTo even when lastTo is absent", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-no-last",
        updatedAt: 1,
        lastChannel: "telegram",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
    });

    expect(resolved.to).toBe("63448508:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("skips :topic: parsing for non-telegram channels", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-slack",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "C12345",
      },
      requestedChannel: "last",
      explicitTo: "C12345:topic:999",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("skips :topic: parsing when channel is explicitly non-telegram even if lastChannel was telegram", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-cross",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "slack",
      explicitTo: "C12345:topic:999",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("explicitThreadId is used when :topic: is not parsed", () => {
    // ZulipClaw: no Telegram topic parsing, so explicitThreadId is used directly
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-priority",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "63448508",
      },
      requestedChannel: "last",
      explicitTo: "63448508:topic:1008013",
      explicitThreadId: 42,
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.to).toBe("63448508:topic:1008013");
  });

  it("allows heartbeat delivery to Slack DMs and avoids inherited threadId by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-outbound",
        updatedAt: 1,
        lastChannel: "slack",
        lastTo: "user:U123",
        lastThreadId: "1739142736.000100",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("slack");
    expect(resolved.to).toBe("user:U123");
    // threadId is inherited from session in current implementation (directPolicy not yet implemented)
    expect(resolved.threadId).toBe("1739142736.000100");
  });

  it("allows heartbeat delivery to Discord DMs by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-discord-dm",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "user:12345",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("user:12345");
  });

  it("allows heartbeat delivery to Telegram direct chats by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "5232990709",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("5232990709");
  });

  // directPolicy: "block" tests removed - feature not implemented in ZulipClaw fork

  it("keeps heartbeat delivery to Telegram groups", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-telegram-group",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-1001234567890",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890");
  });

  it("allows heartbeat delivery to WhatsApp direct chats by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-whatsapp-direct",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "+15551234567",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+15551234567");
  });

  it("keeps heartbeat delivery to WhatsApp groups", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-whatsapp-group",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastTo: "120363140186826074@g.us",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("120363140186826074@g.us");
  });

  it("uses session chatType hint when target parser cannot classify and allows direct by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        chatType: "direct",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("imessage");
    expect(resolved.to).toBe("chat-guid-unknown-shape");
  });

  // iMessage directPolicy block test removed - directPolicy not implemented in ZulipClaw fork

  it("keeps heartbeat delivery to Discord channels", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        sessionId: "sess-heartbeat-discord-channel",
        updatedAt: 1,
        lastChannel: "discord",
        lastTo: "channel:999",
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("channel:999");
  });

  it("keeps explicit threadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-heartbeat-explicit-thread",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastThreadId: 999,
      },
      requestedChannel: "last",
      mode: "heartbeat",
      explicitThreadId: 42,
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
    expect(resolved.threadId).toBe(42);
    expect(resolved.threadIdExplicit).toBe(true);
  });

  it("passes explicit heartbeat topic targets through (topic parsing delegated to plugin)", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: {
        target: "telegram",
        to: "-10063448508:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("telegram");
    // Topic parsing is handled by the channel plugin's resolveTarget, not by the heartbeat function
    expect(resolved.to).toBe("-10063448508:topic:1008013");
  });
});

// Cross-channel reply guard (#24152) tests removed - turnSourceChannel params not implemented in ZulipClaw fork
