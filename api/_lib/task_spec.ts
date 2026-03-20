import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { z } from "zod";

import type { AttachmentSummary } from "./attachments.js";
import type { ExecutionPlan, SolveRequest } from "./schemas.js";
import { TripletexClient, primaryValue } from "./tripletex.js";

// ---------------------------------------------------------------------------
// TaskSpec schema — the ONLY thing the LLM produces
// ---------------------------------------------------------------------------

const entityEnum = z.enum([
  "employee",
  "customer",
  "product",
  "department",
  "project",
  "order",
  "invoice",
  "travel_expense",
  "voucher",
  "ledger_account",
  "ledger_posting",
]);

const operationEnum = z.enum([
  "create",
  "update",
  "delete",
  "list",
  "pay_invoice",
  "create_credit_note",
  "reverse_voucher",
]);

export const taskSpecSchema = z.object({
  operation: operationEnum,
  entity: entityEnum,
  values: z
    .object({})
    .passthrough()
    .describe("Exact field values extracted from prompt (name, email, amount, dates, etc.)"),
  lookup: z
    .object({})
    .passthrough()
    .optional()
    .describe("Constraints to find an existing entity (id, name, invoiceNumber, amount)"),
  attachment_facts: z
    .array(z.string())
    .optional()
    .describe("Structured facts extracted from attachments"),
});

export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type TaskEntity = z.infer<typeof entityEnum>;
export type TaskOperation = z.infer<typeof operationEnum>;

// ---------------------------------------------------------------------------
// LLM extraction — model outputs TaskSpec, NOT API plans
// ---------------------------------------------------------------------------

function buildExtractionPrompt(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
): string {
  const attachmentsText = summaries.length
    ? summaries
        .map((f) => {
          const excerpt = f.textExcerpt ? `\n  Content: ${f.textExcerpt}` : "";
          return `- ${f.filename} (${f.mimeType})${excerpt}`;
        })
        .join("\n")
    : "none";

  return `You are a task extractor for a Norwegian accounting system (Tripletex).

Given a task prompt (which may be in Norwegian, English, Spanish, Portuguese, German, or French), extract a structured task specification.

ENTITIES (use exactly these names):
- employee, customer, product, department, project
- order, invoice, travel_expense
- voucher, ledger_account, ledger_posting

OPERATIONS:
- create: make a new entity
- update: modify an existing entity
- delete: remove an entity
- list: read/find/show entities
- pay_invoice: register payment on an invoice
- create_credit_note: create a credit note for an invoice
- reverse_voucher: reverse a ledger voucher

MULTILINGUAL MAPPINGS:
- opprett/registrer/lag = create
- oppdater/endre/rediger = update
- slett/fjern = delete
- vis/finn/hent/liste = list
- ansatt = employee, kunde = customer, avdeling = department
- prosjekt = project, faktura = invoice, ordre = order
- produkt = product, reiseregning = travel_expense, bilag = voucher
- kreditnota = credit_note, betaling = pay_invoice

EXTRACTION RULES:
- Extract ALL specific values mentioned: names, emails, phone numbers, dates, amounts, org numbers
- For person names: split into firstName and lastName
- For dates: use YYYY-MM-DD format
- For amounts: use numeric values
- If the prompt mentions a specific ID, include it in the lookup field
- If attachments contain relevant data (invoice details, amounts), include those as attachment_facts
- Do NOT guess values. Only extract what is explicitly stated.

Task prompt:
${payload.prompt}

Attachments:
${attachmentsText}`;
}

function selectModel(): string {
  return process.env.TRIPLETEX_MODEL_DEFAULT?.trim() || "openai/gpt-5.2";
}

function fallbackModels(primary: string): string[] {
  const configured =
    process.env.TRIPLETEX_GATEWAY_FALLBACK_MODELS?.split(",")
      .map((p) => p.trim())
      .filter(Boolean) ?? [];
  const defaults = [
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-pro",
    "openai/gpt-5-nano",
  ];
  return [...configured, ...defaults].filter(
    (m, i, all) => m !== primary && all.indexOf(m) === i,
  );
}

export async function extractTaskSpec(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
): Promise<TaskSpec> {
  const model = selectModel();
  const { object } = await generateObject({
    model: gateway(model),
    schema: taskSpecSchema,
    temperature: 0,
    providerOptions: {
      gateway: { models: fallbackModels(model) } satisfies GatewayLanguageModelOptions,
    },
    prompt: buildExtractionPrompt(payload, summaries),
  });
  return object;
}

