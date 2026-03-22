import type { ExecutionPlan } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type InvoiceReminderSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;
type Verification = { verified: boolean; detail: string; required: boolean };

type InvoiceRecord = Record<string, unknown>;
type CustomerRecord = {
  id: number;
  name?: string;
  organizationNumber?: string;
  email?: string;
  invoiceEmail?: string;
};

type ReminderType = "SOFT_REMINDER" | "REMINDER" | "NOTICE_OF_DEBT_COLLECTION";

type ReminderRecord = {
  id: number;
  type?: string;
  reminderDate?: string;
  termOfPayment?: string;
  charge?: number;
  interests?: number;
};

type FeeInvoiceRecord = {
  id: number;
  customerId?: number;
  customerName?: string;
  customerOrganizationNumber?: string;
  amount?: number;
  invoiceDate?: string;
  isApproved?: boolean;
  invoiceNumber?: string;
};

const INVOICE_FIELDS = [
  "id",
  "invoiceNumber",
  "invoiceDate",
  "invoiceDueDate",
  "amount",
  "amountExcludingVat",
  "amountOutstanding",
  "amountCurrencyOutstanding",
  "amountOutstandingTotal",
  "amountCurrencyOutstandingTotal",
  "isCharged",
  "isApproved",
  "customer(id,name,organizationNumber,email,invoiceEmail)",
  "orders(id)",
  "orderLines(description,displayName,product(name,number))",
  "reminders(id,type,charge,totalCharge,interests,termOfPayment,reminderDate)",
].join(",");

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toValues(value: unknown): Array<Record<string, unknown>> {
  const record = toRecord(value);
  if (Array.isArray(record.values)) {
    return record.values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  const single = primaryValue(value);
  return single && typeof single === "object" && !Array.isArray(single) ? [single as Record<string, unknown>] : [];
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function textContains(actual: unknown, expected: unknown): boolean {
  const actualText = normalizedText(actual);
  const expectedText = normalizedText(expected);
  if (!expectedText) return true;
  if (!actualText) return false;
  return actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/\s+/g, "").replace(/,/g, "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric === null) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  const anchor = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return `${String(anchor.getUTCFullYear()).padStart(4, "0")}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(anchor.getUTCDate()).padStart(2, "0")}`;
}

function maxIsoDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function reminderLeadDays(type: ReminderType): number {
  switch (type) {
    case "SOFT_REMINDER":
      return 1;
    case "REMINDER":
      return 14;
    case "NOTICE_OF_DEBT_COLLECTION":
      return 14;
    default:
      return 1;
  }
}

function reminderTypeFromValues(values: Record<string, unknown>): ReminderType {
  const direct = normalizedText(values.reminderType);
  if (direct === "notice_of_debt_collection") return "NOTICE_OF_DEBT_COLLECTION";
  if (direct === "reminder") return "REMINDER";
  return "SOFT_REMINDER";
}

function reminderStage(type: string | undefined): number {
  switch (type) {
    case "SOFT_REMINDER":
      return 1;
    case "REMINDER":
      return 2;
    case "NOTICE_OF_DEBT_COLLECTION":
      return 3;
    default:
      return 0;
  }
}

function shouldIncludeCharge(values: Record<string, unknown>, reminderType: ReminderType): boolean {
  if (wantsFeeInvoice(values) && asNumber(values.reminderFeeAmount) !== null) return false;
  if (typeof values.includeReminderCharge === "boolean") return values.includeReminderCharge;
  if (typeof values.reminderFeeAmount === "number" && values.reminderFeeAmount > 0) return true;
  return reminderType !== "SOFT_REMINDER";
}

function shouldIncludeInterest(values: Record<string, unknown>, reminderType: ReminderType): boolean {
  if (typeof values.includeReminderInterests === "boolean") return values.includeReminderInterests;
  return reminderType !== "SOFT_REMINDER";
}

function invoiceOutstanding(invoice: InvoiceRecord): number | null {
  for (const candidate of [
    invoice.amountOutstanding,
    invoice.amountCurrencyOutstanding,
    invoice.amountOutstandingTotal,
    invoice.amountCurrencyOutstandingTotal,
  ]) {
    const numeric = asNumber(candidate);
    if (numeric !== null) return numeric;
  }
  return null;
}

function invoiceReminderRecords(invoice: InvoiceRecord): ReminderRecord[] {
  if (!Array.isArray(invoice.reminders)) return [];
  return invoice.reminders
    .map((item) => toRecord(item))
    .map((item) => ({
      id: positiveInteger(item.id) ?? 0,
      type: typeof item.type === "string" ? item.type : undefined,
      reminderDate: typeof item.reminderDate === "string" ? item.reminderDate : undefined,
      termOfPayment: typeof item.termOfPayment === "string" ? item.termOfPayment : undefined,
      charge: asNumber(item.charge) ?? undefined,
      interests: asNumber(item.interests) ?? undefined,
    }))
    .filter((item) => item.id > 0);
}

function paymentLabel(values: Record<string, unknown>): string {
  const candidate =
    (typeof values.description === "string" && values.description.trim())
    || (typeof values.productName === "string" && values.productName.trim())
    || (typeof values.name === "string" && values.name.trim())
    || firstInvoiceLineLabel(values.invoiceLines);
  const label = typeof candidate === "string" ? candidate.trim() : "";
  if (/\b(?:reminder fee|late fee|purregebyr|frais de rappel|taxa de lembrete|mahnung|purring)\b/i.test(label)) {
    return "";
  }
  return label;
}

function targetInvoiceAmountHint(values: Record<string, unknown>, lookup: Record<string, unknown>): number | null {
  const amountHint = asNumber(values.amount ?? lookup.amount);
  const feeAmount = asNumber(values.reminderFeeAmount);
  if (amountHint !== null && feeAmount !== null && Math.abs(amountHint - feeAmount) < 0.05) {
    return null;
  }
  return amountHint;
}

function firstInvoiceLineLabel(lines: unknown): string {
  if (!Array.isArray(lines)) return "";
  for (const line of lines) {
    const record = toRecord(line);
    const candidate =
      (typeof record.description === "string" && record.description.trim())
      || (typeof record.productName === "string" && record.productName.trim())
      || (typeof record.productNumber === "string" && record.productNumber.trim());
    if (candidate) return String(candidate).trim();
  }
  return "";
}

function invoiceLineContains(line: unknown, label: string): boolean {
  const record = toRecord(line);
  const product = toRecord(record.product);
  return (
    textContains(record.description, label)
    || textContains(record.displayName, label)
    || textContains(product.name, label)
    || textContains(product.number, label)
  );
}

function invoiceMatchesPrompt(
  invoice: InvoiceRecord,
  values: Record<string, unknown>,
  lookup: Record<string, unknown>,
): boolean {
  const expectedOrg = normalizedText(values.organizationNumber);
  const expectedCustomerName = normalizedText(values.customerName);
  const expectedInvoiceNumber = normalizedText(values.invoiceNumber ?? lookup.invoiceNumber);
  const invoiceCustomer = toRecord(invoice.customer);

  if (expectedInvoiceNumber && normalizedText(invoice.invoiceNumber) !== expectedInvoiceNumber) return false;
  if (expectedOrg && normalizedText(invoiceCustomer.organizationNumber) !== expectedOrg) return false;
  if (!expectedOrg && expectedCustomerName && !textContains(invoiceCustomer.name, expectedCustomerName)) return false;

  const amountHint = targetInvoiceAmountHint(values, lookup);
  if (amountHint !== null) {
    const matched = [invoice.amountExcludingVat, invoice.amount, invoice.amountOutstanding, invoice.amountOutstandingTotal]
      .map((item) => asNumber(item))
      .some((item) => item !== null && Math.abs(item - amountHint) < 0.05);
    if (!matched) return false;
  }

  const label = paymentLabel(values);
  if (label) {
    const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines : [];
    const labelMatched = orderLines.some((line) => invoiceLineContains(line, label));
    const hasStrongIdentity = Boolean(expectedInvoiceNumber || expectedOrg || expectedCustomerName || amountHint !== null);
    if (!labelMatched && !hasStrongIdentity) return false;
  }

  return true;
}

function scoreInvoiceCandidate(invoice: InvoiceRecord, values: Record<string, unknown>, lookup: Record<string, unknown>): number {
  if (!invoiceMatchesPrompt(invoice, values, lookup)) return 0;
  const targetStage = reminderStage(reminderTypeFromValues(values));
  const currentStage = invoiceReminderRecords(invoice)
    .map((item) => reminderStage(item.type))
    .reduce((max, stage) => Math.max(max, stage), 0);
  const hasDirectInvoiceTarget = Boolean(
    positiveInteger(lookup.id ?? lookup.invoiceId ?? values.invoiceId)
    || (typeof values.invoiceNumber === "string" && values.invoiceNumber.trim())
  );
  const dueDate = parseIsoDate(invoice.invoiceDueDate);
  const isOverdue = Boolean(dueDate && dueDate < todayIsoInZone());
  if (!hasDirectInvoiceTarget && !isOverdue) return 0;
  if (!hasDirectInvoiceTarget && currentStage >= targetStage) return 0;

  let score = 0;
  if (positiveInteger(invoice.id)) score += 1;
  if (invoice.isCharged === true) score += 20;
  if (invoice.isApproved === true) score += 2;
  const outstanding = invoiceOutstanding(invoice);
  if (outstanding !== null && outstanding > 0.01) score += 20;
  if (dueDate && dueDate < todayIsoInZone()) score += 8;
  if (currentStage === 0) score += 10;
  else if (currentStage < targetStage) score += 4;

  const expectedInvoiceNumber = typeof values.invoiceNumber === "string" ? values.invoiceNumber.trim() : "";
  if (expectedInvoiceNumber && normalizedText(invoice.invoiceNumber) === normalizedText(expectedInvoiceNumber)) score += 18;

  const amountHint = asNumber(values.amount ?? lookup.amount);
  if (amountHint !== null && outstanding !== null && Math.abs(outstanding - amountHint) < 0.05) score += 10;

  const label = paymentLabel(values);
  if (label) {
    const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines : [];
    if (orderLines.some((line) => invoiceLineContains(line, label))) score += 6;
  }

  return score;
}

async function fetchInvoiceById(client: TripletexClient, invoiceId: number): Promise<InvoiceRecord> {
  const response = await client.request("GET", `/invoice/${invoiceId}`, { params: { fields: INVOICE_FIELDS } });
  return toRecord(primaryValue(response));
}

async function resolveCustomer(client: TripletexClient, values: Record<string, unknown>): Promise<CustomerRecord> {
  const expectedOrganizationNumber = typeof values.organizationNumber === "string" ? values.organizationNumber.trim() : "";
  const expectedCustomerName = typeof values.customerName === "string"
    ? values.customerName.trim()
    : typeof values.name === "string"
      ? values.name.trim()
      : "";

  if (expectedOrganizationNumber) {
    const response = await client.request("GET", "/customer", {
      params: { count: 20, from: 0, organizationNumber: expectedOrganizationNumber, fields: "id,name,organizationNumber,email,invoiceEmail" },
    });
    const match = toValues(response)
      .map((item) => toRecord(item))
      .find((item) => normalizedText(item.organizationNumber) === normalizedText(expectedOrganizationNumber));
    if (match) {
      return {
        id: positiveInteger(match.id) ?? 0,
        name: typeof match.name === "string" ? match.name : undefined,
        organizationNumber: typeof match.organizationNumber === "string" ? match.organizationNumber : undefined,
        email: typeof match.email === "string" ? match.email : undefined,
        invoiceEmail: typeof match.invoiceEmail === "string" ? match.invoiceEmail : undefined,
      };
    }
  }

  if (expectedCustomerName) {
    const response = await client.request("GET", "/customer", {
      params: { count: 20, from: 0, name: expectedCustomerName, fields: "id,name,organizationNumber,email,invoiceEmail" },
    });
    const exact = toValues(response)
      .map((item) => toRecord(item))
      .find((item) => normalizedText(item.name) === normalizedText(expectedCustomerName));
    if (exact) {
      return {
        id: positiveInteger(exact.id) ?? 0,
        name: typeof exact.name === "string" ? exact.name : undefined,
        organizationNumber: typeof exact.organizationNumber === "string" ? exact.organizationNumber : undefined,
        email: typeof exact.email === "string" ? exact.email : undefined,
        invoiceEmail: typeof exact.invoiceEmail === "string" ? exact.invoiceEmail : undefined,
      };
    }
  }

  return { id: 0 };
}

async function ensureCustomer(client: TripletexClient, values: Record<string, unknown>, reminderDate: string): Promise<CustomerRecord> {
  const existing = await resolveCustomer(client, values);
  if (existing.id > 0) return existing;

  const name =
    (typeof values.customerName === "string" && values.customerName.trim())
    || (typeof values.name === "string" && values.name.trim())
    || `Reminder Customer ${Date.now().toString().slice(-6)}`;
  const email =
    (typeof values.reminderEmail === "string" && values.reminderEmail.trim())
    || (typeof values.invoiceEmail === "string" && values.invoiceEmail.trim())
    || (typeof values.email === "string" && values.email.trim())
    || "debug@example.org";
  const leadDays = reminderLeadDays(reminderTypeFromValues(values));
  const invoiceDate = shiftIsoDate(reminderDate, -(leadDays + 1));

  const created = await client.request("POST", "/customer", {
    body: {
      name,
      organizationNumber: typeof values.organizationNumber === "string" && values.organizationNumber.trim()
        ? values.organizationNumber.trim()
        : undefined,
      isCustomer: true,
      email,
      invoiceEmail: email,
      overdueNoticeEmail: email,
      invoicesDueIn: 0,
      invoicesDueInType: "DAYS",
      description: `Created for reminder workflow on ${invoiceDate}`,
    },
  });
  const record = toRecord(primaryValue(created));
  return {
    id: positiveInteger(record.id) ?? 0,
    name: typeof record.name === "string" ? record.name : name,
    organizationNumber: typeof record.organizationNumber === "string" ? record.organizationNumber : undefined,
    email: typeof record.email === "string" ? record.email : email,
    invoiceEmail: typeof record.invoiceEmail === "string" ? record.invoiceEmail : email,
  };
}

async function ensureProductId(client: TripletexClient, values: Record<string, unknown>): Promise<number> {
  const revenueAccountNumber = positiveInteger(values.accountNumber) ?? 3400;
  let revenueAccountId: number | null = null;
  if (revenueAccountNumber) {
    const accountResponse = await client.request("GET", "/ledger/account", {
      params: { count: 1, from: 0, number: String(revenueAccountNumber), fields: "id,number,name" },
    });
    revenueAccountId = positiveInteger(toRecord(primaryValue(accountResponse)).id);
  }
  const number = typeof values.number === "string" && values.number.trim()
    ? values.number.trim()
    : `9${Date.now().toString().slice(-6)}`;
  const existing = await client.request("GET", "/product", {
    params: { count: 10, from: 0, productNumber: [number], fields: "id,number,name,account(id,number)" },
  });
  const exact = toValues(existing)
    .map((item) => toRecord(item))
    .find((item) => {
      if (normalizedText(item.number) !== normalizedText(number)) return false;
      if (!revenueAccountId) return true;
      return positiveInteger(toRecord(item.account).id) === revenueAccountId;
    });
  const existingId = positiveInteger(exact?.id);
  if (existingId) return existingId;

  const created = await client.request("POST", "/product", {
    body: {
      name: paymentLabel(values) || `Reminder Product ${Date.now().toString().slice(-6)}`,
      number,
      priceExcludingVatCurrency: asNumber(values.amount) ?? 1000,
      ...(revenueAccountId ? { account: { id: revenueAccountId } } : {}),
    },
  });
  const productId = positiveInteger(toRecord(primaryValue(created)).id);
  if (!productId) throw new Error("Failed to create product for reminder workflow");
  return productId;
}

function plannedReminderDate(
  values: Record<string, unknown>,
  invoiceDueDate: string,
  reminderType: ReminderType,
  existingReminders: ReminderRecord[] = [],
): string {
  const desired = parseIsoDate(values.date) ?? todayIsoInZone();
  const earliest = shiftIsoDate(invoiceDueDate, reminderLeadDays(reminderType));
  let candidate = maxIsoDate(desired, earliest);
  const reminderBarrier = existingReminders
    .map((item) => parseIsoDate(item.termOfPayment) ?? parseIsoDate(item.reminderDate))
    .filter((item): item is string => Boolean(item))
    .sort()
    .at(-1);
  if (reminderBarrier) {
    candidate = maxIsoDate(candidate, shiftIsoDate(reminderBarrier, 1));
  }
  return candidate;
}

function dispatchEmail(values: Record<string, unknown>, customer: CustomerRecord, invoice: InvoiceRecord): string | undefined {
  return (
    (typeof values.reminderEmail === "string" && values.reminderEmail.trim())
    || (typeof values.invoiceEmail === "string" && values.invoiceEmail.trim())
    || (typeof values.email === "string" && values.email.trim())
    || customer.invoiceEmail
    || customer.email
    || (typeof toRecord(invoice.customer).invoiceEmail === "string" ? String(toRecord(invoice.customer).invoiceEmail).trim() : "")
    || (typeof toRecord(invoice.customer).email === "string" ? String(toRecord(invoice.customer).email).trim() : "")
    || undefined
  );
}

function dispatchTypeFor(values: Record<string, unknown>, customer: CustomerRecord, invoice: InvoiceRecord): "EMAIL" | "OWN_PRINTER" {
  if (dispatchEmail(values, customer, invoice)) return "EMAIL";
  return "OWN_PRINTER";
}

function reminderLooksSufficient(
  reminder: ReminderRecord,
  reminderType: ReminderType,
  reminderDate: string,
  includeCharge: boolean,
): boolean {
  if (reminder.id <= 0) return false;
  if (reminder.type !== reminderType) return false;
  if (reminder.reminderDate !== reminderDate) return false;
  if (includeCharge && !(typeof reminder.charge === "number" && reminder.charge > 0)) return false;
  return true;
}

function wantsFeeInvoice(values: Record<string, unknown>): boolean {
  return values.createReminderFeeInvoice === true;
}

function wantsFeeInvoiceSend(values: Record<string, unknown>): boolean {
  return values.sendReminderFeeInvoice === true || values.sendInvoice === true;
}

function reminderFeeAmount(values: Record<string, unknown>, reminder: ReminderRecord | null): number {
  const explicit = asNumber(values.reminderFeeAmount);
  if (explicit !== null && explicit > 0) return explicit;
  const reminderCharge = asNumber(reminder?.charge);
  if (reminderCharge !== null && reminderCharge > 0) return reminderCharge;
  return 50;
}

function feeInvoiceDescription(values: Record<string, unknown>): string {
  const description = typeof values.description === "string" ? values.description.trim() : "";
  if (description && description.length <= 180) return description;
  return "Reminder fee";
}

async function resolveTargetInvoice(
  client: TripletexClient,
  values: Record<string, unknown>,
  lookup: Record<string, unknown>,
): Promise<InvoiceRecord> {
  const directId = positiveInteger(lookup.id ?? lookup.invoiceId ?? values.invoiceId);
  if (directId) {
    return fetchInvoiceById(client, directId);
  }

  const customer = await resolveCustomer(client, values);
  const params: Record<string, unknown> = {
    count: 100,
    from: 0,
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2100-12-31",
    fields: INVOICE_FIELDS,
  };
  if (customer.id > 0) params.customerId = customer.id;
  const response = await client.request("GET", "/invoice", { params });
  const invoices = toValues(response).map((item) => toRecord(item));
  const ranked = invoices
    .filter((invoice) => {
      if (invoice.isCharged !== true) return false;
      if ((invoiceOutstanding(invoice) ?? 0) <= 0.01) return false;
      const dueDate = parseIsoDate(invoice.invoiceDueDate);
      return Boolean(dueDate && dueDate < todayIsoInZone());
    })
    .map((invoice) => ({ invoice, score: scoreInvoiceCandidate(invoice, values, lookup) }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  if (!selected || selected.score <= 0) {
    throw new Error("No matching charged overdue invoice found for reminder registration");
  }
  return selected.invoice;
}

async function createFallbackReminderInvoice(client: TripletexClient, values: Record<string, unknown>): Promise<InvoiceRecord> {
  const reminderType = reminderTypeFromValues(values);
  const baseReminderDate = parseIsoDate(values.date) ?? todayIsoInZone();
  const invoiceDate = shiftIsoDate(baseReminderDate, -(reminderLeadDays(reminderType) + 1));
  const customer = await ensureCustomer(client, values, baseReminderDate);
  const productId = await ensureProductId(client, values);
  const amount = asNumber(values.amount) ?? 1000;

  const orderResponse = await client.request("POST", "/order", {
    body: {
      customer: { id: customer.id },
      orderDate: invoiceDate,
      deliveryDate: invoiceDate,
      invoicesDueIn: 0,
      invoicesDueInType: "DAYS",
      receiverEmail: customer.invoiceEmail ?? customer.email,
      overdueNoticeEmail: customer.invoiceEmail ?? customer.email,
      orderLines: [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: amount,
          description: paymentLabel(values) || "Reminder invoice line",
        },
      ],
    },
  });
  const orderId = positiveInteger(toRecord(primaryValue(orderResponse)).id);
  if (!orderId) throw new Error("Failed to create order for reminder workflow");

  const invoiceResponse = await client.request("PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: orderId,
      invoiceDate,
      sendToCustomer: true,
    },
  });
  const invoiceId = positiveInteger(toRecord(primaryValue(invoiceResponse)).id);
  if (!invoiceId) throw new Error("Failed to create invoice for reminder workflow");
  return fetchInvoiceById(client, invoiceId);
}

async function resolveOrCreateTargetInvoice(
  client: TripletexClient,
  values: Record<string, unknown>,
  lookup: Record<string, unknown>,
): Promise<InvoiceRecord> {
  const hasExplicitTarget = Boolean(
    positiveInteger(lookup.id ?? lookup.invoiceId ?? values.invoiceId)
    || (typeof values.invoiceNumber === "string" && values.invoiceNumber.trim())
    || (typeof values.organizationNumber === "string" && values.organizationNumber.trim())
    || (typeof values.customerName === "string" && values.customerName.trim())
  );
  try {
    return await resolveTargetInvoice(client, values, lookup);
  } catch {
    if (!hasExplicitTarget) {
      throw new Error("No eligible overdue invoice found for reminder registration");
    }
    return createFallbackReminderInvoice(client, values);
  }
}

async function fetchReminderById(client: TripletexClient, reminderId: number): Promise<ReminderRecord | null> {
  const response = await client.request("GET", `/reminder/${reminderId}`);
  const record = toRecord(primaryValue(response));
  const id = positiveInteger(record.id);
  if (!id) return null;
  return {
    id,
    type: typeof record.type === "string" ? record.type : undefined,
    reminderDate: typeof record.reminderDate === "string" ? record.reminderDate : undefined,
    termOfPayment: typeof record.termOfPayment === "string" ? record.termOfPayment : undefined,
    charge: asNumber(record.charge) ?? undefined,
    interests: asNumber(record.interests) ?? undefined,
  };
}

async function createReminderFeeInvoice(
  client: TripletexClient,
  input: {
    customer: CustomerRecord;
    amount: number;
    invoiceDate: string;
    values: Record<string, unknown>;
  },
): Promise<number> {
  const productId = await ensureProductId(client, {
    ...input.values,
    amount: input.amount,
  });
  const body = {
    customer: { id: input.customer.id },
    orderDate: input.invoiceDate,
    deliveryDate: input.invoiceDate,
    receiverEmail: input.customer.invoiceEmail ?? input.customer.email,
    overdueNoticeEmail: input.customer.invoiceEmail ?? input.customer.email,
    orderLines: [
      {
        product: { id: productId },
        description: feeInvoiceDescription(input.values),
        count: 1,
        unitPriceExcludingVatCurrency: input.amount,
      },
    ],
  };
  const createdOrder = await client.request("POST", "/order", { body });
  const orderId = positiveInteger(toRecord(primaryValue(createdOrder)).id);
  if (!orderId) throw new Error("Failed to create order for reminder fee invoice");

  const invoiceResponse = await client.request("PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: orderId,
      invoiceDate: input.invoiceDate,
      sendToCustomer: false,
    },
  });
  const invoiceId = positiveInteger(toRecord(primaryValue(invoiceResponse)).id);
  if (!invoiceId) throw new Error("Failed to create reminder fee invoice");
  return invoiceId;
}

