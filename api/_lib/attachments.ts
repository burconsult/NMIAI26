import type { SolveRequest } from "./schemas";

type AttachmentSummary = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textExcerpt: string;
};

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

export function summarizeAttachments(
  files: SolveRequest["files"],
  maxChars = 1600,
): AttachmentSummary[] {
  return files.map((file: SolveRequest["files"][number]) => {
    const raw = safeDecodeBase64(file.content_base64);
    const mime = file.mime_type.toLowerCase();
    const textLike =
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "text/csv" ||
      mime === "application/xml";

    return {
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: raw.byteLength,
      textExcerpt: textLike ? toText(raw, maxChars) : "",
    };
  });
}
