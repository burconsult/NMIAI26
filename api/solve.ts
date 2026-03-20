import type { VercelRequest, VercelResponse } from "@vercel/node";

import { summarizeAttachments, type AttachmentTraceEvent } from "./_lib/attachments.js";
import {
  executePlan,
  heuristicPlan,
  llmPlan,
  SolveError,
  validatePlanForPrompt,
  type PlannerTraceEvent,
} from "./_lib/planner.js";
import { solveRequestSchema } from "./_lib/schemas.js";
import { TripletexClient, TripletexError, type TripletexCallLogEvent } from "./_lib/tripletex.js";

export const config = {
  maxDuration: 300,
};

function createRunId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `solve-${Date.now()}-${rand}`;
}

function shouldLogSolveTrace(): boolean {
  return process.env.TRIPLETEX_LOGGING_ENABLED !== "0";
}

function shouldLogPayloads(): boolean {
  return process.env.TRIPLETEX_LOG_PAYLOADS === "1";
}

type TraceRecord = {
  runId: string;
  event: string;
  at: string;
} & Record<string, unknown>;

function appendTrace(
  traceEvents: TraceRecord[],
  runId: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  if (!shouldLogSolveTrace()) return;
  const safeDetails = details ? { ...details } : undefined;
  if (safeDetails && "event" in safeDetails) {
    safeDetails.traceEvent = safeDetails.event;
    delete safeDetails.event;
  }
  traceEvents.push({
    runId,
    event,
    at: new Date().toISOString(),
    ...safeDetails,
  });
}

function flushTrace(traceEvents: TraceRecord[], runId: string): void {
  if (!shouldLogSolveTrace() || traceEvents.length === 0) return;
  const chunkSizeRaw = Number(process.env.TRIPLETEX_TRACE_CHUNK_SIZE || "60");
  const chunkSize = Number.isFinite(chunkSizeRaw) ? Math.max(10, Math.min(200, Math.round(chunkSizeRaw))) : 60;
  const totalChunks = Math.ceil(traceEvents.length / chunkSize);
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const events = traceEvents.slice(start, start + chunkSize);
    const payload = {
      runId,
      eventCount: traceEvents.length,
      chunkIndex: index + 1,
      chunkCount: totalChunks,
      events,
    };
    try {
      console.info(`tripletex_trace ${JSON.stringify(payload)}`);
    } catch {
      console.info(
        `tripletex_trace ${JSON.stringify({
          runId,
          event: "trace.flush_failed",
          at: new Date().toISOString(),
          chunkIndex: index + 1,
          chunkCount: totalChunks,
          note: "trace_payload_not_serializable",
        })}`,
      );
    }
  }
}

function tracePlanner(traceEvents: TraceRecord[], runId: string, event: PlannerTraceEvent): void {
  appendTrace(traceEvents, runId, `planner.${event.event}`, event as unknown as Record<string, unknown>);
}

function traceTripletexCall(traceEvents: TraceRecord[], runId: string, event: TripletexCallLogEvent): void {
  appendTrace(traceEvents, runId, `tripletex.${event.kind}`, event as unknown as Record<string, unknown>);
}

function traceAttachment(traceEvents: TraceRecord[], runId: string, event: AttachmentTraceEvent): void {
  appendTrace(traceEvents, runId, `attachment.${event.event}`, event as unknown as Record<string, unknown>);
}

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

function isMutatingExecutionFailure(error: unknown): boolean {
  return error instanceof SolveError && error.message.startsWith("Plan execution failed on mutating steps:");
}

