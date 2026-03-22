import { generateText } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

import type { SolveRequest } from "./schemas.js";

export type AttachmentSummary = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExcerpt: string;
  extractionSource: "text" | "docai" | "ai" | "metadata";
};

export type AttachmentTraceEvent = {
  event:
    | "attachments_start"
    | "attachment_text_extracted"
    | "attachment_docai_attempt"
    | "attachment_docai_success"
    | "attachment_docai_failed"
    | "attachment_ai_attempt"
    | "attachment_ai_success"
    | "attachment_ai_failed"
    | "attachment_metadata_fallback";
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  reason?: string;
  extractionSource?: AttachmentSummary["extractionSource"];
  durationMs?: number;
  message?: string;
};

type AttachmentTrace = (event: AttachmentTraceEvent) => void;

type DocAiConfig = {
  projectId: string;
  location: string;
  processorId: string;
  processorVersion?: string;
  maxFiles: number;
  maxBytesPerFile: number;
  timeoutMs: number;
  credentials?: {
    client_email: string;
    private_key: string;
  };
};

type AttachmentAiConfig = {
  model: string;
  maxFiles: number;
  maxBytesPerFile: number;
  timeoutMs: number;
  maxOutputTokens: number;
};

const DOC_AI_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/tiff",
]);

function safeDecodeBase64(value: string): Buffer {
  try {
    return Buffer.from(value, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function toText(buf: Buffer, maxChars: number): string {
  const utf8 = buf.toString("utf8").replace(/\r\n?/g, "\n");
  const normalized = utf8
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return normalized.slice(0, maxChars);
}

function parseDocAiCredentials(): {
  client_email: string;
  private_key: string;
  project_id?: string;
} | null {
  const raw =
    process.env.DOC_AI_CREDENTIALS_JSON?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    const projectId = parsed.project_id;
    if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
      return null;
    }
    return {
      client_email: clientEmail,
      private_key: privateKey,
      project_id: typeof projectId === "string" ? projectId : undefined,
    };
  } catch {
    return null;
  }
}

function getDocAiConfig(): DocAiConfig | null {
  const parsedCredentials = parseDocAiCredentials();
  const projectId = process.env.DOC_AI_PROJECT_ID?.trim() || parsedCredentials?.project_id;
  const location = process.env.DOC_AI_LOCATION?.trim();
  const processorId = process.env.DOC_AI_PROCESSOR_ID?.trim();
  if (!projectId || !location || !processorId) return null;
  const timeoutRaw = Number(process.env.DOC_AI_TIMEOUT_MS || "12000");
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.min(60000, Math.max(2000, Math.round(timeoutRaw)))
    : 12000;
  return {
    projectId,
    location,
    processorId,
    processorVersion: process.env.DOC_AI_PROCESSOR_VERSION?.trim() || undefined,
    maxFiles: Math.max(1, Number(process.env.DOC_AI_MAX_FILES || "3")),
    maxBytesPerFile: Math.max(1024, Number(process.env.DOC_AI_MAX_BYTES_PER_FILE || `${10 * 1024 * 1024}`)),
    timeoutMs,
    credentials: parsedCredentials
      ? {
          client_email: parsedCredentials.client_email,
          private_key: parsedCredentials.private_key,
        }
      : undefined,
  };
}

function getAttachmentAiConfig(): AttachmentAiConfig | null {
  if ((process.env.TRIPLETEX_ATTACHMENT_AI_ENABLED || "").trim() === "0") return null;
  const model = process.env.TRIPLETEX_ATTACHMENT_AI_MODEL?.trim() || "anthropic/claude-sonnet-4.6";
  const timeoutRaw = Number(process.env.TRIPLETEX_ATTACHMENT_AI_TIMEOUT_MS || "20000");
  const maxOutputTokensRaw = Number(process.env.TRIPLETEX_ATTACHMENT_AI_MAX_OUTPUT_TOKENS || "1200");
  return {
    model,
    maxFiles: Math.max(1, Number(process.env.TRIPLETEX_ATTACHMENT_AI_MAX_FILES || "3")),
    maxBytesPerFile: Math.max(1024, Number(process.env.TRIPLETEX_ATTACHMENT_AI_MAX_BYTES_PER_FILE || `${6 * 1024 * 1024}`)),
    timeoutMs: Number.isFinite(timeoutRaw) ? Math.min(60000, Math.max(3000, Math.round(timeoutRaw))) : 20000,
    maxOutputTokens: Number.isFinite(maxOutputTokensRaw)
      ? Math.min(4000, Math.max(200, Math.round(maxOutputTokensRaw)))
      : 1200,
  };
}

function buildProcessorName(client: DocumentProcessorServiceClient, config: DocAiConfig): string {
  const base = client.processorPath(config.projectId, config.location, config.processorId);
  if (!config.processorVersion) return base;
  return `${base}/processorVersions/${config.processorVersion}`;
}

function normalizeStructuredText(value: string, maxChars: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars)
    .trim();
}

