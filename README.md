# 🦞 OpenClaw - Personal AI Assistant

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
    <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
  </picture>
</p>

<p align="center"><strong>EXFOLIATE! EXFOLIATE!</strong></p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

OpenClaw is a personal AI assistant that runs on your own devices.

It gives you one control plane (Gateway) for messaging channels, tools, sessions, and device nodes - while still feeling local and always available.

[Website](https://openclaw.ai) · [Docs](https://docs.openclaw.ai) · [Getting started](https://docs.openclaw.ai/start/getting-started) · [Wizard](https://docs.openclaw.ai/start/wizard) · [Security](https://docs.openclaw.ai/gateway/security) · [Docker](https://docs.openclaw.ai/install/docker) · [Nix](https://github.com/openclaw/nix-openclaw) · [FAQ](https://docs.openclaw.ai/start/faq) · [Discord](https://discord.gg/clawd)

## Why OpenClaw

- Local-first Gateway with full control of sessions, channels, and tools.
- Multi-channel inbox (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage/BlueBubbles, Teams, Matrix, Zalo, WebChat).
- Built-in tools for browser automation, canvas, nodes, cron, and session orchestration.
- Optional companion apps and nodes for macOS, iOS, and Android.

## Install (recommended)

Runtime: **Node >= 22**.

```bash
npm install -g openclaw@latest
# or: pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

The onboarding wizard is the preferred setup path and works on macOS, Linux, and Windows (via WSL2).

## Quick start

```bash
# Guided setup (recommended)
openclaw onboard --install-daemon

# Run gateway in foreground (optional while testing)
openclaw gateway --port 18789 --verbose

# Send a message
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# Ask the assistant
openclaw agent --message "Ship checklist" --thinking high
```

Upgrading? See [Updating](https://docs.openclaw.ai/install/updating) and run `openclaw doctor`.

## Models and auth

OpenClaw supports multiple providers and model failover.

- [Model configuration](https://docs.openclaw.ai/concepts/models)
- [Auth profile rotation + failover](https://docs.openclaw.ai/concepts/model-failover)

OAuth subscriptions commonly used:

- [Anthropic](https://www.anthropic.com/) (Claude Pro/Max)
- [OpenAI](https://openai.com/) (ChatGPT/Codex)

## From source (development)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm ui:build
pnpm build

pnpm openclaw onboard --install-daemon
pnpm gateway:watch
```

`pnpm openclaw ...` runs TypeScript directly via `tsx`. `pnpm build` outputs `dist/`.

## Security defaults (important)

Inbound DMs should be treated as untrusted input.

Default behavior for major chat channels:

- DM policy defaults to pairing (`dmPolicy="pairing"`): unknown senders receive a short code and are not processed until approved.
- Approve with `openclaw pairing approve <channel> <code>`.
- To open inbound DMs, set `dmPolicy="open"` and include `"*"` in allowlists.

Run `openclaw doctor` to detect risky DM policy configuration.

## Architecture (short)

```text
Messaging channels
      |
      v
+---------------------------+
|   Gateway (control plane) |
|   ws://127.0.0.1:18789    |
+-------------+-------------+
              |
   +----------+----------+
   |                     |
Pi agent / CLI / WebChat | macOS+iOS+Android nodes
```

## Channels and platforms

| Area              | Docs                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| Channels overview | [docs.openclaw.ai/channels](https://docs.openclaw.ai/channels)                   |
| macOS app         | [docs.openclaw.ai/platforms/macos](https://docs.openclaw.ai/platforms/macos)     |
| iOS node          | [docs.openclaw.ai/platforms/ios](https://docs.openclaw.ai/platforms/ios)         |
| Android node      | [docs.openclaw.ai/platforms/android](https://docs.openclaw.ai/platforms/android) |
| Browser tool      | [docs.openclaw.ai/tools/browser](https://docs.openclaw.ai/tools/browser)         |
| Skills            | [docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills)           |

## Remote access

You can run Gateway on Linux and connect from apps/clients over:

- [Tailscale Serve/Funnel](https://docs.openclaw.ai/gateway/tailscale)
- [SSH tunnels](https://docs.openclaw.ai/gateway/remote)

Gateway executes host tools by default; node actions execute on paired devices.

## Configuration

Minimal `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
}
```

For all keys and examples: [Configuration reference](https://docs.openclaw.ai/gateway/configuration).

## Development channels

- **stable**: tagged releases (`latest`)
- **beta**: prereleases (`beta`)
- **dev**: moving `main` (`dev`)

Switch with:

```bash
openclaw update --channel stable|beta|dev
```

See [Development channels](https://docs.openclaw.ai/install/development-channels).

## Contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md)
- Browse open work in [Issues](https://github.com/openclaw/openclaw/issues)
- Join the [Discord community](https://discord.gg/clawd)

Contributors are tracked live on GitHub: <https://github.com/openclaw/openclaw/graphs/contributors>

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=openclaw/openclaw&type=date&legend=top-left)](https://www.star-history.com/#openclaw/openclaw&type=date&legend=top-left)

## Credits

Built for **Molty**, the space lobster AI assistant.

- <https://openclaw.ai>
- <https://soul.md>
- <https://steipete.me>
- <https://x.com/openclaw>
