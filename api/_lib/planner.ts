import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";

import type { AttachmentSummary } from "./attachments.js";
import type { ExecutionPlan, PlanStep, SolveRequest } from "./schemas.js";
import { executionPlanSchema } from "./schemas.js";
import { dig, primaryValue, TripletexClient } from "./tripletex.js";

export class SolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolveError";
  }
}

const varPattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*}}/g;

function resolveVar(vars: Record<string, unknown>, expr: string): unknown {
  const normalized = expr.startsWith("vars.") ? expr.slice(5) : expr;
  if (!normalized.includes(".")) return vars[normalized];
  const [root, ...rest] = normalized.split(".");
  const base = vars[root];
  if (!rest.length) return base;
  return dig(base, rest.join("."));
}

function interpolateValue(input: unknown, vars: Record<string, unknown>): unknown {
  if (Array.isArray(input)) return input.map((item) => interpolateValue(item, vars));
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, interpolateValue(v, vars)]),
    );
  }
  if (typeof input !== "string") return input;

  const matches = [...input.matchAll(varPattern)];
  if (!matches.length) return input;

  if (matches.length === 1 && matches[0]?.[0] === input) {
    const only = matches[0]?.[1] ?? "";
    const resolved = resolveVar(vars, only);
    if (resolved === undefined) throw new SolveError(`Template variable '${only}' not found`);
    return resolved;
  }

  let rendered = input;
  for (const match of matches) {
    const expr = match[1] ?? "";
    const resolved = resolveVar(vars, expr);
    if (resolved === undefined) throw new SolveError(`Template variable '${expr}' not found`);
    rendered = rendered.replace(match[0], typeof resolved === "string" ? resolved : JSON.stringify(resolved));
  }
  return rendered;
}

function extractEmail(prompt: string): string | null {
  const match = prompt.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return match?.[0] ?? null;
}

function extractQuoted(prompt: string): string | null {
  const match = prompt.match(/[\"'“”](.{2,120}?)[\"'“”]/);
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? null;
}

function extractCapitalizedName(prompt: string): string | null {
  const matches = prompt.match(/\b([A-ZÆØÅ][A-Za-zÆØÅæøå'-]+(?:\s+[A-ZÆØÅ][A-Za-zÆØÅæøå'-]+)+)\b/g);
  return matches?.[0] ?? null;
}

function splitPersonName(name: string | null): { firstName: string; lastName: string } {
  if (!name) {
    const suffix = Date.now().toString().slice(-6);
    return { firstName: "Generated", lastName: `User${suffix}` };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0] ?? "Generated", lastName: "Generated" };
  return {
    firstName: parts[0] ?? "Generated",
    lastName: parts.slice(1).join(" "),
  };
}

function isCreateIntent(lower: string): boolean {
  return [
    "create",
    "opprett",
    "registrer",
    "register",
    "lag ",
    "criar",
    "crear",
    "erstell",
    "ajouter",
  ].some((token) => lower.includes(token));
}

function isDeleteIntent(lower: string): boolean {
  return [
    "delete",
    "slett",
    "fjern",
    "remove",
    "eliminar",
    "excluir",
    "supprimer",
    "lösch",
  ].some((token) => lower.includes(token));
}

export function heuristicPlan(payload: SolveRequest): ExecutionPlan {
  const prompt = payload.prompt;
  const lower = prompt.toLowerCase();
  const email = extractEmail(prompt);
  const quoted = extractQuoted(prompt);
  const capitalized = extractCapitalizedName(prompt);

  if ((lower.includes("customer") || lower.includes("kunde") || lower.includes("cliente")) && isCreateIntent(lower)) {
    const customerName = quoted ?? capitalized ?? `Generated Customer ${Date.now().toString().slice(-6)}`;
    return {
      summary: "Heuristic customer create flow",
      steps: [
        {
          method: "POST",
          path: "/customer",
          body: {
            name: customerName,
            email: email ?? undefined,
            isCustomer: true,
          },
          saveAs: "customer",
          reason: "Create customer from prompt fields",
        },
      ],
    };
  }

  if ((lower.includes("employee") || lower.includes("ansatt")) && isCreateIntent(lower)) {
    const person = splitPersonName(quoted ?? capitalized);
    return {
      summary: "Heuristic employee create flow",
      steps: [
        {
          method: "POST",
          path: "/employee",
          body: {
            firstName: person.firstName,
            lastName: person.lastName,
            email: email ?? undefined,
          },
          saveAs: "employee",
          reason: "Create employee from prompt fields",
        },
      ],
    };
  }

  if ((lower.includes("department") || lower.includes("avdeling")) && isCreateIntent(lower)) {
    return {
      summary: "Heuristic department create flow",
      steps: [
        {
          method: "POST",
          path: "/department",
          body: { name: quoted ?? "Ny avdeling" },
          saveAs: "department",
        },
      ],
    };
  }

  if ((lower.includes("travel expense") || lower.includes("reise")) && isDeleteIntent(lower)) {
    const idMatch = lower.match(/\b(\d{1,9})\b/);
    if (idMatch?.[1]) {
      return {
        summary: "Heuristic travel expense delete flow",
        steps: [{ method: "DELETE", path: `/travelExpense/${idMatch[1]}` }],
      };
    }
  }

  throw new SolveError("No heuristic plan found; configure AI Gateway to enable LLM planning.");
}

