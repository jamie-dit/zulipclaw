import fs from "node:fs/promises";
import path from "node:path";
import {
  buildHourlyUsageCsv,
  discoverTranscriptHourBounds,
  enforceMaxHoursPerRun,
  exportHourlyUsageCsv,
  formatHourStartIso,
  resolveHourSelection,
  uploadHourlyUsageCsv,
} from "../src/infra/hourly-usage-export.js";

type ParsedArgs = {
  hour?: string;
  from?: string;
  to?: string;
  allHours: boolean;
  output?: string;
  outputDir?: string;
  chunkByHour: boolean;
  upload: boolean;
  dryRun: boolean;
  maxHours?: string;
  force: boolean;
  printCsv: boolean;
  json: boolean;
  help: boolean;
};

type HourRunSummary = {
  hourStartIso: string;
  rows: number;
  outputPath?: string;
  uploaded: boolean;
  dryRunUpload: boolean;
  diagnostics: {
    reportedRecords: number;
    reportedZeroRecords: number;
    missingUsageRecords: number;
  };
  uploadResult?: {
    ok: true;
    importedRows: number;
    status: number;
  };
};

const DEFAULT_MAX_HOURS_PER_RUN = 48;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    allHours: false,
    chunkByHour: false,
    upload: false,
    dryRun: false,
    force: false,
    printCsv: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];

    switch (arg) {
      case "--hour":
        if (next && !next.startsWith("--")) {
          parsed.hour = next;
          i += 1;
        }
        break;
      case "--from":
        if (next && !next.startsWith("--")) {
          parsed.from = next;
          i += 1;
        }
        break;
      case "--to":
        if (next && !next.startsWith("--")) {
          parsed.to = next;
          i += 1;
        }
        break;
      case "--all-hours":
        parsed.allHours = true;
        break;
      case "--output":
        if (next && !next.startsWith("--")) {
          parsed.output = next;
          i += 1;
        }
        break;
      case "--output-dir":
        if (next && !next.startsWith("--")) {
          parsed.outputDir = next;
          i += 1;
        }
        break;
      case "--chunk-by-hour":
        parsed.chunkByHour = true;
        break;
      case "--upload":
        parsed.upload = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--max-hours":
        if (next && !next.startsWith("--")) {
          parsed.maxHours = next;
          i += 1;
        }
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--print-csv":
        parsed.printCsv = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

function usage(): string {
  return [
    "usage_hourly_export.ts",
    "",
    "Export OpenClaw transcript usage for one or more UTC hours as CSV and optionally upload to Helix.",
    "",
    "Default mode:",
    "  Without range flags, exports the previous UTC hour (cron-safe).",
    "",
    "Hour selection:",
    "  --hour <iso>         Single hour start in UTC (YYYY-MM-DDTHH:00:00Z).",
    "  --from <iso>         Inclusive UTC start hour for ranged backfill.",
    "  --to <iso>           Inclusive UTC end hour for ranged backfill.",
    "  --all-hours          Discover earliest transcript hour and replay through previous UTC hour.",
    "",
    "Output/upload:",
    "  --output <path>      Write CSV to this file path.",
    "  --output-dir <dir>   Write CSV under this directory (auto filename).",
    "  --chunk-by-hour      For ranges, write one CSV per hour (requires --output-dir for files).",
    "  --upload             POST each hour CSV to Helix (safe hour-by-hour replay).",
    "  --print-csv          Print CSV to stdout.",
    "  --json               Print run summary as JSON.",
    "",
    "Guardrails:",
    `  --max-hours <n>      Refuse runs above n hours unless --force (default ${DEFAULT_MAX_HOURS_PER_RUN}).`,
    "  --force              Override --max-hours guard.",
    "  --dry-run            Plan/export/write without uploading.",
    "  --help               Show this help.",
    "",
    "Helix env:",
    "  HELIX_USAGE_INGEST_TOKEN (required with --upload)",
    "  HELIX_USAGE_INGEST_URL    (full endpoint URL), OR",
    "  HELIX_USAGE_BASE_URL      (base URL; path /api/usage/zulipclaw/hourly is appended)",
    "",
    "Examples:",
    "  # Normal hourly cron mode (previous UTC hour)",
    "  node --import tsx scripts/usage_hourly_export.ts --output-dir /tmp/hourly --upload --json",
    "",
    "  # One-time date range backfill",
    "  node --import tsx scripts/usage_hourly_export.ts --from 2026-02-01T00:00:00Z --to 2026-02-07T23:00:00Z --chunk-by-hour --output-dir /tmp/hourly --upload --force --json",
    "",
    "  # One-time full history backfill",
    "  node --import tsx scripts/usage_hourly_export.ts --all-hours --chunk-by-hour --output-dir /tmp/hourly --upload --force --json",
  ].join("\n");
}

function sanitizeFileHour(hourIso: string): string {
  return hourIso.replaceAll(":", "-");
}

function parseMaxHours(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_MAX_HOURS_PER_RUN;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid --max-hours value: ${raw}`);
  }
  return value;
}

function rangeFilename(fromHourIso: string, toHourIso: string): string {
  return `zulipclaw-usage-${sanitizeFileHour(fromHourIso)}-to-${sanitizeFileHour(toHourIso)}.csv`;
}

function singleHourFilename(hourIso: string): string {
  return `zulipclaw-usage-${sanitizeFileHour(hourIso)}.csv`;
}

async function writeCsvToPath(targetPath: string, csv: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, csv, "utf-8");
  return resolved;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (args.output && args.outputDir) {
    throw new Error("--output and --output-dir cannot be used together.");
  }

  const now = new Date();
  const discoveredBounds = args.allHours ? await discoverTranscriptHourBounds() : undefined;

  const selection = resolveHourSelection({
    hourStartIso: args.hour,
    fromIso: args.from,
    toIso: args.to,
    allHours: args.allHours,
    discoveredFromHour: discoveredBounds?.earliestHour,
    now,
  });

  const maxHours = parseMaxHours(args.maxHours);
  enforceMaxHoursPerRun({
    hours: selection.hours.length,
    maxHours,
    force: args.force,
  });

  if (args.chunkByHour && selection.hours.length > 1 && args.output) {
    throw new Error("--chunk-by-hour with a range requires --output-dir (not --output).");
  }

  if (args.chunkByHour && selection.hours.length > 1 && args.printCsv) {
    throw new Error("--print-csv is not supported with --chunk-by-hour across multiple hours.");
  }

  const runSummaries: HourRunSummary[] = [];
  const hourCsvByIso = new Map<string, string>();
  const combinedRows = [] as Awaited<ReturnType<typeof exportHourlyUsageCsv>>["rows"];

  for (const hourStart of selection.hours) {
    const result = await exportHourlyUsageCsv({ hourStart });
    hourCsvByIso.set(result.hourStartIso, result.csv);
    combinedRows.push(...result.rows);

    let outputPath: string | undefined;
    if (args.outputDir && (selection.hours.length === 1 || args.chunkByHour)) {
      outputPath = await writeCsvToPath(
        path.join(args.outputDir, singleHourFilename(result.hourStartIso)),
        result.csv,
      );
    }

    let uploadResult:
      | {
          ok: true;
          importedRows: number;
          status: number;
        }
      | undefined;

    if (args.upload && !args.dryRun) {
      uploadResult = await uploadHourlyUsageCsv({
        hourStartIso: result.hourStartIso,
        csv: result.csv,
      });
    }

    runSummaries.push({
      hourStartIso: result.hourStartIso,
      rows: result.rows.length,
      outputPath,
      uploaded: Boolean(uploadResult),
      dryRunUpload: args.upload && args.dryRun,
      diagnostics: result.diagnostics,
      uploadResult,
    });
  }

  let rangeOutputPath: string | undefined;
  if (selection.hours.length > 1 && !args.chunkByHour) {
    const combinedCsv = buildHourlyUsageCsv(combinedRows);

    if (args.output) {
      rangeOutputPath = await writeCsvToPath(args.output, combinedCsv);
    } else if (args.outputDir) {
      rangeOutputPath = await writeCsvToPath(
        path.join(
          args.outputDir,
          rangeFilename(
            formatHourStartIso(selection.fromHour),
            formatHourStartIso(selection.toHour),
          ),
        ),
        combinedCsv,
      );
    }

    if (args.printCsv) {
      process.stdout.write(combinedCsv);
    }
  }

  if (selection.hours.length === 1) {
    const singleRun = runSummaries[0];
    if (!singleRun) {
      throw new Error("Expected a single-hour export result but found none.");
    }

    const singleHourCsv = hourCsvByIso.get(singleRun.hourStartIso);
    if (!singleHourCsv) {
      throw new Error(`Missing CSV payload for ${singleRun.hourStartIso}.`);
    }

    if (!singleRun.outputPath) {
      if (args.output) {
        singleRun.outputPath = await writeCsvToPath(args.output, singleHourCsv);
      } else if (args.outputDir) {
        singleRun.outputPath = await writeCsvToPath(
          path.join(args.outputDir, singleHourFilename(singleRun.hourStartIso)),
          singleHourCsv,
        );
      }
    }

    if (args.printCsv) {
      process.stdout.write(singleHourCsv);
    }
  }

  const hasAnyOutputPath =
    Boolean(rangeOutputPath) || runSummaries.some((summary) => Boolean(summary.outputPath));

  if (args.json || (!args.printCsv && !hasAnyOutputPath)) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: selection.mode,
          fromHourIso: formatHourStartIso(selection.fromHour),
          toHourIso: formatHourStartIso(selection.toHour),
          hours: selection.hours.length,
          maxHours,
          forced: args.force,
          dryRun: args.dryRun,
          chunkByHour: args.chunkByHour,
          outputPath: rangeOutputPath,
          discoveredBounds: discoveredBounds
            ? {
                earliestHourIso: formatHourStartIso(discoveredBounds.earliestHour),
                latestHourIso: formatHourStartIso(discoveredBounds.latestHour),
              }
            : undefined,
          summary: {
            totalRows: runSummaries.reduce((sum, hour) => sum + hour.rows, 0),
            uploadedHours: runSummaries.filter((hour) => hour.uploaded).length,
            importedRows: runSummaries.reduce(
              (sum, hour) => sum + (hour.uploadResult?.importedRows ?? 0),
              0,
            ),
            reportedRecords: runSummaries.reduce(
              (sum, hour) => sum + hour.diagnostics.reportedRecords,
              0,
            ),
            reportedZeroRecords: runSummaries.reduce(
              (sum, hour) => sum + hour.diagnostics.reportedZeroRecords,
              0,
            ),
            missingUsageRecords: runSummaries.reduce(
              (sum, hour) => sum + hour.diagnostics.missingUsageRecords,
              0,
            ),
            missingUsageFallbackEnabled: true,
          },
          hoursDetail: runSummaries,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`usage_hourly_export.ts failed: ${message}\n`);
    process.exitCode = 1;
  });
}
