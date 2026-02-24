import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

type GatewayCall = { method?: string; params?: Record<string, unknown> };
const callGatewayMock = getCallGatewayMock();

function setupBasicSpawnMock(calls: GatewayCall[]) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as GatewayCall;
    calls.push(request);
    if (request.method === "agent") {
      return { runId: "run-prompt", status: "accepted" };
    }
    if (request.method === "sessions.patch") {
      return { ok: true };
    }
    return {};
  });
}

function getAgentMessage(calls: GatewayCall[]): string {
  const agentCall = calls.find((call) => call.method === "agent");
  const message = agentCall?.params?.message;
  return typeof message === "string" ? message : "";
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("sessions_spawn mandatory task prompt blocks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSessionsSpawnConfigOverride();
    callGatewayMock.mockReset();
  });

  it("injects model/reply-routing/progress blocks when missing", async () => {
    const calls: GatewayCall[] = [];
    setupBasicSpawnMock(calls);

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:zulip:channel:marcel:topic:change%20model%20list",
      agentChannel: "zulip",
      agentTo: "stream:marcel#change model list",
    });

    await tool.execute("call-inject-missing", {
      task: "Implement the requested code changes.",
    });

    const message = getAgentMessage(calls);
    expect(message).toContain("## Model Selection (MANDATORY)");
    expect(message).toContain("## Reply Routing (MANDATORY)");
    expect(message).toContain("## Progress Updates (MANDATORY)");
    expect(message).toContain(
      'message(action="send", channel="zulip", target="stream:marcel#change model list", message="...")',
    );
  });

  it("does not duplicate mandatory blocks when already present", async () => {
    const calls: GatewayCall[] = [];
    setupBasicSpawnMock(calls);

    const existingTask = [
      "Do the thing.",
      "",
      "## Model Selection (MANDATORY)",
      "existing model block",
      "",
      "## Reply Routing (MANDATORY)",
      "existing routing block",
      "",
      "## Progress Updates (MANDATORY)",
      "existing progress block",
    ].join("\n");

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:zulip:channel:marcel:topic:change%20model%20list",
      agentChannel: "zulip",
      agentTo: "stream:marcel#change model list",
    });

    await tool.execute("call-inject-no-dup", {
      task: existingTask,
    });

    const message = getAgentMessage(calls);
    expect(countOccurrences(message, "## Model Selection (MANDATORY)")).toBe(1);
    expect(countOccurrences(message, "## Reply Routing (MANDATORY)")).toBe(1);
    expect(countOccurrences(message, "## Progress Updates (MANDATORY)")).toBe(1);
  });

  it("formats reply routing target with stream#topic for Zulip topic routes", async () => {
    const calls: GatewayCall[] = [];
    setupBasicSpawnMock(calls);

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:zulip:channel:marcel-ai:topic:deploy-notes",
      agentChannel: "zulip",
      agentTo: "zulip:stream:marcel-ai#deploy notes",
    });

    await tool.execute("call-topic-format", {
      task: "Ship changes.",
    });

    const message = getAgentMessage(calls);
    expect(message).toContain("Origin topic: deploy notes");
    expect(message).toContain(
      'message(action="send", channel="zulip", target="stream:marcel-ai#deploy notes", message="...")',
    );
    expect(message).not.toContain('target="stream:marcel-ai"');
  });

  it("keeps non-Zulip channels backward-compatible (no reply-routing injection)", async () => {
    const calls: GatewayCall[] = [];
    setupBasicSpawnMock(calls);

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:discord:channel:dev",
      agentChannel: "discord",
      agentTo: "channel:dev",
    });

    await tool.execute("call-non-zulip", {
      task: "Summarize findings.",
    });

    const message = getAgentMessage(calls);
    expect(message).toContain("## Model Selection (MANDATORY)");
    expect(message).toContain("## Progress Updates (MANDATORY)");
    expect(message).not.toContain("## Reply Routing (MANDATORY)");
  });
});
