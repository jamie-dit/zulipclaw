import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { SandboxDockerConfig } from "./sandbox.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const sandboxFsBridgeStub: SandboxFsBridge = {
  resolvePath: () => ({
    hostPath: "/tmp/sandbox",
    relativePath: "",
    containerPath: "/workspace",
  }),
  readFile: async () => Buffer.from(""),
  writeFile: async () => {},
  mkdirp: async () => {},
  remove: async () => {},
  rename: async () => {},
  stat: async () => null,
};

const sandboxPolicy = {
  allow: ["exec", "process", "read", "image"],
  deny: ["browser"],
};

function createSandbox(sessionKey: string) {
  return {
    enabled: true,
    sessionKey,
    workspaceDir: "/tmp/sandbox-web-research",
    agentWorkspaceDir: "/tmp/test-web-research",
    workspaceAccess: "ro" as const,
    containerName: "test-container-web-research",
    containerWorkdir: "/workspace",
    docker: {
      image: "test-image",
      containerPrefix: "test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: [],
      network: "none",
      capDrop: [],
    } satisfies SandboxDockerConfig,
    tools: sandboxPolicy,
    fsBridge: sandboxFsBridgeStub,
    browserAllowHostControl: false,
  };
}

describe("createOpenClawCodingTools web_research sandbox group policy", () => {
  it("keeps web_search/web_fetch for internal web_research group", () => {
    const cfg = {} as OpenClawConfig;
    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:subagent:web-research",
      groupId: "__openclaw_web_research__",
      workspaceDir: "/tmp/test-web-research",
      agentDir: "/tmp/agent-web-research",
      sandbox: createSandbox("agent:main:subagent:web-research"),
    });

    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("web_search")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("image")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("process")).toBe(false);
    expect(names.has("browser")).toBe(false);
    expect(names.has("message")).toBe(false);
  });

  it("keeps browser for internal browser web_research group", () => {
    const cfg = {} as OpenClawConfig;
    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:subagent:web-research-browser",
      groupId: "__openclaw_web_research_browser__",
      workspaceDir: "/tmp/test-web-research-browser",
      agentDir: "/tmp/agent-web-research-browser",
      sandbox: createSandbox("agent:main:subagent:web-research-browser"),
    });

    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("browser")).toBe(true);
    expect(names.has("web_search")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("image")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("process")).toBe(false);
    expect(names.has("message")).toBe(false);
  });
});
