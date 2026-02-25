import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PromptSectionsConfig } from "../config/types.agent-defaults.js";
import {
  BUILTIN_PROMPT_SECTION_IDS,
  buildPromptSections,
  formatPromptSections,
  setBuiltinPromptSectionsDir,
  type ResolvedPromptSection,
  type SessionScope,
} from "./prompt-sections.js";

// Use the real docs/prompt-sections directory for built-in tests
const REAL_BUILTIN_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../docs/prompt-sections",
);

describe("prompt-sections", () => {
  beforeEach(() => {
    setBuiltinPromptSectionsDir(REAL_BUILTIN_DIR);
  });

  afterEach(() => {
    setBuiltinPromptSectionsDir(undefined);
  });

  describe("BUILTIN_PROMPT_SECTION_IDS", () => {
    it("contains expected built-in ids", () => {
      expect(BUILTIN_PROMPT_SECTION_IDS.has("orchestration")).toBe(true);
      expect(BUILTIN_PROMPT_SECTION_IDS.has("coding-workflow")).toBe(true);
      expect(BUILTIN_PROMPT_SECTION_IDS.has("ci-review")).toBe(true);
      expect(BUILTIN_PROMPT_SECTION_IDS.has("investigation")).toBe(true);
      expect(BUILTIN_PROMPT_SECTION_IDS.has("error-recovery")).toBe(true);
    });
  });

  describe("buildPromptSections", () => {
    it("returns empty map when no config provided", async () => {
      const result = await buildPromptSections({});
      expect(result.size).toBe(0);
    });

    it("returns empty map when config is empty", async () => {
      const result = await buildPromptSections({ config: {} });
      expect(result.size).toBe(0);
    });

    it("loads built-in sections from builtins shorthand", async () => {
      const result = await buildPromptSections({
        config: { builtins: ["orchestration"] },
      });
      expect(result.size).toBe(1);
      const sections = result.get("after-skills")!;
      expect(sections).toHaveLength(1);
      expect(sections[0].id).toBe("orchestration");
      expect(sections[0].content).toContain("Orchestration");
    });

    it("loads multiple built-in sections", async () => {
      const result = await buildPromptSections({
        config: { builtins: ["orchestration", "ci-review", "error-recovery"] },
      });
      const sections = result.get("after-skills")!;
      expect(sections).toHaveLength(3);
      const ids = sections.map((s) => s.id);
      expect(ids).toContain("orchestration");
      expect(ids).toContain("ci-review");
      expect(ids).toContain("error-recovery");
    });

    it("loads inline sections", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          {
            id: "custom-rules",
            source: "inline",
            content: "Always be helpful.",
            heading: "Custom Rules",
          },
        ],
      };
      const result = await buildPromptSections({ config });
      const sections = result.get("after-skills")!;
      expect(sections).toHaveLength(1);
      expect(sections[0].id).toBe("custom-rules");
      expect(sections[0].heading).toBe("Custom Rules");
      expect(sections[0].content).toBe("Always be helpful.");
    });

    it("loads file sections relative to workspace dir", async () => {
      // Create a temp file for testing
      const tmpDir = path.join("/tmp", `prompt-sections-test-${Date.now()}`);
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, "custom.md"), "# Custom Content\nHello from file.");

      try {
        const config: PromptSectionsConfig = {
          sections: [
            {
              id: "from-file",
              source: "file",
              path: "custom.md",
            },
          ],
        };
        const result = await buildPromptSections({
          config,
          workspaceDir: tmpDir,
        });
        const sections = result.get("after-skills")!;
        expect(sections).toHaveLength(1);
        expect(sections[0].id).toBe("from-file");
        expect(sections[0].content).toContain("Hello from file");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("skips file sections when file is missing", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          {
            id: "missing-file",
            source: "file",
            path: "nonexistent.md",
          },
        ],
      };
      const result = await buildPromptSections({
        config,
        workspaceDir: "/tmp",
      });
      expect(result.size).toBe(0);
    });

    it("filters by scope: main sees main+all", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "all-scope", source: "inline", content: "all content", scope: "all" },
          { id: "main-scope", source: "inline", content: "main content", scope: "main" },
          {
            id: "subagent-scope",
            source: "inline",
            content: "subagent content",
            scope: "subagent",
          },
          { id: "cron-scope", source: "inline", content: "cron content", scope: "cron" },
        ],
      };
      const result = await buildPromptSections({
        config,
        sessionScope: "main",
      });
      const sections = result.get("after-skills")!;
      const ids = sections.map((s) => s.id);
      expect(ids).toContain("all-scope");
      expect(ids).toContain("main-scope");
      expect(ids).not.toContain("subagent-scope");
      expect(ids).not.toContain("cron-scope");
    });

    it("filters by scope: subagent sees subagent+all", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "all-scope", source: "inline", content: "all content", scope: "all" },
          { id: "main-scope", source: "inline", content: "main content", scope: "main" },
          {
            id: "subagent-scope",
            source: "inline",
            content: "subagent content",
            scope: "subagent",
          },
          { id: "cron-scope", source: "inline", content: "cron content", scope: "cron" },
        ],
      };
      const result = await buildPromptSections({
        config,
        sessionScope: "subagent",
      });
      const sections = result.get("after-skills")!;
      const ids = sections.map((s) => s.id);
      expect(ids).toContain("all-scope");
      expect(ids).not.toContain("main-scope");
      expect(ids).toContain("subagent-scope");
      expect(ids).not.toContain("cron-scope");
    });

    it("filters by scope: cron sees cron+all", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "all-scope", source: "inline", content: "all content", scope: "all" },
          { id: "main-scope", source: "inline", content: "main content", scope: "main" },
          { id: "cron-scope", source: "inline", content: "cron content", scope: "cron" },
        ],
      };
      const result = await buildPromptSections({
        config,
        sessionScope: "cron",
      });
      const sections = result.get("after-skills")!;
      const ids = sections.map((s) => s.id);
      expect(ids).toContain("all-scope");
      expect(ids).not.toContain("main-scope");
      expect(ids).toContain("cron-scope");
    });

    it("defaults scope to 'all' when omitted", async () => {
      const config: PromptSectionsConfig = {
        sections: [{ id: "no-scope", source: "inline", content: "content" }],
      };
      // Should appear for any session scope
      for (const scope of ["main", "subagent", "cron"] as SessionScope[]) {
        const result = await buildPromptSections({ config, sessionScope: scope });
        const sections = result.get("after-skills")!;
        expect(sections).toHaveLength(1);
        expect(sections[0].id).toBe("no-scope");
      }
    });

    it("excludes disabled sections", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "enabled", source: "inline", content: "yes", enabled: true },
          { id: "disabled", source: "inline", content: "no", enabled: false },
          { id: "default-enabled", source: "inline", content: "default" },
        ],
      };
      const result = await buildPromptSections({ config });
      const sections = result.get("after-skills")!;
      const ids = sections.map((s) => s.id);
      expect(ids).toContain("enabled");
      expect(ids).not.toContain("disabled");
      expect(ids).toContain("default-enabled");
    });

    it("groups sections by position", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "a", source: "inline", content: "after skills", position: "after-skills" },
          { id: "b", source: "inline", content: "after workspace", position: "after-workspace" },
          { id: "c", source: "inline", content: "before context", position: "before-context" },
          { id: "d", source: "inline", content: "after runtime", position: "after-runtime" },
        ],
      };
      const result = await buildPromptSections({ config });
      expect(result.get("after-skills")!.map((s) => s.id)).toEqual(["a"]);
      expect(result.get("after-workspace")!.map((s) => s.id)).toEqual(["b"]);
      expect(result.get("before-context")!.map((s) => s.id)).toEqual(["c"]);
      expect(result.get("after-runtime")!.map((s) => s.id)).toEqual(["d"]);
    });

    it("defaults position to 'after-skills'", async () => {
      const config: PromptSectionsConfig = {
        sections: [{ id: "no-pos", source: "inline", content: "content" }],
      };
      const result = await buildPromptSections({ config });
      expect(result.get("after-skills")!).toHaveLength(1);
    });

    it("builtins shorthand expands with defaults", async () => {
      const config: PromptSectionsConfig = {
        builtins: ["orchestration"],
      };
      const result = await buildPromptSections({ config, sessionScope: "main" });
      const sections = result.get("after-skills")!;
      expect(sections).toHaveLength(1);
      expect(sections[0].id).toBe("orchestration");
      expect(sections[0].position).toBe("after-skills");
    });

    it("later section entries override earlier ones with same id", async () => {
      const config: PromptSectionsConfig = {
        builtins: ["orchestration"],
        sections: [
          {
            id: "orchestration",
            source: "inline",
            content: "Custom orchestration content",
            position: "before-context",
          },
        ],
      };
      const result = await buildPromptSections({ config });
      // The inline override should win
      expect(result.has("after-skills")).toBe(false);
      const sections = result.get("before-context")!;
      expect(sections).toHaveLength(1);
      expect(sections[0].content).toBe("Custom orchestration content");
    });

    it("heading defaults to id when omitted", async () => {
      const config: PromptSectionsConfig = {
        sections: [{ id: "my-section", source: "inline", content: "content" }],
      };
      const result = await buildPromptSections({ config });
      const sections = result.get("after-skills")!;
      expect(sections[0].heading).toBe("my-section");
    });

    it("uses custom heading when provided", async () => {
      const config: PromptSectionsConfig = {
        sections: [
          { id: "my-section", source: "inline", content: "content", heading: "My Custom Heading" },
        ],
      };
      const result = await buildPromptSections({ config });
      const sections = result.get("after-skills")!;
      expect(sections[0].heading).toBe("My Custom Heading");
    });
  });

  describe("formatPromptSections", () => {
    it("formats sections with heading prefix", () => {
      const sections: ResolvedPromptSection[] = [
        {
          id: "test",
          heading: "Test Section",
          content: "Some content here.",
          position: "after-skills",
        },
      ];
      const lines = formatPromptSections(sections);
      expect(lines).toEqual(["## Test Section", "Some content here.", ""]);
    });

    it("uses content as-is when it already has a heading", () => {
      const sections: ResolvedPromptSection[] = [
        {
          id: "test",
          heading: "Test",
          content: "## Already Has Heading\nContent below.",
          position: "after-skills",
        },
      ];
      const lines = formatPromptSections(sections);
      expect(lines).toEqual(["## Already Has Heading\nContent below.", ""]);
    });

    it("formats multiple sections", () => {
      const sections: ResolvedPromptSection[] = [
        { id: "a", heading: "Section A", content: "Content A", position: "after-skills" },
        { id: "b", heading: "Section B", content: "Content B", position: "after-skills" },
      ];
      const lines = formatPromptSections(sections);
      expect(lines).toEqual(["## Section A", "Content A", "", "## Section B", "Content B", ""]);
    });
  });

  describe("built-in section files", () => {
    for (const id of BUILTIN_PROMPT_SECTION_IDS) {
      it(`loads built-in section: ${id}`, async () => {
        const result = await buildPromptSections({
          config: { builtins: [id] },
        });
        const sections = result.get("after-skills")!;
        expect(sections).toHaveLength(1);
        expect(sections[0].id).toBe(id);
        expect(sections[0].content.length).toBeGreaterThan(50);
      });
    }
  });
});
