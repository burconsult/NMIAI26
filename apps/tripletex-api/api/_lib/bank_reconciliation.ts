import type { ExecutionPlan, SolveRequest } from "./schemas.js";
import type { TripletexCapabilities } from "./capabilities.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type BankReconciliationSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;
type Verification = { verified: boolean; detail: string; required: boolean };

type ParsedBankRow = {
  rowNumber: number;
  date: string;
  amount: number;
  description: string;
  invoiceNumber?: string;
  partyName?: string;
  raw: Record<string, string>;
};

type BankArtifact =
  | {
      kind: "customer_invoice";
      invoiceId: number;
      invoiceNumber?: string;
      rowNumber: number;
      amount: number;
      paymentDate: string;
      expectedOutstanding: number;
      description: string;
    }
  | {
      kind: "supplier_invoice_full";
      voucherId: number;
      paymentVoucherId: number;
      rowNumber: number;
      paymentDate: string;
      amount: number;
      originalPostingId: number;
      paymentPostingId: number;
      description: string;
    }
  | {
      kind: "supplier_invoice_partial";
      incomingInvoiceId: number;
      voucherId: number;
      rowNumber: number;
      paymentDate: string;
      amount: number;
      description: string;
    }
  | {
      kind: "supplier_voucher_partial";
      voucherId: number;
      paymentVoucherId: number;
      rowNumber: number;
      paymentDate: string;
      amount: number;
      originalPostingId: number;
      paymentPostingId: number;
      description: string;
    }
  | {
      kind: "manual_follow_up";
      reconciliationId: number;
      rowNumber: number;
      date: string;
      amount: number;
      description: string;
    };

const CUSTOMER_INVOICE_FIELDS =
  "id,invoiceNumber,invoiceDate,amount,amountExcludingVat,amountOutstanding,amountOutstandingTotal,amountCurrencyOutstanding,amountCurrencyOutstandingTotal,customer(id,name,organizationNumber),orderLines(description,displayName,product(name,number))";

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

function parseFlexibleNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function nearlyEqual(left: number, right: number, epsilon = 0.05): boolean {
  return Math.abs(left - right) <= epsilon;
}

function parseIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const numeric = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return null;
}

function isCsvLike(file: SolveRequest["files"][number]): boolean {
  const mime = file.mime_type.toLowerCase();
  const filename = file.filename.toLowerCase();
  return mime === "text/csv"
    || mime === "text/plain"
    || mime === "application/vnd.ms-excel"
    || mime === "application/csv"
    || mime.includes("csv")
    || mime.includes("excel")
    || mime.includes("spreadsheet")
    || filename.endsWith(".csv")
    || filename.endsWith(".txt")
    || filename.endsWith(".tsv");
}

function decodeFileText(file: SolveRequest["files"][number]): string {
  return Buffer.from(file.content_base64 || "", "base64").toString("utf8");
}

