# ZulipClaw

A Zulip-optimised fork of [OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI assistant platform.

ZulipClaw is built for power users who run their AI assistant primarily through [Zulip](https://zulip.com). It includes Zulip-specific enhancements, performance optimisations, and quality-of-life improvements on top of the upstream OpenClaw project.

## Key Differences from OpenClaw

- **Zulip-first experience** — optimised message handling, topic awareness, stream routing
- **Enhanced session management** — improved session store reliability
- **Power user features** — sub-agent orchestration, skill packs, advanced routing
- **Bundled skills** — 29 ready-to-use skills for common tasks

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

See the [OpenClaw documentation](https://docs.openclaw.ai) for configuration basics. ZulipClaw is compatible with all OpenClaw configuration options.

### Running

```bash
pnpm start
```

## Bundled Skills

ZulipClaw ships with 29 community skills in `skills/`:

| Category | Skills |
|----------|--------|
| **Productivity** | apple-notes, apple-reminders, notion, obsidian, himalaya (email) |
| **Development** | github, gh-issues, coding-agent, skill-creator, mcporter |
| **Media** | gifgrep, video-frames, nano-banana-pro, nano-pdf, camsnap |
| **Communication** | imsg, sag (TTS), openai-whisper (STT) |
| **Smart Home** | blucli, sonoscli, peekaboo |
| **Utilities** | weather, goplaces, summarize, blogwatcher, healthcheck, gemini, tmux |
| **Security** | 1password |

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