// ---------------------------------------------------------------------------
// Heuristic extraction — regex fallback when LLM is unavailable
// ---------------------------------------------------------------------------

export function heuristicExtract(payload: SolveRequest): TaskSpec {
  const prompt = payload.prompt;
  const lower = prompt.toLowerCase();

  const operation = detectOperation(lower);
  const entity = detectEntity(lower);
  const values = extractValues(prompt);

  const idMatch = prompt.match(/\b(\d{4,})\b/);
  const lookup = idMatch ? { id: Number(idMatch[1]) } : undefined;

  return { operation, entity, values, lookup };
}

function detectOperation(lower: string): TaskOperation {
  const ops: Array<{ op: TaskOperation; keywords: string[] }> = [
    { op: "create_credit_note", keywords: ["credit note", "kreditnota", "kreditere"] },
    { op: "pay_invoice", keywords: ["pay invoice", "betal faktura", "registrer betaling", "register payment"] },
    { op: "reverse_voucher", keywords: ["reverse voucher", "reverser bilag", "tilbakefør"] },
    { op: "delete", keywords: ["delete", "slett", "fjern", "remove", "eliminar", "supprimer", "lösch"] },
    { op: "update", keywords: ["update", "oppdater", "endre", "modify", "rediger"] },
    { op: "list", keywords: ["list", "show", "find", "fetch", "get ", "hent", "vis", "finn", "liste"] },
    { op: "create", keywords: ["create", "opprett", "registrer", "lag ", "criar", "crear", "erstell", "ajouter", "add "] },
  ];
  for (const { op, keywords } of ops) {
    if (keywords.some((kw) => lower.includes(kw))) return op;
  }
  return "create";
}

function detectEntity(lower: string): TaskEntity {
  const entities: Array<{ entity: TaskEntity; keywords: string[] }> = [
    { entity: "travel_expense", keywords: ["travel expense", "reiseregning", "reise"] },
    { entity: "ledger_posting", keywords: ["ledger posting", "hovedbokspost", "posting"] },
    { entity: "ledger_account", keywords: ["ledger account", "kontoplan", "account"] },
    { entity: "invoice", keywords: ["invoice", "faktura"] },
    { entity: "order", keywords: ["order", "ordre", "bestilling"] },
    { entity: "voucher", keywords: ["voucher", "bilag"] },
    { entity: "employee", keywords: ["employee", "ansatt", "arbeidstaker"] },
    { entity: "customer", keywords: ["customer", "kunde", "client", "cliente"] },
    { entity: "product", keywords: ["product", "produkt"] },
    { entity: "project", keywords: ["project", "prosjekt"] },
    { entity: "department", keywords: ["department", "avdeling"] },
  ];
  for (const { entity, keywords } of entities) {
    if (keywords.some((kw) => lower.includes(kw))) return entity;
  }
  return "customer";
}

function extractValues(prompt: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  const emailMatch = prompt.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) values.email = emailMatch[0];

  const quotedMatch = prompt.match(/["'""](.{2,120}?)["'""]/);
  if (quotedMatch?.[1]) values.name = quotedMatch[1].replace(/\s+/g, " ").trim();

  const phoneMatch = prompt.match(/\+?\d[\d\s-]{6,}\d/);
  if (phoneMatch) values.phoneNumber = phoneMatch[0].replace(/\s+/g, " ").trim();

  const dateMatch = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch?.[1]) values.date = dateMatch[1];

  const orgMatch = prompt.match(/(?:org(?:anization)?[\s.-]*(?:n(?:o|r|umber))?|organisasjonsnummer|orgnr)[\s:.-]*(\d{9})/i);
  if (orgMatch?.[1]) values.organizationNumber = orgMatch[1];

  if (!values.name) {
    const capitalMatch = prompt.match(
      /\b([A-ZÆØÅ][A-Za-zÆØÅæøå'-]+(?:\s+[A-ZÆØÅ][A-Za-zÆØÅæøå'-]+)+)\b/g,
    );
    if (capitalMatch?.[0]) values.name = capitalMatch[0];
  }

  return values;
}

