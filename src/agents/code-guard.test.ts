import { describe, expect, it } from "vitest";
import {
  checkCodeGuard,
  DEFAULT_CODE_EXTENSIONS,
  extractFilePathFromParams,
  isCodeFilePath,
  isExemptPath,
  isSingleLineFix,
} from "./code-guard.js";

describe("isCodeFilePath", () => {
  it("returns true for TypeScript files", () => {
    expect(isCodeFilePath("src/index.ts")).toBe(true);
    expect(isCodeFilePath("src/component.tsx")).toBe(true);
  });

  it("returns true for JavaScript files", () => {
    expect(isCodeFilePath("lib/helper.js")).toBe(true);
    expect(isCodeFilePath("lib/component.jsx")).toBe(true);
    expect(isCodeFilePath("config.mjs")).toBe(true);
    expect(isCodeFilePath("config.cjs")).toBe(true);
  });

  it("returns true for Python files", () => {
    expect(isCodeFilePath("scripts/deploy.py")).toBe(true);
  });

  it("returns true for shell scripts", () => {
    expect(isCodeFilePath("bin/start.sh")).toBe(true);
    expect(isCodeFilePath("bin/init.bash")).toBe(true);
    expect(isCodeFilePath("bin/setup.zsh")).toBe(true);
  });

  it("returns true for other code file types", () => {
    expect(isCodeFilePath("main.rs")).toBe(true);
    expect(isCodeFilePath("main.go")).toBe(true);
    expect(isCodeFilePath("main.c")).toBe(true);
    expect(isCodeFilePath("main.cpp")).toBe(true);
    expect(isCodeFilePath("App.vue")).toBe(true);
    expect(isCodeFilePath("App.svelte")).toBe(true);
  });

  it("returns false for markdown files", () => {
    expect(isCodeFilePath("README.md")).toBe(false);
    expect(isCodeFilePath("docs/AGENTS.md")).toBe(false);
  });

  it("returns false for config files", () => {
    expect(isCodeFilePath("package.json")).toBe(false);
    expect(isCodeFilePath("config.yaml")).toBe(false);
    expect(isCodeFilePath("config.yml")).toBe(false);
    expect(isCodeFilePath("pyproject.toml")).toBe(false);
  });

  it("returns false for files with no extension", () => {
    expect(isCodeFilePath("Makefile")).toBe(false);
    expect(isCodeFilePath("Dockerfile")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCodeFilePath("main.TS")).toBe(true);
    expect(isCodeFilePath("main.Py")).toBe(true);
  });

  it("uses custom extensions when provided", () => {
    expect(isCodeFilePath("data.csv", [".csv", ".dat"])).toBe(true);
    expect(isCodeFilePath("main.ts", [".csv", ".dat"])).toBe(false);
  });

  it("handles custom extensions without leading dot", () => {
    expect(isCodeFilePath("main.ts", ["ts", "js"])).toBe(true);
  });
});

