import type { VercelRequest, VercelResponse } from "@vercel/node";

import { summarizeAttachments } from "./_lib/attachments.js";
import { executePlan, heuristicPlan, llmPlan, SolveError } from "./_lib/planner.js";
import { solveRequestSchema } from "./_lib/schemas.js";
import { TripletexClient, TripletexError } from "./_lib/tripletex.js";

export const config = {
  maxDuration: 300,
};

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

  const parsed = solveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
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
          previousError = String(error);
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
        details: debug ? error.message : undefined,
      });
      return;
    }
    res.status(500).json({
      error: "Unexpected error",
      planner: usedPlanner,
      details: debug ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
}
