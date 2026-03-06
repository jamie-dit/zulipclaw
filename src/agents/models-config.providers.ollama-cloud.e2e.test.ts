import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Ollama Cloud provider", () => {
  it("should not include ollama-cloud when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const saved = process.env.OLLAMA_CLOUD_API_KEY;
    delete process.env.OLLAMA_CLOUD_API_KEY;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.["ollama-cloud"]).toBeUndefined();
    } finally {
      if (saved !== undefined) {
        process.env.OLLAMA_CLOUD_API_KEY = saved;
      }
    }
  });

  it("should include ollama-cloud when OLLAMA_CLOUD_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_CLOUD_API_KEY = "test-cloud-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.["ollama-cloud"]).toBeDefined();
      expect(providers?.["ollama-cloud"]?.apiKey).toBe("OLLAMA_CLOUD_API_KEY");
    } finally {
      delete process.env.OLLAMA_CLOUD_API_KEY;
    }
  });

  it("should use https://ollama.com as base URL", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_CLOUD_API_KEY = "test-cloud-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.["ollama-cloud"]?.baseUrl).toBe("https://ollama.com");
    } finally {
      delete process.env.OLLAMA_CLOUD_API_KEY;
    }
  });

  it("should use native ollama api type", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_CLOUD_API_KEY = "test-cloud-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.["ollama-cloud"]?.api).toBe("ollama");
    } finally {
      delete process.env.OLLAMA_CLOUD_API_KEY;
    }
  });

  it("should not conflict with local ollama provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_CLOUD_API_KEY = "test-cloud-key";
    process.env.OLLAMA_API_KEY = "test-local-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      // Both providers should coexist
      expect(providers?.["ollama-cloud"]).toBeDefined();
      expect(providers?.ollama).toBeDefined();
      expect(providers?.["ollama-cloud"]?.baseUrl).toBe("https://ollama.com");
      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    } finally {
      delete process.env.OLLAMA_CLOUD_API_KEY;
      delete process.env.OLLAMA_API_KEY;
    }
  });
});
