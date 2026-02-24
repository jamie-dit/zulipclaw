import type { LogLevel } from "../../logging/levels.js";

export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

type AnyFn = (...args: unknown[]) => unknown;

export type PluginRuntime = {
  version: string;
  config: {
    loadConfig: AnyFn;
    writeConfigFile: AnyFn;
  };
  system: {
    enqueueSystemEvent: AnyFn;
    runCommandWithTimeout: AnyFn;
    formatNativeDependencyHint: AnyFn;
  };
  media: {
    loadWebMedia: AnyFn;
    detectMime: AnyFn;
    mediaKindFromMime: AnyFn;
    isVoiceCompatibleAudio: AnyFn;
    getImageMetadata: AnyFn;
    resizeToJpeg: AnyFn;
    [key: string]: unknown;
  };
  tts: {
    textToSpeechTelephony: AnyFn;
    [key: string]: unknown;
  };
  tools: {
    createMemoryGetTool: AnyFn;
    createMemorySearchTool: AnyFn;
    registerMemoryCli: AnyFn;
    [key: string]: unknown;
  };
  channel: {
    text: {
      chunkByNewline: AnyFn;
      chunkMarkdownText: AnyFn;
      chunkMarkdownTextWithMode: AnyFn;
      chunkText: AnyFn;
      chunkTextWithMode: AnyFn;
      resolveChunkMode: AnyFn;
      resolveTextChunkLimit: AnyFn;
      hasControlCommand: AnyFn;
      resolveMarkdownTableMode: AnyFn;
      convertMarkdownTables: AnyFn;
      [key: string]: unknown;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: AnyFn;
      createReplyDispatcherWithTyping: AnyFn;
      resolveEffectiveMessagesConfig: AnyFn;
      resolveHumanDelayConfig: AnyFn;
      dispatchReplyFromConfig: AnyFn;
      finalizeInboundContext: AnyFn;
      formatAgentEnvelope: AnyFn;
      formatInboundEnvelope: AnyFn;
      resolveEnvelopeFormatOptions: AnyFn;
      [key: string]: unknown;
    };
    routing: {
      resolveAgentRoute: AnyFn;
    };
    pairing: {
      buildPairingReply: AnyFn;
      readAllowFromStore: AnyFn;
      upsertPairingRequest: AnyFn;
    };
    media: {
      fetchRemoteMedia: AnyFn;
      saveMediaBuffer: AnyFn;
    };
    activity: {
      record: AnyFn;
      get: AnyFn;
    };
    session: {
      resolveStorePath: AnyFn;
      readSessionUpdatedAt: AnyFn;
      recordSessionMetaFromInbound: AnyFn;
      recordInboundSession: AnyFn;
      updateLastRoute: AnyFn;
    };
    mentions: {
      buildMentionRegexes: AnyFn;
      matchesMentionPatterns: AnyFn;
      matchesMentionWithExplicit: AnyFn;
    };
    reactions: {
      shouldAckReaction: AnyFn;
      removeAckReactionAfterReply: AnyFn;
    };
    groups: {
      resolveGroupPolicy: AnyFn;
      resolveRequireMention: AnyFn;
    };
    debounce: {
      createInboundDebouncer: AnyFn;
      resolveInboundDebounceMs: AnyFn;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers: AnyFn;
      isControlCommandMessage: AnyFn;
      shouldComputeCommandAuthorized: AnyFn;
      shouldHandleTextCommands: AnyFn;
    };
    [key: string]: unknown;
  };
  logging: {
    shouldLogVerbose: AnyFn;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: {
        level?: LogLevel;
      },
    ) => RuntimeLogger;
  };
};