function validateApiKey(req: VercelRequest): boolean {
  const expected = process.env.TRIPLETEX_API_KEY?.trim();
  if (!expected) return true;
  const candidates: string[] = [];

  const authorization = String(req.headers.authorization || "").trim();
  if (authorization) {
    if (authorization.startsWith("Bearer ")) {
      candidates.push(authorization.slice("Bearer ".length).trim());
    } else if (authorization.startsWith("ApiKey ")) {
      candidates.push(authorization.slice("ApiKey ".length).trim());
    } else {
      // Some clients send the raw key without a scheme.
      candidates.push(authorization);
    }
  }

  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string") {
    candidates.push(xApiKey.trim());
  } else if (Array.isArray(xApiKey)) {
    for (const value of xApiKey) {
      if (typeof value === "string") candidates.push(value.trim());
    }
  }

  return candidates.some((candidate) => candidate === expected);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const runId = createRunId();
  const traceEvents: TraceRecord[] = [];
  try {
    appendTrace(traceEvents, runId, "solve.request_received", {
      method: req.method,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
    });

    if (req.method !== "POST") {
      appendTrace(traceEvents, runId, "solve.rejected_method", { method: req.method });
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    if (!validateApiKey(req)) {
      appendTrace(traceEvents, runId, "solve.rejected_unauthorized");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const normalizedBody = normalizeSolveBody(req.body);
    const parsed = solveRequestSchema.safeParse(normalizedBody);
    if (!parsed.success) {
      appendTrace(traceEvents, runId, "solve.validation_failed", {
        issues: parsed.error.issues.slice(0, 12).map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
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
    console.info(
      `tripletex_run_start ${JSON.stringify({
        runId,
        promptPreview: payload.prompt.slice(0, 220),
        promptLength: payload.prompt.length,
        fileCount: payload.files.length,
      })}`,
    );
    appendTrace(traceEvents, runId, "solve.validation_passed", {
      prompt: payload.prompt.slice(0, 500),
      promptLength: payload.prompt.length,
      fileCount: payload.files.length,
      baseUrlHost: new URL(payload.tripletex_credentials.base_url).host,
    });

    const client = new TripletexClient({
      baseUrl: payload.tripletex_credentials.base_url,
      sessionToken: payload.tripletex_credentials.session_token,
      timeoutMs: Number(process.env.TRIPLETEX_HTTP_TIMEOUT_MS || "12000"),
      onEvent: (event) => traceTripletexCall(traceEvents, runId, event),
      logPayloads: shouldLogPayloads(),
      maxLogChars: Math.max(120, Number(process.env.TRIPLETEX_LOG_MAX_CHARS || "500")),
    });
    const dryRun = ["1", "true", "yes"].includes((process.env.TRIPLETEX_DRY_RUN || "").toLowerCase());
    const attachments = await summarizeAttachments(payload.files, 2400, (event) =>
      traceAttachment(traceEvents, runId, event),
    );
    appendTrace(traceEvents, runId, "solve.attachments_summarized", {
      attachments: attachments.map((file) => ({
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        extractionSource: file.extractionSource,
        textLength: file.textExcerpt.length,
      })),
    });

    const maxAttempts = Math.max(1, Number(process.env.TRIPLETEX_LLM_ATTEMPTS || "2"));
    const llmDisabled = process.env.TRIPLETEX_LLM_DISABLED === "1";
    let previousError = "";
    let usedPlanner = "heuristic";
    const llmAttemptErrors: string[] = [];
    const failHard = process.env.TRIPLETEX_FAIL_HARD !== "0";
    try {
      if (!llmDisabled) {
        for (let i = 0; i < maxAttempts; i += 1) {
          appendTrace(traceEvents, runId, "solve.llm_attempt_start", { attempt: i + 1, maxAttempts });
          try {
            const plan = await llmPlan(payload, attachments, previousError || undefined, (event) =>
              tracePlanner(traceEvents, runId, event),
            );
            const planIssues = validatePlanForPrompt(payload.prompt, plan);
            if (planIssues.length > 0) {
              tracePlanner(traceEvents, runId, {
                event: "plan_validation_failed",
                error: planIssues.join(" | "),
              });
              throw new SolveError(`Plan validation failed: ${planIssues.join(" | ")}`);
            }
            tracePlanner(traceEvents, runId, {
              event: "plan_validation_passed",
              totalSteps: plan.steps.length,
            });
            await executePlan(client, plan, dryRun, (event) => tracePlanner(traceEvents, runId, event));
            usedPlanner = "vercel-ai-sdk";
            appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner, llmAttempt: i + 1 });
            res.status(200).json({ status: "completed" });
            return;
          } catch (error) {
            previousError = formatAttemptError(error);
            llmAttemptErrors.push(previousError);
            appendTrace(traceEvents, runId, "solve.llm_attempt_failed", {
              attempt: i + 1,
              error: previousError,
            });
            if (i === maxAttempts - 1) break;
          }
        }
      }

      const fallbackPlan = heuristicPlan(payload);
      appendTrace(traceEvents, runId, "solve.heuristic_fallback", {
        summary: fallbackPlan.summary,
        steps: fallbackPlan.steps.length,
      });
      const fallbackIssues = validatePlanForPrompt(payload.prompt, fallbackPlan);
      if (fallbackIssues.length > 0) {
        appendTrace(traceEvents, runId, "solve.heuristic_fallback_invalid", {
          issues: fallbackIssues,
        });
        throw new SolveError(`Heuristic fallback plan invalid: ${fallbackIssues.join(" | ")}`);
      }
      usedPlanner = "heuristic";
      await executePlan(client, fallbackPlan, dryRun, (event) => tracePlanner(traceEvents, runId, event));
      appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner || "heuristic" });
      res.status(200).json({ status: "completed" });
      return;
    } catch (error) {
      const debug = process.env.TRIPLETEX_DEBUG_ERRORS === "1";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const promptPreview = payload.prompt.slice(0, 300);
      console.error("Tripletex solve error", {
        runId,
        prompt: promptPreview,
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
      appendTrace(traceEvents, runId, "solve.failed", {
        prompt: promptPreview,
        planner: usedPlanner,
        error: errorMessage,
        failHard,
        llmAttemptErrors,
      });

      if (!failHard && !isMutatingExecutionFailure(error)) {
        appendTrace(traceEvents, runId, "solve.completed_fail_soft");
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
      return;
    }
  } finally {
    // Flush one consolidated trace entry per request.
    // This avoids fragmented log ingestion and keeps full run timelines searchable by runId.
    flushTrace(traceEvents, runId);
  }
}