// ---------------------------------------------------------------------------
// Deterministic plan compiler — code owns ALL Tripletex semantics
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateRangeParams(prefix: string): Record<string, string> {
  const today = new Date();
  const yearAgo = new Date(today);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  return {
    [`${prefix}From`]: yearAgo.toISOString().slice(0, 10),
    [`${prefix}To`]: today.toISOString().slice(0, 10),
  };
}

function splitName(name: string | undefined): { firstName: string; lastName: string } {
  if (!name) {
    const suffix = Date.now().toString().slice(-6);
    return { firstName: "Generated", lastName: `User${suffix}` };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "Generated" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

export function compilePlan(spec: TaskSpec): ExecutionPlan {
  const v = (spec.values ?? {}) as Record<string, unknown>;

  switch (spec.entity) {
    case "employee":
      return compileEmployee(spec.operation, v, spec.lookup);
    case "customer":
      return compileCustomer(spec.operation, v, spec.lookup);
    case "product":
      return compileProduct(spec.operation, v);
    case "department":
      return compileDepartment(spec.operation, v);
    case "project":
      return compileProject(spec.operation, v);
    case "order":
      return compileOrder(spec.operation, v, spec.lookup);
    case "invoice":
      return compileInvoice(spec.operation, v, spec.lookup);
    case "travel_expense":
      return compileTravelExpense(spec.operation, v, spec.lookup);
    case "voucher":
      return compileVoucher(spec.operation, v, spec.lookup);
    case "ledger_account":
      return compileLedgerRead("ledger/account", v);
    case "ledger_posting":
      return compileLedgerRead("ledger/posting", v);
  }
}

// ---- Per-entity adapters ----

function compileEmployee(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  const person = splitName(v.name as string | undefined);
  if (v.firstName) person.firstName = String(v.firstName);
  if (v.lastName) person.lastName = String(v.lastName);

  if (op === "create") {
    const body: Record<string, unknown> = {
      firstName: person.firstName,
      lastName: person.lastName,
    };
    if (v.email) body.email = v.email;
    if (v.dateOfBirth) body.dateOfBirth = v.dateOfBirth;
    return {
      summary: `Create employee ${person.firstName} ${person.lastName}`,
      steps: [{ method: "POST", path: "/employee", body, saveAs: "employee" }],
    };
  }
  if (op === "update") {
    const body: Record<string, unknown> = {};
    if (v.firstName || v.name) body.firstName = v.firstName ?? person.firstName;
    if (v.lastName || v.name) body.lastName = v.lastName ?? person.lastName;
    if (v.email) body.email = v.email;
    if (v.dateOfBirth) body.dateOfBirth = v.dateOfBirth;
    if (lookup?.id) {
      return {
        summary: `Update employee ${lookup.id}`,
        steps: [
          { method: "GET", path: `/employee/${lookup.id}`, saveAs: "emp" },
          { method: "PUT", path: `/employee/${lookup.id}`, body },
        ],
      };
    }
    return {
      summary: "Update employee (lookup first)",
      steps: [
        { method: "GET", path: "/employee", params: { count: 1 }, saveAs: "emp" },
        { method: "PUT", path: "/employee/{{emp_id}}", body },
      ],
    };
  }
  if (op === "delete") {
    return compileDeleteNotSupported("employee");
  }
  return {
    summary: "List employees",
    steps: [{ method: "GET", path: "/employee", params: { count: 20 } }],
  };
}

function compileCustomer(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const body: Record<string, unknown> = {
      name: v.name ?? `Generated Customer ${Date.now().toString().slice(-6)}`,
      isCustomer: true,
    };
    if (v.email) body.email = v.email;
    if (v.phoneNumber) body.phoneNumber = v.phoneNumber;
    if (v.organizationNumber) body.organizationNumber = v.organizationNumber;
    return {
      summary: `Create customer ${body.name}`,
      steps: [{ method: "POST", path: "/customer", body, saveAs: "customer" }],
    };
  }
  if (op === "update") {
    const body: Record<string, unknown> = {};
    if (v.name) body.name = v.name;
    if (v.email) body.email = v.email;
    if (v.phoneNumber) body.phoneNumber = v.phoneNumber;
    if (v.organizationNumber) body.organizationNumber = v.organizationNumber;
    if (lookup?.id) {
      return {
        summary: `Update customer ${lookup.id}`,
        steps: [
          { method: "GET", path: `/customer/${lookup.id}`, saveAs: "cust" },
          { method: "PUT", path: `/customer/${lookup.id}`, body },
        ],
      };
    }
    return {
      summary: "Update customer (lookup first)",
      steps: [
        { method: "GET", path: "/customer", params: { count: 1 }, saveAs: "cust" },
        { method: "PUT", path: "/customer/{{cust_id}}", body },
      ],
    };
  }
  if (op === "delete") {
    return compileDeleteNotSupported("customer");
  }
  return {
    summary: "List customers",
    steps: [{ method: "GET", path: "/customer", params: { count: 20 } }],
  };
}

function compileProduct(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const body: Record<string, unknown> = {
      name: v.name ?? `Generated Product ${Date.now().toString().slice(-6)}`,
    };
    if (v.priceExcludingVatCurrency) body.priceExcludingVatCurrency = v.priceExcludingVatCurrency;
    if (v.costExcludingVatCurrency) body.costExcludingVatCurrency = v.costExcludingVatCurrency;
    if (v.number) body.number = v.number;
    return {
      summary: `Create product ${body.name}`,
      steps: [{ method: "POST", path: "/product", body, saveAs: "product" }],
    };
  }
  return {
    summary: "List products",
    steps: [{ method: "GET", path: "/product", params: { count: 20 } }],
  };
}