function buildAttachmentAiInstruction(taskPrompt?: string): string {
  const promptHint = typeof taskPrompt === "string" && taskPrompt.trim()
    ? `Task prompt: ${taskPrompt.trim()}\n\n`
    : "";
  return (
    `${promptHint}`
    + "Extract exact accounting-relevant facts from the attached document. "
    + "Return line-oriented plain text only, with one fact per line using stable labels when possible. "
    + "Prefer labels like Employee, First name, Last name, Email, Date of birth, National identity number, Start date, Department, Occupation code, Employment percentage, Annual salary, Monthly salary, Bank account number, User access, Supplier, Customer, Organization number, Invoice number, Due date, Amount, VAT rate, Account number, Product, Line item. "
    + "Preserve exact values and identifiers. Do not paraphrase away numbers. Keep each line short. If the document contains item rows, emit one 'Line item:' line per row. If you are unsure, include the raw text fragment as a labeled line instead of omitting it."
  );
}

async function extractWithDocumentAi(
  client: DocumentProcessorServiceClient,
  name: string,
  mimeType: string,
  content: Buffer,
  maxChars: number,
): Promise<string> {
  const [result] = await client.processDocument({
    name,
    rawDocument: {
      content: content.toString("base64"),
      mimeType,
    },
  });

  const text = normalizeStructuredText(result.document?.text || "", maxChars);
  const entityHints = (result.document?.entities ?? [])
    .slice(0, 20)
    .map((entity) => {
      const type = entity.type || "field";
      const mention = normalizeStructuredText(entity.mentionText || "", 240);
      if (!mention) return null;
      return `${type}: ${mention}`;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (text && entityHints) return normalizeStructuredText(`${text}\n${entityHints}`, maxChars);
  if (text) return text;
  return entityHints;
}

async function extractWithAiGateway(
  model: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  maxChars: number,
  taskPrompt?: string,
): Promise<string> {
  const instruction = buildAttachmentAiInstruction(taskPrompt);
  const filePart = mimeType.startsWith("image/")
    ? {
        type: "image" as const,
        image: content,
        mediaType: mimeType,
      }
    : {
        type: "file" as const,
        data: content,
        mediaType: mimeType,
        filename,
      };

  const { text } = await generateText({
    model: gateway(model),
    maxOutputTokens: Number(process.env.TRIPLETEX_ATTACHMENT_AI_MAX_OUTPUT_TOKENS || "1200"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: instruction },
          filePart,
        ],
      },
    ],
  });

  return normalizeStructuredText(text, maxChars);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function summarizeAttachments(
  files: SolveRequest["files"],
  maxChars = 2400,
  trace?: AttachmentTrace,
  taskPrompt?: string,
): Promise<AttachmentSummary[]> {
  const config = getDocAiConfig();
  const aiConfig = getAttachmentAiConfig();
  let canUseDocAi = config !== null;
  const canUseAttachmentAi = aiConfig !== null;
  trace?.({
    event: "attachments_start",
    reason: canUseDocAi
      ? "docai_configured"
      : canUseAttachmentAi
        ? "docai_not_configured_ai_available"
        : "no_attachment_ai_configured",
  });
  let docAiClient: DocumentProcessorServiceClient | null = null;
  let processorName: string | null = null;
  if (canUseDocAi && config) {
    try {
      docAiClient = new DocumentProcessorServiceClient({
        apiEndpoint: `${config.location}-documentai.googleapis.com`,
        projectId: config.projectId,
        credentials: config.credentials,
      });
      processorName = buildProcessorName(docAiClient, config);
    } catch (error) {
      canUseDocAi = false;
      trace?.({
        event: "attachments_start",
        reason: `docai_init_failed:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const summaries: AttachmentSummary[] = [];
  let docAiUsed = 0;
  let attachmentAiUsed = 0;

  for (const file of files) {
    try {
      const raw = safeDecodeBase64(file.content_base64);
      const mime = file.mime_type.toLowerCase();
      const textLike =
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime === "text/csv" ||
        mime === "application/xml";

      if (textLike) {
        summaries.push({
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: raw.byteLength,
          textExcerpt: toText(raw, maxChars),
          extractionSource: "text",
        });
        trace?.({
          event: "attachment_text_extracted",
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: raw.byteLength,
          extractionSource: "text",
        });
        continue;
      }

      const shouldUseDocAi =
        canUseDocAi &&
        docAiClient &&
        processorName &&
        config &&
        DOC_AI_MIME_TYPES.has(mime) &&
        raw.byteLength <= config.maxBytesPerFile &&
        docAiUsed < config.maxFiles;

      if (shouldUseDocAi && config && docAiClient && processorName) {
        const startedAt = Date.now();
        trace?.({
          event: "attachment_docai_attempt",
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: raw.byteLength,
        });
        try {
          const extracted = await withTimeout(
            extractWithDocumentAi(docAiClient, processorName, mime, raw, maxChars),
            config.timeoutMs,
            `Document AI timeout after ${config.timeoutMs}ms`,
          );
          docAiUsed += 1;
          summaries.push({
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            textExcerpt: extracted.slice(0, maxChars),
            extractionSource: "docai",
          });
          trace?.({
            event: "attachment_docai_success",
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            extractionSource: "docai",
            durationMs: Date.now() - startedAt,
          });
          continue;
        } catch (error) {
          trace?.({
            event: "attachment_docai_failed",
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
          });
          // Non-fatal: continue with metadata-only fallback.
        }
      }

      const shouldUseAttachmentAi =
        canUseAttachmentAi &&
        aiConfig &&
        DOC_AI_MIME_TYPES.has(mime) &&
        raw.byteLength <= aiConfig.maxBytesPerFile &&
        attachmentAiUsed < aiConfig.maxFiles;

      if (shouldUseAttachmentAi && aiConfig) {
        const startedAt = Date.now();
        trace?.({
          event: "attachment_ai_attempt",
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: raw.byteLength,
        });
        try {
          const extracted = await withTimeout(
            extractWithAiGateway(aiConfig.model, file.filename, mime, raw, maxChars, taskPrompt),
            aiConfig.timeoutMs,
            `Attachment AI timeout after ${aiConfig.timeoutMs}ms`,
          );
          attachmentAiUsed += 1;
          summaries.push({
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            textExcerpt: extracted.slice(0, maxChars),
            extractionSource: "ai",
          });
          trace?.({
            event: "attachment_ai_success",
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            extractionSource: "ai",
            durationMs: Date.now() - startedAt,
          });
          continue;
        } catch (error) {
          trace?.({
            event: "attachment_ai_failed",
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: raw.byteLength,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const fallbackReason = !canUseDocAi
        ? canUseAttachmentAi
          ? "docai_unavailable"
          : "docai_not_configured"
        : !DOC_AI_MIME_TYPES.has(mime)
          ? "mime_not_supported_by_docai"
          : config && raw.byteLength > config.maxBytesPerFile
            ? "file_too_large_for_docai"
          : config && docAiUsed >= config.maxFiles
              ? "docai_file_quota_reached"
              : shouldUseAttachmentAi
                ? "attachment_ai_failed"
                : "docai_failed";

      summaries.push({
        filename: file.filename,
        mimeType: file.mime_type,
        sizeBytes: raw.byteLength,
        textExcerpt: "",
        extractionSource: "metadata",
      });
      trace?.({
        event: "attachment_metadata_fallback",
        filename: file.filename,
        mimeType: file.mime_type,
        sizeBytes: raw.byteLength,
        extractionSource: "metadata",
        reason: fallbackReason,
      });
    } catch (error) {
      summaries.push({
        filename: file.filename,
        mimeType: file.mime_type,
        sizeBytes: 0,
        textExcerpt: "",
        extractionSource: "metadata",
      });
      trace?.({
        event: "attachment_metadata_fallback",
        filename: file.filename,
        mimeType: file.mime_type,
        sizeBytes: 0,
        extractionSource: "metadata",
        reason: `attachment_processing_failed:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return summaries;
}
