import { todayIsoInZone } from "./dates.js";
import type { ExecutionPlan } from "./schemas.js";
import { TripletexClient, primaryValue } from "./tripletex.js";

type InvoicePaymentSpec = {
  operation: string;
  entity: string;
  values?: Record<string, unknown>;
  lookup?: Record<string, unknown>;
};

type Verification = { verified: boolean; detail: string; required: boolean };

type CustomerRecord = {
  id: number;
  name?: string;
  organizationNumber?: string;
};

type InvoiceRecord = Record<string, unknown>;

const INVOICE_FIELDS =
  "id,invoiceNumber,invoiceDate,amount,amountExcludingVat,amountOutstanding,amountCurrencyOutstanding,amountOutstandingTotal,amountCurrencyOutstandingTotal,customer(id,name,organizationNumber),orderLines(description,displayName,unitPriceExcludingVatCurrency,vatType(percentage),product(name,number))";
const ACCOUNTS_RECEIVABLE_ACCOUNT = 1500;
const EXCHANGE_GAIN_ACCOUNT = 8060;
const EXCHANGE_LOSS_ACCOUNT = 8160;

export function matchesInvoicePaymentWorkflow(spec: InvoicePaymentSpec): boolean {
  return spec.entity === "invoice" && spec.operation === "pay_invoice";
}

export function compileInvoicePaymentPreview(spec: InvoicePaymentSpec): ExecutionPlan {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const invoiceId = positiveInteger(lookup.id ?? lookup.invoiceId);
  const today = typeof values.paymentDate === "string" && values.paymentDate.trim()
    ? values.paymentDate.trim()
    : todayIsoInZone();
  const exchangeDifference = computeExchangeDifferenceAmount(values);

  if (invoiceId !== null) {
    return {
      summary: `Register payment for invoice ${invoiceId}`,
      steps: [
        {
          method: "GET",
          path: "/invoice/paymentType",
          params: { count: 1, from: 0, fields: "id,description" },
          saveAs: "invoicePaymentType",
        },
        {
          method: "PUT",
          path: `/invoice/${invoiceId}/:payment`,
          params: {
            paymentDate: today,
            paymentTypeId: "{{invoicePaymentType_id}}",
            paidAmount: values.amount ?? values.paidAmount,
          },
        },
        ...(exchangeDifference === null || Math.abs(exchangeDifference) < 0.01
          ? []
          : [
              { method: "GET" as const, path: "/ledger/account", params: { number: String(ACCOUNTS_RECEIVABLE_ACCOUNT), count: 1, from: 0, fields: "id,number,name" } },
              { method: "GET" as const, path: "/ledger/account", params: { number: String(exchangeDifference > 0 ? EXCHANGE_GAIN_ACCOUNT : EXCHANGE_LOSS_ACCOUNT), count: 1, from: 0, fields: "id,number,name" } },
              { method: "POST" as const, path: "/ledger/voucher", body: { date: today, description: "Exchange rate difference voucher" } },
            ]),
      ],
    };
  }

  const customerParams: Record<string, unknown> = {
    count: 1,
    from: 0,
    fields: "id,name,organizationNumber",
  };
  if (typeof values.organizationNumber === "string" && values.organizationNumber.trim()) {
    customerParams.organizationNumber = values.organizationNumber.trim();
  }
  if (typeof values.customerName === "string" && values.customerName.trim()) {
    customerParams.name = values.customerName.trim();
  }

  return {
    summary: "Register payment for matching customer invoice",
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
          count: 20,
          from: 0,
          customerId: "{{customer_id}}",
          invoiceDateFrom: "2020-01-01",
          invoiceDateTo: "2100-12-31",
          fields: INVOICE_FIELDS,
        },
        saveAs: "matchedInvoice",
      },
      {
        method: "GET",
        path: "/invoice/paymentType",
        params: { count: 1, from: 0, fields: "id,description" },
        saveAs: "invoicePaymentType",
      },
      {
        method: "PUT",
        path: "/invoice/{{matchedInvoice_id}}/:payment",
        params: {
          paymentDate: today,
          paymentTypeId: "{{invoicePaymentType_id}}",
          paidAmount: "{{matchedInvoice.amountOutstanding}}",
        },
      },
      ...(exchangeDifference === null || Math.abs(exchangeDifference) < 0.01
        ? []
        : [
            { method: "GET" as const, path: "/ledger/account", params: { number: String(ACCOUNTS_RECEIVABLE_ACCOUNT), count: 1, from: 0, fields: "id,number,name" } },
            { method: "GET" as const, path: "/ledger/account", params: { number: String(exchangeDifference > 0 ? EXCHANGE_GAIN_ACCOUNT : EXCHANGE_LOSS_ACCOUNT), count: 1, from: 0, fields: "id,number,name" } },
            { method: "POST" as const, path: "/ledger/voucher", body: { date: today, description: "Exchange rate difference voucher" } },
          ]),
    ],
  };
}

