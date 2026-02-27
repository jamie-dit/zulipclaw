import fsSync from "node:fs";

/**
 * Normalize a /proc cmdline argument for comparison.
 * Lowercases and converts backslashes to forward slashes.
 */
export function normalizeProcArg(arg: string): string {
  return arg.replaceAll("\\", "/").toLowerCase();
}

/**
 * Parse a raw /proc/<pid>/cmdline buffer into an array of argument strings.
 * Arguments in /proc/cmdline are NUL-separated.
 */
export function parseProcCmdline(raw: string): string[] {
  return raw
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Determine whether an argv array looks like a gateway process.
 * Checks for the "gateway" subcommand and known entry-point filenames.
 */
export function isGatewayArgv(args: string[]): boolean {
  const normalized = args.map(normalizeProcArg);
  if (!normalized.includes("gateway")) {
    return false;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "openclaw.mjs",
    "scripts/run-node.mjs",
    "src/index.ts",
  ];
  if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) {
    return true;
  }

  const exe = normalized[0] ?? "";
  return exe.endsWith("/openclaw") || exe === "openclaw";
}

/**
 * Read the cmdline of a Linux process from /proc.
 * Returns null if the process doesn't exist or isn't readable.
 */
export function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

/**
 * Read the start time (field 22, zero-indexed 21) from /proc/<pid>/stat.
 * Returns null if the process doesn't exist or the field can't be parsed.
 */
export function readLinuxStartTime(pid: number): number | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      return null;
    }
    const rest = raw.slice(closeParen + 1).trim();
    const fields = rest.split(/\s+/);
    const startTime = Number.parseInt(fields[19] ?? "", 10);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}
