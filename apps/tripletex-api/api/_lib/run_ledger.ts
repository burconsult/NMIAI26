import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RunLayerResult = {
  layer: string;
  error?: string;
  verified?: boolean;
  detail?: string;
  terminal?: boolean;
};

export type RunVerification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

export type RunLedgerRecord = {
  runId: string;
  promptFingerprint?: string;
  debugMode?: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status:
    | "completed"
    | "failed"
    | "failed_verification"
    | "invalid_payload"
    | "unauthorized"
    | "method_not_allowed";
  httpStatus: number;
  planner: string;
  promptText?: string;
  promptPreview?: string;
  promptLength?: number;
  fileCount?: number;
  baseUrlHost?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    sizeBytes: number;
    extractionSource?: string;
    textExcerpt?: string;
  }>;
  attachmentProviders?: string[];
  capabilities?: {
    modules?: Record<string, boolean | null>;
    dimensions?: {
      freeDimensionSlotsUsed?: number | null;
      freeDimensionSlotsAvailable?: number | null;
    };
    bank?: Record<string, boolean | null>;
    assets?: Record<string, boolean | null>;
    probeErrors?: string[];
  };
  spec?: {
    operation: string;
    entity: string;
    values?: Record<string, unknown>;
    lookup?: Record<string, unknown>;
  };
  plan?: {
    summary: string;
    stepCount: number;
    steps: string[];
  };
  verification?: RunVerification;
  layerResults?: RunLayerResult[];
  attemptErrors?: string[];
  traceSummary?: {
    eventCount: number;
    tripletexRequests: number;
    tripletexResponses: number;
    tripletexErrors: number;
    mutatingRequests: number;
  };
};

type TraceLike = {
  event: string;
  method?: string;
}[];

export function summarizeTrace(traceEvents: TraceLike): RunLedgerRecord["traceSummary"] {
  let tripletexRequests = 0;
  let tripletexResponses = 0;
  let tripletexErrors = 0;
  let mutatingRequests = 0;

  for (const event of traceEvents) {
    if (event.event === "tripletex.request") {
      tripletexRequests += 1;
      if (event.method && event.method !== "GET") mutatingRequests += 1;
      continue;
    }
    if (event.event === "tripletex.response") {
      tripletexResponses += 1;
      continue;
    }
    if (event.event === "tripletex.network_error") {
      tripletexErrors += 1;
      continue;
    }
  }

  return {
    eventCount: traceEvents.length,
    tripletexRequests,
    tripletexResponses,
    tripletexErrors,
    mutatingRequests,
  };
}

export async function emitRunLedger(record: RunLedgerRecord): Promise<void> {
  const serialized = JSON.stringify(record);
  console.log(`tripletex_run_record ${serialized}`);

  const path = process.env.TRIPLETEX_RUN_LEDGER_PATH?.trim();
  if (!path) return;

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${serialized}\n`, "utf8");
  } catch (error) {
    console.warn("Tripletex run ledger append failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
      runId: record.runId,
    });
  }
}
