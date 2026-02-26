import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, type Dispatcher } from "undici";
  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (isIpv4Address(strictIp)) {
      return isBlockedSpecialUseIpv4Address(strictIp, blockOptions);
    }
    if (isBlockedSpecialUseIpv6Address(strictIp)) {
      return true;
    }

    const isUnspecified =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 0;
    const isLoopback =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 1;
    if (isUnspecified || isLoopback) {
      return true;
    }

    const embeddedIpv4 = extractIpv4FromEmbeddedIpv6(hextets);
    if (embeddedIpv4) {
      return isPrivateIpv4(embeddedIpv4);
    }

    // IPv6 private/internal ranges
    // - link-local: fe80::/10
    // - site-local (deprecated, but internal): fec0::/10
    // - unique local: fc00::/7
    const first = hextets[0];
    if ((first & 0xffc0) === 0xfe80) {
      return true;
    }
    if ((first & 0xffc0) === 0xfec0) {
      return true;
    }
    if ((first & 0xfe00) === 0xfc00) {
      return true;
    }
    return false;
  }

  const ipv4 = parseIpv4(normalized);
  if (!ipv4) {
    return false;
  }
  return isPrivateIpv4(ipv4);
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

export function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof dnsLookupCb;
}): typeof dnsLookupCb {
  const normalizedHost = normalizeHostname(params.hostname);
  const fallback = params.fallback ?? dnsLookupCb;
  const fallbackLookup = fallback as unknown as (
    hostname: string,
    callback: LookupCallback,
  ) => void;
  const fallbackWithOptions = fallback as unknown as (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ) => void;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));
  let index = 0;

  return ((host: string, options?: unknown, callback?: unknown) => {
    const cb: LookupCallback =
      typeof options === "function" ? (options as LookupCallback) : (callback as LookupCallback);
    if (!cb) {
      return;
    }
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === "function" || options === undefined) {
        return fallbackLookup(host, cb);
      }
      return fallbackWithOptions(host, options, cb);
    }

    const opts =
      typeof options === "object" && options !== null
        ? (options as { all?: boolean; family?: number })
        : {};
    const requestedFamily =
      typeof options === "number" ? options : typeof opts.family === "number" ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;
    if (opts.all) {
      cb(null, usable as LookupAddress[]);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dnsLookupCb;
}

export type PinnedHostname = {
  hostname: string;
  addresses: string[];
  lookup: typeof dnsLookupCb;
};

export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  params: { lookupFn?: LookupFn; policy?: SsrFPolicy } = {},
): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new Error("Invalid hostname");
  }

  const allowPrivateNetwork = Boolean(params.policy?.allowPrivateNetwork);
  const allowedHostnames = normalizeHostnameSet(params.policy?.allowedHostnames);
  const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);
  const isExplicitAllowed = allowedHostnames.has(normalized);

  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
    throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);
  }

  if (!allowPrivateNetwork && !isExplicitAllowed) {
    if (isBlockedHostname(normalized)) {
      throw new SsrFBlockedError(`Blocked hostname: ${hostname}`);
    }

    if (isPrivateIpAddress(normalized)) {
      throw new SsrFBlockedError("Blocked: private/internal IP address");
    }
  }

  const lookupFn = params.lookupFn ?? dnsLookup;
  const results = await lookupFn(normalized, { all: true });
  if (results.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  if (!allowPrivateNetwork && !isExplicitAllowed) {
    for (const entry of results) {
      if (isPrivateIpAddress(entry.address)) {
        throw new SsrFBlockedError("Blocked: resolves to private/internal IP address");
      }
    }
  }

  const addresses = Array.from(new Set(results.map((entry) => entry.address)));
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }

  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

export async function resolvePinnedHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
): Promise<PinnedHostname> {
  return await resolvePinnedHostnameWithPolicy(hostname, { lookupFn });
}

export function createPinnedDispatcher(pinned: PinnedHostname): Dispatcher {
  return new Agent({
    connect: {
      lookup: pinned.lookup,
    },
  });
}

export async function closeDispatcher(dispatcher?: Dispatcher | null): Promise<void> {
  if (!dispatcher) {
    return;
  }
  const candidate = dispatcher as { close?: () => Promise<void> | void; destroy?: () => void };
  try {
    if (typeof candidate.close === "function") {
      await candidate.close();
      return;
    }
    if (typeof candidate.destroy === "function") {
      candidate.destroy();
    }
  } catch {
    // ignore dispatcher cleanup errors
  }
}

export async function assertPublicHostname(
  hostname: string,
  lookupFn: LookupFn = dnsLookup,
): Promise<void> {
  await resolvePinnedHostname(hostname, lookupFn);
}
