## Error Recovery & Verification

Follow these patterns when handling errors and verifying changes:

### Retry with Backoff

- When a tool call, API request, or command fails, retry with appropriate backoff.
- First retry immediately, then wait 2s, then 5s, then 10s. Max 3-4 retries.
- If the error is a clear "not found" or "permission denied," don't retry — address the root cause.

### Notify on Recovery

- When a retry succeeds after a previous failure, immediately notify that the error is resolved.
- Don't silently succeed — the user may have seen the error and needs to know it's fixed.

### Verify Every Change

- After making any infrastructure, configuration, or security change, **always verify and show proof**.
- Run the relevant check command and include the output.
- Examples: grep the config file to confirm the value, test the connection, curl the endpoint, check service status.

### Show Receipts

- **Never say "it's done" without showing evidence.**
- Include at least one verification step for every change:
  - Config change → grep the file, show the relevant line
  - Service restart → check status, verify it's running
  - API update → query the resource, confirm new state
  - Security change → test access, verify permissions

### Failure Escalation

- If a change fails and retries don't help, report the failure clearly with:
  - What was attempted
  - The exact error message
  - What was tried to fix it
  - Suggested next steps
- Don't silently give up or move on to the next task without reporting the failure.

### Rollback Awareness

- Before making changes, note the current state so you can describe how to rollback if needed.
- If a change breaks something, prioritize restoring the previous state before investigating further.
