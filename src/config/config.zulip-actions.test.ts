import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config zulip action gates", () => {
  it("accepts top-level zulip action flags", () => {
    const res = validateConfigObject({
      channels: {
        zulip: {
          actions: {
            channelCreate: true,
            channelEdit: false,
            channelDelete: false,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts per-account zulip action flags", () => {
    const res = validateConfigObject({
      channels: {
        zulip: {
          accounts: {
            ops: {
              baseUrl: "https://zulip.example.com",
              email: "ops@example.com",
              apiKey: "secret",
              actions: {
                channelCreate: true,
                channelEdit: true,
                channelDelete: false,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
