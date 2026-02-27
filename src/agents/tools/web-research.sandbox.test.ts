import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import { __testing, createWebResearchTool } from "./web-research.js";

vi.mock("../subagent-spawn.js", () => ({
  spawnSubagentDirect: vi.fn(),
}));

const mockSpawnSubagentDirect = vi.mocked(spawnSubagentDirect);

describe("web_research sandbox config", () => {
  describe("resolveWebResearchSandboxConfig", () => {
    it("defaults to forceSandbox=true, networkRestrictions=true, workspaceAccess=ro", () => {
      const config = __testing.resolveWebResearchSandboxConfig(undefined);
      expect(config).toEqual({
        forceSandbox: true,
        networkRestrictions: true,
        workspaceAccess: "ro",
      });
    });

    it("defaults to forceSandbox=true when sandbox section is empty", () => {
      const config = __testing.resolveWebResearchSandboxConfig({ sandbox: {} });
      expect(config.forceSandbox).toBe(true);
      expect(config.networkRestrictions).toBe(true);
      expect(config.workspaceAccess).toBe("ro");
    });

    it("respects sandbox.enabled=false", () => {
      const config = __testing.resolveWebResearchSandboxConfig({
        sandbox: { enabled: false },
      });
      expect(config.forceSandbox).toBe(false);
    });

    it("respects sandbox.networkRestrictions=false", () => {
      const config = __testing.resolveWebResearchSandboxConfig({
        sandbox: { networkRestrictions: false },
      });
      expect(config.networkRestrictions).toBe(false);
    });

    it("respects sandbox.workspaceAccess=none", () => {
      const config = __testing.resolveWebResearchSandboxConfig({
        sandbox: { workspaceAccess: "none" },
      });
      expect(config.workspaceAccess).toBe("none");
    });
  });

  describe("createWebResearchTool sandbox params", () => {
    beforeEach(() => {
      mockSpawnSubagentDirect.mockReset();
      mockSpawnSubagentDirect.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:test",
        runId: "run-test",
        note: "queued",
      });
    });

    it("passes default sandbox params to spawnSubagentDirect", async () => {
      const tool = createWebResearchTool({
        config: {},
        agentSessionKey: "agent:main:main",
      });

      await tool?.execute?.("call-1", { query: "test query" });

      expect(mockSpawnSubagentDirect).toHaveBeenCalledTimes(1);
      const [spawnParams] = mockSpawnSubagentDirect.mock.calls[0];
      expect(spawnParams.forceSandbox).toBe(true);
      expect(spawnParams.sandboxWorkspaceAccess).toBe("ro");
      expect(spawnParams.sandboxNetworkRestrictions).toBe(true);
    });

    it("passes configured sandbox params to spawnSubagentDirect", async () => {
      const tool = createWebResearchTool({
        config: {
          tools: {
            webResearch: {
              sandbox: {
                enabled: false,
                networkRestrictions: false,
                workspaceAccess: "none",
              },
            },
          },
        },
        agentSessionKey: "agent:main:main",
      });

      await tool?.execute?.("call-1", { query: "test query" });

      const [spawnParams] = mockSpawnSubagentDirect.mock.calls[0];
      expect(spawnParams.forceSandbox).toBe(false);
      expect(spawnParams.sandboxWorkspaceAccess).toBe("none");
      expect(spawnParams.sandboxNetworkRestrictions).toBe(false);
    });
  });
});
