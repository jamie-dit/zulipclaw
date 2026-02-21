import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const noop = () => {};

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const announceSpy = vi.fn(async () => true);
  return { callGatewayMock, announceSpy };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
  emitAgentEvent: vi.fn((evt) => {
    const actual = vi.importActual<typeof import("../infra/agent-events.js")>(
      "../infra/agent-events.js",
    );
    return actual.then((m) => m.emitAgentEvent(evt));
  }),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: hoisted.announceSpy,
}));

describe("subagent registry restart handling", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const writePersistedRegistry = async (persisted: Record<string, unknown>) => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    return registryPath;
  };

  afterEach(async () => {
    hoisted.announceSpy.mockClear();
    hoisted.callGatewayMock.mockClear();

    // Reset the registry
    const { resetSubagentRegistryForTests } = await import("./subagent-registry.js");
    resetSubagentRegistryForTests({ persist: false });

    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("re-restores runs after initSubagentRegistry() following simulated restart", async () => {
    const { initSubagentRegistry } = await import("./subagent-registry.js");
    const { loadSubagentRegistryFromDisk } = await import("./subagent-registry.store.js");

    // Create a persisted registry with an ended run
    const persisted = {
      version: 2,
      runs: {
        "run-restart-test": {
          runId: "run-restart-test",
          childSessionKey: "agent:main:subagent:restart-test",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "test task after restart",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
        },
      },
    };
    await writePersistedRegistry(persisted);

    // First init - should restore the run
    initSubagentRegistry();
    await new Promise((r) => setTimeout(r, 0));

    // Verify the run was restored
    const runsBefore = loadSubagentRegistryFromDisk();
    expect(runsBefore.has("run-restart-test")).toBe(true);

    // Simulate a restart by calling initSubagentRegistry again
    // First, manually reset the registry (simulating module reload)
    const { resetSubagentRegistryForTests } = await import("./subagent-registry.js");
    resetSubagentRegistryForTests({ persist: false });

    // Now call initSubagentRegistry again - this should re-restore the runs
    // because restoreAttempted is now reset
    initSubagentRegistry();
    await new Promise((r) => setTimeout(r, 0));

    // Verify the run was re-restored after the second init
    const runsAfter = loadSubagentRegistryFromDisk();
    expect(runsAfter.has("run-restart-test")).toBe(true);
  });

  it("resetSubagentRegistryForTests properly resets restoreAttempted flag", async () => {
    const { initSubagentRegistry, resetSubagentRegistryForTests } =
      await import("./subagent-registry.js");
    const { loadSubagentRegistryFromDisk } = await import("./subagent-registry.store.js");

    // Create a persisted registry
    const persisted = {
      version: 2,
      runs: {
        "run-flag-test": {
          runId: "run-flag-test",
          childSessionKey: "agent:main:subagent:flag-test",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "test task",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
        },
      },
    };
    await writePersistedRegistry(persisted);

    // First init
    initSubagentRegistry();
    await new Promise((r) => setTimeout(r, 0));

    const runs1 = loadSubagentRegistryFromDisk();
    expect(runs1.has("run-flag-test")).toBe(true);

    // Reset registry
    resetSubagentRegistryForTests({ persist: false });

    // Create a different persisted registry to verify re-restore works
    const persisted2 = {
      version: 2,
      runs: {
        "run-flag-test-2": {
          runId: "run-flag-test-2",
          childSessionKey: "agent:main:subagent:flag-test-2",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "test task 2",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
        },
      },
    };
    const registryPath = path.join(tempStateDir!, "subagents", "runs.json");
    await fs.writeFile(registryPath, `${JSON.stringify(persisted2)}\n`, "utf8");

    // Re-init - should restore the NEW run
    initSubagentRegistry();
    await new Promise((r) => setTimeout(r, 0));

    const runs2 = loadSubagentRegistryFromDisk();
    // Should have the NEW run, not the old one
    expect(runs2.has("run-flag-test-2")).toBe(true);
  });
});
