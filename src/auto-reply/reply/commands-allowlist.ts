import type { CommandHandler } from "./commands-types.js";

export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const raw = params.command.rawBodyNormalized?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("/allowlist")) {
    return null;
  }

  return {
    shouldContinue: false,
    reply: {
      text: "Allowlist management for non-Zulip channels has been removed in this Zulip-only build.",
    },
  };
};
