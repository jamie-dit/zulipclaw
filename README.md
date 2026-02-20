# 🦞 ZulipClaw

ZulipClaw is a personal AI assistant stack focused on self-hosted messaging, tool use, and device-connected automation.

This repository tracks the DreamIT-maintained fork and keeps documentation centered on this project.

## Highlights

- Local-first gateway architecture with explicit operator control.
- Multi-channel messaging and session orchestration.
- Built-in tooling for browser actions, canvas, node control, cron, and automation workflows.
- Development workflow for desktop and mobile companion surfaces.

## Quick start (from source)

Runtime: **Node >= 22**

```bash
git clone git@gitea.hosting-cloud.net:dreamit/zulip-claw.git
cd zulip-claw
pnpm install
pnpm ui:build
pnpm build
```

Run the gateway in development mode:

```bash
pnpm gateway:watch
```

## Common development commands

```bash
pnpm lint
pnpm test:fast
pnpm format
```

## Security defaults

- Treat inbound DMs as untrusted input.
- Use pairing-style approval for unknown senders.
- Keep allowlists narrow and explicit.

## Architecture (short)

```text
Messaging channels
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

## Contributing

- Read [CONTRIBUTING.md](CONTRIBUTING.md)
- Use focused PRs with clear test evidence
- Prefer small, reviewable commits

## License

MIT - see [LICENSE](LICENSE)
