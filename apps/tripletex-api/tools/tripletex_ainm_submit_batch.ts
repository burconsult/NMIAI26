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

function resolveNumber(argv: string[], name: string, fallback: number): number {
  return Number(parseFlag(argv, name) ?? String(fallback)) || fallback;
}

function resolveEndpoint(argv: string[]): string {
  return parseFlag(argv, "endpoint") ?? process.env.TRIPLETEX_SOLVE_URL?.trim() ?? "https://nmiai26-tripletex.vercel.app/solve";
}

function resolveEndpointApiKey(argv: string[]): string | undefined {
  return parseFlag(argv, "api-key") ?? process.env.TRIPLETEX_API_KEY?.trim() ?? undefined;
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
    throw new Error(`Worker could not identify submission id for job ${index}/${total}`);
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
    `[${index}/${total}] ${completed.id} | ${completed.status} | ${formatScoreLabel(completed.score_raw)}/${formatScoreLabel(completed.score_max)} | ${
      percent === undefined ? "-" : `${percent}%`
    } | ${completed.duration_ms ?? 0}ms`,
  );
  if (completed.feedback?.comment) {
    console.log(`[${index}/${total}] ${completed.feedback.comment}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accessToken = resolveAinmAccessToken(argv);
  const endpointUrl = resolveEndpoint(argv);
  const endpointApiKey = resolveEndpointApiKey(argv);
  const count = Math.max(1, resolveNumber(argv, "count", 3));
  const concurrency = Math.max(1, Math.min(3, resolveNumber(argv, "concurrency", 2)));
  const pollMs = Math.max(500, resolveNumber(argv, "poll-ms", 5000));
  const timeoutMs = Math.max(pollMs, resolveNumber(argv, "timeout-ms", 15 * 60_000));

  console.log(`Batch submit: count=${count} concurrency=${concurrency} endpoint=${endpointUrl}`);

  let next = 1;
  const worker = async (): Promise<void> => {
    while (next <= count) {
      const current = next;
      next += 1;
      await submitOne(current, count, accessToken, endpointUrl, endpointApiKey, pollMs, timeoutMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
}

await main();
