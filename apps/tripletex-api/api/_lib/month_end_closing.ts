import type { ExecutionPlan } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type MonthEndClosingSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;
type Verification = { verified: boolean; detail: string; required: boolean };

type MonthEndDetails = {
  year: number;
  month: number;
  closeDate: string;
  annualClosing: boolean;
  accrualAmount: number | null;
  accrualFromAccountNumber: number | null;
  accrualToAccountNumber: number | null;
  depreciationAmount: number | null;
  assetCost: number | null;
  usefulLifeYears: number | null;
  depreciationExpenseAccountNumber: number | null;
  accumulatedDepreciationAccountNumber: number | null;
  depreciationEntries: DepreciationEntry[];
};

type VoucherArtifact = {
  voucherId: number;
  amount: number;
  debitAccountNumber: number;
  creditAccountNumber: number;
  date: string;
  description: string;
  label?: string;
};

type DepreciationEntry = {
  label: string;
  amount: number;
  assetCost: number;
  usefulLifeYears: number;
  assetAccountNumber?: number | null;
  expenseAccountNumber?: number | null;
  accumulatedAccountNumber?: number | null;
};

const MONTHS: Record<string, number> = {
  january: 1,
  januar: 1,
  janvier: 1,
  enero: 1,
  janeiro: 1,
  february: 2,
  februar: 2,
  fevrier: 2,
  febrero: 2,
  fevereiro: 2,
  march: 3,
  mars: 3,
  marz: 3,
  marzo: 3,
  april: 4,
  avril: 4,
  abril: 4,
  may: 5,
  mai: 5,
  mayo: 5,
  maio: 5,
  june: 6,
  juni: 6,
  juin: 6,
  junio: 6,
  junho: 6,
  july: 7,
  juli: 7,
  juillet: 7,
  julio: 7,
  julho: 7,
  august: 8,
  augusti: 8,
  aout: 8,
  agosto: 8,
  september: 9,
  septembre: 9,
  septiembre: 9,
  setembro: 9,
  october: 10,
  oktober: 10,
  octobre: 10,
  octubre: 10,
  outubro: 10,
  november: 11,
  novembre: 11,
  noviembre: 11,
  december: 12,
  desember: 12,
  decembre: 12,
  diciembre: 12,
  dezembro: 12,
};

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

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function parseFlexibleNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoLastDayOfMonth(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 0));
  return date.toISOString().slice(0, 10);
}

function monthNameToNumber(value: string | undefined): number | null {
  if (!value) return null;
  return MONTHS[normalizeText(value)] ?? null;
}

function parseMonthYear(prompt: string, values: Record<string, unknown>, annualClosing = false): { month: number; year: number } {
  const directMonth = parseFlexibleNumber(values.closingMonth ?? values.month);
  const directYear = parseFlexibleNumber(values.closingYear ?? values.year);
  if (directYear) {
    const resolvedMonth = directMonth
      ? Math.max(1, Math.min(12, Math.trunc(directMonth)))
      : annualClosing
        ? 12
        : new Date().getUTCMonth() + 1;
    return { month: resolvedMonth, year: Math.trunc(directYear) };
  }

  const normalizedPrompt = prompt.replace(/[()]/g, " ");
  const textualMatch = normalizedPrompt.match(/\b(?:for|per|pour|fur|fuer|i|in)\s+([A-Za-zÀ-ÿ]+)\s+(20\d{2})\b/i)
    ?? normalizedPrompt.match(/\b([A-Za-zÀ-ÿ]+)\s+(20\d{2})\b/);
  const textualMonth = monthNameToNumber(textualMatch?.[1]);
  const textualYear = textualMatch?.[2] ? Number(textualMatch[2]) : null;
  if (textualMonth && textualYear) {
    return { month: textualMonth, year: textualYear };
  }

  const standaloneYear = normalizedPrompt.match(/\b(20\d{2})\b/);
  if (standaloneYear?.[1]) {
    return {
      month: annualClosing ? 12 : new Date().getUTCMonth() + 1,
      year: Number(standaloneYear[1]),
    };
  }

  const today = new Date();
  return {
    month: today.getUTCMonth() + 1,
    year: today.getUTCFullYear(),
  };
}