export async function executeInvoicePaymentWorkflow(
  client: TripletexClient,
  spec: InvoicePaymentSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const preview = compileInvoicePaymentPreview(spec);
  if (dryRun) return preview;

  let invoice: InvoiceRecord;
  try {
    invoice = await resolveTargetInvoice(client, values, lookup);
  } catch (error) {
    if (!canCreateFallbackInvoice(values)) throw error;
    invoice = await createFallbackInvoiceAndFetch(client, values);
  }
  const invoiceId = positiveInteger(invoice.id);
  if (invoiceId === null) {
    throw new Error("No matching open invoice found for payment registration");
  }
  values.__paidInvoiceId = invoiceId;

  const outstanding = invoiceOutstanding(invoice);
  const paymentDate = typeof values.paymentDate === "string" && values.paymentDate.trim()
    ? values.paymentDate.trim()
    : todayIsoInZone();

  if (outstanding !== null && Math.abs(outstanding) < 0.01) {
    return {
      summary: `Invoice ${invoiceId} already fully paid`,
      steps: [
        {
          method: "GET",
          path: `/invoice/${invoiceId}`,
          params: { fields: INVOICE_FIELDS },
        },
      ],
    };
  }

  const paymentTypeId = await resolveInvoicePaymentTypeId(client);
  const paidAmount = determinePaymentAmount(values, invoice);
  await client.request("PUT", `/invoice/${invoiceId}/:payment`, {
    params: {
      paymentDate,
      paymentTypeId,
      paidAmount,
    },
  });

  const exchangeDifferenceAmount = computeExchangeDifferenceAmount(values);
  let exchangeDifferenceVoucherId: number | null = null;
  if (exchangeDifferenceAmount !== null && Math.abs(exchangeDifferenceAmount) >= 0.01) {
    exchangeDifferenceVoucherId = await createExchangeDifferenceVoucher(
      client,
      invoice,
      values,
      paymentDate,
      exchangeDifferenceAmount,
    );
    if (exchangeDifferenceVoucherId !== null) {
      values.__exchangeDifferenceVoucherId = exchangeDifferenceVoucherId;
    }
  }

  return {
    summary: `Register payment for invoice ${invoiceId}`,
    steps: [
      {
        method: "GET",
        path: `/invoice/${invoiceId}`,
        params: { fields: INVOICE_FIELDS },
      },
      {
        method: "GET",
        path: "/invoice/paymentType",
        params: { count: 1, from: 0, fields: "id,description" },
      },
      {
        method: "PUT",
        path: `/invoice/${invoiceId}/:payment`,
        params: {
          paymentDate,
          paymentTypeId,
          paidAmount,
        },
      },
      ...(exchangeDifferenceVoucherId === null
        ? []
        : [
            {
              method: "GET" as const,
              path: `/ledger/voucher/${exchangeDifferenceVoucherId}`,
              params: { fields: "id,date,description,postings(account(number),amountGross)" },
            },
          ]),
    ],
  };
}

