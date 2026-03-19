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

export type PlannerTraceEvent = {
  event:
    | "llm_plan_start"
    | "llm_plan_success"
    | "llm_plan_gateway_failed"
    | "llm_plan_direct_openai_fallback"
    | "plan_validation_failed"
    | "plan_validation_passed"
    | "plan_step_start"
    | "plan_step_end"
    | "plan_step_var_saved"
    | "plan_step_var_extracted";
  model?: string;
  fallbackModels?: string[];
  directModel?: string;
  step?: number;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path?: string;
  dryRun?: boolean;
  saveAs?: string;
  extractKey?: string;
  totalSteps?: number;
  responseShape?: unknown;
  error?: string;
};

type PlannerTrace = (event: PlannerTraceEvent) => void;

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

function extractFirstNumericId(prompt: string): string | null {
  const match = prompt.match(/\b(\d{1,9})\b/);
  return match?.[1] ?? null;
}

function extractPhone(prompt: string): string | null {
  const match = prompt.match(/\+?\d[\d\s-]{6,}\d/);
  return match?.[0]?.replace(/\s+/g, " ").trim() ?? null;
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

function isUpdateIntent(lower: string): boolean {
  const explicitReadOnlyNegations = [
    "do not modify",
    "without modifying",
    "read-only",
    "read only",
    "no changes",
    "ikke endre",
    "uten å endre",
    "kun les",
  ];
  if (explicitReadOnlyNegations.some((token) => lower.includes(token))) return false;
  return [
    "update",
    "oppdater",
    "endre",
    "set ",
    "modify",
    "rediger",
  ].some((token) => lower.includes(token));
}

type NormalizedEntity =
  | "employee"
  | "customer"
  | "department"
  | "project"
  | "invoice"
  | "order"
  | "product"
  | "travelExpense"
  | "ledger_account"
  | "ledger_posting"
  | "ledger_voucher";

type AllowedMethod = "GET" | "POST" | "PUT" | "DELETE";

type EndpointContract = {
  basePath: string;
  entity: NormalizedEntity;
  methods: AllowedMethod[];
  idPathRequiredFor?: AllowedMethod[];
};

const ENDPOINT_CONTRACTS: EndpointContract[] = [
  { basePath: "/employee", entity: "employee", methods: ["GET", "POST", "PUT"], idPathRequiredFor: ["PUT"] },
  { basePath: "/customer", entity: "customer", methods: ["GET", "POST", "PUT"], idPathRequiredFor: ["PUT"] },
  { basePath: "/product", entity: "product", methods: ["GET", "POST"] },
  { basePath: "/invoice", entity: "invoice", methods: ["GET", "POST"] },
  { basePath: "/order", entity: "order", methods: ["GET", "POST"] },
  {
    basePath: "/travelExpense",
    entity: "travelExpense",
    methods: ["GET", "POST", "PUT", "DELETE"],
    idPathRequiredFor: ["PUT", "DELETE"],
  },
  { basePath: "/project", entity: "project", methods: ["GET", "POST"] },
  { basePath: "/department", entity: "department", methods: ["GET", "POST"] },
  { basePath: "/ledger/account", entity: "ledger_account", methods: ["GET"] },
  { basePath: "/ledger/posting", entity: "ledger_posting", methods: ["GET"] },
  {
    basePath: "/ledger/voucher",
    entity: "ledger_voucher",
    methods: ["GET", "POST", "DELETE"],
    idPathRequiredFor: ["DELETE"],
  },
];

const ENDPOINT_CONTRACTS_BY_MATCH = [...ENDPOINT_CONTRACTS].sort((a, b) => b.basePath.length - a.basePath.length);

const ENTITY_KEYWORDS: Array<{ entity: NormalizedEntity; keywords: string[] }> = [
  { entity: "employee", keywords: ["employee", "ansatt", "ansatte", "medarbeider"] },
  { entity: "customer", keywords: ["customer", "kunde", "kunder", "client", "cliente"] },
  { entity: "department", keywords: ["department", "avdeling", "avdelinger"] },
  { entity: "project", keywords: ["project", "prosjekt", "prosjekter"] },
  { entity: "invoice", keywords: ["invoice", "faktura", "fakturaer"] },
  { entity: "order", keywords: ["order", "ordre", "ordrer"] },
  { entity: "product", keywords: ["product", "produkt", "produkter"] },
  { entity: "travelExpense", keywords: ["travel expense", "reise", "reiseregning", "reiseregninger"] },
  { entity: "ledger_account", keywords: ["ledger account", "kontoplan", "konto"] },
  { entity: "ledger_posting", keywords: ["ledger posting", "hovedbokspost", "postering"] },
  { entity: "ledger_voucher", keywords: ["ledger voucher", "voucher", "bilag"] },
];

function normalizePath(path: string): string {
  const noQuery = path.split("?")[0] || "";
  const withLeading = noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
  const squashed = withLeading.replace(/\/{2,}/g, "/");
  if (squashed.length > 1 && squashed.endsWith("/")) return squashed.slice(0, -1);
  return squashed;
}

function endpointContractFromPath(path: string): EndpointContract | null {
  const normalized = normalizePath(path).toLowerCase();
  for (const contract of ENDPOINT_CONTRACTS_BY_MATCH) {
    const base = contract.basePath.toLowerCase();
    if (normalized === base || normalized.startsWith(`${base}/`)) return contract;
  }
  return null;
}

function pathHasIdSegment(path: string, basePath: string): boolean {
  const normalized = normalizePath(path);
  const normalizedLower = normalized.toLowerCase();
  const baseLower = basePath.toLowerCase();
  if (!normalizedLower.startsWith(`${baseLower}/`)) return false;
  const remainder = normalized.slice(basePath.length + 1);
  if (!remainder) return false;
  const firstSegment = remainder.split("/")[0] ?? "";
  if (!firstSegment || firstSegment.startsWith(":")) return false;
  return /^\d+$/.test(firstSegment) || /^\{\{\s*[a-zA-Z0-9_.]+\s*}}$/.test(firstSegment);
}

function pathMatchesChallengeShape(path: string, basePath: string): boolean {
  const normalized = normalizePath(path);
  const normalizedLower = normalized.toLowerCase();
  const baseLower = basePath.toLowerCase();
  if (normalizedLower === baseLower) return true;
  if (!normalizedLower.startsWith(`${baseLower}/`)) return false;
  const remainder = normalized.slice(basePath.length + 1);
  if (!remainder) return false;
  if (remainder.includes("/")) return false;
  if (remainder.startsWith(":")) return false;
  return /^\d+$/.test(remainder) || /^\{\{\s*[a-zA-Z0-9_.]+\s*}}$/.test(remainder);
}

function entityFromPath(path: string): NormalizedEntity | null {
  const contract = endpointContractFromPath(path);
  return contract?.entity ?? null;
}

function requestedEntitiesFromPrompt(lower: string): Set<NormalizedEntity> {
  const set = new Set<NormalizedEntity>();
  for (const entry of ENTITY_KEYWORDS) {
    if (entry.keywords.some((keyword) => lower.includes(keyword))) {
      set.add(entry.entity);
    }
  }
  return set;
}

export function validatePlanForPrompt(prompt: string, plan: ExecutionPlan): string[] {
  const lower = prompt.toLowerCase();
  const createIntent = isCreateIntent(lower);
  const deleteIntent = isDeleteIntent(lower);
  const updateIntent = isUpdateIntent(lower);
  const readIntent = isReadIntent(lower) && !createIntent && !deleteIntent && !updateIntent;

  const requestedEntities = requestedEntitiesFromPrompt(lower);
  const planEntities = new Set<NormalizedEntity>();
  for (const step of plan.steps) {
    const entity = entityFromPath(step.path);
    if (entity) planEntities.add(entity);
  }

  const issues: string[] = [];
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index] as PlanStep;
    const stepNumber = index + 1;
    const contract = endpointContractFromPath(step.path);
    if (!contract) {
      issues.push(`step ${stepNumber}: path '${step.path}' is outside allowed endpoint set`);
      continue;
    }
    if (!contract.methods.includes(step.method as AllowedMethod)) {
      issues.push(
        `step ${stepNumber}: method ${step.method} is not allowed for ${contract.basePath} (allowed: ${contract.methods.join(", ")})`,
      );
    }
    if (!pathMatchesChallengeShape(step.path, contract.basePath)) {
      issues.push(`step ${stepNumber}: path '${step.path}' must use ${contract.basePath} or ${contract.basePath}/{id}`);
    }
    if ((contract.idPathRequiredFor ?? []).includes(step.method as AllowedMethod) && !pathHasIdSegment(step.path, contract.basePath)) {
      issues.push(`step ${stepNumber}: ${step.method} must target an ID path like ${contract.basePath}/{id}`);
    }
    if (step.method === "POST" || step.method === "PUT") {
      const isTemplateString = typeof step.body === "string" && step.body.includes("{{");
      if (step.body === undefined || step.body === null || (typeof step.body !== "object" && !isTemplateString)) {
        issues.push(`step ${stepNumber}: ${step.method} requires an object JSON body`);
      }
    }
  }

  if (readIntent && plan.steps.some((step) => step.method !== "GET")) {
    issues.push("read-only prompt produced mutating method");
  }
  if (createIntent && !plan.steps.some((step) => step.method === "POST")) {
    issues.push("create intent detected but no POST step");
  }
  if (deleteIntent && !plan.steps.some((step) => step.method === "DELETE")) {
    issues.push("delete intent detected but no DELETE step");
  }
  if (updateIntent && !plan.steps.some((step) => step.method === "PUT" || step.method === "POST")) {
    issues.push("update intent detected but no PUT/POST step");
  }

  if (requestedEntities.size > 0) {
    const covered = [...requestedEntities].filter((entity) => planEntities.has(entity));
    if (covered.length === 0) {
      issues.push("none of the requested entities appear in plan steps");
    } else if (requestedEntities.size >= 2 && covered.length < requestedEntities.size) {
      issues.push(`partial entity coverage: covered ${covered.length}/${requestedEntities.size}`);
    }
  }

  return issues;
}

