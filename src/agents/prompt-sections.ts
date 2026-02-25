import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PromptSectionEntry,
  PromptSectionPosition,
  PromptSectionsConfig,
} from "../config/types.agent-defaults.js";

/**
 * Known built-in prompt section ids.
 * Each corresponds to a `<id>.md` file in `docs/prompt-sections/`.
 */
export const BUILTIN_PROMPT_SECTION_IDS: ReadonlySet<string> = new Set([
  "orchestration",
  "coding-workflow",
  "ci-review",
  "investigation",
  "error-recovery",
]);

/** Session scope used for filtering prompt sections. */
export type SessionScope = "main" | "subagent" | "cron";

export type ResolvedPromptSection = {
  id: string;
  heading: string;
  content: string;
  position: PromptSectionPosition;
};

const builtinContentCache = new Map<string, Promise<string>>();

let builtinDirOverride: string | undefined;

/**
 * Override the built-in prompt sections directory (for testing).
 */
export function setBuiltinPromptSectionsDir(dir: string | undefined): void {
  builtinDirOverride = dir;
  builtinContentCache.clear();
}

function resolveBuiltinDir(): string {
  if (builtinDirOverride) {
    return builtinDirOverride;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/prompt-sections");
}

async function loadBuiltinContent(id: string): Promise<string> {
  const cached = builtinContentCache.get(id);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    const dir = resolveBuiltinDir();
    const filePath = path.join(dir, `${id}.md`);
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      throw new Error(`Missing built-in prompt section: ${id} (expected at ${filePath})`);
    }
  })();
  builtinContentCache.set(id, pending);
  try {
    return await pending;
  } catch (error) {
    builtinContentCache.delete(id);
    throw error;
  }
}

/**
 * Expand the `builtins` shorthand into full PromptSectionEntry objects.
 */
function expandBuiltins(builtinIds: string[]): PromptSectionEntry[] {
  return builtinIds.map((id) => ({
    id,
    source: "builtin" as const,
    enabled: true,
    scope: "all" as const,
    position: "after-skills" as const,
  }));
}

/**
 * Check whether a section's scope matches the current session scope.
 */
function matchesScope(sectionScope: string | undefined, sessionScope: SessionScope): boolean {
  const scope = sectionScope ?? "all";
  if (scope === "all") {
    return true;
  }
  return scope === sessionScope;
}

/**
 * Resolve and filter prompt sections from config.
 *
 * Returns sections grouped by their `position`, each with resolved content.
 */
export async function buildPromptSections(params: {
  config?: PromptSectionsConfig;
  sessionScope?: SessionScope;
  workspaceDir?: string;
}): Promise<Map<PromptSectionPosition, ResolvedPromptSection[]>> {
  const config = params.config;
  const sessionScope = params.sessionScope ?? "main";
  const workspaceDir = params.workspaceDir ?? process.cwd();

  const result = new Map<PromptSectionPosition, ResolvedPromptSection[]>();

  if (!config) {
    return result;
  }

  // Collect all entries: expanded builtins + explicit sections
  const allEntries: PromptSectionEntry[] = [];
  if (config.builtins && config.builtins.length > 0) {
    allEntries.push(...expandBuiltins(config.builtins));
  }
  if (config.sections && config.sections.length > 0) {
    allEntries.push(...config.sections);
  }

  // Deduplicate by id (later entries override earlier ones)
  const entriesById = new Map<string, PromptSectionEntry>();
  for (const entry of allEntries) {
    entriesById.set(entry.id, entry);
  }

  // Resolve content for each enabled, scope-matching section
  const resolvePromises: Array<Promise<ResolvedPromptSection | null>> = [];

  for (const entry of entriesById.values()) {
    // Skip disabled sections
    if (entry.enabled === false) {
      continue;
    }

    // Skip sections that don't match the current scope
    if (!matchesScope(entry.scope, sessionScope)) {
      continue;
    }

    resolvePromises.push(resolveSection(entry, workspaceDir));
  }

  const resolved = await Promise.all(resolvePromises);
  for (const section of resolved) {
    if (!section) {
      continue;
    }
    const existing = result.get(section.position);
    if (existing) {
      existing.push(section);
    } else {
      result.set(section.position, [section]);
    }
  }

  return result;
}

async function resolveSection(
  entry: PromptSectionEntry,
  workspaceDir: string,
): Promise<ResolvedPromptSection | null> {
  const position = entry.position ?? "after-skills";
  const heading = entry.heading ?? entry.id;

  let content: string;
  try {
    switch (entry.source) {
      case "builtin":
        content = await loadBuiltinContent(entry.id);
        break;
      case "file": {
        if (!entry.path) {
          return null;
        }
        const filePath = path.resolve(workspaceDir, entry.path);
        content = await fs.readFile(filePath, "utf-8");
        break;
      }
      case "inline":
        if (entry.content === undefined || entry.content === null) {
          return null;
        }
        content = entry.content;
        break;
      default:
        return null;
    }
  } catch {
    // Skip sections that fail to load (missing files, etc.)
    return null;
  }

  return {
    id: entry.id,
    heading,
    content: content.trim(),
    position,
  };
}

/**
 * Format resolved sections into prompt lines.
 * Each section is rendered as `## <heading>` followed by its content.
 */
export function formatPromptSections(sections: ResolvedPromptSection[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    // If the content already starts with a heading (## ...), use it as-is
    if (section.content.startsWith("## ")) {
      lines.push(section.content, "");
    } else {
      lines.push(`## ${section.heading}`, section.content, "");
    }
  }
  return lines;
}
