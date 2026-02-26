import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { __testing, createWebResearchTool } from "./web-research.js";

vi.mock("../subagent-spawn.js", () => ({
  spawnSubagentDirect: vi.fn(),
}));

const mockSpawnSubagentDirect = vi.mocked(spawnSubagentDirect);

describe("web_research tool", () => {
  beforeEach(() => {
    mockSpawnSubagentDirect.mockReset();
    mockSpawnSubagentDirect.mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:test",
      runId: "run-test",
      note: "queued",
    });
  });

  it("spawns quick research with fast model and maxIterations=5", async () => {
    const tool = createWebResearchTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "zulip",
      agentTo: "stream:marcel-zulipclaw#secure web browsing",
    });

    expect(tool).not.toBeNull();

    const result = await tool?.execute?.("call-1", {
      query: "latest Anthropic model updates",
      depth: "quick",
    });

    expect(mockSpawnSubagentDirect).toHaveBeenCalledTimes(1);
    const [spawnParams, spawnCtx] = mockSpawnSubagentDirect.mock.calls[0];

    expect(spawnParams.maxIterations).toBe(5);
    expect(spawnParams.model).toBe(__testing.QUICK_RESEARCH_MODEL);
    expect(spawnParams.expectsCompletionMessage).toBe(true);
    expect(spawnCtx.agentGroupId).toBe(__testing.WEB_RESEARCH_GROUP_ID);

    expect(result?.details).toMatchObject({
      status: "accepted",
      requested: {
        depth: "quick",
        maxIterations: 5,
        browser: false,
      },
    });
  });

  it("enables browser by default for deep research", async () => {
    const tool = createWebResearchTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "zulip",
      agentTo: "stream:marcel-zulipclaw#secure web browsing",
    });

    await tool?.execute?.("call-2", {
      query: "investigate JavaScript-heavy pricing pages",
      depth: "deep",
    });

    expect(mockSpawnSubagentDirect).toHaveBeenCalledTimes(1);
    const [spawnParams, spawnCtx] = mockSpawnSubagentDirect.mock.calls[0];
    expect(spawnParams.maxIterations).toBe(25);
    expect(spawnCtx.agentGroupId).toBe(__testing.WEB_RESEARCH_BROWSER_GROUP_ID);

    const taskPrompt = String(spawnParams.task ?? "");
    expect(taskPrompt).toContain("## Reply Routing (MANDATORY)");
    expect(taskPrompt).toContain("## Progress Updates (MANDATORY)");
  });

  it("rejects invalid depth values", async () => {
    const tool = createWebResearchTool();
    await expect(
      tool?.execute?.("call-3", {
        query: "test",
        depth: "invalid",
      }),
    ).rejects.toThrow('depth must be one of: "quick", "standard", "deep"');
  });
});