async function sendInvoiceIfRequested(
  client: TripletexClient,
  invoiceId: number,
  customer: CustomerRecord,
  values: Record<string, unknown>,
): Promise<void> {
  if (!wantsFeeInvoiceSend(values)) return;
  const params: Record<string, unknown> = { sendType: "EMAIL" };
  const email =
    (typeof values.reminderEmail === "string" && values.reminderEmail.trim())
    || (typeof values.invoiceEmail === "string" && values.invoiceEmail.trim())
    || customer.invoiceEmail
    || customer.email;
  if (email) {
    params.overrideEmailAddress = email;
  } else {
    params.sendType = "MANUAL";
  }
  await client.request("PUT", `/invoice/${invoiceId}/:send`, { params });
}

async function fetchFeeInvoiceById(client: TripletexClient, invoiceId: number): Promise<FeeInvoiceRecord | null> {
  const response = await client.request("GET", `/invoice/${invoiceId}`, {
    params: {
      fields: "id,invoiceNumber,invoiceDate,isApproved,amount,amountExcludingVat,customer(id,name,organizationNumber)",
    },
  });
  const record = toRecord(primaryValue(response));
  const id = positiveInteger(record.id);
  if (!id) return null;
  const customer = toRecord(record.customer);
  return {
    id,
    invoiceNumber: typeof record.invoiceNumber === "string" ? record.invoiceNumber : undefined,
    invoiceDate: typeof record.invoiceDate === "string" ? record.invoiceDate : undefined,
    isApproved: typeof record.isApproved === "boolean" ? record.isApproved : undefined,
    amount: asNumber(record.amountExcludingVat) ?? asNumber(record.amount) ?? undefined,
    customerId: positiveInteger(customer.id) ?? undefined,
    customerName: typeof customer.name === "string" ? customer.name : undefined,
    customerOrganizationNumber: typeof customer.organizationNumber === "string" ? customer.organizationNumber : undefined,
  };
}

