import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskOperation, TaskSpec } from "./task_spec.js";

type Verification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type SupplierInvoiceSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

type SupplierRecord = {
  id: number;
  name?: string;
  organizationNumber?: string;
};

const SUPPLIER_PAYABLE_ACCOUNT = 2400;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toValues(value: unknown): unknown[] {
  const record = toRecord(value);
  if (Array.isArray(record.values)) return record.values as unknown[];
  const primary = primaryValue(value);
  return primary ? [primary] : [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nearlyEqual(left: number, right: number, epsilon = 0.02): boolean {
  return Math.abs(left - right) <= epsilon;
}

function vatAccountNumberForRate(rate: number): number | null {
  if (nearlyEqual(rate, 25)) return 2710;
  if (nearlyEqual(rate, 15)) return 2711;
  if (nearlyEqual(rate, 12)) return 2712;
  return null;
}

function vatTypeIdForRate(rate: number | null): number | undefined {
  if (rate === null) return undefined;
  if (nearlyEqual(rate, 25)) return 3;
  if (nearlyEqual(rate, 15)) return 31;
  if (nearlyEqual(rate, 12)) return 32;
  if (nearlyEqual(rate, 0)) return 5;
  return undefined;
}

function pushStep(
  steps: PlanStep[],
  method: PlanStep["method"],
  path: string,
  extra?: Partial<PlanStep>,
): void {
  steps.push({
    method,
    path,
    params: extra?.params,
    body: extra?.body,
    saveAs: extra?.saveAs,
    extract: extra?.extract,
    reason: extra?.reason,
  });
}

async function resolveAccountId(client: TripletexClient, number: number): Promise<number> {
  const response = await client.request("GET", "/ledger/account", {
    params: {
      number: String(number),
      count: 1,
      from: 0,
      fields: "id,number,name",
    },
  });
  const account = toRecord(primaryValue(response));
  const id = Number(account.id ?? 0);
  if (id <= 0) throw new Error(`Ledger account ${number} could not be resolved`);
  return id;
}

async function findSupplier(client: TripletexClient, values: Record<string, unknown>): Promise<SupplierRecord | null> {
  const organizationNumber = typeof values.organizationNumber === "string" ? values.organizationNumber.trim() : "";
  if (organizationNumber) {
    const response = await client.request("GET", "/supplier", {
      params: {
        organizationNumber,
        count: 10,
        from: 0,
        fields: "id,name,organizationNumber",
      },
    });
    const exact = toValues(response)
      .map((item) => toRecord(item))
      .find((item) => normalized(item.organizationNumber) === normalized(organizationNumber));
    if (exact) {
      return {
        id: Number(exact.id ?? 0),
        name: typeof exact.name === "string" ? exact.name : undefined,
        organizationNumber: typeof exact.organizationNumber === "string" ? exact.organizationNumber : undefined,
      };
    }
  }

  const name = typeof values.name === "string" ? values.name.trim() : "";
  if (!name) return null;
  const response = await client.request("GET", "/supplier", {
    params: {
      count: 10,
      from: 0,
      fields: "id,name,organizationNumber",
    },
  });
  const exact = toValues(response)
    .map((item) => toRecord(item))
    .find((item) => normalized(item.name) === normalized(name));
  if (!exact) return null;
  return {
    id: Number(exact.id ?? 0),
    name: typeof exact.name === "string" ? exact.name : undefined,
    organizationNumber: typeof exact.organizationNumber === "string" ? exact.organizationNumber : undefined,
  };
}

async function ensureSupplier(client: TripletexClient, values: Record<string, unknown>): Promise<SupplierRecord> {
  const existing = await findSupplier(client, values);
  if (existing?.id) return existing;

  const name = typeof values.name === "string" && values.name.trim()
    ? values.name.trim()
    : `Generated Supplier ${Date.now().toString().slice(-6)}`;
  const body: Record<string, unknown> = {
    name,
    isCustomer: false,
  };
  if (typeof values.organizationNumber === "string" && values.organizationNumber.trim()) {
    body.organizationNumber = values.organizationNumber.trim();
  }
  if (typeof values.email === "string" && values.email.trim()) {
    body.email = values.email.trim();
  }
  if (typeof values.invoiceEmail === "string" && values.invoiceEmail.trim()) {
    body.invoiceEmail = values.invoiceEmail.trim();
  }
  if (typeof values.phoneNumber === "string" && values.phoneNumber.trim()) {
    body.phoneNumber = values.phoneNumber.trim();
  }

  const created = await client.request("POST", "/supplier", { body });
  const supplier = toRecord(primaryValue(created));
  const id = Number(supplier.id ?? 0);
  if (id <= 0) throw new Error("Supplier creation did not return an id");
  return {
    id,
    name: typeof supplier.name === "string" ? supplier.name : name,
    organizationNumber: typeof supplier.organizationNumber === "string" ? supplier.organizationNumber : undefined,
  };
}

function computeVoucherAmounts(grossAmount: number, vatRate: number | null): {
  expenseAmount: number;
  vatAmount: number;
} {
  if (!vatRate || vatRate <= 0) {
    return {
      expenseAmount: roundMoney(grossAmount),
      vatAmount: 0,
    };
  }

  const expenseAmount = roundMoney(grossAmount / (1 + vatRate / 100));
  const vatAmount = roundMoney(grossAmount - expenseAmount);
  return {
    expenseAmount,
    vatAmount,
  };
}

export function matchesSupplierInvoiceWorkflow(spec: SupplierInvoiceSpec): boolean {
  return spec.entity === "supplier_invoice" && spec.operation === "create";
}

export function compileSupplierInvoicePreview(
  op: TaskOperation,
  values: Record<string, unknown>,
): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List supplier invoice vouchers",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: {
            dateFrom: todayIsoInZone(),
            dateTo: todayIsoInZone(),
            count: 20,
            from: 0,
            fields: "id,date,description,externalVoucherNumber,postings(account(number),supplier(id,name,organizationNumber),amountGross)",
          },
        },
      ],
    };
  }

  const supplierName = typeof values.name === "string" ? values.name : "supplier";
  const invoiceNumber = typeof values.invoiceNumber === "string" ? values.invoiceNumber : "invoice";
  const expenseAccount = typeof values.accountNumber === "string" ? values.accountNumber : "6300";
  const vatRate = toNumber(values.vatRate);
  const vatAccount = vatRateAccountPreview(vatRate);

  return {
    summary: `Register supplier invoice ${invoiceNumber} from ${supplierName}`,
    steps: [
      { method: "GET", path: "/supplier", params: { count: 10, from: 0, fields: "id,name,organizationNumber" } },
      {
        method: "POST",
        path: "/supplier",
        body: {
          name: supplierName,
          organizationNumber: values.organizationNumber,
          isCustomer: false,
        },
      },
      { method: "GET", path: "/ledger/account", params: { number: expenseAccount, count: 1, from: 0, fields: "id,number,name" } },
      ...(vatAccount
        ? [{ method: "GET" as const, path: "/ledger/account", params: { number: String(vatAccount), count: 1, from: 0, fields: "id,number,name" } }]
        : []),
      { method: "GET", path: "/ledger/account", params: { number: String(SUPPLIER_PAYABLE_ACCOUNT), count: 1, from: 0, fields: "id,number,name" } },
      {
        method: "POST",
        path: "/ledger/voucher",
        body: {
          date: values.date ?? todayIsoInZone(),
          description: values.description ?? `Supplier invoice ${invoiceNumber}`,
          externalVoucherNumber: invoiceNumber,
        },
        saveAs: "voucher",
      },
    ],
  };
}

