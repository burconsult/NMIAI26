import { z } from "zod";

const MAX_FILES = Math.max(1, Number(process.env.TRIPLETEX_MAX_FILES || "8"));
const MAX_FILE_BYTES = Math.max(1024, Number(process.env.TRIPLETEX_MAX_FILE_BYTES || `${15 * 1024 * 1024}`));
const MAX_BASE64_CHARS = Math.ceil((MAX_FILE_BYTES * 4) / 3);

function isAllowedTripletexBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host.endsWith(".tripletex.dev") || host === "tx-proxy.ainm.no";
  } catch {
    return false;
  }
}

export const solveFileSchema = z.object({
  filename: z.string().min(1),
  content_base64: z.string().min(1).max(MAX_BASE64_CHARS),
  mime_type: z.string().min(1).default("application/octet-stream"),
});

export const solveRequestSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(solveFileSchema).max(MAX_FILES).default([]),
  tripletex_credentials: z.object({
    base_url: z.string().url().refine(isAllowedTripletexBaseUrl, {
      message: "base_url host is not allowed",
    }),
    session_token: z.string().min(1),
  }),
});

export const planStepSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string().min(1),
  params: z.record(z.string(), z.any()).optional(),
  body: z.any().optional(),
  saveAs: z.string().optional(),
  extract: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
});

export const executionPlanSchema = z.object({
  summary: z.string().default(""),
  steps: z.array(planStepSchema).min(1).max(18),
});

export type SolveRequest = z.infer<typeof solveRequestSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
