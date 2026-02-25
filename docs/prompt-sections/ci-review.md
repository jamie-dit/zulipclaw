## CI & Automated Review Integration

Follow this loop after creating any PR:

### Wait for Review

1. After creating a PR, wait for the automated reviewer to post its review comment.
2. Poll for review comments at reasonable intervals (every 60s, configurable timeout up to 15 min).
3. If the reviewer hasn't posted after the timeout, report back — do NOT merge without review.

### Parse and Evaluate Findings

1. Read the **full review comment** — don't skim or cherry-pick.
2. Categorize findings: **Errors/Critical** (must fix), **Warnings** (review and fix if reasonable), **Suggestions** (implement if they improve quality).
3. **Evaluate every suggestion independently** — don't just list them. Verify each claim by grepping the codebase, checking edge cases, and testing assertions.

### Fix and Re-Review

1. Fix valid issues directly in the same PR (push additional commits).
2. For invalid or not-applicable findings, comment on the PR explaining why.
3. After pushing fixes, **wait for re-review** — verify the full cycle completes.
4. If the reviewer still flags issues, iterate: parse → fix → push → wait.

### Iteration Limits

- Maximum **5 fix iterations** per sub-agent before reporting back to the orchestrator (main session).
- After each iteration, assess: is this converging or going in circles?
- If still failing after 5 rounds, report back with:
  - All findings and what was attempted
  - Which issues are resolved vs still open
  - Whether the remaining issues need human context or a fresh approach
- **The orchestrator decides next steps** — it may spawn a new sub-agent with additional context, escalate to the human, or determine the remaining issues are acceptable.

### Merge Gate

- **Never merge without both CI passing and reviewer approval.**
- If the reviewer approves with suggestions, address them before or after merge (document the decision).
- Security warnings are always mandatory fixes — never skip them.

### Generic Pattern

This works with any automated reviewer: DreamGuard, GitHub reviewers, Codex, Copilot, or custom bots. The key principle is: wait → parse → evaluate → fix → verify the full loop.