export function heuristicPlan(payload: SolveRequest): ExecutionPlan {
  const prompt = payload.prompt;
  const lower = prompt.toLowerCase();
  const email = extractEmail(prompt);
  const quoted = extractQuoted(prompt);
  const capitalized = extractCapitalizedName(prompt);
  const numericId = extractFirstNumericId(prompt);
  const phone = extractPhone(prompt);
  const createIntent = isCreateIntent(lower);
  const deleteIntent = isDeleteIntent(lower);
  const updateIntent = isUpdateIntent(lower) && !createIntent && !deleteIntent;
  const readIntent = isReadIntent(lower) && !createIntent && !deleteIntent && !updateIntent;

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

  if ((lower.includes("employee") || lower.includes("ansatt")) && updateIntent) {
    const body: Record<string, unknown> = {};
    if (email) body.email = email;
    if (phone) body.mobileNumber = phone;
    if (quoted || capitalized) {
      const person = splitPersonName(quoted ?? capitalized);
      body.firstName = person.firstName;
      body.lastName = person.lastName;
    }
    if (Object.keys(body).length > 0) {
      if (numericId) {
        return {
          summary: "Heuristic employee update by id flow",
          steps: [{ method: "PUT", path: `/employee/${numericId}`, body, reason: "Update employee by explicit id" }],
        };
      }
      return {
        summary: "Heuristic employee lookup + update flow",
        steps: [
          {
            method: "GET",
            path: "/employee",
            params: { count: 1, fields: "id,firstName,lastName,email,mobileNumber" },
            saveAs: "employee",
            reason: "Fetch one employee id for update fallback",
          },
          {
            method: "PUT",
            path: "/employee/{{employee_id}}",
            body,
            reason: "Apply requested employee update fields",
          },
        ],
      };
    }
  }

  if ((lower.includes("customer") || lower.includes("kunde") || lower.includes("cliente")) && updateIntent) {
    const body: Record<string, unknown> = {};
    if (email) body.email = email;
    if (phone) body.phoneNumber = phone;
    if (quoted || capitalized) {
      body.name = quoted ?? capitalized;
    }
    if (Object.keys(body).length > 0) {
      if (numericId) {
        return {
          summary: "Heuristic customer update by id flow",
          steps: [{ method: "PUT", path: `/customer/${numericId}`, body, reason: "Update customer by explicit id" }],
        };
      }
      return {
        summary: "Heuristic customer lookup + update flow",
        steps: [
          {
            method: "GET",
            path: "/customer",
            params: { count: 1, fields: "id,name,email,phoneNumber" },
            saveAs: "customer",
            reason: "Fetch one customer id for update fallback",
          },
          {
            method: "PUT",
            path: "/customer/{{customer_id}}",
            body,
            reason: "Apply requested customer update fields",
          },
        ],
      };
    }
  }

  if ((lower.includes("travel expense") || lower.includes("reise")) && updateIntent) {
    const body: Record<string, unknown> = {};
    if (quoted) body.description = quoted;
    if (Object.keys(body).length > 0) {
      if (numericId) {
        return {
          summary: "Heuristic travel expense update by id flow",
          steps: [{ method: "PUT", path: `/travelExpense/${numericId}`, body }],
        };
      }
      return {
        summary: "Heuristic travel expense lookup + update flow",
        steps: [
          {
            method: "GET",
            path: "/travelExpense",
            params: { count: 1, fields: "id,description" },
            saveAs: "travelExpense",
            reason: "Fetch one travel expense id for update fallback",
          },
          {
            method: "PUT",
            path: "/travelExpense/{{travelExpense_id}}",
            body,
            reason: "Apply requested travel expense update fields",
          },
        ],
      };
    }
  }

  if ((lower.includes("travel expense") || lower.includes("reise")) && deleteIntent) {
    if (numericId) {
      return {
        summary: "Heuristic travel expense delete flow",
        steps: [{ method: "DELETE", path: `/travelExpense/${numericId}` }],
      };
    }
    return {
      summary: "Heuristic travel expense fetch-and-delete flow",
      steps: [
        {
          method: "GET",
          path: "/travelExpense",
          params: { count: 1, fields: "id" },
          saveAs: "travelExpense",
          reason: "Fetch one travel expense id before delete",
        },
        {
          method: "DELETE",
          path: "/travelExpense/{{travelExpense_id}}",
          reason: "Delete fetched travel expense",
        },
      ],
    };
  }

  if ((lower.includes("voucher") || lower.includes("bilag")) && deleteIntent) {
    if (numericId) {
      return {
        summary: "Heuristic ledger voucher delete flow",
        steps: [{ method: "DELETE", path: `/ledger/voucher/${numericId}` }],
      };
    }
    return {
      summary: "Heuristic ledger voucher fetch-and-delete flow",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: { count: 1, fields: "id" },
          saveAs: "voucher",
          reason: "Fetch one voucher id before delete",
        },
        {
          method: "DELETE",
          path: "/ledger/voucher/{{voucher_id}}",
          reason: "Delete fetched voucher",
        },
      ],
    };
  }

  if ((lower.includes("project") || lower.includes("prosjekt")) && createIntent) {
    const projectName = quoted ?? capitalized ?? `Generated Project ${Date.now().toString().slice(-6)}`;
    return {
      summary: "Heuristic project create flow",
      steps: [
        {
          method: "POST",
          path: "/project",
          body: { name: projectName },
          saveAs: "project",
          reason: "Create project from prompt fields",
        },
      ],
    };
  }

  if ((lower.includes("product") || lower.includes("produkt")) && createIntent) {
    const productName = quoted ?? capitalized ?? `Generated Product ${Date.now().toString().slice(-6)}`;
    return {
      summary: "Heuristic product create flow",
      steps: [
        {
          method: "POST",
          path: "/product",
          body: { name: productName },
          saveAs: "product",
          reason: "Create product from prompt fields",
        },
      ],
    };
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

  if (readIntent && (lower.includes("product") || lower.includes("produkt"))) {
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
    "Challenge endpoint/method contract:",
    "- /employee: GET, POST, PUT (PUT must use /employee/{id})",
    "- /customer: GET, POST, PUT (PUT must use /customer/{id})",
    "- /product: GET, POST",
    "- /invoice: GET, POST",
    "- /order: GET, POST",
    "- /travelExpense: GET, POST, PUT, DELETE (PUT/DELETE must use /travelExpense/{id})",
    "- /project: GET, POST",
    "- /department: GET, POST",
    "- /ledger/account: GET",
    "- /ledger/posting: GET",
    "- /ledger/voucher: GET, POST, DELETE (DELETE must use /ledger/voucher/{id})",
    "Use only relative endpoint paths, for example /employee.",
    "DELETE requests must use ID in URL path.",
    "POST and PUT requests must include JSON body.",
    "GET list responses are typically wrapped as { fullResultSize: N, values: [...] }.",
    "For created entities, set saveAs and use templating in later steps with {{alias_id}} or {{alias.field}}.",
    "If prompt is read-only (e.g. list/show/find/get/do not modify), use GET-only steps and never mutate data.",
    "Use query tips for efficient reads: fields, count, from.",
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
  trace?: PlannerTrace,
): Promise<ExecutionPlan> {
  const modelName = selectPlanningModel(payload.prompt, summaries);
  const fallbackModels = parseFallbackModels(modelName);
  trace?.({
    event: "llm_plan_start",
    model: modelName,
    fallbackModels,
  });
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
    trace?.({
      event: "llm_plan_success",
      model: modelName,
      totalSteps: object.steps.length,
    });
    return object;
  } catch (error) {
    trace?.({
      event: "llm_plan_gateway_failed",
      model: modelName,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!shouldUseDirectOpenAiFallback()) {
      throw error;
    }

    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    });
    const directModel = process.env.TRIPLETEX_DIRECT_OPENAI_MODEL?.trim() || "gpt-4.1-mini";
    trace?.({
      event: "llm_plan_direct_openai_fallback",
      model: modelName,
      directModel,
    });
    const { object } = await generateObject({
      model: openai(directModel),
      schema: executionPlanSchema,
      temperature: 0,
      prompt: buildPlanningPrompt(payload, summaries, `Gateway failed: ${String(error)}\n${previousError || ""}`.trim()),
    });
    trace?.({
      event: "llm_plan_success",
      model: directModel,
      totalSteps: object.steps.length,
    });
    return object;
  }
}