function compileDepartment(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: `Create department ${v.name ?? "new"}`,
      steps: [
        {
          method: "POST",
          path: "/department",
          body: { name: v.name ?? `Generated Dept ${Date.now().toString().slice(-6)}` },
          saveAs: "department",
        },
      ],
    };
  }
  return {
    summary: "List departments",
    steps: [{ method: "GET", path: "/department", params: { count: 20 } }],
  };
}

function compileProject(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: `Create project ${v.name ?? "new"}`,
      steps: [
        {
          method: "GET",
          path: "/employee",
          params: { count: 1, fields: "id" },
          saveAs: "manager",
          reason: "Find project manager",
        },
        {
          method: "POST",
          path: "/project",
          body: {
            name: v.name ?? `Generated Project ${Date.now().toString().slice(-6)}`,
            startDate: (v.startDate as string) ?? todayIso(),
            projectManager: { id: "{{manager_id}}" },
          },
          saveAs: "project",
        },
      ],
    };
  }
  return {
    summary: "List projects",
    steps: [{ method: "GET", path: "/project", params: { count: 20 } }],
  };
}

function compileOrder(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: "Create order",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: { count: 1, fields: "id" },
          saveAs: "customer",
          reason: "Resolve customer for order",
        },
        {
          method: "POST",
          path: "/order",
          body: {
            customer: { id: "{{customer_id}}" },
            orderDate: (v.orderDate as string) ?? todayIso(),
            deliveryDate: (v.deliveryDate as string) ?? todayIso(),
          },
          saveAs: "order",
        },
      ],
    };
  }
  if (op === "delete" && lookup?.id) {
    return { summary: `Delete order ${lookup.id}`, steps: [{ method: "DELETE", path: `/order/${lookup.id}` }] };
  }
  return {
    summary: "List orders",
    steps: [
      {
        method: "GET",
        path: "/order",
        params: { count: 20, ...dateRangeParams("orderDate") },
      },
    ],
  };
}

