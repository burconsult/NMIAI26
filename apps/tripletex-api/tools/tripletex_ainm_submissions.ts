import { formatScoreLabel, listMyTripletexSubmissions, resolveAinmAccessToken, submissionPercent } from "./tripletex_ainm_client.ts";

function parseLimit(argv: string[]): number {
  const index = argv.findIndex((arg) => arg === "--limit");
  if (index >= 0 && argv[index + 1]) return Number(argv[index + 1]) || 20;
  const inline = argv.find((arg) => arg.startsWith("--limit="));
  if (inline) return Number(inline.slice("--limit=".length)) || 20;
  return 20;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accessToken = resolveAinmAccessToken(argv);
  const limit = Math.max(1, parseLimit(argv));
  const json = argv.includes("--json");
  const submissions = await listMyTripletexSubmissions(accessToken);
  const selected = submissions.slice(0, limit);

  if (json) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  console.log(`Tripletex submissions (${selected.length}/${submissions.length})`);
  for (const submission of selected) {
    const percent = submissionPercent(submission);
    const checks = submission.feedback?.checks?.length ?? 0;
    console.log(
      [
        submission.id,
        submission.status,
        submission.queued_at,
        `${formatScoreLabel(submission.score_raw)}/${formatScoreLabel(submission.score_max)}`,
        percent === undefined ? "-" : `${percent}%`,
        `${submission.duration_ms ?? 0}ms`,
        `${checks} checks`,
      ].join(" | "),
    );
    if (submission.feedback?.comment) {
      console.log(`  ${submission.feedback.comment}`);
    }
  }
}

await main();