function extractLabeledAccount(prompt: string, pattern: RegExp): number | null {
  const match = prompt.match(pattern);
  return parseFlexibleNumber(match?.[1]);
}

function hasAccrualIntent(prompt: string, values: Record<string, unknown>): boolean {
  if (values.accrualAmount != null || values.accrualFromAccountNumber != null || values.accrualToAccountNumber != null) {
    return true;
  }
  return /\b(?:accrual|accrual reversal|reverse accrual|periodisering|periodiser|prepaid|prepayment|forskudd|forhandsbetalt|forh[aå]ndsbetalt|deferral|deferred|rechnungsabgrenzung|periodificaci[oó]n|periodificacion|periodiza[cç][aã]o|periodizacao)\b/i.test(prompt);
}

function isAnnualClosingPrompt(prompt: string): boolean {
  return /\b(?:year[- ]end closing|year end close|annual closing|annual close|forenkla [aå]rsoppgjer|forenklet [aå]rsoppgj[øo]r|[aå]rsoppgj[øo]r|jahresabschluss|cierre anual|fechamento anual|cl[oô]ture annuelle|cloture annuelle)\b/i.test(prompt);
}

function parseDepreciationEntries(
  prompt: string,
  values: Record<string, unknown>,
  annualClosing: boolean,
): DepreciationEntry[] {
  const explicitExpenseAccountNumber =
    parseFlexibleNumber(values.depreciationExpenseAccountNumber)
    ?? extractLabeledAccount(prompt, /(?:bruk konto|use account)\s*(\d{4,6})\s*(?:for|til)\s*(?:avskrivingskostnad|depreciation expense|charge d['’]amortissement)/i)
    ?? extractLabeledAccount(prompt, /(?:verwenden\s+sie\s+konto|nutzen\s+sie\s+konto)\s*(\d{4,6})\s*(?:für|fur)\s*(?:abschreibungskosten|abschreibungsaufwand)/i)
    ?? extractLabeledAccount(prompt, /(?:utilisez?\s+le\s+compte)\s*(\d{4,6})\s*(?:pour|for)\s*(?:la\s+)?(?:charge d['’]amortissement)/i)
    ?? extractLabeledAccount(prompt, /(?:depreciation expense(?: account)?|avskrivningskonto|charge d['’]amortissement|compte de charge d['’]amortissement|konto for avskrivingskostnad|bruk konto|abschreibungskosten|abschreibungsaufwand)[^\d]{0,20}(\d{4,6})/i);
  const explicitAccumulatedAccountNumber =
    parseFlexibleNumber(values.accumulatedDepreciationAccountNumber)
    ?? extractLabeledAccount(prompt, /(?:og|and)\s*(\d{4,6})\s*(?:for|til)\s*(?:akkumulerte avskrivingar|akkumulerte avskrivninger|accumulated depreciation|amortissement cumul[eé])/i)
    ?? extractLabeledAccount(prompt, /(?:et)\s*(\d{4,6})\s*(?:pour)\s*(?:l['’]amortissement cumul[eé]|amortissement cumul[eé])/i)
    ?? extractLabeledAccount(prompt, /(?:utilisez?\s+le\s+compte)\s*(\d{4,6})\s*(?:pour|for)\s*(?:l['’]amortissement cumul[eé]|amortissement cumul[eé])/i)
    ?? extractLabeledAccount(prompt, /(?:accumulated depreciation(?: account)?|akkumulerte avskrivninger(?: konto)?|amortissement cumul[eé]|compte d['’]amortissement cumul[eé]|akkumulerte avskrivingar|bruk konto)[^\d]{0,40}(\d{4,6})/i);

  const entries: DepreciationEntry[] = [];
  const assetPattern = /([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'’.\- ]{1,60})\s*\((\d[\d .,'’]*)\s*(?:nok|kr|kroner)[^)]*?(\d{1,2}(?:[.,]\d+)?)\s*(?:years?|jahren?|jahre|[aå]r|ans?)[^)]*?(?:konto|account|compte)\s*(\d{4,6})[^)]*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = assetPattern.exec(prompt)) !== null) {
    const label = match[1]?.trim().replace(/^(?:and|og|und|et)\s+/i, "");
    const assetCost = parseFlexibleNumber(match[2]);
    const usefulLifeYears = parseFlexibleNumber(match[3]);
    const assetAccountNumber = parseFlexibleNumber(match[4]);
    if (!label || !assetCost || !usefulLifeYears) continue;
    const amount = annualClosing
      ? roundMoney(assetCost / usefulLifeYears)
      : roundMoney(assetCost / usefulLifeYears / 12);
    if (amount <= 0) continue;
    entries.push({
      label,
      amount,
      assetCost,
      usefulLifeYears,
      assetAccountNumber: assetAccountNumber ? Math.trunc(assetAccountNumber) : null,
      expenseAccountNumber: explicitExpenseAccountNumber ? Math.trunc(explicitExpenseAccountNumber) : null,
      accumulatedAccountNumber: explicitAccumulatedAccountNumber ? Math.trunc(explicitAccumulatedAccountNumber) : null,
    });
  }

  if (entries.length > 0) {
    return entries;
  }

  const assetCost =
    parseFlexibleNumber(values.assetCost)
    ?? parseFlexibleNumber(prompt.match(/(?:acquisition cost|anskaffelseskost|cout d['’]acquisition|coste de adquisicion|coste de adquisición|costo de adquisicion|costo de adquisición|custo de aquisi[cç][aã]o|custo de aquisicao)[^\d]{0,20}(\d[\d .,'’]*)/i)?.[1]);
  const usefulLifeYears =
    parseFlexibleNumber(values.usefulLifeYears)
    ?? parseFlexibleNumber(prompt.match(/(?:useful life|levetid|duree de vie utile|vida util|vida útil|nutzungsdauer)[^\d]{0,20}(\d{1,2}(?:[.,]\d+)?)/i)?.[1]);
  const explicitDepreciationAmount =
    parseFlexibleNumber(values.depreciationAmount)
    ?? parseFlexibleNumber(prompt.match(/(?:monthly depreciation|depreciation of|avskrivning(?: per month)?|depreciation mensuelle|årlege avskrivingar|annual depreciation|depreciaci[oó]n mensual|depreciacion mensual|deprecia[cç][aã]o mensal|depreciacao mensal)[^\d]{0,20}(\d[\d .,'’]*)/i)?.[1]);
  if (assetCost && usefulLifeYears) {
    const amount = explicitDepreciationAmount
      ?? (annualClosing ? roundMoney(assetCost / usefulLifeYears) : roundMoney(assetCost / usefulLifeYears / 12));
    if (amount && amount > 0) {
      return [{
        label: "asset",
        amount,
        assetCost,
        usefulLifeYears,
        expenseAccountNumber: explicitExpenseAccountNumber ? Math.trunc(explicitExpenseAccountNumber) : null,
        accumulatedAccountNumber: explicitAccumulatedAccountNumber ? Math.trunc(explicitAccumulatedAccountNumber) : null,
      }];
    }
  }

  return [];
}

function extractMonthEndDetails(prompt: string, values: Record<string, unknown>): MonthEndDetails {
  const annualClosing = isAnnualClosingPrompt(prompt);
  const { month, year } = parseMonthYear(prompt, values, annualClosing);
  const closeDate = typeof values.date === "string" && values.date.trim()
    ? values.date.trim()
    : isoLastDayOfMonth(year, annualClosing ? 12 : month);
  const wantsAccrual = hasAccrualIntent(prompt, values);

  const accrualAmount =
    wantsAccrual
      ? parseFlexibleNumber(values.accrualAmount)
        ?? parseFlexibleNumber(prompt.match(/(\d[\d .,'’]*)\s*(?:nok|kr|eur|usd|gbp)\s*(?:per month|each month|pr\.?\s*m[aå]ned|par mois|pro monat|por mes|por m[eê]s)/i)?.[1])
        ?? parseFlexibleNumber(values.amount)
      : null;

  const accrualFromAccountNumber =
    wantsAccrual
      ? parseFlexibleNumber(values.accrualFromAccountNumber ?? values.accountNumber)
        ?? extractLabeledAccount(prompt, /(?:from|fra|von|de|du)\s+(?:account|konto|compte|cuenta|conta)\s+(\d{4,6})/i)
        ?? extractLabeledAccount(prompt, /account\s+(\d{4,6})\s+to\s+expense/i)
      : null;

  const accrualToAccountNumber =
    wantsAccrual
      ? parseFlexibleNumber(values.accrualToAccountNumber ?? values.counterAccountNumber ?? values.expenseAccountNumber)
        ?? extractLabeledAccount(prompt, /(?:expense|expense account|kostnadskonto|cost account|depense|charge|aufwandskonto|gasto|cuenta de gasto|despesa|conta de despesa)[^\d]{0,20}(\d{4,6})/i)
      : null;

  const depreciationExpenseAccountNumber =
    parseFlexibleNumber(values.depreciationExpenseAccountNumber)
    ?? extractLabeledAccount(prompt, /(?:utilisez?\s+le\s+compte)\s*(\d{4,6})\s*(?:pour|for)\s*(?:la\s+)?(?:charge d['’]amortissement)/i)
    ?? extractLabeledAccount(prompt, /(?:depreciation expense(?: account)?|avskrivningskonto|amortization expense(?: account)?|charge d['’]amortissement|compte de charge d['’]amortissement)[^\d]{0,20}(\d{4,6})/i);

  const accumulatedDepreciationAccountNumber =
    parseFlexibleNumber(values.accumulatedDepreciationAccountNumber)
    ?? extractLabeledAccount(prompt, /(?:utilisez?\s+le\s+compte)\s*(\d{4,6})\s*(?:pour|for)\s*(?:l['’]amortissement cumul[eé]|amortissement cumul[eé])/i)
    ?? extractLabeledAccount(prompt, /(?:accumulated depreciation(?: account)?|akkumulerte avskrivninger(?: konto)?|contra asset(?: account)?|amortissement cumul[eé]|compte d['’]amortissement cumul[eé])[^\d]{0,20}(\d{4,6})/i);

  const depreciationEntries = parseDepreciationEntries(prompt, values, annualClosing);
  const firstDepreciationEntry = depreciationEntries[0];
  const assetCost = firstDepreciationEntry?.assetCost ?? null;
  const usefulLifeYears = firstDepreciationEntry?.usefulLifeYears ?? null;
  const depreciationAmount = firstDepreciationEntry?.amount ?? null;

  return {
    year,
    month,
    closeDate,
    annualClosing,
    accrualAmount: accrualAmount && accrualAmount > 0 ? accrualAmount : null,
    accrualFromAccountNumber: accrualFromAccountNumber && accrualFromAccountNumber > 0 ? Math.trunc(accrualFromAccountNumber) : null,
    accrualToAccountNumber: accrualToAccountNumber && accrualToAccountNumber > 0 ? Math.trunc(accrualToAccountNumber) : null,
    depreciationAmount: depreciationAmount && depreciationAmount > 0 ? depreciationAmount : null,
    assetCost: assetCost && assetCost > 0 ? assetCost : null,
    usefulLifeYears: usefulLifeYears && usefulLifeYears > 0 ? usefulLifeYears : null,
    depreciationExpenseAccountNumber: depreciationExpenseAccountNumber && depreciationExpenseAccountNumber > 0 ? Math.trunc(depreciationExpenseAccountNumber) : null,
    accumulatedDepreciationAccountNumber: accumulatedDepreciationAccountNumber && accumulatedDepreciationAccountNumber > 0 ? Math.trunc(accumulatedDepreciationAccountNumber) : null,
    depreciationEntries,
  };
}

async function resolveAccountIdByNumber(client: TripletexClient, accountNumber: number): Promise<number> {
  const response = await client.request("GET", "/ledger/account", {
    params: {
      number: String(accountNumber),
      count: 1,
      from: 0,
      fields: "id,number,name",
    },
  });
  const account = toRecord(primaryValue(response));
  const id = Number(account.id ?? 0);
  if (id <= 0) {
    throw new Error(`Account ${accountNumber} could not be resolved`);
  }
  return id;
}

async function listAccounts(client: TripletexClient): Promise<Array<Record<string, unknown>>> {
  const response = await client.request("GET", "/ledger/account", {
    params: {
      count: 500,
      from: 0,
      fields: "id,number,name,type,isInactive",
    },
  });
  return toValues(response).filter((account) => account.isInactive !== true);
}

function pickAccountByKeywords(accounts: Array<Record<string, unknown>>, positiveKeywords: string[], negativeKeywords: string[] = []): number | null {
  for (const account of accounts) {
    const name = normalizeText(account.name);
    if (!name) continue;
    if (!positiveKeywords.every((keyword) => name.includes(normalizeText(keyword)))) continue;
    if (negativeKeywords.some((keyword) => name.includes(normalizeText(keyword)))) continue;
    const number = parseFlexibleNumber(account.number);
    if (number && number > 0) return Math.trunc(number);
  }
  return null;
}

async function inferAccrualCounterAccountNumber(
  client: TripletexClient,
  sourceAccountNumber: number,
  closeDate: string,
): Promise<number | null> {
  const sourceAccountId = await resolveAccountIdByNumber(client, sourceAccountNumber);
  const response = await client.request("GET", "/ledger/posting", {
    params: {
      accountId: sourceAccountId,
      dateFrom: "2020-01-01",
      dateTo: closeDate,
      count: 50,
      from: 0,
      sorting: "date desc",
      fields: "id,date,amountGross,voucher(id,date,description)",
    },
  });
  const postings = toValues(response);
  for (const posting of postings) {
    const voucher = toRecord(posting.voucher);
    const voucherId = Number(voucher.id ?? 0);
    if (voucherId <= 0) continue;
    const voucherResponse = await client.request("GET", `/ledger/voucher/${voucherId}`, {
      params: {
        fields: "id,date,description,postings(id,amountGross,account(number,name))",
      },
    });
    const voucherRecord = toRecord(primaryValue(voucherResponse));
    const voucherPostings = Array.isArray(voucherRecord.postings)
      ? voucherRecord.postings.map((item) => toRecord(item))
      : [];
    const counterpart = voucherPostings.find((item) => {
      const account = toRecord(item.account);
      const number = parseFlexibleNumber(account.number);
      if (!number || Math.trunc(number) === sourceAccountNumber) return false;
      return Math.trunc(number) >= 4000;
    });
    const counterpartNumber = parseFlexibleNumber(toRecord(counterpart?.account).number);
    if (counterpartNumber && counterpartNumber > 0) {
      return Math.trunc(counterpartNumber);
    }
  }
  return null;
}

async function resolveAccrualExpenseAccountNumber(
  client: TripletexClient,
  explicitAccountNumber: number | null,
  sourceAccountNumber: number,
  closeDate: string,
): Promise<number | null> {
  if (explicitAccountNumber && explicitAccountNumber > 0) {
    return Math.trunc(explicitAccountNumber);
  }
  const inferred = await inferAccrualCounterAccountNumber(client, sourceAccountNumber, closeDate);
  if (inferred && inferred > 0) {
    return inferred;
  }
  const accounts = await listAccounts(client);
  const keywordCandidate =
    pickAccountByKeywords(accounts, ["expense"])
    ?? pickAccountByKeywords(accounts, ["kost"])
    ?? pickAccountByKeywords(accounts, ["charge"])
    ?? pickAccountByKeywords(accounts, ["aufwand"])
    ?? pickAccountByKeywords(accounts, ["gasto"])
    ?? pickAccountByKeywords(accounts, ["despesa"]);
  return await firstResolvableAccountNumber(client, [keywordCandidate, 6800, 6590, 6010, 6300]);
}

async function resolveDepreciationAccounts(
  client: TripletexClient,
  explicitExpenseAccountNumber: number | null,
  explicitAccumulatedAccountNumber: number | null,
): Promise<{ expenseAccountNumber: number; accumulatedAccountNumber: number }> {
  const hasExplicitPair = Boolean(
    explicitExpenseAccountNumber && explicitExpenseAccountNumber > 0
    && explicitAccumulatedAccountNumber && explicitAccumulatedAccountNumber > 0,
  );
  const accounts = hasExplicitPair ? [] : await listAccounts(client);
  const expenseCandidates = [
    explicitExpenseAccountNumber,
    pickAccountByKeywords(accounts, ["avskriv"]),
    pickAccountByKeywords(accounts, ["depreci"]),
    6000,
    6010,
  ];
  const accumulatedCandidates = [
    explicitAccumulatedAccountNumber,
    pickAccountByKeywords(accounts, ["akkumul", "avskriv"]),
    pickAccountByKeywords(accounts, ["accum", "depreci"]),
    1290,
    1289,
    1280,
  ];

  const expenseAccountNumber = await firstResolvableAccountNumber(client, expenseCandidates);
  const accumulatedAccountNumber = await firstResolvableAccountNumber(client, accumulatedCandidates);
  if (!expenseAccountNumber || !accumulatedAccountNumber) {
    throw new Error("Month-end closing could not resolve depreciation accounts");
  }
  return { expenseAccountNumber, accumulatedAccountNumber };
}

async function firstResolvableAccountNumber(client: TripletexClient, candidates: Array<number | null>): Promise<number | null> {
  for (const candidate of candidates) {
    if (!candidate || candidate <= 0) continue;
    try {
      await resolveAccountIdByNumber(client, candidate);
      return Math.trunc(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

async function createBalancedVoucher(
  client: TripletexClient,
  date: string,
  description: string,
  debitAccountNumber: number,
  creditAccountNumber: number,
  amount: number,
): Promise<number> {
  const debitAccountId = await resolveAccountIdByNumber(client, debitAccountNumber);
  const creditAccountId = await resolveAccountIdByNumber(client, creditAccountNumber);
  const body = {
    date,
    description,
    postings: [
      {
        row: 1,
        account: { id: debitAccountId },
        amountGross: roundMoney(amount),
        amountGrossCurrency: roundMoney(amount),
      },
      {
        row: 2,
        account: { id: creditAccountId },
        amountGross: -roundMoney(amount),
        amountGrossCurrency: -roundMoney(amount),
      },
    ],
  };
  const response = await client.request("POST", "/ledger/voucher", { body });
  const voucher = toRecord(primaryValue(response));
  const voucherId = Number(voucher.id ?? 0);
  if (voucherId <= 0) {
    throw new Error("Month-end voucher creation did not return an id");
  }
  return voucherId;
}

async function fetchVoucher(client: TripletexClient, voucherId: number): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: {
      fields: "id,date,description,postings(id,amountGross,account(number,name))",
    },
  });
  return toRecord(primaryValue(response));
}

function voucherMatches(voucher: Record<string, unknown>, artifact: VoucherArtifact): boolean {
  if (String(voucher.date ?? "") !== artifact.date) return false;
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  const debitPosting = postings.find((posting) => Math.trunc(parseFlexibleNumber(toRecord(posting.account).number) ?? 0) === artifact.debitAccountNumber);
  const creditPosting = postings.find((posting) => Math.trunc(parseFlexibleNumber(toRecord(posting.account).number) ?? 0) === artifact.creditAccountNumber);
  if (!debitPosting || !creditPosting) return false;
  const debitAmount = parseFlexibleNumber(debitPosting.amountGross);
  const creditAmount = parseFlexibleNumber(creditPosting.amountGross);
  return Math.abs((debitAmount ?? 0) - artifact.amount) < 0.02 && Math.abs((creditAmount ?? 0) + artifact.amount) < 0.02;
}

export function matchesMonthEndClosingWorkflow(spec: MonthEndClosingSpec): boolean {
  return spec.entity === "month_end_closing" && spec.operation === "create";
}

export function compileMonthEndClosingPreview(
  op: MonthEndClosingSpec["operation"],
  values: Record<string, unknown>,
): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List recent closing vouchers",
      steps: [
        {
          method: "GET",
          path: "/ledger/voucher",
          params: {
            count: 20,
            from: 0,
            dateFrom: "2026-01-01",
            dateTo: todayIsoInZone(),
            fields: "id,date,description",
          },
        },
      ],
    };
  }

  const descriptionPrefix = typeof values.description === "string" && values.description.trim()
    ? values.description.trim()
    : "Month-end closing";
  const date = typeof values.date === "string" && values.date.trim() ? values.date.trim() : todayIsoInZone();
  return {
    summary: descriptionPrefix,
    steps: [
      {
        method: "POST",
        path: "/ledger/voucher",
        body: { date, description: `${descriptionPrefix} - accrual reversal` },
      },
      {
        method: "POST",
        path: "/ledger/voucher",
        body: { date, description: `${descriptionPrefix} - depreciation` },
      },
    ],
  };
}

export async function executeMonthEndClosingWorkflow(
  client: TripletexClient,
  spec: MonthEndClosingSpec,
  prompt: string,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const details = extractMonthEndDetails(prompt, values);
  const preview = compileMonthEndClosingPreview(spec.operation, {
    ...values,
    date: details.closeDate,
    description: `Month-end closing ${details.year}-${String(details.month).padStart(2, "0")}`,
  });
  if (dryRun) return preview;

  const artifacts: VoucherArtifact[] = [];
  const periodLabel = `${details.year}-${String(details.month).padStart(2, "0")}`;

  if (details.accrualAmount && details.accrualFromAccountNumber) {
    const accrualToAccountNumber = await resolveAccrualExpenseAccountNumber(
      client,
      details.accrualToAccountNumber,
      details.accrualFromAccountNumber,
      details.closeDate,
    );
    if (!accrualToAccountNumber) {
      throw new Error("Month-end closing could not infer accrual expense account");
    }
    const description = `Month-end closing ${periodLabel} accrual reversal`;
    const voucherId = await createBalancedVoucher(
      client,
      details.closeDate,
      description,
      accrualToAccountNumber,
      details.accrualFromAccountNumber,
      details.accrualAmount,
    );
    artifacts.push({
      voucherId,
      amount: details.accrualAmount,
      debitAccountNumber: accrualToAccountNumber,
      creditAccountNumber: details.accrualFromAccountNumber,
      date: details.closeDate,
      description,
    });
    values.__monthEndAccrualVoucherId = voucherId;
    values.__monthEndAccrualAmount = details.accrualAmount;
    values.__monthEndAccrualFromAccountNumber = details.accrualFromAccountNumber;
    values.__monthEndAccrualToAccountNumber = accrualToAccountNumber;
  }

  if (details.depreciationEntries.length > 0 || (details.depreciationAmount && details.depreciationAmount > 0)) {
    const defaultExpenseAccountFromEntries = details.depreciationEntries.find((entry) => entry.expenseAccountNumber)?.expenseAccountNumber ?? null;
    const defaultAccumulatedAccountFromEntries = details.depreciationEntries.find((entry) => entry.accumulatedAccountNumber)?.accumulatedAccountNumber ?? null;
    const accounts = await resolveDepreciationAccounts(
      client,
      defaultExpenseAccountFromEntries ?? details.depreciationExpenseAccountNumber,
      defaultAccumulatedAccountFromEntries ?? details.accumulatedDepreciationAccountNumber,
    );
    const depreciationEntries = details.depreciationEntries.length > 0
      ? details.depreciationEntries
      : [{
        label: "asset",
        amount: details.depreciationAmount ?? 0,
        assetCost: details.assetCost ?? 0,
        usefulLifeYears: details.usefulLifeYears ?? 0,
      }];
    for (const [index, entry] of depreciationEntries.entries()) {
      if (!(entry.amount > 0)) continue;
      const effectiveExpenseAccountNumber = entry.expenseAccountNumber
        ? await firstResolvableAccountNumber(client, [entry.expenseAccountNumber, accounts.expenseAccountNumber]) ?? accounts.expenseAccountNumber
        : accounts.expenseAccountNumber;
      const effectiveAccumulatedAccountNumber = entry.accumulatedAccountNumber
        ? await firstResolvableAccountNumber(client, [entry.accumulatedAccountNumber, accounts.accumulatedAccountNumber]) ?? accounts.accumulatedAccountNumber
        : accounts.accumulatedAccountNumber;
      const labelSuffix = entry.label && entry.label !== "asset" ? ` ${entry.label}` : depreciationEntries.length > 1 ? ` asset ${index + 1}` : "";
      const description = `${details.annualClosing ? "Year-end closing" : "Month-end closing"} ${periodLabel} depreciation${labelSuffix}`.slice(0, 120);
      const voucherId = await createBalancedVoucher(
        client,
        details.closeDate,
        description,
        effectiveExpenseAccountNumber,
        effectiveAccumulatedAccountNumber,
        entry.amount,
      );
      artifacts.push({
        voucherId,
        amount: entry.amount,
        debitAccountNumber: effectiveExpenseAccountNumber,
        creditAccountNumber: effectiveAccumulatedAccountNumber,
        date: details.closeDate,
        description,
        label: entry.label,
      });
      if (index === 0) {
        values.__monthEndDepreciationVoucherId = voucherId;
        values.__monthEndDepreciationAmount = entry.amount;
        values.__monthEndDepreciationExpenseAccountNumber = effectiveExpenseAccountNumber;
        values.__monthEndAccumulatedDepreciationAccountNumber = effectiveAccumulatedAccountNumber;
      }
    }
  }

  if (artifacts.length === 0) {
    throw new Error("Month-end closing prompt did not yield any actionable accrual or depreciation entries");
  }

  values.__monthEndCloseDate = details.closeDate;
  values.__monthEndYear = details.year;
  values.__monthEndMonth = details.month;
  values.__monthEndAnnualClosing = details.annualClosing;
  values.__monthEndArtifacts = artifacts;

  const steps = artifacts.flatMap((artifact) => ([
    {
      method: "POST" as const,
      path: "/ledger/voucher",
      body: { date: artifact.date, description: artifact.description },
    },
    {
      method: "GET" as const,
      path: `/ledger/voucher/${artifact.voucherId}`,
      params: { fields: "id,date,description,postings(account(number),amountGross)" },
    },
  ]));

  return {
    summary: `Month-end closing ${periodLabel}`,
    steps,
  };
}

export async function verifyMonthEndClosingOutcome(
  client: TripletexClient,
  spec: MonthEndClosingSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const recordedArtifacts = Array.isArray(values.__monthEndArtifacts)
    ? (values.__monthEndArtifacts as VoucherArtifact[])
    : [];
  const artifacts: VoucherArtifact[] = [...recordedArtifacts];
  const accrualVoucherId = Number(values.__monthEndAccrualVoucherId ?? 0);
  if (artifacts.length === 0 && accrualVoucherId > 0) {
    artifacts.push({
      voucherId: accrualVoucherId,
      amount: Number(values.__monthEndAccrualAmount ?? 0),
      debitAccountNumber: Number(values.__monthEndAccrualToAccountNumber ?? 0),
      creditAccountNumber: Number(values.__monthEndAccrualFromAccountNumber ?? 0),
      date: String(values.__monthEndCloseDate ?? ""),
      description: "accrual reversal",
    });
  }
  const depreciationVoucherId = Number(values.__monthEndDepreciationVoucherId ?? 0);
  if (artifacts.length === 0 && depreciationVoucherId > 0) {
    artifacts.push({
      voucherId: depreciationVoucherId,
      amount: Number(values.__monthEndDepreciationAmount ?? 0),
      debitAccountNumber: Number(values.__monthEndDepreciationExpenseAccountNumber ?? 0),
      creditAccountNumber: Number(values.__monthEndAccumulatedDepreciationAccountNumber ?? 0),
      date: String(values.__monthEndCloseDate ?? ""),
      description: "depreciation",
    });
  }

  if (artifacts.length === 0) {
    return { verified: false, detail: "month-end closing did not record any voucher ids", required: true };
  }

  for (const artifact of artifacts) {
    const voucher = await fetchVoucher(client, artifact.voucherId);
    if (!voucherMatches(voucher, artifact)) {
      return {
        verified: false,
        detail: `month-end ${artifact.description} voucher ${artifact.voucherId} did not match expected postings`,
        required: true,
      };
    }
  }

  return {
    verified: true,
    detail: `month-end closing verified via ${artifacts.length} returned voucher id${artifacts.length === 1 ? "" : "s"}`,
    required: true,
  };
}
