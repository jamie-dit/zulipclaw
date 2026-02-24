# ZulipClaw

A Zulip-optimised fork of [OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI assistant platform.

ZulipClaw is built for power users who run their AI assistant primarily through [Zulip](https://zulip.com). It takes the solid OpenClaw foundation and adds deep Zulip integration: topic-aware routing, native formatting, sub-agent orchestration that respects Zulip's stream/topic model, and reliability improvements for long-running background work.

If you're running an AI assistant in Zulip and want it to feel like a first-class citizen rather than a bolted-on chatbot, ZulipClaw is for you.

---

## What's Different from OpenClaw

### 🎯 Zulip-Native Topic & Stream Routing

ZulipClaw treats Zulip's stream/topic model as a core primitive, not an afterthought:

- **Topic-aware message delivery** — all outbound messages are routed to explicit `stream:name#topic` targets. The plugin parses, normalises, and validates stream/topic targets throughout the stack (`targets.ts`, `normalize.ts`).
- **Sub-agent topic stickiness** — when a sub-agent is spawned from a conversation in a specific topic, it posts results back to *that exact topic*, not a generic stream root. This is enforced via mandatory `## Reply Routing` blocks automatically injected into every sub-agent task prompt (`subagent-spawn.ts → appendMandatorySpawnTaskBlocks()`).
- **Progress updates routed to origin** — sub-agents send periodic progress updates to the same topic that triggered them, so you always know where to look for results.
- **Default topic fallback** — configurable `defaultTopic` per account, used when no topic is specified, so messages never land in an unexpected place.

### 🤖 Sub-Agent Orchestration

ZulipClaw has a full sub-agent lifecycle system designed for Zulip's conversational model:

- **Spawn / steer / kill** — the `subagents` tool lets you spawn background workers, steer them with new instructions (triggering a restart with context), or kill them outright. All from within a Zulip conversation.
- **Depth-limited nesting** — sub-agents can spawn their own sub-agents, with configurable `maxSpawnDepth` to prevent runaway recursion.
- **Concurrency limits** — `maxChildrenPerAgent` prevents a single session from overwhelming the system.
- **Watchdog for frozen agents** — a built-in idle watchdog detects sub-agents that stop making progress. After 5 minutes of inactivity, it nudges the sub-agent with a steer message. If that fails, it marks the agent as frozen and notifies the user. Smart timeout extensions for long-running operations (exec commands, process polling, child sub-agent spawning) prevent false positives.
- **Gateway restart recovery** — if the gateway restarts while sub-agents are running, orphaned runs are automatically detected, their session history is read to gauge progress, and resumable tasks are re-spawned with context about what was already done (`subagent-restart-recovery.ts`). A Zulip summary is posted to the infra topic.

### 📋 Clean Conversation History with Spoiler Blocks

Tool calls are a core part of how AI agents work, but they're noisy. ZulipClaw keeps conversations readable:

- **Tool progress in spoiler blocks** — the `ToolProgressAccumulator` collects all tool calls for a run into a single Zulip message using Zulip's native `spoiler` block syntax. The message is created on the first tool call and edited (debounced) on subsequent ones, so you get one clean collapsible block instead of a stream of individual tool call messages.
- **Sub-agent completion in spoiler blocks** — when a sub-agent finishes, its output is wrapped in a `spoiler` block with a clear header (`✅ Sub-agent 'name' finished`). You see the result at a glance; expand the spoiler for details.
- **Live relay messages** — each running sub-agent gets a single Zulip message that's continuously edited with tool-call progress, model info, elapsed time, and tool count. Status emoji (🔄 running, ✅ done, ❌ error) and watchdog indicators (⏳ nudged, ⚠️ frozen) give you instant visual status.
- **Mirror topic support** — optionally mirror all sub-agent relay messages to a dedicated monitoring topic (`mirrorTopic` config), so you can watch all background work in one place without cluttering origin topics.
- **Backtick sanitisation** — tool output containing triple backticks is safely escaped with zero-width spaces so it never breaks the Zulip code fence rendering.

### 🔘 Reaction-Based Interactions

ZulipClaw uses Zulip's emoji reactions as an interactive UI:

- **Reaction buttons** — present numbered options (1️⃣ through 🔟) as emoji reactions on a message. Users respond by clicking a reaction instead of typing, enabling quick confirmations and choice prompts directly in Zulip.
- **Session-managed** — reaction button sessions are tracked with automatic timeout cleanup, so stale prompts don't accumulate.

### 🛡️ Reliability & Recovery

Built for always-on operation in production Zulip environments:

- **In-flight message checkpoints** — when processing an inbound Zulip message, the system writes a checkpoint to disk before dispatching to the agent. If the gateway crashes mid-processing, the checkpoint survives and can be recovered on restart. Checkpoints include retry counts and max-age guards to prevent infinite loops.
- **Mirror state persistence** — relay mirror message IDs are persisted to disk, so after a restart the system can edit stale mirror messages to show ❌ status instead of leaving them as false "running" indicators.
- **Atomic JSON state writes** — all persisted state (registry, mirror state, checkpoints) uses atomic file writes to prevent corruption from crashes during writes.
- **Zulip event queue resilience** — the monitor handles queue registration, keepalive, backoff on failures, and graceful cleanup. Recovery from network interruptions is automatic.

### 📦 52 Bundled Skills

ZulipClaw ships with 52 ready-to-use skills in `skills/`:

| Category | Skills |
|----------|--------|
| **Productivity** | apple-notes, apple-reminders, bear-notes, notion, obsidian, things-mac, trello, himalaya (email) |
| **Development** | github, gh-issues, coding-agent, skill-creator, mcporter, clawhub |
| **Media** | gifgrep, video-frames, nano-banana-pro, nano-pdf, camsnap, openai-image-gen |
| **Communication** | imsg, sag (TTS), openai-whisper, openai-whisper-api, voice-call, wacli, bluebubbles, discord, slack |
| **Smart Home** | blucli, sonoscli, openhue, peekaboo, eightctl |
| **Music** | songsee, spotify-player |
| **Utilities** | weather, goplaces, summarize, blogwatcher, healthcheck, gemini, tmux, oracle, canvas, food-order, session-logs, model-usage, sherpa-onnx-tts, ordercli, gog |
| **Security** | 1password |

---

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm

### Installation

```bash
git clone https://github.com/jamie-dit/zulipclaw.git
cd zulipclaw
pnpm install
pnpm build
```

### Configuration

See the [OpenClaw documentation](https://docs.openclaw.ai) for configuration basics. ZulipClaw is compatible with all OpenClaw configuration options, plus additional Zulip-specific settings:

| Config Key | Description |
|-----------|-------------|
| `channels.zulip.streams` | Streams to monitor |
| `channels.zulip.defaultTopic` | Fallback topic when none is specified |
| `agents.defaults.subagents.relay.enabled` | Enable/disable the live tool-progress relay |
| `agents.defaults.subagents.relay.level` | Relay verbosity: `tools`, `full`, or `summary` |
| `agents.defaults.subagents.relay.mirrorTopic` | Mirror all relay messages to a monitoring topic |
| `agents.defaults.subagents.maxSpawnDepth` | Maximum sub-agent nesting depth |
| `agents.defaults.subagents.maxChildrenPerAgent` | Max concurrent sub-agents per session |

### Recommended Configuration

Here's a practical starting config (`~/.openclaw/openclaw.json`) you can copy and adapt:

```json5
{
  // Gateway auth token — change this to a long random string
  gateway: {
    auth: {
      token: "change-me-to-a-long-random-token",
    },
  },

  // Model provider (set your preferred API key)
  providers: {
    anthropic: {
      apiKey: "your-anthropic-api-key",
    },
  },

  // Default model for the main agent and sub-agents
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-5",
      subagents: {
        // Enable live tool-progress relay to Zulip (recommended)
        relay: {
          enabled: true,
          // "tools" = show tool calls; "full" = include output; "summary" = compact
          level: "tools",
          // Optional: mirror all sub-agent relay messages to a dedicated monitoring topic
          // mirrorTopic: "infra",
        },
        // Prevent runaway sub-agent recursion
        maxSpawnDepth: 2,
        maxChildrenPerAgent: 5,
      },
    },
  },

  channels: {
    zulip: {
      enabled: true,

      // Zulip bot credentials
      baseUrl: "https://your-org.zulipchat.com",
      email: "your-bot-email@your-org.zulipchat.com",
      apiKey: "your-zulip-bot-api-key",

      // Streams to monitor (no leading "#")
      streams: ["general", "ai-assistant"],

      // Reply to every message in monitored streams/topics (default: true)
      alwaysReply: true,

      // Fallback topic when outbound messages omit a topic
      defaultTopic: "general chat",

      // Emoji reactions while the bot is working
      reactions: {
        enabled: true,
        onStart: "eyes",
        onSuccess: "check",
        onFailure: "warning",
        // Stage-based workflow reactions for richer status signalling
        workflow: {
          enabled: true,
          replaceStageReaction: true,
          minTransitionMs: 1500,
          stages: {
            queued: "hourglass",
            processing: "gear",
            toolRunning: "hammer",
            success: "check",
            failure: "warning",
          },
        },
      },
    },
  },
}
```

**Key values to replace:**
- `gateway.auth.token` — generate with `openssl rand -hex 32`
- `providers.anthropic.apiKey` — your Anthropic API key (or swap for OpenAI/Gemini/OpenRouter)
- `channels.zulip.baseUrl` — your Zulip organisation URL
- `channels.zulip.email` — your bot's email address (from Zulip bot settings)
- `channels.zulip.apiKey` — your bot's API key (from Zulip bot settings)
- `channels.zulip.streams` — streams you want the bot to monitor

### Running

```bash
pnpm start
```

---

## Upstream Sync

ZulipClaw tracks upstream OpenClaw. To sync:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream
git merge upstream/main
```

## License

[FSL-1.1-MIT](LICENSE.md) — Functional Source License with MIT future license. Each version converts to MIT two years after release.

## Contributing

Contributions welcome! Please open an issue or PR.