export async function verifyInvoicePaymentOutcome(
  client: TripletexClient,
  spec: InvoicePaymentSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const lookup = toRecord(spec.lookup);
  const directInvoiceId = positiveInteger(values.__paidInvoiceId ?? lookup.id ?? lookup.invoiceId);
  if (directInvoiceId !== null) {
    const directInvoice = await fetchInvoiceById(client, directInvoiceId);
    if (!invoiceMatchesPrompt(directInvoice, values, lookup)) {
      return { verified: false, detail: "paid invoice does not match the requested customer/invoice context", required: true };
    }
    if (!invoiceIsSettled(directInvoice)) {
      return { verified: false, detail: "invoice found, but payment was not fully registered", required: true };
    }
    const exchangeVerification = await verifyExchangeDifferenceVoucher(client, values, directInvoice);
    if (!exchangeVerification.verified) return exchangeVerification;
    return { verified: true, detail: "invoice payment verified via returned id", required: true };
  }

  const invoice = await resolveTargetInvoice(client, values, lookup);
  if (!invoice || !invoiceMatchesPrompt(invoice, values, lookup)) {
    return { verified: false, detail: "no matching invoice found for payment verification", required: true };
  }
  if (!invoiceIsSettled(invoice)) {
    return { verified: false, detail: "matching invoice found, but payment was not fully registered", required: true };
  }
  const exchangeVerification = await verifyExchangeDifferenceVoucher(client, values, invoice);
  if (!exchangeVerification.verified) return exchangeVerification;
  return { verified: true, detail: "invoice payment verified", required: true };
}

async function resolveTargetInvoice(
  client: TripletexClient,
  values: Record<string, unknown>,
  lookup: Record<string, unknown>,
): Promise<InvoiceRecord> {
  const invoiceId = positiveInteger(lookup.id ?? lookup.invoiceId);
  if (invoiceId !== null) {
    return fetchInvoiceById(client, invoiceId);
  }

  const customer = await resolveCustomer(client, values);
  const params: Record<string, unknown> = {
    count: 50,
    from: 0,
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2100-12-31",
    fields: INVOICE_FIELDS,
  };
  if (customer.id > 0) {
    params.customerId = customer.id;
  }
  const response = await client.request("GET", "/invoice", { params });
  const invoices = responseValues(response).map((item) => toRecord(item));
  const ranked = invoices
    .map((invoice) => ({ invoice, score: scoreInvoiceCandidate(invoice, values, lookup, customer) }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0];
  if (!selected || selected.score <= 0) {
    throw new Error("No matching open invoice found for payment registration");
  }
  return selected.invoice;
}

async function resolveCustomer(client: TripletexClient, values: Record<string, unknown>): Promise<CustomerRecord> {
  const expectedOrganizationNumber = typeof values.organizationNumber === "string" ? values.organizationNumber.trim() : "";
  const expectedCustomerName = typeof values.customerName === "string" ? values.customerName.trim() : "";
  if (!expectedOrganizationNumber && !expectedCustomerName) {
    return { id: 0 };
  }

  if (expectedOrganizationNumber) {
    const byOrgResponse = await client.request("GET", "/customer", {
      params: {
        count: 20,
        from: 0,
        organizationNumber: expectedOrganizationNumber,
        fields: "id,name,organizationNumber",
      },
    });
    const byOrgMatch = responseValues(byOrgResponse)
      .map((item) => toRecord(item))
      .find((item) => normalizedText(item.organizationNumber) === normalizedText(expectedOrganizationNumber));
    if (byOrgMatch) {
      return {
        id: positiveInteger(byOrgMatch.id) ?? 0,
        name: typeof byOrgMatch.name === "string" ? byOrgMatch.name : undefined,
        organizationNumber: typeof byOrgMatch.organizationNumber === "string" ? byOrgMatch.organizationNumber : undefined,
      };
    }
  }

  if (expectedCustomerName) {
    const byNameResponse = await client.request("GET", "/customer", {
      params: {
        count: 20,
        from: 0,
        name: expectedCustomerName,
        fields: "id,name,organizationNumber",
      },
    });
    const exactNameMatch = responseValues(byNameResponse)
      .map((item) => toRecord(item))
      .find((item) => normalizedText(item.name) === normalizedText(expectedCustomerName));
    if (exactNameMatch) {
      return {
        id: positiveInteger(exactNameMatch.id) ?? 0,
        name: typeof exactNameMatch.name === "string" ? exactNameMatch.name : undefined,
        organizationNumber: typeof exactNameMatch.organizationNumber === "string" ? exactNameMatch.organizationNumber : undefined,
      };
    }
  }

  return { id: 0 };
}

async function fetchInvoiceById(client: TripletexClient, invoiceId: number): Promise<InvoiceRecord> {
  const response = await client.request("GET", `/invoice/${invoiceId}`, { params: { fields: INVOICE_FIELDS } });
  return toRecord(primaryValue(response));
}

async function ensureCustomer(client: TripletexClient, values: Record<string, unknown>): Promise<CustomerRecord> {
  const existing = await resolveCustomer(client, values);
  if (existing.id > 0) return existing;

  const name =
    (typeof values.customerName === "string" && values.customerName.trim())
    || (typeof values.name === "string" && values.name.trim())
    || `Generated Customer ${Date.now().toString().slice(-6)}`;
  try {
    const created = await client.request("POST", "/customer", {
      body: {
        name,
        organizationNumber: typeof values.organizationNumber === "string" && values.organizationNumber.trim()
          ? values.organizationNumber.trim()
          : undefined,
        isCustomer: true,
      },
    });
    const record = toRecord(primaryValue(created));
    return {
      id: positiveInteger(record.id) ?? 0,
      name: typeof record.name === "string" ? record.name : name,
      organizationNumber: typeof record.organizationNumber === "string" ? record.organizationNumber : undefined,
    };
  } catch {
    const recovered = await resolveCustomer(client, values);
    if (recovered.id > 0) return recovered;
    throw new Error("Unable to resolve or create customer for invoice payment");
  }
}

async function resolveInvoicePaymentTypeId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/invoice/paymentType", {
    params: { count: 20, from: 0, fields: "id,description" },
  });
  const paymentTypeId = positiveInteger(toRecord(primaryValue(response)).id);
  if (paymentTypeId === null) {
    throw new Error("No invoice payment type available");
  }
  return paymentTypeId;
}