function detectDelimiter(headerLine: string): string {
  const delimiters = [";", ",", "\t", "|"];
  const counts = delimiters.map((delimiter) => ({ delimiter, count: headerLine.split(delimiter).length }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]?.count && counts[0].count > 1 ? counts[0].delimiter : ";";
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function normalizeHeader(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractInvoiceNumber(value: string): string | undefined {
  const prefixed = value.match(/\b((?:INV|SUP|BILAG|FAKTURA|FACTURE|FACTURA|FATURA|RECHNUNG)[A-Z0-9-]*\d[A-Z0-9-]*)\b/i)?.[1];
  if (prefixed) return prefixed.toUpperCase();
  const direct = value.match(/\b(?:invoice|faktura|facture|rechnung|factura|fatura|inv)\b[-\s#:]*([a-z0-9][a-z0-9-]*)\b/i)?.[1];
  if (direct) return direct.toUpperCase();
  const generic = value.match(/\b([A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*)\b/);
  if (generic) return generic[1].toUpperCase();
  return undefined;
}

function extractPartyName(text: string): string | undefined {
  const labeled = text.match(
    /\b(?:invoice|supplier|vendor|customer|client|kunde|leverand(?:ø|o)r|fournisseur|proveedor|lieferant|facture|factura|fatura|rechnung)\b[-\s#:]*[A-Z0-9-]*\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9&'’.\-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9&'’.\-]+){0,4})\b/i,
  )?.[1]?.trim();
  if (labeled) return labeled;

  const cleaned = text
    .replace(/\b(?:inv|ref|kid)\b[-\s#:]*[A-Z0-9-]+/gi, " ")
    .replace(/\b(?:invoice|faktura|facture|rechnung|factura|fatura|supplier|vendor|customer|client|kunde|leverand(?:ø|o)r|fournisseur|proveedor|lieferant)\b[:#-]*/gi, " ");
  const match = cleaned.match(/\b([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9&'’.\-]+(?:\s+[A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9&'’.\-]+){0,4})\b/);
  return match?.[1]?.trim();
}

function rowAmountFromRecord(record: Record<string, string>): number | null {
  const amountKeys = [
    "amount",
    "belop",
    "beløp",
    "sum",
    "amount_nok",
    "total",
    "importe",
    "monto",
    "betrag",
    "valor",
    "valor_nok",
    "importe_nok",
    "credit_amount",
    "debit_amount",
    "credit_nok",
    "debit_nok",
    "paid_in",
    "paid_out",
  ];
  for (const key of amountKeys) {
    const value = record[key];
    const parsed = parseFlexibleNumber(value);
    if (parsed !== null) return parsed;
  }
  const credit = parseFlexibleNumber(
    record.credit
    ?? record.incoming
    ?? record.innbetaling
    ?? record.innbetalt
    ?? record.abono
    ?? record.credito
    ?? record.crédito
    ?? record.gutschrift
    ?? record.eingang
    ?? record.eingehend
    ?? record.credit_amount
    ?? record.credit_nok
    ?? record.paid_in
    ?? record.inn
  );
  const debit = parseFlexibleNumber(
    record.debit
    ?? record.outgoing
    ?? record.utbetaling
    ?? record.utbetalt
    ?? record.cargo
    ?? record.debito
    ?? record.débito
    ?? record.lastschrift
    ?? record.ausgang
    ?? record.ausgehend
    ?? record.debit_amount
    ?? record.debit_nok
    ?? record.paid_out
    ?? record.ut
  );
  if (credit !== null || debit !== null) {
    return roundMoney((credit ?? 0) - (debit ?? 0));
  }
  return null;
}

function parseCsvTransactions(files: SolveRequest["files"]): ParsedBankRow[] {
  const orderedFiles = [...files].sort((left, right) => Number(isCsvLike(right)) - Number(isCsvLike(left)));
  for (const file of orderedFiles) {
    const content = decodeFileText(file).replace(/^\uFEFF/, "").trim();
    if (!content) continue;
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;
    const delimiter = detectDelimiter(lines[0] ?? ";");
    const headers = parseCsvLine(lines[0] ?? "", delimiter).map(normalizeHeader);
    if (headers.length < 2) continue;
    const rows: ParsedBankRow[] = [];
    for (let index = 1; index < lines.length; index += 1) {
      const cells = parseCsvLine(lines[index] ?? "", delimiter);
      const record: Record<string, string> = {};
      headers.forEach((header, cellIndex) => {
        record[header] = (cells[cellIndex] ?? "").trim();
      });
      const date =
        parseIsoDate(record.date)
        ?? parseIsoDate(record.fecha)
        ?? parseIsoDate(record.datum)
        ?? parseIsoDate(record.bokforingsdato)
        ?? parseIsoDate(record.buchungsdatum)
        ?? parseIsoDate(record.transaksjonsdato)
        ?? parseIsoDate(record.transaktionsdatum)
        ?? parseIsoDate(record.booking_date)
        ?? parseIsoDate(record.bookingdate)
        ?? parseIsoDate(record.posting_date)
        ?? parseIsoDate(record.transaction_date)
        ?? parseIsoDate(record.value_date)
        ?? parseIsoDate(record.valuta_date)
        ?? parseIsoDate(record.valutadato)
        ?? todayIsoInZone();
      const description = [
        record.description,
        record.beskrivelse,
        record.verwendungszweck,
        record.texto,
        record.concepto,
        record.detalle,
        record.details,
        record.text,
        record.reference,
        record.referencia,
        record.referenz,
        record.melding,
        record.mottaker,
        record.avsender,
        record.counterparty,
        record.payee,
        record.payer,
        record.narrative,
        record.memo,
        record.remittance_information,
      ].find((value) => typeof value === "string" && value.trim())?.trim() ?? "Bank transaction";
      const amount = rowAmountFromRecord(record);
      if (amount === null || Math.abs(amount) < 0.01) continue;
      const invoiceNumber =
        record.invoice_number
        || record.invoice
        || record.fakturanummer
        || record.facture
        || record.factura
        || record.rechnungsnummer
        || record.belegnummer
        || record.documento
        || record.documentonumero
        || record.documento_numero
        || record.reference_number
        || record.numero_referencia
        || record.referenznummer
        || record.kid
        || record.reference
        || extractInvoiceNumber(Object.values(record).join(" "));
      const partyName =
        record.customer
        || record.client
        || record.kunde
        || record.supplier
        || record.vendor
        || record.leverandor
        || record.leverandør
        || record.cliente
        || record.proveedor
        || record.lieferant
        || record.beneficiario
        || record.ordenante
        || record.gegenpartei
        || record.gegenkonto_name
        || record.counterparty
        || record.payee
        || record.payer
        || extractPartyName(description);
      rows.push({
        rowNumber: index + 1,
        date,
        amount: roundMoney(amount),
        description,
        invoiceNumber: typeof invoiceNumber === "string" && invoiceNumber.trim() ? invoiceNumber.trim() : undefined,
        partyName: typeof partyName === "string" && partyName.trim() ? partyName.trim() : undefined,
        raw: record,
      });
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

async function resolveInvoicePaymentTypeId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/invoice/paymentType", {
    params: { count: 1, from: 0, fields: "id,description" },
  });
  const paymentType = toRecord(primaryValue(response));
  const id = Number(paymentType.id ?? 0);
  if (id <= 0) throw new Error("Invoice payment type could not be resolved");
  return id;
}

async function resolveAccountIdByNumber(client: TripletexClient, accountNumber: number): Promise<number> {
  const response = await client.request("GET", "/ledger/account", {
    params: { number: String(accountNumber), count: 1, from: 0, fields: "id,number,name" },
  });
  const account = toRecord(primaryValue(response));
  const id = Number(account.id ?? 0);
  if (id <= 0) throw new Error(`Account ${accountNumber} could not be resolved`);
  return id;
}

async function resolveAccountingPeriodIdForDate(client: TripletexClient, isoDate: string): Promise<number> {
  const response = await client.request("GET", "/ledger/accountingPeriod", {
    params: {
      count: 50,
      from: 0,
      fields: "id,start,end,isClosed",
    },
  });
  const periods = toValues(response).map((item) => toRecord(item));
  const match = periods.find((period) => {
    const start = String(period.start ?? "");
    const end = String(period.end ?? "");
    const isClosed = period.isClosed === true;
    return !isClosed && start <= isoDate && isoDate < end;
  });
  const id = Number(match?.id ?? 0);
  if (id <= 0) throw new Error(`Accounting period could not be resolved for ${isoDate}`);
  return id;
}

async function ensureBankReconciliationSettings(client: TripletexClient): Promise<number> {
  const current = await client.request("GET", "/bank/reconciliation/settings", {
    params: { fields: "id,numberOfMatchesPerPage" },
  });
  const existing = toRecord(primaryValue(current));
  const currentId = Number(existing.id ?? 0);
  if (currentId > 0) return currentId;

  const created = await client.request("POST", "/bank/reconciliation/settings", {
    body: { numberOfMatchesPerPage: "ITEMS_10" },
  });
  const createdId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (createdId <= 0) throw new Error("Bank reconciliation settings could not be created");
  return createdId;
}

async function createManualBankReconciliation(client: TripletexClient, isoDate: string): Promise<{
  reconciliationId: number;
  accountId: number;
  accountingPeriodId: number;
}> {
  const accountId = await resolveAccountIdByNumber(client, 1920);
  const accountingPeriodId = await resolveAccountingPeriodIdForDate(client, isoDate);
  const existing = await client.request("GET", "/bank/reconciliation", {
    params: {
      accountId,
      accountingPeriodId,
      count: 20,
      from: 0,
      fields: "id,isClosed,type,account(id),accountingPeriod(id)",
    },
  });
  const existingOpen = toValues(existing)
    .map((item) => toRecord(item))
    .find((item) => Number(item.id ?? 0) > 0 && item.isClosed !== true);
  const existingId = Number(existingOpen?.id ?? 0);
  if (existingId > 0) {
    return { reconciliationId: existingId, accountId, accountingPeriodId };
  }
  const created = await client.request("POST", "/bank/reconciliation", {
    body: {
      account: { id: accountId },
      accountingPeriod: { id: accountingPeriodId },
      type: "MANUAL",
    },
  });
  const reconciliationId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (reconciliationId <= 0) throw new Error("Manual bank reconciliation could not be created");
  return { reconciliationId, accountId, accountingPeriodId };
}

async function fetchCustomerInvoiceById(client: TripletexClient, invoiceId: number): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `/invoice/${invoiceId}`, {
    params: { fields: CUSTOMER_INVOICE_FIELDS },
  });
  return toRecord(primaryValue(response));
}

function customerInvoiceOutstanding(invoice: Record<string, unknown>): number {
  const candidates = [
    invoice.amountOutstandingTotal,
    invoice.amountCurrencyOutstandingTotal,
    invoice.amountOutstanding,
    invoice.amountCurrencyOutstanding,
  ];
  for (const candidate of candidates) {
    const parsed = parseFlexibleNumber(candidate);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function scoreCustomerInvoice(row: ParsedBankRow, invoice: Record<string, unknown>): number {
  let score = 0;
  const invoiceNumber = String(invoice.invoiceNumber ?? "").trim().toUpperCase();
  if (row.invoiceNumber && invoiceNumber === row.invoiceNumber.toUpperCase()) score += 120;
  const outstanding = customerInvoiceOutstanding(invoice);
  if (Math.abs(outstanding) > 0.01 && nearlyEqual(Math.abs(row.amount), Math.abs(outstanding))) score += 40;
  const grossAmount = parseFlexibleNumber(invoice.amount);
  if (grossAmount !== null && nearlyEqual(Math.abs(row.amount), Math.abs(grossAmount))) score += 25;
  const exVatAmount = parseFlexibleNumber(invoice.amountExcludingVat);
  if (exVatAmount !== null && nearlyEqual(Math.abs(row.amount), Math.abs(exVatAmount))) score += 15;
  const description = normalizeText(row.description);
  const customer = toRecord(invoice.customer);
  const customerName = normalizeText(customer.name);
  if (row.partyName && customerName.includes(normalizeText(row.partyName))) score += 20;
  const lines = Array.isArray(invoice.orderLines) ? invoice.orderLines.map((item) => toRecord(item)) : [];
  const lineMatch = lines.some((line) => {
    const label = normalizeText(line.displayName ?? line.description ?? toRecord(line.product).name);
    return label && description.includes(label);
  });
  if (lineMatch) score += 15;
  if (outstanding <= 0.01) score -= 200;
  return score;
}

async function resolveCustomerInvoice(client: TripletexClient, row: ParsedBankRow): Promise<Record<string, unknown>> {
  if (row.invoiceNumber) {
    const response = await client.request("GET", "/invoice", {
      params: {
        invoiceNumber: row.invoiceNumber,
        count: 20,
        from: 0,
        invoiceDateFrom: "2020-01-01",
        invoiceDateTo: "2100-12-31",
        fields: CUSTOMER_INVOICE_FIELDS,
      },
    });
    const direct = toValues(response)
      .map((item) => toRecord(item))
      .filter((invoice) => String(invoice.invoiceNumber ?? "").trim().toUpperCase() === row.invoiceNumber?.toUpperCase())
      .sort((left, right) => scoreCustomerInvoice(row, right) - scoreCustomerInvoice(row, left))[0];
    if (direct) return direct;
    throw new Error(`No exact customer invoice found for bank row ${row.rowNumber}`);
  }

  const response = await client.request("GET", "/invoice", {
    params: {
      count: 100,
      from: 0,
      invoiceDateFrom: "2020-01-01",
      invoiceDateTo: "2100-12-31",
      fields: CUSTOMER_INVOICE_FIELDS,
    },
  });
  const ranked = toValues(response)
    .map((item) => toRecord(item))
    .map((invoice) => ({ invoice, score: scoreCustomerInvoice(row, invoice) }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  if (!selected || selected.score <= 0) {
    throw new Error(`No matching customer invoice found for bank row ${row.rowNumber}`);
  }
  return selected.invoice;
}

async function resolveIncomingInvoice(client: TripletexClient, row: ParsedBankRow): Promise<Record<string, unknown>> {
  const baseParams: Record<string, unknown> = {
    status: "ledger",
    count: 100,
    from: 0,
    invoiceDateFrom: "2020-01-01",
    invoiceDateTo: "2100-12-31",
    fields: "id,voucherId,invoiceHeader(vendorId,invoiceNumber,invoiceAmount,description),metadata(voucherNumber)",
  };
  if (row.invoiceNumber) {
    const response = await client.request("GET", "/incomingInvoice/search", {
      params: {
        ...baseParams,
        invoiceNumber: row.invoiceNumber,
      },
    });
    const direct = toValues(response)
      .map((item) => toRecord(item))
      .find((invoice) => String(toRecord(invoice.invoiceHeader).invoiceNumber ?? "").trim().toUpperCase() === row.invoiceNumber?.toUpperCase());
    if (direct) return direct;
    throw new Error(`No exact supplier invoice found for bank row ${row.rowNumber}`);
  }

  const response = await client.request("GET", "/incomingInvoice/search", { params: baseParams });
  const ranked = toValues(response)
    .map((item) => toRecord(item))
    .map((invoice) => ({ invoice, score: scoreIncomingInvoice(row, invoice) }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  if (!selected || selected.score <= 0) {
    throw new Error(`No matching supplier invoice found for bank row ${row.rowNumber}`);
  }
  return selected.invoice;
}

type SupplierVoucherMatch = {
  voucherId: number;
  supplierId: number;
  supplierName?: string;
  originalPostingId: number;
  originalAmount: number;
  description?: string;
  externalVoucherNumber?: string;
  vendorInvoiceNumber?: string;
};

function scoreSupplierVoucher(row: ParsedBankRow, voucher: Record<string, unknown>): number {
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  const payablePosting = postings.find((posting) => {
    const accountNumber = parseFlexibleNumber(toRecord(posting.account).number);
    const amount = parseFlexibleNumber(posting.amountGross);
    const closeGroupId = Number(toRecord(posting.closeGroup).id ?? 0);
    return Math.trunc(accountNumber ?? 0) === 2400 && (amount ?? 0) < 0 && closeGroupId <= 0;
  });
  if (!payablePosting) return -1000;

  let score = 0;
  const description = normalizeText(voucher.description);
  const externalVoucherNumber = String(voucher.externalVoucherNumber ?? "").trim().toUpperCase();
  const vendorInvoiceNumber = String(voucher.vendorInvoiceNumber ?? "").trim().toUpperCase();
  if (row.invoiceNumber) {
    const invoiceNumber = row.invoiceNumber.toUpperCase();
    if (externalVoucherNumber === invoiceNumber || vendorInvoiceNumber === invoiceNumber) score += 120;
    if (description.includes(normalizeText(invoiceNumber))) score += 40;
  }
  const supplier = toRecord(payablePosting.supplier);
  const supplierName = normalizeText(supplier.name);
  if (row.partyName && supplierName.includes(normalizeText(row.partyName))) score += 20;
  const amount = Math.abs(parseFlexibleNumber(payablePosting.amountGross) ?? 0);
  if (amount > 0 && nearlyEqual(Math.abs(row.amount), amount)) score += 40;
  if (description && normalizeText(row.description).includes(description)) score += 10;
  return score;
}

async function resolveSupplierVoucher(client: TripletexClient, row: ParsedBankRow): Promise<SupplierVoucherMatch> {
  const baseParams = {
    count: 100,
    dateFrom: "2020-01-01",
    dateTo: "2100-12-31",
    fields:
      "id,description,externalVoucherNumber,vendorInvoiceNumber,postings(id,amountGross,account(number),supplier(id,name),closeGroup(id))",
  } as const;

  let candidates: Record<string, unknown>[] = [];
  if (row.invoiceNumber) {
    const invoiceNumber = row.invoiceNumber.toUpperCase();
    for (let from = 0; from <= 1000; from += 100) {
      const response = await client.request("GET", "/ledger/voucher", {
        params: { ...baseParams, from },
      });
      const page = toValues(response).map((item) => toRecord(item));
      candidates = page.filter((voucher) => {
        const externalVoucherNumber = String(voucher.externalVoucherNumber ?? "").trim().toUpperCase();
        const vendorInvoiceNumber = String(voucher.vendorInvoiceNumber ?? "").trim().toUpperCase();
        return externalVoucherNumber === invoiceNumber || vendorInvoiceNumber === invoiceNumber;
      });
      if (candidates.length > 0) break;
      if (page.length < baseParams.count) break;
    }
  } else {
    const response = await client.request("GET", "/ledger/voucher", {
      params: { ...baseParams, from: 0 },
    });
    candidates = toValues(response).map((item) => toRecord(item));
  }
  const ranked = candidates
    .map((voucher) => ({ voucher, score: scoreSupplierVoucher(row, voucher) }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  if (!selected || selected.score <= 0) {
    throw new Error(`No matching supplier voucher found for bank row ${row.rowNumber}`);
  }

  const postings = Array.isArray(selected.voucher.postings)
    ? selected.voucher.postings.map((item) => toRecord(item))
    : [];
  const payablePosting = postings.find((posting) => {
    const accountNumber = parseFlexibleNumber(toRecord(posting.account).number);
    const amount = parseFlexibleNumber(posting.amountGross);
    const closeGroupId = Number(toRecord(posting.closeGroup).id ?? 0);
    return Math.trunc(accountNumber ?? 0) === 2400 && (amount ?? 0) < 0 && closeGroupId <= 0;
  });
  const supplier = toRecord(payablePosting?.supplier);
  const voucherId = Number(selected.voucher.id ?? 0);
  const supplierId = Number(supplier.id ?? 0);
  const originalPostingId = Number(payablePosting?.id ?? 0);
  const originalAmount = Math.abs(parseFlexibleNumber(payablePosting?.amountGross) ?? 0);
  if (voucherId <= 0 || supplierId <= 0 || originalPostingId <= 0 || originalAmount <= 0) {
    throw new Error(`Supplier voucher fallback could not resolve an open payable posting for bank row ${row.rowNumber}`);
  }
  return {
    voucherId,
    supplierId,
    supplierName: typeof supplier.name === "string" ? supplier.name : undefined,
    originalPostingId,
    originalAmount,
    description: typeof selected.voucher.description === "string" ? selected.voucher.description : undefined,
    externalVoucherNumber: typeof selected.voucher.externalVoucherNumber === "string" ? selected.voucher.externalVoucherNumber : undefined,
    vendorInvoiceNumber: typeof selected.voucher.vendorInvoiceNumber === "string" ? selected.voucher.vendorInvoiceNumber : undefined,
  };
}

function scoreIncomingInvoice(row: ParsedBankRow, invoice: Record<string, unknown>): number {
  let score = 0;
  const header = toRecord(invoice.invoiceHeader);
  const invoiceNumber = String(header.invoiceNumber ?? "").trim().toUpperCase();
  if (row.invoiceNumber && invoiceNumber === row.invoiceNumber.toUpperCase()) score += 120;
  const amount = parseFlexibleNumber(header.invoiceAmount);
  if (amount !== null && nearlyEqual(Math.abs(row.amount), Math.abs(amount))) score += 40;
  const description = normalizeText(row.description);
  const invoiceDescription = normalizeText(header.description);
  if (invoiceDescription && description.includes(invoiceDescription)) score += 15;
  if (row.partyName) {
    const vendorId = Number(header.vendorId ?? 0);
    if (vendorId > 0 && description.includes(normalizeText(row.partyName))) score += 10;
  }
  return score;
}

async function fetchVoucher(client: TripletexClient, voucherId: number, fields: string): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, { params: { fields } });
  return toRecord(primaryValue(response));
}

async function addSupplierPartialPayment(
  client: TripletexClient,
  incomingInvoiceId: number,
  row: ParsedBankRow,
): Promise<void> {
  await client.request("POST", `/incomingInvoice/${incomingInvoiceId}/addPayment`, {
    body: {
      amountCurrency: roundMoney(Math.abs(row.amount)),
      paymentDate: row.date,
      useDefaultPaymentType: true,
      partialPayment: true,
      kidOrReceiverReference: row.invoiceNumber,
    },
  });
}

async function createSupplierPaymentVoucher(
  client: TripletexClient,
  invoiceVoucherId: number,
  row: ParsedBankRow,
  options?: { closeOnFullAmount?: boolean; originalPostingId?: number; supplierId?: number; originalAmount?: number },
): Promise<{ paymentVoucherId: number; originalPostingId: number; paymentPostingId: number }> {
  const voucher = await fetchVoucher(
    client,
    invoiceVoucherId,
    "id,description,postings(id,amountGross,account(number),supplier(id,name),closeGroup(id))",
  );
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  const originalPosting = postings.find((posting) => {
    const accountNumber = parseFlexibleNumber(toRecord(posting.account).number);
    const amount = parseFlexibleNumber(posting.amountGross);
    const hasCloseGroup = Number(toRecord(posting.closeGroup).id ?? 0) > 0;
    const matchesPostingId = options?.originalPostingId ? Number(posting.id ?? 0) === options.originalPostingId : true;
    const matchesSupplierId = options?.supplierId ? Number(toRecord(posting.supplier).id ?? 0) === options.supplierId : true;
    return Math.trunc(accountNumber ?? 0) === 2400 && (amount ?? 0) < 0 && !hasCloseGroup && matchesPostingId && matchesSupplierId;
  });
  const supplierId = Number(options?.supplierId ?? toRecord(originalPosting?.supplier).id ?? 0);
  const originalPostingId = Number(options?.originalPostingId ?? originalPosting?.id ?? 0);
  const originalAmount = Math.abs(parseFlexibleNumber(options?.originalAmount ?? originalPosting?.amountGross) ?? 0);
  if (supplierId <= 0 || originalPostingId <= 0) {
    throw new Error(`Supplier payable posting not found on voucher ${invoiceVoucherId}`);
  }
  const bankAccountId = await resolveAccountIdByNumber(client, 1920);
  const supplierAccountId = await resolveAccountIdByNumber(client, 2400);
  const amount = roundMoney(Math.abs(row.amount));
  const created = await client.request("POST", "/ledger/voucher", {
    body: {
      date: row.date,
      description: `Bank payment ${row.invoiceNumber ?? row.description}`.slice(0, 120),
      externalVoucherNumber: row.invoiceNumber,
      postings: [
        {
          row: 1,
          account: { id: supplierAccountId },
          supplier: { id: supplierId },
          amountGross: amount,
          amountGrossCurrency: amount,
        },
        {
          row: 2,
          account: { id: bankAccountId },
          amountGross: -amount,
          amountGrossCurrency: -amount,
        },
      ],
    },
  });
  const paymentVoucherId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (paymentVoucherId <= 0) {
    throw new Error(`Supplier payment voucher was not created for bank row ${row.rowNumber}`);
  }
  const paymentVoucher = await fetchVoucher(
    client,
    paymentVoucherId,
    "id,postings(id,amountGross,account(number),supplier(id,name),closeGroup(id))",
  );
  const paymentPosting = (Array.isArray(paymentVoucher.postings) ? paymentVoucher.postings : [])
    .map((item) => toRecord(item))
    .find((posting) => Math.trunc(parseFlexibleNumber(toRecord(posting.account).number) ?? 0) === 2400 && Number(toRecord(posting.supplier).id ?? 0) === supplierId);
  const paymentPostingId = Number(paymentPosting?.id ?? 0);
  if (paymentPostingId <= 0) {
    throw new Error(`Supplier payment posting missing on voucher ${paymentVoucherId}`);
  }
  if (options?.closeOnFullAmount !== false && nearlyEqual(amount, originalAmount)) {
    await client.request("PUT", "/ledger/posting/:closePostings", {
      body: [originalPostingId, paymentPostingId],
    });
  }
  return { paymentVoucherId, originalPostingId, paymentPostingId };
}

export function matchesBankReconciliationWorkflow(spec: BankReconciliationSpec): boolean {
  return spec.entity === "bank_reconciliation" && spec.operation === "create";
}

export function compileBankReconciliationPreview(
  op: BankReconciliationSpec["operation"],
  values: Record<string, unknown>,
): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List bank reconciliations",
      steps: [
        {
          method: "GET",
          path: "/bank/reconciliation",
          params: { count: 20, from: 0, fields: "id,account(id),isClosed" },
        },
      ],
    };
  }
  return {
    summary: "Reconcile bank statement rows against open invoices",
    steps: [
      { method: "PUT", path: "/invoice/123/:payment", params: { paymentDate: values.date ?? todayIsoInZone(), paymentTypeId: 1, paidAmount: 100 } },
      { method: "POST", path: "/ledger/voucher", body: { date: values.date ?? todayIsoInZone(), description: "Bank payment" } },
      { method: "PUT", path: "/ledger/posting/:closePostings", body: { postingIds: [1, 2] } },
    ],
  };
}

export async function executeBankReconciliationWorkflow(
  client: TripletexClient,
  spec: BankReconciliationSpec,
  payload: Pick<SolveRequest, "files" | "prompt">,
  capabilities: TripletexCapabilities | undefined,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileBankReconciliationPreview(spec.operation, values);
  if (dryRun) return preview;

  const rows = parseCsvTransactions(payload.files);
  if (rows.length === 0) {
    throw new Error("Bank reconciliation workflow requires a parseable CSV attachment");
  }

  const artifacts: BankArtifact[] = [];
  const paymentTypeId = await resolveInvoicePaymentTypeId(client);
  values.__bankWorkflowMode = capabilities?.bank.hasReconciliationSettings ? "statement_matching_fallback" : "payment_matching_fallback";
  values.__bankExpectedRows = rows.length;
  const executionSteps: ExecutionPlan["steps"] = [];
  let createdSettingsId = 0;
  let manualReconciliation:
    | { reconciliationId: number; accountId: number; accountingPeriodId: number }
    | undefined;

  const ensureManualFollowUp = async (row: ParsedBankRow): Promise<number> => {
    if (!createdSettingsId) {
      createdSettingsId = await ensureBankReconciliationSettings(client);
      executionSteps.push({
        method: "POST",
        path: "/bank/reconciliation/settings",
        body: { numberOfMatchesPerPage: "ITEMS_10" },
      });
    }
    if (!manualReconciliation) {
      manualReconciliation = await createManualBankReconciliation(client, row.date);
      executionSteps.push({
        method: "POST",
        path: "/bank/reconciliation",
        body: {
          account: { id: manualReconciliation.accountId },
          accountingPeriod: { id: manualReconciliation.accountingPeriodId },
          type: "MANUAL",
        },
      });
      values.__bankManualReconciliationId = manualReconciliation.reconciliationId;
    }
    return manualReconciliation.reconciliationId;
  };

  for (const row of rows) {
    if (row.amount > 0) {
      let invoice: Record<string, unknown>;
      try {
        invoice = await resolveCustomerInvoice(client, row);
      } catch {
        const reconciliationId = await ensureManualFollowUp(row);
        artifacts.push({
          kind: "manual_follow_up",
          reconciliationId,
          rowNumber: row.rowNumber,
          date: row.date,
          amount: row.amount,
          description: row.description,
        });
        continue;
      }
      const invoiceId = Number(invoice.id ?? 0);
      if (invoiceId <= 0) throw new Error(`Customer invoice id missing for bank row ${row.rowNumber}`);
      const beforeOutstanding = customerInvoiceOutstanding(invoice);
      const paidAmount = Math.min(roundMoney(Math.abs(row.amount)), beforeOutstanding > 0 ? beforeOutstanding : roundMoney(Math.abs(row.amount)));
      await client.request("PUT", `/invoice/${invoiceId}/:payment`, {
        params: {
          paymentDate: row.date,
          paymentTypeId,
          paidAmount,
        },
      });
      const expectedOutstanding = Math.max(0, roundMoney(beforeOutstanding - paidAmount));
      artifacts.push({
        kind: "customer_invoice",
        invoiceId,
        invoiceNumber: String(invoice.invoiceNumber ?? row.invoiceNumber ?? "").trim() || undefined,
        rowNumber: row.rowNumber,
        amount: paidAmount,
        paymentDate: row.date,
        expectedOutstanding,
        description: row.description,
      });
      executionSteps.push({
        method: "PUT",
        path: `/invoice/${invoiceId}/:payment`,
        params: { paymentDate: row.date, paymentTypeId, paidAmount },
      });
      continue;
    }

    let incomingInvoice: Record<string, unknown> | undefined;
    let supplierVoucherMatch: SupplierVoucherMatch | undefined;
    try {
      incomingInvoice = await resolveIncomingInvoice(client, row);
    } catch {
      try {
        supplierVoucherMatch = await resolveSupplierVoucher(client, row);
      } catch {
        const reconciliationId = await ensureManualFollowUp(row);
        artifacts.push({
          kind: "manual_follow_up",
          reconciliationId,
          rowNumber: row.rowNumber,
          date: row.date,
          amount: row.amount,
          description: row.description,
        });
        continue;
      }
    }
    const paymentAmount = roundMoney(Math.abs(row.amount));
    if (supplierVoucherMatch) {
      const closeInFull = nearlyEqual(supplierVoucherMatch.originalAmount, paymentAmount);
      const payment = await createSupplierPaymentVoucher(client, supplierVoucherMatch.voucherId, row, {
        closeOnFullAmount: closeInFull,
        originalPostingId: supplierVoucherMatch.originalPostingId,
        supplierId: supplierVoucherMatch.supplierId,
        originalAmount: supplierVoucherMatch.originalAmount,
      });
      artifacts.push(closeInFull
        ? {
            kind: "supplier_invoice_full",
            voucherId: supplierVoucherMatch.voucherId,
            paymentVoucherId: payment.paymentVoucherId,
            rowNumber: row.rowNumber,
            paymentDate: row.date,
            amount: paymentAmount,
            originalPostingId: payment.originalPostingId,
            paymentPostingId: payment.paymentPostingId,
            description: row.description,
          }
        : {
            kind: "supplier_voucher_partial",
            voucherId: supplierVoucherMatch.voucherId,
            paymentVoucherId: payment.paymentVoucherId,
            rowNumber: row.rowNumber,
            paymentDate: row.date,
            amount: paymentAmount,
            originalPostingId: payment.originalPostingId,
            paymentPostingId: payment.paymentPostingId,
            description: row.description,
          });
      executionSteps.push({
        method: "POST",
        path: "/ledger/voucher",
        body: { date: row.date, description: `Bank payment ${row.invoiceNumber ?? row.description}`.slice(0, 120) },
      });
      if (closeInFull) {
        executionSteps.push({
          method: "PUT",
          path: "/ledger/posting/:closePostings",
          body: { postingIds: [payment.originalPostingId, payment.paymentPostingId] },
        });
      }
      continue;
    }

    const voucherId = Number(incomingInvoice?.voucherId ?? 0);
    const incomingInvoiceId = Number(incomingInvoice?.id ?? 0);
    if (voucherId <= 0) {
      throw new Error(`Supplier invoice voucher id missing for bank row ${row.rowNumber}`);
    }

    const invoiceHeader = toRecord(incomingInvoice?.invoiceHeader);
    const invoiceAmount = Math.abs(parseFlexibleNumber(invoiceHeader.invoiceAmount) ?? 0);
    if (invoiceAmount > 0 && nearlyEqual(invoiceAmount, paymentAmount)) {
      const closed = await createSupplierPaymentVoucher(client, voucherId, row);
      artifacts.push({
        kind: "supplier_invoice_full",
        voucherId,
        paymentVoucherId: closed.paymentVoucherId,
        rowNumber: row.rowNumber,
        paymentDate: row.date,
        amount: paymentAmount,
        originalPostingId: closed.originalPostingId,
        paymentPostingId: closed.paymentPostingId,
        description: row.description,
      });
      executionSteps.push({
        method: "POST",
        path: "/ledger/voucher",
        body: { date: row.date, description: `Bank payment ${row.invoiceNumber ?? row.description}`.slice(0, 120) },
      });
      executionSteps.push({
        method: "PUT",
        path: "/ledger/posting/:closePostings",
        body: { postingIds: [closed.originalPostingId, closed.paymentPostingId] },
      });
      continue;
    }

    if (incomingInvoiceId <= 0) {
      throw new Error(`Supplier incoming invoice id missing for bank row ${row.rowNumber}`);
    }

    await addSupplierPartialPayment(client, incomingInvoiceId, row);
    artifacts.push({
      kind: "supplier_invoice_partial",
      incomingInvoiceId,
      voucherId,
      rowNumber: row.rowNumber,
      paymentDate: row.date,
      amount: paymentAmount,
      description: row.description,
    });
    executionSteps.push({
      method: "POST",
      path: `/incomingInvoice/${incomingInvoiceId}/addPayment`,
      body: { paymentDate: row.date, amountCurrency: paymentAmount, partialPayment: true },
    });
  }

  values.__bankArtifacts = artifacts;
  values.__bankProcessedRows = artifacts.length;
  values.__bankManualFollowUpRows = artifacts.filter((artifact) => artifact.kind === "manual_follow_up").length;

  return {
    summary:
      values.__bankManualFollowUpRows
        ? `Bank reconciliation processed ${artifacts.length} statement rows with ${values.__bankManualFollowUpRows} row(s) left for manual follow-up`
        : `Bank reconciliation processed ${artifacts.length} statement rows`,
    steps: executionSteps,
  };
}

async function verifyCustomerInvoiceArtifact(client: TripletexClient, artifact: Extract<BankArtifact, { kind: "customer_invoice" }>): Promise<boolean> {
  const invoice = await fetchCustomerInvoiceById(client, artifact.invoiceId);
  const invoiceNumber = String(invoice.invoiceNumber ?? "").trim().toUpperCase();
  if (artifact.invoiceNumber && invoiceNumber !== artifact.invoiceNumber.trim().toUpperCase()) {
    return false;
  }
  const outstanding = customerInvoiceOutstanding(invoice);
  return outstanding <= artifact.expectedOutstanding + 0.05;
}

async function verifySupplierFullArtifact(client: TripletexClient, artifact: Extract<BankArtifact, { kind: "supplier_invoice_full" }>): Promise<boolean> {
  const originalVoucher = await fetchVoucher(client, artifact.voucherId, "id,postings(id,account(number),closeGroup(id),amountGross)");
  const paymentVoucher = await fetchVoucher(client, artifact.paymentVoucherId, "id,postings(id,account(number),closeGroup(id),amountGross)");
  const originalPosting = (Array.isArray(originalVoucher.postings) ? originalVoucher.postings : [])
    .map((item) => toRecord(item))
    .find((posting) => Number(posting.id ?? 0) === artifact.originalPostingId);
  const paymentPosting = (Array.isArray(paymentVoucher.postings) ? paymentVoucher.postings : [])
    .map((item) => toRecord(item))
    .find((posting) => Number(posting.id ?? 0) === artifact.paymentPostingId);
  const originalCloseGroupId = Number(toRecord(originalPosting?.closeGroup).id ?? 0);
  const paymentCloseGroupId = Number(toRecord(paymentPosting?.closeGroup).id ?? 0);
  return originalCloseGroupId > 0 && originalCloseGroupId === paymentCloseGroupId;
}

async function verifySupplierPartialArtifact(client: TripletexClient, artifact: Extract<BankArtifact, { kind: "supplier_invoice_partial" }>): Promise<boolean> {
  const invoice = await client.request("GET", `/incomingInvoice/${artifact.incomingInvoiceId}`, {
    params: { fields: "id,voucherId,invoiceHeader(invoiceNumber,invoiceAmount),metadata(voucherNumber)" },
  });
  const record = toRecord(primaryValue(invoice));
  return Number(record.id ?? 0) === artifact.incomingInvoiceId && Number(record.voucherId ?? 0) === artifact.voucherId;
}

async function verifySupplierVoucherPartialArtifact(client: TripletexClient, artifact: Extract<BankArtifact, { kind: "supplier_voucher_partial" }>): Promise<boolean> {
  const originalVoucher = await fetchVoucher(client, artifact.voucherId, "id,postings(id,account(number),closeGroup(id),amountGross,supplier(id,name))");
  const paymentVoucher = await fetchVoucher(client, artifact.paymentVoucherId, "id,postings(id,account(number),closeGroup(id),amountGross,supplier(id,name))");
  const originalPosting = (Array.isArray(originalVoucher.postings) ? originalVoucher.postings : [])
    .map((item) => toRecord(item))
    .find((posting) => Number(posting.id ?? 0) === artifact.originalPostingId);
  const paymentPosting = (Array.isArray(paymentVoucher.postings) ? paymentVoucher.postings : [])
    .map((item) => toRecord(item))
    .find((posting) => Number(posting.id ?? 0) === artifact.paymentPostingId);
  const originalCloseGroupId = Number(toRecord(originalPosting?.closeGroup).id ?? 0);
  const paymentCloseGroupId = Number(toRecord(paymentPosting?.closeGroup).id ?? 0);
  return Number(originalPosting?.id ?? 0) === artifact.originalPostingId
    && Number(paymentPosting?.id ?? 0) === artifact.paymentPostingId
    && originalCloseGroupId <= 0
    && paymentCloseGroupId <= 0;
}

async function verifyManualFollowUpArtifact(client: TripletexClient, artifact: Extract<BankArtifact, { kind: "manual_follow_up" }>): Promise<boolean> {
  const reconciliation = await client.request("GET", `/bank/reconciliation/${artifact.reconciliationId}`, {
    params: { fields: "id,isClosed,type,account(id),accountingPeriod(id,start,end)" },
  });
  const record = toRecord(primaryValue(reconciliation));
  return Number(record.id ?? 0) === artifact.reconciliationId && record.isClosed !== true && record.type === "MANUAL";
}

export async function verifyBankReconciliationOutcome(
  client: TripletexClient,
  spec: BankReconciliationSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const artifacts = Array.isArray(values.__bankArtifacts) ? values.__bankArtifacts as BankArtifact[] : [];
  const expectedRows = Number(values.__bankExpectedRows ?? 0);
  if (artifacts.length === 0 || expectedRows === 0) {
    return { verified: false, detail: "bank reconciliation did not process any statement rows", required: true };
  }
  if (artifacts.length !== expectedRows) {
    return { verified: false, detail: `bank reconciliation processed ${artifacts.length}/${expectedRows} rows`, required: true };
  }

  for (const artifact of artifacts) {
    const verified = artifact.kind === "customer_invoice"
      ? await verifyCustomerInvoiceArtifact(client, artifact)
      : artifact.kind === "supplier_invoice_full"
        ? await verifySupplierFullArtifact(client, artifact)
        : artifact.kind === "supplier_invoice_partial"
          ? await verifySupplierPartialArtifact(client, artifact)
          : artifact.kind === "supplier_voucher_partial"
            ? await verifySupplierVoucherPartialArtifact(client, artifact)
          : await verifyManualFollowUpArtifact(client, artifact);
    if (!verified) {
      return {
        verified: false,
        detail: `bank reconciliation verification failed for row ${artifact.rowNumber} (${artifact.kind})`,
        required: true,
      };
    }
  }

  return {
    verified: true,
    detail: `bank reconciliation verified for ${artifacts.length} statement rows`,
    required: true,
  };
}
