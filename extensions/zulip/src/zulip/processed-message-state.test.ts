import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isZulipMessageAlreadyProcessed,
  loadZulipProcessedMessageState,
  markZulipMessageProcessed,
  resolveZulipProcessedMessageStateDir,
  writeZulipProcessedMessageState,
  ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
} from "./processed-message-state.js";

describe("zulip processed message state", () => {
  it("returns empty state when file is missing", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-processed-missing-"));

    const loaded = await loadZulipProcessedMessageState({
      accountId: "default",
      stateDir: tmp,
    });

    expect(loaded).toEqual({
      version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
      accountId: "default",
      updatedAtMs: expect.any(Number),
      streamWatermarks: {},
    });
  });

  it("writes and reloads stream watermarks", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-processed-write-"));

    await writeZulipProcessedMessageState({
      state: {
        version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
        accountId: "default",
        updatedAtMs: 123,
        streamWatermarks: {
          marcel: 77,
        },
      },
      stateDir: tmp,
    });

    const loaded = await loadZulipProcessedMessageState({
      accountId: "default",
      stateDir: tmp,
    });

    expect(loaded).toMatchObject({
      version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
      accountId: "default",
      streamWatermarks: {
        marcel: 77,
      },
    });

    const filePath = path.join(tmp, "default.json");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o077).toBe(0);
  });

  it("quarantines corrupt state and falls back to empty", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "zulip-processed-corrupt-"));
    const filePath = path.join(tmp, "default.json");
    await fs.writeFile(filePath, "not-json", "utf8");

    const loaded = await loadZulipProcessedMessageState({
      accountId: "default",
      stateDir: tmp,
    });

    expect(loaded.streamWatermarks).toEqual({});
    const files = await fs.readdir(tmp);
    expect(files.some((entry) => entry.startsWith("default.json.corrupt-"))).toBe(true);
  });

  it("keeps watermarks monotonic and checks processed message ids", () => {
    const empty = {
      version: ZULIP_PROCESSED_MESSAGE_STATE_VERSION,
      accountId: "default",
      updatedAtMs: 0,
      streamWatermarks: {},
    };

    const first = markZulipMessageProcessed({
      state: empty,
      stream: "marcel",
      messageId: 100,
      nowMs: 10,
    });
    expect(first.updated).toBe(true);
    expect(first.state.streamWatermarks.marcel).toBe(100);
    expect(
      isZulipMessageAlreadyProcessed({ state: first.state, stream: "marcel", messageId: 99 }),
    ).toBe(true);
    expect(
      isZulipMessageAlreadyProcessed({ state: first.state, stream: "marcel", messageId: 100 }),
    ).toBe(true);
    expect(
      isZulipMessageAlreadyProcessed({ state: first.state, stream: "marcel", messageId: 101 }),
    ).toBe(false);

    const second = markZulipMessageProcessed({
      state: first.state,
      stream: "marcel",
      messageId: 50,
      nowMs: 20,
    });
    expect(second.updated).toBe(false);
    expect(second.state).toBe(first.state);

    const third = markZulipMessageProcessed({
      state: first.state,
      stream: "marcel",
      messageId: 120,
      nowMs: 30,
    });
    expect(third.updated).toBe(true);
    expect(third.state.streamWatermarks.marcel).toBe(120);
    expect(third.state.updatedAtMs).toBe(30);
  });

  it("resolves processed-state directory under runtime/zulip", () => {
    const dir = resolveZulipProcessedMessageStateDir({
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
    } as NodeJS.ProcessEnv);
    expect(dir).toContain(path.join("runtime", "zulip", "processed"));
  });
});
