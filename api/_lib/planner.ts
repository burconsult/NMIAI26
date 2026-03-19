import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";

import type { AttachmentSummary } from "./attachments.js";
import type { ExecutionPlan, PlanStep, SolveRequest } from "./schemas.js";
import { executionPlanSchema } from "./schemas.js";
import { dig, primaryValue, TripletexClient, TripletexError } from "./tripletex.js";

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
    | "plan_step_var_extracted"
    | "plan_step_retry_on_validation"
    | "plan_step_retry_success";
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
  retryFields?: string[];
};

type PlannerTrace = (event: PlannerTraceEvent) => void;

const varPattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*}}/g;

function canonicalVarName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function extractIdFromVarValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (object.id !== undefined) return object.id;
  if (object.value && typeof object.value === "object" && (object.value as Record<string, unknown>).id !== undefined) {
    return (object.value as Record<string, unknown>).id;
  }
  if (Array.isArray(object.values) && object.values.length > 0) {
    const first = object.values[0];
    if (first && typeof first === "object" && (first as Record<string, unknown>).id !== undefined) {
      return (first as Record<string, unknown>).id;
    }
  }
  return undefined;
}

function resolveVarRoot(vars: Record<string, unknown>, name: string): unknown {
  if (name in vars) return vars[name];

  const canonical = canonicalVarName(name);
  for (const [key, value] of Object.entries(vars)) {
    if (canonicalVarName(key) === canonical) return value;
  }

  const camelIdMatch = name.match(/^(.+)Id$/);
  if (camelIdMatch?.[1]) {
    const base = resolveVarRoot(vars, camelIdMatch[1]);
    const id = extractIdFromVarValue(base);
    if (id !== undefined) return id;
  }

  const snakeIdMatch = name.match(/^(.+)_id$/i);
  if (snakeIdMatch?.[1]) {
    const base = resolveVarRoot(vars, snakeIdMatch[1]);
    const id = extractIdFromVarValue(base);
    if (id !== undefined) return id;
  }

  return undefined;
}

function resolveVar(vars: Record<string, unknown>, expr: string): unknown {
  const normalized = expr.startsWith("vars.") ? expr.slice(5) : expr;
  if (!normalized.includes(".")) return resolveVarRoot(vars, normalized);
  const [root, ...rest] = normalized.split(".");
  const base = resolveVarRoot(vars, root);
  if (base === undefined) return undefined;
  if (!rest.length) return base;
  const subPath = rest.join(".");
  const resolved = dig(base, subPath);
  if (resolved !== undefined) return resolved;
  if (subPath === "id") {
    const derived = extractIdFromVarValue(base);
    if (derived !== undefined) return derived;
  }
  return undefined;
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
  {
    entity: "employee",
    keywords: ["employee", "ansatt", "ansatte", "medarbeider", "empleado", "empregado", "mitarbeiter", "employe"],
  },
  {
    entity: "customer",
    keywords: ["customer", "kunde", "kunder", "client", "cliente", "clientes"],
  },
  { entity: "department", keywords: ["department", "avdeling", "avdelinger", "departamento", "abteilung", "departement"] },
  { entity: "project", keywords: ["project", "prosjekt", "prosjekter", "proyecto", "projeto", "projekt", "projet"] },
  { entity: "invoice", keywords: ["invoice", "faktura", "fakturaer", "factura", "fatura", "rechnung", "facture"] },
  { entity: "order", keywords: ["order", "ordre", "ordrer", "pedido", "bestellung", "commande", "encomenda"] },
  { entity: "product", keywords: ["product", "produkt", "produkter", "producto", "produto", "produit"] },
  {
    entity: "travelExpense",
    keywords: ["travel expense", "reiseutgift", "reiseregning", "gasto de viaje", "despesa de viagem", "reisekosten", "note de frais"],
  },
  {
    entity: "ledger_account",
    keywords: ["ledger account", "chart of accounts", "kontoplan", "plan de cuentas", "plano de contas", "kontenplan", "plan comptable"],
  },
  {
    entity: "ledger_posting",
    keywords: ["ledger posting", "hovedbokspost", "hovedboksposter", "asiento contable", "lancamento contabil", "buchung"],
  },
  {
    entity: "ledger_voucher",
    keywords: ["ledger voucher", "voucher", "bilag", "comprobante contable", "comprovante", "beleg", "piece comptable"],
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptContainsKeyword(lowerPrompt: string, keyword: string): boolean {
  if (!keyword.trim()) return false;
  if (keyword.includes(" ")) return lowerPrompt.includes(keyword);
  const pattern = new RegExp(`(^|[^a-z0-9æøå])${escapeRegExp(keyword)}([^a-z0-9æøå]|$)`, "i");
  return pattern.test(lowerPrompt);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    sorted[key] = sortJsonValue(object[key]);
  }
  return sorted;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value);
  }
}

