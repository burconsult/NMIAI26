import assert from "node:assert/strict";

import {
  createClient,
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

type VoucherRecord = {
  id: number;
  date?: string;
  description?: string;
  postings?: Array<{
    amountGross?: number | string;
    account?: { number?: number | string; name?: string };
  }>;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = Number(value.replace(/\s+/g, "").replace(",", "."));
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

async function listVoucherIdsForDate(client: ReturnType<typeof createClient>, date: string): Promise<number[]> {
  const response = await client.request("GET", "/ledger/voucher", {
    params: {
      count: 200,
      from: 0,
      dateFrom: date,
      dateTo: shiftIsoDate(date, 1),
      fields: "id,date,description",
    },
  });
  return valuesArray<Record<string, unknown>>(response)
    .map((item) => Number(item.id ?? 0))
    .filter((id) => id > 0);
}

async function fetchVoucher(client: ReturnType<typeof createClient>, voucherId: number): Promise<VoucherRecord> {
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,date,description,postings(amountGross,account(number,name))" },
  });
  return primaryValue<VoucherRecord>(response);
}

function voucherHasPosting(voucher: VoucherRecord, accountNumber: number, amount: number): boolean {
  const postings = Array.isArray(voucher.postings) ? voucher.postings : [];
  return postings.some((posting) => {
    const number = Math.trunc(asNumber(posting.account?.number) ?? 0);
    const amountGross = asNumber(posting.amountGross);
    return number === accountNumber && amountGross !== null && Math.abs(amountGross - amount) < 0.02;
  });
}

function findVoucher(
  vouchers: VoucherRecord[],
  description: string,
  accountNumber: number,
  amount: number,
): VoucherRecord | undefined {
  return vouchers.find((voucher) =>
    voucher.description === description && voucherHasPosting(voucher, accountNumber, amount));
}

async function main(): Promise<void> {
  const endpoint = resolveSolveEndpoint();
  const apiKey = resolveApiKey();
  const creds = await resolveTripletexCredentials();
  const seed = parseFlag("seed") ?? uniqueSuffix();
  printHarnessHeader("Tripletex seeded month-end", endpoint, seed);

  const client = createClient(creds);
  const closeDate = "2026-03-31";
  const periodLabel = "2026-03";
  const accrualAmount = 6157;
  const assetOneLabel = `Inventar ${seed}`;
  const assetTwoLabel = `Maschine ${seed}`;
  const assetOneCost = 181471;
  const assetTwoCost = 94213;
  const assetOneAmount = roundMoney(assetOneCost / 10 / 12);
  const assetTwoAmount = roundMoney(assetTwoCost / 7 / 12);

  const prompt =
    `Führen Sie den Monatsabschluss für März 2026 durch. `
    + `Buchen Sie die Rechnungsabgrenzung (${accrualAmount} NOK pro Monat von Konto 1710 auf Aufwandskonto 6800). `
    + `Erfassen Sie die monatliche Abschreibung für zwei Anlagen: `
    + `${assetOneLabel} (${assetOneCost} NOK, 10 Jahre, Konto 1240) und `
    + `${assetTwoLabel} (${assetTwoCost} NOK, 7 Jahre, Konto 1200). `
    + `Verwenden Sie Konto 6010 für Abschreibungskosten.`;

  const result = await postSolve(endpoint, apiKey, {
    prompt,
    files: [],
    tripletex_credentials: creds,
  });
  console.log(`Solve run ${result.runId || "-"} status=${result.status} verified=${result.verified ? 1 : 0} solverStatus=${result.solverStatus ?? "-"}`);
  assert.equal(result.status, 200, `Expected HTTP 200, got ${result.status}: ${result.bodyText}`);
  assert.equal(result.verified, true, `Expected verified=1, got run ${result.runId || "-"}: ${result.bodyText}`);

  const voucherIds = await listVoucherIdsForDate(client, closeDate);
  assert(voucherIds.length > 0, `No vouchers found on close date ${closeDate}`);
  const vouchers = await Promise.all(voucherIds.map((id) => fetchVoucher(client, id)));

  const accrualDescription = `Month-end closing ${periodLabel} accrual reversal`;
  const depreciationOneDescription = `Month-end closing ${periodLabel} depreciation ${assetOneLabel}`;
  const depreciationTwoDescription = `Month-end closing ${periodLabel} depreciation ${assetTwoLabel}`;

  const accrualVoucher = findVoucher(vouchers, accrualDescription, 6800, accrualAmount);
  assert(accrualVoucher, `Missing accrual voucher '${accrualDescription}'`);
  assert(voucherHasPosting(accrualVoucher, 6800, accrualAmount), `Accrual voucher missing debit posting 6800/${accrualAmount}`);
  assert(voucherHasPosting(accrualVoucher, 1710, -accrualAmount), `Accrual voucher missing credit posting 1710/${-accrualAmount}`);

  const depreciationOneVoucher = findVoucher(vouchers, depreciationOneDescription, 6010, assetOneAmount);
  assert(depreciationOneVoucher, `Missing depreciation voucher '${depreciationOneDescription}'`);
  assert(voucherHasPosting(depreciationOneVoucher, 6010, assetOneAmount), `Depreciation voucher missing debit posting 6010/${assetOneAmount}`);

  const depreciationTwoVoucher = findVoucher(vouchers, depreciationTwoDescription, 6010, assetTwoAmount);
  assert(depreciationTwoVoucher, `Missing depreciation voucher '${depreciationTwoDescription}'`);
  assert(voucherHasPosting(depreciationTwoVoucher, 6010, assetTwoAmount), `Depreciation voucher missing debit posting 6010/${assetTwoAmount}`);

  console.log(`Verified accrual and depreciation vouchers for ${periodLabel}`);
}

await main();
