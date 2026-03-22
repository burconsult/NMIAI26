import { access, readFile, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { formatScoreLabel, listMyTripletexSubmissions, resolveAinmAccessToken, submissionPercent } from "../tripletex_ainm_client.ts";
import type { CompetitionResult, ObservedRun, RunLedgerRecord, VercelLogEntry } from "./types.js";

const execFile = promisify(execFileCallback);

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function fetchVercelLogs(domain: string, since: string): Promise<VercelLogEntry[]> {
  const { stdout } = await execFile("npx", ["vercel", "logs", domain, "--no-follow", "--since", since, "--json"], {
    cwd: process.cwd(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const parsed = safeJsonParse<VercelLogEntry>(line);
      return parsed ? [parsed] : [];
    });
}

export async function readOptionalLedger(pathValue: string | undefined): Promise<RunLedgerRecord[]> {
  if (!pathValue) return [];
  try {
    await access(pathValue);
  } catch {
    return [];
  }
  const raw = await readFile(pathValue, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = safeJsonParse<RunLedgerRecord>(line);
      return parsed ? [parsed] : [];
    });
}

function currentLocalDateParts(): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  return {
    year: Number(parts.find((part) => part.type === "year")?.value ?? "0"),
    month: Number(parts.find((part) => part.type === "month")?.value ?? "0"),
    day: Number(parts.find((part) => part.type === "day")?.value ?? "0"),
  };
}

function parseLocalTimestamp(label: string): number | null {
  const match = label.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  const { year, month, day } = currentLocalDateParts();
  const stamp = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(stamp) ? stamp : null;
}

export function parseCompetitionResults(raw: string): CompetitionResult[] {
  const normalized = raw.replace(/\r\n/g, "\n");
  const blockRegex =
    /Task\s+\(([\d.]+)\/(\d+)\)\s*\n+\s*(\d{1,2}:\d{2}\s*[AP]M)\s*·\s*([\d.]+)s\s*\n+\s*([\d.]+)\/(\d+)\s+\((\d+)%\)/g;
  const results: CompetitionResult[] = [];
  for (const match of normalized.matchAll(blockRegex)) {
    const [, labelSolved, labelTotal, timeLabel, durationLabel, solvedLabel, totalLabel, percentLabel] = match;
    const timestamp = parseLocalTimestamp(timeLabel || "");
    if (!timestamp) continue;
    results.push({
      taskLabel: `Task (${labelSolved}/${labelTotal})`,
      solved: Number(solvedLabel),
      total: Number(totalLabel),
      percent: Number(percentLabel),
      durationSeconds: Number(durationLabel),
      timestamp,
      rawBlock: match[0],
    });
  }
  return results.sort((a, b) => b.timestamp - a.timestamp);
}

export async function readOptionalCompetitionResults(pathValue: string | undefined): Promise<CompetitionResult[]> {
  if (!pathValue) return [];
  try {
    await access(pathValue);
  } catch {
    return [];
  }
  const raw = await readFile(pathValue, "utf8");
  return parseCompetitionResults(raw);
}

export async function readCompetitionResultsFromApi(argv: string[] = process.argv.slice(2)): Promise<CompetitionResult[]> {
  let accessToken: string;
  try {
    accessToken = resolveAinmAccessToken(argv);
  } catch {
    return [];
  }
  const submissions = await listMyTripletexSubmissions(accessToken);
  return submissions
    .map((submission) => {
      const solved = Number(submission.score_raw ?? 0);
      const total = Number(submission.score_max ?? 0);
      const percent = submissionPercent(submission);
      const timestamp = Date.parse(submission.queued_at);
      return {
        taskLabel: `Task (${formatScoreLabel(solved)}/${formatScoreLabel(total)})`,
        solved,
        total,
        percent,
        durationSeconds: submission.duration_ms ? submission.duration_ms / 1000 : undefined,
        timestamp,
        rawBlock: JSON.stringify(submission),
        submissionId: submission.id,
        status: submission.status,
      } satisfies CompetitionResult;
    })
    .filter((result) => Number.isFinite(result.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function extractRunIdFromFailureMessage(message: string): string | undefined {
  return message.match(/runId:\s*'([^']+)'/)?.[1];
}

function mergeRun(target: ObservedRun, patch: Partial<ObservedRun>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "attemptErrors" && Array.isArray(value)) {
      target.attemptErrors.push(...value.filter((item) => !target.attemptErrors.includes(item)));
      continue;
    }
    if (key === "sources" && Array.isArray(value)) {
      target.sources.push(...value.filter((item) => !target.sources.includes(item)));
      continue;
    }
    (target as Record<string, unknown>)[key] = value;
  }
}

function observedRun(runId: string): ObservedRun {
  return {
    runId,
    attemptErrors: [],
    sources: [],
  };
}

