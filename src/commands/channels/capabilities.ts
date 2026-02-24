import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelCapabilities } from "../../channels/plugins/types.js";
import { danger } from "../../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export type ChannelsCapabilitiesOptions = {
  channel?: string;
  account?: string;
  timeout?: string;
  json?: boolean;
};

type ChannelCapabilitiesReport = {
  channel: string;
  accountId: string;
  accountName?: string;
  configured?: boolean;
  enabled?: boolean;
  support?: ChannelCapabilities;
  actions?: string[];
  probe?: unknown;
};

function normalizeTimeout(raw: unknown, fallback = 10_000) {
  const value = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function formatSupport(capabilities?: ChannelCapabilities) {
  if (!capabilities) {
    return "unknown";
  }
  const bits: string[] = [];
  if (capabilities.chatTypes?.length) {
    bits.push(`chatTypes=${capabilities.chatTypes.join(",")}`);
  }
  if (capabilities.polls) {
    bits.push("polls");
  }
  if (capabilities.reactions) {
    bits.push("reactions");
  }
  if (capabilities.edit) {
    bits.push("edit");
  }
  if (capabilities.unsend) {
    bits.push("unsend");
  }
  if (capabilities.reply) {
    bits.push("reply");
  }
  if (capabilities.effects) {
    bits.push("effects");
  }
  if (capabilities.groupManagement) {
    bits.push("groupManagement");
  }
  if (capabilities.threads) {
    bits.push("threads");
  }
  if (capabilities.media) {
    bits.push("media");
  }
  if (capabilities.nativeCommands) {
    bits.push("nativeCommands");
  }
  if (capabilities.blockStreaming) {
    bits.push("blockStreaming");
  }
  return bits.length ? bits.join(" ") : "none";
}

async function resolveChannelReports(params: {
  cfg: Record<string, unknown>;
  channelId: string;
  timeoutMs: number;
  accountOverride?: string;
}): Promise<ChannelCapabilitiesReport[]> {
  const plugin = getChannelPlugin(params.channelId);
  if (!plugin?.config) {
    return [];
  }

  const accountIds = plugin.config.listAccountIds(params.cfg as never);
  const fallbackAccountId = resolveChannelDefaultAccountId({
    plugin,
    cfg: params.cfg as never,
  });

  const selectedIds = params.accountOverride?.trim()
    ? [params.accountOverride.trim()]
    : accountIds.length > 0
      ? accountIds
      : [fallbackAccountId];

  const reports: ChannelCapabilitiesReport[] = [];
  for (const accountId of selectedIds) {
    const account = plugin.config.resolveAccount(params.cfg as never, accountId);
    const snapshot = plugin.config.describeAccount?.(account, params.cfg as never);
    const configured = await plugin.config.isConfigured?.(account, params.cfg as never);
    const enabled = plugin.config.isEnabled?.(account, params.cfg as never);
    const actions = plugin.actions?.map((action) => action.name).toSorted() ?? [];

    let probe: unknown;
    if (plugin.status?.probeAccount && configured !== false && enabled !== false) {
      try {
        probe = await plugin.status.probeAccount({
          account,
          timeoutMs: params.timeoutMs,
          cfg: params.cfg as never,
        });
      } catch (err) {
        probe = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    reports.push({
      channel: plugin.id,
      accountId,
      accountName: snapshot?.name,
      configured,
      enabled,
      support: plugin.capabilities,
      actions,
      probe,
    });
  }

  return reports;
}

export async function channelsCapabilitiesCommand(
  opts: ChannelsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const timeoutMs = normalizeTimeout(opts.timeout, 10_000);
  const rawChannel = typeof opts.channel === "string" ? opts.channel.trim().toLowerCase() : "";

  if (opts.account && (!rawChannel || rawChannel === "all")) {
    runtime.error(danger("--account requires a specific --channel."));
    runtime.exit(1);
    return;
  }

  const plugins = listChannelPlugins();
  const selected =
    !rawChannel || rawChannel === "all"
      ? plugins
      : (() => {
          const plugin = getChannelPlugin(rawChannel);
          return plugin ? [plugin] : null;
        })();

  if (!selected || selected.length === 0) {
    runtime.error(danger(`Unknown channel "${rawChannel}".`));
    runtime.exit(1);
    return;
  }

  const reports: ChannelCapabilitiesReport[] = [];
  for (const plugin of selected) {
    reports.push(
      ...(await resolveChannelReports({
        cfg,
        channelId: plugin.id,
        timeoutMs,
        accountOverride: opts.account,
      })),
    );
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ channels: reports }, null, 2));
    return;
  }

  const lines: string[] = [];
  for (const report of reports) {
    const label = formatChannelAccountLabel({
      channel: report.channel,
      accountId: report.accountId,
      name: report.accountName,
      channelStyle: theme.accent,
      accountStyle: theme.heading,
    });
    lines.push(theme.heading(label));
    lines.push(`Support: ${formatSupport(report.support)}`);
    if (report.actions && report.actions.length > 0) {
      lines.push(`Actions: ${report.actions.join(", ")}`);
    }
    if (report.configured === false || report.enabled === false) {
      const configuredLabel = report.configured === false ? "not configured" : "configured";
      const enabledLabel = report.enabled === false ? "disabled" : "enabled";
      lines.push(`Status: ${configuredLabel}, ${enabledLabel}`);
    }
    if (report.probe && typeof report.probe === "object") {
      const ok = (report.probe as { ok?: unknown }).ok;
      if (ok === true) {
        lines.push(theme.success("Probe: ok"));
      } else if (ok === false) {
        const error = (report.probe as { error?: unknown }).error;
        const errorText =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : error != null
                ? JSON.stringify(error)
                : "failed";
        lines.push(`Probe: ${theme.error(errorText)}`);
      } else {
        lines.push(`Probe: ${JSON.stringify(report.probe)}`);
      }
    }
    lines.push("");
  }

  runtime.log(lines.join("\n").trimEnd());
}
