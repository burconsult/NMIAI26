import assert from "node:assert/strict";

import {
  assertVerifiedResult,
  createClient,
  localIsoDate,
  makeOrgNumber,
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

import type { TripletexClient } from "../api/_lib/tripletex.ts";

type CustomerRecord = {
  id: number;
  name: string;
  organizationNumber: string;
  invoiceEmail: string;
};

type SupplierRecord = {
  id: number;
  name: string;
  organizationNumber: string;
};

type CustomerInvoiceRecord = {
  id: number;
  invoiceNumber: string;
  amountOutstanding?: number;
  amountOutstandingTotal?: number;
};

type IncomingInvoiceRecord = {
  kind: "incoming_invoice" | "voucher";
  id: number;
  voucherId: number;
  supplierId: number;
  invoiceNumber: string;
  amount: number;
};

type VoucherRecord = {
  id: number;
  description?: string;
  postings?: Array<{
    id?: number;
    amountGross?: number | string;
    account?: { number?: number | string };
    closeGroup?: { id?: number | string };
    supplier?: { id?: number | string };
  }>;
};

type BankReconciliationRecord = {
  id: number;
  isClosed?: boolean;
  type?: string;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/\s+/g, "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function verboseBankHarness(): boolean {
  return process.env.TRIPLETEX_BANK_HARNESS_VERBOSE === "1";
}

function debugArtifacts(result: Awaited<ReturnType<typeof postSolve>>): unknown[] {
  if (!result.json || typeof result.json !== "object") return [];
  const root = result.json as Record<string, unknown>;
  const debug = root._debug;
  if (!debug || typeof debug !== "object") return [];
  const spec = (debug as Record<string, unknown>).spec;
  if (!spec || typeof spec !== "object") return [];
  const values = ((spec as Record<string, unknown>).values ?? {}) as Record<string, unknown>;
  return Array.isArray(values.__bankArtifacts) ? values.__bankArtifacts : [];
}

function findDebugArtifact<T extends { kind?: string }>(result: Awaited<ReturnType<typeof postSolve>>, kind: string, rowNumber: number): T | undefined {
  return debugArtifacts(result).find((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return record.kind === kind && Number(record.rowNumber ?? 0) === rowNumber;
  }) as T | undefined;
}

async function resolveAccountId(client: TripletexClient, number: number): Promise<number> {
  const response = await client.request("GET", "/ledger/account", {
    params: { number: String(number), count: 1, from: 0, fields: "id,number,name" },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, `Account ${number} could not be resolved`);
  return id;
}

async function createCustomer(client: TripletexClient, seed: string): Promise<CustomerRecord> {
  const organizationNumber = makeOrgNumber(Number(seed.slice(0, 6)) + 44_000);
  const name = `Bank Harness ${seed} AS`;
  const invoiceEmail = `harness.bank.${seed}@example.org`;
  const response = await client.request("POST", "/customer", {
    body: {
      name,
      organizationNumber,
      isCustomer: true,
      email: invoiceEmail,
      invoiceEmail,
      overdueNoticeEmail: invoiceEmail,
      invoicesDueIn: 14,
      invoicesDueInType: "DAYS",
    },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, "Customer creation did not return an id");
  return { id, name, organizationNumber, invoiceEmail };
}

async function createProduct(client: TripletexClient, seed: string, amount: number): Promise<number> {
  const response = await client.request("POST", "/product", {
    body: {
      name: `Bank Harness Product ${seed}`,
      number: `96${seed.slice(0, 4)}`,
      priceExcludingVatCurrency: amount,
    },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, "Product creation did not return an id");
  return id;
}

async function createOpenCustomerInvoice(
  client: TripletexClient,
  customer: CustomerRecord,
  productId: number,
  amount: number,
  seed: string,
): Promise<CustomerInvoiceRecord> {
  const today = localIsoDate();
  const orderDate = shiftIsoDate(today, -2);
  const orderResponse = await client.request("POST", "/order", {
    body: {
      customer: { id: customer.id },
      orderDate,
      deliveryDate: orderDate,
      invoicesDueIn: 14,
      invoicesDueInType: "DAYS",
      receiverEmail: customer.invoiceEmail,
      overdueNoticeEmail: customer.invoiceEmail,
      orderLines: [
        {
          product: { id: productId },
          count: 1,
          unitPriceExcludingVatCurrency: amount,
          description: `Bank harness customer line ${seed}`,
        },
      ],
    },
  });
  const orderId = Number(primaryValue<Record<string, unknown>>(orderResponse).id ?? 0);
  assert(orderId > 0, "Order creation did not return an id");

  const invoiceResponse = await client.request("PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: orderId,
      invoiceDate: orderDate,
      sendToCustomer: true,
    },
  });
  const invoiceId = Number(primaryValue<Record<string, unknown>>(invoiceResponse).id ?? 0);
  assert(invoiceId > 0, "Invoice creation did not return an id");

  const invoice = await client.request("GET", `/invoice/${invoiceId}`, {
    params: {
      fields: "id,invoiceNumber,amountOutstanding,amountOutstandingTotal",
    },
  });
  const value = primaryValue<Record<string, unknown>>(invoice);
  const invoiceNumber = String(value.invoiceNumber ?? "").trim();
  assert(invoiceNumber, `Invoice ${invoiceId} did not return invoiceNumber`);
  return {
    id: invoiceId,
    invoiceNumber,
    amountOutstanding: asNumber(value.amountOutstanding) ?? undefined,
    amountOutstandingTotal: asNumber(value.amountOutstandingTotal) ?? undefined,
  };
}

async function waitForCustomerInvoiceSearchable(
  client: TripletexClient,
  invoiceNumber: string,
  expectedInvoiceId: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await client.request("GET", "/invoice", {
      params: {
        invoiceNumber,
        count: 20,
        from: 0,
        invoiceDateFrom: "2020-01-01",
        invoiceDateTo: "2100-12-31",
        fields: "id,invoiceNumber",
      },
    });
    const match = valuesArray<Record<string, unknown>>(response).find((item) => Number(item.id ?? 0) === expectedInvoiceId);
    if (match) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Seeded customer invoice ${invoiceNumber} was not discoverable through /invoice search`);
}

async function waitForSupplierVoucherSearchable(
  client: TripletexClient,
  invoiceNumber: string,
  expectedVoucherId: number,
): Promise<void> {
  const today = localIsoDate();
  const tomorrow = shiftIsoDate(today, 1);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await client.request("GET", "/ledger/voucher", {
      params: {
        count: 400,
        from: 0,
        dateFrom: today,
        dateTo: tomorrow,
        fields: "id,externalVoucherNumber,vendorInvoiceNumber,description",
      },
    });
    const match = valuesArray<Record<string, unknown>>(response).find((item) => {
      const id = Number(item.id ?? 0);
      if (id !== expectedVoucherId) return false;
      const externalVoucherNumber = String(item.externalVoucherNumber ?? "").trim().toUpperCase();
      const vendorInvoiceNumber = String(item.vendorInvoiceNumber ?? "").trim().toUpperCase();
      const wanted = invoiceNumber.trim().toUpperCase();
      return externalVoucherNumber === wanted || vendorInvoiceNumber === wanted;
    });
    if (match) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Seeded supplier voucher ${invoiceNumber} was not discoverable through /ledger/voucher search`);
}

async function createSupplier(client: TripletexClient, seed: string): Promise<SupplierRecord> {
  const organizationNumber = makeOrgNumber(Number(seed.slice(0, 6)) + 55_000);
  const name = `Bank Supplier ${seed} AS`;
  const response = await client.request("POST", "/supplier", {
    body: {
      name,
      organizationNumber,
      email: `harness.supplier.${seed}@example.org`,
    },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  const id = Number(value.id ?? 0);
  assert(id > 0, "Supplier creation did not return an id");
  return { id, name, organizationNumber };
}

async function createIncomingInvoice(
  client: TripletexClient,
  supplier: SupplierRecord,
  invoiceNumber: string,
  amount: number,
  description: string,
): Promise<IncomingInvoiceRecord> {
  const accountId = await resolveAccountId(client, 6800);
  const payableAccountId = await resolveAccountId(client, 2400);
  const today = localIsoDate();
  try {
    const created = await client.request("POST", "/incomingInvoice", {
      params: { sendTo: "ledger" },
      body: {
        invoiceHeader: {
          vendorId: supplier.id,
          invoiceDate: today,
          dueDate: shiftIsoDate(today, 14),
          invoiceAmount: roundMoney(amount),
          description,
          invoiceNumber,
        },
        orderLines: [
          {
            externalId: "line-1",
            row: 1,
            description,
            accountId,
            count: 1,
            amountInclVat: roundMoney(amount),
            vendorId: supplier.id,
          },
        ],
      },
    });
    const value = primaryValue<Record<string, unknown>>(created);
    let id = Number(value.id ?? 0);
    let voucherId = Number(value.voucherId ?? 0);
    if (id <= 0 || voucherId <= 0) {
      const resolved = await client.request("GET", "/incomingInvoice/search", {
        params: {
          status: "ledger",
          invoiceNumber,
          count: 10,
          from: 0,
          invoiceDateFrom: shiftIsoDate(today, -7),
          invoiceDateTo: shiftIsoDate(today, 7),
          fields: "id,voucherId,invoiceHeader(invoiceNumber,invoiceAmount,description)",
        },
      });
      const match = valuesArray<Record<string, unknown>>(resolved).find((item) => {
        const header = item.invoiceHeader as Record<string, unknown> | undefined;
        return String(header?.invoiceNumber ?? "").trim() === invoiceNumber;
      });
      id = Number(match?.id ?? id ?? 0);
      voucherId = Number(match?.voucherId ?? voucherId ?? 0);
    }
    assert(id > 0, `Incoming invoice ${invoiceNumber} did not return an id`);
    assert(voucherId > 0, `Incoming invoice ${invoiceNumber} did not return voucherId`);
    return { kind: "incoming_invoice", id, voucherId, supplierId: supplier.id, invoiceNumber, amount: roundMoney(amount) };
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode ?? 0) : 0;
    const responseMessage =
      typeof error === "object" && error && "responseBody" in error
        ? String(((error as { responseBody?: Record<string, unknown> }).responseBody ?? {}).message ?? "")
        : "";
    const featureUnavailable = statusCode === 403 || /permission to access this feature/i.test(responseMessage);
    if (!featureUnavailable) throw error;
  }

  const created = await client.request("POST", "/ledger/voucher", {
    body: {
      date: today,
      description,
      externalVoucherNumber: invoiceNumber,
      vendorInvoiceNumber: invoiceNumber,
      postings: [
        {
          row: 1,
          account: { id: accountId },
          supplier: { id: supplier.id },
          amountGross: roundMoney(amount),
          amountGrossCurrency: roundMoney(amount),
        },
        {
          row: 2,
          account: { id: payableAccountId },
          supplier: { id: supplier.id },
          amountGross: -roundMoney(amount),
          amountGrossCurrency: -roundMoney(amount),
        },
      ],
    },
  });
  const voucherId = Number(primaryValue<Record<string, unknown>>(created).id ?? 0);
  assert(voucherId > 0, `Supplier voucher ${invoiceNumber} did not return voucherId`);
  return { kind: "voucher", id: 0, voucherId, supplierId: supplier.id, invoiceNumber, amount: roundMoney(amount) };
}

async function fetchCustomerInvoice(client: TripletexClient, invoiceId: number): Promise<CustomerInvoiceRecord> {
  const response = await client.request("GET", `/invoice/${invoiceId}`, {
    params: { fields: "id,invoiceNumber,amountOutstanding,amountOutstandingTotal" },
  });
  const value = primaryValue<Record<string, unknown>>(response);
  return {
    id: Number(value.id ?? 0),
    invoiceNumber: String(value.invoiceNumber ?? ""),
    amountOutstanding: asNumber(value.amountOutstanding) ?? undefined,
    amountOutstandingTotal: asNumber(value.amountOutstandingTotal) ?? undefined,
  };
}

async function fetchVoucher(client: TripletexClient, voucherId: number): Promise<VoucherRecord> {
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,description,postings(id,amountGross,account(number),closeGroup(id),supplier(id))" },
  });
  return primaryValue<VoucherRecord>(response);
}