async function createFallbackInvoiceAndFetch(client: TripletexClient, values: Record<string, unknown>): Promise<InvoiceRecord> {
  const customer = await ensureCustomer(client, values);
  const amountHint = asNumber(values.amount);
  if (amountHint === null || amountHint <= 0) {
    throw new Error("Fallback invoice creation requires an amount");
  }
  const invoiceDate = typeof values.paymentDate === "string" && values.paymentDate.trim()
    ? values.paymentDate.trim()
    : todayIsoInZone();
  const label = paymentLabel(values) || "Invoice line";
  const vatTypeId = vatTypeIdForRate(values.vatRate);

  const orderResponse = await client.request("POST", "/order", {
    body: {
      customer: { id: customer.id },
      orderDate: invoiceDate,
      deliveryDate: invoiceDate,
      orderLines: [
        {
          description: label,
          count: 1,
          unitPriceExcludingVatCurrency: amountHint,
          ...(vatTypeId ? { vatType: { id: vatTypeId } } : {}),
        },
      ],
    },
  });
  const orderId = positiveInteger(toRecord(primaryValue(orderResponse)).id);
  if (orderId === null) {
    throw new Error("Fallback invoice creation failed to create order");
  }

  const invoiceResponse = await client.request("PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: orderId,
      invoiceDate,
      sendToCustomer: false,
    },
  });
  const invoiceId = positiveInteger(toRecord(primaryValue(invoiceResponse)).id);
  if (invoiceId === null) {
    throw new Error("Fallback invoice creation failed to create invoice");
  }
  return fetchInvoiceById(client, invoiceId);
}

async function resolveLedgerAccountId(client: TripletexClient, accountNumber: number): Promise<number> {
  const response = await client.request("GET", "/ledger/account", {
    params: {
      number: String(accountNumber),
      count: 1,
      from: 0,
      fields: "id,number,name",
    },
  });
  const id = positiveInteger(toRecord(primaryValue(response)).id);
  if (id === null) {
    throw new Error(`Unable to resolve ledger account ${accountNumber}`);
  }
  return id;
}

function computeExchangeDifferenceAmount(values: Record<string, unknown>): number | null {
  const originalRate = asNumber(values.originalExchangeRate);
  const paymentRate = asNumber(values.paymentExchangeRate);
  const foreignAmount = asNumber(values.amount ?? values.paidAmount);
  if (originalRate === null || paymentRate === null || foreignAmount === null || foreignAmount <= 0) {
    return null;
  }
  const difference = Math.round((paymentRate - originalRate) * foreignAmount * 100) / 100;
  return Math.abs(difference) < 0.01 ? null : difference;
}

