import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { z } from "zod";

import {
  compileAccountingDimensionPreview,
  verifyAccountingDimensionOutcome as verifyAccountingDimensionWorkflowOutcome,
} from "./accounting_dimension.js";
import {
  compileAttachmentOnboardingPreview,
  matchesAttachmentOnboardingWorkflow,
  verifyAttachmentOnboardingOutcome as verifyAttachmentOnboardingWorkflowOutcome,
} from "./attachment_onboarding.js";
import type { AttachmentSummary } from "./attachments.js";
import {
  compileBankReconciliationPreview,
  verifyBankReconciliationOutcome as verifyBankReconciliationWorkflowOutcome,
} from "./bank_reconciliation.js";
import { shiftIsoDateInZone, todayIsoInZone } from "./dates.js";
import {
  verifyExpenseVoucherOutcome as verifyExpenseVoucherWorkflowOutcome,
} from "./expense_voucher.js";
import type { ExecutePlanResult } from "./planner.js";
import {
  compilePayrollPreview,
  verifyPayrollOutcome as verifyPayrollWorkflowOutcome,
} from "./payroll.js";
import {
  compileInvoicePaymentPreview,
  verifyInvoicePaymentOutcome as verifyInvoicePaymentWorkflowOutcome,
} from "./invoice_payment.js";
import {
  compileInvoiceReminderPreview,
  verifyInvoiceReminderOutcome as verifyInvoiceReminderWorkflowOutcome,
} from "./invoice_reminder.js";
import {
  compileLedgerVarianceProjectsPreview,
  verifyLedgerVarianceProjectsOutcome as verifyLedgerVarianceProjectsWorkflowOutcome,
} from "./ledger_variance_projects.js";
import {
  compileLedgerErrorCorrectionPreview,
  verifyLedgerErrorCorrectionOutcome as verifyLedgerErrorCorrectionWorkflowOutcome,
} from "./ledger_error_correction.js";
import {
  compileProjectTimeInvoicePreview,
  matchesProjectTimeInvoiceWorkflow,
  verifyProjectTimeInvoiceOutcome,
} from "./project_time_invoice.js";
import {
  compileProjectCyclePreview,
  verifyProjectCycleOutcome as verifyProjectCycleWorkflowOutcome,
} from "./project_cycle.js";
import {
  compileSupplierInvoicePreview,
  verifySupplierInvoiceOutcome as verifySupplierInvoiceWorkflowOutcome,
} from "./supplier_invoice.js";
import {
  verifyReturnedPaymentOutcome as verifyReturnedPaymentWorkflowOutcome,
} from "./returned_payment.js";
import {
  compileMonthEndClosingPreview,
  verifyMonthEndClosingOutcome as verifyMonthEndClosingWorkflowOutcome,
} from "./month_end_closing.js";
import type { ExecutionPlan, PlanStep, SolveRequest } from "./schemas.js";
import { TripletexClient, primaryValue } from "./tripletex.js";

// ---------------------------------------------------------------------------
// TaskSpec schema — the ONLY thing the LLM produces
// ---------------------------------------------------------------------------