function selectPlanningModel(prompt: string, summaries: AttachmentSummary[]): string {
  const lower = prompt.toLowerCase();
  const hasDocAttachment = summaries.some(
    (item) =>
      item.mimeType.toLowerCase() === "application/pdf" ||
      item.mimeType.toLowerCase().startsWith("image/"),
  );
  const complexAccountingTask = [
    "reconcile",
    "reconciliation",
    "ledger",
    "voucher",
    "year-end",
    "bank statement",
    "årsoppgjør",
    "hovedbok",
    "avstemming",
  ].some((token) => lower.includes(token));

  if (hasDocAttachment && complexAccountingTask) {
    return process.env.TRIPLETEX_MODEL_DOC_COMPLEX?.trim() || "google/gemini-2.5-pro";
  }
  if (hasDocAttachment) {
    return process.env.TRIPLETEX_MODEL_DOC_FAST?.trim() || "google/gemini-2.5-flash";
  }
  if (complexAccountingTask) {
    return process.env.TRIPLETEX_MODEL_REASONING?.trim() || "anthropic/claude-sonnet-4.5";
  }
  return process.env.TRIPLETEX_MODEL_DEFAULT?.trim() || "openai/gpt-4.1-mini";
}

function buildPlanningPrompt(payload: SolveRequest, summaries: AttachmentSummary[], previousError?: string): string {
  const attachmentsText = summaries.length
    ? summaries
        .map((file) => {
          const excerpt = file.textExcerpt ? `; excerpt=${file.textExcerpt}` : "";
          return `- ${file.filename} (${file.mimeType}, ${file.sizeBytes} bytes; source=${file.extractionSource}${excerpt})`;
        })
        .join("\n")
    : "- none";

  return [
    "You are a Tripletex API planner. Return only an execution plan object.",
    "Use minimal, deterministic API calls.",
    "For created entities, set saveAs and use templating in later steps with {{alias_id}} or {{alias.field}}.",
    "Do not include auth details in the plan.",
    "",
    `Task prompt:\n${payload.prompt}`,
    "",
    `Attachments:\n${attachmentsText}`,
    "",
    `Previous execution error: ${previousError ?? "none"}`,
  ].join("\n");
}

export async function llmPlan(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
  previousError?: string,
): Promise<ExecutionPlan> {
  const modelName = selectPlanningModel(payload.prompt, summaries);
  const { object } = await generateObject({
    model: gateway(modelName),
    schema: executionPlanSchema,
    temperature: 0,
    prompt: buildPlanningPrompt(payload, summaries, previousError),
  });
  return object;
}

export async function executePlan(client: TripletexClient, plan: ExecutionPlan, dryRun: boolean): Promise<number> {
  const vars: Record<string, unknown> = {};
  let count = 0;

  for (const rawStep of plan.steps) {
    const step = rawStep as PlanStep;
    count += 1;
    const path = interpolateValue(step.path, vars);
    const params = interpolateValue(step.params ?? {}, vars);
    const body = interpolateValue(step.body, vars);
    if (typeof path !== "string") throw new SolveError("Resolved path must be a string.");

    let response: unknown;
    if (dryRun && step.method !== "GET") {
      response = { value: { id: count, dryRun: true } };
    } else {
      response = await client.request(step.method, path, {
        params: (params ?? {}) as Record<string, unknown>,
        body,
      });
    }

    const primary = primaryValue(response);
    if (step.saveAs) {
      vars[step.saveAs] = primary;
      if (primary && typeof primary === "object" && (primary as Record<string, unknown>).id !== undefined) {
        vars[`${step.saveAs}_id`] = (primary as Record<string, unknown>).id;
      }
    }
    for (const [name, sourcePath] of Object.entries(step.extract ?? {}) as Array<[string, string]>) {
      const extracted = dig(response, sourcePath);
      if (extracted !== undefined) vars[name] = extracted;
    }
  }

  return count;
}
