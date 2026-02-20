#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUTPUT_DIR="${HELIX_USAGE_EXPORT_DIR:-$HOME/.openclaw/usage-hourly}"

cd "$ROOT_DIR"
node --import tsx scripts/usage_hourly_export.ts --output-dir "$OUTPUT_DIR" --upload --json
