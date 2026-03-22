import { todayIsoInZone } from "./dates.js";
import type { ExecutionPlan } from "./schemas.js";
import { TripletexClient } from "./tripletex.js";

type ReturnedPaymentSpec = {
  operation: string;
  entity: string;
  values?: Record<string, unknown>;
};

type InvoiceCandidate = Record<string, unknown>;

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
  if (!expectedText || !actualText) return false;
  return actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function amountMatches(actual: unknown, expected: unknown): boolean {
  const actualNumber = asNumber(actual);
  const expectedNumber = asNumber(expected);
  if (actualNumber === null || expectedNumber === null) return false;
  return Math.abs(actualNumber - expectedNumber) < 0.01;
}

function invoiceMatches(invoice: InvoiceCandidate, invoiceLabel: string, amountHint: number | null): number {
  let score = 0;
  if (amountHint !== null) {
    if (amountMatches(invoice.amountExcludingVat, amountHint)) score += 5;
    else if (amountMatches(invoice.amount, amountHint)) score += 4;
  }

  const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines as unknown[] : [];
  for (const line of orderLines) {
    const record = toRecord(line);
    const product = toRecord(record.product);
    if (
      textContains(record.description, invoiceLabel)
      || textContains(record.displayName, invoiceLabel)
      || textContains(product.name, invoiceLabel)
    ) {
      score += 6;
      break;
    }
  }

  const outstanding = asNumber(invoice.amountOutstanding);
  const outstandingTotal = asNumber(invoice.amountOutstandingTotal);
  if ((outstanding !== null && outstanding <= 0.01) || (outstandingTotal !== null && outstandingTotal <= 0.01)) {
    score += 1;
  }

  return score;
}

function selectPaymentVoucherId(invoice: InvoiceCandidate): number | null {
  const postings = Array.isArray(invoice.postings) ? invoice.postings as unknown[] : [];
  for (const posting of postings) {
    const record = toRecord(posting);
    const postingType = String(record.type ?? "").trim().toUpperCase();
    if (postingType !== "INCOMING_PAYMENT" && postingType !== "INCOMING_PAYMENT_OPPOSITE") continue;
    const voucherId = asNumber(toRecord(record.voucher).id);
    if (voucherId !== null) return voucherId;
  }
  return null;
}

export function matchesReturnedPaymentWorkflow(spec: ReturnedPaymentSpec): boolean {
  if (spec.operation !== "reverse_voucher" || spec.entity !== "voucher") return false;
  const values = spec.values ?? {};
  return Boolean(values.customerName || values.organizationNumber);
}