function normalizePath(path: string): string {
  const noQuery = path.split("?")[0] || "";
  const withLeading = noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
  const squashed = withLeading.replace(/\/{2,}/g, "/");
  if (squashed.length > 1 && squashed.endsWith("/")) return squashed.slice(0, -1);
  return squashed;
}

function defaultLedgerDateFrom(): string {
  return process.env.TRIPLETEX_LEDGER_DATE_FROM?.trim() || "2000-01-01";
}

function defaultLedgerDateTo(): string {
  return process.env.TRIPLETEX_LEDGER_DATE_TO?.trim() || "2100-12-31";
}

function defaultEntityDateFrom(): string {
  return process.env.TRIPLETEX_ENTITY_DATE_FROM?.trim() || "2000-01-01";
}

function defaultEntityDateTo(): string {
  return process.env.TRIPLETEX_ENTITY_DATE_TO?.trim() || "2100-12-31";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
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

function ensurePlannerSafeQueryParams(
  method: AllowedMethod,
  path: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method !== "GET") return params;
  const contract = endpointContractFromPath(path);
  if (!contract) return params;

  const hasId = pathHasIdSegment(path, contract.basePath);
  const next = { ...params };

  if (!hasId) {
    if (next.count === undefined || next.count === null || String(next.count).trim() === "") {
      next.count = 1;
    }
    if (next.from === undefined || next.from === null || String(next.from).trim() === "") {
      next.from = 0;
    }
  }

  if (!hasId && (contract.basePath === "/ledger/posting" || contract.basePath === "/ledger/voucher")) {
    if (next.dateFrom === undefined || next.dateFrom === null || String(next.dateFrom).trim() === "") {
      next.dateFrom = defaultLedgerDateFrom();
    }
    if (next.dateTo === undefined || next.dateTo === null || String(next.dateTo).trim() === "") {
      next.dateTo = defaultLedgerDateTo();
    }
  }

  if (!hasId && contract.basePath === "/order") {
    if (next.orderDateFrom === undefined || next.orderDateFrom === null || String(next.orderDateFrom).trim() === "") {
      next.orderDateFrom = defaultEntityDateFrom();
    }
    if (next.orderDateTo === undefined || next.orderDateTo === null || String(next.orderDateTo).trim() === "") {
      next.orderDateTo = defaultEntityDateTo();
    }
  }

  if (!hasId && contract.basePath === "/invoice") {
    if (next.invoiceDateFrom === undefined || next.invoiceDateFrom === null || String(next.invoiceDateFrom).trim() === "") {
      next.invoiceDateFrom = defaultEntityDateFrom();
    }
    if (next.invoiceDateTo === undefined || next.invoiceDateTo === null || String(next.invoiceDateTo).trim() === "") {
      next.invoiceDateTo = defaultEntityDateTo();
    }
  }

  return next;
}

function entityFromPath(path: string): NormalizedEntity | null {
  const contract = endpointContractFromPath(path);
  return contract?.entity ?? null;
}

function requestedEntitiesFromPrompt(lower: string): Set<NormalizedEntity> {
  const set = new Set<NormalizedEntity>();
  for (const entry of ENTITY_KEYWORDS) {
    if (entry.keywords.some((keyword) => promptContainsKeyword(lower, keyword.toLowerCase()))) {
      set.add(entry.entity);
    }
  }
  return set;
}

function planTouchesRequestedEntities(
  requestedEntities: Set<NormalizedEntity>,
  planEntities: Set<NormalizedEntity>,
): boolean {
  for (const entity of requestedEntities) {
    if (planEntities.has(entity)) return true;
  }
  return false;
}

