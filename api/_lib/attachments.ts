import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

import type { SolveRequest } from "./schemas.js";

export type AttachmentSummary = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExcerpt: string;
  extractionSource: "text" | "docai" | "metadata";
};

type DocAiConfig = {
  projectId: string;
  location: string;
  processorId: string;
  processorVersion?: string;
  maxFiles: number;
  maxBytesPerFile: number;
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
  const utf8 = buf.toString("utf8");
  const normalized = utf8.replace(/\s+/g, " ").trim();
  return normalized.slice(0, maxChars);
}

function getDocAiConfig(): DocAiConfig | null {
  const projectId = process.env.DOC_AI_PROJECT_ID?.trim();
  const location = process.env.DOC_AI_LOCATION?.trim();
  const processorId = process.env.DOC_AI_PROCESSOR_ID?.trim();
  if (!projectId || !location || !processorId) return null;
  return {
    projectId,
    location,
    processorId,
    processorVersion: process.env.DOC_AI_PROCESSOR_VERSION?.trim() || undefined,
    maxFiles: Math.max(1, Number(process.env.DOC_AI_MAX_FILES || "3")),
    maxBytesPerFile: Math.max(1024, Number(process.env.DOC_AI_MAX_BYTES_PER_FILE || `${10 * 1024 * 1024}`)),
  };
}

function buildProcessorName(client: DocumentProcessorServiceClient, config: DocAiConfig): string {
  const base = client.processorPath(config.projectId, config.location, config.processorId);
  if (!config.processorVersion) return base;
  return `${base}/processorVersions/${config.processorVersion}`;
}

async function extractWithDocumentAi(
  client: DocumentProcessorServiceClient,
  name: string,
  mimeType: string,
  content: Buffer,
): Promise<string> {
  const [result] = await client.processDocument({
    name,
    rawDocument: {
      content: content.toString("base64"),
      mimeType,
    },
  });

  const text = result.document?.text?.replace(/\s+/g, " ").trim() || "";
  const entityHints =
    result.document?.entities
      ?.slice(0, 12)
      .map((entity) => {
        const type = entity.type || "field";
        const mention = (entity.mentionText || "").replace(/\s+/g, " ").trim();
        if (!mention) return null;
        return `${type}: ${mention}`;
      })
      .filter((value): value is string => Boolean(value))
      .join(" | ") || "";

  if (text && entityHints) return `${text}\n\nDocument fields: ${entityHints}`;
  if (text) return text;
  return entityHints;
}

export async function summarizeAttachments(
  files: SolveRequest["files"],
  maxChars = 2400,
): Promise<AttachmentSummary[]> {
  const config = getDocAiConfig();
  const canUseDocAi = config !== null;
  const docAiClient = canUseDocAi
    ? new DocumentProcessorServiceClient({
        apiEndpoint: `${config.location}-documentai.googleapis.com`,
      })
    : null;
  const processorName = canUseDocAi && docAiClient ? buildProcessorName(docAiClient, config) : null;

  const summaries: AttachmentSummary[] = [];
  let docAiUsed = 0;

  for (const file of files) {
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
      continue;
    }

    const shouldUseDocAi =
      canUseDocAi &&
      docAiClient &&
      processorName &&
      DOC_AI_MIME_TYPES.has(mime) &&
      raw.byteLength <= config.maxBytesPerFile &&
      docAiUsed < config.maxFiles;

    if (shouldUseDocAi) {
      try {
        const extracted = await extractWithDocumentAi(docAiClient, processorName, mime, raw);
        docAiUsed += 1;
        summaries.push({
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: raw.byteLength,
          textExcerpt: extracted.slice(0, maxChars),
          extractionSource: "docai",
        });
        continue;
      } catch {
        // Non-fatal: continue with metadata-only fallback.
      }
    }

    summaries.push({
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: raw.byteLength,
      textExcerpt: "",
      extractionSource: "metadata",
    });
  }

  return summaries;
}

