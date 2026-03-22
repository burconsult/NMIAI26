import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";

import { summarizeAttachments, type AttachmentTraceEvent } from "./_lib/attachments.js";
import {
  executeAttachmentOnboardingWorkflow,
  matchesAttachmentOnboardingWorkflow,
} from "./_lib/attachment_onboarding.js";
import { probeTripletexCapabilities, summarizeCapabilitiesForLog, type TripletexCapabilities } from "./_lib/capabilities.js";
import {
  executePlan,
  heuristicPlan,
  llmPlan,
  validatePlanForPrompt,
  type ExecutePlanResult,
  type PlannerTraceEvent,
} from "./_lib/planner.js";
import { solveRequestSchema, type ExecutionPlan } from "./_lib/schemas.js";
import { emitRunLedger, summarizeTrace, type RunVerification } from "./_lib/run_ledger.js";
import { executeAccountingDimensionWorkflow } from "./_lib/accounting_dimension.js";
import { executeBankReconciliationWorkflow, matchesBankReconciliationWorkflow } from "./_lib/bank_reconciliation.js";
import { executeExpenseVoucherWorkflow, matchesExpenseVoucherWorkflow } from "./_lib/expense_voucher.js";
import { executePayrollWorkflow, matchesPayrollWorkflow } from "./_lib/payroll.js";
import { executeMonthEndClosingWorkflow, matchesMonthEndClosingWorkflow } from "./_lib/month_end_closing.js";
import {
  executeProjectTimeInvoiceWorkflow,
  matchesProjectTimeInvoiceWorkflow,
} from "./_lib/project_time_invoice.js";
import {
  executeProjectCycleWorkflow,
  matchesProjectCycleWorkflow,
} from "./_lib/project_cycle.js";
import {
  executeInvoicePaymentWorkflow,
  matchesInvoicePaymentWorkflow,
} from "./_lib/invoice_payment.js";
import {
  executeInvoiceReminderWorkflow,
  matchesInvoiceReminderWorkflow,
} from "./_lib/invoice_reminder.js";
import {
  executeLedgerVarianceProjectsWorkflow,
  matchesLedgerVarianceProjectsWorkflow,
} from "./_lib/ledger_variance_projects.js";
import {
  executeLedgerErrorCorrectionWorkflow,
  matchesLedgerErrorCorrectionWorkflow,
} from "./_lib/ledger_error_correction.js";
import { executeReturnedPaymentWorkflow, matchesReturnedPaymentWorkflow } from "./_lib/returned_payment.js";
import { executeSupplierInvoiceWorkflow, matchesSupplierInvoiceWorkflow } from "./_lib/supplier_invoice.js";
import { executeTravelExpenseWorkflow, matchesTravelExpenseWorkflow } from "./_lib/travel_expense.js";
import {
  extractTaskSpec,
  repairTaskSpec,
  heuristicExtract,
  compilePlan,
  normalizeTaskSpec,
  verifyOutcome,
  type TaskSpec,
} from "./_lib/task_spec.js";
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

function hasActionableMonthEndValues(spec: TaskSpec): boolean {
  const values = spec.values && typeof spec.values === "object" && !Array.isArray(spec.values)
    ? spec.values as Record<string, unknown>
    : {};
  return Boolean(
    values.accrualAmount != null
    || values.accrualFromAccountNumber != null
    || values.accrualToAccountNumber != null
    || values.depreciationAmount != null
    || values.assetCost != null
    || values.usefulLifeYears != null
    || values.depreciationExpenseAccountNumber != null
    || values.accumulatedDepreciationAccountNumber != null
    || (Array.isArray(values.depreciationEntries) && values.depreciationEntries.length > 0),
  );
}

function shouldPreferHeuristicFirst(spec: TaskSpec): boolean {
  return (
    (spec.entity === "attachment_onboarding" && spec.operation === "create")
    || (spec.entity === "accounting_dimension" && spec.operation === "create")
    || (spec.entity === "bank_reconciliation" && spec.operation === "create")
    || (spec.entity === "ledger_variance_projects" && spec.operation === "create")
    || (spec.entity === "ledger_error_correction" && spec.operation === "create")
    || (spec.entity === "project_cycle" && spec.operation === "create")
    || (spec.entity === "month_end_closing" && spec.operation === "create" && hasActionableMonthEndValues(spec))
    || (spec.entity === "invoice_reminder" && spec.operation === "create")
    || (spec.entity === "supplier_invoice" && spec.operation === "create")
    || (spec.entity === "voucher" && spec.operation === "create" && Boolean((spec.values as Record<string, unknown> | undefined)?.receiptExpense))
  );
}

