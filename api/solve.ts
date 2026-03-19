import type { VercelRequest, VercelResponse } from "@vercel/node";

import { summarizeAttachments } from "./_lib/attachments.js";
import { executePlan, heuristicPlan, llmPlan, SolveError } from "./_lib/planner.js";
import { solveRequestSchema } from "./_lib/schemas.js";
import { TripletexClient, TripletexError } from "./_lib/tripletex.js";

export const config = {
  maxDuration: 300,
};

function normalizeSolveBody(body: unknown): unknown {
  let input = body;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return body;
    }
  }
  if (!input || typeof input !== "object") return input;

  const raw = input as Record<string, unknown>;
  const rawCreds = (raw.tripletex_credentials ?? raw.tripletexCredentials) as unknown;
  const creds =
    rawCreds && typeof rawCreds === "object"
      ? (rawCreds as Record<string, unknown>)
      : undefined;

  const normalizedFiles = Array.isArray(raw.files)
    ? raw.files.map((file) => {
        if (!file || typeof file !== "object") return file;
        const item = file as Record<string, unknown>;
        return {
          ...item,
          filename:
            typeof item.filename === "string"
              ? item.filename
              : typeof item.name === "string"
                ? item.name
                : "attachment",
          content_base64:
            typeof item.content_base64 === "string"
              ? item.content_base64
              : typeof item.contentBase64 === "string"
                ? item.contentBase64
                : typeof item.base64 === "string"
                  ? item.base64
                  : "",
          mime_type:
            typeof item.mime_type === "string"
              ? item.mime_type
              : typeof item.mimeType === "string"
                ? item.mimeType
                : typeof item.type === "string"
                  ? item.type
                  : "application/octet-stream",
        };
      })
    : raw.files === null || raw.files === undefined
      ? []
      : raw.files;

  return {
    ...raw,
    files: normalizedFiles,
    tripletex_credentials: creds
      ? {
          ...creds,
          base_url:
            typeof creds.base_url === "string"
              ? creds.base_url
              : typeof creds.baseUrl === "string"
                ? creds.baseUrl
                : creds.base_url,
          session_token:
            typeof creds.session_token === "string"
              ? creds.session_token
              : typeof creds.sessionToken === "string"
                ? creds.sessionToken
                : creds.session_token,
        }
      : raw.tripletex_credentials,
  };
}

function stringifyUnknown(value: unknown, maxChars = 1500): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function formatAttemptError(error: unknown): string {
  if (error instanceof TripletexError) {
    const body = stringifyUnknown(error.responseBody, 1200);
    const status = error.statusCode ?? "n/a";
    return `${error.message}; endpoint=${error.endpoint}; status=${status}; body=${body}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return stringifyUnknown(error);
}

function validateApiKey(req: VercelRequest): boolean {
  const expected = process.env.TRIPLETEX_API_KEY?.trim();
  if (!expected) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return token === expected;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!validateApiKey(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const normalizedBody = normalizeSolveBody(req.body);
  const parsed = solveRequestSchema.safeParse(normalizedBody);
  if (!parsed.success) {
    console.warn("Invalid solve payload", {
      issues: parsed.error.issues.slice(0, 12).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    });
    res.status(400).json({ error: "Invalid request payload", details: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  const client = new TripletexClient({
    baseUrl: payload.tripletex_credentials.base_url,
    sessionToken: payload.tripletex_credentials.session_token,
    timeoutMs: Number(process.env.TRIPLETEX_HTTP_TIMEOUT_MS || "25000"),
  });
  const dryRun = ["1", "true", "yes"].includes((process.env.TRIPLETEX_DRY_RUN || "").toLowerCase());
  const attachments = await summarizeAttachments(payload.files);

  const maxAttempts = Math.max(1, Number(process.env.TRIPLETEX_LLM_ATTEMPTS || "3"));
  const llmDisabled = process.env.TRIPLETEX_LLM_DISABLED === "1";
  let previousError = "";
  let usedPlanner = "heuristic";
  const llmAttemptErrors: string[] = [];
  const failHard = process.env.TRIPLETEX_FAIL_HARD === "1";
  try {
    if (!llmDisabled) {
      for (let i = 0; i < maxAttempts; i += 1) {
        try {
          const plan = await llmPlan(payload, attachments, previousError || undefined);
          await executePlan(client, plan, dryRun);
          usedPlanner = "vercel-ai-sdk";
          res.status(200).json({ status: "completed" });
          return;
        } catch (error) {
          previousError = formatAttemptError(error);
          llmAttemptErrors.push(previousError);
          if (i === maxAttempts - 1) break;
        }
      }
    }

    const fallbackPlan = heuristicPlan(payload);
    await executePlan(client, fallbackPlan, dryRun);
    res.status(200).json({ status: "completed" });
    return;
  } catch (error) {
    const debug = process.env.TRIPLETEX_DEBUG_ERRORS === "1";
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Tripletex solve error", {
      planner: usedPlanner,
      error: errorMessage,
      llmAttemptErrors,
      kind: error instanceof TripletexError ? "tripletex" : error instanceof SolveError ? "solver" : "unexpected",
      tripletex:
        error instanceof TripletexError
          ? {
              endpoint: error.endpoint,
              statusCode: error.statusCode,
              responseBody: error.responseBody,
            }
          : undefined,
    });

    if (!failHard) {
      res.status(200).json({ status: "completed" });
      return;
    }

    if (error instanceof TripletexError) {
      res.status(500).json({
        error: "Tripletex execution failed",
        planner: usedPlanner,
        endpoint: error.endpoint,
        statusCode: error.statusCode,
        details: debug ? error.responseBody : undefined,
      });
      return;
    }
    if (error instanceof SolveError) {
      res.status(500).json({
        error: "Solver failed",
        planner: usedPlanner,
        details: debug ? { message: error.message, llmAttemptErrors } : undefined,
      });
      return;
    }
    res.status(500).json({
      error: "Unexpected error",
      planner: usedPlanner,
      details: debug ? { message: error instanceof Error ? error.message : String(error), llmAttemptErrors } : undefined,
    });
  }
}
