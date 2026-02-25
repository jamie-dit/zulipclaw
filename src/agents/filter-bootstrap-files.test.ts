import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const makeFile = (name: string, content = "content"): WorkspaceBootstrapFile => ({
  name,
  path: `/workspace/${name}`,
  content,
  missing: false,
});

describe("filterBootstrapFilesForSession", () => {
  const allFiles: WorkspaceBootstrapFile[] = [
    makeFile(DEFAULT_AGENTS_FILENAME),
    makeFile(DEFAULT_TOOLS_FILENAME),
    makeFile(DEFAULT_SOUL_FILENAME),
    makeFile(DEFAULT_USER_FILENAME),
    makeFile(DEFAULT_IDENTITY_FILENAME),
    makeFile("CUSTOM.md"),
    makeFile("README.md"),
  ];

  describe("non-subagent sessions", () => {
    it("returns all files for main session (no sessionKey)", () => {
      const result = filterBootstrapFilesForSession(allFiles, undefined);
      expect(result).toHaveLength(allFiles.length);
      expect(result.map((f) => f.name)).toContain("README.md");
    });

    it("returns all files for regular session (not subagent/cron)", () => {
      const result = filterBootstrapFilesForSession(allFiles, "user:abc123");
      expect(result).toHaveLength(allFiles.length);
    });
  });

  describe("subagent sessions with default allowlist", () => {
    it("includes AGENTS.md, TOOLS.md, SOUL.md, USER.md, IDENTITY.md for subagent sessions", () => {
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123");
      const names = result.map((f) => f.name);
      expect(names).toContain(DEFAULT_AGENTS_FILENAME);
      expect(names).toContain(DEFAULT_TOOLS_FILENAME);
      expect(names).toContain(DEFAULT_SOUL_FILENAME);
      expect(names).toContain(DEFAULT_USER_FILENAME);
      expect(names).toContain(DEFAULT_IDENTITY_FILENAME);
    });

    it("excludes other files for subagent sessions", () => {
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123");
      const names = result.map((f) => f.name);
      expect(names).not.toContain("CUSTOM.md");
      expect(names).not.toContain("README.md");
      expect(result).toHaveLength(5);
    });

    it("includes SOUL.md, USER.md, IDENTITY.md in addition to AGENTS.md and TOOLS.md", () => {
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123");
      expect(result.map((f) => f.name).toSorted()).toEqual([
        DEFAULT_AGENTS_FILENAME,
        DEFAULT_IDENTITY_FILENAME,
        DEFAULT_SOUL_FILENAME,
        DEFAULT_TOOLS_FILENAME,
        DEFAULT_USER_FILENAME,
      ]);
    });
  });

  describe("cron sessions with default allowlist", () => {
    it("includes default bootstrap files for cron sessions", () => {
      const result = filterBootstrapFilesForSession(allFiles, "agent:main:cron:job-1");
      const names = result.map((f) => f.name);
      expect(names).toContain(DEFAULT_SOUL_FILENAME);
      expect(names).toContain(DEFAULT_USER_FILENAME);
      expect(names).toContain(DEFAULT_IDENTITY_FILENAME);
      expect(result).toHaveLength(5);
    });
  });

  describe("configurable bootstrapFiles", () => {
    it("uses custom allowlist when bootstrapFiles config is provided", () => {
      const config = { subagentBootstrapFiles: ["AGENTS.md", "CUSTOM.md"] };
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123", config);
      const names = result.map((f) => f.name);
      expect(names).toContain("AGENTS.md");
      expect(names).toContain("CUSTOM.md");
      expect(names).not.toContain(DEFAULT_TOOLS_FILENAME);
      expect(names).not.toContain(DEFAULT_SOUL_FILENAME);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when bootstrapFiles is empty", () => {
      const config = { subagentBootstrapFiles: [] };
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123", config);
      expect(result).toHaveLength(0);
    });

    it("ignores missing files from custom allowlist", () => {
      const config = { subagentBootstrapFiles: ["MISSING.md", "AGENTS.md"] };
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123", config);
      expect(result.map((f) => f.name)).toEqual(["AGENTS.md"]);
    });

    it("applies config for cron sessions too", () => {
      const config = { subagentBootstrapFiles: ["CUSTOM.md"] };
      const result = filterBootstrapFilesForSession(allFiles, "agent:main:cron:job-1", config);
      expect(result.map((f) => f.name)).toEqual(["CUSTOM.md"]);
    });
  });

  describe("config precedence", () => {
    it("uses default allowlist when config is undefined", () => {
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123", undefined);
      expect(result).toHaveLength(5);
      expect(result.map((f) => f.name)).toContain(DEFAULT_SOUL_FILENAME);
    });

    it("uses default allowlist when subagentBootstrapFiles is undefined", () => {
      const config = {};
      const result = filterBootstrapFilesForSession(allFiles, "subagent:abc123", config);
      expect(result).toHaveLength(5);
    });
  });
});
