# Contributing to ZulipClaw

Welcome! ZulipClaw is a fork of [OpenClaw](https://github.com/openclaw/openclaw) with first-class Zulip channel support.

## Quick Links

- **GitHub:** https://github.com/jamie-dit/zulipclaw
- **Upstream OpenClaw:** https://github.com/openclaw/openclaw
- **Vision:** [`VISION.md`](VISION.md)
- **Discussions:** https://github.com/jamie-dit/zulipclaw/discussions

## Maintainers

- **Jamie** - Fork maintainer, Zulip integration
  - GitHub: [@jamie-dit](https://github.com/jamie-dit)

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Discussion](https://github.com/jamie-dit/zulipclaw/discussions) first
3. **Questions** → GitHub Discussions

## Issue Linking Policy (epics vs complete issues)

When your PR only delivers part of a larger epic, link with:
- `refs #<epic>`
- `part of #<epic>`

Use closing keywords only when the linked issue is truly complete:
- `fixes #<issue>`
- `closes #<issue>`

This prevents epic tracking issues from being auto-closed by partial work.

## Before You PR

- Test locally with your ZulipClaw instance
- Run tests: `pnpm build && pnpm check && pnpm test`
- Ensure CI checks pass
- Keep PRs focused (one thing per PR; do not mix unrelated concerns)
- Describe what & why

## Control UI Decorators

The Control UI uses Lit with **legacy** decorators (current Rollup parsing does not support
`accessor` fields required for standard decorators). When adding reactive fields, keep the
legacy style:

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

The root `tsconfig.json` is configured for legacy decorators (`experimentalDecorators: true`)
with `useDefineForClassFields: false`. Avoid flipping these unless you are also updating the UI
build tooling to support standard decorators.

## AI/Vibe-Coded PRs Welcome! 🤖

Built with Codex, Claude, or other AI tools? **Awesome - just mark it!**

Please include in your PR:

- [ ] Mark as AI-assisted in the PR title or description
- [ ] Note the degree of testing (untested / lightly tested / fully tested)
- [ ] Include prompts or session logs if possible (super helpful!)
- [ ] Confirm you understand what the code does

AI PRs are first-class citizens here. We just want transparency so reviewers know what to look for.

## Current Focus & Roadmap 🗺

ZulipClaw priorities:

- **Zulip integration**: Improving Zulip channel stability, thread replies, and stream routing.
- **Stability**: Fixing edge cases in channel connections.
- **UX**: Improving the onboarding wizard and error messages.
- **Performance**: Optimizing token usage and compaction logic.

Check the [GitHub Issues](https://github.com/jamie-dit/zulipclaw/issues) for "good first issue" labels!

## Syncing with Upstream

ZulipClaw tracks upstream OpenClaw. To sync:

```bash
git fetch upstream
git merge upstream/main
```

Upstream changes that conflict with Zulip-specific code should be resolved in favour of ZulipClaw's Zulip implementation.

## Report a Vulnerability

See [SECURITY.md](SECURITY.md) for the security policy and reporting instructions.
