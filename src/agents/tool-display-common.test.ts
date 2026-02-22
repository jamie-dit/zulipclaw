import { describe, expect, it } from "vitest";
import { resolveExecDetail } from "./tool-display-common.js";

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