export async function executeReturnedPaymentWorkflow(
  client: TripletexClient,
  spec: ReturnedPaymentSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = spec.values ?? {};
  const customerName = String(values.customerName ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  const invoiceLabel = String(values.name ?? "").trim();
  const amountHint = asNumber(values.amount);

  const customerParams: Record<string, unknown> = {
    count: 1,
    from: 0,
    fields: "id,name,organizationNumber",
  };
  if (organizationNumber) customerParams.organizationNumber = organizationNumber;
  if (customerName) customerParams.name = customerName;

  const customerResponse = await client.request("GET", "/customer", { params: customerParams });
  const customerValues = Array.isArray(toRecord(customerResponse).values) ? toRecord(customerResponse).values as unknown[] : [];
  const customer = toRecord(customerValues[0]);
  const customerId = asNumber(customer.id);
  if (customerId === null) {
    throw new Error("No matching customer found for returned-payment reversal");
  }

  const invoiceResponse = await client.request("GET", "/invoice", {
    params: {
      count: 20,
      from: 0,
      customerId,
      invoiceDateFrom: "2020-01-01",
      invoiceDateTo: "2100-12-31",
      fields: "id,invoiceNumber,customer(id,name,organizationNumber),amount,amountExcludingVat,amountOutstanding,amountOutstandingTotal,orderLines(description,displayName,unitPriceExcludingVatCurrency,product(name,number)),postings(type,amount,invoiceNumber,voucher(id,number),description)",
    },
  });
  const invoices = Array.isArray(toRecord(invoiceResponse).values) ? toRecord(invoiceResponse).values as unknown[] : [];
  const rankedInvoices = invoices
    .map((invoice) => ({ invoice: toRecord(invoice), score: invoiceMatches(toRecord(invoice), invoiceLabel, amountHint) }))
    .sort((a, b) => b.score - a.score);
  const selectedInvoice = rankedInvoices[0]?.invoice;
  if (!selectedInvoice || (rankedInvoices[0]?.score ?? 0) <= 0) {
    throw new Error("No matching invoice found for returned-payment reversal");
  }
  const selectedInvoiceId = asNumber(selectedInvoice.id);
  if (selectedInvoiceId !== null) {
    values.__returnedPaymentInvoiceId = selectedInvoiceId;
  }

  const voucherId = selectPaymentVoucherId(selectedInvoice);
  if (voucherId === null) {
    throw new Error("No payment voucher found on the matched invoice");
  }
  values.__returnedPaymentVoucherId = voucherId;

  const reverseDate = typeof values.date === "string" && values.date.trim() ? values.date : todayIsoInZone();
  const description =
    (typeof values.comment === "string" && values.comment.trim())
    || (typeof values.description === "string" && values.description.trim())
    || "Returned payment reversal";

  if (!dryRun) {
    const reverseResponse = await client.request("PUT", `/ledger/voucher/${voucherId}/:reverse`, {
      body: {
        date: reverseDate,
        description,
      },
    });
    const reversedVoucher = toRecord(toRecord(reverseResponse).value);
    const reversedVoucherId = asNumber(reversedVoucher.id);
    if (reversedVoucherId !== null) {
      values.__reversalVoucherId = reversedVoucherId;
    }
  }

  return {
    summary: "Reverse returned payment voucher resolved from invoice context",
    steps: [
      {
        method: "GET",
        path: "/customer",
        params: customerParams,
      },
      {
        method: "GET",
        path: "/invoice",
        params: {
          count: 20,
          from: 0,
          customerId,
          invoiceDateFrom: "2020-01-01",
          invoiceDateTo: "2100-12-31",
          fields: "id,invoiceNumber,customer(id,name,organizationNumber),amount,amountExcludingVat,amountOutstanding,amountOutstandingTotal,orderLines(description,displayName,unitPriceExcludingVatCurrency,product(name,number)),postings(type,amount,invoiceNumber,voucher(id,number),description)",
        },
      },
      {
        method: "PUT",
        path: `/ledger/voucher/${voucherId}/:reverse`,
        body: {
          date: reverseDate,
          description,
        },
      },
    ],
  };
}

export async function verifyReturnedPaymentOutcome(
  client: TripletexClient,
  spec: ReturnedPaymentSpec,
): Promise<{ verified: boolean; detail: string; required: boolean }> {
  const values = spec.values ?? {};

  const directInvoiceId = asNumber(values.__returnedPaymentInvoiceId);
  if (directInvoiceId !== null) {
    const invoiceResponse = await client.request("GET", `/invoice/${directInvoiceId}`, {
      params: {
        fields: "id,amountOutstanding,amountOutstandingTotal,postings(type,voucher(id,number),amount),customer(id,name,organizationNumber)",
      },
    });
    const invoice = toRecord(toRecord(invoiceResponse).value);
    if (invoiceOutstanding(invoice) > 0.01) {
      return { verified: true, detail: "returned payment verified via reopened invoice id", required: true };
    }
    return { verified: false, detail: "invoice matched for returned payment, but it was not reopened", required: true };
  }

  const customerName = String(values.customerName ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  const invoiceLabel = String(values.name ?? "").trim();
  const amountHint = asNumber(values.amount);

  const customerParams: Record<string, unknown> = {
    count: 1,
    from: 0,
    fields: "id,name,organizationNumber",
  };
  if (organizationNumber) customerParams.organizationNumber = organizationNumber;
  if (customerName) customerParams.name = customerName;

  const customerResponse = await client.request("GET", "/customer", { params: customerParams });
  const customerValues = Array.isArray(toRecord(customerResponse).values) ? toRecord(customerResponse).values as unknown[] : [];
  const customer = toRecord(customerValues[0]);
  const customerId = asNumber(customer.id);
  if (customerId === null) {
    return { verified: false, detail: "customer not found for returned-payment verification", required: true };
  }

  const invoiceResponse = await client.request("GET", "/invoice", {
    params: {
      count: 20,
      from: 0,
      customerId,
      invoiceDateFrom: "2020-01-01",
      invoiceDateTo: "2100-12-31",
      fields: "id,invoiceNumber,customer(id,name,organizationNumber),amount,amountExcludingVat,amountOutstanding,amountOutstandingTotal,orderLines(description,displayName,unitPriceExcludingVatCurrency,product(name,number)),postings(type,amount,invoiceNumber,voucher(id,number),description)",
    },
  });
  const invoices = Array.isArray(toRecord(invoiceResponse).values) ? toRecord(invoiceResponse).values as unknown[] : [];
  const rankedInvoices = invoices
    .map((invoice) => ({ invoice: toRecord(invoice), score: invoiceMatches(toRecord(invoice), invoiceLabel, amountHint) }))
    .sort((a, b) => b.score - a.score);
  const selectedInvoice = rankedInvoices[0]?.invoice;
  if (!selectedInvoice || (rankedInvoices[0]?.score ?? 0) <= 0) {
    return { verified: false, detail: "no matching invoice found for returned-payment verification", required: true };
  }

  if (invoiceOutstanding(selectedInvoice) > 0.01) {
    return { verified: true, detail: "returned payment verified via reopened invoice search", required: true };
  }
  return { verified: false, detail: "matched invoice did not reopen after payment reversal", required: true };
}

function invoiceOutstanding(invoice: InvoiceCandidate): number {
  const outstanding = asNumber(invoice.amountOutstanding);
  if (outstanding !== null) return outstanding;
  const outstandingTotal = asNumber(invoice.amountOutstandingTotal);
  return outstandingTotal ?? 0;
}
