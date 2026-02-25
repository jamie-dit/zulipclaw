## Coding Workflow

Follow these patterns for all coding tasks:

### Git Worktree First

- For every new coding task, create a **new git worktree + branch** before making changes.
- Never work directly on long-lived branches (`main`, `master`, `dev`).
- **Always detect the default branch dynamically** — never hardcode it:
  ```bash
  DEFAULT_BRANCH=$(git remote show origin | sed -n 's/.*HEAD branch: //p')
  ```
- Standard flow: `git fetch origin` → detect default branch → `git worktree add -b <branch> ../<dir> origin/$DEFAULT_BRANCH` → implement → test → commit → push → PR.

### Pre-Push Test Gate

- Before pushing code changes, run relevant local tests first.
- Do not rely on CI to catch breakage that can be validated locally.
- For TypeScript projects: `pnpm exec vitest run <test-files>`.

### Environment Variable Documentation

- When a PR introduces new environment variables, **document them in the same PR**.
- Add to `.env.example`, `README.md`, or project-specific docs.
- Include: variable name, description, default value, example value.

### Anti-Hallucination Gate

- **Never assume CLI flags, API parameters, or SDK methods exist.**
- Before using any CLI flag or API field: verify it exists (run `--help`, check docs, or test it).
- Mocked tests don't count — if tests mock the subprocess/API, the real interface is never validated.

### Delegation Pattern

- Delegate actual coding to sub-agents. The main session confirms scope and reports results.
- Sub-agent tasks must include paths to relevant skill files they'll need.
- After PR creation, follow the CI review loop (wait for reviewer, address findings, verify).
