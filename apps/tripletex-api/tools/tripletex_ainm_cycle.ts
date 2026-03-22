import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createTripletexSubmission,
  extractSubmissionId,
  formatScoreLabel,
  listMyTripletexSubmissions,
  parseFlag,
  resolveAinmAccessToken,
  submissionPercent,
  waitForTripletexSubmission,
} from "./tripletex_ainm_client.ts";
import { buildReport, renderMarkdown } from "./tripletex_feedback/report.js";
import {
  fetchOpenApiEndpoints,
  fetchVercelLogs,
  loadSandboxCorpus,
  parseObservedRuns,
  readCompetitionResultsFromApi,
  readOptionalLedger,
} from "./tripletex_feedback/sources.js";

function resolveNumber(argv: string[], name: string, fallback: number): number {
  return Number(parseFlag(argv, name) ?? String(fallback)) || fallback;
}

function resolveEndpoint(argv: string[]): string {
  return parseFlag(argv, "endpoint") ?? process.env.TRIPLETEX_SOLVE_URL?.trim() ?? "https://nmiai26-tripletex.vercel.app/solve";
}

function resolveEndpointApiKey(argv: string[]): string | undefined {
  return parseFlag(argv, "api-key") ?? process.env.TRIPLETEX_API_KEY?.trim() ?? undefined;
}

async function writeOptional(pathValue: string | undefined, contents: string): Promise<void> {
  if (!pathValue) return;
  const outPath = resolve(pathValue);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, contents, "utf8");
}

async function submitOne(
  index: number,
  total: number,
  accessToken: string,
  endpointUrl: string,
  endpointApiKey: string | undefined,
  pollMs: number,
  timeoutMs: number,
): Promise<void> {
  const before = await listMyTripletexSubmissions(accessToken);
  const beforeIds = new Set(before.map((submission) => submission.id));
  const response = await createTripletexSubmission({
    accessToken,
    endpointUrl,
    endpointApiKey,
  });
  let submissionId = extractSubmissionId(response);

  if (!submissionId) {
    const deadline = Date.now() + 30_000;
    while (!submissionId && Date.now() < deadline) {
      const submissions = await listMyTripletexSubmissions(accessToken);
      const fresh = submissions.find((submission) => !beforeIds.has(submission.id));
      if (fresh) submissionId = fresh.id;
      if (!submissionId) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  if (!submissionId) {
    throw new Error(`Could not identify submission id for job ${index}/${total}`);
  }

  console.log(`[${index}/${total}] submitted ${submissionId}`);
  const completed = await waitForTripletexSubmission({
    accessToken,
    submissionId,
    pollMs,
    timeoutMs,
  });
  const percent = submissionPercent(completed);
  console.log(
    `[${index}/${total}] ${completed.id} | ${completed.status} | ${formatScoreLabel(completed.score_raw)}/${formatScoreLabel(
      completed.score_max,
    )} | ${percent === undefined ? "-" : `${percent}%`} | ${completed.duration_ms ?? 0}ms`,
  );
  if (completed.feedback?.comment) {
    console.log(`[${index}/${total}] ${completed.feedback.comment}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accessToken = resolveAinmAccessToken(argv);
  const endpointUrl = resolveEndpoint(argv);
  const endpointOrigin = new URL(endpointUrl).origin;
  const endpointApiKey = resolveEndpointApiKey(argv);
  const count = Math.max(1, resolveNumber(argv, "count", 12));
  const concurrency = Math.max(1, Math.min(3, resolveNumber(argv, "concurrency", 3)));
  const pollMs = Math.max(500, resolveNumber(argv, "poll-ms", 5000));
  const timeoutMs = Math.max(pollMs, resolveNumber(argv, "timeout-ms", 15 * 60_000));
  const since = parseFlag(argv, "since") ?? "3h";
  const limit = Math.max(1, resolveNumber(argv, "limit", 12));
  const ledgerPath = process.env.TRIPLETEX_RUN_LEDGER_PATH?.trim() || undefined;
  const outMarkdown = parseFlag(argv, "out-markdown") ?? "reports/feedback/latest.md";
  const outJson = parseFlag(argv, "out-json") ?? "reports/feedback/latest.json";

  console.log(`Cycle start: count=${count} concurrency=${concurrency} endpoint=${endpointUrl}`);

  let next = 1;
  const worker = async (): Promise<void> => {
    while (next <= count) {
      const current = next;
      next += 1;
      await submitOne(current, count, accessToken, endpointUrl, endpointApiKey, pollMs, timeoutMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));

  const [logs, ledgerRecords, competitionResults, endpoints, sandboxCorpus] = await Promise.all([
    fetchVercelLogs(endpointOrigin, since),
    readOptionalLedger(ledgerPath),
    readCompetitionResultsFromApi(["--access-token", accessToken]),
    fetchOpenApiEndpoints(),
    loadSandboxCorpus(),
  ]);
  const runs = parseObservedRuns(logs, ledgerRecords);
  const report = buildReport(runs, competitionResults, endpoints, sandboxCorpus, endpointOrigin, since, limit);
  const markdown = renderMarkdown(report);

  console.log("");
  console.log(markdown.trim());

  await writeOptional(outMarkdown, markdown);
  await writeOptional(outJson, `${JSON.stringify(report, null, 2)}\n`);
}

await main();
