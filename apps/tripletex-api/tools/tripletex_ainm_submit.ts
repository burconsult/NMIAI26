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

function resolveEndpoint(argv: string[]): string {
  return parseFlag(argv, "endpoint") ?? process.env.TRIPLETEX_SOLVE_URL?.trim() ?? "https://nmiai26-tripletex.vercel.app/solve";
}

function resolveEndpointApiKey(argv: string[]): string | undefined {
  return parseFlag(argv, "api-key") ?? process.env.TRIPLETEX_API_KEY?.trim() ?? undefined;
}

function resolvePollMs(argv: string[]): number {
  return Number(parseFlag(argv, "poll-ms") ?? "5000") || 5000;
}

function resolveTimeoutMs(argv: string[]): number {
  return Number(parseFlag(argv, "timeout-ms") ?? `${15 * 60_000}`) || 15 * 60_000;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accessToken = resolveAinmAccessToken(argv);
  const endpointUrl = resolveEndpoint(argv);
  const endpointApiKey = resolveEndpointApiKey(argv);
  const wait = !argv.includes("--no-wait");
  const pollMs = resolvePollMs(argv);
  const timeoutMs = resolveTimeoutMs(argv);

  const before = await listMyTripletexSubmissions(accessToken);
  const beforeIds = new Set(before.map((submission) => submission.id));
  const response = await createTripletexSubmission({
    accessToken,
    endpointUrl,
    endpointApiKey,
  });

  const responseId = extractSubmissionId(response);
  console.log(`Submitted endpoint ${endpointUrl}`);
  if (responseId) console.log(`Submission id: ${responseId}`);
  console.log(`Response: ${JSON.stringify(response)}`);

  if (!wait) return;

  let submissionId = responseId;
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
    throw new Error("Could not identify newly created submission id");
  }

  const completed = await waitForTripletexSubmission({
    accessToken,
    submissionId,
    pollMs,
    timeoutMs,
  });
  const percent = submissionPercent(completed);
  console.log(
    [
      completed.id,
      completed.status,
      `${formatScoreLabel(completed.score_raw)}/${formatScoreLabel(completed.score_max)}`,
      percent === undefined ? "-" : `${percent}%`,
      `${completed.duration_ms ?? 0}ms`,
    ].join(" | "),
  );
  if (completed.feedback?.comment) {
    console.log(completed.feedback.comment);
  }
  for (const check of completed.feedback?.checks ?? []) {
    console.log(check);
  }
}

await main();