const entityEnum = z.enum([
  "employee",
  "customer",
  "supplier",
  "product",
  "department",
  "project",
  "project_cycle",
  "order",
  "invoice",
  "invoice_reminder",
  "supplier_invoice",
  "attachment_onboarding",
  "bank_reconciliation",
  "ledger_variance_projects",
  "ledger_error_correction",
  "month_end_closing",
  "accounting_dimension",
  "travel_expense",
  "salary_transaction",
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

const valuesSchema = z
  .object({
    // Common
    name: z.string().optional().describe("Full name (person or company)"),
    names: z.array(z.string()).optional().describe("Multiple names when the prompt creates several entities"),
    email: z.string().optional().describe("Email address"),
    phoneNumber: z.string().optional().describe("Phone number (mobile or main)"),
    description: z.string().optional().describe("Description or comment"),
    comment: z.string().optional().describe("Comment text"),
    url: z.string().optional().describe("Website URL"),
    // Employee fields
    firstName: z.string().optional().describe("First name for employees"),
    lastName: z.string().optional().describe("Last name for employees"),
    dateOfBirth: z.string().optional().describe("Date of birth YYYY-MM-DD"),
    employmentDate: z.string().optional().describe("Employment start date YYYY-MM-DD"),
    nationalIdentityNumber: z.string().optional().describe("National identity number (fødselsnummer, 11 digits)"),
    userType: z.string().optional().describe("Employee user type: STANDARD, EXTENDED, or NO_ACCESS"),
    isAdmin: z.boolean().optional().describe("Whether user should be admin/kontoadministrator"),
    departmentName: z.string().optional().describe("Department name if referenced"),
    address: z.string().optional().describe("Street address / gate"),
    postalCode: z.string().optional().describe("Postal code / postnummer"),
    city: z.string().optional().describe("City / poststed"),
    bankAccountNumber: z.string().optional().describe("Bank account number / kontonummer"),
    occupationCode: z.string().optional().describe("Occupation/profession code"),
    employmentPercentage: z.number().optional().describe("Employment percentage / percentage of full-time equivalent"),
    annualSalary: z.number().optional().describe("Annual salary amount"),
    monthlySalary: z.number().optional().describe("Monthly salary amount"),
    userAccessRequested: z.boolean().optional().describe("Whether user access/logon access should be created"),
    entitlementTemplate: z.string().optional().describe("Optional employee entitlement template when supported"),
    // Customer fields
    organizationNumber: z.string().optional().describe("Norwegian org number (9 digits)"),
    isSupplier: z.boolean().optional().describe("Whether entity is also a supplier/leverandør"),
    isCustomer: z.boolean().optional().describe("Whether entity is a customer (default true)"),
    invoiceEmail: z.string().optional().describe("Email for invoices if different"),
    // Date fields
    date: z.string().optional().describe("General date YYYY-MM-DD"),
    startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
    endDate: z.string().optional().describe("End date YYYY-MM-DD"),
    invoiceDate: z.string().optional().describe("Invoice date YYYY-MM-DD"),
    invoiceDueDate: z.string().optional().describe("Invoice due date YYYY-MM-DD"),
    invoiceNumber: z.string().optional().describe("Invoice number / fakturanummer"),
    orderDate: z.string().optional().describe("Order date YYYY-MM-DD"),
    deliveryDate: z.string().optional().describe("Delivery date YYYY-MM-DD"),
    paymentDate: z.string().optional().describe("Payment date YYYY-MM-DD"),
    reminderType: z.string().optional().describe("Invoice reminder type: SOFT_REMINDER, REMINDER, NOTICE_OF_DEBT_COLLECTION"),
    reminderFeeAmount: z.number().optional().describe("Explicit reminder fee amount when stated in the prompt"),
    includeReminderCharge: z.boolean().optional().describe("Whether the reminder should include a reminder fee"),
    includeReminderInterests: z.boolean().optional().describe("Whether the reminder should include interest"),
    reminderEmail: z.string().optional().describe("Email address for sending reminders"),
    // Monetary
    amount: z.number().optional().describe("Monetary amount"),
    vatRate: z.number().optional().describe("VAT percentage"),
    hours: z.number().optional().describe("Hour quantity for project or timesheet work"),
    closingMonth: z.number().optional().describe("Month for closing tasks, 1-12"),
    closingYear: z.number().optional().describe("Year for closing tasks"),
    accrualAmount: z.number().optional().describe("Monthly accrual reversal amount"),
    accrualFromAccountNumber: z.number().optional().describe("Balance-sheet account to reverse from"),
    accrualToAccountNumber: z.number().optional().describe("Expense or counterpart account for accrual reversal"),
    assetCost: z.number().optional().describe("Fixed asset acquisition cost"),
    usefulLifeYears: z.number().optional().describe("Useful life in years"),
    depreciationAmount: z.number().optional().describe("Monthly depreciation amount"),
    depreciationExpenseAccountNumber: z.number().optional().describe("Expense account for depreciation"),
    accumulatedDepreciationAccountNumber: z.number().optional().describe("Accumulated depreciation account"),
    baseSalaryAmount: z.number().optional().describe("Base salary amount for payroll runs"),
    bonusAmount: z.number().optional().describe("One-time bonus amount for payroll runs"),
    price: z.number().optional().describe("Price/unit price"),
    hourlyRate: z.number().optional().describe("Hourly rate for project or timesheet work"),
    budgetAmount: z.number().optional().describe("Project budget amount"),
    currencyCode: z.string().optional().describe("Invoice/payment currency code, e.g. EUR"),
    originalExchangeRate: z.number().optional().describe("Original NOK per foreign-currency unit"),
    paymentExchangeRate: z.number().optional().describe("Payment NOK per foreign-currency unit"),
    postExchangeDifference: z.boolean().optional().describe("Whether the prompt explicitly asks to post exchange-rate difference"),
    accountNumber: z.string().optional().describe("Ledger account number, e.g. 6540"),
    // Product fields
    number: z.string().optional().describe("Product number, project number, etc"),
    productName: z.string().optional().describe("Product name if referenced in order/invoice"),
    invoiceLines: z
      .array(z.object({
        description: z.string().optional(),
        productName: z.string().optional(),
        productNumber: z.string().optional(),
        amount: z.number().optional(),
        vatRate: z.number().optional(),
      }).passthrough())
      .optional()
      .describe("Invoice/order lines extracted from the prompt"),
    dimensionName: z.string().optional().describe("Custom accounting dimension name"),
    dimensionValueName: z.string().optional().describe("Specific dimension value to use for voucher posting"),
    dimensionValues: z.array(z.string()).optional().describe("Dimension values to create"),
    // References
    customerName: z.string().optional().describe("Referenced customer name"),
    employeeName: z.string().optional().describe("Referenced employee name"),
    activityName: z.string().optional().describe("Referenced activity name"),
    projectName: z.string().optional().describe("Referenced project name"),
    projectManagerName: z.string().optional().describe("Project manager name"),
    projectManagerEmail: z.string().optional().describe("Project manager email if explicitly stated"),
    title: z.string().optional().describe("Title for travel expenses etc"),
    travelDays: z.number().optional().describe("Travel duration in days"),
    perDiemRate: z.number().optional().describe("Daily allowance / per diem rate"),
    analysisFromMonth: z.number().optional().describe("First month in a ledger variance comparison, 1-12"),
    analysisToMonth: z.number().optional().describe("Second month in a ledger variance comparison, 1-12"),
    topCount: z.number().optional().describe("How many top ranked entities to create or return"),
    costs: z
      .array(z.object({
        comments: z.string(),
        amountCurrencyIncVat: z.number(),
      }).passthrough())
      .optional()
      .describe("Itemized travel expense costs"),
  })
  .passthrough()
  .describe("Exact field values extracted from the prompt");

const lookupSchema = z
  .object({
    id: z.number().optional().describe("Entity ID if explicitly mentioned"),
    name: z.string().optional().describe("Entity name to search by"),
    invoiceNumber: z.string().optional().describe("Invoice number"),
    amount: z.number().optional().describe("Amount to match"),
  })
  .passthrough()
  .optional()
  .describe("Constraints to find an existing entity");

export const taskSpecSchema = z.object({
  operation: operationEnum,
  entity: entityEnum,
  values: valuesSchema,
  lookup: lookupSchema,
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

Given a task prompt (which may be in Norwegian Bokmål, Norwegian Nynorsk, English, Spanish, Portuguese, German, or French), extract a structured task specification.

ENTITIES (use exactly these names):
- employee, customer, product, department, project, project_cycle
- order, invoice, invoice_reminder, supplier_invoice, attachment_onboarding, bank_reconciliation, ledger_variance_projects, ledger_error_correction, month_end_closing
- accounting_dimension, travel_expense, salary_transaction
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
- opprett/registrer/lag/add/crear/criar/erstellen/ajouter/créer = create
- oppdater/endre/rediger/modify/modificar/alterar/ändern/modifier = update
- slett/fjern/remove/delete/eliminar/excluir/löschen/supprimer = delete
- vis/finn/hent/liste/list/show/find/get/mostrar/buscar/zeigen/afficher = list
- ansatt/arbeidstakar/tilsett/medarbeider = employee, kunde/client/cliente/Kunde = customer
- avdeling = department, prosjekt = project
- faktura/factura/fatura/Rechnung/facture = invoice, ordre/bestilling = order
- produkt/producto/produto/Produkt/produit = product
- lønn/payroll/paie/salary/payslip = salary_transaction
- reiseregning/reiserekning = travel_expense, bilag/voucher/Beleg = voucher
- kreditnota/kreditere = create_credit_note, betaling/betal = pay_invoice, reverser = reverse_voucher
- leverandør/supplier/fournisseur/proveedor = supplier
- purring/purregebyr/betalingspåminnelse/late fee/reminder fee = invoice_reminder
- leverandørfaktura/supplier invoice/incoming invoice = supplier_invoice
- onboarding/new employee from attached contract/offer letter = attachment_onboarding
- bank reconciliation/bank statement/relevé bancaire/releve bancaire/Bankabstimmung = bank_reconciliation
- compare ledger postings / expense increase / create internal projects = ledger_variance_projects
- general ledger audit / voucher errors / find and correct errors = ledger_error_correction
- month-end closing/month end close/period close/clôture mensuelle/cloture mensuelle = month_end_closing

FIELD EXTRACTION — Extract EVERY value from the prompt using these exact field names:

For EMPLOYEE:
  firstName, lastName — split full name. "Ola Nordmann" → firstName="Ola", lastName="Nordmann"
  email, phoneNumber, dateOfBirth (YYYY-MM-DD), employmentDate (YYYY-MM-DD)
  nationalIdentityNumber — fødselsnummer (11 digits)
  address, postalCode, city — physical address
  bankAccountNumber — kontonummer
  occupationCode — profession/occupation code
  employmentPercentage — stillingsprosent / percentage of full-time equivalent
  annualSalary, monthlySalary
  userType — "STANDARD", "EXTENDED", or "NO_ACCESS"
  isAdmin — true if kontoadministrator/administrator
  userAccessRequested — true when the prompt says to create user/logon access
  departmentName — name of department if mentioned

For ATTACHMENT_ONBOARDING:
  Use this when the task is based on an attached employment contract / offer letter / PDF for a new employee.
  Extract the same employee fields as above, plus:
  occupationCode, employmentPercentage, annualSalary, monthlySalary, userAccessRequested
  Keep exact values from the document whenever present.

For CUSTOMER:
  name — company or person name
  email, phoneNumber, organizationNumber (9 digits)
  isSupplier — true if leverandør/supplier
  invoiceEmail — separate invoice email if mentioned
  address, postalCode, city

For PRODUCT:
  name, number (product number/varenummer), price (unit price)

For DEPARTMENT:
  name, number (department number/avdelingsnummer)

For PROJECT:
  name, startDate, endDate, projectManagerName, projectManagerEmail, customerName, organizationNumber, description

For ORDER:
  customerName, orderDate, deliveryDate, productName, amount

For INVOICE:
  customerName, invoiceDate, invoiceDueDate, amount, productName
  projectName, activityName, employeeName, hours, hourlyRate/price when the prompt is about project hours to be invoiced

For INVOICE_REMINDER:
  customerName, organizationNumber, invoiceNumber, date
  reminderType, reminderFeeAmount, includeReminderCharge, includeReminderInterests
  reminderEmail
  invoiceLines — if the prompt lists multiple lines, extract each as:
    { productNumber?, productName?, description?, amount, vatRate? }

For SUPPLIER_INVOICE:
  name — supplier name
  organizationNumber — supplier org number
  invoiceNumber — supplier invoice number
  amount — gross amount including VAT
  vatRate — input VAT percentage if stated
  accountNumber — expense account number if stated
  description/comment — what the supplier invoice concerns
  date — voucher/invoice date if stated

For ACCOUNTING_DIMENSION:
  dimensionName — custom/free accounting dimension name
  dimensionValues — list of values to create for the dimension
  dimensionValueName — if one value is specifically referenced for a voucher posting
  accountNumber — ledger account number if the prompt includes one
  amount, date, description/comment if the prompt also asks to create a voucher

For BANK_RECONCILIATION:
  date, startDate, endDate if the prompt states a statement period
  attachment_facts should include invoice numbers, payment references, dates, amounts, and counterparties found in CSV/text attachments

For MONTH_END_CLOSING:
  closingMonth, closingYear
  accrualAmount, accrualFromAccountNumber, accrualToAccountNumber
  assetCost, usefulLifeYears, depreciationAmount
  depreciationExpenseAccountNumber, accumulatedDepreciationAccountNumber

For TRAVEL_EXPENSE:
  employeeName, email, title, description, date, startDate, endDate, amount
  travelDays — trip duration in days if stated
  perDiemRate — daily allowance / per diem rate if stated
  costs — itemized costs as { comments, amountCurrencyIncVat }

For SALARY_TRANSACTION:
  employeeName, email, date
  baseSalaryAmount — fixed/base salary amount
  bonusAmount — one-time bonus amount if stated

For VOUCHER:
  description, date, amount

TRIPLETEX-SPECIFIC TERMS:
- kontoadministrator/kontoansvarlig = userType "EXTENDED" + isAdmin true
- standardbruker = userType "STANDARD"
- ingen tilgang = userType "NO_ACCESS"
- leverandør = isSupplier true
- payroll / paie / lønnskjøring / execute salary = entity salary_transaction
- base salary / fastlønn / salaire de base maps to baseSalaryAmount
- bonus / prime unique maps to bonusAmount
- avdeling → set departmentName
- prosjektleder/prosjektansvarlig → set projectManagerName

KEY RULES:
- Dates: always YYYY-MM-DD format. Convert "1. mars 2026" → "2026-03-01".
- Amounts: numeric only, no currency symbols. "5000 kr" → 5000.
- IDs go in "lookup" field, not "values".
- Focus on PRIMARY entity. "opprett faktura for kunde X" → entity=invoice, customerName="X".
- Fixed-price milestone billing tasks are invoice creation tasks, even if they also mention creating/updating a project.
- Project timesheet billing tasks ("log/register X hours on activity Y in project Z and invoice/bill the customer") are invoice creation tasks.
- For project timesheet billing tasks, include projectName, activityName, employeeName, hours, and hourlyRate/price.
- Returned-payment tasks ("returned by the bank", "returnert av banken") that should reopen an invoice map to operation=reverse_voucher, entity=voucher.
- If the prompt asks to create a custom/free accounting dimension with values, use entity=accounting_dimension.
- Bank statement / CSV reconciliation tasks are entity=bank_reconciliation, operation=create.
- General-ledger audit / voucher-repair tasks are entity=ledger_error_correction, operation=create.
- Month-end closing tasks with accrual reversal or depreciation are entity=month_end_closing, operation=create.
- Attachment-driven employee onboarding tasks are entity=attachment_onboarding, operation=create.
- If the prompt asks to create multiple entities of the same kind, include values.names as an array.
- If the prompt includes multiple invoice lines, include values.invoiceLines instead of flattening to one productName/amount pair.
- Do NOT guess values. Only extract what is explicitly stated.
- Extract ALL attributes: names, emails, phones, dates, amounts, roles, addresses, org numbers.
- If attachments have invoice/receipt data, extract into attachment_facts array.

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
    "google/gemini-3.1-pro-preview",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5-nano",
  ];
  return [...configured, ...defaults].filter(
    (m, i, all) => m !== primary && all.indexOf(m) === i,
  );
}

function taskSpecLlmTimeoutMs(): number {
  const raw = Number(process.env.TRIPLETEX_TASKSPEC_LLM_TIMEOUT_MS || process.env.TRIPLETEX_LLM_TIMEOUT_MS || "12000");
  if (!Number.isFinite(raw)) return 12000;
  return Math.min(60000, Math.max(2000, Math.round(raw)));
}

async function generateTaskSpecObjectWithTimeout(
  options: {
    model: unknown;
    prompt: string;
    providerOptions?: unknown;
    temperature: number;
  },
  timeoutMs: number,
): Promise<TaskSpec> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`TaskSpec extraction timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const generated = await Promise.race([
      generateObject({
        model: options.model as never,
        schema: taskSpecSchema,
        temperature: options.temperature,
        maxRetries: 0,
        abortSignal: controller.signal,
        providerOptions: options.providerOptions as never,
        prompt: options.prompt,
      }),
      timeoutPromise,
    ]);
    return (generated as { object: TaskSpec }).object;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function extractTaskSpec(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
): Promise<TaskSpec> {
  const model = selectModel();
  return await generateTaskSpecObjectWithTimeout({
    model: gateway(model),
    temperature: 0,
    providerOptions: {
      gateway: { models: fallbackModels(model) } satisfies GatewayLanguageModelOptions,
    },
    prompt: buildExtractionPrompt(payload, summaries),
  }, taskSpecLlmTimeoutMs());
}

export async function repairTaskSpec(
  payload: SolveRequest,
  summaries: AttachmentSummary[],
  previousSpec: TaskSpec,
  errorDetail: string,
): Promise<TaskSpec> {
  const model = selectModel();
  const repairPrompt = [
    buildExtractionPrompt(payload, summaries),
    "",
    "IMPORTANT — REPAIR CONTEXT:",
    `A previous attempt extracted this spec but it failed:`,
    `  operation: ${previousSpec.operation}`,
    `  entity: ${previousSpec.entity}`,
    `  values: ${JSON.stringify(previousSpec.values)}`,
    `  lookup: ${JSON.stringify(previousSpec.lookup ?? {})}`,
    "",
    `The execution failed with this error:`,
    errorDetail,
    "",
    "Please re-extract the task spec, fixing the issue. Pay special attention to:",
    "- Are the operation and entity correct?",
    "- Are ALL values from the prompt included (names, emails, phones, dates, amounts, roles)?",
    "- Are field names correct for the Tripletex API?",
    "- If the error mentions a missing field, make sure to include it.",
    "- If the error mentions a wrong value, correct it.",
  ].join("\n");

  return await generateTaskSpecObjectWithTimeout({
    model: gateway(model),
    temperature: 0.2,
    providerOptions: {
      gateway: { models: fallbackModels(model) } satisfies GatewayLanguageModelOptions,
    },
    prompt: repairPrompt,
  }, taskSpecLlmTimeoutMs());
}

// ---------------------------------------------------------------------------
// Heuristic extraction — regex fallback when LLM is unavailable
// ---------------------------------------------------------------------------

function extractQuotedSegments(prompt: string): string[] {
  return [...prompt.matchAll(/"([^"\n]{2,120})"|“([^”\n]{2,120})”|'([^'\n]{2,120})'/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value));
}

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function stripEmailsForKeywordDetection(value: string): string {
  return value.replace(EMAIL_REGEX, " ");
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(value: string): RegExp {
  const escaped = escapeRegexLiteral(value.trim()).replace(/\s+/g, "\\s+");
  const startsWithWord = /^[\p{L}\p{N}]/u.test(value);
  const endsWithWord = /[\p{L}\p{N}]$/u.test(value);
  const prefix = startsWithWord ? String.raw`(?:^|[^\p{L}\p{N}])` : "";
  const suffix = endsWithWord ? String.raw`(?:$|[^\p{L}\p{N}])` : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "iu");
}

function matchesKeyword(value: string, keyword: string): boolean {
  return keywordPattern(keyword).test(value);
}

function matchesAnyKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => matchesKeyword(value, keyword));
}

function foldSemanticText(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

const SEMANTIC_HINT_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "project cycle",
    patterns: [
      /\bproject cycle\b/,
      /\bproject lifecycle\b/,
      /\bproject life cycle\b/,
      /\bprosjektsyklus\b/,
      /\bprojektzyklus\b/,
      /\bcycle de vie complet du projet\b/,
      /\bcycle de vie du projet\b/,
      /\bciclo del proyecto\b/,
      /\bciclo do projeto\b/,
    ],
  },
  {
    canonical: "month end closing",
    patterns: [
      /\bmonth end closing\b/,
      /\bmonth end close\b/,
      /\bperiod close\b/,
      /\bmanedsavslutning\b/,
      /\bperiodestenging\b/,
      /\bmonatsabschluss\b/,
      /\bcloture mensuelle\b/,
      /\bcierre mensual\b/,
      /\bfechamento mensal\b/,
      /\bencerramento mensal\b/,
    ],
  },
  {
    canonical: "annual closing",
    patterns: [
      /\bannual closing\b/,
      /\byear end closing\b/,
      /\byear end close\b/,
      /\barsoppgjor\b/,
      /\bjahresabschluss\b/,
      /\bcloture annuelle\b/,
      /\bcierre anual\b/,
      /\bfechamento anual\b/,
      /\bencerramento anual\b/,
    ],
  },
  {
    canonical: "supplier invoice",
    patterns: [
      /\bsupplier invoice\b/,
      /\bincoming invoice\b/,
      /\bleverandorfaktura\b/,
      /\bfacture fournisseur\b/,
      /\bfournisseur facture\b/,
      /\bfatura de fornecedor\b/,
      /\bfatura do fornecedor\b/,
      /\bfactura de proveedor\b/,
      /\bfactura del proveedor\b/,
    ],
  },
  {
    canonical: "invoice reminder",
    patterns: [
      /\bpayment reminder\b/,
      /\breminder fee\b/,
      /\blate fee\b/,
      /\bpurregebyr\b/,
      /\bpurring\b/,
      /\bmahnung\b/,
      /\bfrais de rappel\b/,
      /\btaxa de lembrete\b/,
    ],
  },
  {
    canonical: "returned payment",
    patterns: [
      /\breturned payment\b/,
      /\breturned by the bank\b/,
      /\bdevuelto por el banco\b/,
      /\brevierta el pago\b/,
      /\breverta o pagamento\b/,
      /\breverter o pagamento\b/,
      /\breverser betaling\b/,
      /\bannulez le paiement\b/,
    ],
  },
  {
    canonical: "project manager",
    patterns: [
      /\bproject manager\b/,
      /\bprosjektleder\b/,
      /\bprosjektleiar\b/,
      /\bprojektleiter\b/,
      /\bchef de projet\b/,
      /\bjefe de proyecto\b/,
      /\bgerente do projeto\b/,
    ],
  },
];

const SEMANTIC_LABEL_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "department",
    patterns: [/^department$/, /^avdeling$/, /^abteilung$/, /^departamento$/, /^departement$/],
  },
  {
    canonical: "occupation code",
    patterns: [
      /^occupation code$/,
      /^profession code$/,
      /^job code$/,
      /^position code$/,
      /^yrkeskode$/,
      /^stillingskode$/,
      /^code profession$/,
      /^codigo de ocupacion$/,
      /^codigo de profissao$/,
      /^codigo del puesto$/,
      /^codigo de puesto$/,
      /^berufsschluessel$/,
      /^berufsschlussel$/,
      /^berufscode$/,
      /^taetigkeitsschluessel$/,
      /^tatigkeitsschlussel$/,
    ],
  },
  {
    canonical: "employment percentage",
    patterns: [
      /^employment percentage$/,
      /^stillingsprosent$/,
      /^arbeidsprosent$/,
      /^taux d'occupation$/,
      /^taux d occupation$/,
      /^porcentaje de empleo$/,
      /^percentagem de emprego$/,
      /^besch[a-z]*ftigungsgrad$/,
      /^beschaeftigungsgrad$/,
      /^anstellungsgrad$/,
    ],
  },
  {
    canonical: "annual salary",
    patterns: [
      /^annual salary$/,
      /^annual base salary$/,
      /^gross annual salary$/,
      /^arslonn$/,
      /^salaire annuel$/,
      /^salario anual$/,
      /^salario bruto anual$/,
      /^salario anual bruto$/,
      /^salario anual bruto$/,
      /^jahresgehalt$/,
      /^jahreslohn$/,
      /^jahresvergutung$/,
    ],
  },
  {
    canonical: "employment date",
    patterns: [
      /^employment date$/,
      /^start date$/,
      /^eintrittsdatum$/,
      /^date de debut$/,
      /^data de inicio$/,
      /^data de inicio do emprego$/,
    ],
  },
  {
    canonical: "user access",
    patterns: [
      /^user access$/,
      /^brukertilgang$/,
      /^brukeradgang$/,
      /^benutzerzugang$/,
      /^acesso de utilizador$/,
      /^acesso do utilizador$/,
      /^acceso de usuario$/,
    ],
  },
  {
    canonical: "project manager",
    patterns: [/^project manager$/, /^prosjektleder$/, /^prosjektleiar$/, /^projektleiter$/, /^chef de projet$/, /^jefe de proyecto$/, /^gerente do projeto$/],
  },
];

function collectSemanticAugmentations(value: string): string[] {
  const base = String(value ?? "").trim();
  if (!base) return [];
  const folded = foldSemanticText(base);
  const augmentations: string[] = [];

  for (const alias of SEMANTIC_HINT_ALIASES) {
    if (alias.patterns.some((pattern) => pattern.test(folded))) {
      augmentations.push(alias.canonical);
    }
  }

  for (const line of base.split(/\n+/)) {
    const match = line.match(/^\s*([^:\n]{2,80})\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const label = foldSemanticText(match[1]);
    const rawValue = match[2]?.trim();
    if (!rawValue) continue;
    for (const alias of SEMANTIC_LABEL_ALIASES) {
      if (alias.patterns.some((pattern) => pattern.test(label))) {
        augmentations.push(`${alias.canonical}: ${rawValue}`);
        break;
      }
    }
  }

  return [...new Set(augmentations)].filter(Boolean);
}

function buildSemanticAugmentedText(value: string): string {
  const base = String(value ?? "").trim();
  if (!base) return "";
  const foldedBase = foldSemanticText(base);
  const augmentations = collectSemanticAugmentations(base).filter((item) => !foldedBase.includes(foldSemanticText(item)));
  return augmentations.length > 0 ? [base, ...augmentations].join("\n") : base;
}

function hasSupplierSignal(value: string): boolean {
  return /\b(?:supplier(?:s)?|leverand(?:ø|o)r(?:en|er|ens)?|fornecedor(?:es)?|fournisseur(?:s)?|proveedor(?:es)?)\b/i.test(value);
}

function hasEmployeeSignal(value: string): boolean {
  return /\b(?:employee|ansatt|arbeidstakar|tilsett|empleado|empregado|mitarbeiter|employe|employé|funcion[aá]rio(?:s)?)\b/i.test(value);
}

function hasEmployeeFieldSignal(value: string): boolean {
  return /\b(?:date\s*of\s*birth|f[øo]dselsdato|date\s+de\s+naissance|fecha\s+de\s+nacimiento|data\s+de\s+nascimento|employment\s*date|employment\s*start\s*date|startdato|start\s*date|date\s+de\s+d[ée]but|fecha\s+de\s+inicio|data\s+de\s+in[íi]cio|tiltredelsesdato|oppstarts?dato|startdatum|eintrittsdatum|occupation\s*code|profession\s*code|yrkeskode|stillingskode|code\s+profession|c[oó]digo\s+de\s+ocupaci[oó]n|c[oó]digo\s+de\s+profiss[aã]o|berufsschl(?:uessel|[uü]ssel)|employment\s*percentage|stillingsprosent|arbeidsprosent|taux\s+d[' ]occupation|porcentaje\s+de\s+empleo|percentagem\s+de\s+emprego|national\s+identity|identity\s+number|f[øo]dselsnummer|personnummer|numero\s+de\s+identidade|n[úu]mero\s+de\s+identifica[cç][aã]o|annual\s+salary|monthly\s+salary|[aå]rsl[øo]nn|m[aå]nedsl[øo]nn|salaire\s+annuel|salaire\s+mensuel|salario\s+anual|salario\s+mensual|sal[aá]rio\s+anual|sal[aá]rio\s+mensal)\b/i.test(value);
}

function hasCreateIntentKeyword(value: string): boolean {
  return /\b(?:create|opprett|lag|registrer|registre|registe|registar|registe|cr[ée]ez|cree|crie|crear|criar|erstell(?:e|en|en sie)?|erstelle)\b/i.test(value);
}

function hasInvoiceContactFieldKeyword(value: string): boolean {
  return /\b(?:invoice e-?mail|invoiceemail|faktura(?:\s+|-)e-?mail|fakturaemail|e-?mail de fatura|email de fatura|e-?mail de factura|email de factura|e-?mail de facturation|email de facturation)\b/i.test(value);
}

function hasCustomerMasterDataSignal(value: string): boolean {
  return /\b(?:customer|kunde|client|cliente)\b/i.test(value) || hasSupplierSignal(value);
}

function hasTravelExpenseKeyword(value: string): boolean {
  return /\b(?:travel expense|reiseregning|reiserekning|gastos? de viaje|frais de voyage|reisekosten)\b/i.test(value);
}

function isReceiptExpenseVoucherPrompt(value: string): boolean {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  const hasReceiptSignal = /\b(?:receipt|recibo|kvittering|kvitteringa|beleg|recu|reçu)\b/i.test(lower);
  const hasExpenseSignal = /\b(?:expense|depense|dépense|despesa|utgift|kostnad|purchase|kjøp|kjop|compra|charge)\b/i.test(lower);
  const hasAccountingSignal = /\b(?:department|avdeling|departamento|abteilung|departement|d[ée]partement|mva|iva|vat|tva|account|konto|conta|compte|ledger)\b/i.test(lower);
  return hasReceiptSignal && hasExpenseSignal && hasAccountingSignal && !hasInvoiceKeyword(lower) && !hasTravelExpenseKeyword(lower);
}

function hasProjectKeyword(value: string): boolean {
  return /\b(?:project(?:s)?|prosjekt(?:et|er|ene)?|proyecto(?:s)?|projeto(?:s)?|projekt(?:e|en|et)?|projet(?:s)?)\b/i.test(value);
}

function hasProjectCycleKeyword(value: string): boolean {
  return /\b(?:project cycle|project lifecycle|project life cycle|full project cycle|complete project cycle|full project lifecycle|complete project lifecycle|prosjektsyklus|prosjektsyklusen|vollst[aä]ndigen projektzyklus|projet complet|cycle de projet|cycle de vie du projet|ciclo del proyecto|ciclo do projeto)\b/i.test(value);
}

function isProjectCyclePrompt(value: string): boolean {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  if (!hasProjectCycleKeyword(lower)) return false;
  return (
    hasProjectKeyword(lower)
    && /\b(?:budget|budsjett|presupuesto|orcamento|orçamento|hours?|timer|timar|heures?|horas?|stunden|invoice|faktura|facture|rechnung|fatura|payment|betaling|paiement|zahlung)\b/i.test(lower)
  );
}

function hasOrderKeyword(value: string): boolean {
  return /\b(?:order|ordre|bestilling|pedido|commande|bestellung|auftrag)\b/i.test(value);
}

function hasInvoiceKeyword(value: string): boolean {
  return /\b(?:invoice|faktura|factura|fatura|rechnung|facture)\b/i.test(value);
}

function hasSupplierInvoiceKeyword(value: string): boolean {
  return /\b(?:supplier invoice|incoming invoice|leverand(?:ø|o)rfaktura(?:en)?|purchase invoice|vendor invoice|fournisseur facture|facture fournisseur|fatura d[oe] fornecedor|factura d(?:el|e) proveedor)\b/i.test(value);
}

function hasInputVatKeyword(value: string): boolean {
  return /\b(?:inng[åa]ende mva|input vat|input tax|incoming vat|iva soportado|tva d['’]entr[ée]e)\b/i.test(value);
}

function isSupplierInvoicePrompt(value: string): boolean {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  return (
    hasSupplierInvoiceKeyword(lower)
    || (
      hasSupplierSignal(lower)
      && hasInvoiceKeyword(lower)
      && (hasInputVatKeyword(lower) || /\b(?:register|registrer|bokf[øo]r|book|record)\b/i.test(lower))
    )
  );
}

function hasPaymentKeyword(value: string): boolean {
  return /\b(?:pay(?:ment)?|betal(?:ing(?:en|a)?)?|register payment|registrer betaling(?:en|a)?|pago|pagamento|zahlung|paiement)\b/i.test(value);
}

function hasInvoiceReminderKeyword(value: string): boolean {
  return /\b(?:reminder(?: fee)?|late fee|payment reminder|soft reminder|betalingsp[aå]minnelse|purring|purregebyr|inkassovarsel|notice of debt collection|taxa de lembrete|frais de rappel|rappel|mahnung)\b/i.test(value);
}

function isInvoiceReminderPrompt(value: string): boolean {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  if (!hasInvoiceReminderKeyword(lower)) return false;
  return (
    hasInvoiceKeyword(lower)
    || /\b(?:overdue|forfalt|forfallen|forfalte|utest[aå]ende|impay[ée]e?|past due|late payment)\b/i.test(lower)
  );
}

function deriveReminderTypeFromPrompt(value: string): "SOFT_REMINDER" | "REMINDER" | "NOTICE_OF_DEBT_COLLECTION" {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  if (/\b(?:inkassovarsel|notice of debt collection|avis de recouvrement|aviso de cobran[cç]a)\b/i.test(lower)) {
    return "NOTICE_OF_DEBT_COLLECTION";
  }
  if (/\b(?:reminder fee|late fee|purregebyr|purring|taxa de lembrete|frais de rappel|mahnung)\b/i.test(lower)) {
    return "REMINDER";
  }
  return "SOFT_REMINDER";
}

function extractReminderFeeAmount(prompt: string): number | null {
  const match = prompt.match(
    /(?:reminder fee|late fee|purregebyr\w*|taxa de lembrete|frais de rappel)[^\d]{0,20}(\d[\d .,'’]*)/i,
  ) ?? prompt.match(
    /(\d[\d .,'’]*)\s*(?:nok|kr|kroner)[^.\n,;:]{0,18}(?:reminder fee|late fee|purregebyr\w*|taxa de lembrete|frais de rappel)/i,
  );
  return parseFlexibleNumber(match?.[1]);
}

function wantsReminderFeeInvoice(prompt: string): boolean {
  return /\b(?:create|opprett|lag|registrer|cr[ée]ez|crear|criar|erstell(?:e|en)?)\b[\s\S]{0,120}\b(?:invoice|faktura|facture|factura|fatura|rechnung)\b[\s\S]{0,40}\b(?:for|på|de|des|for the|para|pour|f[üu]r)\b[\s\S]{0,40}\b(?:reminder fee|late fee|purregebyr\w*|frais de rappel|taxa de lembrete|mahnung)\b/i.test(prompt);
}

function wantsReminderFeeInvoiceSend(prompt: string): boolean {
  return wantsReminderFeeInvoice(prompt)
    && /\b(?:send|sende|send den|send it|envoyer|envoyez|mandar|enviar|schicken)\b/i.test(prompt);
}

function looksLikeSpuriousReminderCustomerName(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /^(?:og|and|e|et|y|und)\s+(?:send|sende|envoy(?:er|ez)|enviar|mandar|schicken)\b/i.test(text)
    || /^(?:send|sende|envoy(?:er|ez)|enviar|mandar|schicken)\b/i.test(text)
    || /\b(?:purregebyr\w*|reminder fee|late fee|frais de rappel|taxa de lembrete|mahnung)\b/i.test(text)
    || /\b\d+(?:[.,]\d+)?\s*(?:kr|nok|eur|usd)\b/i.test(text);
}

function looksLikeInvoiceIdentifier(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(?:forfalt|forfallen|vencida|vencido|overdue|impayee?|ouverte|offene?)$/i.test(trimmed)) return false;
  if (/^\d{3,}$/.test(trimmed)) return true;
  if (/[A-Za-z]/.test(trimmed) && /\d/.test(trimmed)) return true;
  return /[-/]/.test(trimmed) && /[A-Za-z0-9]/.test(trimmed);
}

function extractLookupId(prompt: string): { id: number } | undefined {
  const patterns = [
    /(?:^|\b)id\s*[:#-]?\s*(\d{3,})\b/i,
    /(?:employee|ansatt|customer|kunde|client|supplier|leverand(?:ø|o)r|product|produkt|department|avdeling|project|prosjekt|order|ordre|invoice|faktura|facture|fatura|rechnung|travel\s*expense|reiseregning|voucher|bilag)\s*(?:id|number|nr|no|n[oº°])\s*[:#-]?\s*(\d{3,})\b/i,
    /(?:delete|remove|update|modify|reverse|pay|settle|registrer|register|oppdater|slett|supprimer|annuler|pagar|bezahlen)\s+(?:employee|customer|supplier|project|order|invoice|travel\s*expense|voucher|bilag|reiseregning)\s+(\d{3,})\b/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const numeric = Number(match?.[1] ?? "");
    if (Number.isInteger(numeric) && numeric > 0) {
      return { id: numeric };
    }
  }
  return undefined;
}

function hasBankReconciliationKeyword(value: string): boolean {
  return /\b(?:bank reconciliation|bank statement|bank match(?:ing)?|reconcile(?:ment)?|relev[eé] bancaire|releve bancaire|kontoavstemming|bankavstemming|bankabstimmung|conciliaci[oó]n bancaria|concilia[cç][aã]o banc[aá]ria|extracto bancario|kontoauszug|kontoutskrift|concilia el extracto bancario|gleichen sie den kontoauszug)\b/i.test(value);
}

function hasLedgerVarianceKeyword(value: string): boolean {
  return /\b(?:general ledger|ledger postings?|ledger entries|hovedbok|hovedboks(?:poster|posteringer)?|grand livre|livro raz[aã]o|libro mayor|hauptbuch|expense accounts?|expense account increases?|cost accounts?|cost increase|costs have increased|total costs(?: have)? increased|costos totales(?: aumentaron| han aumentado)?|cuentas? de gastos?|incremento en monto|mayor incremento|kont(?:o|i) de despesa|contas? de despesa|aufwandskonten?|comptes? de charge|maior aumento|largest increase|biggest increase|grö[sß]ten anstieg|deutlich gestiegen)\b/i.test(value);
}

function hasLedgerErrorCorrectionKeyword(value: string): boolean {
  return /\b(?:general ledger audit|review all vouchers|find the \d+ errors|find \d+ errors|find dei \d+ feila|correct the errors|voucher errors?|ledger errors?|wrong account|duplicate voucher|missing vat|audit note|hauptbuchprufung|hauptbuchprüfung|fehlerhafte belege|fehler im hauptbuch|uberprufen sie alle belege|überprüfen sie alle belege|finden sie die \d+ fehler|korrigier(?:en|t)?|prufnotiz|prüfnotiz|prufvermerk|prüfvermerk|falsches konto|doppelter beleg|duplikatbeleg|fehlende mwst|fehlende ust|corriger les erreurs|erros no raz[aã]o|corrija os erros|feil i hovedboken|feil i hovudboka|rett feilene|rett opp feila|gå gjennom alle bilag|ga gjennom alle bilag|finn dei \d+ feila|feil konto|duplikat bilag|manglande mva)\b/i.test(value);
}

function isLedgerErrorCorrectionPrompt(value: string): boolean {
  const lower = stripEmailsForKeywordDetection(value.toLowerCase());
  if (hasLedgerErrorCorrectionKeyword(lower)) return true;
  return (
    /\b(?:general ledger|hovedbok|hauptbuch|grand livre|livro raz[aã]o)\b/i.test(lower)
    && /\b(?:errors?|feil|fehler|erros?|erreurs?)\b/i.test(lower)
    && /\b(?:correct|repair|fix|rett|korriger|korrigieren|corriger|corrija|beheben)\b/i.test(lower)
  );
}

function hasInternalProjectKeyword(value: string): boolean {
  return /\b(?:internal project|internt prosjekt|internprosjekt|projeto interno|proyecto interno|internes projekt|projet interne)\b/i.test(value);
}

function hasMonthEndClosingKeyword(value: string): boolean {
  return /\b(?:month[- ]end closing|month end close|period close|closing entries|cl[oô]ture mensuelle|cloture mensuelle|m[åa]nedsavslutning|periodestenging|monatsabschluss|cierre mensual|fechamento mensal|encerramento mensal)\b/i.test(value);
}

function hasAttachmentSignal(prompt: string, files?: SolveRequest["files"]): boolean {
  const promptSignal = /\b(?:attached|attachment|attaché|vedlagt|adjunto|anexo|anexo|pdf|document|contract)\b/i.test(prompt);
  const fileSignal = Array.isArray(files) && files.some((file) => {
    const filename = String(file.filename ?? "").toLowerCase();
    const mimeType = String(file.mime_type ?? "").toLowerCase();
    return filename.endsWith(".pdf")
      || filename.endsWith(".png")
      || filename.endsWith(".jpg")
      || filename.endsWith(".jpeg")
      || mimeType.includes("pdf")
      || mimeType.startsWith("image/")
      || mimeType === "text/plain";
  });
  return promptSignal || fileSignal;
}

function hasAttachmentOnboardingKeyword(value: string): boolean {
  return /\b(?:onboarding|new employee|new hire|offer letter|employment contract|work contract|arbeidskontrakt|arbeidsavtale|tilbudsbrev|employment offer|carta de oferta|carta de oferta de emprego|offerbrev|lettre d[' ]offre|lettre d[' ]embauche|contrat de travail|contrato de trabajo|contrato de trabalho|contrato laboral|novo funcionario|novo funcionário|nouvel employe|nouvel employé|nuevo empleado|novo empregado|arbeitsvertrag|angebotsschreiben|neuer mitarbeiter|neuen mitarbeiter|neue mitarbeiterin)\b/i.test(value);
}

function isAttachmentOnboardingPrompt(prompt: string, files?: SolveRequest["files"]): boolean {
  const sanitized = stripEmailsForKeywordDetection(prompt.toLowerCase());
  if (!hasAttachmentSignal(prompt, files)) return false;
  if (hasAttachmentOnboardingKeyword(sanitized)) return true;
  const hasEmploymentSignal = /\b(?:start date|employment date|employment|salary|l[øo]nn|stillingsprosent|occupation code|yrkeskode|national identity|f[øo]dselsnummer|department|avdeling|user access|brukertilgang|brukeradgang|data de inicio|data de in[íi]cio|data de nascimento|numero de identificacao|n[úu]mero de identifica[cç][aã]o|conta banc[áa]ria|codigo de profiss[aã]o|c[oó]digo de profiss[aã]o|percentagem de emprego|sal[aá]rio anual|acesso de utilizador|acesso do utilizador|date de debut|date de naissance|numero d[' ]identite|code profession|salaire annuel|d[ée]partement|compte bancaire|pourcentage d[' ]emploi|acc[eè]s utilisateur|berufsschluessel|berufsschlussel|besch[aä]ftigungsgrad|jahresgehalt|abteilung|benutzerzugang|eintrittsdatum|gehalt)\b/i.test(sanitized);
  return hasEmployeeSignal(sanitized) && hasEmploymentSignal;
}

function hasYearEndClosingKeyword(value: string): boolean {
  return /\b(?:year[- ]end closing|year end close|annual closing|annual close|closing the year|forenkla [aå]rsoppgjer|forenklet [aå]rsoppgj[øo]r|[aå]rsoppgj[øo]r|year[- ]end accounts?|annual accounts?|jahresabschluss|cierre anual|fechamento anual|encerramento anual|cl[oô]ture annuelle|cloture annuelle)\b/i.test(value);
}

function hasAccrualKeyword(value: string): boolean {
  return /\b(?:accrual reversal|reverse accrual|periodisering(?:s)?reversering|periodiseringsreversering|reversering av periodisering|extourne|reversi[oó]n de provisi[oó]n|revers[aã]o de provis[aã]o|revers[aã]o de acr[eé]scimos|provis[aã]o salarial)\b/i.test(value);
}

function hasDepreciationKeyword(value: string): boolean {
  return /\b(?:depreciation|depreciation expense|avskrivning|amortissement|amortizacao|amortiza[cç][aã]o|deprecia[cç][aã]o)\b/i.test(value);
}

function hasMonthReference(value: string): boolean {
  return /\b(?:january|januar|janvier|enero|janeiro|february|februar|fevrier|febrero|fevereiro|march|mars|marz|marzo|mar[cç]o|april|avril|abril|may|mai|mayo|maio|june|juni|juin|junio|junho|july|juli|juillet|julio|julho|august|aout|agosto|september|septembre|septiembre|setembro|october|oktober|octobre|octubre|outubro|november|novembre|noviembre|december|desember|decembre|diciembre|dezembro)\b/i.test(value);
}

function hasCsvAttachment(files: SolveRequest["files"] | undefined): boolean {
  return Array.isArray(files) && files.some((file) => {
    const filename = String(file.filename ?? "").toLowerCase();
    const mimeType = String(file.mime_type ?? "").toLowerCase();
    return filename.endsWith(".csv") || mimeType === "text/csv" || mimeType === "application/csv";
  });
}

function isBankReconciliationPrompt(prompt: string, files?: SolveRequest["files"]): boolean {
  const sanitized = stripEmailsForKeywordDetection(prompt.toLowerCase());
  if (hasBankReconciliationKeyword(sanitized)) return true;
  if (!hasCsvAttachment(files)) return false;
  const mentionsInvoiceState =
    hasInvoiceKeyword(sanitized)
    || hasSupplierInvoiceKeyword(sanitized)
    || /\b(?:open invoices?|factures ouvertes|offene rechnungen|facturas abiertas|u[åa]pne faktura(?:er)?|faturas? em aberto)\b/i.test(sanitized);
  const mentionsMatching =
    hasPaymentKeyword(sanitized)
    || /\b(?:associate|match|associer|zuordnen|koble|concile|concilia|matcha|relaciona|ordnet|ordnen)\b/i.test(sanitized);
  const mentionsBankRows =
    /\b(?:extracto bancario|kontoauszug|kontoutskrift|pagos entrantes|pagos salientes|eingehende zahlungen|ausgehende zahlungen|pagos parciales|teilzahlungen|seguimiento manual|manuellen nachverfolgung|manual follow-up)\b/i.test(sanitized);
  return mentionsInvoiceState && (mentionsMatching || mentionsBankRows);
}

function isLedgerVarianceProjectsPrompt(prompt: string): boolean {
  const sanitized = stripEmailsForKeywordDetection(prompt.toLowerCase());
  const hasRankingSignal =
    /\b(?:top\s*\d+|top\b|largest|highest|biggest|major(?:est)?|maior(?:es)?|gr[öo][sß]ten?|principales?)\b/i.test(sanitized)
    || /\b(?:for each|para cada|pour chaque|f[üu]r jedes|for kvar|for each of them)\b/i.test(sanitized);
  const hasMonthComparison = /\b20\d{2}\b/.test(sanitized) && hasMonthReference(sanitized);
  return hasInternalProjectKeyword(sanitized) && hasLedgerVarianceKeyword(sanitized) && (hasRankingSignal || hasMonthComparison);
}

function isMonthEndClosingPrompt(prompt: string): boolean {
  const sanitized = stripEmailsForKeywordDetection(prompt.toLowerCase());
  if (hasMonthEndClosingKeyword(sanitized) || hasYearEndClosingKeyword(sanitized)) return true;
  const hasClosingSignals = hasAccrualKeyword(sanitized) || hasDepreciationKeyword(sanitized);
  return hasClosingSignals && (/\b20\d{2}\b/.test(sanitized) || hasMonthReference(sanitized));
}

function extractPartyReference(prompt: string): string | null {
  const patterns = [
    /(?:customer|kunden|kunde|client|cliente|supplier|leverand(?:ø|o)ren?|fornecedor|fournisseur|proveedor)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{1,120}?)(?:\s+(?:with|med|com|con|num(?:ero)?|n(?:o|º|°)?|organization|organisasjon|organisasjonsnummer|organiza[cç][ãa]o|org\.?|address|adresse|endere[cç]o|e-?mail)|\s*\(|[.,\n]|$)/i,
    /(?:opprett|create|crie|crear|créez|registrer|registre|registe|erstellen(?:\s+sie)?|erstelle)\s+(?:den|die|das|der|el|la|le|les|o|a)?\s*(?:kunden|kunde|customer|client|cliente|supplier|leverand(?:ø|o)ren?|fornecedor|fournisseur|proveedor)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{1,120}?)(?:\s+(?:with|med|com|con|num(?:ero)?|n(?:o|º|°)?|organization|organisasjon|organisasjonsnummer|organiza[cç][ãa]o|org\.?|address|adresse|endere[cç]o|e-?mail)|\s*\(|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = cleanPartyNameCandidate(prompt.match(pattern)?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractSupplierReference(prompt: string): string | null {
  const labeled = extractLabeledValue(
    prompt,
    /^(?:supplier|leverand(?:ø|o)r|fornecedor|fournisseur|proveedor)\s*:?\s*([^\n,;()]+)$/i,
  );
  if (labeled) return labeled.replace(/^(?:leverand(?:ø|o)ren?|supplier|fornecedor|fournisseur|proveedor)\s+/i, "").trim();
  const patterns = [
    /(?:supplier|leverand(?:ø|o)ren?|fornecedor|fournisseur|proveedor)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{1,120}?)(?:\s+(?:with|med|com|con|num(?:ero)?|n(?:o|º|°)?|organization|organisasjon|organisasjonsnummer|organiza[cç][ãa]o|org\.?)|\s*\(|[.,\n]|$)/i,
    /(?:do fornecedor|de fornecedor|del proveedor|du fournisseur)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{1,120}?)(?:\s+(?:with|med|com|con|num(?:ero)?|n(?:o|º|°)?|organization|organisasjon|organisasjonsnummer|organiza[cç][ãa]o|org\.?)|\s*\(|[.,\n]|$)/i,
    /(?:fra|from)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{1,120}?)(?:\s*\((?:org|org\.|organization|organisasjon)[^)]+\)|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = cleanPartyNameCandidate(prompt.match(pattern)?.[1]);
    if (candidate) {
      return candidate.replace(/^(?:leverand(?:ø|o)ren?|supplier|fornecedor|fournisseur|proveedor)\s+/i, "").trim();
    }
  }
  return null;
}

function extractPostalAddress(prompt: string): { address?: string; postalCode?: string; city?: string } {
  const patterns = [
    /(?:address|adresse|endere[cç]o|direcci[oó]n)\s*(?:(?:ist|est|is|er|es|é)(?=\s|[:\-]))?\s*[:\-]?\s*([^,\n]+),\s*(\d{4,5})\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.\- ]+?)(?:[.,\n]|$)/i,
    /\b([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.\- ]+\d[A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.\- ]*),\s*(\d{4,5})\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.\- ]+?)(?:[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const address = match?.[1]?.trim();
    const postalCode = match?.[2]?.trim();
    const city = match?.[3]?.trim();
    if (address && postalCode && city) {
      return { address, postalCode, city };
    }
  }
  return {};
}

function extractReceiptExpenseLabel(prompt: string): string | null {
  const patterns = [
    /(?:expense|despesa|utgift|kostnad)\s+(?:of|de|da|do|for|fra)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.\- ]{1,80}?)(?:\s+(?:from|fra|deste|desta)\s+(?:this\s+)?(?:receipt|recibo|kvittering|kvitteringa)|[.,\n]|$)/i,
    /(?:depense|dépense)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.\- ]{1,80}?)(?:\s+de\s+ce\s+(?:recu|reçu)|\s+du\s+(?:recu|reçu)|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim().replace(/[.,;:]$/g, "");
    if (candidate) return candidate;
  }
  return null;
}

function cleanPartyNameCandidate(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(
      /\s+(?:with|med|mit|com|con|avec|org(?:anization)?(?:\s+number)?|organisasjonsnummer|organiza[cç][ãa]o|organizaci[oó]n|organisation|num(?:ero)?\s+de\s+organizaci[oó]n|num[eé]ro d['’]organisation|address|adresse|endere[cç]o|direcci[oó]n|correo|email|e-?mail)\b.*$/iu,
      "",
    )
    .replace(/[.,;:]$/g, "")
    .replace(/^(?:de|da|do|del|du|des)\s+/i, "")
    .trim();
  return cleaned || null;
}

function extractExplicitPromptName(prompt: string): string | null {
  const patterns = [
    /(?:navn|name|med\s+navn|heter|kalt|called|named|chamad[oa]|nomm?[ée])\s+(?:er\s+)?["'""]?([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’-]+)*(?:\s+(?:AS|ANS|DA|ASA|SA|AB|GmbH|Ltd|LLC|Inc))?)["'""]?/i,
    /\b([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’-]+)+(?:\s+(?:AS|ANS|DA|ASA))?)\b/,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (!candidate) continue;
    const noiseWords = ["Opprett", "Registrer", "Create", "Update", "Delete", "Slett", "Endre", "Lag"];
    if (!noiseWords.includes(candidate.split(/\s+/)[0]!)) {
      return candidate;
    }
  }
  return null;
}

export function normalizeTaskSpec(payload: SolveRequest, spec: TaskSpec): TaskSpec {
  const next: TaskSpec = {
    ...spec,
    values: { ...(spec.values ?? {}) },
    lookup: spec.lookup ? { ...spec.lookup } : spec.lookup,
  };
  const values = next.values as Record<string, unknown>;
  const quotedSegments = extractQuotedSegments(payload.prompt);
  const semanticPrompt = buildSemanticAugmentedText(payload.prompt);
  const extractionText = buildExtractionText(semanticPrompt, next.attachment_facts);
  const heuristicValues = extractValues(extractionText);

  if (isAttachmentOnboardingPrompt(payload.prompt, payload.files)) {
    next.operation = "create";
    next.entity = "attachment_onboarding";
    delete values.date;
    delete values.startDate;
    delete values.endDate;
    delete values.amount;
    delete values.accountNumber;
    delete values.customerName;
    delete values.description;
    const heuristicName =
      typeof heuristicValues.name === "string" && heuristicValues.name.trim() && looksLikePersonName(heuristicValues.name.trim())
        ? heuristicValues.name.trim()
        : undefined;
    const nameCandidate =
      extractOfferLetterName(extractionText)
      ?? extractEmployeeReference(extractionText)
      ?? heuristicName;
    if (typeof nameCandidate === "string" && nameCandidate.trim()) {
      values.name = nameCandidate.trim();
    }
    if (!values.email && typeof heuristicValues.email === "string" && heuristicValues.email.trim()) {
      values.email = heuristicValues.email.trim();
    }
    if (!values.dateOfBirth && typeof heuristicValues.dateOfBirth === "string" && heuristicValues.dateOfBirth.trim()) {
      values.dateOfBirth = heuristicValues.dateOfBirth.trim();
    }
    if (!values.employmentDate && typeof heuristicValues.employmentDate === "string" && heuristicValues.employmentDate.trim()) {
      values.employmentDate = heuristicValues.employmentDate.trim();
    }
    if (!values.nationalIdentityNumber && typeof heuristicValues.nationalIdentityNumber === "string" && heuristicValues.nationalIdentityNumber.trim()) {
      values.nationalIdentityNumber = heuristicValues.nationalIdentityNumber.trim();
    }
    if (!values.bankAccountNumber && typeof heuristicValues.bankAccountNumber === "string" && heuristicValues.bankAccountNumber.trim()) {
      values.bankAccountNumber = heuristicValues.bankAccountNumber.trim();
    }
    if (!values.departmentName && typeof heuristicValues.departmentName === "string" && heuristicValues.departmentName.trim()) {
      values.departmentName = heuristicValues.departmentName.trim();
    }
    if (!values.occupationCode && typeof heuristicValues.occupationCode === "string" && heuristicValues.occupationCode.trim()) {
      values.occupationCode = heuristicValues.occupationCode.trim();
    }
    if (values.employmentPercentage == null && typeof heuristicValues.employmentPercentage === "number" && heuristicValues.employmentPercentage > 0) {
      values.employmentPercentage = heuristicValues.employmentPercentage;
    }
    if (values.annualSalary == null && typeof heuristicValues.annualSalary === "number" && heuristicValues.annualSalary > 0) {
      values.annualSalary = heuristicValues.annualSalary;
    }
    if (values.monthlySalary == null && typeof heuristicValues.monthlySalary === "number" && heuristicValues.monthlySalary > 0) {
      values.monthlySalary = heuristicValues.monthlySalary;
    }
    if (!values.userType && typeof heuristicValues.userType === "string" && heuristicValues.userType.trim()) {
      values.userType = heuristicValues.userType.trim().toUpperCase();
    }
    if (values.userAccessRequested == null && heuristicValues.userAccessRequested === true) {
      values.userAccessRequested = true;
    }
    if (!values.address && typeof heuristicValues.address === "string" && heuristicValues.address.trim()) {
      values.address = heuristicValues.address.trim();
    }
    if (!values.postalCode && typeof heuristicValues.postalCode === "string" && heuristicValues.postalCode.trim()) {
      values.postalCode = heuristicValues.postalCode.trim();
    }
    if (!values.city && typeof heuristicValues.city === "string" && heuristicValues.city.trim()) {
      values.city = heuristicValues.city.trim();
    }
    if (!values.firstName && typeof values.name === "string" && values.name.trim()) {
      values.firstName = splitName(values.name as string).firstName;
    }
    if (!values.lastName && typeof values.name === "string" && values.name.trim()) {
      values.lastName = splitName(values.name as string).lastName;
    }
    return next;
  }

  if (isBankReconciliationPrompt(semanticPrompt, payload.files)) {
    next.operation = "create";
    next.entity = "bank_reconciliation";
    if (!values.date && typeof heuristicValues.date === "string" && heuristicValues.date.trim()) {
      values.date = heuristicValues.date.trim();
    }
    return next;
  }

  if (isLedgerVarianceProjectsPrompt(semanticPrompt)) {
    next.operation = "create";
    next.entity = "ledger_variance_projects";
    if (!values.topCount && typeof heuristicValues.topCount === "number" && heuristicValues.topCount > 0) {
      values.topCount = heuristicValues.topCount;
    }
    return next;
  }

  if (isLedgerErrorCorrectionPrompt(semanticPrompt)) {
    next.operation = "create";
    next.entity = "ledger_error_correction";
    return next;
  }

  if (isProjectCyclePrompt(semanticPrompt)) {
    next.operation = "create";
    next.entity = "project_cycle";
    const quotedProjectName = quotedSegments[0]?.trim();
    if (quotedProjectName) {
      values.projectName = quotedProjectName;
      values.name = quotedProjectName;
    } else if (!values.projectName && typeof values.name === "string" && values.name.trim()) {
      values.projectName = values.name.trim();
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.customerName) {
      const inlineCustomer = semanticPrompt.match(/\(([^()]+?)\s*,\s*(?:org(?:\.|-)?\s*(?:nr|no|nummer|number)?|n[º°o]\s*org\.?)\s*\.?\s*\d{9}\)/i)?.[1]?.trim();
      if (inlineCustomer) values.customerName = inlineCustomer;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.projectManagerName && heuristicValues.projectManagerName) {
      values.projectManagerName = heuristicValues.projectManagerName;
    }
    if (!values.projectManagerEmail && heuristicValues.projectManagerEmail) {
      values.projectManagerEmail = heuristicValues.projectManagerEmail;
    }
    const budgetAmount = extractFixedPriceAmountFromPrompt(extractionText) ?? parseFlexibleNumber(String(heuristicValues.amount ?? ""));
    if (values.budgetAmount == null && budgetAmount !== null && budgetAmount > 0) {
      values.budgetAmount = budgetAmount;
    }
    return next;
  }

  if (isMonthEndClosingPrompt(semanticPrompt)) {
    next.operation = "create";
    next.entity = "month_end_closing";
    if (!values.date && typeof heuristicValues.date === "string" && heuristicValues.date.trim()) {
      values.date = heuristicValues.date.trim();
    }
    return next;
  }

  if (isInvoiceReminderPrompt(semanticPrompt)) {
    next.operation = "create";
    next.entity = "invoice_reminder";
    if (!values.reminderType) {
      values.reminderType = deriveReminderTypeFromPrompt(semanticPrompt);
    }
    if (values.includeReminderCharge == null) {
      values.includeReminderCharge = values.reminderType !== "SOFT_REMINDER";
    }
    if (values.includeReminderInterests == null) {
      values.includeReminderInterests = values.reminderType !== "SOFT_REMINDER";
    }
    const reminderFeeAmount = extractReminderFeeAmount(extractionText);
    if (values.reminderFeeAmount == null && reminderFeeAmount !== null) {
      values.reminderFeeAmount = reminderFeeAmount;
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.customerName && typeof values.name === "string" && values.name.trim()) {
      values.customerName = values.name.trim();
    }
    if (looksLikeSpuriousReminderCustomerName(values.customerName)) {
      delete values.customerName;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.invoiceNumber && heuristicValues.invoiceNumber) {
      values.invoiceNumber = heuristicValues.invoiceNumber;
    }
    if (!values.reminderEmail && typeof heuristicValues.email === "string" && heuristicValues.email.trim()) {
      values.reminderEmail = heuristicValues.email.trim();
    }
    if (!values.date && typeof heuristicValues.date === "string" && heuristicValues.date.trim()) {
      values.date = heuristicValues.date.trim();
    }
    if (!values.amount && typeof heuristicValues.amount === "number" && heuristicValues.amount > 0) {
      values.amount = heuristicValues.amount;
    }
    if (typeof values.organizationNumber === "string" && String(next.lookup?.id ?? "") === values.organizationNumber) {
      delete next.lookup?.id;
    }
    if (!looksLikeInvoiceIdentifier(typeof values.invoiceNumber === "string" ? values.invoiceNumber : undefined)) {
      delete values.invoiceNumber;
    }
    if (typeof values.reminderFeeAmount === "number" && typeof values.amount === "number" && Math.abs(values.reminderFeeAmount - values.amount) < 0.05) {
      delete values.amount;
    }
    if ((values as Record<string, unknown>).createReminderFeeInvoice == null && wantsReminderFeeInvoice(semanticPrompt)) {
      (values as Record<string, unknown>).createReminderFeeInvoice = true;
    }
    if ((values as Record<string, unknown>).sendReminderFeeInvoice == null && wantsReminderFeeInvoiceSend(semanticPrompt)) {
      (values as Record<string, unknown>).sendReminderFeeInvoice = true;
    }
    return next;
  }

  if (
    isSupplierInvoicePrompt(semanticPrompt)
    && (
      next.operation === "create"
      || payload.files.length > 0
      || /\b(?:register|registrer|book|bokf[øo]r|record|create|opprett|crear|criar|créez)\b/i.test(semanticPrompt)
    )
  ) {
    next.operation = "create";
    next.entity = "supplier_invoice";
    values.isSupplier = true;
  }

  if (next.operation === "create" && next.entity !== "supplier_invoice" && hasSupplierSignal(semanticPrompt)) {
    next.entity = "supplier";
    values.isSupplier = true;
  }

  if (
    next.operation === "create"
    && hasCustomerMasterDataSignal(semanticPrompt)
    && !hasEmployeeSignal(semanticPrompt)
    && !hasEmployeeFieldSignal(semanticPrompt)
    && !isSupplierInvoicePrompt(semanticPrompt)
    && !hasSupplierSignal(semanticPrompt)
    && !hasInvoiceKeyword(stripEmailsForKeywordDetection(semanticPrompt.toLowerCase()))
    && !hasProjectKeyword(stripEmailsForKeywordDetection(semanticPrompt.toLowerCase()))
    && !hasOrderKeyword(stripEmailsForKeywordDetection(semanticPrompt.toLowerCase()))
  ) {
    next.entity = "customer";
  }

  if (
    next.operation === "create"
    && next.entity === "customer"
    && (
      hasEmployeeSignal(semanticPrompt)
      || hasEmployeeFieldSignal(semanticPrompt)
      || typeof values.dateOfBirth === "string"
      || typeof values.employmentDate === "string"
      || typeof values.nationalIdentityNumber === "string"
      || typeof values.occupationCode === "string"
      || typeof values.bankAccountNumber === "string"
      || typeof values.annualSalary === "number"
      || typeof values.monthlySalary === "number"
      || typeof values.employmentPercentage === "number"
    )
  ) {
    next.entity = "employee";
  }

  if (
    next.operation === "create"
    && hasProjectKeyword(semanticPrompt)
    && !isFixedPriceMilestonePrompt(semanticPrompt)
    && !isProjectTimeInvoicePrompt(semanticPrompt)
  ) {
    next.entity = "project";
    if (!values.projectName) {
      values.projectName =
        quotedSegments[0]
        ?? (typeof values.name === "string" && values.name.trim().length > 0 ? values.name : undefined)
        ?? heuristicValues.projectName;
    }
    if (typeof values.projectName === "string" && values.projectName.trim()) {
      values.name = values.projectName.trim();
    }
  }

  if (
    next.operation === "pay_invoice"
    && !isReturnedPaymentReversalPrompt(semanticPrompt)
    && (
      hasInvoiceKeyword(semanticPrompt)
      || values.postExchangeDifference === true
      || typeof values.currencyCode === "string"
    )
  ) {
    next.entity = "invoice";
    if (looksLikePaymentStatusPhrase(values.customerName)) {
      delete values.customerName;
    }
    if (looksLikePaymentStatusPhrase(values.name)) {
      delete values.name;
    }
    if (!values.customerName) {
      const customerDirectionalMatch = semanticPrompt.match(
        /(?:til|to|for|para|pour|f[üu]r)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)(?:\s*\((?:org|org\.|organization|organisasjon|organisasjonsnummer|organisationsnummer|n[º°o]\s*org\.?)[^)]+\)|[.,\n]|$)/i,
      );
      const customerDirectionalName = cleanPartyNameCandidate(customerDirectionalMatch?.[1]);
      const fallbackCustomerName = customerDirectionalName || extractPartyReference(semanticPrompt);
      if (fallbackCustomerName && fallbackCustomerName.length >= 2) {
        values.customerName = fallbackCustomerName;
        if (!values.name) values.name = fallbackCustomerName;
      }
    }
  }

  if (
    next.operation === "create"
    && hasOrderKeyword(semanticPrompt)
    && hasInvoiceKeyword(semanticPrompt)
  ) {
    next.entity = "invoice";
    if (hasPaymentKeyword(semanticPrompt)) {
      values.registerPayment = true;
    }
  }

  if (next.operation === "create" && next.entity === "department") {
    const existingNames = Array.isArray(values.names)
      ? values.names.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (quotedSegments.length > 1) {
      const merged = existingNames.length > 1 ? existingNames : quotedSegments;
      const normalizedNames = [...new Set(merged)];
      values.names = normalizedNames;
      values.name = normalizedNames[0] ?? values.name;
    } else if (!values.name && quotedSegments[0]) {
      values.name = quotedSegments[0];
    }
  }

  if (next.entity === "employee") {
    if (!values.email && typeof heuristicValues.email === "string" && heuristicValues.email.trim()) {
      values.email = heuristicValues.email.trim();
    }
    if (!values.dateOfBirth && typeof heuristicValues.dateOfBirth === "string" && heuristicValues.dateOfBirth.trim()) {
      values.dateOfBirth = heuristicValues.dateOfBirth.trim();
    }
    if (!values.employmentDate && typeof heuristicValues.employmentDate === "string" && heuristicValues.employmentDate.trim()) {
      values.employmentDate = heuristicValues.employmentDate.trim();
    }
    const employeeName = extractEmployeeReference(payload.prompt);
    if (!values.name && employeeName) {
      values.name = employeeName;
    }
    const explicitEmployeeName = extractExplicitPromptName(payload.prompt);
    const currentEmployeeName = typeof values.name === "string" ? values.name.trim() : "";
    if (
      explicitEmployeeName
      && (!currentEmployeeName || foldSemanticText(currentEmployeeName) === foldSemanticText(explicitEmployeeName))
    ) {
      values.name = explicitEmployeeName;
    }
    const canonicalEmployeeName = [values.firstName, values.lastName]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (canonicalEmployeeName) {
      const currentName = typeof values.name === "string" ? values.name.trim() : "";
      if (!currentName || !textContains(currentName, canonicalEmployeeName)) {
        values.name = canonicalEmployeeName;
      }
    }
  }

  if (next.entity === "voucher" && next.operation === "create" && isReceiptExpenseVoucherPrompt(payload.prompt)) {
    values.receiptExpense = true;
    const receiptExpenseLabel = extractReceiptExpenseLabel(payload.prompt);
    if (receiptExpenseLabel) {
      if (!values.name) values.name = receiptExpenseLabel;
      if (!values.description) values.description = receiptExpenseLabel;
    }
  }

  if (next.entity === "accounting_dimension") {
    if (!values.dimensionName && quotedSegments[0]) {
      values.dimensionName = quotedSegments[0];
    }
    if (!Array.isArray(values.dimensionValues) || values.dimensionValues.length === 0) {
      const dimensionValues = quotedSegments.slice(1).map((item) => item.trim()).filter(Boolean);
      if (dimensionValues.length > 0) {
        values.dimensionValues = [...new Set(dimensionValues)];
      }
    }
    if (!values.dimensionValueName && Array.isArray(values.dimensionValues) && values.dimensionValues.length === 1) {
      values.dimensionValueName = values.dimensionValues[0];
    }
    const canonicalNames = [
      typeof values.dimensionName === "string" ? values.dimensionName.trim() : "",
      ...(Array.isArray(values.dimensionValues)
        ? values.dimensionValues.map((item) => String(item).trim())
        : []),
    ].filter(Boolean);
    if (canonicalNames.length > 0) {
      const normalizedNames = [...new Set(canonicalNames)];
      values.names = normalizedNames;
      values.name = normalizedNames[0];
    } else {
      delete values.names;
    }
  }

  if (next.entity === "travel_expense" && next.operation === "create") {
    if (!values.title && quotedSegments[0]) {
      values.title = quotedSegments[0];
    }
    const travelDays = extractTravelDays(payload.prompt);
    if (travelDays !== null) {
      values.travelDays = travelDays;
    }
    const perDiemRate = extractTravelPerDiemRate(payload.prompt);
    if (perDiemRate !== null) {
      values.perDiemRate = perDiemRate;
    }
    const costs = extractTravelExpenseCosts(payload.prompt);
    if (costs.length > 0) {
      values.costs = costs;
    }
    const employeeName = extractEmployeeReference(payload.prompt);
    if (!values.employeeName && employeeName) {
      values.employeeName = employeeName;
    }
    if (!values.name && employeeName) {
      values.name = employeeName;
    }
    if (
      typeof values.title === "string"
      && typeof values.name === "string"
      && values.name.trim() === values.title.trim()
      && typeof values.employeeName === "string"
      && values.employeeName.trim()
    ) {
      values.name = values.employeeName.trim();
    }
    const suspiciousDescription = typeof values.description === "string"
      && (
        (/\([A-Za-z0-9._%+-]+@/i.test(values.description) && !/\)/.test(values.description))
        || /\([A-Za-z0-9._%+-]*$/i.test(values.description)
      );
    if (suspiciousDescription && typeof values.title === "string" && values.title.trim()) {
      values.description = values.title.trim();
    }
    if (!values.description && typeof values.title === "string" && values.title.trim()) {
      values.description = values.title.trim();
    }
  }

  if (isPayrollPrompt(payload.prompt)) {
    next.operation = "create";
    next.entity = "salary_transaction";
    const payrollValues = extractPayrollValues(payload.prompt);
    for (const [key, value] of Object.entries(payrollValues)) {
      if (values[key] == null) values[key] = value;
    }
    if (typeof values.customerName === "string" && /\beste mes\b/i.test(values.customerName)) {
      delete values.customerName;
    }
    const explicitPayrollName =
      (typeof values.name === "string" && values.name.trim())
      || extractExplicitPromptName(payload.prompt)
      || extractEmployeeReference(payload.prompt);
    if (typeof explicitPayrollName === "string" && explicitPayrollName.trim()) {
      values.employeeName = explicitPayrollName.trim();
      values.name = explicitPayrollName.trim();
    }
    if (!values.employeeName && payrollValues.employeeName) {
      values.employeeName = payrollValues.employeeName;
    }
    if (!values.name && payrollValues.employeeName) {
      values.name = payrollValues.employeeName;
    }
  }

  if (isProjectTimeInvoicePrompt(payload.prompt)) {
    next.operation = "create";
    next.entity = "invoice";
    if (!values.projectName) {
      values.projectName = heuristicValues.projectName ?? extractProjectReference(payload.prompt);
    }
    if (!values.activityName) {
      values.activityName = heuristicValues.activityName ?? extractActivityReference(payload.prompt);
    }
    if (!values.description && values.activityName) {
      values.description = values.activityName;
    }
    const hours = extractHours(payload.prompt);
    if (values.hours == null && hours !== null) {
      values.hours = hours;
    }
    const hourlyRate = extractHourlyRate(payload.prompt);
    if (values.hourlyRate == null && hourlyRate !== null) {
      values.hourlyRate = hourlyRate;
    }
    if (values.price == null && values.hourlyRate != null) {
      values.price = values.hourlyRate;
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    const employeeName = extractEmployeeReference(payload.prompt);
    if (!values.employeeName && employeeName) {
      values.employeeName = employeeName;
    }
    if (!values.name && values.employeeName) {
      values.name = values.employeeName;
    }
    const suspiciousDescription = typeof values.description === "string"
      && /\([A-Za-z0-9._%+-]+@/i.test(values.description)
      && !/\)/.test(values.description);
    if (suspiciousDescription && values.activityName) {
      values.description = values.activityName;
    }
    const suspiciousProductName = typeof values.productName === "string"
      && /\([A-Za-z0-9._%+-]+@/i.test(values.productName)
      && !/\)/.test(values.productName);
    if (suspiciousProductName) {
      delete values.productName;
    }
    if (
      Array.isArray(values.invoiceLines)
      && values.invoiceLines.some((line) => {
        const record = line as Record<string, unknown>;
        const label = String(record.description ?? record.productName ?? "").trim();
        return /\([A-Za-z0-9._%+-]+@/i.test(label) && !/\)/.test(label);
      })
    ) {
      delete values.invoiceLines;
    }
    const numericHours = typeof values.hours === "number" ? values.hours : parseFlexibleNumber(String(values.hours ?? ""));
    const numericRate = typeof values.hourlyRate === "number"
      ? values.hourlyRate
      : typeof values.price === "number"
        ? values.price
        : parseFlexibleNumber(String(values.hourlyRate ?? values.price ?? ""));
    if (numericHours !== null && numericRate !== null) {
      values.amount = Math.round(numericHours * numericRate * 100) / 100;
    }
  }

  if (next.entity === "invoice") {
    const zeroVatPrompt = /\b(?:without vat|without mva|excluding vat|ekskl\.?\s*mva|uten mva|ohne mwst|ohne mehrwertsteuer|sans tva|hors tva|sin iva|sem iva)\b/i.test(payload.prompt);
    if (zeroVatPrompt && values.vatRate == null) {
      values.vatRate = 0;
    }
    if (hasInvoiceSendIntent(payload.prompt)) {
      values.sendInvoice = true;
    }
    if (hasPaymentKeyword(payload.prompt) && hasOrderKeyword(payload.prompt) && hasInvoiceKeyword(payload.prompt)) {
      values.registerPayment = true;
    }
    const normalizedLines = normalizeInvoiceLines(values.invoiceLines);
    if (normalizedLines.length > 0) {
      values.invoiceLines = zeroVatPrompt
        ? normalizedLines.map((line) => ({ ...line, ...(line.vatRate == null ? { vatRate: 0 } : {}) }))
        : normalizedLines;
    } else {
      const extractedLines = extractInvoiceLines(payload.prompt);
      if (extractedLines.length > 0) {
        values.invoiceLines = zeroVatPrompt
          ? extractedLines.map((line) => ({ ...line, ...(line.vatRate == null ? { vatRate: 0 } : {}) }))
          : extractedLines;
      }
    }
    if (!isFixedPriceMilestonePrompt(payload.prompt)) {
      const invoiceSubject = extractInvoiceSubject(payload.prompt);
      if (!Array.isArray(values.invoiceLines) && typeof values.productName !== "string" && invoiceSubject) {
        values.productName = invoiceSubject;
      }
      if (
        !Array.isArray(values.invoiceLines)
        && typeof values.productName !== "string"
        && typeof values.description === "string"
        && values.description.trim()
      ) {
        values.productName = values.description.trim();
      }
      if (
        !Array.isArray(values.invoiceLines)
        && typeof values.productName === "string"
        && values.productName.trim()
        && typeof values.amount === "number"
        && values.amount > 0
      ) {
        values.invoiceLines = [{
          productName: values.productName.trim(),
          description:
            typeof values.description === "string" && values.description.trim()
              ? values.description.trim()
              : values.productName.trim(),
          amount: values.amount,
          ...(typeof values.vatRate === "number" ? { vatRate: values.vatRate } : {}),
        }];
      }
    }
  }

  if (next.entity === "supplier_invoice" && next.operation === "create") {
    values.isSupplier = true;
    const labeledSupplierName = extractionText.match(/(?:^|\n)(?:supplier|leverand(?:ø|o)r|fornecedor|fournisseur|proveedor)\s*:\s*([^\n,;()]+)/i)?.[1]
      ?.replace(/^(?:leverand(?:ø|o)ren?|supplier|fornecedor|fournisseur|proveedor)\s+/i, "")
      .trim();
    const invoiceLikeName = (value: unknown): boolean =>
      typeof value === "string" && /\b(?:leverand(?:ø|o)rfaktura|supplier invoice|incoming invoice|facture fournisseur|fournisseur facture|fatura d[oe] fornecedor|factura d(?:el|e) proveedor|fakturanummer|faktura|invoice|facture|fatura|rechnung)\b/i.test(value);
    const supplierNameCandidate = labeledSupplierName && !invoiceLikeName(labeledSupplierName)
      ? labeledSupplierName
      : extractSupplierReference(payload.prompt) ?? extractSupplierReference(extractionText);
    const supplierName = supplierNameCandidate && !invoiceLikeName(supplierNameCandidate) ? supplierNameCandidate : null;
    if (supplierName && supplierName.trim()) {
      values.name = supplierName.trim();
    } else if (
      typeof values.name === "string"
      && /\b(?:leverand(?:ø|o)rfaktura|supplier invoice|incoming invoice|facture fournisseur|fakturanummer|faktura|invoice)\b/i.test(values.name)
    ) {
      delete values.name;
    }
    if (!values.invoiceNumber && heuristicValues.invoiceNumber) {
      values.invoiceNumber = heuristicValues.invoiceNumber;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    const heuristicName = typeof heuristicValues.name === "string" ? heuristicValues.name.trim() : "";
    if (
      !values.name
      && heuristicName
      && !/\b(?:leverand(?:ø|o)rfaktura|supplier invoice|incoming invoice|facture fournisseur|fakturanummer|faktura|invoice)\b/i.test(heuristicName)
    ) {
      values.name = heuristicName;
    }
    if (!values.accountNumber && heuristicValues.accountNumber) {
      values.accountNumber = heuristicValues.accountNumber;
    }
    if (!values.accountNumber) {
      const attachmentAccountNumber = extractSupplierInvoiceAccountNumber(extractionText);
      if (attachmentAccountNumber) values.accountNumber = attachmentAccountNumber;
    }
    if (values.amount == null && typeof heuristicValues.amount === "number") {
      values.amount = heuristicValues.amount;
    }
    if (values.amount == null) {
      const attachmentAmount = extractSupplierInvoiceGrossAmount(extractionText);
      if (attachmentAmount !== null) values.amount = attachmentAmount;
    }
    if (values.vatRate == null && typeof heuristicValues.vatRate === "number") {
      values.vatRate = heuristicValues.vatRate;
    }
    if (!values.description && heuristicValues.description) {
      values.description = heuristicValues.description;
    }
    if (!values.date) {
      values.date = heuristicValues.date ?? todayIso();
    }
    if (!values.invoiceDueDate && typeof heuristicValues.endDate === "string" && heuristicValues.endDate.trim()) {
      values.invoiceDueDate = heuristicValues.endDate.trim();
    }
  }

  if (next.entity === "project") {
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.projectManagerName && heuristicValues.projectManagerName) {
      values.projectManagerName = heuristicValues.projectManagerName;
    }
    if (!values.projectManagerEmail && heuristicValues.projectManagerEmail) {
      values.projectManagerEmail = heuristicValues.projectManagerEmail;
    }
    if (!values.email && heuristicValues.email) {
      values.email = heuristicValues.email;
    }
  }

  if (next.entity === "customer" && next.operation === "create") {
    if (typeof heuristicValues.name === "string" && heuristicValues.name.trim() && !values.name) {
      values.name = heuristicValues.name;
    }
    if (typeof heuristicValues.organizationNumber === "string" && heuristicValues.organizationNumber.trim() && !values.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (typeof heuristicValues.email === "string" && heuristicValues.email.trim() && !values.email) {
      values.email = heuristicValues.email;
    }
    if (typeof heuristicValues.address === "string" && heuristicValues.address.trim() && !values.address) {
      values.address = heuristicValues.address;
    }
    if (typeof heuristicValues.postalCode === "string" && heuristicValues.postalCode.trim() && !values.postalCode) {
      values.postalCode = heuristicValues.postalCode;
    }
    if (typeof heuristicValues.city === "string" && heuristicValues.city.trim() && !values.city) {
      values.city = heuristicValues.city;
    }
    if (heuristicValues.isSupplier === true) {
      values.isSupplier = true;
    }
    if (!/(?:\b(?:nok|kr|kroner|usd|eur|gbp)\b)/i.test(payload.prompt)) {
      delete values.amount;
      delete values.price;
    }
  }

  if (next.operation === "create" && typeof values.organizationNumber === "string" && String(next.lookup?.id ?? "") === values.organizationNumber) {
    delete next.lookup?.id;
  }

  if (isFixedPriceMilestonePrompt(payload.prompt)) {
    next.operation = "create";
    next.entity = "invoice";
    if (!values.projectName) {
      values.projectName =
        (typeof values.name === "string" && values.name.trim().length > 0 ? values.name : undefined)
        ?? quotedSegments[0]
        ?? heuristicValues.name;
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.projectManagerName && heuristicValues.projectManagerName) {
      values.projectManagerName = heuristicValues.projectManagerName;
    }
    if (!values.projectManagerEmail && heuristicValues.projectManagerEmail) {
      values.projectManagerEmail = heuristicValues.projectManagerEmail;
    }
    const fixedPriceAmount = extractFixedPriceAmountFromPrompt(payload.prompt);
    if (!values.fixedPriceAmount && fixedPriceAmount !== null) {
      values.fixedPriceAmount = fixedPriceAmount;
    }
    const milestonePercent = extractPercentageFromPrompt(payload.prompt);
    if (!values.milestonePercent && milestonePercent !== null) {
      values.milestonePercent = milestonePercent;
    }
  }

  if (isReturnedPaymentReversalPrompt(payload.prompt)) {
    next.operation = "reverse_voucher";
    next.entity = "voucher";
    if (next.lookup && next.lookup.id && String(next.lookup.id) === String(heuristicValues.organizationNumber ?? "")) {
      delete next.lookup.id;
    }
    const returnedPaymentCustomerName = extractReturnedPaymentCustomerName(payload.prompt);
    if (returnedPaymentCustomerName) {
      values.customerName = returnedPaymentCustomerName;
    } else if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.name && quotedSegments[0]) {
      values.name = quotedSegments[0];
    }
    if (!values.amount && heuristicValues.amount) {
      values.amount = heuristicValues.amount;
    }
    if (!values.comment) {
      values.comment = "Returned payment reversal";
    }
  }

  if (next.entity === "project_cycle" || isProjectCyclePrompt(payload.prompt)) {
    next.operation = "create";
    next.entity = "project_cycle";
    const quotedProjectName = quotedSegments[0]?.trim();
    if (quotedProjectName) {
      values.projectName = quotedProjectName;
      values.name = quotedProjectName;
    } else if (!values.projectName && typeof values.name === "string" && values.name.trim()) {
      values.projectName = values.name.trim();
    }
    if (!values.customerName && heuristicValues.customerName) {
      values.customerName = heuristicValues.customerName;
    }
    if (!values.customerName) {
      const inlineCustomer = semanticPrompt.match(/\(([^()]+?)\s*,\s*(?:org(?:\.|-)?\s*(?:nr|no|nummer|number)?|n[º°o]\s*org\.?)\s*\.?\s*\d{9}\)/i)?.[1]?.trim();
      if (inlineCustomer) values.customerName = inlineCustomer;
    }
    if (!values.organizationNumber && heuristicValues.organizationNumber) {
      values.organizationNumber = heuristicValues.organizationNumber;
    }
    if (!values.projectManagerName && heuristicValues.projectManagerName) {
      values.projectManagerName = heuristicValues.projectManagerName;
    }
    if (!values.projectManagerEmail && heuristicValues.projectManagerEmail) {
      values.projectManagerEmail = heuristicValues.projectManagerEmail;
    }
    const budgetAmount = extractFixedPriceAmountFromPrompt(payload.prompt) ?? parseFlexibleNumber(String(heuristicValues.amount ?? ""));
    if (values.budgetAmount == null && budgetAmount !== null && budgetAmount > 0) {
      values.budgetAmount = budgetAmount;
    }
  }

  return next;
}

export function heuristicExtract(payload: SolveRequest, summaries: AttachmentSummary[] = []): TaskSpec {
  const prompt = payload.prompt;
  const semanticPrompt = buildSemanticAugmentedText(prompt);
  const attachmentFacts = summaries
    .map((item) => item.textExcerpt.trim())
    .filter(Boolean);
  const extractionText = buildExtractionText(semanticPrompt, attachmentFacts);
  const lower = semanticPrompt.toLowerCase();

  const operation = detectOperation(lower);
  const entity = isAttachmentOnboardingPrompt(prompt, payload.files)
    ? "attachment_onboarding"
    : isBankReconciliationPrompt(semanticPrompt, payload.files)
    ? "bank_reconciliation"
    : isLedgerVarianceProjectsPrompt(semanticPrompt)
      ? "ledger_variance_projects"
    : isLedgerErrorCorrectionPrompt(semanticPrompt)
      ? "ledger_error_correction"
    : isProjectCyclePrompt(semanticPrompt)
      ? "project_cycle"
    : isMonthEndClosingPrompt(semanticPrompt)
      ? "month_end_closing"
      : isInvoiceReminderPrompt(semanticPrompt)
        ? "invoice_reminder"
      : detectEntity(lower);
  const values = extractValues(extractionText);

  const lookup = extractLookupId(prompt);

  return { operation, entity, values, lookup, attachment_facts: attachmentFacts };
}

function detectOperation(lower: string): TaskOperation {
  const ops: Array<{ op: TaskOperation; patterns: RegExp[] }> = [
    { op: "create_credit_note", patterns: [/\bcredit note\b/i, /\bkreditnota\b/i, /\bkreditere\b/i, /\bnota de crédito\b/i, /\bgutschrift\b/i, /\bnote de crédit\b/i] },
    {
      op: "pay_invoice",
      patterns: [
        /\bpay invoice\b/i,
        /\bbetal faktura\b/i,
        /\bregistrer(?: den| det)? betaling(?:en|a)?\b/i,
        /\bregister(?: the)? payment\b/i,
        /\bpago\b/i,
        /\bpagamento\b/i,
        /\bzahlung\b/i,
        /\bpaiement\b/i,
      ],
    },
    {
      op: "reverse_voucher",
      patterns: [
        /\breverse voucher\b/i,
        /\breverser bilag\b/i,
        /\breverser betaling\b/i,
        /\breverser betalinga\b/i,
        /\btilbakefør\b/i,
        /\bstornieren\b/i,
        /\bannuler le\b/i,
        /\brevierta el pago\b/i,
        /\brevertir el pago\b/i,
        /\breverta o pagamento\b/i,
        /\breverter o pagamento\b/i,
        /\breturned by the bank\b/i,
        /\breturnert av banken\b/i,
      ],
    },
    { op: "delete", patterns: [/\bdelete\b/i, /\bslett\b/i, /\bfjern\b/i, /\bremove\b/i, /\beliminar\b/i, /\bsupprimer\b/i, /\blösch/i, /\bexcluir\b/i] },
    { op: "update", patterns: [/\bupdate\b/i, /\boppdater\b/i, /\bendre\b/i, /\bmodify\b/i, /\brediger\b/i, /\bmodificar\b/i, /\balterar\b/i, /\bändern\b/i, /\bmodifier\b/i] },
    { op: "list", patterns: [/\blist\b/i, /\bshow\b/i, /\bfind\b/i, /\bfetch\b/i, /\bget\b/i, /\bhent\b/i, /\bvis\b/i, /\bfinn\b/i, /\bliste\b/i, /\bmostrar\b/i, /\bbuscar\b/i, /\bzeigen\b/i, /\bafficher\b/i] },
    { op: "create", patterns: [/\bcreate\b/i, /\bopprett\b/i, /\bregistrer\b/i, /\blag\b/i, /\bcriar\b/i, /\bcrear\b/i, /\berstell/i, /\bajouter\b/i, /\badd\b/i, /\bcréer\b/i] },
  ];
  for (const { op, patterns } of ops) {
    if (patterns.some((pattern) => pattern.test(lower))) return op;
  }
  return "create";
}

function detectEntity(lower: string): TaskEntity {
  const sanitized = stripEmailsForKeywordDetection(lower);
  if (hasAttachmentOnboardingKeyword(sanitized) && hasAttachmentSignal(sanitized)) return "attachment_onboarding";
  if (isBankReconciliationPrompt(sanitized)) return "bank_reconciliation";
  if (isLedgerVarianceProjectsPrompt(sanitized)) return "ledger_variance_projects";
  if (isLedgerErrorCorrectionPrompt(sanitized)) return "ledger_error_correction";
  if (isProjectCyclePrompt(sanitized)) return "project_cycle";
  if (isMonthEndClosingPrompt(sanitized)) return "month_end_closing";
  if (isInvoiceReminderPrompt(sanitized)) return "invoice_reminder";
  if (isReturnedPaymentReversalPrompt(sanitized)) return "voucher";
  if (isReceiptExpenseVoucherPrompt(sanitized)) return "voucher";
  if (isSupplierInvoicePrompt(sanitized)) return "supplier_invoice";
  if (hasInvoiceKeyword(sanitized) && hasPaymentKeyword(sanitized)) return "invoice";
  if (hasSupplierSignal(sanitized)) return "supplier";
  if (
    hasCreateIntentKeyword(sanitized)
    && /\b(?:customer|kunde|client|cliente)\b/i.test(sanitized)
    && (!hasInvoiceKeyword(sanitized) || hasInvoiceContactFieldKeyword(sanitized))
    && !hasOrderKeyword(sanitized)
    && /\b(?:org(?:anization)?|organisasjonsnummer|organization|adresse|address|endere[cç]o|postal|post(?:al)? code|city|by|e-?mail|invoice e-?mail|faktura(?:\s+|-)e-?mail|e-?mail de fatura)\b/i.test(sanitized)
  ) {
    return "customer";
  }
  if (hasCreateIntentKeyword(sanitized) && /\b(?:department|departments|avdeling(?:er)?|departamento(?:s)?|abteilung(?:en)?|d[ée]partement(?:s)?)\b/i.test(sanitized)) {
    return "department";
  }
  if (
    hasEmployeeSignal(sanitized)
    && hasEmployeeFieldSignal(sanitized)
    && !hasInvoiceKeyword(sanitized)
    && !hasOrderKeyword(sanitized)
    && !hasProjectKeyword(sanitized)
  ) {
    return "employee";
  }
  if (
    hasCreateIntentKeyword(sanitized)
    && /\b(?:product|products|produkt(?:et|er)?|producto(?:s)?|produto(?:s)?|produit(?:s)?)\b/i.test(sanitized)
    && !hasInvoiceKeyword(sanitized)
    && !hasOrderKeyword(sanitized)
    && /\b(?:price|pris|precio|pre[cç]o|vat|mva|iva|tva|nummer|number|num(?:ero)?|nr)\b/i.test(sanitized)
  ) {
    return "product";
  }
  if (
    hasCreateIntentKeyword(sanitized)
    && hasTravelExpenseKeyword(sanitized)
  ) {
    return "travel_expense";
  }
  const entities: Array<{ entity: TaskEntity; keywords: string[] }> = [
    {
      entity: "invoice_reminder",
      keywords: [
        "reminder fee",
        "late fee",
        "payment reminder",
        "soft reminder",
        "betalingspåminnelse",
        "purring",
        "purregebyr",
        "inkassovarsel",
        "notice of debt collection",
        "taxa de lembrete",
        "frais de rappel",
        "mahnung",
      ],
    },
    {
      entity: "accounting_dimension",
      keywords: [
        "accounting dimension",
        "free dimension",
        "custom dimension",
        "dimension comptable",
        "dimension compta",
        "regnskapsdimensjon",
        "bokforingsdimensjon",
        "kostsenter",
        "cost center",
        "cost centre",
      ],
    },
    {
      entity: "project_cycle",
      keywords: [
        "project cycle",
        "project lifecycle",
        "project life cycle",
        "complete project cycle",
        "complete project lifecycle",
        "full project cycle",
        "full project lifecycle",
        "prosjektsyklus",
        "prosjektsyklusen",
        "vollständigen projektzyklus",
        "vollstandigen projektzyklus",
        "cycle de vie du projet",
      ],
    },
    {
      entity: "ledger_error_correction",
      keywords: [
        "general ledger audit",
        "review all vouchers",
        "fehler im hauptbuch",
        "uberprufen sie alle belege",
        "überprüfen sie alle belege",
        "finden sie die fehler",
        "korrigieren sie",
        "ledger errors",
        "voucher errors",
        "wrong account",
        "duplicate voucher",
        "missing vat",
        "audit note",
      ],
    },
    {
      entity: "salary_transaction",
      keywords: [
        "payroll",
        "salary",
        "lonn",
        "lønn",
        "paie",
        "payslip",
        "bulletin de paie",
        "execute salary",
        "run payroll",
        "lønnskjør",
      ],
    },
    { entity: "travel_expense", keywords: ["travel expense", "reiseregning", "reiserekning", "reise", "gastos de viaje", "frais de voyage", "reisekosten"] },
    { entity: "ledger_posting", keywords: ["ledger posting", "hovedbokspost", "posting", "kontierung"] },
    { entity: "ledger_account", keywords: ["ledger account", "kontoplan", "account", "konto"] },
    { entity: "invoice", keywords: ["invoice", "faktura", "factura", "fatura", "rechnung", "facture"] },
    { entity: "order", keywords: ["order", "ordre", "bestilling", "pedido", "commande", "bestellung"] },
    { entity: "voucher", keywords: ["voucher", "bilag", "beleg", "comprobante"] },
    { entity: "employee", keywords: ["employee", "ansatt", "arbeidstakar", "tilsett", "empleado", "empregado", "funcionario", "funcionário", "mitarbeiter", "employé"] },
    { entity: "project", keywords: ["project", "projects", "prosjekt", "prosjektet", "proyecto", "projeto", "projekt", "projektet", "projet"] },
    { entity: "customer", keywords: ["customer", "kunde", "client", "cliente", "Kunde"] },
    { entity: "supplier", keywords: ["supplier", "leverandør", "leverandor", "fornecedor", "fournisseur", "proveedor"] },
    { entity: "product", keywords: ["product", "produkt", "producto", "produto", "produit"] },
    { entity: "department", keywords: ["department", "avdeling", "departamento", "abteilung", "département"] },
  ];
  for (const { entity, keywords } of entities) {
    if (matchesAnyKeyword(sanitized, keywords)) return entity;
  }
  return "customer";
}

function extractValues(prompt: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const quotedSegments = extractQuotedSegments(prompt);
  const lower = prompt.toLowerCase();
  const sanitizedPrompt = stripEmailsForKeywordDetection(prompt);
  const onboardingContext = hasAttachmentOnboardingKeyword(sanitizedPrompt);

  const emailMatch = prompt.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch) values.email = emailMatch[0];

  if (quotedSegments[0]) values.name = quotedSegments[0];
  if (quotedSegments.length > 1) values.names = quotedSegments;

  const orgMatch = prompt.match(/(?:org(?:anization)?[\s.-]*(?:n(?:o|r|umber)|nr)?|org\.?\s*n[º°o]\.?|organisasjonsnummer|organisationsnummer|org\.?\s*nr\.?|organiza[cç][ãa]o|organizaci[oó]n|organisation|n[úu]mero de organiza(?:[cç][ãa]o|ci[oó]n)|num[eé]ro d['’]organisation|n[º°o]\s*org\.?)[\s:.-]*(\d{9})/i);
  if (orgMatch?.[1]) values.organizationNumber = orgMatch[1];

  const phoneMatch = prompt.match(/(?:tlf|tel|mobil|phone|ring|nummer)[\s.:]*(\+?\d[\d\s-]{6,}\d)/i)
    ?? prompt.match(/(\+\d[\d\s-]{6,}\d)/);
  if (phoneMatch?.[1] && phoneMatch[1] !== values.organizationNumber) {
    values.phoneNumber = phoneMatch[1].replace(/\s+/g, "").trim();
  }

  const allDates = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
  if (allDates?.[0]) values.date = allDates[0];
  if (allDates?.[1]) values.startDate = allDates[0];
  if (allDates?.[1]) values.endDate = allDates[1];

  const amountMatch = prompt.match(/(\d[\d\s.,]*)\s*(?:kr|NOK|USD|EUR|GBP)/i);
  const amount = parseFlexibleNumber(amountMatch?.[1] ?? "");
  if (amount !== null) values.amount = amount;

  const currencyMatch = prompt.match(/\b(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(EUR|USD|GBP|SEK|DKK)\b/i);
  if (currencyMatch?.[2]) values.currencyCode = currencyMatch[2].toUpperCase();

  const exchangeRateMatches = [...prompt.matchAll(/(\d+(?:[.,]\d+)?)\s*NOK\s*\/\s*([A-Z]{3})\b/gi)];
  if (exchangeRateMatches[0]?.[2]) {
    values.currencyCode = String(exchangeRateMatches[0][2]).toUpperCase();
  }
  const originalExchangeRate = parseFlexibleNumber(exchangeRateMatches[0]?.[1] ?? "");
  if (originalExchangeRate !== null && originalExchangeRate > 0) {
    values.originalExchangeRate = originalExchangeRate;
  }
  const paymentExchangeRate = parseFlexibleNumber(exchangeRateMatches[1]?.[1] ?? "");
  if (paymentExchangeRate !== null && paymentExchangeRate > 0) {
    values.paymentExchangeRate = paymentExchangeRate;
    values.postExchangeDifference = true;
  }

  const accountMatch = prompt.match(/(?:expense account|utgiftskonto|compte de charges|cuenta de gastos|conta de despesa|conta|account|ledger account|konto|kontonummer|compte|cuenta)\s*(?:number|nr|no|n[oº])?[\s:#-]*(\d{4,6})/i);
  if (accountMatch?.[1]) values.accountNumber = accountMatch[1];

  const invoiceNumberMatch = prompt.match(
    /(?:invoice|faktura(?:en)?|factura|fatura|rechnung|facture)\s*(?:number|nr|n[oº°]|num[eé]ro|id)\s*[\s:#-]*([A-Z0-9][A-Z0-9-]{1,})/i,
  ) ?? prompt.match(
    /\b((?:INV|FAK|FAT|RECH|FACT)[A-Z-]*\d[A-Z0-9-]*)\b/i,
  );
  const invoiceNumberCandidate = invoiceNumberMatch?.[1];
  if (looksLikeInvoiceIdentifier(invoiceNumberCandidate)) values.invoiceNumber = invoiceNumberCandidate;

  const vatRateMatch = prompt.match(/(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:mva|vat|tva|iva)/i) ?? prompt.match(/\b(?:mva|vat|tva|iva)[^\d]{0,20}(\d{1,2}(?:[.,]\d+)?)\s*%/i);
  if (vatRateMatch?.[1]) {
    const vatRate = parseFlexibleNumber(vatRateMatch[1]);
    if (vatRate !== null) values.vatRate = vatRate;
  }

  const birthDate = extractLabeledDate(
    prompt,
    /(?:fødselsdato|date\s*of\s*birth|date\s+de\s+naissance|født|born|né(?:e)?\s+le|nacido\s+el|nascid[oa]\s+em|geboren\s+am|data de nascimento|fecha de nacimiento)\s*(?::|er\b|es\b|est\b|em\b|el\b|am\b)?\s*(.+)$/i,
  );
  if (birthDate) values.dateOfBirth = birthDate;

  const employmentDate = extractLabeledDate(
    prompt,
    /(?:employment\s*start\s*date|employment\s*date|startdato|start\s*date|date\s+de\s+d[ée]but|fecha\s+de\s+inicio|data\s+de\s+in[íi]cio|tiltredelsesdato|oppstarts?dato|startdatum|eintrittsdatum|start am)\s*(?::|er\b|es\b|est\b|em\b|el\b|am\b)?\s*(.+)$/i,
  );
  if (employmentDate) values.employmentDate = employmentDate;

  const nationalIdentityNumber = extractNationalIdentityNumber(prompt);
  if (nationalIdentityNumber) values.nationalIdentityNumber = nationalIdentityNumber;

  const bankAccountNumber = extractBankAccountNumber(prompt);
  if (bankAccountNumber) values.bankAccountNumber = bankAccountNumber;

  const occupationCode = extractOccupationCode(prompt);
  if (occupationCode) values.occupationCode = occupationCode;

  const employmentPercentage = extractEmploymentPercentage(prompt);
  if (employmentPercentage !== null) values.employmentPercentage = employmentPercentage;

  const annualSalary = extractAnnualSalary(prompt);
  if (annualSalary !== null) values.annualSalary = annualSalary;

  const monthlySalary = extractMonthlySalary(prompt);
  if (monthlySalary !== null) values.monthlySalary = monthlySalary;

  const inferredUserType = inferUserTypeFromPrompt(prompt);
  if (inferredUserType) {
    values.userType = inferredUserType;
    values.userAccessRequested = inferredUserType !== "NO_ACCESS";
  }

  const projectManagerMatch = prompt.match(
    /(?:project manager|prosjektleder|prosjektleiar|prosjektansvarlig|projektleiter|chef de projet)\s*(?:is|er|est|ist|:)?\s+([^,(.\n]+?)(?:\s*\(([^)]+@[^)]+)\)|[.,\n]|$)/i,
  );
  const projectManagerName = projectManagerMatch?.[1]?.trim();
  if (projectManagerName && projectManagerName.length >= 2) {
    values.projectManagerName = projectManagerName;
  }
  const projectManagerEmail = projectManagerMatch?.[2]?.trim();
  if (projectManagerEmail) {
    values.projectManagerEmail = projectManagerEmail;
  }

  const departmentMatch = prompt.match(
    /(?:department|avdeling|departamento|abteilung|d[ée]partement|setor)\s*(?:is|er|est|es|:)?\s*[\"“]?([^\"”\n,;:.]+)[\"”]?/i,
  );
  const departmentName = departmentMatch?.[1]?.trim().replace(/^(?:de|da|do)\s+/i, "").replace(/[.,;:]$/g, "").trim();
  if (departmentName && departmentName.length >= 2) {
    values.departmentName = departmentName;
  }
  if (!values.departmentName) {
    const offerLetterDepartment = extractOfferLetterDepartment(prompt);
    if (offerLetterDepartment) values.departmentName = offerLetterDepartment;
  }

  if (!onboardingContext) {
    const customerRefMatch = prompt.match(
      /(?:kunden|kunde|customer|client|cliente)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)(?:\s*\(|\s+har\b|[.,\n]|$)/i,
    );
    const customerRefName = cleanPartyNameCandidate(customerRefMatch?.[1]);
    if (customerRefName && customerRefName.length >= 2) {
      values.customerName = customerRefName;
    }
    if (!values.customerName) {
      const customerDirectionalMatch = prompt.match(
        /(?:frå|fra|from|for|para|pour|f[üu]r)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)(?:\s*\((?:org|org\.|organization|organisasjon)[^)]+\)|[.,\n]|$)/i,
      );
      const customerDirectionalName = cleanPartyNameCandidate(customerDirectionalMatch?.[1]);
      if (customerDirectionalName && customerDirectionalName.length >= 2) {
        values.customerName = customerDirectionalName;
      }
    }

    const partyName = extractPartyReference(sanitizedPrompt);
    if (partyName && partyName.length >= 2) {
      values.name = partyName;
      if (!values.customerName && /\b(?:customer|kunde|client|cliente)\b/i.test(sanitizedPrompt)) {
        values.customerName = partyName;
      }
    }

    const supplierName = extractSupplierReference(prompt);
    if (supplierName && supplierName.length >= 2) {
      values.name = supplierName;
    }
  }

  if (looksLikePaymentStatusPhrase(values.customerName)) {
    delete values.customerName;
  }
  if (looksLikePaymentStatusPhrase(values.name)) {
    delete values.name;
  }

  if (hasInvoiceKeyword(lower) && hasPaymentKeyword(lower) && !values.customerName) {
    const customerDirectionalMatch = prompt.match(
      /(?:til|to|for|para|pour|f[üu]r)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)(?:\s*\((?:org|org\.|organization|organisasjon|organisasjonsnummer|organisationsnummer|n[º°o]\s*org\.?)[^)]+\)|[.,\n]|$)/i,
    );
    const customerDirectionalName = cleanPartyNameCandidate(customerDirectionalMatch?.[1]);
    const fallbackCustomerName = customerDirectionalName || extractPartyReference(prompt);
    if (fallbackCustomerName && fallbackCustomerName.length >= 2) {
      values.customerName = fallbackCustomerName;
      if (!values.name) values.name = fallbackCustomerName;
    }
  }

  if (hasSupplierSignal(sanitizedPrompt)) {
    values.isSupplier = true;
  }

  const supplierInvoiceDescription = extractSupplierInvoiceDescription(prompt);
  if (supplierInvoiceDescription && !values.description) {
    values.description = supplierInvoiceDescription;
  }

  if (isInvoiceReminderPrompt(prompt)) {
    values.reminderType = deriveReminderTypeFromPrompt(prompt);
    values.includeReminderCharge = values.reminderType !== "SOFT_REMINDER";
    values.includeReminderInterests = values.reminderType !== "SOFT_REMINDER";
    const reminderFeeAmount = extractReminderFeeAmount(prompt);
    if (reminderFeeAmount !== null) {
      values.reminderFeeAmount = reminderFeeAmount;
    }
  }

  const postalAddress = extractPostalAddress(prompt);
  if (postalAddress.address) values.address = postalAddress.address;
  if (postalAddress.postalCode) values.postalCode = postalAddress.postalCode;
  if (postalAddress.city) values.city = postalAddress.city;

  if (!values.name) {
    const offerLetterName = extractOfferLetterName(prompt);
    if (offerLetterName) {
      values.name = offerLetterName;
    }
  }

  if (!values.name && !onboardingContext) {
    const explicitName = extractExplicitPromptName(prompt);
    if (explicitName) {
      values.name = explicitName;
    }
  }
  if (!values.name && typeof values.email === "string") {
    const fromEmail = emailToName(values.email);
    if (fromEmail) values.name = fromEmail;
  }

  if (/(?:accounting dimension|free dimension|custom dimension|dimension comptable|kostsenter|cost center|cost centre)/i.test(prompt)) {
    if (!values.dimensionName && quotedSegments[0]) values.dimensionName = quotedSegments[0];
    const dimensionValues = extractDimensionValues(prompt, quotedSegments);
    if (dimensionValues.length > 0) {
      values.dimensionValues = dimensionValues;
      if (!values.dimensionValueName && dimensionValues.length === 1) {
        values.dimensionValueName = dimensionValues[0];
      }
    }
  }

  if (/(?:invoice|faktura|factura|fatura|rechnung|facture)/i.test(prompt) || lower.includes("mva") || lower.includes("vat")) {
    const invoiceLines = extractInvoiceLines(prompt);
    if (invoiceLines.length > 0) {
      values.invoiceLines = invoiceLines;
    }
  }

  if (/(?:travel expense|reiseregning|reiserekning|reise|gastos de viaje|frais de voyage|reisekosten)/i.test(prompt)) {
    const employeeName = extractEmployeeReference(prompt);
    if (employeeName) {
      values.employeeName = employeeName;
      if (!values.name) values.name = employeeName;
    }
    if (!values.title && quotedSegments[0]) values.title = quotedSegments[0];
    const travelDays = extractTravelDays(prompt);
    if (travelDays !== null) values.travelDays = travelDays;
    const perDiemRate = extractTravelPerDiemRate(prompt);
    if (perDiemRate !== null) values.perDiemRate = perDiemRate;
    const costs = extractTravelExpenseCosts(prompt);
    if (costs.length > 0) values.costs = costs;
  }

  if (isPayrollPrompt(prompt)) {
    Object.assign(values, extractPayrollValues(prompt), values);
  }

  const projectName = extractProjectReference(prompt);
  if (projectName) values.projectName = projectName;

  const activityName = extractActivityReference(prompt);
  if (activityName) {
    values.activityName = activityName;
    if (!values.description) values.description = activityName;
  }

  const hours = extractHours(prompt);
  if (hours !== null) values.hours = hours;

  const hourlyRate = extractHourlyRate(prompt);
  if (hourlyRate !== null) {
    values.hourlyRate = hourlyRate;
    if (values.price == null) values.price = hourlyRate;
  }

  if (hours !== null && hourlyRate !== null) {
    values.amount = Math.round(hours * hourlyRate * 100) / 100;
  }

  return values;
}

function looksLikePaymentStatusPhrase(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const folded = foldSemanticText(text);
  return (
    /\b(?:har no betalt|har na betalt|has now paid|has paid|paid now|ja har betalt|ya ha pagado|ja foi pago|est maintenant payee|est maintenant paye)\b/.test(folded)
    || /^(?:betalt|paid|zahlung|pago|pagamento|paiement)$/.test(folded)
  );
}

function extractLabeledDate(prompt: string, pattern: RegExp): string | null {
  const candidate = extractLabeledValue(prompt, pattern);
  if (!candidate) return null;
  const isoInline = candidate.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoInline) return isoInline;
  const parsed = parseLooseDate(candidate);
  if (parsed) return parsed;
  const looseInline = candidate.match(
    /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|(?:\d{1,2}\.?\s+[A-Za-zÀ-ÿ]+\s+\d{4})|(?:[A-Za-zÀ-ÿ]+\s+\d{1,2}\.?\s+\d{4}))\b/,
  )?.[0];
  return parseLooseDate(looseInline);
}

function extractLabeledValue(prompt: string, pattern: RegExp): string | null {
  const normalized = prompt.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  const match = normalized.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseLooseDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const numeric = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3]);
    return toIsoDate(year, month, day);
  }

  const normalized = trimmed
    .normalize("NFKC")
    .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
    .replace(/\bde\b/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const dayMonthYear = normalized.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})$/);
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = monthNameToNumber(dayMonthYear[2]);
    const year = Number(dayMonthYear[3]);
    return month ? toIsoDate(year, month, day) : null;
  }

  const monthDayYear = normalized.match(/^([A-Za-zÀ-ÿ]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (monthDayYear) {
    const month = monthNameToNumber(monthDayYear[1]);
    const day = Number(monthDayYear[2]);
    const year = Number(monthDayYear[3]);
    return month ? toIsoDate(year, month, day) : null;
  }

  return null;
}

function monthNameToNumber(value: string): number | null {
  const month = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const lookup: Record<string, number> = {
    january: 1, januar: 1, janvier: 1, enero: 1, janeiro: 1, januarir: 1,
    february: 2, februar: 2, fevrier: 2, febrero: 2, fevereiro: 2,
    march: 3, mars: 3, marz: 3, marzo: 3,
    april: 4, avril: 4, abril: 4,
    may: 5, mai: 5, mayo: 5, maio: 5,
    june: 6, juni: 6, juin: 6, junio: 6, junho: 6,
    july: 7, juli: 7, juillet: 7, julio: 7, julho: 7,
    august: 8, augusti: 8, aout: 8, agosto: 8,
    september: 9, sept: 9, septembre: 9, septiembre: 9, setembro: 9,
    october: 10, oktober: 10, octobre: 10, octubre: 10, outubro: 10,
    november: 11, novembre: 11, noviembre: 11,
    december: 12, desember: 12, decembre: 12, diciembre: 12, dezembro: 12,
  };
  return lookup[month] ?? null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function emailToName(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const local = value.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  if (!local) return null;
  return local
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFlexibleNumber(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function buildExtractionText(prompt: string, attachmentFacts?: Array<string>): string {
  const facts = Array.isArray(attachmentFacts)
    ? attachmentFacts.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return buildSemanticAugmentedText([prompt, ...facts].filter(Boolean).join("\n"));
}

function extractNationalIdentityNumber(prompt: string): string | null {
  const match = prompt.match(
    /(?:national identity(?: number)?|identity number|f[øo]dselsnummer|personnummer|num(?:ero)? de identidad|num[eé]ro d[' ]identit[eé]|numero de identificacao|n[úu]mero de identifica[cç][aã]o)[^\d]{0,24}(\d{11})/i,
  ) ?? prompt.match(/\b(\d{11})\b/);
  return match?.[1] ? match[1] : null;
}

function extractBankAccountNumber(prompt: string): string | null {
  const match = prompt.match(
    /(?:bank account(?: number)?|konto(?:nummer)?|kontonummer|iban|conta banc[áa]ria|numero da conta|compte bancaire)[^\dA-Z]{0,24}([A-Z]{2}\d{13,30}|\d{11})/i,
  );
  return match?.[1] ? match[1].replace(/\s+/g, "") : null;
}

function extractOccupationCode(prompt: string): string | null {
  const match = prompt.match(
    /(?:occupation code|occupation|profession code|job code|position code|yrkeskode|stillingskode|code profession|c[oó]digo de ocupaci[oó]n|c[oó]digo de profiss[aã]o|c[oó]digo del puesto|c[oó]digo de puesto|berufsschl(?:uessel|[uü]ssel)|berufscode|taetigkeitsschl(?:uessel|[uü]ssel)|t[aä]tigkeitsschl(?:uessel|[uü]ssel))[^\dA-Z]{0,24}([A-Z0-9-]{3,12})/i,
  );
  return match?.[1] ? match[1].trim() : null;
}

function extractEmploymentPercentage(prompt: string): number | null {
  const keywordMatch = prompt.match(
    /(?:employment percentage|percentage of full[- ]time equivalent|full[- ]?time equivalent|fte|stillingsprosent|arbeidsprosent|taux d[' ]occupation|pourcentage d[' ]emploi|porcentaje de empleo|percentagem de emprego|jornada|equivalente a tiempo completo|equivalente a tempo inteiro|besch(?:aeftigungsgrad|[aä]ftigungsgrad)|anstellungsgrad)[^\d]{0,24}(\d{1,3}(?:[.,]\d+)?)\s*%/i,
  );
  if (keywordMatch?.[1]) {
    return parseFlexibleNumber(keywordMatch[1]);
  }
  const proseMatch = prompt.match(
    /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:of full[- ]time|full[- ]time equivalent|fte|jornada|employment|empleo|emprego|occupation|ocupaci[oó]n|ocupa[cç][aã]o)/i,
  );
  if (proseMatch?.[1]) {
    return parseFlexibleNumber(proseMatch[1]);
  }
  return null;
}

function extractAnnualSalary(prompt: string): number | null {
  const match = prompt.match(
    /(?:annual salary|annual base salary|gross annual salary|annual compensation|yearly salary|salary per year|[aå]rsl[øo]nn|salaire annuel|salario anual|salario bruto anual|remuneraci[oó]n anual|sal[aá]rio anual|sal[aá]rio bruto anual|remunera[cç][aã]o anual|jahresgehalt|jahreslohn|jahresverg[uü]tung)[^\d-]{0,28}(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)?/i,
  );
  return parseFlexibleNumber(match?.[1]);
}

function extractMonthlySalary(prompt: string): number | null {
  const match = prompt.match(
    /(?:monthly salary|salary per month|m[aå]nedsl[øo]nn|salaire mensuel|salario mensual|sal[aá]rio mensal)[^\d-]{0,24}(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)?/i,
  );
  return parseFlexibleNumber(match?.[1]);
}

function inferUserTypeFromPrompt(prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  if (/\b(?:ingen tilgang|no access|sans acc[eè]s|sin acceso|sem acesso)\b/i.test(lower)) return "NO_ACCESS";
  if (/\b(?:kontoadministrator|kontoansvarlig|administrator|admin access)\b/i.test(lower)) return "EXTENDED";
  if (/\b(?:standardbruker|standard user|utilisateur standard|utilizador padrao|utilizador padrão|usuario padrao|usuário padrão|standardbenutzer)\b/i.test(lower)) return "STANDARD";
  if (/\b(?:user access|login access|portal access|system access|logon access|brukertilgang|brukeradgang|acc[eè]s utilisateur|acc[eè]s de l[' ]utilisateur|accesso utilisateur|acceso de usuario|acesso de utilizador|acesso de usuario|acesso do usuario|acesso do utilizador|benutzerzugang|systemzugang)\b/i.test(lower)) return "STANDARD";
  return undefined;
}

function extractOfferLetterName(prompt: string): string | null {
  const labeled = extractLabeledValue(
    prompt,
    /^(?:employee|employee name|new employee|name|nom|ansatt|tilsett|arbeidstakar|employ[ée]|empleado|nombre del empleado|nombre|funcion[aá]rio|nome do funcion[aá]rio|nome|mitarbeiter|mitarbeitername)\s*:?\s*([^\n,;()]+)$/i,
  );
  if (labeled && labeled.length >= 2) return labeled;
  const patterns = [
    /(?:offer (?:letter|contract).{0,40}for|pleased to offer(?: you)?|employment contract for|carta de oferta.{0,40}para|contrato de trabajo para|contrato de trabalho para|lettre d['’]offre.{0,40}pour|arbeitsvertrag.{0,40}fur|arbeitsvertrag.{0,40}f[uü]r|angebotsschreiben.{0,40}fur|angebotsschreiben.{0,40}f[uü]r)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.-]+){1,3})\b/i,
    /(?:dear|estimado|estimada|estimad[oa]|bonjour|hei|hello|ola|ol[áa])\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.-]+)+)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate && looksLikePersonName(candidate)) return candidate;
  }
  return null;
}

function looksLikePersonName(value: string): boolean {
  const candidate = value.replace(/[:,;.]$/g, "").trim();
  if (!candidate) return false;
  if (/(?:department|employment|employee|start date|salary|access|onboarding|offer|contract|departamento|incorporaci[oó]n|incorpora[cç][aã]o)/i.test(candidate)) {
    return false;
  }
  const parts = candidate.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => /^[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.-]+$/.test(part));
}

function extractOfferLetterDepartment(prompt: string): string | null {
  const labeled = extractLabeledValue(
    prompt,
    /^(?:department|avdeling|departamento|setor|area|[ée]quipe|d[ée]partement)\s*:?\s*([^\n,;()]+)$/i,
  );
  if (labeled && labeled.length >= 2) return labeled;
  const patterns = [
    /(?:join|assigned to|work in|part of)\s+the\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’&.\- ]{1,60}?)\s+department\b/i,
    /(?:employment|position|role)\s+in\s+the\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’&.\- ]{1,60}?)\s+department\b/i,
    /(?:departamento|setor|area)\s+de\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’&.\- ]{1,60})/i,
    /(?:puesto|cargo|empleo)\s+en\s+el\s+departamento\s+de\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’&.\- ]{1,60})/i,
    /(?:department|departamento|setor|d[ée]partement)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’&.\- ]{1,60})/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim().replace(/^(?:de|da|do)\s+/i, "").replace(/[.,;:]$/g, "").trim();
    if (candidate && candidate.length >= 2) return candidate;
  }
  return null;
}

function addDaysIso(baseIsoDate: string, days: number): string {
  const [year, month, day] = baseIsoDate.split("-").map((part) => Number(part));
  const anchor = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const nextYear = String(anchor.getUTCFullYear()).padStart(4, "0");
  const nextMonth = String(anchor.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(anchor.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function extractPercentageFromPrompt(prompt: string): number | null {
  const percentMatch = prompt.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
  if (!percentMatch?.[1]) return null;
  return parseFlexibleNumber(percentMatch[1]);
}

function extractFixedPriceAmountFromPrompt(prompt: string): number | null {
  const fixedPriceMatch = prompt.match(
    /(?:fixed price|fastpris|precio fijo|pre[cç]o fixo|prix fixe|festpreis)[^\d-]*(-?\d[\d\s.,]*)/i,
  );
  if (!fixedPriceMatch?.[1]) return null;
  return parseFlexibleNumber(fixedPriceMatch[1]);
}

function isFixedPriceMilestonePrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const hasProjectKeywords = ["project", "prosjekt", "proyecto", "projeto", "projekt", "projet"].some((token) => lower.includes(token));
  const hasInvoiceKeywords = ["invoice", "faktura", "fakturer", "factura", "fatura", "rechnung", "facture", "facturez", "facture al"].some((token) => lower.includes(token));
  const hasMilestoneKeywords = [
    "milestone",
    "hito",
    "milepæl",
    "marco",
    "etappe",
    "parcial",
    "delbetaling",
    "partbetaling",
    "partial invoice",
    "partial billing",
    "deposit invoice",
  ].some((token) => lower.includes(token));
  return hasProjectKeywords && hasInvoiceKeywords && hasMilestoneKeywords && extractFixedPriceAmountFromPrompt(prompt) !== null && extractPercentageFromPrompt(prompt) !== null;
}

function isReturnedPaymentReversalPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const hasReturnSignal = [
    "returned by the bank",
    "returnert av banken",
    "returned payment",
    "betalinga vart returnert",
    "betalingen ble returnert",
    "payment was returned",
    "retourné par la banque",
    "devuelto por el banco",
    "devolvido pelo banco",
    "von der bank zurückgebucht",
    "von der bank zuruckgebucht",
    "zurückgebucht",
    "zuruckgebucht",
  ].some((token) => lower.includes(token));
  const hasReverseSignal = [
    "reverse payment",
    "reverse the payment",
    "reverse the invoice payment",
    "reverser betaling",
    "reverser betalinga",
    "reverser betalingen",
    "revert payment",
    "revierta el pago",
    "revierte el pago",
    "revertir el pago",
    "annuller betalingen",
    "annuler betalingen",
    "annulez le paiement",
    "annuler le paiement",
    "annuler un paiement",
    "annule o pagamento",
    "anule o pagamento",
    "reverta o pagamento",
    "reverter o pagamento",
    "anule el pago",
    "revertir el pago",
    "estornar pagamento",
    "stornieren sie die zahlung",
    "zahlung stornieren",
    "stornieren",
  ].some((token) => lower.includes(token));
  const hasInvoiceSignal = ["invoice", "faktura", "factura", "fatura", "rechnung", "facture"].some((token) => lower.includes(token));
  return hasReturnSignal && hasReverseSignal && hasInvoiceSignal;
}

function extractReturnedPaymentCustomerName(prompt: string): string | null {
  const patterns = [
    /(?:pago)\s+de\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)\s*\((?:org|org\.|n[oº]|nº)[^)]+\)\s+por\s+la\s+factura\b/i,
    /(?:payment|betal(?:ing(?:en|a)?)?|paiement|pago|pagamento)\s+(?:from|fra|de|do|da)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\-\s]{1,80}?)(?:\s*\((?:org|org\.|organization|organisasjon)[^)]+\)|\s+(?:for|pour|para|por)\b|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate && candidate.length >= 2) return candidate;
  }
  return null;
}

function extractEmployeeReference(prompt: string): string | null {
  const labeled = extractLabeledValue(
    prompt,
    /^(?:employee|ansatt|arbeidstakar|tilsett|employ[ée]|empleado|empregado|funcion[aá]rio)\s*:?\s*([^\n,;()]+)$/i,
  );
  if (labeled) return labeled;
  const patterns = [
    /(?:for|til|para|f[üu]r|fr[åa])\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+)+)(?:\s*\(|[.,\n]|$)/i,
    /(?:pour|de)\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+)+)(?:\s*\(|[.,\n]|$)/i,
    /(?:employee|ansatt|arbeidstakar|tilsett|employé|empleado|empregado|funcion[aá]rio)\s*:?\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.-]+)+)(?:\s*\(|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

function extractTravelDays(prompt: string): number | null {
  const match = prompt.match(/\b(\d{1,2})\s*(?:day|days|dager?|d[ií]as?|tage?|jours?)\b/i);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(60, Math.round(parsed)));
}

function extractTravelPerDiemRate(prompt: string): number | null {
  const keywordRateMatch = prompt.match(
    /(?:daily rate|per diem|dagssats|dagsats|dag(?:lig)? sats|taxa di[aá]ria|ajudas? de custo|dieta(?: diaria)?)[^\d-]{0,30}(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)?/i,
  );
  if (keywordRateMatch?.[1]) {
    const parsed = parseFlexibleNumber(keywordRateMatch[1]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  const trailingRateMatch = prompt.match(/(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)\s*(?:per day|per diem|pr\.?\s*dag|por dia)/i);
  if (trailingRateMatch?.[1]) {
    const parsed = parseFlexibleNumber(trailingRateMatch[1]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function extractTravelExpenseCosts(prompt: string): Array<{ comments: string; amountCurrencyIncVat: number }> {
  const results: Array<{ comments: string; amountCurrencyIncVat: number }> = [];
  const regex = /([A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9][A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9\s'’"\/-]{2,100}?)\s+(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const rawLabel = (match[1] ?? "").trim();
    const parsedAmount = parseFlexibleNumber(match[2] ?? "");
    if (!rawLabel || parsedAmount === null || parsedAmount <= 0) continue;
    const cleanedLabel = rawLabel
      .replace(/^(?:expenses?|despesas?|kostnader?|utgifter?|expense(?:s)?):?\s*/i, "")
      .replace(/^(?:and|og|e|y|und|et)\s+/i, "")
      .replace(/\s+(?:and|og|e|y|und|et)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanedLabel) continue;
    if (/(?:daily rate|per diem|dagssats|dagsats|taxa di[aá]ria|tarifa diaria|ajudas? de custo|dieta|diett)/i.test(cleanedLabel)) continue;
    results.push({
      comments: cleanedLabel.slice(0, 120),
      amountCurrencyIncVat: Math.round(parsedAmount * 100) / 100,
    });
  }

  const deduped: Array<{ comments: string; amountCurrencyIncVat: number }> = [];
  for (const item of results) {
    if (deduped.some((existing) => existing.comments === item.comments && existing.amountCurrencyIncVat === item.amountCurrencyIncVat)) {
      continue;
    }
    deduped.push(item);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

function isPayrollPrompt(prompt: string): boolean {
  if (isMonthEndClosingPrompt(prompt) || isBankReconciliationPrompt(prompt)) {
    return false;
  }
  const lower = prompt.toLowerCase();
  const payrollTerms = [
    "payroll",
    "salary",
    "lønn",
    "løn",
    "lonn",
    "lon",
    "paie",
    "payslip",
    "bulletin de paie",
    "nómina",
    "nomina",
    "salario",
    "lønnskjør",
    "køyr løn",
    "køyr lønn",
    "run payroll",
    "execute payroll",
    "ejecute la nómina",
    "ejecute la nomina",
    "ejecuta la nómina",
    "ejecuta la nomina",
  ];
  const amountTerms = [
    "base salary",
    "salaire de base",
    "salario base",
    "fastlønn",
    "grunnløn",
    "grunnløn",
    "grunnlon",
    "salaire",
    "bonus",
    "bonificación",
    "bonificacion",
    "prime",
    "eingongsbonus",
  ];
  return payrollTerms.some((term) => lower.includes(term)) && amountTerms.some((term) => lower.includes(term));
}

function extractPayrollValues(prompt: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const employeeName = extractEmployeeReference(prompt);
  if (employeeName) values.employeeName = employeeName;
  const emailMatch = prompt.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch?.[0]) values.email = emailMatch[0];

  const baseSalaryPatterns = [
    /(?:base salary|salaire de base|fastl[øo]nn)[^\d-]*(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)/i,
    /(?:salario base)[^\d-]*(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)/i,
    /(?:grunnl[øo]n)[^\d-]*(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)/i,
    /(?:salary of|salaire de|l[øo]nn p[åa])\s*(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)/i,
  ];
  for (const pattern of baseSalaryPatterns) {
    const match = prompt.match(pattern);
    const parsed = parseFlexibleNumber(match?.[1]);
    if (parsed !== null && parsed > 0) {
      values.baseSalaryAmount = parsed;
      break;
    }
  }

  const bonusPatterns = [
    /(?:bonus|bonificaci[oó]n(?:\s+[úu]nica)?|prime unique|prime exceptionnelle|one[- ]time bonus|engangsbonus|eingongsbonus)[^\d-]*(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)/i,
    /(?:ajoutez|legg til|add)[^\d-]{0,40}?(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)[^\n]{0,40}?(?:bonus|prime)/i,
    /(?:a[nñ]ada|anada|agregue)[^\d-]{0,40}?(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)[^\n]{0,40}?(?:bonus|bonificaci[oó]n)/i,
  ];
  for (const pattern of bonusPatterns) {
    const match = prompt.match(pattern);
    const parsed = parseFlexibleNumber(match?.[1]);
    if (parsed !== null && parsed > 0) {
      values.bonusAmount = parsed;
      break;
    }
  }

  if (!values.date) {
    values.date = todayIso();
  }
  return values;
}

function extractProjectReference(prompt: string): string | null {
  const patterns = [
    /(?:project(?:\s+(?:life\s*cycle|lifecycle|cycle))?|prosjekt(?:syklus(?:en)?)?|projet(?:\s+complet)?|projektzyklus|ciclo del proyecto|ciclo do projeto)\s*(?:for|of|de|do|del|du|pour|f[üu]r|til)?\s*["'“”]([^"'“”\n]{2,120})["'“”]/i,
    /(?:project|prosjekt(?:et)?|proyecto|projeto|projekt|projet)\s*["'“”]([^"'“”\n]{2,120})["'“”]/i,
    /(?:project|prosjekt(?:et)?|proyecto|projeto|projekt|projet)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{2,120}?)(?:\s+(?:for|para|pour|f[üu]r|til|knyttet)|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (
      candidate
      && !/^(?:life\s*cycle|lifecycle|cycle|project cycle|project lifecycle)$/i.test(candidate)
      && !/^(?:has|har|with|med|budget|budsjett|is|er|est|som|avec|con|com|hat|tem|possui)\b/i.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function extractActivityReference(prompt: string): string | null {
  const patterns = [
    /(?:activity|aktivitet(?:en)?|actividad|activité|atividade|aktivität)\s*["'“”]([^"'“”\n]{2,120})["'“”]/i,
    /(?:activity|aktivitet(?:en)?|actividad|activité|atividade|aktivität)\s+([A-ZÆØÅÀ-ÖØ-Ý0-9][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{2,120}?)(?:\s+(?:in|på|i|im|en|for)|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

function extractHours(prompt: string): number | null {
  const match = prompt.match(/\b(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|timer|timar|horas?|heures?|stunden?)\b/i);
  if (!match?.[1]) return null;
  const parsed = parseFlexibleNumber(match[1]);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function extractHourlyRate(prompt: string): number | null {
  const keywordMatch = prompt.match(
    /(?:hourly rate|rate per hour|timepris|timesats|tarifa horaria|taxa hor[áa]ria|taux horaire|stundensatz)[^\d-]{0,30}(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)?/i,
  );
  if (keywordMatch?.[1]) {
    const parsed = parseFlexibleNumber(keywordMatch[1]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  const slashMatch = prompt.match(/(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)\s*\/\s*(?:h|hr|hour|time|hora|heure|stunde)/i);
  if (slashMatch?.[1]) {
    const parsed = parseFlexibleNumber(slashMatch[1]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
}

function isProjectTimeInvoicePrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const hasInvoiceSignal = ["invoice", "faktura", "factura", "fatura", "facture", "rechnung", "bill the customer", "facture al cliente", "facturez le client"].some((token) => lower.includes(token));
  const hasProjectSignal = ["project", "prosjekt", "proyecto", "projet", "projeto", "projekt"].some((token) => lower.includes(token));
  const hasHoursSignal = ["hours", "timer", "timar", "horas", "heures", "stunden"].some((token) => lower.includes(token));
  const hasActivitySignal = ["activity", "aktivitet", "actividad", "activité", "atividade", "aktivität"].some((token) => lower.includes(token));
  return hasInvoiceSignal && hasProjectSignal && hasHoursSignal && hasActivitySignal;
}

function extractInvoiceLines(prompt: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const withNumberPattern =
    /([A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9][A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9\s'"’"\/&.-]{1,90}?)\s*\((\d{1,10})\)[^\n]{0,90}?(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)\b(?:[^\n]{0,40}?(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:tva|mva|vat))?/gi;
  const loosePattern =
    /(?:product|produkt|produit|producto|produto)\s*(\d{1,10})[^\n]{0,80}?(-?\d[\d\s.,]*)\s*(?:nok|kr|kroner)\b(?:[^\n]{0,40}?(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:tva|mva|vat))?/gi;

  const sanitizeProductName = (value: string): string => value
    .trim()
    .replace(/^(?:and|et|e|og|y)\s+/i, "")
    .replace(/^(?:with|con|com)\s+(?:(?:the|los|las|os|as)\s+)?(?:products?|product lines?|productos?|produtos?|produits?)\s+/i, "")
    .replace(/^(?:products?|product lines?|productos?|produtos?|produits?)\s+/i, "")
    .trim();

  let match: RegExpExecArray | null;
  while ((match = withNumberPattern.exec(prompt)) !== null) {
    const productName = sanitizeProductName(match[1] ?? "");
    const productNumber = (match[2] ?? "").trim();
    const amount = parseFlexibleNumber(match[3] ?? "");
    const vatRate = parseFlexibleNumber(match[4] ?? "");
    const key = `${productNumber}|${amount ?? "na"}|${productName.toLowerCase()}`;
    if (!productNumber || amount === null || amount <= 0 || seen.has(key)) continue;
    seen.add(key);
    lines.push({
      productName: productName || undefined,
      productNumber,
      amount,
      vatRate: vatRate ?? undefined,
    });
    if (lines.length >= 6) return lines;
  }

  while ((match = loosePattern.exec(prompt)) !== null) {
    const productNumber = (match[1] ?? "").trim();
    const amount = parseFlexibleNumber(match[2] ?? "");
    const vatRate = parseFlexibleNumber(match[3] ?? "");
    const key = `${productNumber}|${amount ?? "na"}`;
    if (!productNumber || amount === null || amount <= 0 || seen.has(key)) continue;
    seen.add(key);
    lines.push({
      productNumber,
      amount,
      vatRate: vatRate ?? undefined,
    });
    if (lines.length >= 6) break;
  }

  return lines;
}

function extractInvoiceSubject(prompt: string): string | null {
  const patterns = [
    /invoice\s+(?:is\s+)?for\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /faktura(?:en)?\s+(?:er\s+)?for\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /facture\s+(?:est\s+)?pour\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /facture\s+concerne\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /factura\s+(?:es\s+)?para\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /fatura\s+(?:é\s+)?para\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
    /(?:gjelder|concerns)\s+["'“”]?([^"'“”.,\n]{2,120})["'“”]?/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate) return candidate.replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractSupplierInvoiceDescription(prompt: string): string | null {
  const patterns = [
    /(?:gjelder|gjelder\s+for|applies to|concerns|for)\s+([A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9][^.\n]{2,120}?)(?:\s*\((?:konto|account)[^)]+\)|[.,\n]|$)/i,
    /(?:description|beskrivelse|descri(?:ption|ção)|descripci[oó]n)\s*[:\-]?\s*([A-Za-zÀ-ÖØ-öø-ÿÆØÅæøå0-9][^.\n]{2,120})(?:[.\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate) return candidate.replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractSupplierInvoiceGrossAmount(prompt: string): number | null {
  const match = prompt.match(
    /(?:amount(?:\s+incl(?:uding)?\s+vat)?|gross amount|total amount|bel[øo]p(?:\s+inkl(?:usiv)?\s+mva)?|montant(?:\s+ttc)?|importe total|valor total|valor com iva|montante total)[^\d-]{0,24}(-?\d[\d\s.,]*)\s*(?:nok|kr|eur|usd|gbp)?/i,
  );
  return parseFlexibleNumber(match?.[1]);
}

function extractSupplierInvoiceAccountNumber(prompt: string): string | null {
  const match = prompt.match(
    /(?:expense account|utgiftskonto|compte de charges|cuenta de gastos|conta de despesa|conta)[^\d]{0,16}(\d{4,6})/i,
  );
  return match?.[1]?.trim() ?? null;
}

function hasInvoiceSendIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const hasInvoiceKeyword = /\b(invoice|invoic(?:e|er|ing)|faktura(?:en)?|facture|factura|fatura|rechnung)\b/i.test(lower);
  if (!hasInvoiceKeyword) return false;
  return /\b(send|sent|dispatch|deliver|sende|sendt|envoyer|envoyez|enviar|envie|mandar|schick|senden)\b/i.test(lower);
}

function extractDimensionValues(prompt: string, quotedSegments: string[]): string[] {
  if (quotedSegments.length > 1) {
    return [...new Set(quotedSegments.slice(1).map((item) => item.trim()).filter(Boolean))];
  }
  const listMatch = prompt.match(/(?:values?|verdier?|valeurs?|werte)\s*[:\-]?\s*([^\n.]+)/i);
  if (!listMatch?.[1]) return [];
  return [...new Set(
    listMatch[1]
      .split(/\s*(?:,|;|\bog\b|\band\b|\bet\b|\bund\b|\be\b|\by\b)\s*/i)
      .map((item) => item.trim().replace(/^["'“”]|["'“”]$/g, ""))
      .filter(Boolean),
  )];
}

function normalizeInvoiceLines(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const next: Record<string, unknown> = {};
      if (typeof item.description === "string" && item.description.trim()) next.description = item.description.trim();
      if (typeof item.productName === "string" && item.productName.trim()) next.productName = item.productName.trim();
      if (typeof item.productNumber === "string" && item.productNumber.trim()) next.productNumber = item.productNumber.trim();
      const amount = typeof item.amount === "number" ? item.amount : parseFlexibleNumber(String(item.amount ?? ""));
      const vatRate = typeof item.vatRate === "number" ? item.vatRate : parseFlexibleNumber(String(item.vatRate ?? ""));
      if (amount !== null && amount > 0) next.amount = amount;
      if (vatRate !== null && vatRate >= 0) next.vatRate = vatRate;
      return next;
    })
    .filter((item) => Object.keys(item).length > 0);
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function recordId(value: unknown): number | null {
  const record = toRecord(value);
  return positiveInteger(record.id);
}

function matchesExecutionPrefix(value: string | undefined, prefixes: string[]): boolean {
  if (!value) return false;
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}_`));
}