async function listVouchersOnDate(client: TripletexClient, date: string): Promise<VoucherRecord[]> {
  const response = await client.request("GET", "/ledger/voucher", {
    params: {
      count: 200,
      from: 0,
      dateFrom: date,
      dateTo: shiftIsoDate(date, 1),
      fields: "id,description",
    },
  });
  const ids = valuesArray<Record<string, unknown>>(response)
    .map((item) => Number(item.id ?? 0))
    .filter((id) => id > 0);
  return Promise.all(ids.map((id) => fetchVoucher(client, id)));
}

function postingCloseGroupId(voucher: VoucherRecord, accountNumber: number, supplierId?: number): number {
  const postings = Array.isArray(voucher.postings) ? voucher.postings : [];
  const posting = postings.find((item) => {
    const number = Math.trunc(asNumber(item.account?.number) ?? 0);
    const matchesAccount = number === accountNumber;
    const matchesSupplier = supplierId ? Number(item.supplier?.id ?? 0) === supplierId : true;
    return matchesAccount && matchesSupplier;
  });
  return Number(posting?.closeGroup?.id ?? 0);
}

async function resolveCurrentBankContext(client: TripletexClient): Promise<{ accountId: number; accountingPeriodId: number }> {
  const accountId = await resolveAccountId(client, 1920);
  const periods = valuesArray<Record<string, unknown>>(
    await client.request("GET", "/ledger/accountingPeriod", {
      params: { count: 50, from: 0, fields: "id,start,end,isClosed" },
    }),
  );
  const today = localIsoDate();
  const period = periods.find((item) => item.isClosed !== true && String(item.start ?? "") <= today && today < String(item.end ?? ""))
    ?? periods.find((item) => item.isClosed !== true);
  const accountingPeriodId = Number(period?.id ?? 0);
  assert(accountingPeriodId > 0, "Could not resolve open accounting period");
  return { accountId, accountingPeriodId };
}

