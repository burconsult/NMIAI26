import { detectFamily, familyInfo } from "./families.js";
import type { CompetitionMatch, CompetitionResult, FeedbackReport, FamilyInsight, ObservedRun, SandboxMatch } from "./types.js";

function selectOpenApiEndpoints(
  endpoints: Array<{ method: string; path: string; summary: string }>,
  info: FamilyInsight,
): string[] {
  const matches = endpoints.filter((endpoint) => info.openApiPatterns.some((pattern) => pattern.test(endpoint.path) || pattern.test(endpoint.summary)));
  return matches.slice(0, 6).map((endpoint) => `${endpoint.method} ${endpoint.path} :: ${endpoint.summary}`);
}

function selectSandboxMatches(
  corpus: Array<{ file: string; content: string }>,
  info: FamilyInsight,
): SandboxMatch[] {
  const matches: SandboxMatch[] = [];
  for (const doc of corpus) {
    const lines = doc.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!info.sandboxKeywords.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase()))) continue;
      const excerpt = lines.slice(index, Math.min(lines.length, index + 3)).join(" ").trim();
      matches.push({ file: doc.file, excerpt: excerpt.slice(0, 260) });
      break;
    }
    if (matches.length >= 3) break;
  }
  return matches;
}

export function buildReport(
  runs: ObservedRun[],
  competitionResults: CompetitionResult[],
  endpoints: Array<{ method: string; path: string; summary: string }>,
  sandboxCorpus: Array<{ file: string; content: string }>,
  domain: string,
  since: string,
  limit: number,
): FeedbackReport {
  const failures = runs.filter((run) => (run.responseStatusCode && run.responseStatusCode >= 400) || run.status === "failed" || run.status === "failed_verification");
  const competitionMatches = correlateCompetitionResults(runs, competitionResults);
  const lowScoreMatches = competitionMatches.filter((match) => match.result.solved < match.result.total || (match.result.percent ?? 100) < 100);
  const familyCounts = new Map<string, { count: number; sample: ObservedRun }>();

  for (const run of failures) {
    const family = detectFamily(run.promptText || run.promptPreview || "");
    const existing = familyCounts.get(family);
    if (existing) {
      existing.count += 1;
      continue;
    }
    familyCounts.set(family, { count: 1, sample: run });
  }

  for (const match of lowScoreMatches) {
    if (!match.runId) continue;
    const syntheticRun: ObservedRun = {
      runId: match.runId,
      promptPreview: match.promptPreview,
      responseStatusCode: match.responseStatusCode,
      status: match.status,
      verificationDetail: match.verificationDetail,
      attemptErrors: [],
      sources: ["competition:results_match"],
    };
    const existing = familyCounts.get(match.family);
    if (existing) {
      existing.count += 1;
      continue;
    }
    familyCounts.set(match.family, { count: 1, sample: syntheticRun });
  }

  const families = [...familyCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([family, payload]) => {
      const info = familyInfo(family);
      return {
        family: info.id,
        label: info.label,
        count: payload.count,
        sampleRunId: payload.sample.runId,
        samplePrompt: (payload.sample.promptText || payload.sample.promptPreview || "").slice(0, 320),
        priorities: info.priority,
        nextAction: info.nextAction,
        openApiEndpoints: selectOpenApiEndpoints(endpoints, info),
        sandboxMatches: selectSandboxMatches(sandboxCorpus, info),
        canaryNeeded: info.canaryNeeded,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    domain,
    since,
    totalObservedRuns: runs.length,
    failingRuns: failures.length,
    competitionResults: competitionResults.length,
    families,
    latestFailures: failures.slice(0, limit).map((run) => ({
      runId: run.runId,
      responseStatusCode: run.responseStatusCode ?? run.httpStatus,
      status: run.status,
      family: detectFamily(run.promptText || run.promptPreview || ""),
      promptPreview: (run.promptText || run.promptPreview || "").slice(0, 320),
      verificationDetail: run.verificationDetail,
      attemptErrors: run.attemptErrors.slice(0, 3),
    })),
    latestCompetitionMatches: competitionMatches.slice(0, limit),
  };
}

export function renderMarkdown(report: FeedbackReport): string {
  const lines: string[] = [];
  lines.push("# Tripletex Feedback Loop Report");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Domain: ${report.domain}`);
  lines.push(`- Window: ${report.since}`);
  lines.push(`- Observed runs: ${report.totalObservedRuns}`);
  lines.push(`- Failing runs: ${report.failingRuns}`);
  lines.push(`- Competition results: ${report.competitionResults}`);
  lines.push("");
  lines.push("## Highest-Value Families");
  lines.push("");
  for (const family of report.families) {
    lines.push(`### ${family.label}`);
    lines.push(`- Count: ${family.count}`);
    lines.push(`- Priority: ${family.priorities}`);
    lines.push(`- Sample run: ${family.sampleRunId}`);
    lines.push(`- Sample prompt: ${family.samplePrompt}`);
    lines.push(`- Next action: ${family.nextAction}`);
    lines.push(`- Promote to canary: ${family.canaryNeeded ? "yes" : "no"}`);
    if (family.openApiEndpoints.length > 0) {
      lines.push("- Public API evidence:");
      for (const endpoint of family.openApiEndpoints) lines.push(`  - ${endpoint}`);
    }
    if (family.sandboxMatches.length > 0) {
      lines.push("- Sandbox findings:");
      for (const match of family.sandboxMatches) lines.push(`  - ${match.file}: ${match.excerpt}`);
    }
    lines.push("");
  }
  lines.push("## Latest Failures");
  lines.push("");
  for (const failure of report.latestFailures) {
    lines.push(`- ${failure.runId} :: ${failure.family} :: http=${failure.responseStatusCode ?? "n/a"} :: ${failure.promptPreview}`);
    if (failure.verificationDetail) lines.push(`  - verification: ${failure.verificationDetail}`);
    for (const error of failure.attemptErrors) lines.push(`  - error: ${error}`);
  }
  lines.push("");
  if (report.latestCompetitionMatches.length > 0) {
    lines.push("## Competition Matches");
    lines.push("");
    for (const match of report.latestCompetitionMatches) {
      lines.push(`- ${match.result.taskLabel} @ ${new Date(match.result.timestamp).toISOString()} :: ${match.result.solved}/${match.result.total} (${match.result.percent ?? "n/a"}%)`);
      lines.push(`  - runId: ${match.runId ?? "unmatched"}`);
      lines.push(`  - family: ${match.family}`);
      if (match.promptPreview) lines.push(`  - prompt: ${match.promptPreview}`);
      if (match.verificationDetail) lines.push(`  - verification: ${match.verificationDetail}`);
    }
    lines.push("");
  }
  lines.push("## Operating Rule");
  lines.push("");
  lines.push("Do not make the live solver self-modifying. Keep /solve deterministic and run adaptation outside it:");
  lines.push("- ingest production logs");
  lines.push("- merge run ledger");
  lines.push("- map failures to public API capability and sandbox evidence");
  lines.push("- turn repeated families into regressions and canaries");
  return `${lines.join("\n")}\n`;
}

function isCanaryRun(run: ObservedRun): boolean {
  if (run.debugMode) return true;
  const text = `${run.promptText ?? ""} ${run.promptPreview ?? ""}`.toLowerCase();
  return text.includes("canary");
}

function correlateCompetitionResults(runs: ObservedRun[], results: CompetitionResult[]): CompetitionMatch[] {
  const candidates = runs.filter((run) => !isCanaryRun(run) && typeof run.timestamp === "number");
  const remaining = new Set(candidates.map((run) => run.runId));
  const sortedRuns = [...candidates].sort((a, b) => Math.abs((a.timestamp ?? 0) - (b.timestamp ?? 0)));
  const matches: CompetitionMatch[] = [];

  for (const result of results) {
    let best: ObservedRun | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const run of sortedRuns) {
      if (!remaining.has(run.runId) || typeof run.timestamp !== "number") continue;
      const deltaMs = Math.abs(run.timestamp - result.timestamp);
      if (deltaMs > 20 * 60 * 1000) continue;
      const expectedDurationMs = typeof result.durationSeconds === "number" ? result.durationSeconds * 1000 : null;
      const durationPenalty =
        expectedDurationMs !== null && typeof run.durationMs === "number"
          ? Math.min(4 * 60 * 1000, Math.abs(run.durationMs - expectedDurationMs) * 0.5)
          : 90 * 1000;
      const score = deltaMs + durationPenalty;
      if (score < bestScore) {
        best = run;
        bestScore = score;
      }
    }
    if (best) {
      remaining.delete(best.runId);
    }
    const promptPreview = (best?.promptText || best?.promptPreview || "").slice(0, 320);
    matches.push({
      result,
      runId: best?.runId,
      family: detectFamily(promptPreview),
      promptPreview,
      responseStatusCode: best?.responseStatusCode ?? best?.httpStatus,
      status: best?.status,
      verificationDetail: best?.verificationDetail,
    });
  }

  return matches.sort((a, b) => b.result.timestamp - a.result.timestamp);
}
