# 🦞 ZulipClaw

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A Zulip-optimised AI assistant gateway with deep Zulip integration, sub-agent orchestration, and self-hosted control.

## What is ZulipClaw?

ZulipClaw is a fork of [OpenClaw](https://github.com/openclaw/openclaw) tuned specifically for [Zulip](https://zulip.com) as a first-class messaging surface. Where stock OpenClaw treats Zulip as one of several channels, ZulipClaw adds native thread awareness, topic-scoped todo boards, full message mutation actions, and Zulip-specific formatting support. It also ships opinionated improvements to sub-agent orchestration, model provider support, and security hardening - some cherry-picked from upstream, some custom.

## ✨ Key Features

### 🟦 Zulip-Native Integration

- **Full message actions** - search, edit, delete, react, channel-list, and member-info all exposed as agent tools
- **Topic-scoped todo lists** - auto-updating boards backed by real Zulip messages; one active list per topic, visible in context
- **Stream/topic routing** - agents are thread-aware; responses route to the correct stream and topic automatically
- **Zulip formatting** - tables, spoiler blocks, and LaTeX rendered correctly; no workarounds needed
- **Gated mutations** - channel mutation actions (edit, delete) are behind explicit config flags to prevent accidents

### 🤖 Sub-Agent Orchestration

- **Native watchdog** - background sub-agents are automatically monitored; stalls and failures surface without polling
- **Progress relay** - tool calls from sub-agents stream back with nested spoiler UX, so long tasks stay readable
- **Thinking preview** - reasoning tokens, context usage metrics, and compaction metadata shown inline
- **Spawn tree visualisation** - see the full hierarchy of running and completed agents at a glance
- **Duration tracking** - running indicator and footer summaries on every agent turn

### 🧠 Model Support

- **OpenAI Codex provider** - `gpt-5.3-codex` and `gpt-5.4` with WebSocket-first transport for lower latency
- **Ollama Cloud** - provider support for self-hosted and cloud Ollama endpoints
- **Scope fallback** - model persists across retry iterations without resetting to defaults
- **Model alias system** - short aliases for quick switching (`/model sonnet`, `/model codex`, etc.)

### 🛠️ Developer Experience

- **Edit diffs in relay** - file edits show a compact diff in the tool spoiler, not just "file written"
- **Write previews** - new file writes show a content preview before confirming
- **Grouped reads** - multiple file reads in a single turn are collapsed into one spoiler block
- **Reasoning streaming** - Anthropic thinking/reasoning events stream in real time
- **Sandbox badge** - tool count and sandbox state visible in every response footer
- **Auth cooldown** - rate limit and auth failures include descriptive reasons, not just `rate_limit`

### 🔒 Security Hardening

- **SSRF guards** - web fetch and search tools enforce proxy-aware SSRF protection
- **Symlink escape prevention** - sandbox path alias guard blocks traversal via symlinks
- **Config include hardening** - malicious or recursive config includes are rejected at parse time
- **Node exec approvals** - paired device exec requests go through structured approval flow
- **Device metadata pinning** - paired node identity is validated against stored metadata on each request

### ⏰ Cron & Automation

- **Heartbeat policy** - configure direct heartbeat delivery policy per-agent without touching global config
- **Cron session keys** - cron jobs can specify a session key for routing and context isolation
- **Hook session routing** - isolated hook sessions route correctly without leaking into the main session

## Quick Start

Runtime: **Node >= 22**, **pnpm**

```bash
git clone https://github.com/jamie-dit/zulip-claw.git
cd zulip-claw
pnpm install
pnpm ui:build
pnpm build
```

Run the gateway:

```bash
pnpm gateway:watch   # development (watch mode)
pnpm gateway:start   # production
```

Common dev commands:

```bash
pnpm lint
pnpm test:fast
pnpm format
```

## Configuration

ZulipClaw uses the same configuration format as OpenClaw. Full docs at [docs.openclaw.ai](https://docs.openclaw.ai).

ZulipClaw-specific config highlights:

```jsonc
{
  "channel": {
    "zulip": {
      "server": "https://your-zulip.example.com",
      "email": "bot@your-zulip.example.com",
      "apiKey": "...",
      // Opt-in to message mutation actions
      "allowEdit": true,
      "allowDelete": false,
    },
  },
  "agents": {
    "main": {
      // Heartbeat delivery policy (ZulipClaw extension)
      "heartbeatPolicy": "direct",
    },
  },
}
```

See [docs.openclaw.ai](https://docs.openclaw.ai) for the full schema, model provider setup, and security options.

## Architecture

```text
Messaging channels (Zulip, Telegram, ...)
              |
              v
  +---------------------------+
  |   Gateway (control plane) |
  +-------------+-------------+
                |
     +----------+----------+
     |                     |
CLI / Web UI / agents    Paired device nodes
```

The gateway is the single control plane. It handles channel routing, session management, agent spawning, and tool dispatch. Paired nodes (mobile, desktop, server) connect outbound to the gateway and are controlled via the node tool.

## Relationship to OpenClaw

ZulipClaw is a downstream fork of [OpenClaw](https://github.com/openclaw/openclaw). We track upstream and regularly merge fixes and features. Changes that are Zulip-specific or opinionated live in this fork; generic improvements are contributed back upstream where appropriate.

If you don't need Zulip-specific features, use [OpenClaw](https://github.com/openclaw/openclaw) directly.

## Contributing

- Use focused PRs with clear test evidence
- Prefer small, reviewable commits
- For Zulip-specific changes, note whether the change is a candidate for upstreaming
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines

## License

MIT - see [LICENSE](LICENSE)
