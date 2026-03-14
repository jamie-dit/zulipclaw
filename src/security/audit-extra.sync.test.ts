import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectModelHygieneFindings,
} from "./audit-extra.sync.js";
import { safeEqualSecret } from "./secret-equal.js";

describe("collectAttackSurfaceSummaryFindings", () => {
  it("distinguishes external webhooks from internal hooks when only internal hooks are enabled", () => {
    const cfg: OpenClawConfig = {
      hooks: { internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as enabled when both are configured", () => {
    const cfg: OpenClawConfig = {
      hooks: { enabled: true, internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: enabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as disabled when neither is configured", () => {
    const cfg: OpenClawConfig = {};

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: disabled");
  });
});

describe("safeEqualSecret", () => {
  it("matches identical secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-token")).toBe(true);
  });

  it("rejects mismatched secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects different-length secrets", () => {
    expect(safeEqualSecret("short", "much-longer")).toBe(false);
  });

  it("rejects missing values", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
    expect(safeEqualSecret("secret", undefined)).toBe(false);
    expect(safeEqualSecret(null, "secret")).toBe(false);
  });
});

describe("collectModelHygieneFindings – overloadFallback coverage", () => {
  it("includes agents.defaults.model.overloadFallback in hygiene checks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            overloadFallback: "openai/gpt-3.5-turbo",
          },
        },
      },
    };

    const findings = collectModelHygieneFindings(cfg);
    // gpt-3.5-turbo should trigger the legacy model warning
    const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
    expect(legacyFinding).toBeDefined();
    expect(legacyFinding!.detail).toContain("gpt-3.5");
    expect(legacyFinding!.detail).toContain("agents.defaults.model.overloadFallback");
  });

  it("includes per-agent model.overloadFallback in hygiene checks", () => {
    // Per-agent model type doesn't officially include overloadFallback in the
    // TypeScript type, but the audit scanner casts to check for it at runtime.
    const cfg = {
      agents: {
        defaults: {},
        list: [
          {
            id: "my-agent",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              overloadFallback: "anthropic/claude-instant-1",
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const findings = collectModelHygieneFindings(cfg);
    // claude-instant should trigger the legacy model warning
    const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
    expect(legacyFinding).toBeDefined();
    expect(legacyFinding!.detail).toContain("claude-instant");
    expect(legacyFinding!.detail).toContain("agents.list.my-agent.model.overloadFallback");
  });

  it("does not flag overloadFallback when it is a modern model", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            overloadFallback: "openai/gpt-5.4",
          },
        },
      },
    };

    const findings = collectModelHygieneFindings(cfg);
    const legacyFinding = findings.find((f) => f.checkId === "models.legacy");
    // No legacy findings expected - both models are modern
    expect(legacyFinding).toBeUndefined();
  });
});
