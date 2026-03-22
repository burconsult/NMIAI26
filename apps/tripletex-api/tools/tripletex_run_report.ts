import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type RunLayerResult = {
  layer: string;
  error?: string;
  verified?: boolean;
  detail?: string;
  terminal?: boolean;
};

type RunLedgerRecord = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  httpStatus: number;
  planner: string;
  promptText?: string;
  promptPreview?: string;
  promptLength?: number;
  fileCount?: number;
  baseUrlHost?: string;
  spec?: {
    operation?: string;
    entity?: string;
    values?: Record<string, unknown>;
    lookup?: Record<string, unknown>;
  };
  verification?: {
    verified: boolean;
    detail: string;
    required: boolean;
  };
  layerResults?: RunLayerResult[];
  attemptErrors?: string[];
  traceSummary?: {
    eventCount: number;
    tripletexRequests: number;
    tripletexResponses: number;
    tripletexErrors: number;
    mutatingRequests: number;
  };
};

type Cluster = {
  fingerprint: string;
  count: number;
  sampleRunId: string;
  samplePrompt: string;
  samplePlanner: string;
  sampleStatus: string;
};

function usage(): never {
  console.error(
    [
      "Usage: npx tsx tools/tripletex_run_report.ts [jsonl-path] [--top N] [--emit-regressions output.json]",
      "Default path: TRIPLETEX_RUN_LEDGER_PATH or runs/local-runs.jsonl",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): { path: string; top: number; emitRegressions?: string } {
  let path = process.env.TRIPLETEX_RUN_LEDGER_PATH?.trim() || "runs/local-runs.jsonl";
  let top = 10;
  let emitRegressions: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--top") {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) usage();
      top = Math.round(value);
      index += 1;
      continue;
    }
    if (arg === "--emit-regressions") {
      const value = argv[index + 1];
      if (!value) usage();
      emitRegressions = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) usage();
    path = arg;
  }

  return { path, top, emitRegressions };
}

function normalizeError(error: string): string {
  return error
    .toLowerCase()
    .replace(/\bsolve-\d+-[a-z0-9]+\b/g, "solve-#")
    .replace(/\b\d{3,}\b/g, "#")
    .replace(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/g, "date")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function primaryError(record: RunLedgerRecord): string {
  const terminal = record.layerResults?.find((item) => item.terminal && item.error)?.error;
  if (terminal) return terminal;
  const layerError = record.layerResults?.find((item) => item.error)?.error;
  if (layerError) return layerError;
  const attemptError = record.attemptErrors?.find(Boolean);
  if (attemptError) return attemptError;
  if (record.verification && !record.verification.verified) return record.verification.detail;
  return record.status;
}

function fingerprint(record: RunLedgerRecord): string {
  const operation = record.spec?.operation ?? "unknown-op";
  const entity = record.spec?.entity ?? "unknown-entity";
  return [record.status, operation, entity, normalizeError(primaryError(record))].join(" | ");
}

function bucketCount(records: RunLedgerRecord[], fn: (record: RunLedgerRecord) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const record of records) {
    const key = fn(record);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return new Map([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function parseJsonLines(input: string): RunLedgerRecord[] {
  const records: RunLedgerRecord[] = [];
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RunLedgerRecord);
    } catch {
      // Ignore malformed lines so one bad append does not break reporting.
    }
  }
  return records;
}

function printMap(title: string, map: Map<string, number>, limit = 12): void {
  console.log(`\n${title}`);
  for (const [key, value] of [...map.entries()].slice(0, limit)) {
    console.log(`- ${key}: ${value}`);
  }
}

async function main(): Promise<void> {
  const { path, top, emitRegressions } = parseArgs(process.argv.slice(2));
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, "utf8");
  const records = parseJsonLines(raw);

  if (records.length === 0) {
    console.log(`No run records found in ${absolutePath}`);
    return;
  }

  const failures = records.filter((record) => record.status !== "completed");
  const clusters = new Map<string, Cluster>();
  for (const record of failures) {
    const key = fingerprint(record);
    const existing = clusters.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    clusters.set(key, {
      fingerprint: key,
      count: 1,
      sampleRunId: record.runId,
      samplePrompt: record.promptText ?? record.promptPreview ?? "",
      samplePlanner: record.planner,
      sampleStatus: record.status,
    });
  }

  const avgDuration =
    records.reduce((sum, record) => sum + (Number.isFinite(record.durationMs) ? record.durationMs : 0), 0) / records.length;
  const avgRequests =
    records.reduce((sum, record) => sum + (record.traceSummary?.tripletexRequests ?? 0), 0) / records.length;

  console.log(`Run ledger: ${absolutePath}`);
  console.log(`Records: ${records.length}`);
  console.log(`Failures: ${failures.length}`);
  console.log(`Average duration: ${avgDuration.toFixed(1)} ms`);
  console.log(`Average Tripletex requests: ${avgRequests.toFixed(1)}`);

  printMap("By Status", bucketCount(records, (record) => record.status));
  printMap("By Planner", bucketCount(records, (record) => record.planner || "unknown"));
  printMap(
    "By Operation/Entity",
    bucketCount(records, (record) => `${record.spec?.operation ?? "unknown-op"} / ${record.spec?.entity ?? "unknown-entity"}`),
  );

  console.log(`\nTop Failure Clusters`);
  for (const cluster of [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, top)) {
    console.log(`- ${cluster.count}x ${cluster.fingerprint}`);
    console.log(`  sample run: ${cluster.sampleRunId}`);
    console.log(`  sample planner: ${cluster.samplePlanner}`);
    console.log(`  sample prompt: ${cluster.samplePrompt.slice(0, 240)}`);
  }

  if (emitRegressions) {
    const outPath = resolve(emitRegressions);
    const regressions = failures.map((record) => ({
      runId: record.runId,
      startedAt: record.startedAt,
      status: record.status,
      planner: record.planner,
      promptText: record.promptText ?? record.promptPreview ?? "",
      promptPreview: record.promptPreview ?? "",
      spec: record.spec ?? null,
      verification: record.verification ?? null,
      primaryError: primaryError(record),
      fingerprint: fingerprint(record),
    }));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(regressions, null, 2), "utf8");
    console.log(`\nRegression pack written to ${outPath}`);
  }
}

await main();
