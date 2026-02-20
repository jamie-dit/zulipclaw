import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool, resolveGatewayOptions } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  loadConfig: vi.fn(() => ({})),
  resolveGatewayPort: vi.fn(() => 18789),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: (...args: Parameters<typeof actual.loadConfig>) => mocks.loadConfig(...args),
    resolveGatewayPort: (...args: Parameters<typeof actual.resolveGatewayPort>) =>
      mocks.resolveGatewayPort(...args),
  };
});

vi.mock("../../gateway/call.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../gateway/call.js")>("../../gateway/call.js");
  return {
    ...actual,
    callGateway: (...args: unknown[]) => mocks.callGateway(...args),
  };
});

describe("gateway tool defaults", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.loadConfig.mockReset();
    mocks.resolveGatewayPort.mockReset();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveGatewayPort.mockReturnValue(18789);
  });

  it("leaves url undefined so callGateway can use config", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
  });

  it("accepts allowlisted loopback overrides", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "t",
        timeoutMs: 5000,
      }),
    );
  });

  it("rejects unsafe protocols and malformed auth/path parts", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "file:///etc/passwd" }, {}),
    ).rejects.toThrow(/invalid gatewayUrl protocol/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "gopher://example.com" }, {}),
    ).rejects.toThrow(/invalid gatewayUrl protocol/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://user:pass@127.0.0.1:18789" }, {}),
    ).rejects.toThrow(/credentials are not allowed/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:18789/private" }, {}),
    ).rejects.toThrow(/path not allowed/i);
  });

  it("rejects localhost/private/link-local/metadata hosts unless explicitly allowlisted", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://localhost:9999" }, {}),
    ).rejects.toThrow(/blocked localhost host/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://10.2.3.4:18789" }, {}),
    ).rejects.toThrow(/blocked private host/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://169.254.169.254:80" }, {}),
    ).rejects.toThrow(/blocked metadata host/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://[fe80::1]:18789" }, {}),
    ).rejects.toThrow(/blocked link-local host/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://[::ffff:127.0.0.1]:1234" }, {}),
    ).rejects.toThrow(/blocked loopback host/i);
  });

  it("allows configured remote gateway URL overrides", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    mocks.loadConfig.mockReturnValue({
      gateway: { remote: { url: "wss://relay.example.com:443" } },
    });

    await callGatewayTool(
      "health",
      { gatewayUrl: "wss://relay.example.com:443", gatewayToken: "t" },
      {},
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://relay.example.com",
      }),
    );
  });

  it("allows configured private remote endpoints via explicit policy", async () => {
    mocks.callGateway.mockResolvedValueOnce({ ok: true });
    mocks.loadConfig.mockReturnValue({
      gateway: { remote: { url: "ws://10.42.0.25:18789" } },
    });

    await callGatewayTool("health", { gatewayUrl: "ws://10.42.0.25:18789", gatewayToken: "t" }, {});

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://10.42.0.25:18789",
      }),
    );
  });
});
