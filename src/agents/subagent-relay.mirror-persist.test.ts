import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks (must be declared before imports that use them)
// ---------------------------------------------------------------------------

const dispatchSpy = vi.fn(async () => ({
  ok: true,
  details: { messageId: "mirror-msg-42" },
}));

vi.mock("../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) => dispatchSpy(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ status: "timeout" })),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => () => undefined),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------

import { writeJsonFileAtomically } from "../plugin-sdk/json-store.js";
import {
  recoverMirrorState,
  resolveMirrorStatePath,
  type PersistedMirrorEntry,
} from "./subagent-relay.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<PersistedMirrorEntry>): PersistedMirrorEntry {
  return {
    mirrorMessageId: "msg-1234",
    label: "test-agent",
    originTopic: "dev-ops",
    mirrorTopic: "stream:marcel#sub-agents",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subagent-relay mirror persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-relay-mirror-test-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    dispatchSpy.mockClear();
  });

  afterEach(async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveMirrorStatePath", () => {
    it("places file under <stateDir>/relay/mirror-state.json", () => {
      const p = resolveMirrorStatePath();
      expect(p).toBe(path.join(tempDir, "relay", "mirror-state.json"));
    });
  });

  describe("recoverMirrorState", () => {
    it("does nothing when no state file exists", async () => {
      await recoverMirrorState();
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it("edits dead-run mirror messages to stale status", async () => {
      // Write a persisted entry for a dead run
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, {
        version: 1,
        entries: {
          "run-dead-001": makeEntry({ mirrorMessageId: "msg-dead-001", label: "dead-agent" }),
        },
      });

      // callGateway mock returns { status: "timeout" } → treated as dead
      await recoverMirrorState();

      expect(dispatchSpy).toHaveBeenCalledOnce();
      const call = dispatchSpy.mock.calls[0]?.[0] as {
        action: string;
        params: { messageId: string; message: string };
      };
      expect(call.action).toBe("edit");
      expect(call.params.messageId).toBe("msg-dead-001");
      expect(call.params.message).toContain("❌");
      expect(call.params.message).toContain("dead-agent");
      expect(call.params.message).toContain("gateway restarted");
    });

    it("removes dead-run entries from persisted state file after recovery", async () => {
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, {
        version: 1,
        entries: {
          "run-dead-002": makeEntry({ mirrorMessageId: "msg-dead-002" }),
        },
      });

      await recoverMirrorState();

      // State file should have been cleaned up (entries empty)
      const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
        version: number;
        entries: Record<string, unknown>;
      };
      expect(raw.version).toBe(1);
      expect(Object.keys(raw.entries)).toHaveLength(0);
    });

    it("includes originTopic suffix in stale message when present", async () => {
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, {
        version: 1,
        entries: {
          "run-dead-003": makeEntry({
            mirrorMessageId: "msg-dead-003",
            originTopic: "zulipclaw: sub-agent topic",
          }),
        },
      });

      await recoverMirrorState();

      const call = dispatchSpy.mock.calls[0]?.[0] as { params: { message: string } };
      expect(call.params.message).toContain("📍 zulipclaw: sub-agent topic");
    });

    it("omits originTopic suffix when entry has no originTopic", async () => {
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, {
        version: 1,
        entries: {
          "run-dead-004": makeEntry({ mirrorMessageId: "msg-dead-004", originTopic: undefined }),
        },
      });

      await recoverMirrorState();

      const call = dispatchSpy.mock.calls[0]?.[0] as { params: { message: string } };
      expect(call.params.message).not.toContain("📍");
    });

    it("is best-effort: still cleans up state even if edit dispatch throws", async () => {
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, {
        version: 1,
        entries: {
          "run-dead-005": makeEntry({ mirrorMessageId: "msg-fail" }),
        },
      });

      dispatchSpy.mockRejectedValueOnce(new Error("Zulip unavailable"));

      // Should not throw
      await expect(recoverMirrorState()).resolves.not.toThrow();

      // State file should still be cleaned up
      const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
        entries: Record<string, unknown>;
      };
      expect(Object.keys(raw.entries)).toHaveLength(0);
    });

    it("handles invalid/missing state file gracefully", async () => {
      // Write garbage
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "not valid json", "utf-8");

      await expect(recoverMirrorState()).resolves.not.toThrow();
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it("handles version mismatch gracefully (future-proofing)", async () => {
      const filePath = path.join(tempDir, "relay", "mirror-state.json");
      await writeJsonFileAtomically(filePath, { version: 99, entries: {} });

      await expect(recoverMirrorState()).resolves.not.toThrow();
      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });
});
