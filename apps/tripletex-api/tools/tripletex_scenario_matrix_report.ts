import fs from "node:fs/promises";
import path from "node:path";

import { TRIPLETEX_SCENARIO_MATRIX, summarizeScenarioMatrix } from "./tripletex_scenario_matrix.ts";

function parseFlag(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function renderMarkdown(): string {
  const summary = summarizeScenarioMatrix();
  const lines: string[] = [];
  lines.push("# Tripletex Scenario Matrix");
  lines.push("");
  lines.push(`- Total scenarios: ${summary.total}`);
  lines.push(`- Live-candidate scenarios: ${summary.liveCandidates}`);
  lines.push("");
  lines.push("## By Family");
  for (const [family, count] of Object.entries(summary.byFamily)) {
    lines.push(`- ${family}: ${count}`);
  }
  lines.push("");
  lines.push("## By Locale");
  for (const [locale, count] of Object.entries(summary.byLocale)) {
    lines.push(`- ${locale}: ${count}`);
  }
  lines.push("");
  lines.push("## By Mode");
  for (const [mode, count] of Object.entries(summary.byMode)) {
    lines.push(`- ${mode}: ${count}`);
  }
  lines.push("");
  lines.push("## Scenarios");
  for (const scenario of TRIPLETEX_SCENARIO_MATRIX) {
    lines.push(`### ${scenario.id}`);
    lines.push(`- Family: ${scenario.family}`);
    lines.push(`- Locale: ${scenario.locale}`);
    lines.push(`- Mode: ${scenario.mode}`);
    lines.push(`- Source: ${scenario.source}`);
    lines.push(`- Live candidate: ${scenario.liveCandidate ? "yes" : "no"}`);
    lines.push(`- Expected route: ${scenario.expected.operation} ${scenario.expected.entity}`);
    lines.push(`- Prompt: ${scenario.prompt}`);
    if (scenario.attachmentFacts?.length) {
      lines.push("- Attachment facts:");
      for (const fact of scenario.attachmentFacts) lines.push(`  - ${fact}`);
    }
    if (scenario.notes) lines.push(`- Notes: ${scenario.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function maybeWrite(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) return;
  const resolved = path.resolve(process.cwd(), filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
  console.log(`Wrote ${resolved}`);
}

async function main(): Promise<void> {
  const markdown = renderMarkdown();
  const json = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: summarizeScenarioMatrix(),
      scenarios: TRIPLETEX_SCENARIO_MATRIX,
    },
    null,
    2,
  );

  await maybeWrite(parseFlag("out-markdown"), markdown);
  await maybeWrite(parseFlag("out-json"), json);

  console.log(markdown);
}

await main();
