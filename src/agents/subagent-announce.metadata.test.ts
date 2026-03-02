import { describe, expect, it } from "vitest";
import { buildCompletionDeliveryMessage } from "./subagent-announce.js";

describe("buildCompletionDeliveryMessage metadata", () => {
  it("includes failure classification in completion card metadata when present", () => {
    const msg = buildCompletionDeliveryMessage({
      findings: "partial output",
      subagentName: "worker",
      metadata: {
        status: "timeout",
        failure: "run_timeout",
        iterationsUsed: "3/5",
        duration: "12s",
        tokens: "123",
      },
    });

    expect(msg).toContain("- Status: timeout");
    expect(msg).toContain("- Failure: run_timeout");
  });

  it("omits failure classification line when no failure exists", () => {
    const msg = buildCompletionDeliveryMessage({
      findings: "done",
      subagentName: "worker",
      metadata: {
        status: "completed",
        iterationsUsed: "2/5",
        duration: "8s",
        tokens: "88",
      },
    });

    expect(msg).toContain("- Status: completed");
    expect(msg).not.toContain("- Failure:");
  });
});
