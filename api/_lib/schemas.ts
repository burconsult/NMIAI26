import { z } from "zod";

export const solveFileSchema = z.object({
  filename: z.string().min(1),
  content_base64: z.string().min(1),
  mime_type: z.string().min(1).default("application/octet-stream"),
});

export const solveRequestSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(solveFileSchema).default([]),
  tripletex_credentials: z.object({
    base_url: z.string().url(),
    session_token: z.string().min(1),
  }),
});

export const planStepSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string().min(1),
  params: z.record(z.any()).optional(),
  body: z.any().optional(),
  saveAs: z.string().optional(),
  extract: z.record(z.string()).optional(),
  reason: z.string().optional(),
});

export const executionPlanSchema = z.object({
  summary: z.string().default(""),
  steps: z.array(planStepSchema).min(1).max(18),
});

export type SolveRequest = z.infer<typeof solveRequestSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