function vatRateAccountPreview(vatRate: number | null): number | null {
  if (vatRate === null) return 2710;
  return vatAccountNumberForRate(vatRate);
}

export async function executeSupplierInvoiceWorkflow(
  client: TripletexClient,
  spec: SupplierInvoiceSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileSupplierInvoicePreview(spec.operation, values);
  if (dryRun) return preview;

  const grossAmount = toNumber(values.amount);
  if (!grossAmount || grossAmount <= 0) {
    throw new Error("Supplier invoice workflow requires a positive gross amount");
  }

  const supplier = await ensureSupplier(client, values);
  values.__supplierId = supplier.id;

  const expenseAccountNumber = toNumber(values.accountNumber);
  if (!expenseAccountNumber || expenseAccountNumber <= 0) {
    throw new Error("Supplier invoice workflow requires an expense account number");
  }

  const vatRate = toNumber(values.vatRate);
  const expenseAccountId = await resolveAccountId(client, Math.trunc(expenseAccountNumber));
  const supplierPayableAccountId = await resolveAccountId(client, SUPPLIER_PAYABLE_ACCOUNT);
  const { expenseAmount, vatAmount } = computeVoucherAmounts(grossAmount, vatRate);
  const vatAccountNumber = vatRate !== null && vatRate > 0 ? vatAccountNumberForRate(vatRate) : null;
  const vatAccountId = vatAmount > 0 && vatAccountNumber ? await resolveAccountId(client, vatAccountNumber) : null;
  const vatTypeId = vatTypeIdForRate(vatRate);

  const invoiceNumber = typeof values.invoiceNumber === "string" && values.invoiceNumber.trim()
    ? values.invoiceNumber.trim()
    : `SUP-${Date.now().toString().slice(-6)}`;
  const voucherDate = typeof values.date === "string" && values.date.trim()
    ? values.date.trim()
    : todayIsoInZone();
  const dueDate = typeof values.invoiceDueDate === "string" && values.invoiceDueDate.trim()
    ? values.invoiceDueDate.trim()
    : typeof values.endDate === "string" && values.endDate.trim()
      ? values.endDate.trim()
      : voucherDate;
  const description = typeof values.description === "string" && values.description.trim()
    ? values.description.trim()
    : `Leverandørfaktura ${invoiceNumber} ${supplier.name ?? ""}`.trim();

  try {
    const incomingBody: Record<string, unknown> = {
      invoiceHeader: {
        vendorId: supplier.id,
        invoiceDate: voucherDate,
        dueDate,
        invoiceAmount: roundMoney(grossAmount),
        description,
        invoiceNumber,
      },
      orderLines: [
        {
          externalId: "line-1",
          row: 1,
          description,
          accountId: expenseAccountId,
          count: 1,
          amountInclVat: roundMoney(grossAmount),
          ...(vatTypeId ? { vatTypeId } : {}),
          vendorId: supplier.id,
        },
      ],
    };
    const createdIncoming = await client.request("POST", "/incomingInvoice", {
      params: { sendTo: "ledger" },
      body: incomingBody,
    });
    const incomingRecord = toRecord(primaryValue(createdIncoming));
    let incomingInvoiceId = Number(incomingRecord.id ?? 0);
    let incomingVoucherId = Number(incomingRecord.voucherId ?? 0);
    if (incomingInvoiceId <= 0 || incomingVoucherId <= 0) {
      const resolved = await client.request("GET", "/incomingInvoice/search", {
        params: {
          status: "ledger",
          invoiceNumber,
          count: 10,
          from: 0,
          invoiceDateFrom: "2020-01-01",
          invoiceDateTo: "2100-12-31",
          fields: "voucherId,invoiceHeader(vendorId,invoiceNumber,invoiceAmount,description,dueDate,invoiceDate)",
        },
      });
      const match = toValues(resolved)
        .map((item) => toRecord(item))
        .find((item) => normalized(toRecord(item.invoiceHeader).invoiceNumber) === normalized(invoiceNumber));
      incomingInvoiceId = Number(match?.id ?? incomingInvoiceId ?? 0);
      incomingVoucherId = Number(match?.voucherId ?? incomingVoucherId ?? 0);
    }
    if (incomingInvoiceId > 0) {
      values.__supplierIncomingInvoiceId = incomingInvoiceId;
    }
    if (incomingVoucherId > 0) {
      values.__supplierIncomingVoucherId = incomingVoucherId;
      values.__supplierVoucherId = incomingVoucherId;
    }

    const steps: PlanStep[] = [];
    pushStep(steps, "GET", "/supplier", {
      params: {
        count: 10,
        from: 0,
        fields: "id,name,organizationNumber",
        ...(typeof values.organizationNumber === "string" && values.organizationNumber.trim()
          ? { organizationNumber: values.organizationNumber.trim() }
          : {}),
      },
    });
    pushStep(steps, "GET", "/ledger/account", {
      params: { number: String(Math.trunc(expenseAccountNumber)), count: 1, from: 0, fields: "id,number,name" },
    });
    pushStep(steps, "POST", "/incomingInvoice", {
      params: { sendTo: "ledger" },
      body: incomingBody,
      saveAs: "voucher",
    });
    if (incomingInvoiceId > 0) {
      pushStep(steps, "GET", `/incomingInvoice/${incomingInvoiceId}`, {
        params: {
          fields: "voucherId,invoiceHeader(vendorId,invoiceNumber,invoiceAmount,description,dueDate,invoiceDate)",
        },
      });
    }

    return {
      summary: `Register supplier invoice ${invoiceNumber} from ${supplier.name ?? supplier.id}`,
      steps,
    };
  } catch {
    // Fallback to voucher-based registration for tenants where incomingInvoice is unavailable.
  }

  const postings: Array<Record<string, unknown>> = [
    {
      row: 1,
      account: { id: expenseAccountId },
      supplier: { id: supplier.id },
      amountGross: expenseAmount,
      amountGrossCurrency: expenseAmount,
    },
  ];
  if (vatAmount > 0 && vatAccountId) {
    postings.push({
      row: postings.length + 1,
      account: { id: vatAccountId },
      supplier: { id: supplier.id },
      amountGross: vatAmount,
      amountGrossCurrency: vatAmount,
    });
  }
  postings.push({
    row: postings.length + 1,
    account: { id: supplierPayableAccountId },
    supplier: { id: supplier.id },
    amountGross: -roundMoney(grossAmount),
    amountGrossCurrency: -roundMoney(grossAmount),
  });

  const body = {
    date: voucherDate,
    description,
    externalVoucherNumber: invoiceNumber,
    vendorInvoiceNumber: invoiceNumber,
    postings,
  };
  const created = await client.request("POST", "/ledger/voucher", { body });
  const voucher = toRecord(primaryValue(created));
  const voucherId = Number(voucher.id ?? 0);
  if (voucherId > 0) values.__supplierVoucherId = voucherId;

  const steps: PlanStep[] = [];
  pushStep(steps, "GET", "/supplier", {
    params: {
      count: 10,
      from: 0,
      fields: "id,name,organizationNumber",
      ...(typeof values.organizationNumber === "string" && values.organizationNumber.trim()
        ? { organizationNumber: values.organizationNumber.trim() }
        : {}),
    },
  });
  pushStep(steps, "GET", "/ledger/account", {
    params: { number: String(Math.trunc(expenseAccountNumber)), count: 1, from: 0, fields: "id,number,name" },
  });
  if (vatAmount > 0 && vatAccountNumber) {
    pushStep(steps, "GET", "/ledger/account", {
      params: { number: String(vatAccountNumber), count: 1, from: 0, fields: "id,number,name" },
    });
  }
  pushStep(steps, "GET", "/ledger/account", {
    params: { number: String(SUPPLIER_PAYABLE_ACCOUNT), count: 1, from: 0, fields: "id,number,name" },
  });
  pushStep(steps, "POST", "/ledger/voucher", { body, saveAs: "voucher" });
  if (voucherId > 0) {
    pushStep(steps, "GET", `/ledger/voucher/${voucherId}`, {
      params: {
        fields: "id,date,description,externalVoucherNumber,vendorInvoiceNumber,postings(account(number),supplier(id,name,organizationNumber),amountGross)",
      },
    });
  }

  return {
    summary: `Register supplier invoice ${invoiceNumber} from ${supplier.name ?? supplier.id}`,
    steps,
  };
}

