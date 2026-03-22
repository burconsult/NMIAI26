import assert from "node:assert/strict";

import { TripletexClient } from "../api/_lib/tripletex.ts";
import {
  assertVerifiedResult,
  createClient,
  localIsoDate,
  makeOrgNumber,
  parseFlag,
  postSolve,
  primaryValue,
  printHarnessHeader,
  resolveApiKey,
  resolveSolveEndpoint,
  resolveTripletexCredentials,
  shiftIsoDate,
  uniqueSuffix,
  valuesArray,
} from "./tripletex_harness_common.ts";

type CustomerRecord = {
  id: number;
  name: string;
  organizationNumber: string;
  email: string;
  invoiceEmail: string;
};

type InvoiceRecord = {
  id: number;
  invoiceNumber?: string;
  invoiceDate?: string;
  invoiceDueDate?: string;
  amount?: number;
  amountOutstanding?: number;
  amountOutstandingTotal?: number;
  customer?: { id?: number; name?: string; organizationNumber?: string };
  reminders?: Array<{ id?: number; type?: string; charge?: number; reminderDate?: string }>;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = Number(value.replace(/\s+/g, "").replace(",", "."));
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

async function createCustomer(client: TripletexClient, seed: string): Promise<CustomerRecord> {
  const orgNumber = makeOrgNumber(Number(seed.slice(0, 6)) + 33_000);
  const name = `Reminder Harness ${seed} AS`;
  const email = `harness.reminder.${seed}@example.org`;
  const response = await client.request("POST", "/customer", {
    body: {
      name,
      organizationNumber: orgNumber,
      isCustomer: true,
      email,
      invoiceEmail: email,
      overdueNoticeEmail: email,
      invoicesDueIn: 0,
      invoicesDueInType: "DAYS",
    },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, "Customer creation did not return an id");
  return { id, name, organizationNumber: orgNumber, email, invoiceEmail: email };
}

async function createProduct(client: TripletexClient, seed: string): Promise<number> {
  const response = await client.request("POST", "/product", {
    body: {
      name: `Reminder Harness Product ${seed}`,
      number: `97${seed.slice(0, 4)}`,
      priceExcludingVatCurrency: 1000,
    },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, "Product creation did not return an id");
  return id;
}

async function createOverdueInvoice(
  client: TripletexClient,
  customer: CustomerRecord,
  productId: number,
): Promise<InvoiceRecord> {
  const today = localIsoDate();
  const invoiceDate = shiftIsoDate(today, -21);
  const orderResponse = await client.request("POST", "/order", {
    body: {
      customer: { id: customer.id },
      orderDate: invoiceDate,
      deliveryDate: invoiceDate,
      invoicesDueIn: 0,
      invoicesDueInType: "DAYS",
      receiverEmail: customer.invoiceEmail,
      overdueNoticeEmail: customer.invoiceEmail,
      orderLines: [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: 1000,
          description: `Reminder Harness Line ${customer.organizationNumber}`,
        },
      ],
    },
  });
  const orderId = Number(primaryValue<Record<string, unknown>>(orderResponse).id ?? 0);
  assert(orderId > 0, "Order creation did not return an id");

  const invoiceResponse = await client.request("PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: orderId,
      invoiceDate,
      sendToCustomer: true,
    },
  });
  const invoiceId = Number(primaryValue<Record<string, unknown>>(invoiceResponse).id ?? 0);
  assert(invoiceId > 0, "Invoice creation did not return an id");

  const invoice = await client.request("GET", `/invoice/${invoiceId}`, {
    params: {
      fields:
        "id,invoiceNumber,invoiceDate,invoiceDueDate,amount,amountOutstanding,amountOutstandingTotal,customer(id,name,organizationNumber),reminders(id,type,charge,reminderDate)",
    },
  });
  return primaryValue<InvoiceRecord>(invoice);
}

async function findFeeInvoice(
  client: TripletexClient,
  customerId: number,
  seededInvoiceId: number,
): Promise<InvoiceRecord | undefined> {
  const response = await client.request("GET", "/invoice", {
    params: {
      customerId,
      count: 50,
      from: 0,
      invoiceDateFrom: shiftIsoDate(localIsoDate(), -30),
      invoiceDateTo: shiftIsoDate(localIsoDate(), 1),
      fields: "id,invoiceNumber,invoiceDate,amount,amountExcludingVat,customer(id,name,organizationNumber)",
    },
  });
  const invoices = valuesArray<Record<string, unknown>>(response);
  return invoices
    .filter((item) => Number(item.id ?? 0) !== seededInvoiceId)
    .map((item) => item as InvoiceRecord)
    .find((item) => {
      const amount = asNumber((item as unknown as Record<string, unknown>).amount)
        ?? asNumber((item as unknown as Record<string, unknown>).amountExcludingVat);
      return amount !== null && Math.abs(amount - 50) < 0.02;
    });
}

async function main(): Promise<void> {
  const endpoint = resolveSolveEndpoint();
  const apiKey = resolveApiKey();
  const creds = await resolveTripletexCredentials();
  const seed = parseFlag("seed") ?? uniqueSuffix();
  printHarnessHeader("Tripletex seeded reminder", endpoint, seed);

  const client = createClient(creds);
  const customer = await createCustomer(client, seed);
  const productId = await createProduct(client, seed);
  const seededInvoice = await createOverdueInvoice(client, customer, productId);
  assert.equal(seededInvoice.customer?.id, customer.id, "Seeded invoice customer mismatch");
  assert(seededInvoice.invoiceDueDate && seededInvoice.invoiceDueDate < localIsoDate(), `Seeded invoice is not overdue: ${seededInvoice.invoiceDueDate}`);

  console.log(`Seeded overdue invoice ${seededInvoice.id} for ${customer.name} (${customer.organizationNumber}) due ${seededInvoice.invoiceDueDate}`);

  const prompt =
    `En av kundene dine, ${customer.name} (org.nr ${customer.organizationNumber}), har en forfalt faktura på 1000 NOK. `
    + "Finn den forfalte fakturaen og bokfor et purregebyr pa 50 kr. "
    + "Debet kundefordringer (1500), kredit purregebyr (3400). "
    + "Opprett ogsa en faktura for purregebyret til kunden og send den.";

  const result = await postSolve(endpoint, apiKey, {
    prompt,
    files: [],
    tripletex_credentials: creds,
  });
  console.log(`Solve run ${result.runId || "-"} status=${result.status} verified=${result.verified ? 1 : 0} solverStatus=${result.solverStatus ?? "-"}`);
  assertVerifiedResult(result);

  const refreshedInvoiceResponse = await client.request("GET", `/invoice/${seededInvoice.id}`, {
    params: {
      fields:
        "id,invoiceNumber,invoiceDate,invoiceDueDate,amountOutstanding,amountOutstandingTotal,customer(id,name,organizationNumber),reminders(id,type,charge,reminderDate)",
    },
  });
  const refreshedInvoice = primaryValue<InvoiceRecord>(refreshedInvoiceResponse);
  const reminders = Array.isArray(refreshedInvoice.reminders) ? refreshedInvoice.reminders : [];
  const reminder = reminders.find((item) => String(item.type ?? "").toUpperCase() === "REMINDER");
  assert(reminder?.id, `Expected REMINDER entry on invoice ${seededInvoice.id}`);

  const feeInvoice = await findFeeInvoice(client, customer.id, seededInvoice.id);
  assert(feeInvoice?.id, "Expected a separate reminder-fee invoice for the seeded customer");

  console.log(`Verified reminder on invoice ${seededInvoice.id} and fee invoice ${feeInvoice.id}`);
}

await main();
