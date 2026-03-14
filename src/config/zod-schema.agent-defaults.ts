import { z } from "zod";
import { BUILTIN_PROMPT_SECTION_IDS } from "../agents/prompt-sections.js";
import {
  HeartbeatSchema,
  AgentSandboxSchema,
  AgentModelSchema,
  MemorySearchSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
} from "./zod-schema.core.js";

const PromptSectionSourceSchema = z.union([
  z.literal("builtin"),
  z.literal("file"),
  z.literal("inline"),
]);

const PromptSectionScopeSchema = z.union([
  z.literal("all"),
  z.literal("main"),
  z.literal("subagent"),
  z.literal("cron"),
]);

const PromptSectionPositionSchema = z.union([
  z.literal("after-skills"),
  z.literal("after-workspace"),
  z.literal("before-context"),
  z.literal("after-runtime"),
]);

const PromptSectionEntrySchema = z
  .object({
    id: z.string().min(1),
    heading: z.string().optional(),
    source: PromptSectionSourceSchema,
    path: z.string().optional(),
    content: z.string().optional(),
    enabled: z.boolean().optional(),
    scope: PromptSectionScopeSchema.optional(),
    position: PromptSectionPositionSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.source === "file") {
      if (!val.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`path` is required when source is "file"',
          path: ["path"],
        });
      }
      if (val.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`content` must not be set when source is "file"',
          path: ["content"],
        });
      }
    } else if (val.source === "inline") {
      if (val.content === undefined || val.content === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`content` is required when source is "inline"',
          path: ["content"],
        });
      }
      if (val.path !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`path` must not be set when source is "inline"',
          path: ["path"],
        });
      }
    } else if (val.source === "builtin") {
      if (val.path !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`path` must not be set when source is "builtin"',
          path: ["path"],
        });
      }
      if (val.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`content` must not be set when source is "builtin"',
          path: ["content"],
        });
      }
    }
  });

const PromptSectionsSchema = z
  .object({
    builtins: z
      .array(
        z.string().refine((val) => BUILTIN_PROMPT_SECTION_IDS.has(val), {
          message: `Unknown built-in section id. Valid ids: ${[...BUILTIN_PROMPT_SECTION_IDS].join(", ")}`,
        }),
      )
      .optional(),
    sections: z.array(PromptSectionEntrySchema).optional(),
  })
  .strict()
  .optional();

export const AgentDefaultsSchema = z
  .object({
    model: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
        overloadFallback: z
          .string()
          .optional()
          .describe(
            "Dedicated fallback model for provider overload errors (503/529). On overload, retries once with this model before the normal fallback chain.",
          ),
      })
      .strict()
      .optional(),
    imageModel: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
            params: z.record(z.string(), z.unknown()).optional(),
            /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
            streaming: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    workspace: z.string().optional(),
    repoRoot: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    bootstrapTotalMaxChars: z.number().int().positive().optional(),
    userTimezone: z.string().optional(),
    timeFormat: z.union([z.literal("auto"), z.literal("12"), z.literal("24")]).optional(),
    envelopeTimezone: z.string().optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    contextPruning: z
      .object({
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        ttl: z.string().optional(),
        keepLastAssistants: z.number().int().nonnegative().optional(),
        softTrimRatio: z.number().min(0).max(1).optional(),
        hardClearRatio: z.number().min(0).max(1).optional(),
        minPrunableToolChars: z.number().int().nonnegative().optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        softTrim: z
          .object({
            maxChars: z.number().int().nonnegative().optional(),
            headChars: z.number().int().nonnegative().optional(),
            tailChars: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional(),
        maxHistoryShare: z.number().min(0.1).max(0.9).optional(),
        model: z.string().optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            prompt: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    reasoningDefault: z.union([z.literal("off"), z.literal("on"), z.literal("stream")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    imageMaxDimensionPx: z.number().int().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    heartbeat: HeartbeatSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        maxSpawnDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents.",
          ),
        maxChildrenPerAgent: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Maximum number of active children a single agent session can spawn (default: 5).",
          ),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: AgentModelSchema.optional(),
        thinking: z.string().optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            level: z
              .union([z.literal("tools"), z.literal("full"), z.literal("summary")])
              .optional(),
            mirrorTopic: z.string().optional(),
          })
          .strict()
          .optional(),
        bootstrapFiles: z
          .array(z.string())
          .optional()
          .describe(
            'Workspace files to include in sub-agent bootstrap context. Default: ["AGENTS.md", "TOOLS.md", "SOUL.md", "USER.md", "IDENTITY.md"]',
          ),
        restartRecovery: z
          .object({
            notifyTarget: z
              .string()
              .optional()
              .describe(
                'Delivery target for the Zulip summary sent after restart recovery (e.g. "stream:my-stream#infra"). When unset, the summary is skipped.',
              ),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    promptSections: PromptSectionsSchema,
    sandbox: AgentSandboxSchema,
  })
  .strict()
  .optional();