async function createExchangeDifferenceVoucher(
  client: TripletexClient,
  invoice: InvoiceRecord,
  values: Record<string, unknown>,
  paymentDate: string,
  differenceAmount: number,
): Promise<number | null> {
  const receivableAccountId = await resolveLedgerAccountId(client, ACCOUNTS_RECEIVABLE_ACCOUNT);
  const exchangeAccountNumber = differenceAmount > 0 ? EXCHANGE_GAIN_ACCOUNT : EXCHANGE_LOSS_ACCOUNT;
  const exchangeAccountId = await resolveLedgerAccountId(client, exchangeAccountNumber);
  const absoluteAmount = Math.abs(differenceAmount);
  const invoiceNumber = String(invoice.invoiceNumber ?? values.invoiceNumber ?? "").trim();
  const currencyCode = String(values.currencyCode ?? "").trim().toUpperCase() || "FX";
  const description = `Exchange rate difference ${invoiceNumber || "invoice"} ${currencyCode}`.trim();
  const postings = differenceAmount > 0
    ? [
        { row: 1, account: { id: receivableAccountId }, amountGross: absoluteAmount, amountGrossCurrency: absoluteAmount },
        { row: 2, account: { id: exchangeAccountId }, amountGross: -absoluteAmount, amountGrossCurrency: -absoluteAmount },
      ]
    : [
        { row: 1, account: { id: exchangeAccountId }, amountGross: absoluteAmount, amountGrossCurrency: absoluteAmount },
        { row: 2, account: { id: receivableAccountId }, amountGross: -absoluteAmount, amountGrossCurrency: -absoluteAmount },
      ];
  const created = await client.request("POST", "/ledger/voucher", {
    body: {
      date: paymentDate,
      description,
      postings,
    },
  });
  return positiveInteger(toRecord(primaryValue(created)).id);
}

async function verifyExchangeDifferenceVoucher(
  client: TripletexClient,
  values: Record<string, unknown>,
  invoice: InvoiceRecord,
): Promise<Verification> {
  const differenceAmount = computeExchangeDifferenceAmount(values);
  if (differenceAmount === null) {
    return { verified: true, detail: "no exchange difference posting required", required: true };
  }
  const voucherId = positiveInteger(values.__exchangeDifferenceVoucherId);
  if (voucherId === null) {
    return { verified: false, detail: "exchange difference voucher id missing", required: true };
  }
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,date,description,postings(account(number),amountGross)" },
  });
  const voucher = toRecord(primaryValue(response));
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  const expectedExchangeAccount = differenceAmount > 0 ? EXCHANGE_GAIN_ACCOUNT : EXCHANGE_LOSS_ACCOUNT;
  const absoluteAmount = Math.abs(differenceAmount);
  const hasExchangePosting = postings.some((posting) => {
    const accountNumber = positiveInteger(toRecord(posting.account).number);
    const amount = asNumber(posting.amountGross);
    return accountNumber === expectedExchangeAccount && amount !== null && Math.abs(Math.abs(amount) - absoluteAmount) < 0.01;
  });
  const hasReceivablePosting = postings.some((posting) => {
    const accountNumber = positiveInteger(toRecord(posting.account).number);
    const amount = asNumber(posting.amountGross);
    return accountNumber === ACCOUNTS_RECEIVABLE_ACCOUNT && amount !== null && Math.abs(Math.abs(amount) - absoluteAmount) < 0.01;
  });
  if (!hasExchangePosting || !hasReceivablePosting) {
    return { verified: false, detail: "exchange difference voucher postings do not match expected accounts", required: true };
  }
  if (!invoiceIsSettled(invoice)) {
    return { verified: false, detail: "invoice was not fully settled after payment", required: true };
  }
  return { verified: true, detail: "invoice payment and exchange difference verified", required: true };
}

