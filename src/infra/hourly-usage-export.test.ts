import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateUsageRecords,
  buildHourlyUsageCsv,
  collectUsageRecordsFromTranscriptFile,
  enforceMaxHoursPerRun,
  formatHourStartIso,
  iterateHourStartsInclusive,
  parseHourStart,
  resolveHourSelection,
  summarizeUsageDiagnostics,
  uploadHourlyUsageCsv,
} from "./hourly-usage-export.js";

describe("hourly usage export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to previous UTC hour when hour is omitted", () => {
    const now = new Date("2026-02-20T12:34:56.000Z");
    const hour = parseHourStart(undefined, now);
    expect(formatHourStartIso(hour)).toBe("2026-02-20T11:00:00Z");
  });

  it("iterates inclusive UTC hour ranges", () => {
    const hours = iterateHourStartsInclusive(
      new Date("2026-02-20T01:00:00Z"),
      new Date("2026-02-20T03:00:00Z"),
    );

    expect(hours.map((hour) => formatHourStartIso(hour))).toEqual([
      "2026-02-20T01:00:00Z",
      "2026-02-20T02:00:00Z",
      "2026-02-20T03:00:00Z",
    ]);
  });

  it("resolves explicit range selection from --from/--to", () => {
    const selection = resolveHourSelection({
      fromIso: "2026-02-20T01:00:00Z",
      toIso: "2026-02-20T03:00:00Z",
      now: new Date("2026-02-20T12:00:00Z"),
    });

    expect(selection.mode).toBe("range");
    expect(formatHourStartIso(selection.fromHour)).toBe("2026-02-20T01:00:00Z");
    expect(formatHourStartIso(selection.toHour)).toBe("2026-02-20T03:00:00Z");
    expect(selection.hours).toHaveLength(3);
  });

  it("resolves --all-hours using discovered history bounds", () => {
    const selection = resolveHourSelection({
      allHours: true,
      discoveredFromHour: new Date("2026-02-19T22:20:00Z"),
      now: new Date("2026-02-20T03:10:00Z"),
    });

    expect(selection.mode).toBe("all-hours");
    expect(formatHourStartIso(selection.fromHour)).toBe("2026-02-19T22:00:00Z");
    expect(formatHourStartIso(selection.toHour)).toBe("2026-02-20T02:00:00Z");
    expect(selection.hours).toHaveLength(5);
  });

  it("enforces max-hours guard unless forced", () => {
    expect(() => enforceMaxHoursPerRun({ hours: 49, maxHours: 48 })).toThrow("Refusing to process");
    expect(() => enforceMaxHoursPerRun({ hours: 49, maxHours: 48, force: true })).not.toThrow();
  });

  it("rejects incomplete ranged selection", () => {
    expect(() => resolveHourSelection({ fromIso: "2026-02-20T01:00:00Z" })).toThrow(
      "--from and --to must be provided together",
    );
  });

  it("aggregates usage by hour/session/model and blanks partial costs", () => {
    const rows = aggregateUsageRecords([
      {
        timestampMs: Date.parse("2026-02-20T01:05:00Z"),
        sessionKey: "agent:main:s1",
        modelProvider: "openai",
        model: "openai/gpt-5",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.1,
        provenance: "reported",
      },
      {
        timestampMs: Date.parse("2026-02-20T01:20:00Z"),
        sessionKey: "agent:main:s1",
        modelProvider: "openai",
        model: "openai/gpt-5",
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        provenance: "reported",
      },
      {
        timestampMs: Date.parse("2026-02-20T01:25:00Z"),
        sessionKey: "agent:main:s2",
        modelProvider: "anthropic",
        model: "anthropic/claude-sonnet-4-20250514",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.02,
        provenance: "reported",
      },
    ]);

    expect(rows).toEqual([
      {
        timestamp_hour: "2026-02-20T01:00:00Z",
        session_key: "agent:main:s1",
        model_provider: "openai",
        model: "openai/gpt-5",
        input_tokens: 120,
        output_tokens: 55,
        total_tokens: 175,
        cost_usd: undefined,
      },
      {
        timestamp_hour: "2026-02-20T01:00:00Z",
        session_key: "agent:main:s2",
        model_provider: "anthropic",
        model: "anthropic/claude-sonnet-4-20250514",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_usd: 0.02,
      },
    ]);
  });

  it("summarizes usage provenance diagnostics", () => {
    const diagnostics = summarizeUsageDiagnostics([
      {
        timestampMs: Date.parse("2026-02-20T01:05:00Z"),
        sessionKey: "agent:main:s1",
        modelProvider: "openai",
        model: "openai/gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        provenance: "reported",
      },
      {
        timestampMs: Date.parse("2026-02-20T01:07:00Z"),
        sessionKey: "agent:main:s1",
        modelProvider: "openai",
        model: "openai/gpt-5",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        provenance: "reported_zero",
      },
      {
        timestampMs: Date.parse("2026-02-20T01:08:00Z"),
        sessionKey: "agent:main:s1",
        modelProvider: "openai",
        model: "openai/gpt-5",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        provenance: "missing_usage",
      },
    ]);

    expect(diagnostics).toEqual({
      reportedRecords: 1,
      reportedZeroRecords: 1,
      missingUsageRecords: 1,
    });
  });

  it("builds CSV with escaped values and blank cost cells", () => {
    const csv = buildHourlyUsageCsv([
      {
        timestamp_hour: "2026-02-20T01:00:00Z",
        session_key: "agent:main:sess,one",
        model_provider: "openai",
        model: 'openai/"gpt"',
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
      },
    ]);

    expect(
      csv.startsWith(
        "timestamp_hour,session_key,model_provider,model,input_tokens,output_tokens,total_tokens,cost_usd\n",
      ),
    ).toBe(true);
    expect(csv).toContain('"agent:main:sess,one"');
    expect(csv).toContain('"openai/""gpt"""');
    expect(csv.trimEnd().endsWith(",")).toBe(true);
  });

  it("parses transcript lines into usage records for the selected hour", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hourly-usage-test-"));
    const filePath = path.join(tempDir, "session-a.jsonl");
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-02-20T05:10:00.000Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5",
            usage: {
              input_tokens: 100,
              output_tokens: 25,
              total_tokens: 125,
              cost: { total: 0.12 },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-20T05:20:00.000Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5",
            usage: {
              input_tokens: 20,
              output_tokens: 5,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-20T05:40:00.000Z",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5",
            content: "fallback row with no usage payload",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-20T05:50:00.000Z",
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-20T06:00:00.000Z",
          message: {
            role: "assistant",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        }),
        "{not-json}",
      ].join("\n") + "\n",
      "utf-8",
    );

    const records = await collectUsageRecordsFromTranscriptFile({
      filePath,
      sessionKey: "agent:main:session-a",
      hourStartMs: Date.parse("2026-02-20T05:00:00Z"),
      hourEndMsExclusive: Date.parse("2026-02-20T06:00:00Z"),
      config: {} as never,
    });

    expect(records).toHaveLength(4);
    expect(records[0]?.totalTokens).toBe(125);
    expect(records[0]?.costUsd).toBe(0.12);
    expect(records[0]?.modelProvider).toBe("openai");
    expect(records[1]?.totalTokens).toBe(25);
    expect(records[2]?.totalTokens).toBe(0);
    expect(records[2]?.provenance).toBe("missing_usage");
    expect(records[3]?.totalTokens).toBe(0);
    expect(records[3]?.provenance).toBe("reported_zero");
  });

  it("uploads CSV to Helix with required headers", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, importedRows: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await uploadHourlyUsageCsv({
      hourStartIso: "2026-02-20T05:00:00Z",
      csv: "timestamp_hour,session_key,model_provider,model,input_tokens,output_tokens,total_tokens,cost_usd\n",
      ingestUrl: "https://helix.example.com/api/usage/zulipclaw/hourly",
      token: "token-123",
      fetchImpl,
    });

    expect(result.importedRows).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, request] = fetchImpl.mock.calls[0] ?? [];
    const headers = request?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer token-123");
    expect(headers["X-Usage-Hour"]).toBe("2026-02-20T05:00:00Z");
  });
});