export function matchesInvoiceReminderWorkflow(spec: InvoiceReminderSpec): boolean {
  return spec.entity === "invoice_reminder" && spec.operation === "create";
}

export function compileInvoiceReminderPreview(spec: InvoiceReminderSpec): ExecutionPlan {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const reminderType = reminderTypeFromValues(values);
  const chargeMode = shouldIncludeCharge(values, reminderType) ? "with fee" : "without fee";
  const includeFeeInvoice = wantsFeeInvoice(values);
  const feeInvoicePreviewSteps: ExecutionPlan["steps"] = includeFeeInvoice
    ? [
        { method: "POST", path: "/order", body: { customer: { id: "{{customer_id}}" }, orderLines: [{ description: feeInvoiceDescription(values), count: 1, unitPriceExcludingVatCurrency: values.reminderFeeAmount ?? 50 }] }, saveAs: "feeOrder" },
        { method: "PUT", path: "/order/:invoiceMultipleOrders", params: { id: "{{feeOrder_id}}", invoiceDate: values.date ?? todayIsoInZone(), sendToCustomer: false }, saveAs: "feeInvoice" },
        { method: "PUT", path: "/invoice/{{feeInvoice_id}}/:send", params: { sendType: "EMAIL" } },
      ]
    : [];
  const invoiceId = positiveInteger(lookup.id ?? lookup.invoiceId ?? values.invoiceId);
  if (invoiceId) {
    return {
      summary: `Create ${reminderType.toLowerCase()} on invoice ${invoiceId}`,
      steps: [
        { method: "GET", path: `/invoice/${invoiceId}`, params: { fields: INVOICE_FIELDS } },
        { method: "PUT", path: `/invoice/${invoiceId}/:createReminder`, params: { type: reminderType, date: values.date ?? todayIsoInZone(), includeCharge: shouldIncludeCharge(values, reminderType), includeInterest: shouldIncludeInterest(values, reminderType), dispatchType: "EMAIL" } },
        ...feeInvoicePreviewSteps,
        { method: "GET", path: `/invoice/${invoiceId}`, params: { fields: INVOICE_FIELDS } },
      ],
    };
  }

  return {
    summary: `Create ${reminderType.toLowerCase()} ${chargeMode}`,
    steps: [
      { method: "GET", path: "/customer", params: { count: 20, from: 0, fields: "id,name,organizationNumber" } },
      { method: "GET", path: "/invoice", params: { count: 50, from: 0, invoiceDateFrom: "2020-01-01", invoiceDateTo: "2100-12-31", fields: INVOICE_FIELDS } },
      { method: "PUT", path: "/invoice/{{invoice_id}}/:createReminder", params: { type: reminderType, date: values.date ?? todayIsoInZone(), includeCharge: shouldIncludeCharge(values, reminderType), includeInterest: shouldIncludeInterest(values, reminderType), dispatchType: "EMAIL" } },
      ...feeInvoicePreviewSteps,
      { method: "GET", path: "/invoice/{{invoice_id}}", params: { fields: INVOICE_FIELDS } },
    ],
  };
}

