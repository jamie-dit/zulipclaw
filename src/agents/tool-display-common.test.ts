import { describe, expect, it } from "vitest";
import { resolveExecDetail, resolveTodoDetail } from "./tool-display-common.js";

describe("resolveExecDetail – comment stripping", () => {
  it("skips a single leading comment to find the real command", () => {
    const detail = resolveExecDetail({
      command:
        '# Check if the new features are loaded in dist\ngrep -l "ToolProgressAccumulator" /opt/zulipclaw/dist/**/*.js',
    });

    expect(detail).toContain("search");
    expect(detail).toContain("ToolProgressAccumulator");
    expect(detail).not.toContain("# Check");
  });

  it("skips multiple leading comment lines", () => {
    const detail = resolveExecDetail({
      command: "# Check status\n# More comments\nls -la /tmp",
    });

    expect(detail).toBe("list files in /tmp");
  });

  it("handles command with no comments unchanged", () => {
    const detail = resolveExecDetail({ command: "echo hello" });
    expect(detail).toBe("print text");
  });

  it("falls back for comment-only command", () => {
    const detail = resolveExecDetail({ command: "# just a comment" });
    expect(detail).toBe("run command");
  });

  it("skips comments mixed with export preamble", () => {
    const detail = resolveExecDetail({
      command: "export FOO=bar\n# Setup complete\ngrep pattern file.txt",
    });

    expect(detail).toContain("search");
    expect(detail).toContain("pattern");
  });

  it("skips shebang lines", () => {
    const detail = resolveExecDetail({
      command: "#!/bin/bash\nset -e\nls -la /var/log",
    });

    expect(detail).toBe("list files in /var/log");
  });

  it("handles empty lines between comments", () => {
    const detail = resolveExecDetail({
      command: "# Comment 1\n\n# Comment 2\nfind /tmp -name '*.log'",
    });

    expect(detail).toContain("find files");
    expect(detail).toContain("*.log");
  });
});

describe("resolveExecDetail – newline as command separator", () => {
  it("takes first command when multiple are newline-separated", () => {
    const detail = resolveExecDetail({
      command: "grep -l pattern /some/path\necho done",
    });

    expect(detail).toContain("search");
    expect(detail).toContain("pattern");
    expect(detail).not.toContain("done");
  });

  it("correctly splits multiline after preamble stripping", () => {
    const detail = resolveExecDetail({
      command: "set -euo pipefail\ngrep pattern file.txt\necho finished",
    });

    expect(detail).toContain("search");
    expect(detail).toContain("pattern");
  });

  it("still handles pipelines within a single line", () => {
    const detail = resolveExecDetail({
      command: "git status --short | head -n 3",
    });

    expect(detail).toContain("check git status");
    expect(detail).toContain("show first 3 lines");
  });

  it("handles heredoc detection after newline splitting", () => {
    const detail = resolveExecDetail({
      command: "python3 <<PY\nprint('x')\nPY",
    });

    expect(detail).toContain("run python3 inline script (heredoc)");
  });
});

describe("resolveTodoDetail", () => {
  it("returns undefined for non-object args", () => {
    expect(resolveTodoDetail(null)).toBeUndefined();
    expect(resolveTodoDetail(undefined)).toBeUndefined();
    expect(resolveTodoDetail("string")).toBeUndefined();
  });

  it("returns undefined when action is missing", () => {
    expect(resolveTodoDetail({ title: "foo" })).toBeUndefined();
  });

  it("formats create action with title", () => {
    expect(resolveTodoDetail({ action: "create", title: "Release prep" })).toBe(
      'create list "Release prep"',
    );
  });

  it("formats create action without title", () => {
    expect(resolveTodoDetail({ action: "create" })).toBe("create list");
  });

  it("formats add action with title", () => {
    expect(resolveTodoDetail({ action: "add", title: "Write migration notes" })).toBe(
      'add "Write migration notes"',
    );
  });

  it("formats add action without title", () => {
    expect(resolveTodoDetail({ action: "add" })).toBe("add item");
  });

  it("formats update with title and status", () => {
    expect(
      resolveTodoDetail({
        action: "update",
        title: "Write migration notes",
        status: "in-progress",
      }),
    ).toBe('update "Write migration notes" → in-progress');
  });

  it("formats update with only status", () => {
    expect(resolveTodoDetail({ action: "update", status: "blocked" })).toBe("update → blocked");
  });

  it("formats update with only title", () => {
    expect(resolveTodoDetail({ action: "update", title: "Task A" })).toBe('update "Task A"');
  });

  it("formats update with neither title nor status", () => {
    expect(resolveTodoDetail({ action: "update" })).toBe("update item");
  });

  it("formats complete action with title", () => {
    expect(resolveTodoDetail({ action: "complete", title: "Write migration notes" })).toBe(
      'complete "Write migration notes"',
    );
  });

  it("formats complete action without title", () => {
    expect(resolveTodoDetail({ action: "complete" })).toBe("complete item");
  });

  it("formats delete action with title", () => {
    expect(resolveTodoDetail({ action: "delete", title: "Old task" })).toBe('delete "Old task"');
  });

  it("formats delete action without title", () => {
    expect(resolveTodoDetail({ action: "delete" })).toBe("delete item");
  });

  it("formats archive action with title", () => {
    expect(resolveTodoDetail({ action: "archive", title: "Release prep" })).toBe(
      'archive list "Release prep"',
    );
  });

  it("formats archive action without title", () => {
    expect(resolveTodoDetail({ action: "archive" })).toBe("archive list");
  });

  it("formats list action with topicKey", () => {
    expect(
      resolveTodoDetail({ action: "list", topicKey: "stream:marcel-zulipclaw#todo list tracking" }),
    ).toBe("list current topic");
  });

  it("formats list action without topicKey", () => {
    expect(resolveTodoDetail({ action: "list" })).toBe("list all");
  });

  it("returns undefined for unknown action", () => {
    expect(resolveTodoDetail({ action: "unknown" })).toBeUndefined();
  });

  it("trims whitespace from values", () => {
    expect(resolveTodoDetail({ action: "  create  ", title: "  Spaced  " })).toBe(
      'create list "Spaced"',
    );
  });
});