function collectExecutionIds(
  executionResult: ExecutePlanResult | null,
  options: { pathPrefixes?: string[]; exactPaths?: string[]; saveAsPrefixes?: string[] },
): number[] {
  if (!executionResult) return [];
  const ids = new Set<number>();
  const pathPrefixes = options.pathPrefixes ?? [];
  const exactPaths = options.exactPaths ?? [];
  const saveAsPrefixes = options.saveAsPrefixes ?? [];

  for (const step of executionResult.stepResults) {
    const matchesExactPath = exactPaths.length > 0 && exactPaths.includes(step.path);
    const matchesPrefixedPath = pathPrefixes.some((prefix) => step.path === prefix || step.path.startsWith(`${prefix}/`));
    const matchesPath = exactPaths.length === 0 && pathPrefixes.length === 0
      ? true
      : matchesExactPath || matchesPrefixedPath;
    const matchesSaveAs = saveAsPrefixes.length === 0 || matchesExecutionPrefix(step.saveAs, saveAsPrefixes);
    if (!matchesPath && !matchesSaveAs) continue;
    const id = recordId(step.primary);
    if (id !== null) ids.add(id);
  }

  for (const [key, value] of Object.entries(executionResult.vars)) {
    if (!key.endsWith("_id")) continue;
    const baseName = key.slice(0, -3);
    if (saveAsPrefixes.length > 0 && !matchesExecutionPrefix(baseName, saveAsPrefixes)) continue;
    const id = positiveInteger(value);
    if (id !== null) ids.add(id);
  }

  return [...ids];
}

