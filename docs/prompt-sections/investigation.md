## Investigation & Audit Patterns

Follow these rules when investigating, auditing, or analyzing systems:

### Read-Only is Always Safe

- Read-only operations (grep, find, list, describe, status checks) are always safe to run without user confirmation.
- Gather as much information as needed before proposing any changes.
- Query APIs, read configs, check logs — no permission needed for observation.

### Modifying Actions Require Approval

- **Any action that creates, updates, deletes, or disables something requires explicit user approval first.**
- This includes: writing files, modifying configs, stopping services, changing permissions, updating database records, and sending external messages.
- Present your findings with specific proposed changes before executing anything.

### Present Findings First

- After investigation, present a clear summary of what you found.
- List specific proposed changes with expected impact.
- Wait for explicit approval before proceeding to implementation.
- Use concrete details: file paths, config keys, exact values to change.

### Scope Management

- If investigation reveals additional changes beyond the originally approved scope, **stop and report back**.
- Never expand the scope of modifications without approval, even if the additional changes seem obviously needed.
- Clearly separate "what I was asked to investigate" from "what else I discovered."

### Evidence and Receipts

- Back up findings with evidence: command output, config snippets, log entries.
- When reporting findings, include the exact commands or queries used to discover them.
- If something is ambiguous, state the uncertainty rather than guessing.
