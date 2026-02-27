import { execIptables, execShellCommand } from "./network-restrict-exec.js";

/**
 * Private/reserved IP ranges to block from sandbox containers.
 * These prevent sandboxed code from reaching internal services, metadata endpoints, etc.
 */
const BLOCKED_RANGES = [
  "10.0.0.0/8", // RFC1918 Class A private
  "172.16.0.0/12", // RFC1918 Class B private
  "192.168.0.0/16", // RFC1918 Class C private
  "169.254.0.0/16", // Link-local
  "127.0.0.0/8", // Loopback (defense-in-depth; Docker bridge isolates this already)
];

/**
 * Resolve the container's IP address on its primary network.
 * Uses `docker inspect` directly (via execShellCommand) to avoid circular
 * imports with docker.ts which imports this module for cleanup.
 */
async function getContainerIp(containerName: string): Promise<string | null> {
  const result = await execShellCommand("docker", [
    "inspect",
    "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerName,
  ]);
  if (result.code !== 0) {
    return null;
  }
  const ip = result.stdout.trim();
  return ip || null;
}

/**
 * Check if an iptables rule already exists (to avoid duplicates).
 */
async function iptablesRuleExists(args: string[]): Promise<boolean> {
  const result = await execIptables(["-C", ...args]);
  return result.code === 0;
}

/**
 * Apply network restrictions to a sandbox container by blocking access to
 * private/reserved IP ranges via iptables DOCKER-USER chain rules.
 *
 * The container must be running and connected to a bridge network (not "none").
 * Uses the container's IP address to scope the rules.
 *
 * Idempotent: checks for existing rules before adding.
 */
export async function applyNetworkRestrictions(containerName: string): Promise<void> {
  const ip = await getContainerIp(containerName);
  if (!ip) {
    throw new Error(`Cannot resolve IP for container ${containerName}`);
  }

  for (const range of BLOCKED_RANGES) {
    const ruleArgs = ["DOCKER-USER", "-s", ip, "-d", range, "-j", "DROP"];
    const exists = await iptablesRuleExists(ruleArgs);
    if (!exists) {
      await execIptables(["-I", ...ruleArgs]);
    }
  }
}

/**
 * Remove network restriction rules for a container.
 * Called during container cleanup to avoid stale iptables rules.
 */
export async function removeNetworkRestrictions(containerName: string): Promise<void> {
  const ip = await getContainerIp(containerName);
  if (!ip) {
    return; // Container already gone or no IP
  }

  for (const range of BLOCKED_RANGES) {
    const ruleArgs = ["DOCKER-USER", "-s", ip, "-d", range, "-j", "DROP"];
    const exists = await iptablesRuleExists(ruleArgs);
    if (exists) {
      await execIptables(["-D", ...ruleArgs]);
    }
  }
}

export const __testing = {
  BLOCKED_RANGES,
  getContainerIp,
} as const;
