import path from "node:path";
import type { CodeGuardConfig } from "../config/types.tools.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

const log = createSubsystemLogger("agents/code-guard");

/**
 * Default file extensions considered "code files" for the code guard.
 * Config files (.json, .yaml, .yml, .toml) and documentation (.md) are
 * intentionally excluded - they are legitimate main-session edits.
 */
export const DEFAULT_CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".rs",
  ".go",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".vue",
  ".svelte",
  ".astro",
  ".php",
  ".pl",
  ".pm",
  ".r",
  ".R",
  ".lua",
  ".zig",
  ".nim",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".ml",
  ".mli",
  ".scala",
  ".clj",
  ".cljs",
  ".elm",
  ".dart",
  ".groovy",
  ".gradle",
  ".tf",
  ".hcl",
]);

/** Code-modifying tool names that the guard intercepts. */
const GUARDED_TOOLS = new Set(["write", "edit", "apply_patch"]);

const DEFAULT_SINGLE_LINE_EXEMPT_MAX_CHARS = 200;

/**
 * Check if a file path targets a code file based on its extension.
 */
export function isCodeFilePath(filePath: string, codeExtensions?: string[]): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) {
    return false;
  }
  if (codeExtensions && codeExtensions.length > 0) {
    const customSet = new Set(
      codeExtensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()),
    );
    return customSet.has(ext);
  }
  return DEFAULT_CODE_EXTENSIONS.has(ext);
}

/**
 * Extract the target file path from tool parameters.
 *
 * - write/edit: `file_path` or `path` parameter
 * - apply_patch: parse file path from diff headers (`--- a/path` or `+++ b/path`)
 */
export function extractFilePathFromParams(
  toolName: string,
  params: Record<string, unknown>,
): string | undefined {
  if (toolName === "write" || toolName === "edit") {
    const fp = params.file_path ?? params.path;
    return typeof fp === "string" ? fp : undefined;
  }

  if (toolName === "apply_patch") {
    // apply_patch has the file path embedded in unified diff headers.
    // Standard format: +++ b/path/to/file or +++ b/path/to/file\t2026-02-27 00:00:00
    // The file path ends at a tab character (before timestamp) or end of line.
    const patch = typeof params.patch === "string" ? params.patch : "";
    // Match +++ b/path/to/file (the "to" file in the diff), stopping at tab or EOL
    const plusMatch = patch.match(/^\+\+\+\s+[ab]\/([^\t\n]+)/m);
    if (plusMatch?.[1]) {
      return plusMatch[1].trim();
    }
    // Fallback: match --- a/path/to/file
    const minusMatch = patch.match(/^---\s+[ab]\/([^\t\n]+)/m);
    if (minusMatch?.[1]) {
      return minusMatch[1].trim();
    }
    return undefined;
  }

  return undefined;
}

/**
 * Check if an edit is small enough to be exempt from the code guard.
 *
 * Single-line fixes (no newlines, total change under threshold) are exempt
 * because spawning a sub-agent for them adds more overhead than the fix itself.
 *
 * Only applies to the `edit` tool - `write` creates entire files and is never
 * considered a single-line fix.
 */
export function isSingleLineFix(
  toolName: string,
  params: Record<string, unknown>,
  maxChars?: number,
): boolean {
  if (toolName !== "edit") {
    return false;
  }

  const oldText = (params.old_string ?? params.oldText ?? "") as string;
  const newText = (params.new_string ?? params.newText ?? "") as string;

  // Must not contain newlines (truly single-line)
  if (oldText.includes("\n") || newText.includes("\n")) {
    return false;
  }

  const totalChars = oldText.length + newText.length;
  const threshold = maxChars ?? DEFAULT_SINGLE_LINE_EXEMPT_MAX_CHARS;
  return totalChars <= threshold;
}

/**
 * Check if a file path matches any of the exempt patterns.
 *
 * Supports simple glob patterns:
 * - `**` matches any path segment(s)
 * - `*` matches any characters within a single path segment
 * - Exact string matching as fallback
 */
