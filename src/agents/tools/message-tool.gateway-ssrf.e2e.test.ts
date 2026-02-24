import { describe, expect, it, vi } from "vitest";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import { createMessageTool } from "./message-tool.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
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

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

function mockSendResult() {
  mocks.runMessageAction.mockReset();
  mocks.runMessageAction.mockResolvedValue({
    kind: "send",
    action: "send",
    channel: "telegram",
    to: "telegram:123",
    handledBy: "plugin",
    payload: {},
    dryRun: true,
  } satisfies MessageActionRunResult);
}

describe("message tool gatewayUrl SSRF hardening", () => {
  it("rejects non-allowlisted gatewayUrl overrides", async () => {
    mockSendResult();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveGatewayPort.mockReturnValue(18789);

    const tool = createMessageTool({ config: {} as never });

    await expect(
      tool.execute("1", {
        action: "send",
        target: "telegram:123",
        message: "hi",
        gatewayUrl: "ws://169.254.169.254",
      }),
    ).rejects.toThrow(/gatewayUrl override rejected/i);

    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects unsafe gatewayUrl protocols", async () => {
    mockSendResult();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveGatewayPort.mockReturnValue(18789);

    const tool = createMessageTool({ config: {} as never });

    await expect(
      tool.execute("1", {
        action: "send",
        target: "telegram:123",
        message: "hi",
        gatewayUrl: "file:///etc/passwd",
      }),
    ).rejects.toThrow(/invalid gatewayUrl protocol/i);

    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects gatewayUrl values with non-root paths", async () => {
    mockSendResult();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveGatewayPort.mockReturnValue(18789);

    const tool = createMessageTool({ config: {} as never });

    await expect(
      tool.execute("1", {
        action: "send",
        target: "telegram:123",
        message: "hi",
        gatewayUrl: "ws://127.0.0.1:18789/private",
      }),
    ).rejects.toThrow(/path not allowed/i);

    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  it("allows configured remote gateway URL overrides", async () => {
    mockSendResult();
    mocks.loadConfig.mockReturnValue({
      gateway: { remote: { url: "wss://relay.example.com:443" } },
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);

    const tool = createMessageTool({ config: {} as never });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "hi",
      gatewayUrl: "wss://relay.example.com:443/",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.gateway?.url).toBe("wss://relay.example.com");
  });
});
