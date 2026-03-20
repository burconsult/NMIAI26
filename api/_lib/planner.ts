import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

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
  removedFields?: string[];
};

type PlannerTrace = (event: PlannerTraceEvent) => void;

// OpenAI structured outputs require all keys to be present and avoid optional object keys.
// This schema is used only for LLM generation; we normalize null -> undefined before runtime validation.
const llmPlanStepSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string().min(1),
  params: z.object({}).passthrough().nullable(),
  body: z.object({}).passthrough().nullable(),
  saveAs: z.string().nullable(),
  extract: z.object({}).catchall(z.string()).nullable(),
  reason: z.string().nullable(),
});

const llmExecutionPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(llmPlanStepSchema).min(1).max(18),
});

type LlmExecutionPlan = z.infer<typeof llmExecutionPlanSchema>;

function normalizeLlmExecutionPlan(plan: LlmExecutionPlan): ExecutionPlan {
  return executionPlanSchema.parse({
    summary: plan.summary || "",
    steps: plan.steps.map((step) => ({
      method: step.method,
      path: step.path,
      params: step.params ?? undefined,
      body: step.body ?? undefined,
      saveAs: step.saveAs ?? undefined,
      extract: step.extract ?? undefined,
      reason: step.reason ?? undefined,
    })),
  });
}

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

function extractVersionFromVarValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (object.version !== undefined) return object.version;
  if (object.value && typeof object.value === "object" && (object.value as Record<string, unknown>).version !== undefined) {
    return (object.value as Record<string, unknown>).version;
  }
  if (Array.isArray(object.values) && object.values.length > 0) {
    const first = object.values[0];
    if (first && typeof first === "object" && (first as Record<string, unknown>).version !== undefined) {
      return (first as Record<string, unknown>).version;
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
  // Common LLM pattern: alias.values.0.id even when alias was normalized to primary value.
  if (subPath === "values.0.id" || subPath === "value.id") {
    const derived = extractIdFromVarValue(base);
    if (derived !== undefined) return derived;
  }
  // Compatibility shim: treat the base as if it were still wrapped.
  if (subPath.startsWith("value.")) {
    const wrappedResolved = dig({ value: base }, subPath);
    if (wrappedResolved !== undefined) return wrappedResolved;
  }
  if (subPath.startsWith("values.0.")) {
    const wrappedResolved = dig({ values: [base] }, subPath);
    if (wrappedResolved !== undefined) return wrappedResolved;
  }
  if (subPath === "id") {
    const derived = extractIdFromVarValue(base);
    if (derived !== undefined) return derived;
  }
  if (subPath === "version") {
    const derived = extractVersionFromVarValue(base);
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

function extractOrganizationNumber(prompt: string): string | null {
  const orgNoMatch = prompt.match(/(?:org(?:anization)?[\s.-]*(?:n(?:o|r|umber))?|organisasjonsnummer|orgnr)[\s:.-]*(\d{9})/i);
  if (orgNoMatch?.[1]) return orgNoMatch[1];
  const nineDigit = prompt.match(/\b(\d{9})\b/);
  return nineDigit?.[1] ?? null;
}

function parseFlexibleNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d,.-]/g, "").trim();
  if (!cleaned) return null;
  const commaCount = (cleaned.match(/,/g) ?? []).length;
  const dotCount = (cleaned.match(/\./g) ?? []).length;
  let normalized = cleaned;
  if (commaCount > 0 && dotCount === 0) {
    normalized = cleaned.replace(",", ".");
  } else if (commaCount > 0 && dotCount > 0) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function extractFixedPriceAmount(prompt: string): number | null {
  const fixedPriceMatch = prompt.match(
    /(?:fixed price|fastpris|precio fijo|pre[cç]o fixo|prix fixe|festpreis)[^\d-]*(-?\d[\d\s.,]*)/i,
  );
  if (!fixedPriceMatch?.[1]) return null;
  return parseFlexibleNumber(fixedPriceMatch[1]);
}

function extractPercentage(prompt: string): number | null {
  const percentMatch = prompt.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
  if (!percentMatch?.[1]) return null;
  return parseFlexibleNumber(percentMatch[1]);
}

function extractCustomerNameFromPrompt(prompt: string): string | null {
  const customerMatch = prompt.match(
    /(?:for|til|para|pour|f[üu]r)\s+([^,(.\n]+?)(?:\s*\((?:org|org\.|organization|organisasjon)[^)]+\)|[.,\n]|$)/i,
  );
  const candidate = customerMatch?.[1]?.trim();
  if (candidate && candidate.length >= 2) return candidate;
  return null;
}

function extractProjectManagerName(prompt: string): string | null {
  const managerMatch = prompt.match(/(?:project manager|prosjektleder|gerente de proyecto)\s*(?:is|er|es|:)?\s+([^,(.\n]+?)(?:\s*\(|[.,\n]|$)/i);
  const candidate = managerMatch?.[1]?.trim();
  if (candidate && candidate.length >= 2) return candidate;
  return null;
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

const ENTITY_PREREQUISITES: Record<NormalizedEntity, NormalizedEntity[]> = {
  employee: [],
  customer: [],
  department: [],
  project: ["customer", "employee"],
  invoice: ["customer", "order", "product"],
  order: ["customer", "product"],
  product: [],
  travelExpense: ["employee"],
  ledger_account: [],
  ledger_posting: ["ledger_account"],
  ledger_voucher: ["ledger_account"],
};

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

function defaultEmployeeUserType(): "STANDARD" | "EXTENDED" | "NO_ACCESS" {
  const configured = process.env.TRIPLETEX_EMPLOYEE_USER_TYPE?.trim().toUpperCase();
  if (configured === "STANDARD" || configured === "EXTENDED" || configured === "NO_ACCESS") {
    return configured;
  }
  return "STANDARD";
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

function allowedEntitiesForRequest(requestedEntities: Set<NormalizedEntity>): Set<NormalizedEntity> {
  const allowed = new Set<NormalizedEntity>();
  const stack = [...requestedEntities];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || allowed.has(current)) continue;
    allowed.add(current);
    for (const prerequisite of ENTITY_PREREQUISITES[current] ?? []) {
      if (!allowed.has(prerequisite)) stack.push(prerequisite);
    }
  }
  return allowed;
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
  const allowedEntities = allowedEntitiesForRequest(requestedEntities);
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
    if (requestedEntities.size > 0 && step.method !== "GET" && !allowedEntities.has(contract.entity)) {
      const requestedList = [...requestedEntities].join(", ");
      const allowedList = [...allowedEntities].join(", ");
      issues.push(
        `step ${stepNumber}: mutating '${contract.entity}' is outside prompt scope (requested: ${requestedList}; allowed incl. prerequisites: ${allowedList})`,
      );
    }
    // Date params for GET list calls (ledger, order, invoice) are NOT validated here
    // because the executor auto-injects them via ensurePlannerSafeQueryParams.
    // Blocking plans for missing date params wastes LLM retry attempts.
    if (step.method === "POST" || step.method === "PUT") {
      if (step.body === undefined || step.body === null || typeof step.body !== "object" || Array.isArray(step.body)) {
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

  const fixedPriceAmount = extractFixedPriceAmount(prompt);
  const milestonePercent = extractPercentage(prompt);
  const hasProjectKeywords = lower.includes("project") || lower.includes("prosjekt");
  const hasMilestoneInvoiceKeywords =
    lower.includes("invoice") || lower.includes("faktura") || lower.includes("milestone");
  if (hasProjectKeywords && hasMilestoneInvoiceKeywords && fixedPriceAmount !== null && milestonePercent !== null) {
    const projectName = quoted ?? `Generated Project ${Date.now().toString().slice(-6)}`;
    const customerName = extractCustomerNameFromPrompt(prompt) ?? `Generated Customer ${Date.now().toString().slice(-6)}`;
    const managerName = extractProjectManagerName(prompt) ?? capitalized ?? "Generated Manager";
    const manager = splitPersonName(managerName);
    const orgNo = extractOrganizationNumber(prompt);
    const milestoneAmount = Math.max(0.01, Math.round((fixedPriceAmount * (milestonePercent / 100)) * 100) / 100);
    const productName = `Milestone ${milestonePercent}% ${projectName}`.slice(0, 120);

    const customerLookupParams: Record<string, unknown> = {
      count: 1,
      fields: "id,name,organizationNumber",
    };
    if (orgNo) customerLookupParams.organizationNumber = orgNo;
    if (customerName) customerLookupParams.name = customerName;

    const employeeLookupParams: Record<string, unknown> = {
      count: 1,
      fields: "id,firstName,lastName,email",
      firstName: manager.firstName,
      lastName: manager.lastName,
    };
    if (email) employeeLookupParams.email = email;

    return {
      summary: "Heuristic fixed-price project milestone invoice flow",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: customerLookupParams,
          saveAs: "customer",
          reason: "Find customer by org number/name (or create via template hydration fallback)",
        },
        {
          method: "GET",
          path: "/employee",
          params: employeeLookupParams,
          saveAs: "employee",
          reason: "Find project manager by email/name (or create via template hydration fallback)",
        },
        {
          method: "POST",
          path: "/project",
          body: {
            name: projectName,
            startDate: todayIsoDate(),
            customer: { id: "{{customer_id}}" },
            projectManager: { id: "{{employee_id}}" },
          },
          saveAs: "project",
          reason: "Create the fixed-price project scaffold",
        },
        {
          method: "GET",
          path: "/product",
          params: { count: 1, fields: "id,name", name: productName },
          saveAs: "product",
          reason: "Find/create milestone product for billing line",
        },
        {
          method: "POST",
          path: "/order",
          body: {
            customer: { id: "{{customer_id}}" },
            orderDate: todayIsoDate(),
            deliveryDate: todayIsoDate(),
            orderLines: [
              {
                product: { id: "{{product_id}}" },
                count: 1,
                unitPriceExcludingVatCurrency: milestoneAmount,
                description: `Milestone ${milestonePercent}% of fixed price`,
              },
            ],
          },
          saveAs: "order",
          reason: "Create milestone order with explicit amount",
        },
        {
          method: "POST",
          path: "/invoice",
          body: {
            customer: { id: "{{customer_id}}" },
            invoiceDate: todayIsoDate(),
            invoiceDueDate: todayIsoDate(),
            orders: [{ id: "{{order_id}}" }],
          },
          saveAs: "invoice",
          reason: "Invoice the milestone order",
        },
      ],
    };
  }

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

  if (
    (lower.includes("customer") || lower.includes("kunde") || lower.includes("cliente")) &&
    createIntent &&
    !lower.includes("order") &&
    !lower.includes("ordre") &&
    !lower.includes("invoice") &&
    !lower.includes("faktura")
  ) {
    const customerName = quoted ?? capitalized ?? `Generated Customer ${Date.now().toString().slice(-6)}`;
    const customerBody: Record<string, unknown> = {
      name: customerName,
      isCustomer: true,
    };
    if (email) customerBody.email = email;
    if (phone) customerBody.phoneNumber = phone;
    const orgNo = extractOrganizationNumber(prompt);
    if (orgNo) customerBody.organizationNumber = orgNo;
    return {
      summary: "Heuristic customer create flow",
      steps: [
        {
          method: "POST",
          path: "/customer",
          body: customerBody,
          saveAs: "customer",
          reason: "Create customer from prompt fields",
        },
      ],
    };
  }

  if ((lower.includes("employee") || lower.includes("ansatt")) && createIntent && !lower.includes("travel expense") && !lower.includes("reise")) {
    const person = splitPersonName(quoted ?? capitalized);
    const empBody: Record<string, unknown> = {
      firstName: person.firstName,
      lastName: person.lastName,
    };
    if (email) empBody.email = email;
    const dateMatch = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch?.[1]) empBody.dateOfBirth = dateMatch[1];
    return {
      summary: "Heuristic employee create flow",
      steps: [
        {
          method: "POST",
          path: "/employee",
          body: empBody,
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

  if ((lower.includes("order") || lower.includes("ordre")) && createIntent) {
    return {
      summary: "Heuristic order create flow",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: { count: 1, fields: "id" },
          saveAs: "customer",
          reason: "Find one customer for order creation",
        },
        {
          method: "GET",
          path: "/product",
          params: { count: 1, fields: "id" },
          saveAs: "product",
          reason: "Find one product for order creation",
        },
        {
          method: "POST",
          path: "/order",
          body: {
            customer: { id: "{{customer_id}}" },
            product: { id: "{{product_id}}" },
            orderDate: todayIsoDate(),
            deliveryDate: todayIsoDate(),
          },
          saveAs: "order",
          reason: "Create order with linked customer and product",
        },
      ],
    };
  }

  if ((lower.includes("invoice") || lower.includes("faktura")) && createIntent) {
    return {
      summary: "Heuristic invoice create flow",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: { count: 1, fields: "id" },
          saveAs: "customer",
          reason: "Find one customer for invoice creation",
        },
        {
          method: "GET",
          path: "/order",
          params: {
            count: 1,
            fields: "id",
            orderDateFrom: defaultEntityDateFrom(),
            orderDateTo: defaultEntityDateTo(),
          },
          saveAs: "order",
          reason: "Find one order to invoice",
        },
        {
          method: "POST",
          path: "/invoice",
          body: {
            customer: { id: "{{customer_id}}" },
            invoiceDate: todayIsoDate(),
            invoiceDueDate: todayIsoDate(),
            orders: [{ id: "{{order_id}}" }],
          },
          saveAs: "invoice",
          reason: "Create invoice linked to customer and order",
        },
      ],
    };
  }

  if ((lower.includes("travel expense") || lower.includes("reise")) && createIntent) {
    return {
      summary: "Heuristic travel expense create flow",
      steps: [
        {
          method: "GET",
          path: "/employee",
          params: { count: 1, fields: "id" },
          saveAs: "employee",
          reason: "Find one employee for travel expense",
        },
        {
          method: "POST",
          path: "/travelExpense",
          body: {
            employee: { id: "{{employee_id}}" },
            date: todayIsoDate(),
            description: quoted ?? "Generated travel expense",
          },
          saveAs: "travelExpense",
          reason: "Create travel expense for employee",
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
    const readEntity = detectPrimaryEntity(lower);
    if (readEntity) {
      const contract = ENDPOINT_CONTRACTS.find((c) => c.entity === readEntity);
      if (contract) {
        const readParams: Record<string, unknown> = { count: 1 };
        if (contract.basePath === "/ledger/posting" || contract.basePath === "/ledger/voucher") {
          readParams.dateFrom = defaultLedgerDateFrom();
          readParams.dateTo = defaultLedgerDateTo();
        } else if (contract.basePath === "/order") {
          readParams.orderDateFrom = defaultEntityDateFrom();
          readParams.orderDateTo = defaultEntityDateTo();
        } else if (contract.basePath === "/invoice") {
          readParams.invoiceDateFrom = defaultEntityDateFrom();
          readParams.invoiceDateTo = defaultEntityDateTo();
        }
        return {
          summary: `Heuristic detected ${readEntity} read flow`,
          steps: [{ method: "GET", path: contract.basePath, params: readParams, reason: `Read ${readEntity} from detected entity` }],
        };
      }
    }
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

  const detectedEntity = detectPrimaryEntity(lower);
  if (detectedEntity && createIntent) {
    return buildGenericCreatePlan(detectedEntity, prompt, quoted, capitalized, email);
  }

  if (detectedEntity && deleteIntent) {
    const contract = ENDPOINT_CONTRACTS.find((c) => c.entity === detectedEntity);
    if (contract && contract.methods.includes("DELETE")) {
      if (numericId) {
        return {
          summary: `Heuristic ${detectedEntity} delete by id`,
          steps: [{ method: "DELETE", path: `${contract.basePath}/${numericId}` }],
        };
      }
      const listParams: Record<string, unknown> = { count: 1, fields: "id" };
      if (contract.basePath === "/ledger/voucher") {
        listParams.dateFrom = defaultLedgerDateFrom();
        listParams.dateTo = defaultLedgerDateTo();
      }
      return {
        summary: `Heuristic ${detectedEntity} fetch-and-delete`,
        steps: [
          { method: "GET", path: contract.basePath, params: listParams, saveAs: detectedEntity, reason: `Fetch ${detectedEntity} id` },
          { method: "DELETE", path: `${contract.basePath}/{{${detectedEntity}_id}}`, reason: `Delete ${detectedEntity}` },
        ],
      };
    }
  }

  if (detectedEntity) {
    return buildGenericCreatePlan(detectedEntity, prompt, quoted, capitalized, email);
  }

  return {
    summary: "Heuristic generic fallback — create customer from prompt",
    steps: [
      {
        method: "POST",
        path: "/customer",
        body: { name: quoted ?? capitalized ?? `Generated Customer ${Date.now().toString().slice(-6)}`, isCustomer: true, email: email ?? undefined },
        saveAs: "customer",
        reason: "Last-resort create when no entity could be identified",
      },
    ],
  };
}

function detectPrimaryEntity(lowerPrompt: string): NormalizedEntity | null {
  let best: { entity: NormalizedEntity; position: number } | null = null;
  for (const entry of ENTITY_KEYWORDS) {
    for (const keyword of entry.keywords) {
      if (!promptContainsKeyword(lowerPrompt, keyword.toLowerCase())) continue;
      const position = lowerPrompt.indexOf(keyword.toLowerCase());
      if (position >= 0 && (best === null || position < best.position)) {
        best = { entity: entry.entity, position };
      }
    }
  }
  return best?.entity ?? null;
}

function buildGenericCreatePlan(
  entity: NormalizedEntity,
  prompt: string,
  quoted: string | null,
  capitalized: string | null,
  email: string | null,
): ExecutionPlan {
  const contract = ENDPOINT_CONTRACTS.find((c) => c.entity === entity);
  if (!contract || !contract.methods.includes("POST")) {
    return {
      summary: `Heuristic ${entity} read fallback (POST not available)`,
      steps: [{ method: "GET", path: contract?.basePath ?? "/employee", params: { count: 1 }, reason: `Read ${entity}` }],
    };
  }

  switch (entity) {
    case "employee": {
      const person = splitPersonName(quoted ?? capitalized);
      return {
        summary: "Heuristic detected employee create",
        steps: [{ method: "POST", path: "/employee", body: { firstName: person.firstName, lastName: person.lastName, email: email ?? undefined }, saveAs: "employee" }],
      };
    }
    case "customer":
      return {
        summary: "Heuristic detected customer create",
        steps: [{ method: "POST", path: "/customer", body: { name: quoted ?? capitalized ?? generatedEntityName("/customer"), isCustomer: true, email: email ?? undefined }, saveAs: "customer" }],
      };
    case "department":
      return {
        summary: "Heuristic detected department create",
        steps: [{ method: "POST", path: "/department", body: { name: quoted ?? generatedEntityName("/department") }, saveAs: "department" }],
      };
    case "product":
      return {
        summary: "Heuristic detected product create",
        steps: [{ method: "POST", path: "/product", body: { name: quoted ?? capitalized ?? generatedEntityName("/product") }, saveAs: "product" }],
      };
    case "project":
      return {
        summary: "Heuristic detected project create",
        steps: [
          { method: "GET", path: "/employee", params: { count: 1, fields: "id" }, saveAs: "manager", reason: "Find project manager" },
          { method: "POST", path: "/project", body: { name: quoted ?? capitalized ?? generatedEntityName("/project"), startDate: todayIsoDate(), projectManager: { id: "{{manager_id}}" } }, saveAs: "project" },
        ],
      };
    case "order":
      return {
        summary: "Heuristic detected order create",
        steps: [
          { method: "GET", path: "/customer", params: { count: 1, fields: "id" }, saveAs: "customer", reason: "Find customer for order" },
          { method: "POST", path: "/order", body: { customer: { id: "{{customer_id}}" }, orderDate: todayIsoDate(), deliveryDate: todayIsoDate() }, saveAs: "order" },
        ],
      };
    case "invoice":
      return {
        summary: "Heuristic detected invoice create",
        steps: [
          { method: "GET", path: "/customer", params: { count: 1, fields: "id" }, saveAs: "customer", reason: "Find customer for invoice" },
          { method: "GET", path: "/order", params: { count: 1, fields: "id", orderDateFrom: defaultEntityDateFrom(), orderDateTo: defaultEntityDateTo() }, saveAs: "order", reason: "Find order for invoice" },
          { method: "POST", path: "/invoice", body: { customer: { id: "{{customer_id}}" }, invoiceDate: todayIsoDate(), invoiceDueDate: todayIsoDate(), orders: [{ id: "{{order_id}}" }] }, saveAs: "invoice" },
        ],
      };
    case "travelExpense":
      return {
        summary: "Heuristic detected travel expense create",
        steps: [
          { method: "GET", path: "/employee", params: { count: 1, fields: "id" }, saveAs: "employee", reason: "Find employee for travel expense" },
          { method: "POST", path: "/travelExpense", body: { employee: { id: "{{employee_id}}" }, date: todayIsoDate(), title: quoted ?? "Generated travel expense" }, saveAs: "travelExpense" },
        ],
      };
    default:
      return {
        summary: `Heuristic ${entity} generic create attempt`,
        steps: [{ method: "POST", path: contract.basePath, body: { name: quoted ?? generatedEntityName(contract.basePath) }, saveAs: entity }],
      };
  }
}

function selectPlanningModel(prompt: string, summaries: AttachmentSummary[]): string {
  const defaultOpenAIModel = "openai/gpt-5.4";
  const defaultGeminiModel = "google/gemini-3.1-pro-preview";
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
    return process.env.TRIPLETEX_MODEL_DOC_COMPLEX?.trim() || defaultOpenAIModel;
  }
  if (hasDocAttachment) {
    return process.env.TRIPLETEX_MODEL_DOC_FAST?.trim() || defaultGeminiModel;
  }
  if (complexAccountingTask) {
    return process.env.TRIPLETEX_MODEL_REASONING?.trim() || defaultOpenAIModel;
  }
  return process.env.TRIPLETEX_MODEL_DEFAULT?.trim() || defaultOpenAIModel;
}

function parseFallbackModels(primaryModel: string): string[] {
  const configured =
    process.env.TRIPLETEX_GATEWAY_FALLBACK_MODELS?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  // Keep default fallback chain short to avoid long multi-provider tail latency.
  const defaults = primaryModel.startsWith("openai/")
    ? ["google/gemini-3.1-pro-preview"]
    : ["openai/gpt-5.4"];
  return [...configured, ...defaults].filter((model, index, all) => model !== primaryModel && all.indexOf(model) === index);
}

function shouldUseDirectOpenAiFallback(): boolean {
  return process.env.TRIPLETEX_ENABLE_DIRECT_OPENAI_FALLBACK === "1" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

function llmCallTimeoutMs(): number {
  const raw = Number(process.env.TRIPLETEX_LLM_TIMEOUT_MS || "18000");
  if (!Number.isFinite(raw)) return 18000;
  return Math.min(60000, Math.max(2000, Math.round(raw)));
}

async function generatePlanObjectWithTimeout(
  options: {
    model: unknown;
    prompt: string;
    providerOptions?: unknown;
  },
  timeoutMs: number,
): Promise<LlmExecutionPlan> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new SolveError(`LLM planning timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const generated = await Promise.race([
      generateObject({
        model: options.model as never,
        schema: llmExecutionPlanSchema,
        maxRetries: 0,
        abortSignal: controller.signal,
        providerOptions: options.providerOptions as never,
        prompt: options.prompt,
      }),
      timeoutPromise,
    ]);
    return (generated as { object: LlmExecutionPlan }).object;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
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
    "You are a Tripletex API planner for the NM i AI accounting challenge.",
    "Return an execution plan object with summary and steps.",
    "Use minimal, deterministic API calls. Avoid unnecessary requests.",
    "",
    "ENDPOINT CONTRACT (only these paths and methods are allowed):",
    "- /employee: GET, POST, PUT (PUT requires /employee/{id})",
    "- /customer: GET, POST, PUT (PUT requires /customer/{id})",
    "- /product: GET, POST",
    "- /invoice: GET, POST",
    "- /order: GET, POST",
    "- /travelExpense: GET, POST, PUT, DELETE (PUT/DELETE require /travelExpense/{id})",
    "- /project: GET, POST",
    "- /department: GET, POST",
    "- /ledger/account: GET",
    "- /ledger/posting: GET",
    "- /ledger/voucher: GET, POST, DELETE (DELETE requires /ledger/voucher/{id})",
    "",
    "REQUIRED QUERY PARAMS FOR LIST CALLS:",
    "- GET /ledger/posting: dateFrom, dateTo (YYYY-MM-DD)",
    "- GET /ledger/voucher: dateFrom, dateTo (YYYY-MM-DD)",
    "- GET /order: orderDateFrom, orderDateTo (YYYY-MM-DD)",
    "- GET /invoice: invoiceDateFrom, invoiceDateTo (YYYY-MM-DD)",
    "- All list GETs: include count (usually 1) and from (usually 0)",
    "",
    "REQUIRED BODY FIELDS FOR POST (use ONLY these field names):",
    "- POST /employee: { firstName, lastName } — optional: email, dateOfBirth",
    "- POST /customer: { name, isCustomer: true } — optional: email, phoneNumber, organizationNumber",
    "- POST /product: { name } — optional: number, costExcludingVatCurrency, priceExcludingVatCurrency",
    "- POST /department: { name } — optional: departmentNumber",
    "- POST /project: { name, startDate (YYYY-MM-DD), projectManager: { id } } — get a manager first via GET /employee",
    "- POST /order: { customer: { id }, orderDate (YYYY-MM-DD), deliveryDate (YYYY-MM-DD) } — optional: orderLines: [{ product: { id }, count }]",
    "- POST /invoice: { customer: { id }, invoiceDate (YYYY-MM-DD), invoiceDueDate (YYYY-MM-DD), orders: [{ id }] } — create order first if needed",
    "- POST /travelExpense: { employee: { id }, date (YYYY-MM-DD) } — optional: title, description",
    "- POST /ledger/voucher: { date (YYYY-MM-DD), description } — optional: postings: [{ amount, account: { id } }]",
    "",
    "REQUIRED BODY FIELDS FOR PUT (include id in path AND body):",
    "- PUT /employee/{id}: { id, version, firstName, lastName } — fetch first with GET to get id+version",
    "- PUT /customer/{id}: { id, version, name } — fetch first with GET to get id+version",
    "- PUT /travelExpense/{id}: { id, version } — fetch first with GET to get id+version",
    "",
    "CRITICAL RULES:",
    "- EXTRACT EXACT VALUES from the task prompt. If the prompt says 'Create customer Nordmann AS with email info@nordmann.no',",
    "  use name='Nordmann AS' and email='info@nordmann.no' — do NOT use placeholder or generic values.",
    "- If the prompt mentions a name, email, phone, date, amount, or any specific value, use it EXACTLY as written.",
    "- For employees: split the full name into firstName and lastName. 'Ola Nordmann' → firstName='Ola', lastName='Nordmann'.",
    "- Do NOT invent fields. Only use field names listed above.",
    "- Do NOT include sendType, sendTypeEmail, or any undocumented fields.",
    "- For PUT requests: always GET the entity first to obtain its current id and version number.",
    "- Use saveAs on any step whose result you need later. Reference with {{alias_id}} or {{alias.field}}.",
    "- If the prompt is read-only (list/show/find/get), use GET only.",
    "- Responses wrap as { value: {...} } or { values: [...] }.",
    "- Use relative paths only (e.g. /employee, not https://...).",
    "- Do not include auth details.",
    "",
    "MULTI-LANGUAGE: Prompts may be in Norwegian (nb/nn), English, Spanish, Portuguese, German, or French.",
    "Common Norwegian terms: opprett=create, slett=delete, ansatt=employee, kunde=customer, avdeling=department,",
    "prosjekt=project, faktura=invoice, ordre=order, produkt=product, reiseregning=travel expense, bilag=voucher.",
    "",
    `Task prompt:\n${payload.prompt}`,
    "",
    `Attachments:\n${attachmentsText}`,
    "",
    previousError ? `Previous execution error (fix this issue):\n${previousError}` : "",
  ].filter(Boolean).join("\n");
}

export async function llmPlan(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
  previousError?: string,
  trace?: PlannerTrace,
): Promise<ExecutionPlan> {
  const modelName = selectPlanningModel(payload.prompt, summaries);
  const fallbackModels = parseFallbackModels(modelName);
  const timeoutMs = llmCallTimeoutMs();
  trace?.({
    event: "llm_plan_start",
    model: modelName,
    fallbackModels,
  });
  try {
    const rawObject = await generatePlanObjectWithTimeout(
      {
        model: gateway(modelName),
        providerOptions: {
          gateway: {
            models: fallbackModels,
          } satisfies GatewayLanguageModelOptions,
        },
        prompt: buildPlanningPrompt(payload, summaries, previousError),
      },
      timeoutMs,
    );
    const object = normalizeLlmExecutionPlan(rawObject);
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
    const directModel = process.env.TRIPLETEX_DIRECT_OPENAI_MODEL?.trim() || "gpt-5.4";
    trace?.({
      event: "llm_plan_direct_openai_fallback",
      model: modelName,
      directModel,
    });
    const rawObject = await generatePlanObjectWithTimeout(
      {
        model: openai(directModel),
        prompt: buildPlanningPrompt(payload, summaries, `Gateway failed: ${String(error)}\n${previousError || ""}`.trim()),
      },
      timeoutMs,
    );
    const object = normalizeLlmExecutionPlan(rawObject);
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
    if (key.endsWith("_lookup_path") || key.endsWith("_lookup_params")) continue;
    const matchesWanted = wanted.some(
      (needle) =>
        canonicalKey === needle ||
        canonicalKey === `${needle}id` ||
        canonicalKey === `${needle}value`,
    );
    if (!matchesWanted) continue;
    if (typeof value === "string" || typeof value === "number") return value;
    const extracted = extractIdFromVarValue(value);
    if (extracted !== undefined) return extracted;
  }
  return undefined;
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function generatedUniqueEmail(): string {
  const suffix = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
  return `generated.${suffix}@example.org`;
}

function firstNumberFromVars(vars: Record<string, unknown>, candidates: string[]): number | undefined {
  for (const candidate of candidates) {
    const direct = resolveVar(vars, candidate);
    if (typeof direct === "number" && Number.isFinite(direct)) return direct;
    if (typeof direct === "string") {
      const parsed = parseFlexibleNumber(direct);
      if (parsed !== null) return parsed;
    }
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

  if (method === "PUT") {
    const idMatch = path.match(/\/(\d+)\s*$/);
    if (idMatch?.[1] && !hasValue(next.id)) {
      next.id = Number(idMatch[1]);
      changed = true;
    }
    if (!hasValue(next.version)) {
      const entityAlias = normalizedPath.replace(/^\//, "").replace(/\/.*/, "");
      const canonicalEntityAlias = canonicalVarName(entityAlias);
      let saved: unknown = vars[entityAlias];
      if (!(saved && typeof saved === "object")) {
        for (const [key, value] of Object.entries(vars)) {
          if (key.endsWith("_lookup_path") || key.endsWith("_lookup_params")) continue;
          if (!value || typeof value !== "object") continue;
          if (canonicalVarName(key).includes(canonicalEntityAlias)) {
            saved = value;
            break;
          }
        }
      }
      if (saved && typeof saved === "object") {
        const savedVersion = extractVersionFromVarValue(saved);
        const savedId = extractIdFromVarValue(saved);
        if (hasValue(savedVersion)) {
          next.version = savedVersion;
          changed = true;
        }
        if (!hasValue(next.id) && hasValue(savedId)) {
          next.id = savedId;
          changed = true;
        }
      }
    }
  }

  const customerId = firstIdFromVars(vars, ["customer_id", "customerId", "customer"]);
  const employeeId = firstIdFromVars(vars, ["employee_id", "employeeId", "employee", "projectManager_id"]);
  const orderId = firstIdFromVars(vars, ["order_id", "orderId", "order"]);
  const departmentId = firstIdFromVars(vars, ["department_id", "departmentId", "department"]);
  const productId = firstIdFromVars(vars, ["product_id", "productId", "product"]);
  const amountHint = firstNumberFromVars(vars, ["milestone_amount", "invoice_amount", "amount"]);

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
    if ((!Array.isArray(next.orderLines) || next.orderLines.length === 0) && hasValue(productId)) {
      next.orderLines = [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: amountHint ?? 1,
        },
      ];
      changed = true;
    }
  } else if (normalizedPath === "/invoice") {
    setIfMissing("invoiceDate", todayIsoDate());
    setIfMissing("invoiceDueDate", todayIsoDate());
    if (!hasValue(next.customer) && hasValue(customerId)) {
      next.customer = { id: customerId };
      changed = true;
    }
    if ((!Array.isArray(next.orders) || next.orders.length === 0) && hasValue(orderId)) {
      next.orders = [{ id: orderId }];
      changed = true;
    }
  } else if (normalizedPath === "/travelExpense") {
    setIfMissing("date", todayIsoDate());
    if (!hasValue(next.employee) && hasValue(employeeId)) {
      next.employee = { id: employeeId };
      changed = true;
    }
  } else if (normalizedPath === "/employee") {
    if (method === "POST") {
      setIfMissing("firstName", "Generated");
      setIfMissing("lastName", `Employee${Date.now().toString().slice(-6)}`);
    }
    setIfMissing("userType", defaultEmployeeUserType());
    if (!hasValue(next.department) && hasValue(departmentId)) {
      next.department = { id: departmentId };
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
    if (message.includes("brukertype") || message.includes("user type") || message.includes("usertype")) {
      fields.push("userType");
    }
    if (message.includes("avdeling") || message.includes("department")) {
      fields.push("department");
    }
  }
  return [...new Set(fields)];
}

function unknownMappingFieldsFromError(error: unknown): string[] {
  if (!(error instanceof TripletexError)) return [];
  if (error.statusCode !== 422) return [];
  const body = error.responseBody as Record<string, unknown> | undefined;
  const validationMessages = Array.isArray(body?.validationMessages) ? body.validationMessages : [];
  const fields: string[] = [];
  for (const item of validationMessages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const code = String(row.code ?? row.errorCode ?? "").trim();
    const messageRaw = typeof row.message === "string" ? row.message : "";
    const message = messageRaw.toLowerCase();
    const field = typeof row.field === "string" ? row.field.trim() : "";
    const mappingError =
      code === "16000" ||
      message.includes("cannot map") ||
      message.includes("can not map") ||
      message.includes("kan ikke mappe") ||
      message.includes("unknown field") ||
      message.includes("ukjent felt") ||
      message.includes("does not exist") ||
      message.includes("eksisterer ikke") ||
      message.includes("finnes ikke");
    if (!mappingError) continue;
    if (field) fields.push(field);
    const quotedMatches = [...messageRaw.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9_.[\]]{1,80})['"`]/g)];
    for (const match of quotedMatches) {
      const token = match[1]?.trim();
      if (token) fields.push(token);
    }
    const namedMatches = [
      messageRaw.match(/\bfield\s+([a-zA-Z][a-zA-Z0-9_.[\]]{1,80})/i),
      messageRaw.match(/\bfelt\s+([a-zA-Z][a-zA-Z0-9_.[\]]{1,80})/i),
      messageRaw.match(/\bparameter\s+([a-zA-Z][a-zA-Z0-9_.[\]]{1,80})/i),
      messageRaw.match(/\bproperty\s+([a-zA-Z][a-zA-Z0-9_.[\]]{1,80})/i),
    ];
    for (const match of namedMatches) {
      const token = match?.[1]?.trim();
      if (token) fields.push(token);
    }
  }
  return [...new Set(fields)];
}

function cloneForPatch<T>(value: T): T {
  if (value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function fieldPathToSegments(path: string): Array<string | number> {
  return path
    .replace(/\[(\d+)]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function deletePath(target: unknown, segments: Array<string | number>): boolean {
  if (segments.length === 0 || !target || typeof target !== "object") return false;
  const [head, ...tail] = segments;
  if (tail.length === 0) {
    if (Array.isArray(target) && typeof head === "number" && head >= 0 && head < target.length) {
      target.splice(head, 1);
      return true;
    }
    if (!Array.isArray(target) && typeof head === "string" && Object.prototype.hasOwnProperty.call(target, head)) {
      delete (target as Record<string, unknown>)[head];
      return true;
    }
    return false;
  }

  if (Array.isArray(target)) {
    if (typeof head !== "number" || head < 0 || head >= target.length) return false;
    return deletePath(target[head], tail);
  }
  if (typeof head !== "string") return false;
  return deletePath((target as Record<string, unknown>)[head], tail);
}

function withUnknownFieldRemovals(
  method: AllowedMethod,
  body: unknown,
  rawFields: string[],
): { body: unknown; changed: boolean; removedFields: string[] } {
  if (method !== "POST" && method !== "PUT") return { body, changed: false, removedFields: [] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changed: false, removedFields: [] };
  const fieldCandidates = [...new Set(rawFields.map((field) => field.trim()).filter(Boolean))];
  if (fieldCandidates.length === 0) return { body, changed: false, removedFields: [] };

  const next = cloneForPatch(body) as Record<string, unknown>;
  const removedFields: string[] = [];
  let changed = false;

  for (const field of fieldCandidates) {
    const cleaned = field.replace(/\s+/g, "");
    const removedByPath = deletePath(next, fieldPathToSegments(cleaned));
    if (removedByPath) {
      changed = true;
      removedFields.push(field);
      continue;
    }
    const root = cleaned.replace(/\[(\d+)]/g, ".$1").split(".")[0] ?? cleaned;
    if (root && Object.prototype.hasOwnProperty.call(next, root)) {
      delete next[root];
      changed = true;
      removedFields.push(root);
    }
  }

  return changed ? { body: next, changed: true, removedFields: [...new Set(removedFields)] } : { body, changed: false, removedFields: [] };
}

function missingTemplateVarFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/Template variable '([^']+)' not found/);
  const value = match?.[1]?.trim();
  return value || null;
}

function aliasRootFromTemplateVar(templateVar: string): string {
  const withoutPrefix = templateVar.startsWith("vars.") ? templateVar.slice(5) : templateVar;
  const root = withoutPrefix.split(".")[0] ?? withoutPrefix;
  if (/^(.+)_id$/i.test(root)) return root.replace(/^(.+)_id$/i, "$1");
  if (/^(.+)Id$/.test(root)) return root.replace(/^(.+)Id$/, "$1");
  return root;
}

function aliasLookupParams(vars: Record<string, unknown>, alias: string): Record<string, unknown> {
  return toRecord(vars[`${alias}_lookup_params`]);
}

function buildListParams(path: string, params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  if (next.count === undefined || next.count === null || String(next.count).trim() === "") next.count = 1;
  if (next.from === undefined || next.from === null || String(next.from).trim() === "") next.from = 0;
  if (next.fields === undefined || next.fields === null || String(next.fields).trim() === "") next.fields = "id";
  return ensurePlannerSafeQueryParams("GET", path, next);
}

async function fetchOrCreateProductId(
  client: TripletexClient,
  vars: Record<string, unknown>,
  allowCreate: boolean,
): Promise<unknown> {
  const existing = cachedId(vars, "product");
  if (hasValue(existing)) return existing;
  const lookup = aliasLookupParams(vars, "product");
  try {
    const fetched = await client.request("GET", "/product", {
      params: buildListParams("/product", lookup),
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "product", id);
      return id;
    }
  } catch {
    // Ignore and continue.
  }
  if (!allowCreate) return undefined;
  const nameHint = typeof lookup.name === "string" && lookup.name.trim().length > 0 ? lookup.name.trim() : undefined;
  try {
    const created = await client.request("POST", "/product", {
      body: {
        name: nameHint || generatedEntityName("/product"),
      },
    });
    const id = extractIdFromVarValue(primaryValue(created));
    if (hasValue(id)) {
      cacheId(vars, "product", id);
      return id;
    }
  } catch {
    // Ignore: caller will keep original failure.
  }
  return undefined;
}

async function fetchOrCreateDepartmentId(
  client: TripletexClient,
  vars: Record<string, unknown>,
  allowCreate: boolean,
): Promise<unknown> {
  const existing = cachedId(vars, "department");
  if (hasValue(existing)) return existing;
  const lookup = aliasLookupParams(vars, "department");
  try {
    const fetched = await client.request("GET", "/department", {
      params: buildListParams("/department", lookup),
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "department", id);
      return id;
    }
  } catch {
    // Ignore and continue.
  }
  if (!allowCreate) return undefined;
  try {
    const created = await client.request("POST", "/department", {
      body: {
        name: generatedEntityName("/department"),
      },
    });
    const id = extractIdFromVarValue(primaryValue(created));
    if (hasValue(id)) {
      cacheId(vars, "department", id);
      return id;
    }
  } catch {
    // Ignore and continue.
  }
  return undefined;
}

async function ensureTemplateVariable(
  client: TripletexClient,
  vars: Record<string, unknown>,
  templateVar: string,
  currentMethod: AllowedMethod,
): Promise<boolean> {
  if (resolveVar(vars, templateVar) !== undefined) return true;
  const alias = aliasRootFromTemplateVar(templateVar);
  const allowCreate = currentMethod === "POST";

  if (alias === "customer") {
    await fetchOrCreateCustomerId(client, vars);
  } else if (alias === "employee") {
    await fetchOrCreateEmployeeId(client, vars);
  } else if (alias === "order") {
    await fetchOrCreateOrderId(client, vars);
  } else if (alias === "product") {
    await fetchOrCreateProductId(client, vars, allowCreate);
  } else if (alias === "project") {
    if (allowCreate) {
      const managerId = await fetchOrCreateEmployeeId(client, vars);
      try {
        const created = await client.request("POST", "/project", {
          body: {
            name: generatedEntityName("/project"),
            startDate: todayIsoDate(),
            ...(hasValue(managerId) ? { projectManager: { id: managerId } } : {}),
          },
        });
        const id = extractIdFromVarValue(primaryValue(created));
        if (hasValue(id)) cacheId(vars, "project", id);
      } catch {
        // Ignore.
      }
    }
  } else if (alias === "department") {
    await fetchOrCreateDepartmentId(client, vars, allowCreate);
  }

  return resolveVar(vars, templateVar) !== undefined;
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
  const lookup = aliasLookupParams(vars, "customer");
  try {
    const fetched = await client.request("GET", "/customer", {
      params: buildListParams("/customer", lookup),
    });
    const id = extractIdFromVarValue(primaryValue(fetched));
    if (hasValue(id)) {
      cacheId(vars, "customer", id);
      return id;
    }
  } catch {
    // Ignore and try create fallback.
  }
  const nameHint = firstNonEmptyString(lookup.name, lookup.customerName);
  const orgNoHint = firstNonEmptyString(lookup.organizationNumber, lookup.orgNumber, lookup.orgnr);
  const emailHint = firstNonEmptyString(lookup.email);
  try {
    const createBody: Record<string, unknown> = {
      name: nameHint || generatedEntityName("/customer"),
      isCustomer: true,
    };
    if (emailHint) createBody.email = emailHint;
    if (orgNoHint) createBody.organizationNumber = orgNoHint;
    const created = await client.request("POST", "/customer", {
      body: createBody,
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
  preferCreate = false,
): Promise<unknown> {
  const existing = cachedId(vars, "employee");
  if (hasValue(existing) && !preferCreate) return existing;
  const lookup = aliasLookupParams(vars, "employee");
  if (!preferCreate) {
    try {
      const fetched = await client.request("GET", "/employee", {
        params: buildListParams("/employee", lookup),
      });
      const id = extractIdFromVarValue(primaryValue(fetched));
      if (hasValue(id)) {
        cacheId(vars, "employee", id);
        return id;
      }
    } catch {
      // Ignore and try create fallback.
    }
  }
  // For project-manager and repair flows, prefer reusing an existing employee over creating
  // a new one that may be invalid for project assignment in this tenant.
  try {
    const broad = await client.request("GET", "/employee", {
      params: buildListParams("/employee", { fields: "id", count: 1 }),
    });
    const broadId = extractIdFromVarValue(primaryValue(broad));
    if (hasValue(broadId)) {
      cacheId(vars, "employee", broadId);
      return broadId;
    }
  } catch {
    // Ignore and continue with create fallback.
  }
  const departmentId = await fetchOrCreateDepartmentId(client, vars, true);
  const firstNameHint = firstNonEmptyString(lookup.firstName);
  const lastNameHint = firstNonEmptyString(lookup.lastName);
  const emailHint = firstNonEmptyString(lookup.email);
  const fallbackPerson = splitPersonName(firstNonEmptyString(lookup.name, lookup.fullName, lookup.employeeName) ?? null);
  const fallbackEmail = generatedUniqueEmail();
  const emailCandidates = preferCreate
    ? [emailHint, fallbackEmail].filter(
        (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
      )
    : emailHint
      ? [emailHint, fallbackEmail]
      : [];
  const candidateSet = emailCandidates.length > 0 ? emailCandidates : [undefined];
  for (const candidateEmail of candidateSet) {
    try {
      const createBody: Record<string, unknown> = {
        firstName: firstNameHint || fallbackPerson.firstName,
        lastName: lastNameHint || fallbackPerson.lastName,
        userType: defaultEmployeeUserType(),
      };
      if (candidateEmail) createBody.email = candidateEmail;
      if (hasValue(departmentId)) {
        createBody.department = { id: departmentId };
      }
      const created = await client.request("POST", "/employee", {
        body: createBody,
      });
      const id = extractIdFromVarValue(primaryValue(created));
      if (hasValue(id)) {
        cacheId(vars, "employee", id);
        return id;
      }
    } catch {
      // Try next candidate email (if any).
    }
  }
  return undefined;
}

async function fetchOrCreateOrderId(
  client: TripletexClient,
  vars: Record<string, unknown>,
): Promise<unknown> {
  const existing = cachedId(vars, "order");
  if (hasValue(existing)) return existing;
  const lookup = aliasLookupParams(vars, "order");
  try {
    const fetched = await client.request("GET", "/order", {
      params: buildListParams("/order", lookup),
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
  const productId = await fetchOrCreateProductId(client, vars, true);
  const amountHint = firstNumberFromVars(vars, ["milestone_amount", "invoice_amount", "amount"]);
  try {
    const createBody: Record<string, unknown> = {
      customer: { id: customerId },
      orderDate: todayIsoDate(),
      deliveryDate: todayIsoDate(),
    };
    if (hasValue(productId)) {
      createBody.orderLines = [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: amountHint ?? 1,
        },
      ];
    }
    const created = await client.request("POST", "/order", {
      body: createBody,
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
  const needsFreshProjectManager =
    normalizedPath === "/project" && (roots.has("projectManager") || roots.has("projectManagerId"));
  const needsOrder = roots.has("order") || roots.has("orderId") || roots.has("orders") || normalizedPath === "/invoice";
  const needsProduct =
    roots.has("product") ||
    roots.has("productId") ||
    roots.has("orderLines") ||
    normalizedPath === "/order";
  const needsDepartment =
    roots.has("department") ||
    roots.has("departmentId") ||
    roots.has("userType") ||
    normalizedPath === "/employee";

  if (needsCustomer) await fetchOrCreateCustomerId(client, vars);
  if (needsEmployee) await fetchOrCreateEmployeeId(client, vars, needsFreshProjectManager);
  if (needsOrder) await fetchOrCreateOrderId(client, vars);
  if (needsProduct) await fetchOrCreateProductId(client, vars, true);
  if (needsDepartment) await fetchOrCreateDepartmentId(client, vars, true);
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
  const productId = firstIdFromVars(vars, ["product_id", "productId", "product"]);
  const amountHint = firstNumberFromVars(vars, ["milestone_amount", "invoice_amount", "amount"]);
  const employeeLookup = aliasLookupParams(vars, "employee");
  const generatedEmail = `generated.${Date.now().toString().slice(-6)}@example.org`;
  const defaultEmployeeEmail = firstNonEmptyString(employeeLookup.email, employeeLookup.mail, employeeLookup.ePost) ?? generatedEmail;

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
      case "email":
        if (normalizedPath === "/employee") {
          setIfMissing("email", defaultEmployeeEmail);
        }
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
      case "userType":
        setIfMissing("userType", defaultEmployeeUserType());
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
        if ((!Array.isArray(next.orders) || next.orders.length === 0) && hasValue(orderId)) {
          next.orders = [{ id: orderId }];
          changed = true;
        }
        break;
      case "orderLines":
        if ((!Array.isArray(next.orderLines) || next.orderLines.length === 0) && hasValue(productId)) {
          next.orderLines = [
            {
              product: { id: productId },
              count: 1,
              unitPriceExcludingVatCurrency: amountHint ?? 1,
            },
          ];
          changed = true;
        }
        break;
      default:
        break;
    }
  }

  // Keep critical defaults even when validation field names vary by language or nesting.
  const projectManagerRequested = fields.some((field) => {
    const cleaned = field.replace(/\[\d+]/g, "").trim();
    return cleaned === "projectManager" || cleaned.startsWith("projectManager.");
  });
  if (normalizedPath === "/project" && projectManagerRequested && hasValue(employeeId)) {
    const currentProjectManager = toRecord(next.projectManager);
    if (!hasValue(currentProjectManager.id) || String(currentProjectManager.id) !== String(employeeId)) {
      next.projectManager = { id: employeeId };
      changed = true;
    }
  }
  if (normalizedPath === "/project") {
    setIfMissing("startDate", todayIsoDate());
  }
  if (normalizedPath === "/invoice") {
    setIfMissing("invoiceDate", todayIsoDate());
    setIfMissing("invoiceDueDate", todayIsoDate());
  }
  if (normalizedPath === "/order") {
    setIfMissing("orderDate", todayIsoDate());
    setIfMissing("deliveryDate", todayIsoDate());
    if ((!Array.isArray(next.orderLines) || next.orderLines.length === 0) && hasValue(productId)) {
      next.orderLines = [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: amountHint ?? 1,
        },
      ];
      changed = true;
    }
  }
  if (normalizedPath === "/employee") {
    setIfMissing("userType", defaultEmployeeUserType());
    setIfMissing("email", defaultEmployeeEmail);
    if (hasValue(departmentId)) setIfMissing("department", { id: departmentId });
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
  let successCount = 0;
  const failedSteps: Array<{ step: number; method: AllowedMethod; path: string; error: string }> = [];

  for (const rawStep of plan.steps) {
    const step = rawStep as PlanStep;
    count += 1;
    try {
      let path: unknown;
      let rawParams: unknown;
      let body: unknown;
      let repairedTemplateRounds = 0;
      while (true) {
        try {
          path = interpolateValue(step.path, vars);
          rawParams = interpolateValue(step.params ?? {}, vars);
          body = interpolateValue(step.body, vars);
          break;
        } catch (error) {
          const missing = missingTemplateVarFromError(error);
          if (missing === null) throw error;
          if (repairedTemplateRounds >= 6) throw error;
          const repaired = await ensureTemplateVariable(client, vars, missing, step.method);
          if (!repaired) throw error;
          repairedTemplateRounds += 1;
        }
      }
      const params = ensurePlannerSafeQueryParams(
        step.method,
        typeof path === "string" ? path : String(path),
        toRecord(rawParams),
      );
      if (typeof path !== "string") throw new SolveError("Resolved path must be a string.");
      if (!dryRun && step.method === "POST" && normalizePath(path) === "/order") {
        const orderDraft = toRecord(body);
        if (!Array.isArray(orderDraft.orderLines) || orderDraft.orderLines.length === 0) {
          await fetchOrCreateProductId(client, vars, true);
        }
      }
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
        const maxValidationRetries = Math.max(0, Number(process.env.TRIPLETEX_VALIDATION_RETRIES || "3"));
        let validationRetryRounds = 0;
        let latestRetryFields: string[] = [];
        let latestRemovedFields: string[] = [];
        while (true) {
          try {
            response = await client.request(step.method, path, {
              params: (params ?? {}) as Record<string, unknown>,
              body,
            });
            if (validationRetryRounds > 0) {
              trace?.({
                event: "plan_step_retry_success",
                step: count,
                method: step.method,
                path,
                retryFields: latestRetryFields,
                removedFields: latestRemovedFields,
              });
            }
            break;
          } catch (error) {
            const retryFields = validationFieldsFromError(error);
            let forcedRetry = false;
            if (retryFields.length === 0) {
              const normalizedPath = normalizePath(path);
              if (step.method === "POST" && normalizedPath === "/invoice") {
                retryFields.push("orders", "customer", "invoiceDate", "invoiceDueDate");
                forcedRetry = true;
              } else if (step.method === "POST" && normalizedPath === "/employee") {
                retryFields.push("email", "department", "userType");
                forcedRetry = true;
              }
            }
            const mappingFields = unknownMappingFieldsFromError(error);
            if (retryFields.length > 0) {
              await enrichVarsForValidationRetry(client, vars, path, retryFields);
            }
            const sanitized = withUnknownFieldRemovals(step.method, body, mappingFields);
            const repaired = withValidationFieldDefaults(step.method, path, sanitized.body, vars, retryFields);
            const shouldRetry = forcedRetry || sanitized.changed || repaired.changed;
            if (!shouldRetry || (retryFields.length === 0 && mappingFields.length === 0)) throw error;
            if (validationRetryRounds >= maxValidationRetries) throw error;
            validationRetryRounds += 1;
            latestRetryFields = retryFields;
            latestRemovedFields = sanitized.removedFields;
            trace?.({
              event: "plan_step_retry_on_validation",
              step: count,
              method: step.method,
              path,
              retryFields,
              removedFields: sanitized.removedFields,
              error: error instanceof Error ? error.message : String(error),
            });
            body = repaired.body;
          }
        }
      }
      trace?.({
        event: "plan_step_end",
        step: count,
        method: step.method,
        path,
        responseShape: summarizeResponseShape(response),
      });
      successCount += 1;

      const primary = primaryValue(response);
      if (step.saveAs) {
        vars[step.saveAs] = primary;
        if (step.method === "GET") {
          vars[`${step.saveAs}_lookup_path`] = path;
          vars[`${step.saveAs}_lookup_params`] = { ...(params ?? {}) };
        }
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
    } catch (stepError) {
      failedSteps.push({
        step: count,
        method: step.method,
        path: String(step.path),
        error: stepError instanceof Error ? stepError.message : String(stepError),
      });
      trace?.({
        event: "plan_step_end",
        step: count,
        method: step.method,
        path: step.path,
        error: stepError instanceof Error ? stepError.message : String(stepError),
      });
    }
  }

  if (failedSteps.length > 0) {
    const mutatingFailures = failedSteps.filter((item) => item.method !== "GET");
    if (mutatingFailures.length > 0) {
      const summary = mutatingFailures
        .slice(0, 3)
        .map((item) => `step ${item.step} ${item.method} ${item.path}: ${item.error}`)
        .join(" | ");
      throw new SolveError(`Plan execution failed on mutating steps: ${summary}`);
    }
    if (successCount === 0) {
      const summary = failedSteps
        .slice(0, 3)
        .map((item) => `step ${item.step} ${item.method} ${item.path}: ${item.error}`)
        .join(" | ");
      throw new SolveError(`Plan execution failed: ${summary}`);
    }
  }
  return count;
}