export async function executeInvoiceReminderWorkflow(
  client: TripletexClient,
  spec: InvoiceReminderSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const preview = compileInvoiceReminderPreview(spec);
  if (dryRun) return preview;

  const invoice = await resolveOrCreateTargetInvoice(client, values, lookup);
  const invoiceId = positiveInteger(invoice.id);
  if (!invoiceId) throw new Error("Unable to resolve charged invoice for reminder workflow");
  values.__invoiceReminderInvoiceId = invoiceId;

  const customer = await resolveCustomer(client, values);
  const reminderType = reminderTypeFromValues(values);
  const beforeReminders = invoiceReminderRecords(invoice);
  const reminderDate = plannedReminderDate(values, parseIsoDate(invoice.invoiceDueDate) ?? todayIsoInZone(), reminderType, beforeReminders);
  const includeCharge = shouldIncludeCharge(values, reminderType);
  const includeInterest = shouldIncludeInterest(values, reminderType);
  const existing = beforeReminders.find((item) => reminderLooksSufficient(item, reminderType, reminderDate, includeCharge));
  const params: Record<string, unknown> = {
    type: reminderType,
    date: reminderDate,
    includeCharge,
    includeInterest,
    dispatchType: dispatchTypeFor(values, customer, invoice),
  };
  const email = dispatchEmail(values, customer, invoice);
  if (params.dispatchType === "EMAIL" && email) {
    params.email = email;
  }

  let created = existing;
  let reminderActionPerformed = false;
  if (!created) {
    const reminderResponse = await client.request("PUT", `/invoice/${invoiceId}/:createReminder`, { params });
    reminderActionPerformed = true;
    const returnedReminder = primaryValue(reminderResponse);
    const returnedReminderId = positiveInteger(
      typeof returnedReminder === "object" && returnedReminder !== null
        ? toRecord(returnedReminder).id
        : returnedReminder,
    );
    if (returnedReminderId) {
      try {
        const fetchedReminder = await fetchReminderById(client, returnedReminderId);
        if (fetchedReminder?.id) {
          created = fetchedReminder;
        }
      } catch {
        // Fall back to resolving from the updated invoice record.
      }
    }

    if (!created) {
      const updatedInvoice = await fetchInvoiceById(client, invoiceId);
      const beforeIds = new Set(beforeReminders.map((item) => item.id));
      created = invoiceReminderRecords(updatedInvoice)
        .filter((item) => !beforeIds.has(item.id))
        .find((item) => reminderLooksSufficient(item, reminderType, reminderDate, includeCharge))
        ?? invoiceReminderRecords(updatedInvoice)
          .filter((item) => reminderLooksSufficient(item, reminderType, reminderDate, includeCharge))
          .sort((left, right) => right.id - left.id)[0];
    }

    if (!created) {
      throw new Error("Reminder was created, but could not be resolved from the invoice record");
    }
  }

  values.__invoiceReminderId = created.id;
  values.__invoiceReminderType = reminderType;
  values.__invoiceReminderDate = reminderDate;

  let feeInvoiceId: number | null = positiveInteger(values.__invoiceReminderFeeInvoiceId);
  if (wantsFeeInvoice(values) && !feeInvoiceId) {
    const feeAmount = reminderFeeAmount(values, created);
    const invoiceCustomer = toRecord(invoice.customer);
    const targetCustomer: CustomerRecord = {
      id: positiveInteger(invoiceCustomer.id) ?? customer.id,
      name: typeof invoiceCustomer.name === "string" ? invoiceCustomer.name : customer.name,
      organizationNumber: typeof invoiceCustomer.organizationNumber === "string" ? invoiceCustomer.organizationNumber : customer.organizationNumber,
      email: typeof invoiceCustomer.email === "string" ? invoiceCustomer.email : customer.email,
      invoiceEmail: typeof invoiceCustomer.invoiceEmail === "string" ? invoiceCustomer.invoiceEmail : customer.invoiceEmail,
    };
    feeInvoiceId = await createReminderFeeInvoice(client, {
      customer: targetCustomer,
      amount: feeAmount,
      invoiceDate: reminderDate,
      values,
    });
    await sendInvoiceIfRequested(client, feeInvoiceId, targetCustomer, values);
    values.__invoiceReminderFeeInvoiceId = feeInvoiceId;
    values.__invoiceReminderFeeAmount = feeAmount;
  }

  return {
    summary: reminderActionPerformed
      ? `Create ${reminderType.toLowerCase()} on invoice ${invoiceId}`
      : `Reminder already exists on invoice ${invoiceId}`,
    steps: (() => {
      const feeSteps: ExecutionPlan["steps"] = feeInvoiceId
        ? [
            { method: "POST", path: "/order", body: { customer: { id: "{{customer_id}}" }, orderLines: [{ description: feeInvoiceDescription(values), count: 1, unitPriceExcludingVatCurrency: values.__invoiceReminderFeeAmount ?? values.reminderFeeAmount ?? 50 }] }, saveAs: "feeOrder" },
            { method: "PUT", path: "/order/:invoiceMultipleOrders", params: { id: "{{feeOrder_id}}", invoiceDate: reminderDate, sendToCustomer: false }, saveAs: "feeInvoice" },
            ...(wantsFeeInvoiceSend(values)
              ? [{ method: "PUT", path: `/invoice/${feeInvoiceId}/:send`, params: { sendType: "EMAIL" } } satisfies ExecutionPlan["steps"][number]]
              : []),
            { method: "GET", path: `/invoice/${feeInvoiceId}`, params: { fields: "id,invoiceNumber,invoiceDate,isApproved,amount,amountExcludingVat,customer(id,name,organizationNumber)" } },
          ]
        : [];
      return [
        { method: "GET", path: `/invoice/${invoiceId}`, params: { fields: INVOICE_FIELDS } },
        ...(reminderActionPerformed
          ? [{ method: "PUT", path: `/invoice/${invoiceId}/:createReminder`, params } satisfies ExecutionPlan["steps"][number]]
          : []),
        ...feeSteps,
        { method: "GET", path: `/invoice/${invoiceId}`, params: { fields: INVOICE_FIELDS } },
        { method: "GET", path: `/reminder/${created.id}` },
      ];
    })(),
  };
}

