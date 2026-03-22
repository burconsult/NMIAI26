export type AinmTripletexSubmission = {
  id: string;
  status: string;
  queued_at: string;
  completed_at?: string | null;
  score_raw?: number;
  score_max?: number;
  normalized_score?: number;
  duration_ms?: number;
  feedback?: {
    comment?: string;
    checks?: string[];
  };
};

export type CreateTripletexSubmissionOptions = {
  accessToken: string;
  endpointUrl: string;
  endpointApiKey?: string;
  taskId?: string;
};

export type WaitForSubmissionOptions = {
  accessToken: string;
  submissionId: string;
  pollMs?: number;
  timeoutMs?: number;
};

export const AINM_API_BASE = "https://api.ainm.no";
export const TRIPLETEX_TASK_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function formatResponseBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

export async function ainmRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${AINM_API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      origin: "https://app.ainm.no",
      referer: "https://app.ainm.no/",
      cookie: `access_token=${accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`AINM API ${response.status} ${response.statusText} for ${path}: ${formatResponseBody(bodyText)}`);
  }
  if (!bodyText.trim()) return undefined as T;
  return JSON.parse(bodyText) as T;
}

export async function listMyTripletexSubmissions(accessToken: string): Promise<AinmTripletexSubmission[]> {
  const submissions = await ainmRequest<AinmTripletexSubmission[]>("/tripletex/my/submissions", accessToken, { method: "GET" });
  return Array.isArray(submissions) ? submissions : [];
}

export async function createTripletexSubmission(
  options: CreateTripletexSubmissionOptions,
): Promise<unknown> {
  const taskId = options.taskId || TRIPLETEX_TASK_ID;
  return ainmRequest(`/tasks/${taskId}/submissions`, options.accessToken, {
    method: "POST",
    body: JSON.stringify({
      endpoint_url: options.endpointUrl,
      endpoint_api_key: options.endpointApiKey || "",
    }),
  });
}

export function isTerminalSubmissionStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

export async function waitForTripletexSubmission(
  options: WaitForSubmissionOptions,
): Promise<AinmTripletexSubmission> {
  const pollMs = Math.max(500, options.pollMs ?? 5_000);
  const timeoutMs = Math.max(pollMs, options.timeoutMs ?? 15 * 60_000);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const submissions = await listMyTripletexSubmissions(options.accessToken);
    const match = submissions.find((submission) => submission.id === options.submissionId);
    if (match && isTerminalSubmissionStatus(match.status)) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for submission ${options.submissionId}`);
}

export function extractSubmissionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  return typeof object.id === "string" ? object.id : undefined;
}

export function parseFlag(argv: string[], name: string): string | undefined {
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

export function resolveAinmAccessToken(argv: string[]): string {
  const token = parseFlag(argv, "access-token") ?? process.env.AINM_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing AINM access token. Set AINM_ACCESS_TOKEN or pass --access-token.");
  }
  return token;
}

export function submissionPercent(submission: AinmTripletexSubmission): number | undefined {
  if (!Number.isFinite(submission.score_raw) || !Number.isFinite(submission.score_max) || !submission.score_max) return undefined;
  return Math.round(((submission.score_raw || 0) / (submission.score_max || 1)) * 100);
}

export function formatScoreLabel(value: number | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : String(Number(value).toFixed(1));
}