export function parseObservedRuns(logs: VercelLogEntry[], ledgerRecords: RunLedgerRecord[]): ObservedRun[] {
  const runs = new Map<string, ObservedRun>();
  const ensure = (runId: string): ObservedRun => {
    const existing = runs.get(runId);
    if (existing) return existing;
    const created = observedRun(runId);
    runs.set(runId, created);
    return created;
  };

  for (const entry of logs) {
    const message = entry.message || "";
    if (message.startsWith("tripletex_feedback_signal ")) {
      const parsed = safeJsonParse<{
        runId: string;
        promptFingerprint?: string;
        debugMode?: boolean;
        status?: string;
        httpStatus?: number;
        planner?: string;
        promptPreview?: string;
        promptLength?: number;
        fileCount?: number;
        durationMs?: number;
        entity?: string;
        operation?: string;
        verified?: boolean;
        verificationDetail?: string;
        primaryError?: string;
      }>(message.slice("tripletex_feedback_signal ".length));
      if (!parsed?.runId) continue;
      mergeRun(ensure(parsed.runId), {
        timestamp: entry.timestamp,
        deploymentId: entry.deploymentId,
        responseStatusCode: entry.responseStatusCode,
        promptFingerprint: parsed.promptFingerprint,
        debugMode: parsed.debugMode,
        status: parsed.status,
        httpStatus: parsed.httpStatus,
        planner: parsed.planner,
        promptPreview: parsed.promptPreview,
        promptLength: parsed.promptLength,
        fileCount: parsed.fileCount,
        durationMs: parsed.durationMs,
        entity: parsed.entity,
        operation: parsed.operation,
        verified: parsed.verified,
        verificationDetail: parsed.verificationDetail,
        attemptErrors: parsed.primaryError ? [parsed.primaryError] : [],
        sources: ["vercel:feedback_signal"],
      });
      continue;
    }
    if (message.startsWith("tripletex_run_start ")) {
      const parsed = safeJsonParse<{ runId: string; promptFingerprint?: string; debugMode?: boolean; promptPreview?: string; promptLength?: number; fileCount?: number }>(
        message.slice("tripletex_run_start ".length),
      );
      if (!parsed?.runId) continue;
      mergeRun(ensure(parsed.runId), {
        timestamp: entry.timestamp,
        deploymentId: entry.deploymentId,
        responseStatusCode: entry.responseStatusCode,
        promptFingerprint: parsed.promptFingerprint,
        debugMode: parsed.debugMode,
        promptPreview: parsed.promptPreview,
        promptLength: parsed.promptLength,
        fileCount: parsed.fileCount,
        sources: ["vercel:run_start"],
      });
      continue;
    }
    if (message.startsWith("tripletex_result ")) {
      const parsed = safeJsonParse<{ runId: string; layer?: string; verified?: boolean; detail?: string; entity?: string; operation?: string }>(
        message.slice("tripletex_result ".length),
      );
      if (!parsed?.runId) continue;
      mergeRun(ensure(parsed.runId), {
        timestamp: entry.timestamp,
        deploymentId: entry.deploymentId,
        responseStatusCode: entry.responseStatusCode,
        planner: parsed.layer,
        verified: parsed.verified,
        verificationDetail: parsed.detail,
        entity: parsed.entity,
        operation: parsed.operation,
        status: entry.responseStatusCode === 200 ? "completed" : undefined,
        sources: ["vercel:result"],
      });
      continue;
    }
    if (message.startsWith("tripletex_run_record ")) {
      const parsed = safeJsonParse<RunLedgerRecord>(message.slice("tripletex_run_record ".length));
      if (!parsed?.runId) continue;
      mergeRun(ensure(parsed.runId), {
        promptFingerprint: parsed.promptFingerprint,
        planner: parsed.planner,
        status: parsed.status,
        httpStatus: parsed.httpStatus,
        promptPreview: parsed.promptPreview,
        promptText: parsed.promptText,
        verified: parsed.verification?.verified,
        verificationDetail: parsed.verification?.detail,
        entity: parsed.spec?.entity,
        operation: parsed.spec?.operation,
        attemptErrors: parsed.attemptErrors ?? [],
        sources: ["vercel:run_record"],
      });
      continue;
    }
    if (message.startsWith("Tripletex all layers failed")) {
      const runId = extractRunIdFromFailureMessage(message);
      if (!runId) continue;
      mergeRun(ensure(runId), {
        timestamp: entry.timestamp,
        deploymentId: entry.deploymentId,
        responseStatusCode: entry.responseStatusCode,
        status: entry.responseStatusCode === 500 ? "failed" : undefined,
        attemptErrors: [message.slice(0, 400)],
        sources: ["vercel:all_layers_failed"],
      });
    }
  }

  for (const record of ledgerRecords) {
    const run = ensure(record.runId);
      mergeRun(run, {
        promptFingerprint: record.promptFingerprint,
        debugMode: record.debugMode,
        planner: record.planner,
      status: record.status,
      httpStatus: record.httpStatus,
      promptText: record.promptText,
      promptPreview: record.promptPreview,
      verified: record.verification?.verified,
      verificationDetail: record.verification?.detail,
      entity: record.spec?.entity,
      operation: record.spec?.operation,
      attemptErrors: record.attemptErrors ?? [],
      sources: ["local:run_ledger"],
    });
  }

  return [...runs.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function fetchOpenApiEndpoints(): Promise<Array<{ method: string; path: string; summary: string }>> {
  const response = await fetch(process.env.TRIPLETEX_OPENAPI_URL || "https://kkpqfuj-amager.tripletex.dev/v2/openapi.json");
  const spec = (await response.json()) as { paths?: Record<string, Record<string, { summary?: string }>> };
  const endpoints: Array<{ method: string; path: string; summary: string }> = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(methods || {})) {
      endpoints.push({ method: method.toUpperCase(), path, summary: operation?.summary || "" });
    }
  }
  return endpoints;
}

export async function loadSandboxCorpus(): Promise<Array<{ file: string; content: string }>> {
  const dir = resolve("docs");
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const corpus: Array<{ file: string; content: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = join(dir, name);
    const content = await readFile(file, "utf8");
    corpus.push({ file, content });
  }
  return corpus;
}