export async function verifySupplierInvoiceOutcome(
  client: TripletexClient,
  spec: SupplierInvoiceSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const incomingInvoiceId = Number(values.__supplierIncomingInvoiceId ?? 0);
  const incomingVoucherId = Number(values.__supplierIncomingVoucherId ?? 0);
  if (incomingInvoiceId > 0) {
    const incomingInvoice = await client.request("GET", `/incomingInvoice/${incomingInvoiceId}`, {
      params: {
        fields: "voucherId,invoiceHeader(vendorId,invoiceNumber,invoiceAmount,description,dueDate,invoiceDate)",
      },
    });
    const incomingRecord = toRecord(primaryValue(incomingInvoice));
    const invoiceHeader = toRecord(incomingRecord.invoiceHeader);
    const actualVoucherId = Number(incomingRecord.voucherId ?? 0);
    if (incomingVoucherId > 0 && actualVoucherId !== incomingVoucherId) {
      return { verified: false, detail: "incoming supplier invoice voucher id mismatch", required: true };
    }
    const supplierId = Number(values.__supplierId ?? 0);
    if (supplierId > 0 && Number(invoiceHeader.vendorId ?? 0) !== supplierId) {
      return { verified: false, detail: "incoming supplier invoice vendor mismatch", required: true };
    }
    const invoiceNumber = typeof values.invoiceNumber === "string" ? values.invoiceNumber.trim() : "";
    if (invoiceNumber && normalized(invoiceHeader.invoiceNumber) !== normalized(invoiceNumber)) {
      return { verified: false, detail: "incoming supplier invoice number mismatch", required: true };
    }
    const grossAmount = toNumber(values.amount);
    if (!grossAmount || !nearlyEqual(Number(invoiceHeader.invoiceAmount ?? 0), grossAmount)) {
      return { verified: false, detail: "incoming supplier invoice amount mismatch", required: true };
    }
    return { verified: true, detail: "supplier invoice verified via incoming invoice", required: true };
  }

  const voucherId = Number(values.__supplierVoucherId ?? 0);
  if (voucherId <= 0) {
    return { verified: false, detail: "supplier invoice voucher id missing", required: true };
  }

  const supplierId = Number(values.__supplierId ?? 0);
  const voucherResponse = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: {
      fields: "id,date,description,externalVoucherNumber,vendorInvoiceNumber,postings(account(number),supplier(id,name,organizationNumber),amountGross)",
    },
  });
  const voucher = toRecord(primaryValue(voucherResponse));
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  if (postings.length < 2) {
    return { verified: false, detail: "supplier invoice voucher missing postings", required: true };
  }

  const invoiceNumber = typeof values.invoiceNumber === "string" ? values.invoiceNumber.trim() : "";
  if (invoiceNumber && normalized(voucher.externalVoucherNumber) !== normalized(invoiceNumber)) {
    return { verified: false, detail: "supplier invoice number not stored on voucher", required: true };
  }

  if (supplierId > 0) {
    const supplierMismatch = postings.some((posting) => Number(toRecord(posting.supplier).id ?? 0) !== supplierId);
    if (supplierMismatch) {
      return { verified: false, detail: "supplier invoice voucher postings are not linked to the expected supplier", required: true };
    }
  }

  const grossAmount = toNumber(values.amount);
  if (!grossAmount || grossAmount <= 0) {
    return { verified: false, detail: "supplier invoice verification requires gross amount", required: true };
  }

  const expenseAccountNumber = toNumber(values.accountNumber);
  if (!expenseAccountNumber || expenseAccountNumber <= 0) {
    return { verified: false, detail: "supplier invoice verification requires expense account", required: true };
  }

  const vatRate = toNumber(values.vatRate);
  const { expenseAmount, vatAmount } = computeVoucherAmounts(grossAmount, vatRate);
  const payablePosting = postings.find((posting) => Number(toRecord(posting.account).number ?? 0) === SUPPLIER_PAYABLE_ACCOUNT);
  if (!payablePosting || !nearlyEqual(Number(payablePosting.amountGross ?? 0), -grossAmount)) {
    return { verified: false, detail: "supplier payable posting missing or incorrect", required: true };
  }

  const expensePosting = postings.find((posting) => Number(toRecord(posting.account).number ?? 0) === Math.trunc(expenseAccountNumber));
  if (!expensePosting || !nearlyEqual(Number(expensePosting.amountGross ?? 0), expenseAmount)) {
    return { verified: false, detail: "supplier expense posting missing or incorrect", required: true };
  }

  if (vatAmount > 0) {
    const vatAccountNumber = vatAccountNumberForRate(vatRate ?? 0);
    const vatPosting = postings.find((posting) => Number(toRecord(posting.account).number ?? 0) === vatAccountNumber);
    if (!vatPosting || !nearlyEqual(Number(vatPosting.amountGross ?? 0), vatAmount)) {
      return { verified: false, detail: "input VAT posting missing or incorrect", required: true };
    }
  }

  return { verified: true, detail: "supplier invoice voucher verified", required: true };
}
