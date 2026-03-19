import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";

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

function isReadIntent(lower: string): boolean {
  return [
    "list",
    "show",
    "find",
    "fetch",
    "get ",
    "do not modify",
    "without modifying",
    "read-only",
    "read only",
    "no changes",
    "no update",
    "hent",
    "vis",
    "finn",
    "les ",
    "liste",
    "ikke endre",
    "uten å endre",
    "kun les",
  ].some((token) => lower.includes(token));
}

export function heuristicPlan(payload: SolveRequest): ExecutionPlan {
  const prompt = payload.prompt;
  const lower = prompt.toLowerCase();
  const email = extractEmail(prompt);
  const quoted = extractQuoted(prompt);
  const capitalized = extractCapitalizedName(prompt);
  const createIntent = isCreateIntent(lower);
  const readIntent = isReadIntent(lower) && !createIntent;

  if (readIntent && (lower.includes("employee") || lower.includes("ansatt"))) {
    return {
      summary: "Heuristic employee list/read flow",
      steps: [
        {
          method: "GET",
          path: "/employee",
          params: { count: 1, fields: "id,firstName,lastName,email" },
          reason: "Read-only employee lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("customer") || lower.includes("kunde") || lower.includes("cliente"))) {
    return {
      summary: "Heuristic customer list/read flow",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: { count: 1, fields: "id,name,email" },
          reason: "Read-only customer lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("department") || lower.includes("avdeling"))) {
    return {
      summary: "Heuristic department list/read flow",
      steps: [
        {
          method: "GET",
          path: "/department",
          params: { count: 1, fields: "id,name" },
          reason: "Read-only department lookup",
        },
      ],
    };
  }

  if ((lower.includes("customer") || lower.includes("kunde") || lower.includes("cliente")) && createIntent) {
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

  if ((lower.includes("employee") || lower.includes("ansatt")) && createIntent) {
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

  if ((lower.includes("department") || lower.includes("avdeling")) && createIntent) {
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

  if (readIntent && (lower.includes("invoice") || lower.includes("faktura"))) {
    return {
      summary: "Heuristic invoice list/read flow",
      steps: [
        {
          method: "GET",
          path: "/invoice",
          params: { count: 1 },
          reason: "Read-only invoice lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("project") || lower.includes("prosjekt"))) {
    return {
      summary: "Heuristic project list/read flow",
      steps: [
        {
          method: "GET",
          path: "/project",
          params: { count: 1 },
          reason: "Read-only project lookup",
        },
      ],
    };
  }

  if (readIntent && lower.includes("product")) {
    return {
      summary: "Heuristic product list/read flow",
      steps: [
        {
          method: "GET",
          path: "/product",
          params: { count: 1 },
          reason: "Read-only product lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("order") || lower.includes("ordre"))) {
    return {
      summary: "Heuristic order list/read flow",
      steps: [
        {
          method: "GET",
          path: "/order",
          params: { count: 1 },
          reason: "Read-only order lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("voucher") || lower.includes("bilag"))) {
    return {
      summary: "Heuristic ledger voucher list/read flow",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: { count: 1 },
          reason: "Read-only voucher lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("ledger posting") || lower.includes("hovedbokspost") || lower.includes("posting"))) {
    return {
      summary: "Heuristic ledger posting list/read flow",
      steps: [
        {
          method: "GET",
          path: "/ledger/posting",
          params: { count: 1 },
          reason: "Read-only posting lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("ledger account") || lower.includes("kontoplan") || lower.includes("account"))) {
    return {
      summary: "Heuristic ledger account list/read flow",
      steps: [
        {
          method: "GET",
          path: "/ledger/account",
          params: { count: 1 },
          reason: "Read-only account lookup",
        },
      ],
    };
  }

  if (readIntent && (lower.includes("travel expense") || lower.includes("reise"))) {
    return {
      summary: "Heuristic travel expense list/read flow",
      steps: [
        {
          method: "GET",
          path: "/travelExpense",
          params: { count: 1 },
          reason: "Read-only travel expense lookup",
        },
      ],
    };
  }

  if (readIntent) {
    return {
      summary: "Heuristic generic read flow",
      steps: [
        {
          method: "GET",
          path: "/employee",
          params: { count: 1 },
          reason: "Fallback read-only probe",
        },
      ],
    };
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
    return process.env.TRIPLETEX_MODEL_DOC_COMPLEX?.trim() || "openai/gpt-5.2";
  }
  if (hasDocAttachment) {
    return process.env.TRIPLETEX_MODEL_DOC_FAST?.trim() || "google/gemini-2.5-flash";
  }
  if (complexAccountingTask) {
    return process.env.TRIPLETEX_MODEL_REASONING?.trim() || "anthropic/claude-sonnet-4.5";
  }
  return process.env.TRIPLETEX_MODEL_DEFAULT?.trim() || "openai/gpt-5.2";
}

function parseFallbackModels(primaryModel: string): string[] {
  const configured =
    process.env.TRIPLETEX_GATEWAY_FALLBACK_MODELS?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  const defaults = [
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-pro",
    "openai/gpt-5-nano",
  ];
  return [...configured, ...defaults].filter((model, index, all) => model !== primaryModel && all.indexOf(model) === index);
}

function shouldUseDirectOpenAiFallback(): boolean {
  return process.env.TRIPLETEX_ENABLE_DIRECT_OPENAI_FALLBACK === "1" && Boolean(process.env.OPENAI_API_KEY?.trim());
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
    "Allowed endpoints include /employee, /customer, /product, /invoice, /order, /travelExpense, /project, /department, /ledger/account, /ledger/posting, /ledger/voucher.",
    "Use only relative endpoint paths, for example /employee.",
    "For created entities, set saveAs and use templating in later steps with {{alias_id}} or {{alias.field}}.",
    "If prompt is read-only (e.g. list/show/find/get/do not modify), use GET-only steps and never mutate data.",
    "Use `count` for list endpoints to limit scope (typically count=1).",
    "List responses may be wrapped as { values: [...] } or single { value: {...} }.",
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
  const fallbackModels = parseFallbackModels(modelName);
  try {
    const { object } = await generateObject({
      model: gateway(modelName),
      schema: executionPlanSchema,
      temperature: 0,
      providerOptions: {
        gateway: {
          models: fallbackModels,
        } satisfies GatewayLanguageModelOptions,
      },
      prompt: buildPlanningPrompt(payload, summaries, previousError),
    });
    return object;
  } catch (error) {
    if (!shouldUseDirectOpenAiFallback()) {
      throw error;
    }

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    });
    const directModel = process.env.TRIPLETEX_DIRECT_OPENAI_MODEL?.trim() || "gpt-4.1-mini";
    const { object } = await generateObject({
      model: openai(directModel),
      schema: executionPlanSchema,
      temperature: 0,
      prompt: buildPlanningPrompt(payload, summaries, `Gateway failed: ${String(error)}\n${previousError || ""}`.trim()),
    });
    return object;
  }
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
