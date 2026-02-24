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

## Power User Patterns

These AGENTS.md snippets are practical recommendations that work well in production. Copy what fits your setup.

### 1. Keep the Main Session Conversational — Delegate Everything Else

Running the main session on Opus and letting it do tool work is expensive and slow. The pattern that actually works: the main session is **conversational only**. Every tool call gets spawned out to a sub-agent on a cheaper/faster model.

Add this to your `AGENTS.md`:

```markdown
## Sub-Agent Delegation (MANDATORY)

The main session is conversational only. It NEVER calls non-whitelisted tools directly.

### Permitted main-session tools (exhaustive whitelist)
- memory_search / memory_get
- session_status
- sessions_spawn
- subagents
- sessions_list / sessions_history
- cron
- message
- tts
- gateway (config.get and restart only)

### Everything else → sub-agent. No exceptions.
If you are about to call read, exec, web_search, web_fetch, browser, edit, write,
image, canvas, nodes, or ANY unlisted tool — stop and spawn a sub-agent instead.

### Model configuration
Main session: anthropic/claude-opus-4-5 (or your preferred flagship model)
Sub-agents: anthropic/claude-sonnet-4-5 (faster + cheaper for tool work)

Set in openclaw.json:
agents.defaults.model = "anthropic/claude-opus-4-5"
Sub-agents inherit this; override per-spawn with model= param if needed.

### Self-check before every tool call
"Is this tool on the whitelist?" → If NO, spawn a sub-agent.
```

This keeps the main session snappy and your expensive model budget focused on reasoning, not file reads.

---

### 2. Increase Concurrent Sub-Agent Capacity

The default `maxChildrenPerAgent` is conservative. If you're running parallel research tasks, multi-step workflows, or independent background jobs, bump it:

In `openclaw.json`:

```json5
agents: {
  defaults: {
    subagents: {
      maxChildrenPerAgent: 8,  // default is 3; 5–8 works well for power users
      maxSpawnDepth: 2,
    },
  },
},
```

With 8 slots you can run things like: web research + code changes + data fetch + report generation all in parallel without hitting the concurrency wall. Each sub-agent is isolated, so they don't interfere with each other.

---

### 3. Topic Stickiness — Sub-Agents Reply Where They're Told

Sub-agents should always post back to the Zulip topic that triggered them, not the stream root or a default topic. ZulipClaw enforces this automatically via injected `## Reply Routing` blocks, but your AGENTS.md should reinforce it for sub-agents you spawn manually:

```markdown
## Zulip Reply Routing (MANDATORY for sub-agents)

When spawning a sub-agent, always include the originating topic in the task prompt:

  ## Reply Routing (MANDATORY)
  Origin topic: <origin_topic>
  For every Zulip update/final message, send to:
  message(action="send", channel="zulip", target="stream:marcel#<origin_topic>", message="...")
  Never send to bare stream:marcel. Never omit topic.

Pre-send check:
1. Read origin_topic from the triggering context
2. Build target="stream:marcel#<origin_topic>"
3. Verify target contains "#"
4. Send

Never rely on defaultTopic for sub-agent callbacks.
```

This prevents sub-agent results from appearing in the wrong topic (or not appearing at all).

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