async function listOpenBankReconciliations(
  client: TripletexClient,
  accountId: number,
  accountingPeriodId: number,
): Promise<BankReconciliationRecord[]> {
  const response = await client.request("GET", "/bank/reconciliation", {
    params: {
      accountId,
      accountingPeriodId,
      count: 50,
      from: 0,
      fields: "id,isClosed,type,account(id),accountingPeriod(id)",
    },
  });
  return valuesArray<Record<string, unknown>>(response)
    .map((item) => ({
      id: Number(item.id ?? 0),
      isClosed: item.isClosed === true,
      type: typeof item.type === "string" ? item.type : undefined,
    }))
    .filter((item) => item.id > 0 && item.isClosed !== true);
}

async function main(): Promise<void> {
  const endpoint = resolveSolveEndpoint();
  const apiKey = resolveApiKey();
  const creds = await resolveTripletexCredentials();
  const seed = uniqueSuffix();
  printHarnessHeader("Tripletex seeded bank", endpoint, seed);

  const client = createClient(creds);
  const today = localIsoDate();
  const customerAmount = 12500;
  const supplierFullAmount = 4200;
  const supplierPartialTotal = 8400;
  const supplierPartialPayment = 2100;

  const customer = await createCustomer(client, seed);
  const productId = await createProduct(client, seed, customerAmount);
  const customerInvoice = await createOpenCustomerInvoice(client, customer, productId, customerAmount, seed);
  await waitForCustomerInvoiceSearchable(client, customerInvoice.invoiceNumber, customerInvoice.id);

  const supplier = await createSupplier(client, seed);
  const supplierFullInvoice = await createIncomingInvoice(
    client,
    supplier,
    `SUPFULL-${seed}`,
    supplierFullAmount,
    `Bank harness supplier full ${seed}`,
  );
  const supplierPartialInvoice = await createIncomingInvoice(
    client,
    supplier,
    `SUPPART-${seed}`,
    supplierPartialTotal,
    `Bank harness supplier partial ${seed}`,
  );
  if (supplierFullInvoice.kind === "voucher") {
    await waitForSupplierVoucherSearchable(client, supplierFullInvoice.invoiceNumber, supplierFullInvoice.voucherId);
  }
  if (supplierPartialInvoice.kind === "voucher") {
    await waitForSupplierVoucherSearchable(client, supplierPartialInvoice.invoiceNumber, supplierPartialInvoice.voucherId);
  }

  const bankContext = await resolveCurrentBankContext(client);
  const beforeReconciliations = await listOpenBankReconciliations(client, bankContext.accountId, bankContext.accountingPeriodId);

  const csv = Buffer.from(
    [
      "date;description;amount",
      `${today};Invoice ${customerInvoice.invoiceNumber} ${customer.name};${customerAmount}`,
      `${today};Supplier ${supplierFullInvoice.invoiceNumber} ${supplier.name};-${supplierFullAmount}`,
      `${today};Supplier ${supplierPartialInvoice.invoiceNumber} ${supplier.name};-${supplierPartialPayment}`,
      `${today};Unknown transfer ${seed};3500`,
    ].join("\n"),
    "utf8",
  ).toString("base64");

  const prompt =
    "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex. "
    + "Associez les paiements entrants aux factures clients et les paiements sortants aux factures fournisseurs. "
    + "Gérez correctement les paiements partiels et laissez la ligne non rapprochée pour suivi manuel.";

  const result = await postSolve(endpoint, apiKey, {
    prompt,
    files: [{ filename: `bank-harness-${seed}.csv`, mime_type: "text/csv", content_base64: csv }],
    tripletex_credentials: creds,
  });
  console.log(`Solve run ${result.runId || "-"} status=${result.status} verified=${result.verified ? 1 : 0} solverStatus=${result.solverStatus ?? "-"}`);
  if (verboseBankHarness()) {
    console.log(
      JSON.stringify(
        {
          customerInvoice,
          supplierFullInvoice,
          supplierPartialInvoice,
          bankArtifacts: debugArtifacts(result),
        },
        null,
        2,
      ),
    );
  }
  assertVerifiedResult(result);

  const refreshedCustomerInvoice = await fetchCustomerInvoice(client, customerInvoice.id);
  const outstanding = refreshedCustomerInvoice.amountOutstandingTotal ?? refreshedCustomerInvoice.amountOutstanding ?? null;
  assert(outstanding !== null && outstanding <= 0.05, `Expected customer invoice ${customerInvoice.id} to be paid, got outstanding=${outstanding}`);

  const originalSupplierVoucher = await fetchVoucher(client, supplierFullInvoice.voucherId);
  const originalCloseGroupId = postingCloseGroupId(originalSupplierVoucher, 2400, supplier.id);
  assert(originalCloseGroupId > 0, `Expected supplier payable on voucher ${supplierFullInvoice.voucherId} to be closed`);

  const supplierFullArtifact = findDebugArtifact<{ paymentVoucherId?: number }>(result, "supplier_invoice_full", 3);
  assert(Number(supplierFullArtifact?.paymentVoucherId ?? 0) > 0, `Expected debug payment voucher id for ${supplierFullInvoice.invoiceNumber}`);
  const paymentVoucher = await fetchVoucher(client, Number(supplierFullArtifact?.paymentVoucherId ?? 0));
  const paymentCloseGroupId = postingCloseGroupId(paymentVoucher, 2400, supplier.id);
  assert(paymentCloseGroupId > 0 && paymentCloseGroupId === originalCloseGroupId, "Expected full supplier payment voucher to close against the original payable posting");

  if (supplierPartialInvoice.kind === "incoming_invoice") {
    const partialIncoming = await client.request("GET", `/incomingInvoice/${supplierPartialInvoice.id}`, {
      params: { fields: "id,voucherId,invoiceHeader(invoiceNumber,invoiceAmount)" },
    });
    const partialRecord = primaryValue<Record<string, unknown>>(partialIncoming);
    assert.equal(Number(partialRecord.id ?? 0), supplierPartialInvoice.id, "Partial supplier invoice missing after reconciliation");
    assert.equal(Number(partialRecord.voucherId ?? 0), supplierPartialInvoice.voucherId, "Partial supplier invoice voucher changed unexpectedly");
  } else {
    const supplierPartialArtifact = findDebugArtifact<{ paymentVoucherId?: number }>(result, "supplier_voucher_partial", 4);
    assert(Number(supplierPartialArtifact?.paymentVoucherId ?? 0) > 0, `Expected debug payment voucher id for ${supplierPartialInvoice.invoiceNumber}`);
    const partialPaymentVoucher = await fetchVoucher(client, Number(supplierPartialArtifact?.paymentVoucherId ?? 0));
    const originalPartialVoucher = await fetchVoucher(client, supplierPartialInvoice.voucherId);
    const originalPartialCloseGroupId = postingCloseGroupId(originalPartialVoucher, 2400, supplier.id);
    assert.equal(originalPartialCloseGroupId, 0, "Expected partial supplier payable to remain open");
    const partialPaymentCloseGroupId = postingCloseGroupId(partialPaymentVoucher, 2400, supplier.id);
    assert.equal(partialPaymentCloseGroupId, 0, "Expected partial supplier payment voucher posting to remain open");
  }

  const afterReconciliations = await listOpenBankReconciliations(client, bankContext.accountId, bankContext.accountingPeriodId);
  assert(afterReconciliations.length > 0, "Expected an open bank reconciliation for the current period after unmatched row handling");
  const hasManual = afterReconciliations.some((item) => item.type === "MANUAL");
  assert(hasManual, "Expected manual bank reconciliation state for unmatched row follow-up");

  console.log(
    `Verified bank harness: customer invoice ${customerInvoice.invoiceNumber}, supplier invoices ${supplierFullInvoice.invoiceNumber}/${supplierPartialInvoice.invoiceNumber}, open reconciliations before=${beforeReconciliations.length} after=${afterReconciliations.length}`,
  );
}

await main();