function summarizeResponseShape(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const object = response as Record<string, unknown>;
  return {
    keys: Object.keys(object).slice(0, 20),
    hasValue: object.value !== undefined,
    valuesCount: Array.isArray(object.values) ? object.values.length : undefined,
  };
}

export async function executePlan(
  client: TripletexClient,
  plan: ExecutionPlan,
  dryRun: boolean,
  trace?: PlannerTrace,
): Promise<number> {
  const vars: Record<string, unknown> = {};
  let count = 0;

  for (const rawStep of plan.steps) {
    const step = rawStep as PlanStep;
    count += 1;
    const path = interpolateValue(step.path, vars);
    const params = interpolateValue(step.params ?? {}, vars);
    const body = interpolateValue(step.body, vars);
    if (typeof path !== "string") throw new SolveError("Resolved path must be a string.");
    trace?.({
      event: "plan_step_start",
      step: count,
      method: step.method,
      path,
      dryRun: dryRun && step.method !== "GET",
    });

    let response: unknown;
    if (dryRun && step.method !== "GET") {
      response = { value: { id: count, dryRun: true } };
    } else {
      response = await client.request(step.method, path, {
        params: (params ?? {}) as Record<string, unknown>,
        body,
      });
    }
    trace?.({
      event: "plan_step_end",
      step: count,
      method: step.method,
      path,
      responseShape: summarizeResponseShape(response),
    });

    const primary = primaryValue(response);
    if (step.saveAs) {
      vars[step.saveAs] = primary;
      trace?.({
        event: "plan_step_var_saved",
        step: count,
        saveAs: step.saveAs,
      });
      if (primary && typeof primary === "object" && (primary as Record<string, unknown>).id !== undefined) {
        vars[`${step.saveAs}_id`] = (primary as Record<string, unknown>).id;
        trace?.({
          event: "plan_step_var_saved",
          step: count,
          saveAs: `${step.saveAs}_id`,
        });
      }
    }
    for (const [name, sourcePath] of Object.entries(step.extract ?? {}) as Array<[string, string]>) {
      const extracted = dig(response, sourcePath);
      if (extracted !== undefined) {
        vars[name] = extracted;
        trace?.({
          event: "plan_step_var_extracted",
          step: count,
          extractKey: name,
        });
      }
    }
  }

  return count;
}
