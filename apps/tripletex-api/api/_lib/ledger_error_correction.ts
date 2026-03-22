import { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";
import type { GatewayLanguageModelOptions } from "@ai-sdk/gateway";
import { z } from "zod";

import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type LedgerErrorCorrectionSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;
type Verification = { verified: boolean; detail: string; required: boolean };
type VoucherRecord = Record<string, unknown>;

type CorrectionArtifact =
  | {
      action: "reverse_voucher";
      sourceVoucherId: number;
      createdVoucherId?: number;
      date: string;
      reason: string;
    }
  | {
      action: "post_adjustment";
      sourceVoucherId: number;
      createdVoucherId?: number;
      date: string;
      reason: string;
      postings: Array<{ accountNumber: number; amount: number }>;
    };

type AnalyzerIssue = {
  voucherId: number;
  confidence: number;
  issueType: string;
  reason: string;
  action: "reverse_voucher" | "post_adjustment";
  correctionDate?: string;
  postings?: Array<{ accountNumber: number; amount: number; description?: string }>;
};

type Analyzer = (
  prompt: string,
  period: PeriodWindow,
  vouchers: VoucherRecord[],
  expectedCount: number,
) => Promise<{ issues: AnalyzerIssue[] }>;

type IssueHint =
  | {
      kind: "wrong_account";
      sourceAccount: number;
      targetAccount: number;
      amount: number;
    }
  | {
      kind: "duplicate_voucher";
    };

type PeriodWindow = {
  year: number;
  fromMonth: number;
  toMonth: number;
  dateFrom: string;
  dateToExclusive: string;
  correctionDate: string;
};

const analysisSchema = z.object({
  issues: z.array(z.object({
    voucherId: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    issueType: z.string().min(1).max(80),
    reason: z.string().min(1).max(240),
    action: z.enum(["reverse_voucher", "post_adjustment"]),
    correctionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    postings: z.array(z.object({
      accountNumber: z.number().int().positive(),
      amount: z.number().refine((value) => Number.isFinite(value) && Math.abs(value) > 0.0001),
      description: z.string().max(120).optional(),
    })).max(8).optional(),
  })).max(8),
});

const VOUCHER_FIELDS = [
  "id",
  "date",
  "description",
  "postings(id,row,amountGross,amountGrossCurrency,account(number,name),customer(id,name,organizationNumber),supplier(id,name,organizationNumber),project(id,name),department(id,name),product(id,name,number),vatType(id,name))",
].join(",");

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

function toValues(value: unknown): VoucherRecord[] {
  const record = toRecord(value);
  if (Array.isArray(record.values)) {
    return record.values.filter((item): item is VoucherRecord => Boolean(item) && typeof item === "object");
  }
  const single = primaryValue(value);
  return single && typeof single === "object" && !Array.isArray(single) ? [single as VoucherRecord] : [];
}

function normalized(value: unknown): string {
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

function parseFlexibleNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalizedValue = raw
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function monthNameToNumber(value: string | undefined): number | null {
  if (!value) return null;
  return MONTHS[normalized(value)] ?? null;
}

function isoMonthStart(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const anchor = new Date(Date.UTC(year, month - 1 + delta, 1, 12, 0, 0));
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1 };
}

function isoLastDayOfMonth(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 0, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function parseExpectedCount(prompt: string): number {
  const numeric = prompt.match(/\b(\d{1,2})\s+(?:errors?|feil|fehler|erros?|erreurs?)\b/i)?.[1];
  const parsed = Number(numeric ?? "4");
  if (Number.isInteger(parsed) && parsed > 0) return Math.min(8, parsed);
  return 4;
}

function parsePeriod(prompt: string): PeriodWindow {
  const yearMatch = prompt.match(/\b(20\d{2})\b/);
  const year = yearMatch?.[1] ? Number(yearMatch[1]) : new Date().getUTCFullYear();
  const monthMatches = [...prompt.matchAll(/\b([A-Za-zÀ-ÿ]+)\b/g)]
    .map((match) => monthNameToNumber(match[1]))
    .filter((month): month is number => Boolean(month));
  const uniqueMonths: number[] = [];
  for (const month of monthMatches) {
    if (!uniqueMonths.includes(month)) uniqueMonths.push(month);
  }
  const fromMonth = uniqueMonths[0] ?? 1;
  const toMonth = uniqueMonths[1] ?? uniqueMonths[0] ?? 2;
  const fromStart = isoMonthStart(year, fromMonth);
  const endShift = shiftMonth(year, toMonth, 1);
  const correctionDate = isoLastDayOfMonth(year, toMonth);
  return {
    year,
    fromMonth,
    toMonth,
    dateFrom: fromStart,
    dateToExclusive: isoMonthStart(endShift.year, endShift.month),
    correctionDate,
  };
}

function selectAuditModel(): string {
  return process.env.TRIPLETEX_LEDGER_AUDIT_MODEL?.trim()
    || process.env.TRIPLETEX_MODEL_REASONING?.trim()
    || "openai/gpt-5.4";
}

function auditFallbackModels(primary: string): string[] {
  const configured = process.env.TRIPLETEX_GATEWAY_FALLBACK_MODELS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const defaults = ["google/gemini-3.1-pro-preview", "anthropic/claude-sonnet-4.6", "openai/gpt-5.2"];
  return [...configured, ...defaults].filter((model, index, all) => model !== primary && all.indexOf(model) === index);
}

function auditTimeoutMs(): number {
  const raw = Number(process.env.TRIPLETEX_LEDGER_AUDIT_TIMEOUT_MS || process.env.TRIPLETEX_LLM_TIMEOUT_MS || "18000");
  if (!Number.isFinite(raw)) return 18000;
  return Math.max(3000, Math.min(30000, Math.round(raw)));
}

async function generateAnalysisWithTimeout(prompt: string): Promise<{ issues: AnalyzerIssue[] }> {
  const model = selectAuditModel();
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = auditTimeoutMs();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`Ledger audit timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const generated = await Promise.race([
      generateObject({
        model: gateway(model),
        schema: analysisSchema,
        temperature: 0,
        maxRetries: 0,
        abortSignal: controller.signal,
        providerOptions: {
          gateway: { models: auditFallbackModels(model) } satisfies GatewayLanguageModelOptions,
        },
        prompt,
      }),
      timeoutPromise,
    ]);
    return (generated as { object: { issues: AnalyzerIssue[] } }).object;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function compactVoucher(voucher: VoucherRecord): Record<string, unknown> {
  return {
    id: Number(voucher.id ?? 0),
    date: String(voucher.date ?? ""),
    description: String(voucher.description ?? ""),
    postings: Array.isArray(voucher.postings)
      ? voucher.postings.map((posting) => {
          const record = toRecord(posting);
          const account = toRecord(record.account);
          const customer = toRecord(record.customer);
          const supplier = toRecord(record.supplier);
          const project = toRecord(record.project);
          return {
            row: Number(record.row ?? 0),
            amountGross: parseFlexibleNumber(record.amountGross),
            accountNumber: parseFlexibleNumber(account.number),
            accountName: String(account.name ?? ""),
            customerName: String(customer.name ?? ""),
            supplierName: String(supplier.name ?? ""),
            projectName: String(project.name ?? ""),
          };
        })
      : [],
  };
}

function buildAnalysisPrompt(
  prompt: string,
  period: PeriodWindow,
  vouchers: VoucherRecord[],
  expectedCount: number,
): string {
  const candidateVouchers = selectCandidateVouchers(prompt, vouchers);
  const compact = candidateVouchers.slice(0, 160).map((voucher) => JSON.stringify(compactVoucher(voucher))).join("\n");
  const hints = parseIssueHints(prompt).map((hint) => {
    if (hint.kind === "wrong_account") {
      return `wrong_account: ${hint.sourceAccount} -> ${hint.targetAccount}, amount ${hint.amount}`;
    }
    return "duplicate_voucher";
  });
  return [
    "You audit Tripletex ledger vouchers and propose exact corrections.",
    `Find up to ${expectedCount} obvious errors in the supplied vouchers.`,
    "Prefer only high-confidence issues.",
    "Preferred correction types:",
    "- reverse_voucher for duplicates or entirely wrong vouchers",
    "- post_adjustment for reclassification or missing VAT corrections",
    "For post_adjustment, postings must balance to zero. Positive amount = debit, negative amount = credit.",
    "Ignore vouchers that already look like corrections or reversals.",
    "Each reason should be a short audit note suitable for a voucher description.",
    "",
    `Task prompt: ${prompt}`,
    `Period: ${period.dateFrom} to ${period.dateToExclusive} (exclusive end), correction date ${period.correctionDate}`,
    hints.length > 0 ? `Explicit issue hints: ${hints.join("; ")}` : "",
    "",
    "Voucher summaries (candidate subset when hints were detected):",
    compact || "(none)",
  ].join("\n");
}

async function defaultAnalyzer(
  prompt: string,
  period: PeriodWindow,
  vouchers: VoucherRecord[],
  expectedCount: number,
): Promise<{ issues: AnalyzerIssue[] }> {
  return generateAnalysisWithTimeout(buildAnalysisPrompt(prompt, period, vouchers, expectedCount));
}

async function fetchVoucher(client: TripletexClient, voucherId: number): Promise<VoucherRecord> {
  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,date,description,postings(id,row,amountGross,account(number,name))" },
  });
  return toRecord(primaryValue(response));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function parseIssueHints(prompt: string): IssueHint[] {
  const hints: IssueHint[] = [];
  const primaryPattern = /(?:konto|account|compte)\s*(\d{4,6})\s*(?:instead of|i stedet for|au lieu de|statt)\s*(\d{4,6})[^\n.]{0,120}?(?:betrag|amount|bel[oø]p|montant)\s*(\d[\d .,'’]*)/gi;
  const reversedPattern = /(?:betrag|amount|bel[oø]p|montant)\s*(\d[\d .,'’]*)[^\n.]{0,120}?(?:konto|account|compte)\s*(\d{4,6})\s*(?:instead of|i stedet for|au lieu de|statt)\s*(\d{4,6})/gi;

  let match: RegExpExecArray | null;
  while ((match = primaryPattern.exec(prompt)) !== null) {
    const sourceAccount = parseFlexibleNumber(match[1]);
    const targetAccount = parseFlexibleNumber(match[2]);
    const amount = parseFlexibleNumber(match[3]);
    if (!sourceAccount || !targetAccount || !amount || amount <= 0) continue;
    hints.push({
      kind: "wrong_account",
      sourceAccount: Math.trunc(sourceAccount),
      targetAccount: Math.trunc(targetAccount),
      amount: roundMoney(Math.abs(amount)),
    });
  }

  while ((match = reversedPattern.exec(prompt)) !== null) {
    const amount = parseFlexibleNumber(match[1]);
    const sourceAccount = parseFlexibleNumber(match[2]);
    const targetAccount = parseFlexibleNumber(match[3]);
    if (!sourceAccount || !targetAccount || !amount || amount <= 0) continue;
    hints.push({
      kind: "wrong_account",
      sourceAccount: Math.trunc(sourceAccount),
      targetAccount: Math.trunc(targetAccount),
      amount: roundMoney(Math.abs(amount)),
    });
  }

  if (/\b(?:duplicate voucher|duplicate entry|doppelter beleg|duplikat bilag|duplisert bilag|double entry)\b/i.test(prompt)) {
    hints.push({ kind: "duplicate_voucher" });
  }

  return hints.filter((hint, index, all) => {
    if (hint.kind === "duplicate_voucher") {
      return all.findIndex((candidate) => candidate.kind === "duplicate_voucher") === index;
    }
    return all.findIndex((candidate) => candidate.kind === "wrong_account"
      && candidate.sourceAccount === hint.sourceAccount
      && candidate.targetAccount === hint.targetAccount
      && nearlyEqual(candidate.amount, hint.amount)) === index;
  });
}

function voucherPostingRows(voucher: VoucherRecord): Array<Record<string, unknown>> {
  return Array.isArray(voucher.postings)
    ? voucher.postings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function findWrongAccountMatch(
  voucher: VoucherRecord,
  hint: Extract<IssueHint, { kind: "wrong_account" }>,
): { voucherId: number; postingAmount: number } | null {
  const voucherId = Number(voucher.id ?? 0);
  if (voucherId <= 0) return null;
  for (const posting of voucherPostingRows(voucher)) {
    const accountNumber = parseFlexibleNumber(toRecord(posting.account).number);
    const amountGross = parseFlexibleNumber(posting.amountGross);
    if (accountNumber === hint.sourceAccount && amountGross !== null && nearlyEqual(Math.abs(amountGross), hint.amount)) {
      return { voucherId, postingAmount: roundMoney(amountGross) };
    }
  }
  return null;
}

function postingSignature(voucher: VoucherRecord): string {
  return JSON.stringify(
    voucherPostingRows(voucher)
      .map((posting) => {
        const accountNumber = parseFlexibleNumber(toRecord(posting.account).number) ?? 0;
        const amountGross = Math.abs(parseFlexibleNumber(posting.amountGross) ?? 0);
        return `${Math.trunc(accountNumber)}:${roundMoney(amountGross)}`;
      })
      .sort(),
  );
}

function findDuplicateVoucherIds(vouchers: VoucherRecord[]): number[] {
  const groups = new Map<string, VoucherRecord[]>();
  for (const voucher of vouchers) {
    const voucherId = Number(voucher.id ?? 0);
    if (voucherId <= 0) continue;
    const key = [
      String(voucher.date ?? ""),
      normalized(voucher.description),
      postingSignature(voucher),
    ].join("|");
    const bucket = groups.get(key) ?? [];
    bucket.push(voucher);
    groups.set(key, bucket);
  }

  const duplicates: number[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((left, right) => Number(left.id ?? 0) - Number(right.id ?? 0));
    for (let index = 1; index < sorted.length; index += 1) {
      const voucherId = Number(sorted[index]?.id ?? 0);
      if (voucherId > 0) duplicates.push(voucherId);
    }
  }
  return duplicates;
}

function buildDeterministicIssues(
  prompt: string,
  period: PeriodWindow,
  vouchers: VoucherRecord[],
): AnalyzerIssue[] {
  const issues: AnalyzerIssue[] = [];
  const hints = parseIssueHints(prompt);
  const duplicateVoucherIds = hints.some((hint) => hint.kind === "duplicate_voucher")
    ? findDuplicateVoucherIds(vouchers)
    : [];

  for (const hint of hints) {
    if (hint.kind === "wrong_account") {
      const matches = vouchers
        .map((voucher) => findWrongAccountMatch(voucher, hint))
        .filter((match): match is { voucherId: number; postingAmount: number } => Boolean(match));
      if (matches.length !== 1) continue;
      const match = matches[0]!;
      const sign = match.postingAmount >= 0 ? 1 : -1;
      issues.push({
        voucherId: match.voucherId,
        confidence: 0.99,
        issueType: "wrong_account",
        reason: `Reclassify ${hint.amount} from ${hint.sourceAccount} to ${hint.targetAccount}`,
        action: "post_adjustment",
        correctionDate: period.correctionDate,
        postings: [
          { accountNumber: hint.targetAccount, amount: roundMoney(sign * hint.amount) },
          { accountNumber: hint.sourceAccount, amount: roundMoney(-sign * hint.amount) },
        ],
      });
      continue;
    }

    for (const voucherId of duplicateVoucherIds) {
      if (issues.some((issue) => issue.voucherId === voucherId)) continue;
      issues.push({
        voucherId,
        confidence: 0.96,
        issueType: "duplicate_voucher",
        reason: "Duplicate voucher",
        action: "reverse_voucher",
        correctionDate: period.correctionDate,
      });
    }
  }

  return issues;
}

function selectCandidateVouchers(prompt: string, vouchers: VoucherRecord[]): VoucherRecord[] {
  const hints = parseIssueHints(prompt);
  if (hints.length === 0) return vouchers;
  const ids = new Set<number>();
  for (const hint of hints) {
    if (hint.kind === "wrong_account") {
      for (const voucher of vouchers) {
        const match = findWrongAccountMatch(voucher, hint);
        if (match) ids.add(match.voucherId);
      }
      continue;
    }
    for (const voucherId of findDuplicateVoucherIds(vouchers)) ids.add(voucherId);
  }
  if (ids.size === 0) return vouchers;
  const selected = vouchers.filter((voucher) => ids.has(Number(voucher.id ?? 0)));
  return selected.length > 0 ? selected : vouchers;
}

async function fetchAllVouchers(client: TripletexClient, period: PeriodWindow): Promise<VoucherRecord[]> {
  const count = 200;
  const maxPages = 6;
  const vouchers: VoucherRecord[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.request("GET", "/ledger/voucher", {
      params: {
        dateFrom: period.dateFrom,
        dateTo: period.dateToExclusive,
        count,
        from: page * count,
        fields: VOUCHER_FIELDS,
      },
    });
    const batch = toValues(response);
    vouchers.push(...batch);
    if (batch.length < count) break;
  }
  return vouchers;
}

async function resolveAccountIds(
  client: TripletexClient,
  postings: Array<{ accountNumber: number; amount: number; description?: string }>,
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = [];
  for (let index = 0; index < postings.length; index += 1) {
    const posting = postings[index]!;
    const response = await client.request("GET", "/ledger/account", {
      params: { number: String(posting.accountNumber), count: 1, from: 0, fields: "id,number,name" },
    });
    const account = toRecord(toValues(response)[0]);
    const accountId = Number(account.id ?? 0);
    if (accountId <= 0) {
      throw new Error(`Ledger correction account ${posting.accountNumber} could not be resolved`);
    }
    resolved.push({
      row: index + 1,
      account: { id: accountId },
      amountGross: roundMoney(posting.amount),
      amountGrossCurrency: roundMoney(posting.amount),
    });
  }
  return resolved;
}

export function matchesLedgerErrorCorrectionWorkflow(spec: LedgerErrorCorrectionSpec): boolean {
  return spec.operation === "create" && spec.entity === "ledger_error_correction";
}

export function compileLedgerErrorCorrectionPreview(spec: LedgerErrorCorrectionSpec): ExecutionPlan {
  const values = toRecord(spec.values);
  const prompt = String(values.__prompt ?? values.description ?? "Audit general ledger");
  const period = parsePeriod(prompt);
  return {
    summary: "Audit ledger vouchers and correct detected errors",
    steps: [
      {
        method: "GET",
        path: "/ledger/voucher",
        params: {
          dateFrom: period.dateFrom,
          dateTo: period.dateToExclusive,
          count: 200,
          from: 0,
          fields: VOUCHER_FIELDS,
        },
      },
      {
        method: "PUT",
        path: "/ledger/voucher/{{voucher_id}}/:reverse",
        params: { date: period.correctionDate, description: "Audit correction" },
      },
      {
        method: "POST",
        path: "/ledger/voucher",
        body: {
          date: period.correctionDate,
          description: "Audit correction voucher",
          postings: [
            { row: 1, amountGross: 100, amountGrossCurrency: 100, account: { id: 1 } },
            { row: 2, amountGross: -100, amountGrossCurrency: -100, account: { id: 2 } },
          ],
        },
      },
    ],
  };
}

export async function executeLedgerErrorCorrectionWorkflow(
  client: TripletexClient,
  spec: LedgerErrorCorrectionSpec,
  prompt: string,
  dryRun: boolean,
  analyzer: Analyzer = defaultAnalyzer,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  values.__prompt = prompt;
  const preview = compileLedgerErrorCorrectionPreview(spec);
  if (dryRun) return preview;

  const period = parsePeriod(prompt);
  const expectedCount = parseExpectedCount(prompt);
  const vouchers = (await fetchAllVouchers(client, period)).filter((voucher) => {
    const description = normalized(voucher.description);
    return !description.includes("audit correction") && !description.includes("returned payment reversal");
  });
  if (vouchers.length === 0) {
    throw new Error("No vouchers found in the requested ledger correction period");
  }

  const deterministicIssues = buildDeterministicIssues(prompt, period, vouchers);
  const remainingCount = Math.max(0, expectedCount - deterministicIssues.length);
  const analysis = remainingCount > 0
    ? await analyzer(prompt, period, vouchers, remainingCount)
    : { issues: [] };
  const issues = [
    ...deterministicIssues,
    ...(analysis.issues ?? [])
    .filter((issue) => Number.isFinite(issue.voucherId) && issue.voucherId > 0 && Number.isFinite(issue.confidence) && issue.confidence >= 0.55)
    .filter((issue) => !deterministicIssues.some((existing) => existing.voucherId === issue.voucherId))
    .slice(0, remainingCount),
  ].slice(0, expectedCount);
  if (issues.length < expectedCount) {
    throw new Error(`Ledger audit found only ${issues.length}/${expectedCount} high-confidence corrections`);
  }

  const steps: PlanStep[] = [
    {
      method: "GET",
      path: "/ledger/voucher",
      params: {
        dateFrom: period.dateFrom,
        dateTo: period.dateToExclusive,
        count: 200,
        from: 0,
        fields: VOUCHER_FIELDS,
      },
    },
  ];
  const artifacts: CorrectionArtifact[] = [];

  for (const issue of issues) {
    const correctionDate = issue.correctionDate && /^\d{4}-\d{2}-\d{2}$/.test(issue.correctionDate)
      ? issue.correctionDate
      : period.correctionDate;
    if (issue.action === "reverse_voucher") {
      const params = {
        date: correctionDate,
        description: `Audit correction for voucher ${issue.voucherId}: ${issue.reason}`.slice(0, 250),
      };
      const response = await client.request("PUT", `/ledger/voucher/${issue.voucherId}/:reverse`, {
        body: params,
      });
      const createdVoucherId = Number(toRecord(primaryValue(response)).id ?? 0) || undefined;
      artifacts.push({
        action: "reverse_voucher",
        sourceVoucherId: issue.voucherId,
        createdVoucherId,
        date: correctionDate,
        reason: issue.reason,
      });
      steps.push({
        method: "PUT",
        path: `/ledger/voucher/${issue.voucherId}/:reverse`,
        body: params,
      });
      continue;
    }

    const postings = issue.postings ?? [];
    if (postings.length < 2) {
      throw new Error(`Ledger audit proposed an unbalanced adjustment for voucher ${issue.voucherId}`);
    }
    const total = roundMoney(postings.reduce((sum, posting) => sum + posting.amount, 0));
    if (!nearlyEqual(total, 0)) {
      throw new Error(`Ledger audit produced a non-balanced adjustment for voucher ${issue.voucherId}`);
    }
    const resolvedPostings = await resolveAccountIds(client, postings);
    const body = {
      date: correctionDate,
      description: `Audit correction for voucher ${issue.voucherId}: ${issue.reason}`.slice(0, 250),
      postings: resolvedPostings,
    };
    const response = await client.request("POST", "/ledger/voucher", { body });
    const createdVoucherId = Number(toRecord(primaryValue(response)).id ?? 0) || undefined;
    artifacts.push({
      action: "post_adjustment",
      sourceVoucherId: issue.voucherId,
      createdVoucherId,
      date: correctionDate,
      reason: issue.reason,
      postings: postings.map((posting) => ({ accountNumber: posting.accountNumber, amount: roundMoney(posting.amount) })),
    });
    steps.push({ method: "POST", path: "/ledger/voucher", body, saveAs: "correctionVoucher" });
  }

  values.__ledgerCorrectionArtifacts = artifacts;
  values.__ledgerCorrectionExpectedCount = expectedCount;

  return {
    summary: `Audit ledger vouchers and correct ${expectedCount} errors`,
    steps,
  };
}

export async function verifyLedgerErrorCorrectionOutcome(
  client: TripletexClient,
  spec: LedgerErrorCorrectionSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const artifacts = Array.isArray(values.__ledgerCorrectionArtifacts)
    ? values.__ledgerCorrectionArtifacts.map((item) => toRecord(item))
    : [];
  const expectedCount = Number(values.__ledgerCorrectionExpectedCount ?? 0);
  if (expectedCount > 0 && artifacts.length < expectedCount) {
    return { verified: false, detail: `only ${artifacts.length}/${expectedCount} correction artifacts recorded`, required: true };
  }
  if (artifacts.length === 0) {
    return { verified: false, detail: "ledger correction artifacts missing", required: true };
  }

  for (const artifact of artifacts) {
    const createdVoucherId = Number(artifact.createdVoucherId ?? 0);
    if (createdVoucherId <= 0) {
      return { verified: false, detail: "ledger correction did not return created voucher ids", required: true };
    }
    const voucher = await fetchVoucher(client, createdVoucherId);
    const description = String(voucher.description ?? "");
    if (!normalized(description).includes("audit correction")) {
      return { verified: false, detail: `voucher ${createdVoucherId} missing audit note description`, required: true };
    }
    if (artifact.action === "post_adjustment") {
      const expectedPostings = Array.isArray(artifact.postings) ? artifact.postings.map((item) => toRecord(item)) : [];
      const actualPostings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
      for (const expectedPosting of expectedPostings) {
        const accountNumber = Number(expectedPosting.accountNumber ?? 0);
        const amount = Number(expectedPosting.amount ?? 0);
        const matched = actualPostings.some((posting) => {
          const actualAccountNumber = Number(toRecord(posting.account).number ?? 0);
          const actualAmount = parseFlexibleNumber(posting.amountGross);
          return actualAccountNumber === accountNumber && actualAmount !== null && nearlyEqual(actualAmount, amount);
        });
        if (!matched) {
          return { verified: false, detail: `adjustment voucher ${createdVoucherId} missing expected posting ${accountNumber}/${amount}`, required: true };
        }
      }
    }
  }

  return { verified: true, detail: `ledger correction verified via ${artifacts.length} created audit vouchers`, required: true };
}