export function isExemptPath(filePath: string, exemptPatterns: string[]): boolean {
  if (!exemptPatterns || exemptPatterns.length === 0) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, "/");

  for (const pattern of exemptPatterns) {
    const normalizedPattern = pattern.replace(/\\/g, "/");

    // Convert glob pattern to regex
    const regexStr = normalizedPattern
      // Escape regex special chars (except * and ?)
      .replace(/[.+^${}()|[\]]/g, "\\$&")
      // Convert ** to match any path
      .replace(/\*\*/g, "<<GLOBSTAR>>")
      // Convert * to match within path segment
      .replace(/\*/g, "[^/]*")
      // Convert ? to match a single non-separator character
      .replace(/\?/g, "[^/]")
      // Restore globstar
      .replace(/<<GLOBSTAR>>/g, ".*");

    const regex = new RegExp(`(?:^|/)${regexStr}$`, "i");
    if (regex.test(normalizedPath)) {
      return true;
    }

    // Also try matching the full path directly
    const fullRegex = new RegExp(`^${regexStr}$`, "i");
    if (fullRegex.test(normalizedPath)) {
      return true;
    }
  }

  return false;
}

export type CodeGuardCheckArgs = {
  toolName: string;
  params: Record<string, unknown>;
  sessionKey: string;
  config: CodeGuardConfig;
};

export type CodeGuardResult = {
  blocked: boolean;
  reason?: string;
  warned?: boolean;
} | null;

/**
 * Main code guard check function.
 *
 * Returns:
 * - `null` if the guard does not apply (disabled, sub-agent, non-code tool, etc.)
 * - `{ blocked: true, reason }` if the tool call should be rejected (block mode)
 * - `{ blocked: false, warned: true, reason }` if the tool call is allowed but logged (warn mode)
 * - `{ blocked: false }` if the tool call is allowed (exempt path, single-line fix, etc.)
 */
export function checkCodeGuard(args: CodeGuardCheckArgs): CodeGuardResult {
  const { toolName, params, sessionKey, config } = args;

  // Guard must be explicitly enabled
  if (!config.enabled) {
    return null;
  }

  // Only applies to code-modifying tools
  if (!GUARDED_TOOLS.has(toolName)) {
    return null;
  }

  // Sub-agents and cron sessions are always exempt
  if (isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey)) {
    return null;
  }

  // Extract the target file path
  const filePath = extractFilePathFromParams(toolName, params);
  if (!filePath) {
    // Can't determine file path - allow the call (fail open)
    return null;
  }

  // Check if target is a code file
  if (!isCodeFilePath(filePath, config.codeExtensions)) {
    return null;
  }

  // Check exempt paths
  if (config.exemptPaths && isExemptPath(filePath, config.exemptPaths)) {
    return null;
  }

  // Check single-line fix exemption
  if (isSingleLineFix(toolName, params, config.singleLineExemptMaxChars)) {
    return null;
  }

  const fileName = path.basename(filePath);
  const mode = config.mode ?? "warn";

  if (mode === "block") {
    const reason =
      `BLOCKED: Main session cannot directly edit code files (${fileName}). ` +
      "Use sessions_spawn to delegate this code change to a sub-agent. " +
      "Sub-agents are exempt from this restriction and can edit code files freely. " +
      "Exception: single-line fixes (< " +
      `${config.singleLineExemptMaxChars ?? DEFAULT_SINGLE_LINE_EXEMPT_MAX_CHARS} chars, no newlines) ` +
      "using the edit tool are allowed.";

    log.warn(`code-guard BLOCKED: session=${sessionKey} tool=${toolName} file=${filePath}`);

    return { blocked: true, reason };
  }

  // Warn mode: allow but log
  const reason =
    `⚠️ CODE GUARD WARNING: Main session is directly editing code file (${fileName}). ` +
    "Consider delegating code changes to a sub-agent using sessions_spawn. " +
    "This warning will become a block in strict mode.";

  log.warn(`code-guard WARN: session=${sessionKey} tool=${toolName} file=${filePath}`);

  return { blocked: false, warned: true, reason };
}
