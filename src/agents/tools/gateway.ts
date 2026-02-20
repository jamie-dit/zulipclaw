import { BlockList, isIP } from "node:net";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { readStringParam } from "./common.js";

export const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

export type GatewayCallOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
};

type HostRisk = "localhost" | "loopback" | "private" | "link-local" | "metadata";

type ParsedIpHost = {
  address: string;
  family: "ipv4" | "ipv6";
};

const LOOPBACK_IP_BLOCKLIST = new BlockList();
LOOPBACK_IP_BLOCKLIST.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_IP_BLOCKLIST.addAddress("::1", "ipv6");

const LINK_LOCAL_IP_BLOCKLIST = new BlockList();
LINK_LOCAL_IP_BLOCKLIST.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL_IP_BLOCKLIST.addSubnet("fe80::", 10, "ipv6");

const PRIVATE_IP_BLOCKLIST = new BlockList();
PRIVATE_IP_BLOCKLIST.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE_IP_BLOCKLIST.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_IP_BLOCKLIST.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_IP_BLOCKLIST.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_IP_BLOCKLIST.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_IP_BLOCKLIST.addAddress("::", "ipv6");
PRIVATE_IP_BLOCKLIST.addSubnet("fc00::", 7, "ipv6");

const METADATA_IP_BLOCKLIST = new BlockList();
METADATA_IP_BLOCKLIST.addAddress("169.254.169.254", "ipv4");
METADATA_IP_BLOCKLIST.addAddress("fd00:ec2::254", "ipv6");

const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.aws.internal",
]);

export function readGatewayCallOptions(params: Record<string, unknown>): GatewayCallOptions {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
  };
}

function normalizeHostname(rawHostname: string): string {
  const normalized = rawHostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) {
    throw new Error("invalid gatewayUrl: hostname is required");
  }
  if (normalized.includes("%")) {
    throw new Error("invalid gatewayUrl: zone-scoped hosts are not allowed");
  }
  return normalized;
}

function parseIpHost(hostname: string): ParsedIpHost | undefined {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = isIP(unwrapped);
  if (version === 4) {
    return { address: unwrapped, family: "ipv4" };
  }
  if (version === 6) {
    const mappedV4Prefix = "::ffff:";
    if (unwrapped.toLowerCase().startsWith(mappedV4Prefix)) {
      const maybeIpv4 = unwrapped.slice(mappedV4Prefix.length);
      if (isIP(maybeIpv4) === 4) {
        return { address: maybeIpv4, family: "ipv4" };
      }
    }
    return { address: unwrapped, family: "ipv6" };
  }
  return undefined;
}

function classifyHostRisk(hostname: string): HostRisk | undefined {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "localhost";
  }
  if (METADATA_HOSTNAMES.has(hostname)) {
    return "metadata";
  }

  const parsedIp = parseIpHost(hostname);
  if (!parsedIp) {
    return undefined;
  }

  if (METADATA_IP_BLOCKLIST.check(parsedIp.address, parsedIp.family)) {
    return "metadata";
  }
  if (LOOPBACK_IP_BLOCKLIST.check(parsedIp.address, parsedIp.family)) {
    return "loopback";
  }
  if (LINK_LOCAL_IP_BLOCKLIST.check(parsedIp.address, parsedIp.family)) {
    return "link-local";
  }
  if (PRIVATE_IP_BLOCKLIST.check(parsedIp.address, parsedIp.family)) {
    return "private";
  }
  return undefined;
}

function canonicalizeToolGatewayWsUrl(raw: string): {
  origin: string;
  key: string;
  hostname: string;
} {
  const input = raw.trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid gatewayUrl: ${input} (${message})`, { cause: error });
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`invalid gatewayUrl protocol: ${url.protocol} (expected ws:// or wss://)`);
  }
  if (url.username || url.password) {
    throw new Error("invalid gatewayUrl: credentials are not allowed");
  }
  if (url.search || url.hash) {
    throw new Error("invalid gatewayUrl: query/hash not allowed");
  }
  // Agents/tools expect the gateway websocket on the origin, not arbitrary paths.
  if (url.pathname && url.pathname !== "/") {
    throw new Error("invalid gatewayUrl: path not allowed");
  }

  const hostname = normalizeHostname(url.hostname);
  const origin = url.origin;
  // Key: protocol + host only, lowercased. (host includes IPv6 brackets + port when present)
  const key = `${url.protocol}//${url.host.toLowerCase()}`;
  return { origin, key, hostname };
}

function validateGatewayUrlOverrideForAgentTools(urlOverride: string): string {
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  const allowed = new Set<string>([
    `ws://127.0.0.1:${port}`,
    `wss://127.0.0.1:${port}`,
    `ws://localhost:${port}`,
    `wss://localhost:${port}`,
    `ws://[::1]:${port}`,
    `wss://[::1]:${port}`,
  ]);

  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
  if (remoteUrl) {
    try {
      const remote = canonicalizeToolGatewayWsUrl(remoteUrl);
      allowed.add(remote.key);
    } catch {
      // ignore: misconfigured remote url; tools should fall back to default resolution.
    }
  }

  const parsed = canonicalizeToolGatewayWsUrl(urlOverride);
  if (allowed.has(parsed.key)) {
    return parsed.origin;
  }

  const hostRisk = classifyHostRisk(parsed.hostname);
  if (hostRisk) {
    throw new Error(
      [
        "gatewayUrl override rejected.",
        `Blocked ${hostRisk} host: ${parsed.hostname}.`,
        "Only allowlisted gateway endpoints are accepted for agent tools.",
      ].join(" "),
    );
  }

  throw new Error(
    [
      "gatewayUrl override rejected.",
      `Allowed: ws(s) loopback on port ${port} (127.0.0.1/localhost/[::1])`,
      "Or: configure gateway.remote.url and omit gatewayUrl to use the configured remote gateway.",
    ].join(" "),
  );
}

export function resolveGatewayOptions(opts?: GatewayCallOptions) {
  // Prefer an explicit override; otherwise let callGateway choose based on config.
  const url =
    typeof opts?.gatewayUrl === "string" && opts.gatewayUrl.trim()
      ? validateGatewayUrlOverrideForAgentTools(opts.gatewayUrl)
      : undefined;
  const token =
    typeof opts?.gatewayToken === "string" && opts.gatewayToken.trim()
      ? opts.gatewayToken.trim()
      : undefined;
  const timeoutMs =
    typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 30_000;
  return { url, token, timeoutMs };
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { expectFinal?: boolean },
) {
  const gateway = resolveGatewayOptions(opts);
  return await callGateway<T>({
    url: gateway.url,
    token: gateway.token,
    method,
    params,
    timeoutMs: gateway.timeoutMs,
    expectFinal: extra?.expectFinal,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
}
