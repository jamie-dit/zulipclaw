/**
 * Content-addressed store for skillsSnapshot deduplication.
 *
 * Snapshots are stored once at `<sessionsDir>/snapshots/<sha256prefix>.json`
 * and referenced by hash in SessionEntry.skillsSnapshotRef.
 *
 * This reduces disk usage from O(sessions * 51KB) to O(unique_snapshots * 51KB).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionSkillSnapshot } from "./types.js";

const SNAPSHOTS_DIR_NAME = "snapshots";
/** Number of hex chars of sha256 to use as the filename prefix (collision probability negligible). */
const HASH_PREFIX_LENGTH = 16;

export function resolveSnapshotsDir(storePath: string): string {
  return path.join(path.dirname(storePath), SNAPSHOTS_DIR_NAME);
}

function snapshotFilePath(snapshotsDir: string, ref: string): string {
  return path.join(snapshotsDir, `${ref}.json`);
}

/**
 * Compute the content-addressed ref (sha256 hex prefix) for a snapshot.
 */
export function computeSnapshotRef(snapshot: SessionSkillSnapshot): string {
  const json = JSON.stringify(snapshot);
  return crypto
    .createHash("sha256")
    .update(json, "utf-8")
    .digest("hex")
    .slice(0, HASH_PREFIX_LENGTH);
}

/**
 * Store a snapshot in the content-addressed store.
 * Returns the ref (hash prefix). No-ops if the file already exists.
 * Synchronous to keep it inline with the existing synchronous store patterns.
 */
export function storeSnapshot(storePath: string, snapshot: SessionSkillSnapshot): string {
  const ref = computeSnapshotRef(snapshot);
  const snapshotsDir = resolveSnapshotsDir(storePath);
  const filePath = snapshotFilePath(snapshotsDir, ref);

  // Fast-path: file already exists (idempotent).
  if (fs.existsSync(filePath)) {
    return ref;
  }

  fs.mkdirSync(snapshotsDir, { recursive: true });
  const json = JSON.stringify(snapshot, null, 2);
  // Write atomically via temp + rename.
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600, encoding: "utf-8" });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
  return ref;
}

/**
 * Load a snapshot from the content-addressed store by ref.
 * Returns null if the ref file is not found or cannot be parsed.
 */
export function loadSnapshot(storePath: string, ref: string): SessionSkillSnapshot | null {
  // Validate ref to prevent path traversal — must be a hex string of expected length.
  if (!/^[a-f0-9]{1,64}$/i.test(ref)) {
    return null;
  }
  const snapshotsDir = resolveSnapshotsDir(storePath);
  const filePath = snapshotFilePath(snapshotsDir, ref);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionSkillSnapshot;
  } catch {
    return null;
  }
}

/**
 * Prune snapshot files that are no longer referenced by any session entry.
 * `referencedRefs` is the set of refs currently in use.
 * Returns the number of files removed.
 */
export function pruneUnreferencedSnapshots(storePath: string, referencedRefs: Set<string>): number {
  const snapshotsDir = resolveSnapshotsDir(storePath);
  if (!fs.existsSync(snapshotsDir)) {
    return 0;
  }
  let removed = 0;
  try {
    const files = fs.readdirSync(snapshotsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const ref = file.slice(0, -5); // strip ".json"
      if (!referencedRefs.has(ref)) {
        try {
          fs.unlinkSync(path.join(snapshotsDir, file));
          removed++;
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // snapshotsDir may not be readable
  }
  return removed;
}
