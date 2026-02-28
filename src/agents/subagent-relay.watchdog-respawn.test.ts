import { describe, expect, it } from "vitest";
import {
  countRespawnsInLabel,
  buildRespawnedLabel,
  renderRelayMessage,
  type RelayState,
} from "./subagent-relay.js";

// ---------------------------------------------------------------------------
// Pure-function tests (no mocking needed)
// ---------------------------------------------------------------------------

describe("countRespawnsInLabel", () => {
  it("returns 0 for a label with no respawn suffix", () => {
    expect(countRespawnsInLabel("my-task")).toBe(0);
  });

  it("returns 0 for an empty string", () => {
    expect(countRespawnsInLabel("")).toBe(0);
  });

  it("returns 1 for a label ending with -respawned", () => {
    expect(countRespawnsInLabel("my-task-respawned")).toBe(1);
  });

  it("returns 2 for a label ending with -respawned-2", () => {
    expect(countRespawnsInLabel("my-task-respawned-2")).toBe(2);
  });

  it("returns 3 for a label ending with -respawned-3", () => {
    expect(countRespawnsInLabel("my-task-respawned-3")).toBe(3);
  });

  it("only matches the suffix, not mid-label occurrences", () => {
    // "respawned-task" does not end with "-respawned"
    expect(countRespawnsInLabel("respawned-task")).toBe(0);
  });

  it("handles label that is exactly -respawned", () => {
    expect(countRespawnsInLabel("-respawned")).toBe(1);
  });
});

describe("buildRespawnedLabel", () => {
  it("appends -respawned to a fresh label", () => {
    expect(buildRespawnedLabel("my-task")).toBe("my-task-respawned");
  });

  it("appends -respawned-2 to a label already ending with -respawned", () => {
    expect(buildRespawnedLabel("my-task-respawned")).toBe("my-task-respawned-2");
  });

  it("increments to -respawned-3 from -respawned-2", () => {
    expect(buildRespawnedLabel("my-task-respawned-2")).toBe("my-task-respawned-3");
  });

  it("handles empty string base", () => {
    expect(buildRespawnedLabel("")).toBe("-respawned");
  });
});

describe("renderRelayMessage with respawnedAs", () => {
  function makeRelayState(overrides: Partial<RelayState> = {}): RelayState {
    return {
      runId: "test-run",
      label: "my-task",
      model: "anthropic/claude-opus-4-6",
      toolEntries: [],
      pendingToolCallIds: new Map(),
      startedAt: 1_000,
      toolCount: 3,
      status: "error",
      lastUpdatedAt: 5_000,
      deliveryContext: { channel: "zulip", to: "stream:marcel#general" },
      ...overrides,
    };
  }

  it("includes respawn suffix when respawnedAs is set", () => {
    const msg = renderRelayMessage(makeRelayState({ respawnedAs: "my-task-respawned" }));
    expect(msg).toContain("⚡ re-spawned as `my-task-respawned`");
  });

  it("does not include respawn suffix when respawnedAs is not set", () => {
    const msg = renderRelayMessage(makeRelayState());
    expect(msg).not.toContain("⚡");
    expect(msg).not.toContain("re-spawned as");
  });

  it("does not include respawn suffix when respawnedAs is undefined", () => {
    const msg = renderRelayMessage(makeRelayState({ respawnedAs: undefined }));
    expect(msg).not.toContain("re-spawned as");
  });

  it("includes both origin topic and respawn info when both set", () => {
    const msg = renderRelayMessage(makeRelayState({ respawnedAs: "my-task-respawned" }), "dreamit");
    expect(msg).toContain("📍 dreamit");
    expect(msg).toContain("⚡ re-spawned as `my-task-respawned`");
  });

  it("shows error emoji when status is error and respawnedAs is set", () => {
    const msg = renderRelayMessage(
      makeRelayState({ status: "error", respawnedAs: "my-task-respawned" }),
    );
    expect(msg).toContain("❌");
    expect(msg).toContain("⚡ re-spawned as `my-task-respawned`");
  });
});