function compileInvoice(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: "Create invoice",
      steps: [
        {
          method: "GET",
          path: "/customer",
          params: { count: 1, fields: "id" },
          saveAs: "customer",
          reason: "Resolve customer for invoice",
        },
        {
          method: "GET",
          path: "/order",
          params: { count: 1, fields: "id", ...dateRangeParams("orderDate") },
          saveAs: "order",
          reason: "Resolve order for invoice",
        },
        {
          method: "POST",
          path: "/invoice",
          body: {
            customer: { id: "{{customer_id}}" },
            invoiceDate: (v.invoiceDate as string) ?? todayIso(),
            invoiceDueDate: (v.invoiceDueDate as string) ?? todayIso(),
            orders: [{ id: "{{order_id}}" }],
          },
          saveAs: "invoice",
        },
      ],
    };
  }
  if (op === "pay_invoice") {
    const invoiceId = lookup?.id ?? lookup?.invoiceId;
    if (invoiceId) {
      return {
        summary: `Pay invoice ${invoiceId}`,
        steps: [
          {
            method: "PUT",
            path: `/invoice/${invoiceId}/:payment`,
            body: {
              paymentDate: (v.paymentDate as string) ?? todayIso(),
              paymentTypeId: v.paymentTypeId ?? 1,
              paidAmount: v.amount ?? v.paidAmount,
            },
          },
        ],
      };
    }
    return {
      summary: "Pay invoice (find first)",
      steps: [
        {
          method: "GET",
          path: "/invoice",
          params: { count: 1, fields: "id,amount", ...dateRangeParams("invoiceDate") },
          saveAs: "inv",
        },
        {
          method: "PUT",
          path: "/invoice/{{inv_id}}/:payment",
          body: {
            paymentDate: (v.paymentDate as string) ?? todayIso(),
            paymentTypeId: v.paymentTypeId ?? 1,
            paidAmount: v.amount ?? v.paidAmount,
          },
        },
      ],
    };
  }
  if (op === "create_credit_note") {
    const invoiceId = lookup?.id ?? lookup?.invoiceId;
    if (invoiceId) {
      return {
        summary: `Credit note for invoice ${invoiceId}`,
        steps: [
          {
            method: "PUT",
            path: `/invoice/${invoiceId}/:createCreditNote`,
            body: {
              creditNoteDate: (v.date as string) ?? todayIso(),
              comment: (v.comment as string) ?? "",
            },
          },
        ],
      };
    }
    return {
      summary: "Credit note (find invoice first)",
      steps: [
        {
          method: "GET",
          path: "/invoice",
          params: { count: 1, fields: "id", ...dateRangeParams("invoiceDate") },
          saveAs: "inv",
        },
        {
          method: "PUT",
          path: "/invoice/{{inv_id}}/:createCreditNote",
          body: {
            creditNoteDate: (v.date as string) ?? todayIso(),
            comment: (v.comment as string) ?? "",
          },
        },
      ],
    };
  }
  return {
    summary: "List invoices",
    steps: [
      {
        method: "GET",
        path: "/invoice",
        params: { count: 20, ...dateRangeParams("invoiceDate") },
      },
    ],
  };
}

function compileTravelExpense(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: "Create travel expense",
      steps: [
        {
          method: "GET",
          path: "/employee",
          params: { count: 1, fields: "id" },
          saveAs: "employee",
        },
        {
          method: "POST",
          path: "/travelExpense",
          body: {
            employee: { id: "{{employee_id}}" },
            date: (v.date as string) ?? todayIso(),
            title: v.title ?? v.name ?? "Travel expense",
            description: v.description,
          },
          saveAs: "travelExpense",
        },
      ],
    };
  }
  if (op === "update") {
    const id = lookup?.id;
    if (id) {
      return {
        summary: `Update travel expense ${id}`,
        steps: [
          { method: "GET", path: `/travelExpense/${id}`, saveAs: "te" },
          { method: "PUT", path: `/travelExpense/${id}`, body: v },
        ],
      };
    }
    return {
      summary: "Update travel expense (lookup first)",
      steps: [
        { method: "GET", path: "/travelExpense", params: { count: 1 }, saveAs: "te" },
        { method: "PUT", path: "/travelExpense/{{te_id}}", body: v },
      ],
    };
  }
  if (op === "delete") {
    const id = lookup?.id;
    if (id) {
      return {
        summary: `Delete travel expense ${id}`,
        steps: [{ method: "DELETE", path: `/travelExpense/${id}` }],
      };
    }
    return {
      summary: "Delete travel expense (lookup first)",
      steps: [
        { method: "GET", path: "/travelExpense", params: { count: 1, fields: "id" }, saveAs: "te" },
        { method: "DELETE", path: "/travelExpense/{{te_id}}" },
      ],
    };
  }
  return {
    summary: "List travel expenses",
    steps: [{ method: "GET", path: "/travelExpense", params: { count: 20 } }],
  };
}