describe("extractFilePathFromParams", () => {
  describe("write tool", () => {
    it("extracts file_path parameter", () => {
      expect(
        extractFilePathFromParams("write", { file_path: "/src/index.ts", content: "code" }),
      ).toBe("/src/index.ts");
    });

    it("extracts path parameter", () => {
      expect(extractFilePathFromParams("write", { path: "/src/index.ts", content: "code" })).toBe(
        "/src/index.ts",
      );
    });

    it("prefers file_path over path", () => {
      expect(
        extractFilePathFromParams("write", {
          file_path: "/src/a.ts",
          path: "/src/b.ts",
          content: "code",
        }),
      ).toBe("/src/a.ts");
    });

    it("returns undefined when no path is provided", () => {
      expect(extractFilePathFromParams("write", { content: "code" })).toBeUndefined();
    });

    it("returns undefined when path is not a string", () => {
      expect(extractFilePathFromParams("write", { file_path: 123 })).toBeUndefined();
    });
  });

  describe("edit tool", () => {
    it("extracts file_path parameter", () => {
      expect(
        extractFilePathFromParams("edit", {
          file_path: "/src/index.ts",
          old_string: "a",
          new_string: "b",
        }),
      ).toBe("/src/index.ts");
    });

    it("extracts path parameter", () => {
      expect(
        extractFilePathFromParams("edit", {
          path: "/src/index.ts",
          oldText: "a",
          newText: "b",
        }),
      ).toBe("/src/index.ts");
    });
  });

  describe("apply_patch tool", () => {
    it("extracts file path from +++ header", () => {
      const patch = `--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,3 @@
-old code
+new code`;
      expect(extractFilePathFromParams("apply_patch", { patch })).toBe("src/new.ts");
    });

    it("falls back to --- header when +++ is missing", () => {
      const patch = `--- a/src/file.ts
@@ -1,3 +1,3 @@
-old code
+new code`;
      expect(extractFilePathFromParams("apply_patch", { patch })).toBe("src/file.ts");
    });

    it("returns undefined when no diff headers exist", () => {
      expect(extractFilePathFromParams("apply_patch", { patch: "no diff here" })).toBeUndefined();
    });

    it("returns undefined when patch is not a string", () => {
      expect(extractFilePathFromParams("apply_patch", { patch: 123 })).toBeUndefined();
    });

    it("returns undefined when params is empty", () => {
      expect(extractFilePathFromParams("apply_patch", {})).toBeUndefined();
    });
  });

  describe("unknown tools", () => {
    it("returns undefined for unrecognized tools", () => {
      expect(extractFilePathFromParams("read", { path: "/src/file.ts" })).toBeUndefined();
      expect(extractFilePathFromParams("exec", { command: "ls" })).toBeUndefined();
    });
  });
});

describe("isSingleLineFix", () => {
  it("returns true for small single-line edit", () => {
    expect(
      isSingleLineFix("edit", {
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      }),
    ).toBe(true);
  });

  it("returns false for multi-line edit", () => {
    expect(
      isSingleLineFix("edit", {
        old_string: "line1\nline2",
        new_string: "newline1\nnewline2",
      }),
    ).toBe(false);
  });

  it("returns false when old text has newline", () => {
    expect(
      isSingleLineFix("edit", {
        old_string: "line1\nline2",
        new_string: "combined",
      }),
    ).toBe(false);
  });

  it("returns false when new text has newline", () => {
    expect(
      isSingleLineFix("edit", {
        old_string: "combined",
        new_string: "line1\nline2",
      }),
    ).toBe(false);
  });

  it("returns false when total chars exceed threshold", () => {
    const longString = "a".repeat(150);
    expect(
      isSingleLineFix("edit", {
        old_string: longString,
        new_string: longString,
      }),
    ).toBe(false);
  });

  it("respects custom maxChars threshold", () => {
    expect(
      isSingleLineFix(
        "edit",
        {
          old_string: "short",
          new_string: "also short",
        },
        5,
      ),
    ).toBe(false);
  });

  it("returns false for write tool", () => {
    expect(
      isSingleLineFix("write", {
        old_string: "a",
        new_string: "b",
      }),
    ).toBe(false);
  });

  it("returns false for apply_patch tool", () => {
    expect(
      isSingleLineFix("apply_patch", {
        old_string: "a",
        new_string: "b",
      }),
    ).toBe(false);
  });

  it("handles oldText/newText parameter names", () => {
    expect(
      isSingleLineFix("edit", {
        oldText: "const a = 1;",
        newText: "const a = 2;",
      }),
    ).toBe(true);
  });

  it("handles missing parameters gracefully", () => {
    expect(isSingleLineFix("edit", {})).toBe(true); // Empty strings, 0 chars < 200
  });
});

