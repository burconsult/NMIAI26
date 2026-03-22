import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { buildReport, renderMarkdown } from "./tripletex_feedback/report.js";
import {
  fetchOpenApiEndpoints,
  fetchVercelLogs,
  loadSandboxCorpus,
  parseObservedRuns,
  readCompetitionResultsFromApi,
  readOptionalCompetitionResults,
  readOptionalLedger,
} from "./tripletex_feedback/sources.js";

function parseArgs(argv: string[]): {
  domain: string;
  since: string;
  ledgerPath?: string;
  resultsPath?: string;
  outJson?: string;
  outMarkdown?: string;
  limit: number;
  useApiResults: boolean;
} {
  let domain = "https://nmiai26-tripletex.vercel.app";
  let since = "6h";
  let ledgerPath = process.env.TRIPLETEX_RUN_LEDGER_PATH?.trim() || undefined;
  let resultsPath: string | undefined;
  let useApiResults = false;
  let outJson: string | undefined;
  let outMarkdown: string | undefined;
  let limit = 12;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--domain") {
      domain = argv[++index] || domain;
      continue;
    }
    if (arg === "--since") {
      since = argv[++index] || since;
      continue;
    }
    if (arg === "--ledger") {
      ledgerPath = argv[++index] || ledgerPath;
      continue;
    }
    if (arg === "--results-file") {
      resultsPath = argv[++index] || resultsPath;
      continue;
    }
    if (arg === "--ainm-results") {
      useApiResults = true;
      continue;
    }
    if (arg === "--out-json") {
      outJson = argv[++index];
      continue;
    }
    if (arg === "--out-markdown") {
      outMarkdown = argv[++index];
      continue;
    }
    if (arg === "--limit") {
      limit = Number(argv[++index] || limit) || limit;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return { domain, since, ledgerPath, resultsPath, outJson, outMarkdown, limit, useApiResults };
}

async function writeOptionalOutput(pathValue: string | undefined, contents: string): Promise<void> {
  if (!pathValue) return;
  const outPath = resolve(pathValue);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, contents, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [logs, ledgerRecords, competitionResults, endpoints, sandboxCorpus] = await Promise.all([
    fetchVercelLogs(args.domain, args.since),
    readOptionalLedger(args.ledgerPath),
    args.useApiResults || !args.resultsPath ? readCompetitionResultsFromApi(process.argv.slice(2)) : readOptionalCompetitionResults(args.resultsPath),
    fetchOpenApiEndpoints(),
    loadSandboxCorpus(),
  ]);

  const runs = parseObservedRuns(logs, ledgerRecords);
  const report = buildReport(runs, competitionResults, endpoints, sandboxCorpus, args.domain, args.since, args.limit);
  const markdown = renderMarkdown(report);

  console.log(markdown.trim());

  await writeOptionalOutput(args.outMarkdown, markdown);
  await writeOptionalOutput(args.outJson, `${JSON.stringify(report, null, 2)}\n`);
}

await main();
