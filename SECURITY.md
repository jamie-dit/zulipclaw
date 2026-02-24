# Security Policy

ZulipClaw is a fork of [OpenClaw](https://github.com/openclaw/openclaw). If you believe you've found a security issue in ZulipClaw, please report it privately.

## Reporting

Report vulnerabilities for this fork directly via GitHub:

- **ZulipClaw (this repo)** — [jamie-dit/zulipclaw](https://github.com/jamie-dit/zulipclaw/security/advisories/new)

For issues in upstream OpenClaw that are not specific to the ZulipClaw fork, report them to the upstream project at [openclaw/openclaw](https://github.com/openclaw/openclaw).

### Required in Reports

1. **Title**
2. **Severity Assessment**
3. **Impact**
4. **Affected Component**
5. **Technical Reproduction**
6. **Demonstrated Impact**
7. **Environment**
8. **Remediation Advice**

Reports without reproduction steps, demonstrated impact, and remediation advice will be deprioritized. Given the volume of AI-generated scanner findings, we must ensure we're receiving vetted reports from researchers who understand the issues.

## Bug Bounties

ZulipClaw is a community fork maintained on a volunteer basis. There is no bug bounty program. Please still disclose responsibly so we can fix issues quickly. The best way to help the project right now is by sending PRs.

## Maintainers: GHSA Updates via CLI

When patching a GHSA via `gh api`, include `X-GitHub-Api-Version: 2022-11-28` (or newer). Without it, some fields (notably CVSS) may not persist even if the request returns 200.

## Out of Scope

- Public Internet Exposure
- Using ZulipClaw in ways that the docs recommend not to
- Prompt injection attacks

## Operational Guidance

For threat model and hardening guidance, see the upstream OpenClaw docs:

- `https://docs.openclaw.ai/gateway/security`

### Tool filesystem hardening

- `tools.exec.applyPatch.workspaceOnly: true` (recommended): keeps `apply_patch` writes/deletes within the configured workspace directory.
- `tools.fs.workspaceOnly: true` (optional): restricts `read`/`write`/`edit`/`apply_patch` paths to the workspace directory.
- Avoid setting `tools.exec.applyPatch.workspaceOnly: false` unless you fully trust who can trigger tool execution.

### Web Interface Safety

ZulipClaw's web interface (Gateway Control UI + HTTP endpoints) is intended for **local use only**.

- Recommended: keep the Gateway **loopback-only** (`127.0.0.1` / `::1`).
  - Config: `gateway.bind="loopback"` (default).
- Do **not** expose it to the public internet. It is not hardened for public exposure.
- If you need remote access, prefer an SSH tunnel or VPN (so the Gateway still binds to loopback), plus strong Gateway auth.

## Runtime Requirements

### Node.js Version

ZulipClaw requires **Node.js 22.12.0 or later** (LTS). This version includes important security patches:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: Permission model bypass vulnerability

Verify your Node.js version:

```bash
node --version  # Should be v22.12.0 or later
```

### Docker Security

When running ZulipClaw in Docker:

1. The official image runs as a non-root user (`node`) for reduced attack surface
2. Use `--read-only` flag when possible for additional filesystem protection
3. Limit container capabilities with `--cap-drop=ALL`

## Security Scanning

This project uses `detect-secrets` for automated secret detection in CI/CD.
See `.detect-secrets.cfg` for configuration and `.secrets.baseline` for the baseline.

Run locally:

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