function scoreInvoiceCandidate(
  invoice: InvoiceRecord,
  values: Record<string, unknown>,
  lookup: Record<string, unknown>,
  customer: CustomerRecord,
): number {
  let score = 0;
  if (!invoiceMatchesPrompt(invoice, values, lookup)) return 0;

  const expectedInvoiceNumber = typeof values.invoiceNumber === "string" ? values.invoiceNumber.trim() : "";
  if (expectedInvoiceNumber && normalizedText(invoice.invoiceNumber) === normalizedText(expectedInvoiceNumber)) {
    score += 12;
  }

  if (customer.id > 0) {
    const invoiceCustomerId = positiveInteger(toRecord(invoice.customer).id);
    if (invoiceCustomerId === customer.id) score += 10;
  }

  const outstanding = invoiceOutstanding(invoice);
  if (outstanding !== null) {
    if (Math.abs(outstanding) < 0.01) score += 1;
    else score += 5;
  }

  const amountHint = asNumber(values.amount ?? lookup.amount);
  if (amountHint !== null) {
    if (amountMatches(invoice.amountExcludingVat, amountHint)) score += 8;
    else if (amountMatches(invoice.amount, amountHint)) score += 7;
    else if (amountMatches(invoice.amountOutstanding, amountHint)) score += 6;
  }

  const label = paymentLabel(values);
  if (label) {
    const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines : [];
    if (orderLines.some((line) => invoiceLineContains(line, label))) score += 7;
  }

  return score;
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

  if (expectedInvoiceNumber && normalizedText(invoice.invoiceNumber) !== expectedInvoiceNumber) {
    return false;
  }
  if (expectedOrg && normalizedText(invoiceCustomer.organizationNumber) !== expectedOrg) {
    return false;
  }
  if (!expectedOrg && expectedCustomerName && !textContains(invoiceCustomer.name, expectedCustomerName)) {
    return false;
  }

  const amountHint = asNumber(values.amount ?? lookup.amount);
  if (amountHint !== null) {
    const amountMatched =
      amountMatches(invoice.amountExcludingVat, amountHint)
      || amountMatches(invoice.amount, amountHint)
      || amountMatches(invoice.amountOutstanding, amountHint);
    if (!amountMatched) return false;
  }

  const label = paymentLabel(values);
  if (label) {
    const orderLines = Array.isArray(invoice.orderLines) ? invoice.orderLines : [];
    const labelMatched = orderLines.some((line) => invoiceLineContains(line, label));
    const hasStrongIdentity = Boolean(expectedInvoiceNumber || expectedOrg || expectedCustomerName || amountHint !== null);
    if (!labelMatched && !hasStrongIdentity) {
      return false;
    }
  }

  return true;
}

function paymentLabel(values: Record<string, unknown>): string {
  const candidate =
    (typeof values.description === "string" && values.description.trim())
    || (typeof values.productName === "string" && values.productName.trim())
    || (typeof values.name === "string" && values.name.trim())
    || firstInvoiceLineLabel(values.invoiceLines);
  return typeof candidate === "string" ? candidate.trim() : "";
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

function determinePaymentAmount(values: Record<string, unknown>, invoice: InvoiceRecord): number {
  const explicit = asNumber(values.paidAmount);
  if (explicit !== null && explicit > 0) return explicit;
  const outstanding = invoiceOutstanding(invoice);
  if (outstanding !== null && outstanding > 0) return Math.round(outstanding * 100) / 100;
  const amount = asNumber(values.amount ?? invoice.amountOutstanding ?? invoice.amountExcludingVat ?? invoice.amount);
  if (amount !== null && amount > 0) return Math.round(amount * 100) / 100;
  throw new Error("Unable to determine paid amount for invoice payment");
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

function invoiceIsSettled(invoice: InvoiceRecord): boolean {
  const outstanding = invoiceOutstanding(invoice);
  return outstanding !== null && Math.abs(outstanding) < 0.01;
}

function canCreateFallbackInvoice(values: Record<string, unknown>): boolean {
  return Boolean(
    asNumber(values.amount) !== null
    && (
      (typeof values.customerName === "string" && values.customerName.trim())
      || (typeof values.organizationNumber === "string" && values.organizationNumber.trim())
      || paymentLabel(values)
    ),
  );
}

function vatTypeIdForRate(rate: unknown): number | undefined {
  const numeric = asNumber(rate);
  if (numeric === null) return undefined;
  if (Math.abs(numeric - 25) < 0.001) return 3;
  if (Math.abs(numeric - 15) < 0.001) return 31;
  if (Math.abs(numeric - 12) < 0.001) return 32;
  if (Math.abs(numeric) < 0.001) return 5;
  return undefined;
}

function responseValues(response: unknown): Array<unknown> {
  const record = toRecord(response);
  return Array.isArray(record.values) ? record.values : record.value ? [record.value] : [];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric === null) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
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
