import { describe, expect, it, vi } from "vitest";
import { buildZulipUserAgent, zulipRequest } from "./client.js";

describe("buildZulipUserAgent", () => {
  it("formats the version as OpenClaw-Zulip/<version>", () => {
    expect(buildZulipUserAgent("2026.2.18")).toBe("OpenClaw-Zulip/2026.2.18");
  });

  it("works with unknown version", () => {
    expect(buildZulipUserAgent("unknown")).toBe("OpenClaw-Zulip/unknown");
  });
});

describe("zulipRequest", () => {
  it("includes User-Agent header when auth.userAgent is set", async () => {
    const captured: Record<string, string> = {};
    const mockFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        captured[key] = value;
      });
      return new Response(JSON.stringify({ result: "success" }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    await zulipRequest({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "secret",
        userAgent: "OpenClaw-Zulip/2026.2.18",
      },
      method: "GET",
      path: "/api/v1/users/me",
    });

    expect(captured["user-agent"]).toBe("OpenClaw-Zulip/2026.2.18");
    vi.unstubAllGlobals();
  });

  it("omits User-Agent header when auth.userAgent is not set", async () => {
    const captured: Record<string, string> = {};
    const mockFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.forEach((value, key) => {
        captured[key] = value;
      });
      return new Response(JSON.stringify({ result: "success" }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    await zulipRequest({
      auth: {
        baseUrl: "https://zulip.example.com",
        email: "bot@example.com",
        apiKey: "secret",
      },
      method: "GET",
      path: "/api/v1/users/me",
    });

    expect(captured["user-agent"]).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
