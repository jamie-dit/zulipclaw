import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildZulipCheckpointId,
  clearZulipInFlightCheckpoint,
  isZulipCheckpointStale,
  loadZulipInFlightCheckpoints,
  type ZulipInFlightCheckpoint,
  writeZulipInFlightCheckpoint,
  ZULIP_INFLIGHT_CHECKPOINT_VERSION,
  ZULIP_INFLIGHT_MAX_AGE_MS,
} from "./inflight-checkpoints.js";

function createCheckpoint(overrides?: Partial<ZulipInFlightCheckpoint>): ZulipInFlightCheckpoint {
  const now = Date.now();
  return {
    version: ZULIP_INFLIGHT_CHECKPOINT_VERSION,
    checkpointId: buildZulipCheckpointId({ accountId: "default", messageId: 101 }),
    accountId: "default",
    stream: "marcel",
    topic: "general",
    messageId: 101,
    senderId: "55",
    senderName: "Tester",
    senderEmail: "tester@example.com",
    cleanedContent: "hello",
    body: "hello",
    sessionKey: "session-key",
    from: "zulip:channel:marcel",
    to: "stream:marcel#general",
    wasMentioned: false,
    createdAtMs: now,
    updatedAtMs: now,
    retryCount: 0,
    ...overrides,
  };
}

describe("zulip inflight checkpoints", () => {
  it("writes, loads, and clears checkpoint files", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-checkpoint-"));
    const checkpoint = createCheckpoint();

    await writeZulipInFlightCheckpoint({ checkpoint, checkpointDir: tmp });

    const loaded = await loadZulipInFlightCheckpoints({
      accountId: "default",
      checkpointDir: tmp,
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      messageId: checkpoint.messageId,
      stream: checkpoint.stream,
      topic: checkpoint.topic,
      cleanedContent: checkpoint.cleanedContent,
      body: checkpoint.body,
      sessionKey: checkpoint.sessionKey,
    });

    await clearZulipInFlightCheckpoint({
      checkpointId: checkpoint.checkpointId,
      checkpointDir: tmp,
    });

    const afterClear = await loadZulipInFlightCheckpoints({
      accountId: "default",
      checkpointDir: tmp,
    });
    expect(afterClear).toHaveLength(0);
  });

  it("writes checkpoint files with private permissions", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-checkpoint-perms-"));
    const checkpointDir = path.join(tmp, "runtime", "zulip", "inflight");
    const checkpoint = createCheckpoint({ checkpointId: "default:301", messageId: 301 });

    await writeZulipInFlightCheckpoint({ checkpoint, checkpointDir });

    const filePath = path.join(checkpointDir, `${checkpoint.checkpointId}.json`);
    const stat = await fs.stat(filePath);

    expect(stat.mode & 0o077).toBe(0);
  });

  it("ignores malformed checkpoint timestamps during load", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-checkpoint-malformed-"));
    const valid = createCheckpoint({ checkpointId: "default:201", messageId: 201 });
    const invalid = {
      ...createCheckpoint({ checkpointId: "default:202", messageId: 202 }),
      updatedAtMs: Number.NaN,
    };

    await fs.writeFile(path.join(tmp, "valid.json"), JSON.stringify(valid), "utf8");
    await fs.writeFile(path.join(tmp, "invalid.json"), JSON.stringify(invalid), "utf8");

    const loaded = await loadZulipInFlightCheckpoints({
      accountId: "default",
      checkpointDir: tmp,
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.checkpointId).toBe("default:201");
  });

  it("marks stale checkpoints by age", () => {
    const now = Date.now();
    const fresh = createCheckpoint({ updatedAtMs: now - ZULIP_INFLIGHT_MAX_AGE_MS + 1_000 });
    const stale = createCheckpoint({ updatedAtMs: now - ZULIP_INFLIGHT_MAX_AGE_MS - 1_000 });

    expect(isZulipCheckpointStale({ checkpoint: fresh, nowMs: now })).toBe(false);
    expect(isZulipCheckpointStale({ checkpoint: stale, nowMs: now })).toBe(true);
  });
});
