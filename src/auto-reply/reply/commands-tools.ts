import { createOpenClawTools } from "../../agents/openclaw-tools.js";
import { getTodoTopicKey, getActiveTodoSnapshot } from "../../agents/todo-topic.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

function buildToolsReply(params: Parameters<CommandHandler>[0]): { text: string } {
  const tools = createOpenClawTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.command.channel as never,
    agentAccountId: params.ctx.AccountId ?? undefined,
    agentTo: params.ctx.OriginatingTo ?? params.command.to,
    agentThreadId: params.ctx.MessageThreadId,
    config: params.cfg,
    disableMessageTool: false,
  });

  const topicKey = getTodoTopicKey({
    sessionKey: params.sessionKey,
    agentTo: params.ctx.OriginatingTo ?? params.command.to,
    agentThreadId: params.ctx.MessageThreadId,
  });
  const todoSnapshot = getActiveTodoSnapshot(topicKey);

  const coreNames = tools.map((tool) => tool.name).toSorted();
  const lines = [
    "🧰 Tools",
    `Available (${coreNames.length}): ${coreNames.join(", ")}`,
    `Verbose tool debug: ${params.resolvedVerboseLevel === "full" ? "full" : params.resolvedVerboseLevel === "on" ? "summary" : "off"}`,
  ];
  if (todoSnapshot) {
    lines.push("", todoSnapshot);
  }
  return { text: lines.join("\n") };
}

export const handleToolsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (normalized !== "/tools") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /tools from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return { shouldContinue: false, reply: buildToolsReply(params) };
};
