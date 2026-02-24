---
summary: "Export hourly token usage CSV from ZulipClaw and upload it to Helix"
read_when:
  - You need hourly usage exports to Helix
  - You are wiring cron/systemd automation for usage ingestion
title: "Hourly Usage CSV Export (Helix)"
---

# Hourly usage CSV export (Helix)

This workflow exports transcript usage for one UTC hour (default) or historical hour ranges and can upload to Helix.

The exporter groups usage by:

- `timestamp_hour` (UTC hour bucket)
- `session_key`
- `model_provider`
- `model`

## CSV schema

Header:

```text
timestamp_hour,session_key,model_provider,model,input_tokens,output_tokens,total_tokens,cost_usd
```

Columns:

- `timestamp_hour`: UTC hour start (`YYYY-MM-DDTHH:00:00Z`)
- `session_key`: OpenClaw/ZulipClaw session key (`agent:<agentId>:<sessionId>`)
- `model_provider`: runtime provider (for example `openai`, `anthropic`, `openclaw`)
- `model`: runtime model identifier (legacy `provider/model` values are preserved when already present)
- `input_tokens`: aggregated input tokens
- `output_tokens`: aggregated output tokens
- `total_tokens`: aggregated total tokens
- `cost_usd`: aggregated USD cost when available; blank if unavailable for any row segment

## Helix ingest contract

Uploader target:

- `POST /api/usage/zulipclaw/hourly`
- `Content-Type: text/csv`
- Headers:
  - `Authorization: Bearer <HELIX_USAGE_INGEST_TOKEN>`
  - `X-Usage-Hour: YYYY-MM-DDTHH:00:00Z`

Expected response JSON:

```json
{ "ok": true, "importedRows": 123 }
```

## Environment variables

Set one URL mode plus token:

```bash
HELIX_USAGE_INGEST_TOKEN=...
HELIX_USAGE_BASE_URL=https://helix.example.com
# or HELIX_USAGE_INGEST_URL=https://helix.example.com/api/usage/zulipclaw/hourly

# Optional local archive directory for generated CSV files
HELIX_USAGE_EXPORT_DIR=~/.openclaw/usage-hourly
```

## CLI modes

From repo root:

```bash
# Normal hourly cron mode (default): previous UTC hour
node --import tsx scripts/usage_hourly_export.ts --output-dir /tmp/usage-hourly --upload --json

# One-time backfill for a date range (inclusive hours)
node --import tsx scripts/usage_hourly_export.ts \
  --from 2026-02-01T00:00:00Z \
  --to 2026-02-07T23:00:00Z \
  --chunk-by-hour \
  --output-dir /tmp/usage-backfill \
  --upload \
  --force \
  --json

# One-time full history backfill (auto-discovers earliest transcript hour)
node --import tsx scripts/usage_hourly_export.ts \
  --all-hours \
  --chunk-by-hour \
  --output-dir /tmp/usage-backfill \
  --upload \
  --force \
  --json
```

### Flags for backfill + safety

- `--from` + `--to`: explicit inclusive hour range (`YYYY-MM-DDTHH:00:00Z`)
- `--all-hours`: auto-discover earliest transcript hour and replay to previous UTC hour
- `--chunk-by-hour`: write one CSV file per hour for ranged backfills
- `--upload`: uploads each hour separately (safe historical replay)
- `--dry-run`: build CSV and plan uploads without sending to Helix
- `--max-hours <n>`: guardrail cap (default `48`) unless `--force` is set
- `--force`: allow ranges larger than `--max-hours`

## Rollout sequence

### Step A - run one-time backfill

Run either date-range backfill (`--from/--to`) or full history (`--all-hours`) once.
Use `--dry-run` first if you want to verify the plan and hour count before ingest.

### Step B - enable hourly cron

After backfill succeeds, enable hourly automation for ongoing ingestion.

Repo-owned wrapper script:

```bash
scripts/usage_hourly_export.sh
```

Behavior:

- exports the previous UTC hour
- writes CSV to `${HELIX_USAGE_EXPORT_DIR:-~/.openclaw/usage-hourly}`
- uploads to Helix

Example cron entry (run at 5 minutes past each hour):

```cron
5 * * * * cd /opt/zulipclaw && /opt/zulipclaw/scripts/usage_hourly_export.sh >> /var/log/zulipclaw-usage-hourly.log 2>&1
```

## Notes

- Source of truth is transcript runtime usage per assistant turn (`message.usage` / `entry.usage`).
- If an assistant turn is missing usage, the exporter still emits a fallback row segment with `0` tokens so backfills preserve session/hour coverage.
- `--json` output includes diagnostics (`reportedRecords`, `reportedZeroRecords`, `missingUsageRecords`) so you can track fallback provenance without changing the ingest CSV contract (`reportedZeroRecords` is commonly synthetic mirror/error traffic with explicit zero token usage).
- Cost uses provider-reported `usage.cost.total` when present; otherwise it falls back to configured model cost estimation when possible.
- If cost is unavailable for any grouped segment, `cost_usd` is left blank for that CSV row.
- `--all-hours` backfill can only cover transcript files currently present under `~/.openclaw/agents/*/sessions`; data outside retained transcripts (for example pre-migration/OpenClaw-era files not in this store) cannot be reconstructed exactly.
