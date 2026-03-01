import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";
import { SUBAGENT_SPAWN_ACCEPTED_NOTE } from "./subagent-spawn.js";

const callGatewayMock = getCallGatewayMock();

type SpawnResult = { status?: string; note?: string };
type GatewayRequest = { method?: string };

function setupSessionsSpawnGatewayMock() {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as GatewayRequest;
    if (request.method === "sessions.patch") {
      return { ok: true };
    }
    if (request.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1001 };
    }
    if (request.method === "agent.wait") {
      return { status: "running" };
    }
    return {};
  });
}

describe("sessions_spawn: cron isolated session note suppression", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    resetSubagentRegistryForTests();
    resetSessionsSpawnConfigOverride();
  });

  it("suppresses ACCEPTED_NOTE for cron isolated sessions (mode=run)", async () => {
    setupSessionsSpawnGatewayMock();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:cron:dd871818:run:cf959c9f",
    });
    const result = await tool.execute("call-cron-run", { task: "test task", mode: "run" });
    const details = result.details as SpawnResult;
    expect(details.note).toBeUndefined();
    expect(details.status).toBe("accepted");
  });

  it("preserves ACCEPTED_NOTE for regular sessions (mode=run)", async () => {
    setupSessionsSpawnGatewayMock();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:telegram:63448508",
    });
    const result = await tool.execute("call-regular-run", { task: "test task", mode: "run" });
    const details = result.details as SpawnResult;
    expect(details.note).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
    expect(details.status).toBe("accepted");
  });

  it("does not suppress ACCEPTED_NOTE for non-canonical cron-like keys", async () => {
    setupSessionsSpawnGatewayMock();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:slack:cron:job:run:uuid",
    });
    const result = await tool.execute("call-cron-like-noncanonical", {
      task: "test task",
      mode: "run",
    });
    expect((result.details as SpawnResult).note).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });

  it("does not suppress note when agentSessionKey is undefined", async () => {
    setupSessionsSpawnGatewayMock();
    const tool = await getSessionsSpawnTool({
      agentSessionKey: undefined,
    });
    const result = await tool.execute("call-no-key", { task: "test task", mode: "run" });
    expect((result.details as SpawnResult).note).toBe(SUBAGENT_SPAWN_ACCEPTED_NOTE);
  });
});
