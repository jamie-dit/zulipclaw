import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import { zulipPlugin } from "./channel.js";
import { resolveZulipAccount } from "./zulip/accounts.js";
import { normalizeEmojiName } from "./zulip/normalize.js";
import { parseZulipTarget } from "./zulip/targets.js";

describe("zulipPlugin", () => {
  it("normalizes emoji names", () => {
    expect(normalizeEmojiName(":eyes:")).toBe("eyes");
    expect(normalizeEmojiName("check")).toBe("check");
  });

  it("parses stream targets with optional topics", () => {
    expect(parseZulipTarget("stream:marcel-ai")).toEqual({ kind: "stream", stream: "marcel-ai" });
    expect(parseZulipTarget("zulip:stream:marcel-ai#deploy")).toEqual({
      kind: "stream",
      stream: "marcel-ai",
      topic: "deploy",
    });
  });

  it("applies defaultTopic when target omits topic", () => {
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
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    const res = zulipPlugin.outbound?.resolveTarget?.({
      cfg,
      to: "stream:marcel-ai",
      accountId: account.accountId,
      mode: "explicit",
    });
    expect(res?.ok).toBe(true);
    if (res && res.ok) {
      expect(res.to).toBe("stream:marcel-ai#general chat");
    }
  });

  it("defaults to alwaysReply (no mention requirement)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const requireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "marcel-ai",
    });
    expect(requireMention).toBe(false);
  });

  it("defaults to clearing the onStart reaction", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.clearOnFinish).toBe(true);
  });

  it("can leave the onStart reaction when clearOnFinish=false", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          reactions: {
            clearOnFinish: false,
          },
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.clearOnFinish).toBe(false);
  });

  it("enables workflow reactions by default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
        },
      },
    };
    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.workflow.enabled).toBe(true);
    expect(account.reactions.workflow.stages.queued).toBe(account.reactions.onStart);
    expect(account.reactions.workflow.stages.success).toBe(account.reactions.onSuccess);
    expect(account.reactions.workflow.stages.failure).toBe(account.reactions.onFailure);
  });

  it("supports opt-in workflow reactions with stage overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          reactions: {
            onStart: "eyes",
            onSuccess: "check",
            onFailure: "warning",
            workflow: {
              enabled: true,
              replaceStageReaction: false,
              minTransitionMs: 0,
              stages: {
                queued: "hourglass",
                toolRunning: "hammer",
                partialSuccess: "construction",
              },
            },
          },
        },
      },
    };

    const account = resolveZulipAccount({ cfg, accountId: "default" });
    expect(account.reactions.workflow.enabled).toBe(true);
    expect(account.reactions.workflow.replaceStageReaction).toBe(false);
    expect(account.reactions.workflow.minTransitionMs).toBe(0);
    expect(account.reactions.workflow.stages.queued).toBe("hourglass");
    expect(account.reactions.workflow.stages.processing).toBe("eyes");
    expect(account.reactions.workflow.stages.toolRunning).toBe("hammer");
    expect(account.reactions.workflow.stages.partialSuccess).toBe("construction");
    expect(account.reactions.workflow.stages.failure).toBe("warning");
  });

  it("can require mentions when alwaysReply=false", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-ai"],
          alwaysReply: false,
        },
      },
    };
    const requireMention = zulipPlugin.groups?.resolveRequireMention?.({
      cfg,
      groupId: "marcel-ai",
    });
    expect(requireMention).toBe(true);
  });

  describe("resolveTarget — stream name canonicalization (hallucination guard)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zulip: {
          enabled: true,
          baseUrl: "https://zulip.example.com",
          email: "bot@example.com",
          apiKey: "key",
          streams: ["marcel-dreamit"],
          defaultTopic: "general chat",
        },
      },
    };

    it("accepts a correctly-spelled stream name unchanged", () => {
      const res = zulipPlugin.outbound?.resolveTarget?.({
        cfg,
        to: "stream:marcel-dreamit#dream mta",
        accountId: "default",
        mode: "explicit",
      });
      expect(res?.ok).toBe(true);
      if (res && res.ok) {
        expect(res.to).toBe("stream:marcel-dreamit#dream mta");
      }
    });

    it("corrects a 1-char hallucination (marvel → marcel) when stream is in streams allowlist", () => {
      const res = zulipPlugin.outbound?.resolveTarget?.({
        cfg,
        to: "stream:marvel-dreamit#dream mta",
        accountId: "default",
        mode: "explicit",
      });
      expect(res?.ok).toBe(true);
      if (res && res.ok) {
        // Should be corrected to the configured stream name
        expect(res.to).toBe("stream:marcel-dreamit#dream mta");
      }
    });

    it("passes through an unknown stream when no close match exists", () => {
      const res = zulipPlugin.outbound?.resolveTarget?.({
        cfg,
        to: "stream:totally-unrelated-stream#some-topic",
        accountId: "default",
        mode: "explicit",
      });
      expect(res?.ok).toBe(true);
      if (res && res.ok) {
        // No close match — stream should pass through as-is
        expect(res.to).toBe("stream:totally-unrelated-stream#some-topic");
      }
    });

    it("does not canonicalize when streams list is empty", () => {
      const cfgNoStreams: OpenClawConfig = {
        channels: {
          zulip: {
            enabled: true,
            baseUrl: "https://zulip.example.com",
            email: "bot@example.com",
            apiKey: "key",
          },
        },
      };
      const res = zulipPlugin.outbound?.resolveTarget?.({
        cfg: cfgNoStreams,
        to: "stream:marvel-dreamit#dream mta",
        accountId: "default",
        mode: "explicit",
      });
      expect(res?.ok).toBe(true);
      if (res && res.ok) {
        // No streams allowlist — pass through uncorrected
        expect(res.to).toBe("stream:marvel-dreamit#dream mta");
      }
    });
  });
});
