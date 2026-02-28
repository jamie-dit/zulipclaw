import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCodingAgentMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(async () => "Merged summary body."),
  estimateTokens: vi.fn(() => 10),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    generateSummary: piCodingAgentMocks.generateSummary,
    estimateTokens: piCodingAgentMocks.estimateTokens,
  };
});

import { extractCompactionMetadata, summarizeInStages } from "./compaction.js";

describe("compaction structured metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts decisions, pending items, files, and error lines from compacted history", () => {
    const metadata = extractCompactionMetadata([
      {
        role: "user",
        content:
          "Yes, go ahead with the patch. TODO: verify CI after push. Remember this: keep retries idempotent.",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "Error: request timed out. Resolved by reducing chunk size and retrying.",
        timestamp: 2,
      },
      {
        role: "tool",
        toolName: "edit",
        content: [
          {
            type: "toolCall",
            arguments: { path: "/opt/zulipclaw/src/agents/compaction.ts" },
          },
        ],
        timestamp: 3,
      } as unknown as AgentMessage,
    ]);

    expect(metadata.filesTouched.join("\n")).toContain("compaction.ts");
    expect(metadata.keyDecisions.join("\n")).toMatch(/go ahead|remember this/i);
    expect(metadata.pendingItems.join("\n")).toContain("TODO: verify CI after push");
    expect(metadata.errorResolutions.join("\n")).toContain("Error: request timed out");
  });

  it("prepends structured context and enriches summarizer instructions", async () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Decision: use worktrees for this task. TODO: run build after tests.",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "Read file /opt/zulipclaw/src/agents/subagent-relay.ts" }],
        timestamp: 2,
      } as unknown as AgentMessage,
    ];

    const summary = await summarizeInStages({
      messages,
      model: { id: "mock", name: "mock", contextWindow: 20_000, maxTokens: 1_000 } as never,
      apiKey: "test",
      signal: new AbortController().signal,
      reserveTokens: 100,
      maxChunkTokens: 50_000,
      contextWindow: 20_000,
      customInstructions: "Keep the summary concise.",
      parts: 1,
    });

    expect(summary).toContain("## Compacted Context");
    expect(summary).toContain("**Files touched:**");
    expect(summary).toContain("subagent-relay.ts");
    expect(summary).toContain("**Key decisions:**");
    expect(summary).toContain("Decision: use worktrees for this task");
    expect(summary).toContain("**Pending items:**");
    expect(summary).toContain("TODO: run build after tests");
    expect(summary).toContain("**Summary:**");
    expect(summary).toContain("Merged summary body.");

    const customInstructionsArg = piCodingAgentMocks.generateSummary.mock.calls[0]?.[5];
    expect(String(customInstructionsArg)).toContain("User preferences, corrections");
    expect(String(customInstructionsArg)).toContain("File paths and each file's purpose");
    expect(String(customInstructionsArg)).toContain("Important decisions plus the rationale");
    expect(String(customInstructionsArg)).toContain("Additional instructions");
  });
});