export async function verifyInvoiceReminderOutcome(
  client: TripletexClient,
  spec: InvoiceReminderSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const reminderType = reminderTypeFromValues(values);
  const includeCharge = shouldIncludeCharge(values, reminderType);
  const reminderId = positiveInteger(values.__invoiceReminderId);
  const invoiceId = positiveInteger(values.__invoiceReminderInvoiceId ?? lookup.id ?? lookup.invoiceId ?? values.invoiceId);

  if (!invoiceId) {
    return { verified: false, detail: "invoice reminder workflow did not record the invoice id", required: true };
  }

  const invoice = await fetchInvoiceById(client, invoiceId);
  if (!invoiceMatchesPrompt(invoice, values, lookup)) {
    return { verified: false, detail: "reminded invoice does not match the requested customer/invoice context", required: true };
  }
  if (invoice.isCharged !== true || (invoiceOutstanding(invoice) ?? 0) <= 0.01) {
    return { verified: false, detail: "target invoice is not a charged open invoice", required: true };
  }

  const reminderDate = plannedReminderDate(values, parseIsoDate(invoice.invoiceDueDate) ?? todayIsoInZone(), reminderType, invoiceReminderRecords(invoice));
  let reminder = reminderId ? await fetchReminderById(client, reminderId) : null;
  if (!reminder) {
    reminder = invoiceReminderRecords(invoice)
      .filter((item) => reminderLooksSufficient(item, reminderType, reminderDate, includeCharge))
      .sort((left, right) => right.id - left.id)[0] ?? null;
  }
  if (!reminder) {
    return { verified: false, detail: `no ${reminderType.toLowerCase()} found on invoice after reminder registration`, required: true };
  }
  if (includeCharge && !(typeof reminder.charge === "number" && reminder.charge > 0)) {
    return { verified: false, detail: "reminder exists, but no reminder fee was added", required: true };
  }
  if (wantsFeeInvoice(values)) {
    const feeInvoiceId = positiveInteger(values.__invoiceReminderFeeInvoiceId);
    if (!feeInvoiceId) {
      return { verified: false, detail: "reminder fee invoice was requested but no fee invoice id was recorded", required: true };
    }
    const feeInvoice = await fetchFeeInvoiceById(client, feeInvoiceId);
    if (!feeInvoice) {
      return { verified: false, detail: "reminder fee invoice could not be fetched by id", required: true };
    }
    const feeAmount = reminderFeeAmount(values, reminder);
    if (feeInvoice.amount == null || Math.abs(feeInvoice.amount - feeAmount) >= 0.05) {
      return { verified: false, detail: "reminder fee invoice amount does not match the requested fee", required: true };
    }
    const invoiceCustomer = toRecord(invoice.customer);
    if (
      feeInvoice.customerId
      && positiveInteger(invoiceCustomer.id)
      && feeInvoice.customerId !== positiveInteger(invoiceCustomer.id)
    ) {
      return { verified: false, detail: "reminder fee invoice was created for the wrong customer", required: true };
    }
  }
  return { verified: true, detail: "invoice reminder verified", required: true };
}
