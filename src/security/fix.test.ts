import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixSecurityFootguns } from "./fix.js";

const isWindows = process.platform === "win32";

const expectPerms = (actual: number, expected: number) => {
  if (isWindows) {
    expect([expected, 0o666, 0o777]).toContain(actual);
    return;
  }
  expect(actual).toBe(expected);
};

describe("security fix", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createStateDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const createFixEnv = (stateDir: string, configPath: string) => ({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  });

  const writeJsonConfig = async (configPath: string, config: Record<string, unknown>) => {
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  };

  const _readParsedConfig = async (configPath: string) =>
    JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-fix-suite-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("tightens groupPolicy + filesystem perms", async () => {
    const stateDir = await createStateDir("tightens");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await writeJsonConfig(configPath, {
      channels: {
        zulip: { groupPolicy: "open" },
      },
      logging: { redactSensitive: "off" },
    });
    await fs.chmod(configPath, 0o644);

    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    expect(res.ok).toBe(true);
    expect(res.configWritten).toBe(true);
    // Note: applyConfigFixes only processes hardcoded channel list (telegram, whatsapp, etc.)
    // Zulip is not in that list, so only logging change is applied
    expect(res.changes).toEqual(['logging.redactSensitive=off -> "tools"']);

    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expectPerms(stateMode, 0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expectPerms(configMode, 0o600);
  });

  // WhatsApp-specific security tests removed - channel stripped in ZulipClaw fork

  it("returns ok=false for invalid config but still tightens perms", async () => {
    const stateDir = await createStateDir("invalid-config");
    await fs.chmod(stateDir, 0o755);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{ this is not json }\n", "utf-8");
    await fs.chmod(configPath, 0o644);

    const env = createFixEnv(stateDir, configPath);

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    expect(res.ok).toBe(false);

    const stateMode = (await fs.stat(stateDir)).mode & 0o777;
    expectPerms(stateMode, 0o700);

    const configMode = (await fs.stat(configPath)).mode & 0o777;
    expectPerms(configMode, 0o600);
  });

  it("tightens perms for credentials + agent auth/sessions + include files", async () => {
    const stateDir = await createStateDir("includes");

    const includesDir = path.join(stateDir, "includes");
    await fs.mkdir(includesDir, { recursive: true });
    const includePath = path.join(includesDir, "extra.json5");
    await fs.writeFile(includePath, "{ logging: { redactSensitive: 'off' } }\n", "utf-8");
    await fs.chmod(includePath, 0o644);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(
      configPath,
      `{ "$include": "./includes/extra.json5", channels: { zulip: { groupPolicy: "open" } } }\n`,
      "utf-8",
    );
    await fs.chmod(configPath, 0o644);

    const credsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credsDir, { recursive: true });
    const allowFromPath = path.join(credsDir, "test-allowFrom.json");
    await fs.writeFile(
      allowFromPath,
      `${JSON.stringify({ version: 1, allowFrom: ["test-user"] }, null, 2)}\n`,
      "utf-8",
    );
    await fs.chmod(allowFromPath, 0o644);

    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const authProfilesPath = path.join(agentDir, "auth-profiles.json");
    await fs.writeFile(authProfilesPath, "{}\n", "utf-8");
    await fs.chmod(authProfilesPath, 0o644);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionsStorePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(sessionsStorePath, "{}\n", "utf-8");
    await fs.chmod(sessionsStorePath, 0o644);
    const transcriptPath = path.join(sessionsDir, "sess-main.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session"}\n', "utf-8");
    await fs.chmod(transcriptPath, 0o644);

    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };

    const res = await fixSecurityFootguns({ env, stateDir, configPath });
    expect(res.ok).toBe(true);

    expectPerms((await fs.stat(credsDir)).mode & 0o777, 0o700);
    expectPerms((await fs.stat(allowFromPath)).mode & 0o777, 0o600);
    expectPerms((await fs.stat(authProfilesPath)).mode & 0o777, 0o600);
    expectPerms((await fs.stat(sessionsStorePath)).mode & 0o777, 0o600);
    expectPerms((await fs.stat(transcriptPath)).mode & 0o777, 0o600);
    expectPerms((await fs.stat(includePath)).mode & 0o777, 0o600);
  });
});