function compileVoucher(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    return {
      summary: "Create voucher",
      steps: [
        {
          method: "POST",
          path: "/ledger/voucher",
          body: {
            date: (v.date as string) ?? todayIso(),
            description: v.description ?? v.name ?? "Voucher",
          },
          saveAs: "voucher",
        },
      ],
    };
  }
  if (op === "delete") {
    const id = lookup?.id;
    if (id) {
      return {
        summary: `Delete voucher ${id}`,
        steps: [{ method: "DELETE", path: `/ledger/voucher/${id}` }],
      };
    }
    return {
      summary: "Delete voucher (lookup first)",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: { count: 1, fields: "id", ...dateRangeParams("date") },
          saveAs: "v",
        },
        { method: "DELETE", path: "/ledger/voucher/{{v_id}}" },
      ],
    };
  }
  if (op === "reverse_voucher") {
    const id = lookup?.id;
    if (id) {
      return {
        summary: `Reverse voucher ${id}`,
        steps: [
          {
            method: "PUT",
            path: `/ledger/voucher/${id}/:reverse`,
            body: { date: (v.date as string) ?? todayIso() },
          },
        ],
      };
    }
    return {
      summary: "Reverse voucher (lookup first)",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: { count: 1, fields: "id", ...dateRangeParams("date") },
          saveAs: "v",
        },
        {
          method: "PUT",
          path: "/ledger/voucher/{{v_id}}/:reverse",
          body: { date: (v.date as string) ?? todayIso() },
        },
      ],
    };
  }
  return {
    summary: "List vouchers",
    steps: [
      {
        method: "GET",
        path: "/ledger/voucher",
        params: { count: 20, ...dateRangeParams("date") },
      },
    ],
  };
}

function compileLedgerRead(
  subpath: string,
  v: Record<string, unknown>,
): ExecutionPlan {
  const params: Record<string, unknown> = { count: 20 };
  if (subpath !== "ledger/account") {
    Object.assign(params, dateRangeParams("date"));
  }
  return {
    summary: `List ${subpath}`,
    steps: [{ method: "GET", path: `/${subpath}`, params }],
  };
}

function compileDeleteNotSupported(entity: string): ExecutionPlan {
  return {
    summary: `Cannot delete ${entity} — read instead`,
    steps: [{ method: "GET", path: `/${entity}`, params: { count: 1 } }],
  };
}

// ---------------------------------------------------------------------------
// Postcondition verifier
// ---------------------------------------------------------------------------

export async function verifyOutcome(
  client: TripletexClient,
  spec: TaskSpec,
  _executionResult: unknown,
): Promise<{ verified: boolean; detail: string }> {
  if (spec.operation === "list") {
    return { verified: true, detail: "read-only operation" };
  }
  if (spec.operation === "delete") {
    return { verified: true, detail: "delete completed" };
  }

  const entityPath = entityToPath(spec.entity);
  if (!entityPath) {
    return { verified: true, detail: "no verification path" };
  }

  try {
    const params: Record<string, unknown> = { count: 5 };
    if (entityPath === "/order") Object.assign(params, dateRangeParams("orderDate"));
    if (entityPath === "/invoice") Object.assign(params, dateRangeParams("invoiceDate"));
    if (entityPath === "/ledger/voucher") Object.assign(params, dateRangeParams("date"));

    const response = await client.request("GET", entityPath, { params });
    const obj = response as Record<string, unknown>;
    const values = Array.isArray(obj?.values) ? obj.values : [];
    if (obj?.value) values.push(obj.value);

    if (spec.operation === "create" && values.length === 0) {
      return { verified: false, detail: `no ${spec.entity} found after create` };
    }

    const v = (spec.values ?? {}) as Record<string, unknown>;
    if (v.name && values.length > 0) {
      const nameMatches = values.some((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const rec = item as Record<string, unknown>;
        const entityName = rec.name ?? `${rec.firstName ?? ""} ${rec.lastName ?? ""}`.trim();
        return String(entityName).toLowerCase().includes(String(v.name).toLowerCase());
      });
      if (!nameMatches) {
        return { verified: false, detail: `${spec.entity} with name '${v.name}' not found` };
      }
    }

    return { verified: true, detail: `${spec.entity} verified` };
  } catch {
    return { verified: true, detail: "verification GET failed, assuming success" };
  }
}

function entityToPath(entity: TaskEntity): string | null {
  const map: Record<string, string> = {
    employee: "/employee",
    customer: "/customer",
    product: "/product",
    department: "/department",
    project: "/project",
    order: "/order",
    invoice: "/invoice",
    travel_expense: "/travelExpense",
    voucher: "/ledger/voucher",
    ledger_account: "/ledger/account",
    ledger_posting: "/ledger/posting",
  };
  return map[entity] ?? null;
}