async function fetchById(
  client: TripletexClient,
  path: string,
  id: number,
  fields?: string,
): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `${path}/${id}`, {
    params: fields ? { fields } : undefined,
  });
  return toRecord(primaryValue(response));
}

function matchesCustomerRecord(record: Record<string, unknown>, values: Record<string, unknown>): boolean {
  const name = String(values.name ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  const emailMatches = typeof values.email === "string" && values.email.trim()
    ? normalizedText(record.email) === normalizedText(values.email)
    : true;
  const orgMatches = organizationNumber ? normalizedText(record.organizationNumber) === normalizedText(organizationNumber) : true;
  const nameMatches = name ? normalizedText(record.name) === normalizedText(name) : true;
  const supplierMatches = values.isSupplier === true ? record.isSupplier === true : true;
  const customerMatches = values.isSupplier === true ? record.isSupplier === true : record.isCustomer !== false;
  const postalAddress = toRecord(record.postalAddress);
  const addressMatches = typeof values.address === "string" && values.address.trim()
    ? textContains(postalAddress.addressLine1, values.address)
    : true;
  const postalCodeMatches = typeof values.postalCode === "string" && values.postalCode.trim()
    ? normalizedText(postalAddress.postalCode) === normalizedText(values.postalCode)
    : true;
  const cityMatches = typeof values.city === "string" && values.city.trim()
    ? textContains(postalAddress.city, values.city)
    : true;
  return emailMatches && orgMatches && nameMatches && supplierMatches && customerMatches && addressMatches && postalCodeMatches && cityMatches;
}

function matchesProjectRecord(
  projectRecord: Record<string, unknown>,
  values: Record<string, unknown>,
  requestedManagerIsAssignable: boolean,
): { matches: boolean; detail: string } {
  const projectName = String(values.projectName ?? values.name ?? "").trim();
  const customerName = String(values.customerName ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  const managerName = String(values.projectManagerName ?? values.managerName ?? "").trim();
  const managerEmail = String(values.projectManagerEmail ?? values.email ?? "").trim();

  if (projectName && normalizedText(projectRecord.name) !== normalizedText(projectName)) {
    return { matches: false, detail: "project name does not match the prompt" };
  }

  const projectCustomer = toRecord(projectRecord.customer);
  const customerMatches =
    !customerName && !organizationNumber
      ? true
      : organizationNumber
        ? normalizedText(projectCustomer.organizationNumber) === normalizedText(organizationNumber)
        : textContains(projectCustomer.name, customerName);
  if (!customerMatches) {
    return { matches: false, detail: "project found, but required customer linkage does not match the prompt" };
  }

  const projectManager = toRecord(projectRecord.projectManager);
  const managerFullName = [projectManager.firstName, projectManager.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const managerMatches =
    !managerName && !managerEmail
      ? true
      : managerEmail
        ? normalizedText(projectManager.email) === normalizedText(managerEmail)
        : textContains(managerFullName, managerName);
  const hasAnyManager =
    Boolean(projectManager.id)
    || normalizedText(projectManager.email).length > 0
    || normalizedText(managerFullName).length > 0;

  if (requestedManagerIsAssignable && !managerMatches) {
    return { matches: false, detail: "project found, but customer or project manager linkage does not match the prompt" };
  }
  if (!requestedManagerIsAssignable && !hasAnyManager) {
    return { matches: false, detail: "project found, but tenant fallback manager is missing" };
  }

  return {
    matches: true,
    detail: requestedManagerIsAssignable
      ? "project verified with customer and manager linkage"
      : "project verified with customer linkage; tenant fallback manager used",
  };
}

async function requestedProjectManagerIsAssignable(
  client: TripletexClient,
  values: Record<string, unknown>,
): Promise<boolean> {
  const managerName = String(values.projectManagerName ?? values.managerName ?? "").trim();
  const managerEmail = String(values.projectManagerEmail ?? values.email ?? "").trim();
  if (!managerName && !managerEmail) return false;

  const managerParams: Record<string, unknown> = {
    count: 5,
    from: 0,
    assignableProjectManagers: true,
    fields: "id,firstName,lastName,email",
  };
  if (managerEmail) managerParams.email = managerEmail;
  if (managerName) {
    const splitManager = splitName(managerName);
    if (splitManager.firstName) managerParams.firstName = splitManager.firstName;
    if (splitManager.lastName) managerParams.lastName = splitManager.lastName;
  }
  const managerResponse = await client.request("GET", "/employee", { params: managerParams });
  const managerObject = toRecord(managerResponse);
  const managerValues = Array.isArray(managerObject.values) ? managerObject.values : [];
  return managerValues.some((item) => {
    const managerRecord = toRecord(item);
    const fullName = [managerRecord.firstName, managerRecord.lastName]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ");
    return (
      (managerEmail ? normalizedText(managerRecord.email) === normalizedText(managerEmail) : true)
      && (managerName ? textContains(fullName, managerName) : true)
    );
  });
}

async function verifyGenericEntityByExecutionIds(
  client: TripletexClient,
  spec: TaskSpec,
  entityPath: string,
  executionResult: ExecutePlanResult | null,
  expectedNames: string[],
): Promise<{ verified: boolean; detail: string; required: boolean } | null> {
  if (spec.operation !== "create" || !executionResult) return null;
  if (!["employee", "product", "department", "order", "voucher"].includes(spec.entity)) return null;

  const saveAsPrefixes = (() => {
    switch (spec.entity) {
      case "employee":
        return ["employee", "emp"];
      case "product":
        return ["product"];
      case "department":
        return ["department", "dept"];
      case "order":
        return ["order"];
      case "voucher":
        return ["voucher", "v"];
      default:
        return [];
    }
  })();

  const ids = collectExecutionIds(executionResult, {
    pathPrefixes: spec.entity === "employee" ? [] : [entityPath],
    exactPaths: spec.entity === "employee" ? [entityPath] : [],
    saveAsPrefixes,
  });
  if (ids.length === 0) return null;

  const fields = (() => {
    switch (spec.entity) {
      case "employee":
        return "id,firstName,lastName,email,dateOfBirth";
      case "product":
        return "*";
      case "department":
        return "id,name";
      case "order":
        return "id,customer(id,name,organizationNumber),preliminaryInvoice(id)";
      case "voucher":
        return "id,description,date";
      default:
        return undefined;
    }
  })();

  const values = toRecord(spec.values);
  const matchedDepartmentNames = new Set<string>();
  for (const id of ids) {
    const record = await fetchById(client, entityPath, id, fields);
    if (spec.entity === "department" && expectedNames.length > 0) {
      const actualName = String(record.name ?? "").trim();
      const expectedName = expectedNames.find((name) => normalizedText(actualName) === normalizedText(name));
      if (expectedName) {
        matchedDepartmentNames.add(normalizedText(expectedName));
        continue;
      }
      return { verified: false, detail: `created department ${id} does not match expected names`, required: true };
    }
    if (spec.entity === "employee") {
      const expectedName = values.name ?? `${values.firstName ?? ""} ${values.lastName ?? ""}`.trim();
      const fullName = `${record.firstName ?? ""} ${record.lastName ?? ""}`.trim();
      const emailMatches = typeof values.email === "string" && values.email.trim()
        ? normalizedText(record.email) === normalizedText(values.email)
        : true;
      const birthDateMatches = typeof values.dateOfBirth === "string" && values.dateOfBirth.trim()
        ? normalizedText(record.dateOfBirth) === normalizedText(values.dateOfBirth)
        : true;
      let employmentMatches = true;
      if (typeof values.employmentDate === "string" && values.employmentDate.trim()) {
        const employmentResponse = await client.request("GET", "/employee/employment", {
          params: {
            employeeId: id,
            count: 20,
            fields: "id,startDate,endDate,employee(id),division(id,name)",
          },
        });
        const employmentRecord = toRecord(employmentResponse);
        const employmentValues = Array.isArray(employmentRecord.values) ? employmentRecord.values : [];
        employmentMatches = employmentValues.some((item: unknown) => normalizedText(toRecord(item).startDate) === normalizedText(values.employmentDate));
      }
      if (emailMatches && birthDateMatches && employmentMatches && textContains(fullName, expectedName)) {
        return { verified: true, detail: "employee verified via returned id", required: true };
      }
      continue;
    }
    if (spec.entity === "product") {
      if (await productRecordMatches(client, record, values)) {
        return { verified: true, detail: "product verified via returned id", required: true };
      }
      continue;
    }
    if (spec.entity === "order") {
      return { verified: true, detail: "order verified via returned id", required: true };
    }
    if (spec.entity === "voucher") {
      return { verified: true, detail: "voucher verified via returned id", required: true };
    }
  }

  if (spec.entity === "department" && expectedNames.length > 0) {
    const missing = expectedNames.filter((name) => !matchedDepartmentNames.has(normalizedText(name)));
    if (missing.length === 0) {
      return { verified: true, detail: "departments verified via returned ids", required: true };
    }
    return { verified: false, detail: `one or more created departments were not verified by id: ${missing.join(", ")}`, required: true };
  }
  return { verified: false, detail: `created ${spec.entity} ids did not match expected fields`, required: true };
}

// ---------------------------------------------------------------------------
// Deterministic plan compiler — code owns ALL Tripletex semantics
// ---------------------------------------------------------------------------

function todayIso(): string {
  return todayIsoInZone();
}

function dateRangeParams(prefix: string): Record<string, string> {
  return {
    [`${prefix}From`]: shiftIsoDateInZone({ years: -1 }),
    // Tripletex treats the upper date bound as exclusive, so use tomorrow to include today.
    [`${prefix}To`]: shiftIsoDateInZone({ days: 1 }),
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
    case "attachment_onboarding":
      return compileAttachmentOnboarding(spec.operation, v);
    case "employee":
      return compileEmployee(spec.operation, v, spec.lookup);
    case "customer":
      return compileCustomer(spec.operation, v, spec.lookup);
    case "supplier":
      return compileSupplier(spec.operation, v, spec.lookup);
    case "product":
      return compileProduct(spec.operation, v);
    case "department":
      return compileDepartment(spec.operation, v);
    case "project":
      return compileProject(spec.operation, v);
    case "project_cycle":
      return compileProjectCycle(spec.operation, v);
    case "order":
      return compileOrder(spec.operation, v, spec.lookup);
    case "invoice":
      return compileInvoice(spec.operation, v, spec.lookup);
    case "invoice_reminder":
      return compileInvoiceReminder(spec.operation, v, spec.lookup);
    case "supplier_invoice":
      return compileSupplierInvoice(spec.operation, v);
    case "bank_reconciliation":
      return compileBankReconciliation(spec.operation, v);
    case "ledger_variance_projects":
      return compileLedgerVarianceProjects(spec.operation, v);
    case "ledger_error_correction":
      return compileLedgerErrorCorrection(spec.operation, v);
    case "month_end_closing":
      return compileMonthEndClosing(spec.operation, v);
    case "accounting_dimension":
      return compileAccountingDimension(spec.operation, v);
    case "travel_expense":
      return compileTravelExpense(spec.operation, v, spec.lookup);
    case "salary_transaction":
      return compileSalaryTransaction(spec.operation, v);
    case "voucher":
      return compileVoucher(spec.operation, v, spec.lookup);
    case "ledger_account":
      return compileLedgerRead("ledger/account", v);
    case "ledger_posting":
      return compileLedgerRead("ledger/posting", v);
  }
}

function compileAttachmentOnboarding(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileAttachmentOnboardingPreview(op, v);
}

function compileLedgerErrorCorrection(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileLedgerErrorCorrectionPreview({ operation: op, entity: "ledger_error_correction", values: v });
}

function compileProjectCycle(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileProjectCyclePreview(op, v);
}

// ---- Helpers ----

const PREREQUISITE_KEYS = new Set([
  "customerName", "employeeName", "projectManagerName", "managerName",
  "employee", "customer", "attachment_facts",
  "departmentName", "isAdmin", "productName",
  "address", "postalCode", "city",
]);

function entityBody(v: Record<string, unknown>, overrides: Record<string, unknown>, stripKeys: Set<string>): Record<string, unknown> {
  const body = { ...overrides };
  for (const [k, val] of Object.entries(v)) {
    if (val == null || body[k] !== undefined || stripKeys.has(k) || PREREQUISITE_KEYS.has(k)) continue;
    body[k] = val;
  }
  return body;
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
    const stripKeys = new Set([
      "name", "firstName", "lastName", "phoneNumber", "phone",
      "address", "postalCode", "city", "isAdmin",
      "departmentName", "productName", "employmentDate",
      "occupationCode", "employmentPercentage", "percentageOfFullTimeEquivalent",
      "annualSalary", "monthlySalary", "userAccessRequested", "entitlementTemplate",
    ]);
    const body = entityBody(v, {
      firstName: person.firstName,
      lastName: person.lastName,
    }, stripKeys);
    if (v.phoneNumber || v.phone) body.phoneNumberMobile = v.phoneNumber ?? v.phone;
    if (v.isAdmin || (typeof v.userType === "string" && v.userType.toUpperCase() === "EXTENDED")) {
      body.userType = "EXTENDED";
    }
    if (v.address || v.postalCode || v.city) {
      body.address = {
        addressLine1: v.address ?? "",
        postalCode: v.postalCode ?? "",
        city: v.city ?? "",
      };
    }
    const steps: Array<Record<string, unknown>> = [];
    if (v.departmentName) {
      steps.push({
        method: "POST",
        path: "/department",
        body: { name: v.departmentName },
        saveAs: "dept",
      });
      body.department = { id: "{{dept_id}}" };
    }
    if (typeof v.employmentDate === "string" && v.employmentDate.trim()) {
      steps.push({
        method: "GET",
        path: "/division",
        params: { count: 1, fields: "id,name,organizationNumber" },
        saveAs: "division",
      });
    }
    steps.push({ method: "POST", path: "/employee", body, saveAs: "employee" });
    if (typeof v.employmentDate === "string" && v.employmentDate.trim()) {
      steps.push({
        method: "POST",
        path: "/employee/employment",
        body: {
          employee: { id: "{{employee_id}}" },
          startDate: v.employmentDate,
          division: { id: "{{division_id}}" },
          isMainEmployer: true,
        },
        saveAs: "employment",
      });
    }
    return {
      summary: `Create employee ${person.firstName} ${person.lastName}`,
      steps: steps as ExecutionPlan["steps"],
    };
  }
  if (op === "update") {
    const stripKeys = new Set([
      "name", "firstName", "lastName", "phoneNumber", "phone", "employmentDate",
      "occupationCode", "employmentPercentage", "percentageOfFullTimeEquivalent",
      "annualSalary", "monthlySalary", "userAccessRequested", "entitlementTemplate",
    ]);
    const body = entityBody(v, {}, stripKeys);
    if (v.firstName || v.name) body.firstName = v.firstName ?? person.firstName;
    if (v.lastName || v.name) body.lastName = v.lastName ?? person.lastName;
    if (v.phoneNumber || v.phone) body.phoneNumberMobile = v.phoneNumber ?? v.phone;
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
    const stripKeys = new Set(["name", "address", "postalCode", "city", "isAdmin", "departmentName", "productName"]);
    const body = entityBody(v, {
      name: v.name ?? `Generated Customer ${Date.now().toString().slice(-6)}`,
      isCustomer: v.isSupplier ? false : true,
    }, stripKeys);
    if (v.isSupplier) body.isSupplier = true;
    if (v.address || v.postalCode || v.city) {
      body.postalAddress = {
        addressLine1: v.address ?? "",
        postalCode: v.postalCode ?? "",
        city: v.city ?? "",
      };
    }
    return {
      summary: `Create customer ${body.name}`,
      steps: [{ method: "POST", path: "/customer", body, saveAs: "customer" }],
    };
  }
  if (op === "update") {
    const body = entityBody(v, {}, new Set([]));
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

function compileSupplier(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const stripKeys = new Set(["name", "address", "postalCode", "city", "isAdmin", "departmentName", "productName", "isSupplier", "isCustomer"]);
    const body = entityBody(v, {
      name: v.name ?? `Generated Supplier ${Date.now().toString().slice(-6)}`,
      isCustomer: false,
    }, stripKeys);
    body.isSupplier = true;
    if (v.address || v.postalCode || v.city) {
      body.postalAddress = {
        addressLine1: v.address ?? "",
        postalCode: v.postalCode ?? "",
        city: v.city ?? "",
      };
    }
    return {
      summary: `Create supplier ${body.name}`,
      steps: [{ method: "POST", path: "/supplier", body, saveAs: "supplier" }],
    };
  }
  if (op === "update") {
    const body = entityBody(v, {}, new Set(["isSupplier", "isCustomer"]));
    if (lookup?.id) {
      return {
        summary: `Update supplier ${lookup.id}`,
        steps: [
          { method: "GET", path: `/supplier/${lookup.id}`, saveAs: "supplier" },
          { method: "PUT", path: `/supplier/${lookup.id}`, body },
        ],
      };
    }
    return {
      summary: "Update supplier (lookup first)",
      steps: [
        { method: "GET", path: "/supplier", params: { count: 1 }, saveAs: "supplier" },
        { method: "PUT", path: "/supplier/{{supplier_id}}", body },
      ],
    };
  }
  if (op === "delete") {
    return compileDeleteNotSupported("supplier");
  }
  return {
    summary: "List suppliers",
    steps: [{ method: "GET", path: "/supplier", params: { count: 20 } }],
  };
}

function compileProduct(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const stripKeys = new Set(["name", "price", "cost", "productNumber", "vatRate", "accountNumber", "description"]);
    const body = entityBody(v, {
      name: v.name ?? `Generated Product ${Date.now().toString().slice(-6)}`,
    }, stripKeys);
    if (v.priceExcludingVatCurrency ?? v.price) body.priceExcludingVatCurrency = v.priceExcludingVatCurrency ?? v.price;
    if (v.costExcludingVatCurrency ?? v.cost) body.costExcludingVatCurrency = v.costExcludingVatCurrency ?? v.cost;
    if (v.number ?? v.productNumber) body.number = v.number ?? v.productNumber;
    if (typeof v.description === "string" && v.description.trim()) {
      body.description = v.description.trim();
      body.orderLineDescription = v.description.trim();
    }
    const vatTypeId = vatTypeIdForRate(v.vatRate);
    if (vatTypeId) body.vatType = { id: vatTypeId };
    const steps: PlanStep[] = [];
    if (typeof v.accountNumber === "string" && v.accountNumber.trim()) {
      steps.push({
        method: "GET",
        path: "/ledger/account",
        params: { number: v.accountNumber.trim(), count: 1, fields: "id,number,name" },
        saveAs: "account",
      });
      body.account = { id: "{{account_id}}" };
    }
    steps.push({ method: "POST", path: "/product", body, saveAs: "product" });
    return {
      summary: `Create product ${body.name}`,
      steps,
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
    const names = Array.isArray(v.names)
      ? v.names.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (names.length > 0) {
      return {
        summary: `Create ${names.length} departments`,
        steps: names.map((name, index) => ({
          method: "POST" as const,
          path: "/department",
          body: { name },
          saveAs: `department${index + 1}`,
        })),
      };
    }
    const body = entityBody(v, {
      name: v.name ?? `Generated Dept ${Date.now().toString().slice(-6)}`,
    }, new Set(["name"]));
    return {
      summary: `Create department ${body.name}`,
      steps: [{ method: "POST", path: "/department", body, saveAs: "department" }],
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
    const pMgrName = v.projectManagerName ?? v.managerName;
    const pMgrEmail = v.projectManagerEmail ?? v.email;
    const customerName = typeof v.customerName === "string" ? v.customerName.trim() : "";
    const organizationNumber = typeof v.organizationNumber === "string" ? v.organizationNumber.trim() : "";
    const stripKeys = new Set([
      "name",
      "startDate",
      "endDate",
      "projectManagerName",
      "projectManagerEmail",
      "managerName",
      "customerName",
      "organizationNumber",
      "email",
    ]);
    const body = entityBody(v, {
      name: v.name ?? `Generated Project ${Date.now().toString().slice(-6)}`,
      startDate: (v.startDate as string) ?? todayIso(),
    }, stripKeys);
    body.projectManager = { id: "{{employee_id}}" };
    if (customerName || organizationNumber) {
      body.customer = { id: "{{customer_id}}" };
    }
    if (v.endDate) body.endDate = v.endDate;
    const steps: Array<Record<string, unknown>> = [];
    if (customerName || organizationNumber) {
      const customerParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,name,organizationNumber,email,invoiceEmail",
      };
      if (organizationNumber) customerParams.organizationNumber = organizationNumber;
      if (customerName) customerParams.name = customerName;
      steps.push({
        method: "GET",
        path: "/customer",
        params: customerParams,
        saveAs: "customer",
        reason: "Resolve project customer",
      });
    }
    if (pMgrName || pMgrEmail) {
      const mgr = splitName(typeof pMgrName === "string" ? pMgrName : undefined);
      const employeeParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,firstName,lastName,email",
        assignableProjectManagers: true,
      };
      if (pMgrEmail) employeeParams.email = pMgrEmail;
      if (mgr.firstName) employeeParams.firstName = mgr.firstName;
      if (mgr.lastName) employeeParams.lastName = mgr.lastName;
      steps.push({
        method: "GET",
        path: "/employee",
        params: employeeParams,
        saveAs: "employee",
        reason: "Resolve project manager employee",
      });
    } else {
      steps.push({
        method: "GET",
        path: "/employee",
        params: { count: 1, fields: "id", assignableProjectManagers: true },
        saveAs: "employee",
        reason: "Find existing employee as project manager",
      });
    }
    steps.push({
      method: "POST",
      path: "/project",
      body,
      saveAs: "project",
    });
    return {
      summary: `Create project ${body.name}`,
      steps: steps as ExecutionPlan["steps"],
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
    const today = todayIso();
    const stripKeys = new Set([
      "customerName", "orderDate", "deliveryDate",
      "productName", "amount", "price",
      "address", "postalCode", "city", "isAdmin", "departmentName",
    ]);
    const steps: Array<Record<string, unknown>> = [];

    steps.push({
      method: "POST",
      path: "/customer",
      body: {
        name: v.customerName ?? `Customer ${Date.now().toString().slice(-6)}`,
        isCustomer: true,
      },
      saveAs: "customer",
    });

    const hasProduct = v.productName || v.price || v.amount;
    const orderBody: Record<string, unknown> = {
      customer: { id: "{{customer_id}}" },
      orderDate: (v.orderDate as string) ?? today,
      deliveryDate: (v.deliveryDate as string) ?? today,
    };
    if (hasProduct) {
      steps.push({
        method: "POST",
        path: "/product",
        body: { name: v.productName ?? "Product" },
        saveAs: "product",
      });
      orderBody.orderLines = [{
        product: { id: "{{product_id}}" },
        count: 1,
        unitPriceExcludingVatCurrency: v.price ?? v.amount ?? 1,
      }];
    }
    const body = entityBody(v, orderBody, stripKeys);
    steps.push({
      method: "POST",
      path: "/order",
      body,
      saveAs: "order",
    });

    return {
      summary: "Create order",
      steps: steps as ExecutionPlan["steps"],
    };
  }
  return {
    summary: op === "delete" ? "Delete order is unsupported — list orders instead" : "List orders",
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
  if (matchesProjectTimeInvoiceWorkflow({ operation: op, entity: "invoice", values: v, lookup })) {
    return compileProjectTimeInvoicePreview(op, v);
  }
  if (op === "create") {
    const today = todayIso();
    const steps: Array<Record<string, unknown>> = [];
    const fixedPriceAmount =
      typeof v.fixedPriceAmount === "number"
        ? v.fixedPriceAmount
        : parseFlexibleNumber(String(v.fixedPriceAmount ?? v.price ?? ""));
    const milestonePercent =
      typeof v.milestonePercent === "number"
        ? v.milestonePercent
        : parseFlexibleNumber(String(v.milestonePercent ?? ""));
    const projectName = String(v.projectName ?? "").trim();
    if (
      fixedPriceAmount !== null
      && fixedPriceAmount > 0
      && milestonePercent !== null
      && milestonePercent > 0
      && projectName
    ) {
      const customerName = String(v.customerName ?? `Customer ${Date.now().toString().slice(-6)}`).trim();
      const managerName = String(v.projectManagerName ?? "").trim();
      const managerEmail = String(v.projectManagerEmail ?? v.email ?? "").trim();
      const manager = splitName(managerName || undefined);
      const milestoneAmount = Math.max(0.01, Math.round((fixedPriceAmount * (milestonePercent / 100)) * 100) / 100);
      const productName = `Milestone ${milestonePercent}% ${projectName}`.slice(0, 120);

      const customerParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,name,organizationNumber",
      };
      if (v.organizationNumber) customerParams.organizationNumber = v.organizationNumber;
      if (customerName) customerParams.name = customerName;
      steps.push({
        method: "GET",
        path: "/customer",
        params: customerParams,
        saveAs: "customer",
      });

      const employeeParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,firstName,lastName,email",
        assignableProjectManagers: true,
      };
      if (managerEmail) employeeParams.email = managerEmail;
      if (manager.firstName) employeeParams.firstName = manager.firstName;
      if (manager.lastName) employeeParams.lastName = manager.lastName;
      steps.push({
        method: "GET",
        path: "/employee",
        params: employeeParams,
        saveAs: "employee",
      });

      steps.push({
        method: "POST",
        path: "/project",
        body: {
          name: projectName,
          startDate: (v.startDate as string) ?? today,
          customer: { id: "{{customer_id}}" },
          projectManager: { id: "{{employee_id}}" },
          isFixedPrice: true,
          fixedprice: fixedPriceAmount,
        },
        saveAs: "project",
      });

      steps.push({
        method: "GET",
        path: "/product",
        params: { count: 1, from: 0, fields: "id,number,name", name: productName },
        saveAs: "product",
      });

      steps.push({
        method: "POST",
        path: "/order",
        body: {
          customer: { id: "{{customer_id}}" },
          project: { id: "{{project_id}}" },
          orderDate: (v.invoiceDate as string) ?? today,
          deliveryDate: (v.invoiceDate as string) ?? today,
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
      });

      steps.push({
        method: "PUT",
        path: "/order/:invoiceMultipleOrders",
        params: {
          id: "{{order_id}}",
          invoiceDate: (v.invoiceDate as string) ?? today,
          sendToCustomer: v.sendInvoice === true,
        },
        saveAs: "invoice",
      });

      if (v.registerPayment === true) {
        steps.push({
          method: "GET",
          path: "/invoice/paymentType",
          params: { count: 1, from: 0, fields: "id,description" },
          saveAs: "paymentType",
        });
        steps.push({
          method: "PUT",
          path: "/invoice/{{invoice_id}}/:payment",
          params: {
            paymentDate: (v.paymentDate as string) ?? today,
            paymentTypeId: "{{paymentType_id}}",
            paidAmount: "{{invoice.amountOutstanding}}",
          },
        });
      }

      return {
        summary: "Create fixed-price milestone invoice via order invoice batch endpoint",
        steps: steps as ExecutionPlan["steps"],
      };
    }

    const customerName = (v.customerName ?? v.name ?? `Customer ${Date.now().toString().slice(-6)}`) as string;
    const lines = normalizeInvoiceLines(v.invoiceLines).length > 0
      ? normalizeInvoiceLines(v.invoiceLines)
      : [
          {
            description: typeof v.productName === "string" ? v.productName : "Invoice line",
            productName: typeof v.productName === "string" ? v.productName : undefined,
            amount: typeof (v.price ?? v.amount) === "number" ? (v.price ?? v.amount) : parseFlexibleNumber(String(v.price ?? v.amount ?? "")) ?? 1,
          },
        ];

    steps.push({
      method: "GET",
      path: "/customer",
      params: {
        count: 1,
        from: 0,
        fields: "id,name,organizationNumber,email,invoiceEmail",
        ...(v.organizationNumber ? { organizationNumber: v.organizationNumber } : {}),
        ...(customerName ? { name: customerName } : {}),
      },
      saveAs: "customer",
    });

    lines.forEach((line, index) => {
      const productNumber = typeof line.productNumber === "string" ? line.productNumber : undefined;
      const productName = typeof line.productName === "string" ? line.productName : undefined;
      if (!productNumber && !productName) return;
      const amount = typeof line.amount === "number" ? line.amount : undefined;
      const vatRate = typeof line.vatRate === "number" ? line.vatRate : undefined;
      steps.push({
        method: "GET",
        path: "/product",
        params: {
          count: 1,
          from: 0,
          fields: "id,number,name",
          ...(productNumber ? { number: productNumber } : {}),
          ...(!productNumber && productName ? { name: productName } : {}),
          ...(amount ? { price: amount } : {}),
          ...(vatRate !== undefined ? { vatRate } : {}),
          ...(vatRate !== undefined ? { vatTypeId: vatTypeIdForRate(vatRate) } : {}),
        },
        saveAs: `product${index + 1}`,
      });
    });

    const orderLines = lines.map((line, index) => {
      const nextLine: Record<string, unknown> = { count: 1 };
      const vatTypeId = vatTypeIdForRate(line.vatRate);
      if (line.productNumber || line.productName) {
        nextLine.product = { id: `{{product${index + 1}_id}}` };
      }
      if (line.description && !line.productNumber && !line.productName) {
        nextLine.description = line.description;
      }
      if (typeof line.amount === "number" && Number.isFinite(line.amount) && line.amount > 0) {
        nextLine.unitPriceExcludingVatCurrency = line.amount;
      }
      if (vatTypeId) {
        nextLine.vatType = { id: vatTypeId };
      }
      return nextLine;
    });

    steps.push({
      method: "POST",
      path: "/order",
      body: {
        customer: { id: "{{customer_id}}" },
        orderDate: (v.invoiceDate as string) ?? today,
        deliveryDate: (v.invoiceDate as string) ?? today,
        orderLines,
      },
      saveAs: "order",
    });

    steps.push({
      method: "PUT",
      path: "/order/:invoiceMultipleOrders",
      params: {
        id: "{{order_id}}",
        invoiceDate: (v.invoiceDate as string) ?? today,
        sendToCustomer: v.sendInvoice === true,
      },
      saveAs: "invoice",
    });

    if (v.registerPayment === true) {
      steps.push({
        method: "GET",
        path: "/invoice/paymentType",
        params: { count: 1, from: 0, fields: "id,description" },
        saveAs: "paymentType",
      });
      steps.push({
        method: "PUT",
        path: "/invoice/{{invoice_id}}/:payment",
        params: {
          paymentDate: (v.paymentDate as string) ?? today,
          paymentTypeId: "{{paymentType_id}}",
          paidAmount: "{{invoice.amountOutstanding}}",
        },
      });
    }

    return {
      summary: "Create invoice via order invoice batch endpoint",
      steps: steps as ExecutionPlan["steps"],
    };
  }
  if (op === "pay_invoice") {
    return compileInvoicePaymentPreview({ operation: op, entity: "invoice", values: v, lookup });
  }
  if (op === "create_credit_note") {
    const invoiceId = lookup?.id ?? lookup?.invoiceId;
    const creditComment = (v.comment as string) ?? (v.description as string) ?? "Generated credit note";
    if (invoiceId) {
      return {
        summary: `Credit note for invoice ${invoiceId}`,
        steps: [
          {
            method: "PUT",
            path: `/invoice/${invoiceId}/:createCreditNote`,
            body: {
              date: (v.date as string) ?? todayIso(),
              comment: creditComment,
            },
          },
        ],
      };
    }
    const customerName = String(v.customerName ?? v.name ?? "").trim();
    const orgNo = String(v.organizationNumber ?? "").trim();
    if (customerName || orgNo) {
      const customerParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,name,organizationNumber",
      };
      if (orgNo) {
        customerParams.organizationNumber = orgNo;
      } else {
        customerParams.name = customerName;
      }
      return {
        summary: "Credit note (resolve customer invoice first)",
        steps: [
          {
            method: "GET",
            path: "/customer",
            params: customerParams,
            saveAs: "customer",
          },
          {
            method: "GET",
            path: "/invoice",
            params: {
              count: 1,
              fields: "id,customer(id,name,organizationNumber),invoiceDate,invoiceNumber",
              ...dateRangeParams("invoiceDate"),
              customerId: "{{customer_id}}",
            },
            saveAs: "inv",
          },
          {
            method: "PUT",
            path: "/invoice/{{inv_id}}/:createCreditNote",
            body: {
              date: (v.date as string) ?? todayIso(),
              comment: creditComment,
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
            date: (v.date as string) ?? todayIso(),
            comment: creditComment,
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

function compileInvoiceReminder(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  return compileInvoiceReminderPreview({ operation: op, entity: "invoice_reminder", values: v, lookup });
}

function vatTypeIdForRate(rate: unknown): number | undefined {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
  if (Math.abs(rate - 25) < 0.001) return 3;
  if (Math.abs(rate - 15) < 0.001) return 31;
  if (Math.abs(rate - 12) < 0.001) return 32;
  if (Math.abs(rate) < 0.001) return 5;
  return undefined;
}

function compileAccountingDimension(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileAccountingDimensionPreview(op, v);
}

function compileBankReconciliation(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileBankReconciliationPreview(op, v);
}

function compileLedgerVarianceProjects(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileLedgerVarianceProjectsPreview({ operation: op, entity: "ledger_variance_projects", values: v });
}

function compileMonthEndClosing(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileMonthEndClosingPreview(op, v);
}

function compileSupplierInvoice(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compileSupplierInvoicePreview(op, v);
}

function compileTravelExpense(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const empName = v.employeeName ?? v.employee;
    const stripKeys = new Set(["employeeName", "employee", "date", "title", "name", "travelDays", "perDiemRate"]);
    const travelDate = (v.date as string) ?? todayIso();
    const travelDays = typeof v.travelDays === "number" ? Math.max(1, Math.round(v.travelDays)) : 1;
    const costs = Array.isArray(v.costs)
      ? v.costs
        .map((item) => toRecord(item))
        .filter((item) => typeof item.comments === "string" && typeof item.amountCurrencyIncVat === "number")
      : [];
    const body = entityBody(v, {
      employee: { id: "{{employee_id}}" },
      date: travelDate,
      title: v.title ?? v.name ?? "Travel expense",
      travelDetails: {
        departureDate: travelDate,
        returnDate: addDaysIso(travelDate, Math.max(0, travelDays - 1)),
        destination: String(v.title ?? "Norge"),
        purpose: v.title ?? v.name ?? "Travel expense",
      },
      ...(typeof v.perDiemRate === "number" && v.perDiemRate > 0
        ? {
          perDiemCompensations: [
            {
              count: travelDays,
              rate: v.perDiemRate,
              location: String(v.title ?? "Norge"),
            },
          ],
        }
        : {}),
      ...(costs.length > 0
        ? {
          costs: costs.map((item) => ({
            comments: item.comments,
            amountCurrencyIncVat: item.amountCurrencyIncVat,
            date: travelDate,
            paymentType: {
              id: "{{travelExpensePaymentType_id}}",
              description: "{{travelExpensePaymentType_description}}",
            },
          })),
        }
        : {}),
    }, stripKeys);
    const steps: Array<Record<string, unknown>> = [];
    if (empName) {
      const emp = splitName(String(empName));
      steps.push({
        method: "GET",
        path: "/department",
        params: { count: 1, fields: "id,name" },
        saveAs: "dept",
        reason: "Find department for travel expense employee",
      });
      steps.push({
        method: "POST",
        path: "/employee",
        body: {
          firstName: emp.firstName,
          lastName: emp.lastName,
          email: typeof v.email === "string" ? v.email : undefined,
          dateOfBirth: typeof v.dateOfBirth === "string" ? v.dateOfBirth : "1990-01-15",
          department: { id: "{{dept_id}}" },
        },
        saveAs: "employee",
        reason: "Create employee for travel expense",
      });
    } else {
      steps.push({
        method: "GET",
        path: "/employee",
        params: { count: 1, fields: "id" },
        saveAs: "employee",
        reason: "Find existing employee for travel expense",
      });
    }
    steps.push({
      method: "POST",
      path: "/travelExpense",
      body,
      saveAs: "travelExpense",
    });
    return {
      summary: "Create travel expense",
      steps: steps as ExecutionPlan["steps"],
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

function compileSalaryTransaction(
  op: TaskOperation,
  v: Record<string, unknown>,
): ExecutionPlan {
  return compilePayrollPreview(op, v);
}

function compileVoucher(
  op: TaskOperation,
  v: Record<string, unknown>,
  lookup?: Record<string, unknown>,
): ExecutionPlan {
  if (op === "create") {
    const stripKeys = new Set(["date", "description", "name"]);
    const body = entityBody(v, {
      date: (v.date as string) ?? todayIso(),
      description: v.description ?? v.name ?? "Voucher",
    }, stripKeys);
    return {
      summary: "Create voucher",
      steps: [{ method: "POST", path: "/ledger/voucher", body, saveAs: "voucher" }],
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
    const customerName = String(v.customerName ?? "").trim();
    const orgNo = String(v.organizationNumber ?? "").trim();
    if (customerName || orgNo) {
      const customerParams: Record<string, unknown> = {
        count: 1,
        from: 0,
        fields: "id,name,organizationNumber",
      };
      if (orgNo) customerParams.organizationNumber = orgNo;
      if (customerName) customerParams.name = customerName;
      return {
        summary: "Reverse returned payment voucher for customer",
        steps: [
          {
            method: "GET",
            path: "/customer",
            params: customerParams,
            saveAs: "customer",
          },
          {
            method: "GET",
            path: "/ledger/posting",
            params: {
              count: 1,
              from: 0,
              customerId: "{{customer_id}}",
              type: "INCOMING_PAYMENT",
              ...dateRangeParams("date"),
              fields: "id,voucher(id,number),amount,invoiceNumber,description,type",
            },
            saveAs: "paymentPosting",
          },
          {
            method: "PUT",
            path: "/ledger/voucher/{{paymentPosting.voucher.id}}/:reverse",
            body: {
              date: (v.date as string) ?? todayIso(),
              description: (v.comment as string) ?? (v.description as string) ?? "Returned payment reversal",
            },
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
  executionResult: ExecutePlanResult | null,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  if (spec.operation === "list") {
    return { verified: true, detail: "read-only operation", required: false };
  }
  if (spec.operation === "delete") {
    return { verified: true, detail: "delete completed", required: false };
  }
  if (spec.operation === "create_credit_note") {
    return { verified: true, detail: "action flow accepted; execution is the primary signal", required: false };
  }

  try {
    if (spec.entity === "attachment_onboarding") {
      return await verifyAttachmentOnboardingWorkflowOutcome(client, spec);
    }

    if (spec.entity === "accounting_dimension") {
      return await verifyAccountingDimensionOutcome(client, spec);
    }

    if (spec.entity === "bank_reconciliation") {
      return await verifyBankReconciliationWorkflowOutcome(client, spec);
    }

    if (spec.entity === "voucher" && toRecord(spec.values).receiptExpense === true) {
      return await verifyExpenseVoucherWorkflowOutcome(client, spec);
    }

    if (spec.entity === "ledger_variance_projects") {
      return await verifyLedgerVarianceProjectsWorkflowOutcome(client, spec);
    }

    if (spec.entity === "ledger_error_correction") {
      return await verifyLedgerErrorCorrectionWorkflowOutcome(client, spec);
    }

    if (spec.entity === "project_cycle") {
      return await verifyProjectCycleWorkflowOutcome(client, spec);
    }

    if (spec.entity === "month_end_closing") {
      return await verifyMonthEndClosingWorkflowOutcome(client, spec);
    }

    if (spec.entity === "supplier_invoice") {
      return await verifySupplierInvoiceEntityOutcome(client, spec);
    }

    if (spec.entity === "invoice_reminder") {
      return await verifyInvoiceReminderWorkflowOutcome(client, spec);
    }

    if (spec.operation === "pay_invoice" && spec.entity === "invoice") {
      return await verifyInvoicePaymentWorkflowOutcome(client, spec);
    }

    if (spec.operation === "reverse_voucher" && spec.entity === "voucher" && (toRecord(spec.values).customerName || toRecord(spec.values).organizationNumber)) {
      return await verifyReturnedPaymentWorkflowOutcome(client, spec);
    }

    if (spec.entity === "salary_transaction") {
      return await verifyPayrollWorkflowOutcome(client, spec);
    }

    if (matchesProjectTimeInvoiceWorkflow(spec)) {
      return await verifyProjectTimeInvoiceOutcome(client, spec);
    }

    const entityPath = entityToPath(spec.entity);
    if (!entityPath) {
      return { verified: false, detail: "no verification path", required: true };
    }

    if ((spec.entity === "customer" || spec.entity === "supplier") && spec.operation === "create") {
      if (spec.entity === "supplier") {
        return await verifySupplierCreateOutcome(client, spec, executionResult);
      }
      return await verifyCustomerCreateOutcome(client, spec, executionResult);
    }

    const params: Record<string, unknown> = { count: 20, from: 0 };
    if (entityPath === "/order") Object.assign(params, dateRangeParams("orderDate"));
    if (entityPath === "/invoice") Object.assign(params, dateRangeParams("invoiceDate"));
    if (entityPath === "/ledger/voucher") Object.assign(params, dateRangeParams("date"));

    const v = (spec.values ?? {}) as Record<string, unknown>;
    if (spec.entity === "customer" || spec.entity === "supplier") {
      if (v.organizationNumber) params.organizationNumber = v.organizationNumber;
      else if (v.name || v.customerName) params.name = v.name ?? v.customerName;
    } else if (spec.entity === "department" && v.name) {
      params.name = v.name;
    } else if (spec.entity === "product") {
      if (v.number) params.number = v.number;
      else if (v.name || v.productName) params.name = v.name ?? v.productName;
    } else if (spec.entity === "employee") {
      if (typeof v.email === "string" && v.email.trim()) params.email = v.email;
      else if (v.name) params.name = v.name;
    } else if (spec.entity === "project" && v.name) {
      params.name = v.name;
    }

    const searchName = v.name ?? (v.firstName || v.lastName
      ? `${v.firstName ?? ""} ${v.lastName ?? ""}`.trim()
      : v.customerName ?? null);
    const expectedNames = Array.isArray(v.names)
      ? v.names.map((item) => String(item).trim()).filter(Boolean)
      : searchName
        ? [String(searchName)]
        : [];

    if (spec.entity === "department" && expectedNames.length > 0) {
      for (const expectedName of expectedNames) {
        const response = await client.request("GET", entityPath, {
          params: { count: 20, from: 0, name: expectedName },
        });
        const obj = response as Record<string, unknown>;
        const exactValues = Array.isArray(obj?.values) ? obj.values : [];
        if (obj?.value) exactValues.push(obj.value);

        const exactMatch = exactValues.some((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const rec = item as Record<string, unknown>;
          return String(rec.name ?? "").trim().toLowerCase() === expectedName.toLowerCase();
        });
        if (!exactMatch) {
          return {
            verified: false,
            detail: `department with name '${expectedName}' not found`,
            required: true,
          };
        }
      }
      return { verified: true, detail: "department verified", required: true };
    }

    if (spec.entity === "invoice" && spec.operation === "create") {
      const expectedLines = normalizeInvoiceLines(v.invoiceLines);
      return await verifyInvoiceCreateOutcome(client, spec, executionResult, expectedLines, searchName ? String(searchName) : undefined);
    }

    if (spec.entity === "travel_expense" && spec.operation === "create") {
      return await verifyTravelExpenseCreateOutcome(client, spec);
    }

    if (spec.entity === "project" && spec.operation === "create") {
      return await verifyProjectCreateOutcome(client, spec, executionResult);
    }

    const directVerification = await verifyGenericEntityByExecutionIds(client, spec, entityPath, executionResult, expectedNames);
    if (directVerification) return directVerification;

    const response = await client.request("GET", entityPath, { params });
    const obj = response as Record<string, unknown>;
    const values = Array.isArray(obj?.values) ? obj.values : [];
    if (obj?.value) values.push(obj.value);

    if (spec.operation === "create" && values.length === 0) {
      return { verified: false, detail: `no ${spec.entity} found after create`, required: true };
    }

    if (expectedNames.length > 0 && values.length > 0) {
      for (const expectedName of expectedNames) {
        const nameMatches = values.some((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const rec = item as Record<string, unknown>;
          const entityName =
            rec.name ??
            rec.customerName ??
            `${rec.firstName ?? ""} ${rec.lastName ?? ""}`.trim();
          return String(entityName).toLowerCase().includes(expectedName.toLowerCase());
        });
        if (!nameMatches) {
          return { verified: false, detail: `${spec.entity} with name '${expectedName}' not found`, required: true };
        }
      }
    }

    return { verified: true, detail: `${spec.entity} verified`, required: true };
  } catch (error) {
    return {
      verified: false,
      detail: `verification GET failed: ${error instanceof Error ? error.message : String(error)}`,
      required: true,
    };
  }
}

async function verifyTravelExpenseCreateOutcome(
  client: TripletexClient,
  spec: TaskSpec,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = toRecord(spec.values);
  const travelDate = typeof values.date === "string" ? values.date : todayIso();
  const expectedTitle = typeof values.title === "string" ? values.title : typeof values.name === "string" ? values.name : undefined;
  const expectedPerDiemRate = typeof values.perDiemRate === "number" ? values.perDiemRate : undefined;
  const expectedTravelDays = typeof values.travelDays === "number" ? Math.max(1, Math.round(values.travelDays)) : undefined;
  const expectedCosts = Array.isArray(values.costs) ? values.costs.map((item) => toRecord(item)) : [];

  const matchesTravelExpenseRecord = (item: unknown): boolean => {
    const record = toRecord(item);
    if (expectedTitle && !textContains(record.title, expectedTitle)) return false;

    if (expectedPerDiemRate !== undefined || expectedTravelDays !== undefined) {
      const perDiemEntries = Array.isArray(record.perDiemCompensations) ? record.perDiemCompensations : [];
      const perDiemMatch = perDiemEntries.some((entry) => {
        const perDiem = toRecord(entry);
        const rateMatches = expectedPerDiemRate === undefined
          ? true
          : Math.abs(Number(perDiem.rate ?? 0) - expectedPerDiemRate) < 0.01;
        const countMatches = expectedTravelDays === undefined
          ? true
          : Number(perDiem.count ?? 0) === expectedTravelDays;
        return rateMatches && countMatches;
      });
      if (!perDiemMatch) return false;
    }

    const actualCosts = Array.isArray(record.costs) ? record.costs : [];
    return expectedCosts.every((expected) => actualCosts.some((candidate) => {
      const cost = toRecord(candidate);
      const commentMatches = typeof expected.comments === "string" ? textContains(cost.comments, expected.comments) : true;
      const amountMatches = typeof expected.amountCurrencyIncVat === "number"
        ? Math.abs(Number(cost.amountCurrencyIncVat ?? 0) - expected.amountCurrencyIncVat) < 0.01
        : true;
      return commentMatches && amountMatches;
    }));
  };

  const createdTravelExpenseId = Number(values.__travelExpenseId ?? 0);
  if (createdTravelExpenseId > 0) {
    const createdResponse = await client.request("GET", `/travelExpense/${createdTravelExpenseId}`, {
      params: {
        fields: "id,title,employee(id,email,firstName,lastName),travelDetails(departureDate,returnDate,destination,purpose),perDiemCompensations(count,rate,location),costs(comments,amountCurrencyIncVat)",
      },
    });
    if (matchesTravelExpenseRecord(primaryValue(createdResponse))) {
      return { verified: true, detail: "travel expense verified via returned id", required: true };
    }
  }

  const employeeIds = new Set<number>();
  const createdEmployeeId = Number(values.__employeeId ?? 0);
  if (createdEmployeeId > 0) employeeIds.add(createdEmployeeId);

  const employeeSearchParams: Record<string, unknown> = {
    count: 20,
    from: 0,
    fields: "id,firstName,lastName,email",
  };
  if (typeof values.email === "string" && values.email.trim()) {
    employeeSearchParams.email = values.email.trim();
  } else if (typeof values.employeeName === "string" && values.employeeName.trim()) {
    const person = splitName(values.employeeName.trim());
    employeeSearchParams.firstName = person.firstName;
    employeeSearchParams.lastName = person.lastName;
  } else {
    return { verified: false, detail: "travel expense verification requires employee reference", required: true };
  }

  const employeeResponse = await client.request("GET", "/employee", { params: employeeSearchParams });
  const employeeRecord = toRecord(employeeResponse);
  const employeeValues = Array.isArray(employeeRecord.values)
    ? employeeRecord.values
    : employeeRecord.value
      ? [employeeRecord.value]
      : [];
  for (const item of employeeValues) {
    const employee = toRecord(item);
    const employeeId = Number(employee.id ?? 0);
    if (employeeId > 0) employeeIds.add(employeeId);
  }
  if (employeeIds.size === 0) {
    return { verified: false, detail: "travel expense employee not found", required: true };
  }

  for (const employeeId of employeeIds) {
    const response = await client.request("GET", "/travelExpense", {
      params: {
        employeeId,
        state: "ALL",
        departureDateFrom: addDaysIso(travelDate, -30),
        returnDateTo: addDaysIso(travelDate, 30),
        count: 20,
        from: 0,
        fields: "id,title,employee(id,email,firstName,lastName),travelDetails(departureDate,returnDate,destination,purpose),perDiemCompensations(count,rate,location),costs(comments,amountCurrencyIncVat)",
      },
    });
    const responseRecord = toRecord(response);
    const candidates = Array.isArray(responseRecord.values)
      ? responseRecord.values
      : responseRecord.value
        ? [responseRecord.value]
        : [];
    if (candidates.some(matchesTravelExpenseRecord)) {
      return { verified: true, detail: "travel expense verified with per diem and itemized costs", required: true };
    }
  }

  return { verified: false, detail: "matching travel expense not found with expected structured fields", required: true };
}

async function verifyCustomerCreateOutcome(
  client: TripletexClient,
  spec: TaskSpec,
  executionResult: ExecutePlanResult | null,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = toRecord(spec.values);
  const name = String(values.name ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  if (!name && !organizationNumber) {
    return { verified: false, detail: "customer verification requires name or organization number", required: true };
  }

  const directIds = collectExecutionIds(executionResult, {
    pathPrefixes: ["/customer"],
    saveAsPrefixes: ["customer", "cust"],
  });
  for (const id of directIds) {
    const directRecord = await fetchById(
      client,
      "/customer",
      id,
      "id,name,email,organizationNumber,isCustomer,isSupplier,postalAddress(addressLine1,postalCode,city)",
    );
    if (matchesCustomerRecord(directRecord, values)) {
      return { verified: true, detail: "customer verified via returned id", required: true };
    }
  }

  const response = await client.request("GET", "/customer", {
    params: {
      count: 10,
      from: 0,
      fields: "id,name,email,organizationNumber,isCustomer,isSupplier,postalAddress(addressLine1,postalCode,city)",
      ...(organizationNumber ? { organizationNumber } : {}),
      ...(name ? { name } : {}),
    },
  });
  const responseRecord = toRecord(response);
  const candidates = Array.isArray(responseRecord.values)
    ? responseRecord.values
    : responseRecord.value
      ? [responseRecord.value]
      : [];
  const match = candidates.find((item) => matchesCustomerRecord(toRecord(item), values));

  if (!match) {
    return { verified: false, detail: "customer not found with expected master-data fields", required: true };
  }
  return { verified: true, detail: values.isSupplier === true ? "supplier verified" : "customer verified", required: true };
}

async function verifySupplierCreateOutcome(
  client: TripletexClient,
  spec: TaskSpec,
  executionResult: ExecutePlanResult | null,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = toRecord(spec.values);
  values.isSupplier = true;
  const name = String(values.name ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  if (!name && !organizationNumber) {
    return { verified: false, detail: "supplier verification requires name or organization number", required: true };
  }

  const directIds = collectExecutionIds(executionResult, {
    pathPrefixes: ["/supplier"],
    saveAsPrefixes: ["supplier"],
  });
  for (const id of directIds) {
    const directRecord = await fetchById(
      client,
      "/supplier",
      id,
      "id,name,email,organizationNumber,isCustomer,isSupplier,postalAddress(addressLine1,postalCode,city)",
    );
    if (matchesCustomerRecord(directRecord, values)) {
      return { verified: true, detail: "supplier verified via returned id", required: true };
    }
  }

  const response = await client.request("GET", "/supplier", {
    params: {
      count: 10,
      from: 0,
      fields: "id,name,email,organizationNumber,isCustomer,isSupplier,postalAddress(addressLine1,postalCode,city)",
      ...(organizationNumber ? { organizationNumber } : {}),
      ...(name ? { name } : {}),
    },
  });
  const responseRecord = toRecord(response);
  const candidates = Array.isArray(responseRecord.values)
    ? responseRecord.values
    : responseRecord.value
      ? [responseRecord.value]
      : [];
  const match = candidates.find((item) => matchesCustomerRecord(toRecord(item), values));

  if (!match) {
    return { verified: false, detail: "supplier not found with expected master-data fields", required: true };
  }
  return { verified: true, detail: "supplier verified", required: true };
}

async function verifyInvoiceCreateOutcome(
  client: TripletexClient,
  spec: TaskSpec,
  executionResult: ExecutePlanResult | null,
  expectedLines: Array<Record<string, unknown>>,
  searchName?: string,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = toRecord(spec.values);
  const expectedCustomer = {
    searchName,
    organizationNumber: typeof values.organizationNumber === "string" ? values.organizationNumber : undefined,
  };
  const invoiceFields =
    "id,invoiceNumber,invoiceDate,isCharged,isApproved,amountOutstanding,amountCurrencyOutstanding,amountOutstandingTotal,amountCurrencyOutstandingTotal,customer(id,name,organizationNumber),orders(id),orderLines(description,displayName,count,unitPriceExcludingVatCurrency,vatType(percentage),product(name,number))";
  const fixedPriceAmount = typeof values.fixedPriceAmount === "number"
    ? values.fixedPriceAmount
    : parseFlexibleNumber(String(values.fixedPriceAmount ?? ""));
  const projectName = String(values.projectName ?? "").trim();

  const verifyFixedPriceProjectContext = async (): Promise<{ verified: boolean; detail: string; required: boolean } | null> => {
    if (!projectName || fixedPriceAmount === null || fixedPriceAmount <= 0) return null;

    const projectMatches = (projectRecord: Record<string, unknown>): boolean => {
      if (normalizedText(projectRecord.name) !== normalizedText(projectName)) return false;
      if (projectRecord.isFixedPrice !== true) return false;
      if (Math.abs(Number(projectRecord.fixedprice ?? 0) - fixedPriceAmount) > 0.01) return false;
      const customerRecord = toRecord(projectRecord.customer);
      if (expectedCustomer.organizationNumber) {
        return normalizedText(customerRecord.organizationNumber) === normalizedText(expectedCustomer.organizationNumber);
      }
      if (expectedCustomer.searchName) {
        return textContains(customerRecord.name, expectedCustomer.searchName);
      }
      return true;
    };

    const directProjectIds = collectExecutionIds(executionResult, {
      pathPrefixes: ["/project"],
      saveAsPrefixes: ["project"],
    });
    for (const projectId of directProjectIds) {
      const projectRecord = await fetchById(
        client,
        "/project",
        projectId,
        "id,name,isFixedPrice,fixedprice,customer(id,name,organizationNumber)",
      );
      if (projectMatches(projectRecord)) {
        return { verified: true, detail: "fixed-price project verified via returned id", required: true };
      }
    }

    const projectResponse = await client.request("GET", "/project", {
      params: {
        count: 20,
        from: 0,
        name: projectName,
        fields: "id,name,isFixedPrice,fixedprice,customer(id,name,organizationNumber)",
      },
    });
    const projectObject = toRecord(projectResponse);
    const projects = Array.isArray(projectObject.values) ? projectObject.values : [];
    if (projects.some((item) => projectMatches(toRecord(item)))) {
      return { verified: true, detail: "fixed-price project verified", required: true };
    }
    return { verified: false, detail: "project was not created as fixed-price with the expected amount", required: true };
  };

  const directInvoiceIds = collectExecutionIds(executionResult, {
    pathPrefixes: ["/order/:invoiceMultipleOrders"],
    saveAsPrefixes: ["invoice"],
  });
  for (const invoiceId of directInvoiceIds) {
    const invoiceRecord = await fetchById(
      client,
      "/invoice",
      invoiceId,
      invoiceFields,
    );
    if (invoiceRecordMatches(invoiceRecord, expectedLines, expectedCustomer)) {
      if (values.registerPayment === true && !invoicePaymentMatches(invoiceRecord)) {
        return { verified: false, detail: "invoice was created but payment was not registered", required: true };
      }
      const fixedPriceVerification = await verifyFixedPriceProjectContext();
      if (fixedPriceVerification && !fixedPriceVerification.verified) {
        return fixedPriceVerification;
      }
      return { verified: true, detail: "invoice verified via returned id", required: true };
    }
  }

  const customerResponse = await client.request("GET", "/customer", {
    params: {
      count: 1,
      from: 0,
      fields: "id,name,organizationNumber",
      ...(values.organizationNumber ? { organizationNumber: values.organizationNumber } : {}),
      ...(!values.organizationNumber && searchName ? { name: searchName } : {}),
    },
  });
  const customer = primaryValue(customerResponse) as Record<string, unknown> | undefined;
  const customerId = customer?.id;
  const invoiceResponse = await client.request("GET", "/invoice", {
    params: {
      count: 20,
      from: 0,
      fields: invoiceFields,
      ...dateRangeParams("invoiceDate"),
      ...(customerId ? { customerId } : {}),
    },
  });
  const invoiceObject = toRecord(invoiceResponse);
  const invoices = Array.isArray(invoiceObject.values) ? invoiceObject.values : [];
  const matchingInvoice = invoices.find((item) => invoiceRecordMatches(item, expectedLines, expectedCustomer));
  if (!matchingInvoice) {
    return { verified: false, detail: "no matching invoice found after create", required: true };
  }
  if (values.registerPayment === true && !invoicePaymentMatches(toRecord(matchingInvoice))) {
    return { verified: false, detail: "matching invoice found, but payment was not registered", required: true };
  }
  const fixedPriceVerification = await verifyFixedPriceProjectContext();
  if (fixedPriceVerification && !fixedPriceVerification.verified) {
    return fixedPriceVerification;
  }
  return { verified: true, detail: "invoice verified", required: true };
}

async function verifyProjectCreateOutcome(
  client: TripletexClient,
  spec: TaskSpec,
  executionResult: ExecutePlanResult | null,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = toRecord(spec.values);
  const projectName = String(values.projectName ?? values.name ?? "").trim();
  if (!projectName) {
    return { verified: false, detail: "project verification requires name", required: true };
  }

  const requestedManagerIsAssignable = await requestedProjectManagerIsAssignable(client, values);

  const directProjectIds = collectExecutionIds(executionResult, {
    pathPrefixes: ["/project"],
    saveAsPrefixes: ["project"],
  });
  for (const projectId of directProjectIds) {
    const projectRecord = await fetchById(
      client,
      "/project",
      projectId,
      "id,name,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email)",
    );
    const directMatch = matchesProjectRecord(projectRecord, values, requestedManagerIsAssignable);
    if (directMatch.matches) {
      return { verified: true, detail: `${directMatch.detail} via returned id`, required: true };
    }
  }

  const projectResponse = await client.request("GET", "/project", {
    params: {
      count: 20,
      from: 0,
      name: projectName,
      fields: "id,name,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email)",
    },
  });
  const projectObject = toRecord(projectResponse);
  const projects = Array.isArray(projectObject.values) ? projectObject.values : [];
  const exactNameMatches = projects.filter((item) => normalizedText(toRecord(item).name) === normalizedText(projectName));

  if (exactNameMatches.length === 0) {
    return { verified: false, detail: "project not found after create", required: true };
  }

  for (const item of exactNameMatches) {
    const match = matchesProjectRecord(toRecord(item), values, requestedManagerIsAssignable);
    if (match.matches) {
      return { verified: true, detail: match.detail, required: true };
    }
  }

  return {
    verified: false,
    detail: requestedManagerIsAssignable
      ? "project found, but customer or project manager linkage does not match the prompt"
      : "project found, but required customer linkage does not match the prompt",
    required: true,
  };
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textContains(actual: unknown, expected: unknown): boolean {
  const actualText = normalizedText(actual);
  const expectedText = normalizedText(expected);
  if (!expectedText) return true;
  if (!actualText) return false;
  return actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function entityToPath(entity: TaskEntity): string | null {
  const map: Record<string, string> = {
    attachment_onboarding: "/employee",
    employee: "/employee",
    customer: "/customer",
    supplier: "/supplier",
    product: "/product",
    department: "/department",
    project: "/project",
    order: "/order",
    invoice: "/invoice",
    invoice_reminder: "/reminder",
    supplier_invoice: "/ledger/voucher",
    bank_reconciliation: "/bank/reconciliation",
    ledger_variance_projects: "/project",
    ledger_error_correction: "/ledger/voucher",
    project_cycle: "/project",
    month_end_closing: "/ledger/voucher",
    accounting_dimension: "/ledger/accountingDimensionName",
    travel_expense: "/travelExpense",
    salary_transaction: "/salary/transaction",
    voucher: "/ledger/voucher",
    ledger_account: "/ledger/account",
    ledger_posting: "/ledger/posting",
  };
  return map[entity] ?? null;
}

function invoiceOrderMatches(
  item: unknown,
  expectedLines: Array<Record<string, unknown>>,
  expectedCustomer?: { searchName?: string; organizationNumber?: string },
): boolean {
  if (!item || typeof item !== "object") return false;
  const order = item as Record<string, unknown>;
  const preliminaryInvoice = order.preliminaryInvoice as Record<string, unknown> | undefined;
  if (!preliminaryInvoice?.id) return false;
  const customer = order.customer as Record<string, unknown> | undefined;
  const searchName = expectedCustomer?.searchName;
  const organizationNumber = expectedCustomer?.organizationNumber;
  if (organizationNumber && customer?.organizationNumber && normalizedText(customer.organizationNumber) !== normalizedText(organizationNumber)) {
    return false;
  }
  if (!organizationNumber && searchName && customer?.name && !String(customer.name).toLowerCase().includes(searchName.toLowerCase())) {
    return false;
  }
  if (expectedLines.length === 0) return true;
  const orderLines = Array.isArray(order.orderLines) ? order.orderLines : [];
  return expectedLines.every((expectedLine) => orderLines.some((candidate) => invoiceLineMatches(candidate, expectedLine)));
}

function invoiceRecordMatches(
  item: unknown,
  expectedLines: Array<Record<string, unknown>>,
  expectedCustomer?: { searchName?: string; organizationNumber?: string },
): boolean {
  if (!item || typeof item !== "object") return false;
  const invoice = item as Record<string, unknown>;
  const customer = invoice.customer as Record<string, unknown> | undefined;
  const searchName = expectedCustomer?.searchName;
  const organizationNumber = expectedCustomer?.organizationNumber;
  if (organizationNumber && customer?.organizationNumber && normalizedText(customer.organizationNumber) !== normalizedText(organizationNumber)) {
    return false;
  }
  if (!organizationNumber && searchName && customer?.name && !String(customer.name).toLowerCase().includes(searchName.toLowerCase())) {
    return false;
  }
  if (expectedLines.length === 0) return true;
  const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines : [];
  return expectedLines.every((expectedLine) => orderLines.some((candidate) => invoiceLineMatches(candidate, expectedLine)));
}

function invoicePaymentMatches(item: Record<string, unknown>): boolean {
  const outstandingCandidates = [
    item.amountOutstanding,
    item.amountCurrencyOutstanding,
    item.amountOutstandingTotal,
    item.amountCurrencyOutstandingTotal,
  ];
  return outstandingCandidates.some((value) => {
    const numeric = typeof value === "number" ? value : parseFlexibleNumber(String(value ?? ""));
    return numeric !== null && Math.abs(numeric) < 0.01;
  });
}

async function productRecordMatches(
  client: TripletexClient,
  record: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<boolean> {
  const expectedNumber = typeof (values.number ?? values.productNumber) === "string"
    ? String(values.number ?? values.productNumber).trim()
    : "";
  const expectedName = typeof (values.name ?? values.productName) === "string"
    ? String(values.name ?? values.productName).trim()
    : "";
  const expectedPrice = parseFlexibleNumber(String(values.priceExcludingVatCurrency ?? values.price ?? ""));
  const expectedCost = parseFlexibleNumber(String(values.costExcludingVatCurrency ?? values.cost ?? ""));
  const expectedVatRate = typeof values.vatRate === "number" ? values.vatRate : parseFlexibleNumber(String(values.vatRate ?? ""));
  const expectedAccountNumber = typeof values.accountNumber === "string" ? values.accountNumber.trim() : "";

  if (expectedNumber && normalizedText(record.number) !== normalizedText(expectedNumber)) return false;
  if (expectedName && !textContains(record.name, expectedName)) return false;

  const actualPrice = typeof record.priceExcludingVatCurrency === "number" ? record.priceExcludingVatCurrency : parseFlexibleNumber(String(record.priceExcludingVatCurrency ?? ""));
  if (expectedPrice !== null && actualPrice !== null && Math.abs(actualPrice - expectedPrice) > 0.01) return false;

  const actualCost = typeof record.costExcludingVatCurrency === "number" ? record.costExcludingVatCurrency : parseFlexibleNumber(String(record.costExcludingVatCurrency ?? ""));
  if (expectedCost !== null && actualCost !== null && Math.abs(actualCost - expectedCost) > 0.01) return false;

  const vatType = toRecord(record.vatType);
  const actualVatRate = typeof vatType.percentage === "number" ? vatType.percentage : parseFlexibleNumber(String(vatType.percentage ?? ""));
  if (expectedVatRate !== null && actualVatRate !== null && Math.abs(actualVatRate - expectedVatRate) > 0.01) return false;

  if (expectedAccountNumber) {
    const account = toRecord(record.account);
    const accountId = Number(account.id ?? 0);
    if (accountId <= 0) return false;
    const accountResponse = await client.request("GET", `/ledger/account/${accountId}`, {
      params: { fields: "id,number,name" },
    });
    const accountRecord = toRecord(primaryValue(accountResponse));
    if (normalizedText(accountRecord.number) !== normalizedText(expectedAccountNumber)) return false;
  }

  return true;
}

function invoiceLineMatches(candidate: unknown, expected: Record<string, unknown>): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const line = candidate as Record<string, unknown>;
  const product = line.product as Record<string, unknown> | undefined;
  const vatType = line.vatType as Record<string, unknown> | undefined;
  const expectedAmount = typeof expected.amount === "number" ? expected.amount : undefined;
  const actualAmount = typeof line.unitPriceExcludingVatCurrency === "number" ? line.unitPriceExcludingVatCurrency : undefined;
  const expectedVatRate = typeof expected.vatRate === "number" ? expected.vatRate : undefined;
  const actualVatRate = typeof vatType?.percentage === "number" ? vatType.percentage : undefined;

  if (expected.productNumber && String(product?.number ?? "").trim() !== String(expected.productNumber).trim()) return false;
  if (expected.productName && !expected.productNumber) {
    const actualName = String(product?.name ?? line.displayName ?? "").toLowerCase();
    if (!actualName.includes(String(expected.productName).toLowerCase())) return false;
  }
  if (expected.description && !expected.productNumber && !expected.productName) {
    const actualDescription = String(line.description ?? line.displayName ?? "").toLowerCase();
    if (!actualDescription.includes(String(expected.description).toLowerCase())) return false;
  }
  if (expectedAmount !== undefined && actualAmount !== undefined && Math.abs(actualAmount - expectedAmount) > 0.01) return false;
  if (expectedVatRate !== undefined && actualVatRate !== undefined && Math.abs(actualVatRate - expectedVatRate) > 0.01) return false;
  return true;
}

async function verifyAccountingDimensionOutcome(
  client: TripletexClient,
  spec: TaskSpec,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  return verifyAccountingDimensionWorkflowOutcome(client, spec);
}

async function verifySupplierInvoiceEntityOutcome(
  client: TripletexClient,
  spec: TaskSpec,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  return verifySupplierInvoiceWorkflowOutcome(client, spec);
}
