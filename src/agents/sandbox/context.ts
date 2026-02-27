import fs from "node:fs/promises";
import { DEFAULT_BROWSER_EVALUATE_ENABLED } from "../../browser/constants.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "../../browser/control-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { loadSessionEntry } from "../../gateway/session-utils.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer, execDocker } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { applyNetworkRestrictions, removeNetworkRestrictions } from "./network-restrict.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      }
    }
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return { agentWorkspaceDir, scopeKey, sandboxWorkspaceDir, workspaceDir };
}

/**
 * Load the session entry for sandbox override checks.
 * Returns undefined if the session store cannot be loaded (e.g., during tests).
 */
function loadSessionEntryForSandbox(sessionKey: string): SessionEntry | undefined {
  try {
    const { entry } = loadSessionEntry(sessionKey);
    return entry;
  } catch {
    return undefined;
  }
}

function resolveSandboxSession(params: { config?: OpenClawConfig; sessionKey?: string }) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const sessionEntry = loadSessionEntryForSandbox(rawSessionKey);
  const forceSandbox = sessionEntry?.forceSandbox === true;

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
    forceSandbox,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);

  // Apply per-session sandbox overrides from the session entry.
  if (sessionEntry?.sandboxWorkspaceAccess) {
    cfg.workspaceAccess = sessionEntry.sandboxWorkspaceAccess;
  }

  // When network restrictions are requested, switch from "none" to "bridge"
  // and configure public DNS so outbound internet access works.
  if (sessionEntry?.sandboxNetworkRestrictions) {
    if (cfg.docker.network === "none") {
      cfg.docker = { ...cfg.docker, network: "bridge" };
    }
    if (!cfg.docker.dns?.length) {
      cfg.docker = { ...cfg.docker, dns: ["8.8.8.8", "1.1.1.1"] };
    }
  }

  return { rawSessionKey, runtime, cfg, sessionEntry };
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg, sessionEntry } = resolved;

  await maybePruneSandboxes(cfg);

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
  });

  // Apply network restrictions (block private IPs) when requested.
  // Fail-closed: if iptables rules cannot be applied, tear down the container
  // rather than leaving it on bridge networking without restrictions.
  if (sessionEntry?.sandboxNetworkRestrictions) {
    try {
      await applyNetworkRestrictions(containerName);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      defaultRuntime.error?.(
        `Sandbox network restriction failed for ${containerName}: ${message}. ` +
          `Removing container to prevent unrestricted bridge access.`,
      );
      // Tear down the container - fail closed rather than running unrestricted.
      try {
        await removeNetworkRestrictions(containerName).catch(() => undefined);
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
      } catch {
        // Best-effort cleanup
      }
      return null;
    }
  }

  const evaluateEnabled =
    params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth = params.config ?? loadConfig();
        let browserAuth = resolveBrowserControlAuth(cfgForAuth);
        try {
          const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
          browserAuth = ensured.auth;
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
        }
        return browserAuth;
      })()
    : undefined;
  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg,
    evaluateEnabled,
    bridgeAuth,
  });

  const sandboxContext: SandboxContext = {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: cfg.workspaceAccess,
    containerName,
    containerWorkdir: cfg.docker.workdir,
    docker: cfg.docker,
    tools: cfg.tools,
    browserAllowHostControl: cfg.browser.allowHostControl,
    browser: browser ?? undefined,
  };

  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