function hasRepeatedIdenticalMutations(plan: ExecutionPlan): boolean {
  let previousMutation: { method: AllowedMethod; path: string; bodyFingerprint: string } | null = null;
  for (const step of plan.steps) {
    if (step.method === "GET") continue;
    const current = {
      method: step.method,
      path: normalizePath(step.path),
      bodyFingerprint: stableJson(step.body ?? {}),
    };
    if (
      previousMutation &&
      previousMutation.method === current.method &&
      previousMutation.path === current.path &&
      previousMutation.bodyFingerprint === current.bodyFingerprint
    ) {
      return true;
    }
    previousMutation = current;
  }
  return false;
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
    const stepParams = toRecord(step.params);
    if (
      step.method === "GET" &&
      !pathHasIdSegment(step.path, contract.basePath) &&
      (contract.basePath === "/ledger/posting" || contract.basePath === "/ledger/voucher")
    ) {
      if (stepParams.dateFrom === undefined || stepParams.dateFrom === null || String(stepParams.dateFrom).trim() === "") {
        issues.push(`step ${stepNumber}: GET ${contract.basePath} must include query param dateFrom`);
      }
      if (stepParams.dateTo === undefined || stepParams.dateTo === null || String(stepParams.dateTo).trim() === "") {
        issues.push(`step ${stepNumber}: GET ${contract.basePath} must include query param dateTo`);
      }
    }
    if (step.method === "GET" && !pathHasIdSegment(step.path, contract.basePath) && contract.basePath === "/order") {
      if (
        stepParams.orderDateFrom === undefined ||
        stepParams.orderDateFrom === null ||
        String(stepParams.orderDateFrom).trim() === ""
      ) {
        issues.push(`step ${stepNumber}: GET /order must include query param orderDateFrom`);
      }
      if (stepParams.orderDateTo === undefined || stepParams.orderDateTo === null || String(stepParams.orderDateTo).trim() === "") {
        issues.push(`step ${stepNumber}: GET /order must include query param orderDateTo`);
      }
    }
    if (step.method === "GET" && !pathHasIdSegment(step.path, contract.basePath) && contract.basePath === "/invoice") {
      if (
        stepParams.invoiceDateFrom === undefined ||
        stepParams.invoiceDateFrom === null ||
        String(stepParams.invoiceDateFrom).trim() === ""
      ) {
        issues.push(`step ${stepNumber}: GET /invoice must include query param invoiceDateFrom`);
      }
      if (
        stepParams.invoiceDateTo === undefined ||
        stepParams.invoiceDateTo === null ||
        String(stepParams.invoiceDateTo).trim() === ""
      ) {
        issues.push(`step ${stepNumber}: GET /invoice must include query param invoiceDateTo`);
      }
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

  if (requestedEntities.size > 0 && planEntities.size === 0) {
    issues.push("plan steps did not match any recognized challenge entities");
  }
  if (requestedEntities.size === 1 && !planTouchesRequestedEntities(requestedEntities, planEntities)) {
    const requested = [...requestedEntities][0];
    issues.push(`plan does not include requested entity '${requested}'`);
  }
  if (
    requestedEntities.size > 0 &&
    (createIntent || updateIntent || deleteIntent || readIntent) &&
    !planTouchesRequestedEntities(requestedEntities, planEntities)
  ) {
    issues.push("plan steps do not touch entities requested by prompt");
  }
  if (hasRepeatedIdenticalMutations(plan)) {
    issues.push("plan contains repeated identical mutating steps");
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
          params: {
            invoiceDateFrom: defaultEntityDateFrom(),
            invoiceDateTo: defaultEntityDateTo(),
            count: 1,
          },
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
          params: {
            orderDateFrom: defaultEntityDateFrom(),
            orderDateTo: defaultEntityDateTo(),
            count: 1,
          },
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
          params: {
            dateFrom: defaultLedgerDateFrom(),
            dateTo: defaultLedgerDateTo(),
            count: 1,
          },
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
          params: {
            dateFrom: defaultLedgerDateFrom(),
            dateTo: defaultLedgerDateTo(),
            count: 1,
          },
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

  return {
    summary: "Heuristic generic fallback read flow",
    steps: [
      {
        method: "GET",
        path: "/employee",
        params: { count: 1, fields: "id,firstName,lastName,email" },
        reason: "Last-resort safe probe when prompt parsing fails",
      },
    ],
  };
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
    "- GET /ledger/posting and GET /ledger/voucher list calls must include dateFrom and dateTo (YYYY-MM-DD).",
    "- GET /order list calls must include orderDateFrom and orderDateTo (YYYY-MM-DD).",
    "- GET /invoice list calls must include invoiceDateFrom and invoiceDateTo (YYYY-MM-DD).",
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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function firstIdFromVars(vars: Record<string, unknown>, candidates: string[]): unknown {
  for (const candidate of candidates) {
    const direct = resolveVar(vars, candidate);
    if (direct !== undefined) {
      if (typeof direct === "string" || typeof direct === "number") return direct;
      const extracted = extractIdFromVarValue(direct);
      if (extracted !== undefined) return extracted;
    }
  }

  const wanted = candidates.map((value) => canonicalVarName(value));
  for (const [key, value] of Object.entries(vars)) {
    const canonicalKey = canonicalVarName(key);
    if (!wanted.some((needle) => canonicalKey.includes(needle))) continue;
    if (typeof value === "string" || typeof value === "number") return value;
    const extracted = extractIdFromVarValue(value);
    if (extracted !== undefined) return extracted;
  }
  return undefined;
}

function generatedEntityName(path: string): string {
  const entity = endpointContractFromPath(path)?.entity ?? "entity";
  const readable = entity.replace("ledger_", "ledger ").replace("travelExpense", "travel expense");
  const suffix = Date.now().toString().slice(-6);
  return `Generated ${readable} ${suffix}`;
}

function withPreflightBodyDefaults(
  method: AllowedMethod,
  path: string,
  body: unknown,
  vars: Record<string, unknown>,
): { body: unknown; changed: boolean } {
  if (method !== "POST" && method !== "PUT") return { body, changed: false };
  const normalizedPath = normalizePath(path);
  const next = toRecord(body);
  let changed = false;
  const setIfMissing = (key: string, value: unknown): void => {
    if (!hasValue(value) || hasValue(next[key])) return;
    next[key] = value;
    changed = true;
  };

  const customerId = firstIdFromVars(vars, ["customer_id", "customerId", "customer"]);
  const employeeId = firstIdFromVars(vars, ["employee_id", "employeeId", "employee", "projectManager_id"]);
  const orderId = firstIdFromVars(vars, ["order_id", "orderId", "order"]);

  if (normalizedPath === "/project") {
    setIfMissing("name", generatedEntityName(path));
    setIfMissing("startDate", todayIsoDate());
    if (!hasValue(next.customer) && hasValue(customerId)) {
      next.customer = { id: customerId };
      changed = true;
    }
    if (!hasValue(next.projectManager) && hasValue(employeeId)) {
      next.projectManager = { id: employeeId };
      changed = true;
    }
  } else if (normalizedPath === "/order") {
    setIfMissing("orderDate", todayIsoDate());
    setIfMissing("deliveryDate", todayIsoDate());
    if (!hasValue(next.customer) && hasValue(customerId)) {
      next.customer = { id: customerId };
      changed = true;
    }
  } else if (normalizedPath === "/invoice") {
    setIfMissing("invoiceDate", todayIsoDate());
    setIfMissing("invoiceDueDate", todayIsoDate());
    if (!hasValue(next.customer) && hasValue(customerId)) {
      next.customer = { id: customerId };
      changed = true;
    }
    if (!Array.isArray(next.orders) && hasValue(orderId)) {
      next.orders = [{ id: orderId }];
      changed = true;
    }
  } else if (normalizedPath === "/travelExpense") {
    setIfMissing("date", todayIsoDate());
    if (!hasValue(next.employee) && hasValue(employeeId)) {
      next.employee = { id: employeeId };
      changed = true;
    }
  }

  return changed ? { body: next, changed } : { body, changed };
}

function validationFieldsFromError(error: unknown): string[] {
  if (!(error instanceof TripletexError)) return [];
  if (error.statusCode !== 422) return [];
  const body = error.responseBody as Record<string, unknown> | undefined;
  const validationMessages = Array.isArray(body?.validationMessages) ? body.validationMessages : [];
  const fields: string[] = [];
  for (const item of validationMessages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const field = typeof row.field === "string" ? row.field.trim() : "";
    if (field) {
      fields.push(field);
      continue;
    }
    const message = typeof row.message === "string" ? row.message.toLowerCase() : "";
    if (!message) continue;
    if (message.includes("prosjektleder") || message.includes("project manager")) {
      fields.push("projectManager");
    }
    if (message.includes("kunde") || message.includes("customer")) {
      fields.push("customer");
    }
    if (message.includes("ansatt") || message.includes("employee")) {
      fields.push("employee");
    }
  }
  return [...new Set(fields)];
}

function cachedId(vars: Record<string, unknown>, key: string): unknown {
  return firstIdFromVars(vars, [`${key}_id`, `${key}Id`, key]);
}

function cacheId(vars: Record<string, unknown>, key: string, id: unknown): void {
  if (!hasValue(id)) return;
  vars[`${key}_id`] = id;
  vars[key] = { id };
}

async function fetchOrCreateCustomerId(
  client: TripletexClient,
  vars: Record<string, unknown>,
): Promise<unknown> {
  const existing = cachedId(vars, "customer");
  if (hasValue(existing)) return existing;
  try {
    const fetched = await client.request("GET", "/customer", {
      params: { count: 1, from: 0, fields: "id" },
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "customer", id);
      return id;
    }
  } catch {
    // Ignore and try create fallback.
  }
  try {
    const created = await client.request("POST", "/customer", {
      body: {
        name: generatedEntityName("/customer"),
        isCustomer: true,
      },
    });
    const id = extractIdFromVarValue(primaryValue(created));
    if (hasValue(id)) {
      cacheId(vars, "customer", id);
      return id;
    }
  } catch {
    // Ignore: caller will continue without injected ID.
  }
  return undefined;
}

async function fetchOrCreateEmployeeId(
  client: TripletexClient,
  vars: Record<string, unknown>,
): Promise<unknown> {
  const existing = cachedId(vars, "employee");
  if (hasValue(existing)) return existing;
  try {
    const fetched = await client.request("GET", "/employee", {
      params: { count: 1, from: 0, fields: "id" },
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "employee", id);
      return id;
    }
  } catch {
    // Ignore and try create fallback.
  }
  try {
    const created = await client.request("POST", "/employee", {
      body: {
        firstName: "Generated",
        lastName: `Employee${Date.now().toString().slice(-6)}`,
      },
    });
    const id = extractIdFromVarValue(primaryValue(created));
    if (hasValue(id)) {
      cacheId(vars, "employee", id);
      return id;
    }
  } catch {
    // Ignore: caller will continue without injected ID.
  }
  return undefined;
}

async function fetchOrCreateOrderId(
  client: TripletexClient,
  vars: Record<string, unknown>,
): Promise<unknown> {
  const existing = cachedId(vars, "order");
  if (hasValue(existing)) return existing;
  try {
    const fetched = await client.request("GET", "/order", {
      params: { count: 1, from: 0, fields: "id" },
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "order", id);
      return id;
    }
  } catch {
    // Ignore and try create fallback.
  }

  const customerId = await fetchOrCreateCustomerId(client, vars);
  if (!hasValue(customerId)) return undefined;
  try {
    const created = await client.request("POST", "/order", {
      body: {
        customer: { id: customerId },
        orderDate: todayIsoDate(),
        deliveryDate: todayIsoDate(),
      },
    });
    const id = extractIdFromVarValue(primaryValue(created));
    if (hasValue(id)) {
      cacheId(vars, "order", id);
      return id;
    }
  } catch {
    // Ignore: caller will continue without injected ID.
  }
  return undefined;
}

async function enrichVarsForValidationRetry(
  client: TripletexClient,
  vars: Record<string, unknown>,
  path: string,
  fields: string[],
): Promise<void> {
  const normalizedPath = normalizePath(path);
  const roots = new Set(
    fields.map((field) => field.replace(/\[\d+]/g, "").trim().split(".")[0] ?? field).filter(Boolean),
  );

  const needsCustomer =
    roots.has("customer") ||
    roots.has("customerId") ||
    normalizedPath === "/order" ||
    normalizedPath === "/invoice" ||
    normalizedPath === "/project";
  const needsEmployee =
    roots.has("employee") ||
    roots.has("employeeId") ||
    roots.has("projectManager") ||
    roots.has("projectManagerId") ||
    normalizedPath === "/project" ||
    normalizedPath === "/travelExpense";
  const needsOrder = roots.has("order") || roots.has("orderId") || roots.has("orders") || normalizedPath === "/invoice";

  if (needsCustomer) await fetchOrCreateCustomerId(client, vars);
  if (needsEmployee) await fetchOrCreateEmployeeId(client, vars);
  if (needsOrder) await fetchOrCreateOrderId(client, vars);
}

function withValidationFieldDefaults(
  method: AllowedMethod,
  path: string,
  body: unknown,
  vars: Record<string, unknown>,
  fields: string[],
): { body: unknown; changed: boolean } {
  if (method !== "POST" && method !== "PUT") return { body, changed: false };
  const next = toRecord(body);
  let changed = false;
  const normalizedPath = normalizePath(path);
  const customerId = firstIdFromVars(vars, ["customer_id", "customerId", "customer"]);
  const employeeId = firstIdFromVars(vars, ["employee_id", "employeeId", "employee", "projectManager_id"]);
  const departmentId = firstIdFromVars(vars, ["department_id", "departmentId", "department"]);
  const projectId = firstIdFromVars(vars, ["project_id", "projectId", "project"]);
  const orderId = firstIdFromVars(vars, ["order_id", "orderId", "order"]);

  const setIfMissing = (key: string, value: unknown): void => {
    if (!hasValue(value) || hasValue(next[key])) return;
    next[key] = value;
    changed = true;
  };

  for (const rawField of fields) {
    const cleaned = rawField.replace(/\[\d+]/g, "").trim();
    const root = cleaned.split(".")[0] ?? cleaned;
    switch (root) {
      case "startDate":
      case "orderDate":
      case "invoiceDate":
      case "invoiceDueDate":
      case "deliveryDate":
      case "date":
      case "departureDate":
      case "returnDate":
        setIfMissing(root, todayIsoDate());
        break;
      case "name":
      case "description":
      case "title":
        setIfMissing(root, generatedEntityName(path));
        break;
      case "isCustomer":
        setIfMissing("isCustomer", true);
        break;
      case "customer":
        if (hasValue(customerId)) setIfMissing("customer", { id: customerId });
        break;
      case "customerId":
        setIfMissing("customerId", customerId);
        break;
      case "projectManager":
        if (hasValue(employeeId)) setIfMissing("projectManager", { id: employeeId });
        break;
      case "projectManagerId":
        setIfMissing("projectManagerId", employeeId);
        break;
      case "employee":
        if (hasValue(employeeId)) setIfMissing("employee", { id: employeeId });
        break;
      case "employeeId":
        setIfMissing("employeeId", employeeId);
        break;
      case "department":
        if (hasValue(departmentId)) setIfMissing("department", { id: departmentId });
        break;
      case "departmentId":
        setIfMissing("departmentId", departmentId);
        break;
      case "project":
        if (hasValue(projectId)) setIfMissing("project", { id: projectId });
        break;
      case "projectId":
        setIfMissing("projectId", projectId);
        break;
      case "order":
        if (hasValue(orderId)) setIfMissing("order", { id: orderId });
        break;
      case "orderId":
        setIfMissing("orderId", orderId);
        break;
      case "orders":
        if (!Array.isArray(next.orders) && hasValue(orderId)) {
          next.orders = [{ id: orderId }];
          changed = true;
        }
        break;
      default:
        break;
    }
  }

  // Keep critical defaults even when validation field names vary by language or nesting.
  if (normalizedPath === "/project") {
    setIfMissing("startDate", todayIsoDate());
  }
  if (normalizedPath === "/invoice") {
    setIfMissing("invoiceDate", todayIsoDate());
    setIfMissing("invoiceDueDate", todayIsoDate());
  }
  if (normalizedPath === "/order") {
    setIfMissing("orderDate", todayIsoDate());
  }

  return changed ? { body: next, changed } : { body, changed };
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
    const rawParams = interpolateValue(step.params ?? {}, vars);
    const params = ensurePlannerSafeQueryParams(
      step.method,
      typeof path === "string" ? path : String(path),
      toRecord(rawParams),
    );
    let body = interpolateValue(step.body, vars);
    if (typeof path !== "string") throw new SolveError("Resolved path must be a string.");
    const preflightDefaults = withPreflightBodyDefaults(step.method, path, body, vars);
    if (preflightDefaults.changed) body = preflightDefaults.body;
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
      try {
        response = await client.request(step.method, path, {
          params: (params ?? {}) as Record<string, unknown>,
          body,
        });
      } catch (error) {
        const retryFields = validationFieldsFromError(error);
        if (retryFields.length > 0) {
          await enrichVarsForValidationRetry(client, vars, path, retryFields);
        }
        const repaired = withValidationFieldDefaults(step.method, path, body, vars, retryFields);
        if (!repaired.changed || retryFields.length === 0) throw error;
        trace?.({
          event: "plan_step_retry_on_validation",
          step: count,
          method: step.method,
          path,
          retryFields,
          error: error instanceof Error ? error.message : String(error),
        });
        body = repaired.body;
        response = await client.request(step.method, path, {
          params: (params ?? {}) as Record<string, unknown>,
          body,
        });
        trace?.({
          event: "plan_step_retry_success",
          step: count,
          method: step.method,
          path,
          retryFields,
        });
      }
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
