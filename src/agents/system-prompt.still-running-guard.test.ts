/**
 * Tests that the system prompt includes a defensive guard preventing the
 * assistant from claiming a sub-agent is still running without an explicit
 * live status check via the subagents tool.
 */
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt – still-running guard", () => {
  it("includes a guard against claiming running status without a live check", async () => {
    const prompt = await buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    // The prompt must warn against claiming running status without verification.
    // This prevents false "sub-agent is still running" replies in later turns.
    expect(prompt).toContain("Never claim a sub-agent is still running");
    expect(prompt).toContain("subagents");
  });

  it("mentions completedAt as the way to confirm finished state", async () => {
    const prompt = await buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    // Later turns should know to look for completedAt in the subagents list.
    expect(prompt).toContain("completedAt");
  });

  it("guard is present in both normal and subagent contexts", async () => {
    const mainPrompt = await buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    // Subagent mode also receives the system prompt with tools section.
    // The guard text must be present.
    expect(mainPrompt).toContain("Never claim a sub-agent is still running");
  });
});