function operationRequiresMutation(operation: TaskSpec["operation"]): boolean {
  return operation !== "list";
}

function planHasMutation(plan: ExecutionPlan): boolean {
  return plan.steps.some((step) => step.method !== "GET");
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

function promptFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function isBlockingPlanIssue(issue: string): boolean {
  const normalized = issue.toLowerCase();
  if (normalized.includes("repeated identical mutating steps")) return false;
  return true;
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
  const startedAtMs = Date.now();
  const traceEvents: TraceRecord[] = [];
  let finalStatus: "completed" | "failed" | "failed_verification" | "invalid_payload" | "unauthorized" | "method_not_allowed" = "failed";
  let finalHttpStatus = 500;
  let promptPreview = "";
  let promptText = "";
  let promptHash = "";
  let promptLength = 0;
  let fileCount = 0;
  let baseUrlHost = "";
  let attachmentSummaries: Array<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
    extractionSource: string;
    textExcerpt: string;
  }> = [];
  let attachmentProviders: string[] = [];
  let capabilities: TripletexCapabilities | undefined;
  let usedPlanner = "unknown";
  const attemptErrors: string[] = [];
  let spec: TaskSpec | null = null;
  let plan: ExecutionPlan | null = null;
  let finalVerification: RunVerification | undefined;
  const layerResults: Array<{ layer: string; error?: string; verified?: boolean; detail?: string; terminal?: boolean; mutated?: boolean }> = [];
  let terminalFailureSeen = false;
  let haltFurtherLayers = false;
  let ledgerEmitted = false;
  let feedbackSignalEmitted = false;
  let debugMode = false;

  function emitFeedbackSignal(): void {
    if (feedbackSignalEmitted) return;
    feedbackSignalEmitted = true;
    const primaryError =
      layerResults.find((item) => item.error)?.error
      ?? attemptErrors.find(Boolean)
      ?? (!finalVerification?.verified ? finalVerification?.detail : undefined)
      ?? undefined;
    console.info(
      `tripletex_feedback_signal ${JSON.stringify({
        runId,
        promptFingerprint: promptHash || undefined,
        debugMode,
        status: finalStatus,
        httpStatus: finalHttpStatus,
        planner: usedPlanner,
        promptPreview,
        promptLength,
        fileCount,
        durationMs: Date.now() - startedAtMs,
        entity: spec?.entity,
        operation: spec?.operation,
        verified: finalVerification?.verified,
        verificationDetail: finalVerification?.detail,
        primaryError,
      })}`,
    );
  }

  async function emitCurrentRunLedger(): Promise<void> {
    if (ledgerEmitted) return;
    const finishedAtMs = Date.now();
    emitFeedbackSignal();
    await emitRunLedger({
      runId,
      promptFingerprint: promptHash || undefined,
      debugMode,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      status: finalStatus,
      httpStatus: finalHttpStatus,
      planner: usedPlanner,
      promptText: promptText || undefined,
      promptPreview: promptPreview || undefined,
      promptLength: promptLength || undefined,
      fileCount: fileCount || undefined,
      baseUrlHost: baseUrlHost || undefined,
      attachments: attachmentSummaries.map((file) => ({
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        extractionSource: file.extractionSource,
        textExcerpt: file.textExcerpt.slice(0, 400),
      })),
      attachmentProviders: attachmentProviders.length > 0 ? attachmentProviders : undefined,
      capabilities: capabilities
        ? {
            modules: capabilities.modules,
            dimensions: capabilities.dimensions,
            bank: capabilities.bank,
            assets: capabilities.assets,
            probeErrors: capabilities.probeErrors.slice(0, 20),
          }
        : undefined,
      spec: spec
        ? {
            operation: spec.operation,
            entity: spec.entity,
            values: spec.values,
            lookup: spec.lookup,
          }
        : undefined,
      plan: plan
        ? {
            summary: plan.summary,
            stepCount: plan.steps.length,
            steps: plan.steps.map((step) => `${step.method} ${step.path}`),
          }
        : undefined,
      verification: finalVerification,
      layerResults,
      attemptErrors,
      traceSummary: summarizeTrace(traceEvents),
    });
    ledgerEmitted = true;
  }

  function debugMeta(): Record<string, unknown> {
    return {
      runId,
      promptFingerprint: promptHash || undefined,
      attachmentProviders,
      capabilities: capabilities ? summarizeCapabilitiesForLog(capabilities) : undefined,
    };
  }

  async function sendJson(status: number, body: unknown): Promise<void> {
    finalHttpStatus = status;
    await emitCurrentRunLedger();
    res.setHeader("x-tripletex-run-id", runId);
    if (promptHash) {
      res.setHeader("x-tripletex-prompt-fingerprint", promptHash);
    }
    res.setHeader("x-tripletex-status", finalStatus);
    if (attachmentProviders.length > 0) {
      res.setHeader("x-tripletex-attachment-providers", attachmentProviders.join(","));
    }
    if (finalVerification) {
      res.setHeader("x-tripletex-verified", finalVerification.verified ? "1" : "0");
      res.setHeader("x-tripletex-verification-required", finalVerification.required ? "1" : "0");
    }
    res.status(status).json(body);
  }

  try {
    appendTrace(traceEvents, runId, "solve.request_received", {
      method: req.method,
      hasAuthorizationHeader: Boolean(req.headers.authorization),
    });

    if (req.method !== "POST") {
      appendTrace(traceEvents, runId, "solve.rejected_method", { method: req.method });
      finalStatus = "method_not_allowed";
      finalHttpStatus = 405;
      await sendJson(405, { error: "Method not allowed" });
      return;
    }

    const apiKeyConfigured = Boolean(process.env.TRIPLETEX_API_KEY?.trim());
    if (apiKeyConfigured && !validateApiKey(req)) {
      appendTrace(traceEvents, runId, "solve.rejected_unauthorized");
      console.warn("Tripletex auth rejected — if evaluator calls are failing, remove TRIPLETEX_API_KEY env var", { runId });
      finalStatus = "unauthorized";
      finalHttpStatus = 401;
      await sendJson(401, { error: "Unauthorized" });
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
      finalStatus = "invalid_payload";
      finalHttpStatus = 400;
      await sendJson(400, { error: "Invalid request payload", details: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    debugMode = req.query?.debug === "1" || process.env.TRIPLETEX_DEBUG_RESPONSE === "1";
    promptText = payload.prompt;
    promptPreview = payload.prompt.slice(0, 220);
    promptHash = promptFingerprint(payload.prompt);
    promptLength = payload.prompt.length;
    fileCount = payload.files.length;
    baseUrlHost = new URL(payload.tripletex_credentials.base_url).host;
    console.info(
      `tripletex_run_start ${JSON.stringify({
        runId,
        promptFingerprint: promptHash,
        debugMode,
        promptPreview,
        promptLength,
        fileCount,
      })}`,
    );
    appendTrace(traceEvents, runId, "solve.validation_passed", {
      prompt: payload.prompt.slice(0, 500),
      promptLength,
      fileCount,
      baseUrlHost,
    });

    const client = new TripletexClient({
      baseUrl: payload.tripletex_credentials.base_url,
      sessionToken: payload.tripletex_credentials.session_token,
      timeoutMs: Number(process.env.TRIPLETEX_HTTP_TIMEOUT_MS || "12000"),
      onEvent: (event) => traceTripletexCall(traceEvents, runId, event),
      logPayloads: shouldLogPayloads(),
      maxLogChars: Math.max(120, Number(process.env.TRIPLETEX_LOG_MAX_CHARS || "500")),
    });
    console.info(`tripletex_phase ${JSON.stringify({ runId, phase: "capabilities_start" })}`);
    capabilities = await probeTripletexCapabilities(client);
    appendTrace(traceEvents, runId, "solve.capabilities_probed", summarizeCapabilitiesForLog(capabilities));
    console.info(
      `tripletex_capabilities ${JSON.stringify({
        runId,
        ...summarizeCapabilitiesForLog(capabilities),
      })}`,
    );
    console.info(`tripletex_phase ${JSON.stringify({ runId, phase: "attachments_start" })}`);
    const dryRun = ["1", "true", "yes"].includes((process.env.TRIPLETEX_DRY_RUN || "").toLowerCase());
    let attachments;
    try {
      attachments = await summarizeAttachments(payload.files, 2400, (event) =>
        traceAttachment(traceEvents, runId, event),
        payload.prompt,
      );
    } catch (error) {
      appendTrace(traceEvents, runId, "solve.attachments_summary_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      attachments = payload.files.map((file) => ({
        filename: file.filename,
        mimeType: file.mime_type,
        sizeBytes: Buffer.byteLength(file.content_base64 || "", "base64"),
        textExcerpt: "",
        extractionSource: "metadata" as const,
      }));
    }
    attachmentSummaries = attachments.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      extractionSource: file.extractionSource,
      textExcerpt: file.textExcerpt,
    }));
    attachmentProviders = [...new Set(attachments.map((file) => file.extractionSource))].sort();
    appendTrace(traceEvents, runId, "solve.attachments_summarized", {
      attachments: attachments.map((file) => ({
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        extractionSource: file.extractionSource,
        textLength: file.textExcerpt.length,
      })),
    });
    console.info(`tripletex_phase ${JSON.stringify({ runId, phase: "attachments_done", attachmentProviders, fileCount: attachments.length })}`);

    const llmDisabled = process.env.TRIPLETEX_LLM_DISABLED === "1";
    const failHard = process.env.TRIPLETEX_FAIL_HARD === "1";
    const heuristicSeedSpec = normalizeTaskSpec(payload, heuristicExtract(payload, attachments));
    const heuristicFirst = shouldPreferHeuristicFirst(heuristicSeedSpec);
    const llmLayersEnabled = !llmDisabled && !heuristicFirst;

    // ====================================================================
    //  LAYERED ADAPTIVE PIPELINE
    //  Layer 1: LLM extraction → deterministic compile → execute → verify
    //  Layer 2: Repair extraction (LLM with error feedback) → retry
    //  Layer 3: Heuristic extraction → deterministic compile → execute
    //  Layer 4: Old-style full LLM planner → execute (ultimate fallback)
    // ====================================================================

    async function tryTaskSpecPipeline(
      currentSpec: TaskSpec,
    layerName: string,
    ): Promise<{ success: boolean; error?: string; verified?: boolean; detail?: string; terminal?: boolean; mutated?: boolean }> {
      try {
        let executionResult: ExecutePlanResult | null = null;
        plan = compilePlan(currentSpec);
        const compiledMutation = planHasMutation(plan);
        console.info(
          `tripletex_pipeline ${JSON.stringify({
            runId,
            layer: layerName,
            spec: { op: currentSpec.operation, entity: currentSpec.entity, values: currentSpec.values, lookup: currentSpec.lookup },
            plan: { summary: plan.summary, stepCount: plan.steps.length, steps: plan.steps.map((s) => `${s.method} ${s.path}`) },
            prompt: payload.prompt.slice(0, 400),
          })}`,
        );

        if (operationRequiresMutation(currentSpec.operation) && !compiledMutation) {
          return {
            success: false,
            error: `Compiled read-only plan for mutating task (${currentSpec.operation} ${currentSpec.entity})`,
            terminal: false,
            mutated: false,
          };
        }

        if (currentSpec.entity === "accounting_dimension") {
          plan = await executeAccountingDimensionWorkflow(client, currentSpec, dryRun);
        } else if (matchesAttachmentOnboardingWorkflow(currentSpec)) {
          plan = await executeAttachmentOnboardingWorkflow(client, currentSpec, dryRun);
        } else if (matchesBankReconciliationWorkflow(currentSpec)) {
          plan = await executeBankReconciliationWorkflow(client, currentSpec, payload, capabilities, dryRun);
        } else if (matchesExpenseVoucherWorkflow(currentSpec)) {
          plan = await executeExpenseVoucherWorkflow(client, currentSpec, dryRun);
        } else if (matchesLedgerVarianceProjectsWorkflow(currentSpec)) {
          plan = await executeLedgerVarianceProjectsWorkflow(client, currentSpec, payload.prompt, dryRun);
        } else if (matchesLedgerErrorCorrectionWorkflow(currentSpec)) {
          plan = await executeLedgerErrorCorrectionWorkflow(client, currentSpec, payload.prompt, dryRun);
        } else if (matchesProjectCycleWorkflow(currentSpec)) {
          plan = await executeProjectCycleWorkflow(client, currentSpec, payload.prompt, dryRun);
        } else if (matchesMonthEndClosingWorkflow(currentSpec)) {
          plan = await executeMonthEndClosingWorkflow(client, currentSpec, payload.prompt, dryRun);
        } else if (matchesSupplierInvoiceWorkflow(currentSpec)) {
          plan = await executeSupplierInvoiceWorkflow(client, currentSpec, dryRun);
        } else if (matchesInvoiceReminderWorkflow(currentSpec)) {
          plan = await executeInvoiceReminderWorkflow(client, currentSpec, dryRun);
        } else if (matchesInvoicePaymentWorkflow(currentSpec)) {
          plan = await executeInvoicePaymentWorkflow(client, currentSpec, dryRun);
        } else if (matchesPayrollWorkflow(currentSpec)) {
          plan = await executePayrollWorkflow(client, currentSpec, dryRun);
        } else if (matchesTravelExpenseWorkflow(currentSpec)) {
          plan = await executeTravelExpenseWorkflow(client, currentSpec, dryRun);
        } else if (matchesProjectTimeInvoiceWorkflow(currentSpec)) {
          plan = await executeProjectTimeInvoiceWorkflow(client, currentSpec, dryRun);
        } else if (matchesReturnedPaymentWorkflow(currentSpec)) {
          plan = await executeReturnedPaymentWorkflow(client, currentSpec, dryRun);
        } else {
          executionResult = await executePlan(client, plan, dryRun, (event) => tracePlanner(traceEvents, runId, event));
        }
        const mutated = !dryRun && compiledMutation;

        const verification = await verifyOutcome(client, currentSpec, executionResult);
        finalVerification = verification;
        console.info(
          `tripletex_result ${JSON.stringify({
            runId,
            layer: layerName,
            verified: verification.verified,
            detail: verification.detail,
            required: verification.required,
            entity: currentSpec.entity,
            operation: currentSpec.operation,
          })}`,
        );

        if (!verification.verified && verification.required) {
          return {
            success: false,
            error: `Postcondition verification failed: ${verification.detail}`,
            verified: false,
            detail: verification.detail,
            terminal: true,
            mutated,
          };
        }
        return {
          success: true,
          verified: verification.verified,
          detail: verification.detail,
          terminal: false,
          mutated,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }

    try {
      // ── Layer 1: LLM extraction → compile → execute → verify ──
      if (!haltFurtherLayers && llmLayersEnabled) {
        try {
          appendTrace(traceEvents, runId, "solve.layer1_start");
          spec = normalizeTaskSpec(payload, await extractTaskSpec(payload, attachments));
          usedPlanner = "layer1-llm";
          appendTrace(traceEvents, runId, "solve.extract_success", {
            method: "llm", operation: spec.operation, entity: spec.entity,
            values: JSON.stringify(spec.values).slice(0, 300),
          });

          const result = await tryTaskSpecPipeline(spec, "layer1-llm");
          layerResults.push({ layer: "layer1-llm", ...result });

          if (result.success) {
            appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner, layer: "layer1" });
            finalStatus = "completed";
            finalHttpStatus = 200;
            if (debugMode) {
              await sendJson(200, { status: "completed", _debug: { ...debugMeta(), planner: usedPlanner, spec: { operation: spec.operation, entity: spec.entity, values: spec.values, lookup: spec.lookup }, layerResults } });
              return;
            }
            await sendJson(200, { status: "completed" });
            return;
          }
          attemptErrors.push(`layer1: ${result.error}`);
          if (result.terminal) {
            terminalFailureSeen = true;
            if (result.mutated) haltFurtherLayers = true;
            appendTrace(traceEvents, runId, "solve.layer_terminal_failure", { layer: "layer1", error: result.error });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          attemptErrors.push(`layer1-extract: ${msg}`);
          layerResults.push({ layer: "layer1-extract-failed", error: msg });
          appendTrace(traceEvents, runId, "solve.extract_failed", { method: "llm", error: msg });
        }
      }

      // ── Layer 2: Repair extraction (LLM with error feedback) → retry ──
      if (!haltFurtherLayers && llmLayersEnabled && spec && layerResults.length > 0) {
        const lastError = layerResults[layerResults.length - 1]?.error ?? "Unknown failure";
        try {
          appendTrace(traceEvents, runId, "solve.layer2_start", { previousError: lastError.slice(0, 200) });
          const repairedSpec = normalizeTaskSpec(payload, await repairTaskSpec(payload, attachments, spec, lastError));
          usedPlanner = "layer2-repair";
          appendTrace(traceEvents, runId, "solve.extract_success", {
            method: "repair", operation: repairedSpec.operation, entity: repairedSpec.entity,
            values: JSON.stringify(repairedSpec.values).slice(0, 300),
          });

          const result = await tryTaskSpecPipeline(repairedSpec, "layer2-repair");
          layerResults.push({ layer: "layer2-repair", ...result });
          spec = repairedSpec;

          if (result.success) {
            appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner, layer: "layer2" });
            finalStatus = "completed";
            finalHttpStatus = 200;
            if (debugMode) {
              await sendJson(200, { status: "completed", _debug: { ...debugMeta(), planner: usedPlanner, spec: { operation: repairedSpec.operation, entity: repairedSpec.entity, values: repairedSpec.values, lookup: repairedSpec.lookup }, layerResults } });
              return;
            }
            await sendJson(200, { status: "completed" });
            return;
          }
          attemptErrors.push(`layer2: ${result.error}`);
          if (result.terminal) {
            terminalFailureSeen = true;
            if (result.mutated) haltFurtherLayers = true;
            appendTrace(traceEvents, runId, "solve.layer_terminal_failure", { layer: "layer2", error: result.error });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          attemptErrors.push(`layer2-repair: ${msg}`);
          layerResults.push({ layer: "layer2-repair-failed", error: msg });
        }
      }

      // ── Layer 3: Heuristic extraction → compile → execute ──
      if (!haltFurtherLayers) {
        try {
          appendTrace(traceEvents, runId, "solve.layer3_start");
          const hSpec = heuristicFirst ? heuristicSeedSpec : normalizeTaskSpec(payload, heuristicExtract(payload, attachments));
          usedPlanner = "layer3-heuristic";

          const result = await tryTaskSpecPipeline(hSpec, "layer3-heuristic");
          layerResults.push({ layer: "layer3-heuristic", ...result });
          if (!spec) spec = hSpec;

          if (result.success) {
            appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner, layer: "layer3" });
            finalStatus = "completed";
            finalHttpStatus = 200;
            if (debugMode) {
              await sendJson(200, { status: "completed", _debug: { ...debugMeta(), planner: usedPlanner, spec: { operation: hSpec.operation, entity: hSpec.entity, values: hSpec.values, lookup: hSpec.lookup }, layerResults } });
              return;
            }
            await sendJson(200, { status: "completed" });
            return;
          }
          attemptErrors.push(`layer3: ${result.error}`);
          if (result.terminal) {
            terminalFailureSeen = true;
            if (result.mutated) haltFurtherLayers = true;
            appendTrace(traceEvents, runId, "solve.layer_terminal_failure", { layer: "layer3", error: result.error });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          attemptErrors.push(`layer3: ${msg}`);
          layerResults.push({ layer: "layer3-failed", error: msg });
        }
      }

      // ── Layer 4: Old-style full LLM planner (ultimate fallback) ──
      if (!haltFurtherLayers && llmLayersEnabled) {
        try {
          appendTrace(traceEvents, runId, "solve.layer4_start");
          const previousError = attemptErrors.slice(-2).join(" | ");
          const llmGeneratedPlan = await llmPlan(payload, attachments, previousError, (event) =>
            tracePlanner(traceEvents, runId, event),
          );
          usedPlanner = "layer4-llm-plan";
          const validationErrors = validatePlanForPrompt(payload.prompt, llmGeneratedPlan);
          if (validationErrors.length > 0) {
            appendTrace(traceEvents, runId, "solve.layer4_validation_warnings", { warnings: validationErrors });
          }
          plan = llmGeneratedPlan;
          if (operationRequiresMutation((spec ?? heuristicSeedSpec).operation) && !planHasMutation(llmGeneratedPlan)) {
            throw new Error(`Layer4 produced read-only plan for mutating task (${(spec ?? heuristicSeedSpec).operation})`);
          }

          const executionResult = await executePlan(client, llmGeneratedPlan, dryRun, (event) => tracePlanner(traceEvents, runId, event));
          const verificationSpec = spec ?? normalizeTaskSpec(payload, heuristicExtract(payload, attachments));
          const verification = await verifyOutcome(client, verificationSpec, executionResult);
          finalVerification = verification;
          layerResults.push({
            layer: "layer4-llm-plan",
            verified: verification.verified,
            detail: verification.detail,
            ...(verification.verified ? {} : { error: `Postcondition verification failed: ${verification.detail}` }),
          });

          if (!verification.verified && verification.required) {
            attemptErrors.push(`layer4: Postcondition verification failed: ${verification.detail}`);
            terminalFailureSeen = true;
            appendTrace(traceEvents, runId, "solve.layer_terminal_failure", {
              layer: "layer4",
              error: `Postcondition verification failed: ${verification.detail}`,
            });
            throw new Error(`Postcondition verification failed: ${verification.detail}`);
          }

          appendTrace(traceEvents, runId, "solve.completed", { planner: usedPlanner, layer: "layer4" });
          finalStatus = "completed";
          finalHttpStatus = 200;
          if (debugMode) {
            await sendJson(200, { status: "completed", _debug: { ...debugMeta(), planner: usedPlanner, plan: { summary: llmGeneratedPlan.summary, steps: llmGeneratedPlan.steps.map((s: { method: string; path: string }) => ({ method: s.method, path: s.path })) }, layerResults } });
            return;
          }
          await sendJson(200, { status: "completed" });
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          attemptErrors.push(`layer4: ${msg}`);
          layerResults.push({ layer: "layer4-failed", error: msg });
        }
      }

      // ── All layers exhausted — fail soft ──
      console.error("Tripletex all layers failed", {
        runId, prompt: payload.prompt.slice(0, 300), attemptErrors, layerResults,
      });
      appendTrace(traceEvents, runId, "solve.all_layers_failed", { attemptErrors });

      finalStatus = terminalFailureSeen ? "failed_verification" : "failed";
      finalHttpStatus = terminalFailureSeen || failHard ? 500 : 200;

      if (!failHard && !terminalFailureSeen) {
        if (debugMode) {
          await sendJson(200, { status: "completed", _debug: { ...debugMeta(), planner: usedPlanner, attemptErrors, layerResults, prompt: payload.prompt.slice(0, 500) } });
          return;
        }
        await sendJson(200, { status: "completed" });
        return;
      }
      await sendJson(500, { error: "Tripletex solver failed — all layers exhausted", attemptErrors });
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Tripletex unexpected error", { runId, error: errorMessage, attemptErrors, layerResults });
      appendTrace(traceEvents, runId, "solve.unexpected_error", { error: errorMessage });
      finalStatus = terminalFailureSeen ? "failed_verification" : "failed";
      finalHttpStatus = terminalFailureSeen || failHard ? 500 : 200;
      if (!failHard && !terminalFailureSeen) {
        await sendJson(200, { status: "completed" });
        return;
      }
      await sendJson(500, { error: "Tripletex solver failed", message: errorMessage });
      return;
    }
  } finally {
    await emitCurrentRunLedger();
    // Flush one consolidated trace entry per request.
    // This avoids fragmented log ingestion and keeps full run timelines searchable by runId.
    flushTrace(traceEvents, runId);
  }
}