describe("isExemptPath", () => {
  it("returns false for empty patterns", () => {
    expect(isExemptPath("/src/index.ts", [])).toBe(false);
  });

  it("matches exact file names with glob", () => {
    expect(isExemptPath("/root/clawd/AGENTS.md", ["**/AGENTS.md"])).toBe(true);
  });

  it("matches extension globs", () => {
    expect(isExemptPath("/src/docs/readme.md", ["**/*.md"])).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isExemptPath("/src/index.ts", ["**/*.md"])).toBe(false);
  });

  it("matches specific directory patterns", () => {
    expect(isExemptPath("/src/test/helper.ts", ["**/test/**"])).toBe(true);
  });

  it("matches .env files", () => {
    expect(isExemptPath("/root/.env", ["**/.env*"])).toBe(true);
    expect(isExemptPath("/root/.env.local", ["**/.env*"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExemptPath("/README.MD", ["**/*.md"])).toBe(true);
  });

  it("handles Windows-style paths", () => {
    expect(isExemptPath("C:\\src\\index.ts", ["**/*.ts"])).toBe(true);
  });
});

describe("checkCodeGuard", () => {
  const baseConfig = {
    enabled: true,
    mode: "block" as const,
  };

  it("returns null when guard is disabled", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { enabled: false },
    });
    expect(result).toBeNull();
  });

  it("returns null for non-code-modifying tools", () => {
    const result = checkCodeGuard({
      toolName: "read",
      params: { path: "/src/index.ts" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("returns null for sub-agent sessions", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:subagent:abc123",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("returns null for cron sessions", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:cron:daily-check",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("returns null for non-code files", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/docs/README.md", content: "text" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("blocks write to code file in block mode", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain("BLOCKED");
    expect(result!.reason).toContain("sessions_spawn");
  });

  it("blocks edit to code file in block mode", () => {
    const result = checkCodeGuard({
      toolName: "edit",
      params: {
        file_path: "/src/index.ts",
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 2;\nconst b = 3;",
      },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it("blocks apply_patch to code file in block mode", () => {
    const patch = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
-old code
+new code`;
    const result = checkCodeGuard({
      toolName: "apply_patch",
      params: { patch },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it("warns but does not block in warn mode", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { ...baseConfig, mode: "warn" },
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(false);
    expect(result!.warned).toBe(true);
    expect(result!.reason).toContain("WARNING");
  });

  it("allows single-line fixes in block mode", () => {
    const result = checkCodeGuard({
      toolName: "edit",
      params: {
        file_path: "/src/index.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("allows exempt paths", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/test/helper.ts", content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { ...baseConfig, exemptPaths: ["**/test/**"] },
    });
    expect(result).toBeNull();
  });

  it("returns null when file path cannot be extracted", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: baseConfig,
    });
    expect(result).toBeNull();
  });

  it("respects custom singleLineExemptMaxChars", () => {
    // With a very small threshold, even a short edit is not exempt
    const result = checkCodeGuard({
      toolName: "edit",
      params: {
        file_path: "/src/index.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { ...baseConfig, singleLineExemptMaxChars: 5 },
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it("uses custom code extensions", () => {
    // .txt is not a default code extension
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/data.txt", content: "text" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { ...baseConfig, codeExtensions: [".txt"] },
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it("defaults to warn mode when mode is not specified", () => {
    const result = checkCodeGuard({
      toolName: "write",
      params: { file_path: "/src/index.ts", content: "code" },
      sessionKey: "agent:main:zulip:channel:test#topic",
      config: { enabled: true },
    });
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(false);
    expect(result!.warned).toBe(true);
  });
});

describe("DEFAULT_CODE_EXTENSIONS", () => {
  it("includes common web development extensions", () => {
    expect(DEFAULT_CODE_EXTENSIONS.has(".ts")).toBe(true);
    expect(DEFAULT_CODE_EXTENSIONS.has(".tsx")).toBe(true);
    expect(DEFAULT_CODE_EXTENSIONS.has(".js")).toBe(true);
    expect(DEFAULT_CODE_EXTENSIONS.has(".jsx")).toBe(true);
    expect(DEFAULT_CODE_EXTENSIONS.has(".vue")).toBe(true);
    expect(DEFAULT_CODE_EXTENSIONS.has(".svelte")).toBe(true);
  });

  it("does not include documentation or config files", () => {
    expect(DEFAULT_CODE_EXTENSIONS.has(".md")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".json")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".yaml")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".yml")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".toml")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".xml")).toBe(false);
    expect(DEFAULT_CODE_EXTENSIONS.has(".txt")).toBe(false);
  });
});
