import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { ensureAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

describe("OAuth without refresh token", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tmpDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-no-refresh-test-"));
    agentDir = path.join(tmpDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });

    // Set environment variables
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    envSnapshot.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns expired token for Anthropic OAuth without refresh token", async () => {
    const profileId = "anthropic:test";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago

    // Write expired credentials without refresh token
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "sk-ant-oat-test-token",
          refresh: "", // Empty refresh token
          expires: expiredTime,
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store),
    );

    const loadedStore = ensureAuthProfileStore(agentDir);

    const result = await resolveApiKeyForProfile({
      store: loadedStore,
      profileId,
      agentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("sk-ant-oat-test-token");
    expect(result?.provider).toBe("anthropic");
  });

  it("returns expired token for any OAuth provider without refresh token", async () => {
    const profileId = "google-gemini-cli:test";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000;

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "some-access-token",
          refresh: "", // Empty refresh token
          expires: expiredTime,
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store),
    );

    const loadedStore = ensureAuthProfileStore(agentDir);

    const result = await resolveApiKeyForProfile({
      store: loadedStore,
      profileId,
      agentDir,
    });

    expect(result).not.toBeNull();
    // google-gemini-cli provider wraps token in JSON with projectId
    expect(result?.apiKey).toBe('{"token":"some-access-token"}');
    expect(result?.provider).toBe("google-gemini-cli");
  });

  it("returns null when refresh token exists but is invalid/expired", async () => {
    const profileId = "anthropic:test-with-refresh";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000;

    // Write expired credentials with a refresh token
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "expired-access-token",
          refresh: "some-refresh-token", // Has refresh token
          expires: expiredTime,
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store),
    );

    // Mock fetch to simulate OAuth refresh failure
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const loadedStore = ensureAuthProfileStore(agentDir);

    // Should throw because refresh is attempted and fails
    await expect(
      resolveApiKeyForProfile({
        store: loadedStore,
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed/);
  });
});
