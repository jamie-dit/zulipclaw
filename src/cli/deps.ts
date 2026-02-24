import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

export type CliDeps = {
  sendMessageWhatsApp: NonNullable<OutboundSendDeps["sendWhatsApp"]>;
  sendMessageTelegram: NonNullable<OutboundSendDeps["sendTelegram"]>;
  sendMessageDiscord: NonNullable<OutboundSendDeps["sendDiscord"]>;
  sendMessageSlack: NonNullable<OutboundSendDeps["sendSlack"]>;
  sendMessageSignal: NonNullable<OutboundSendDeps["sendSignal"]>;
  sendMessageIMessage: NonNullable<OutboundSendDeps["sendIMessage"]>;
};

const unsupportedSend = async (): Promise<never> => {
  throw new Error("Only Zulip channel support is bundled in this build.");
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: unsupportedSend,
    sendMessageTelegram: unsupportedSend,
    sendMessageDiscord: unsupportedSend,
    sendMessageSlack: unsupportedSend,
    sendMessageSignal: unsupportedSend,
    sendMessageIMessage: unsupportedSend,
  } as CliDeps;
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}

export function logWebSelfId(): void {
  // no-op: web/whatsapp channel removed from Zulip-only build
}
