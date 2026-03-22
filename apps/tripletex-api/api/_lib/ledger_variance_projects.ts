import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type LedgerVarianceProjectsSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

type Verification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type PeriodWindow = {
  year: number;
  fromMonth: number;
  toMonth: number;
  fromStart: string;
  fromEndExclusive: string;
  toStart: string;
  toEndExclusive: string;
  topCount: number;
};

type AccountDelta = {
  accountNumber: number;
  accountName: string;
  fromAmount: number;
  toAmount: number;
  increase: number;
};

type ProjectArtifact = {
  id: number;
  accountNumber: number;
  accountName: string;
  increase: number;
  projectName: string;
};

type ProjectRecord = {
  id: number;
  name?: string;
  isInternal?: boolean;
  description?: string;
};

const POSTING_FIELDS = "id,date,amount,amountGross,amountCurrency,amountGrossCurrency,account(id,number,name,type)";
const PROJECT_FIELDS = "id,name,isInternal,description";

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
  marco: 3,
  marcos: 3,
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

const NUMBER_WORDS: Array<[RegExp, number]> = [
  [/\b(?:1|one|uno|um|en|ein|ett)\b/i, 1],
  [/\b(?:2|two|dos|deux|zwei|to)\b/i, 2],
  [/\b(?:3|three|tres|trois|drei|tre)\b/i, 3],
  [/\b(?:4|four|cuatro|quatro|quatre|vier|fire)\b/i, 4],
  [/\b(?:5|five|cinco|cinq|funf|fem)\b/i, 5],
];

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
    .replace(/\s+/g, " ")
    .trim();
}

function textContains(actual: unknown, expected: unknown): boolean {
  const actualText = normalizeText(actual);
  const expectedText = normalizeText(expected);
  if (!actualText || !expectedText) return false;
  return actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText);
}

function parseFlexibleNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function monthNameToNumber(value: string | undefined): number | null {
  if (!value) return null;
  return MONTHS[normalizeText(value)] ?? null;
}

function isoMonthStart(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const anchor = new Date(Date.UTC(year, month - 1 + delta, 1, 12, 0, 0));
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1 };
}

function parseTopCount(prompt: string, values: Record<string, unknown>): number {
  const explicit = parseFlexibleNumber(values.topCount);
  if (explicit && explicit > 0) return Math.min(10, Math.max(1, Math.trunc(explicit)));

  const accountPhrase = prompt.match(/(\d+)\s+(?:expense accounts?|accounts?|contas?|konten|comptes)/i);
  if (accountPhrase?.[1]) {
    const numeric = Number(accountPhrase[1]);
    if (Number.isInteger(numeric) && numeric > 0) return Math.min(10, numeric);
  }
  for (const [pattern, count] of NUMBER_WORDS) {
    if (pattern.test(prompt) && /\b(?:accounts?|contas?|konten|comptes|expense accounts?)\b/i.test(prompt)) {
      return count;
    }
  }
  return 3;
}

function parseWindow(prompt: string, values: Record<string, unknown>): PeriodWindow {
  const directYear = parseFlexibleNumber(values.closingYear ?? values.year);
  const directFrom = parseFlexibleNumber(values.analysisFromMonth ?? values.fromMonth);
  const directTo = parseFlexibleNumber(values.analysisToMonth ?? values.toMonth);
  const topCount = parseTopCount(prompt, values);

  if (directYear && directFrom && directTo) {
    return {
      year: Math.trunc(directYear),
      fromMonth: Math.trunc(directFrom),
      toMonth: Math.trunc(directTo),
      fromStart: isoMonthStart(Math.trunc(directYear), Math.trunc(directFrom)),
      fromEndExclusive: isoMonthStart(shiftMonth(Math.trunc(directYear), Math.trunc(directFrom), 1).year, shiftMonth(Math.trunc(directYear), Math.trunc(directFrom), 1).month),
      toStart: isoMonthStart(Math.trunc(directYear), Math.trunc(directTo)),
      toEndExclusive: isoMonthStart(shiftMonth(Math.trunc(directYear), Math.trunc(directTo), 1).year, shiftMonth(Math.trunc(directYear), Math.trunc(directTo), 1).month),
      topCount,
    };
  }

  const monthMatches = [...prompt.matchAll(/\b([A-Za-zÀ-ÿ]+)\b/g)]
    .map((match) => ({ month: monthNameToNumber(match[1]), index: match.index ?? -1 }))
    .filter((match): match is { month: number; index: number } => typeof match.month === "number");

  const uniqueMonths: number[] = [];
  for (const match of monthMatches) {
    if (!uniqueMonths.includes(match.month)) uniqueMonths.push(match.month);
  }

  const yearMatch = prompt.match(/\b(20\d{2})\b/);
  const year = yearMatch?.[1] ? Number(yearMatch[1]) : new Date().getUTCFullYear();
  const fromMonth = uniqueMonths[0] ?? 1;
  const toMonth = uniqueMonths[1] ?? Math.min(12, fromMonth + 1);
  const fromEnd = shiftMonth(year, fromMonth, 1);
  const toEnd = shiftMonth(year, toMonth, 1);
  return {
    year,
    fromMonth,
    toMonth,
    fromStart: isoMonthStart(year, fromMonth),
    fromEndExclusive: isoMonthStart(fromEnd.year, fromEnd.month),
    toStart: isoMonthStart(year, toMonth),
    toEndExclusive: isoMonthStart(toEnd.year, toEnd.month),
    topCount,
  };
}

function projectNameFor(account: AccountDelta): string {
  return `Variance ${account.accountNumber} ${account.accountName}`.slice(0, 120);
}

function projectDescriptionFor(account: AccountDelta, window: PeriodWindow): string {
  return `Expense increase from ${window.year}-${String(window.fromMonth).padStart(2, "0")} to ${window.year}-${String(window.toMonth).padStart(2, "0")}: ${roundMoney(account.increase)} NOK`;
}

function postingAmount(record: Record<string, unknown>): number {
  const numeric =
    parseFlexibleNumber(record.amount)
    ?? parseFlexibleNumber(record.amountGross)
    ?? parseFlexibleNumber(record.amountCurrency)
    ?? parseFlexibleNumber(record.amountGrossCurrency)
    ?? 0;
  return roundMoney(numeric);
}

function isExpensePosting(record: Record<string, unknown>): boolean {
  const account = toRecord(record.account);
  const type = String(account.type ?? "");
  const number = parseFlexibleNumber(account.number);
  if (type.includes("EXPENSE") || type.includes("COST")) return true;
  return number !== null && number >= 4000 && number < 9000;
}

function pushStep(steps: PlanStep[], method: PlanStep["method"], path: string, extra?: Partial<PlanStep>): void {
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

async function fetchAllPostings(
  client: TripletexClient,
  dateFrom: string,
  dateTo: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const response = await client.request("GET", "/ledger/posting", {
      params: {
        dateFrom,
        dateTo,
        from: offset,
        count: pageSize,
        fields: POSTING_FIELDS,
      },
    });
    const values = toValues(response).map((item) => toRecord(item));
    rows.push(...values);
    if (values.length < pageSize) break;
  }
  return rows;
}

function aggregateExpenses(postings: Array<Record<string, unknown>>): Map<number, { name: string; amount: number }> {
  const totals = new Map<number, { name: string; amount: number }>();
  for (const posting of postings) {
    if (!isExpensePosting(posting)) continue;
    const account = toRecord(posting.account);
    const accountNumber = parseFlexibleNumber(account.number);
    if (!accountNumber) continue;
    const key = Math.trunc(accountNumber);
    const existing = totals.get(key) ?? { name: String(account.name ?? `Account ${key}`), amount: 0 };
    existing.amount = roundMoney(existing.amount + postingAmount(posting));
    if (!existing.name && typeof account.name === "string") existing.name = account.name;
    totals.set(key, existing);
  }
  return totals;
}

function expenseMagnitude(total: number): number {
  return total < 0 ? roundMoney(-total) : roundMoney(total);
}

function rankExpenseIncrease(
  fromTotals: Map<number, { name: string; amount: number }>,
  toTotals: Map<number, { name: string; amount: number }>,
  topCount: number,
): AccountDelta[] {
  const keys = new Set<number>([...fromTotals.keys(), ...toTotals.keys()]);
  const deltas = [...keys].map((accountNumber) => {
    const fromEntry = fromTotals.get(accountNumber);
    const toEntry = toTotals.get(accountNumber);
    const fromAmount = roundMoney(fromEntry?.amount ?? 0);
    const toAmount = roundMoney(toEntry?.amount ?? 0);
    return {
      accountNumber,
      accountName: String(toEntry?.name ?? fromEntry?.name ?? `Account ${accountNumber}`),
      fromAmount,
      toAmount,
      increase: roundMoney(expenseMagnitude(toAmount) - expenseMagnitude(fromAmount)),
    } satisfies AccountDelta;
  });

  return deltas
    .filter((item) => item.increase > 0.009)
    .sort((left, right) =>
      right.increase - left.increase
      || right.toAmount - left.toAmount
      || left.accountNumber - right.accountNumber)
    .slice(0, topCount);
}

async function resolveProjectManagerId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/employee", {
    params: {
      count: 1,
      from: 0,
      fields: "id,firstName,lastName,email",
      assignableProjectManagers: true,
    },
  });
  const employee = toValues(response).map((item) => toRecord(item))[0];
  const id = parseFlexibleNumber(employee?.id);
  if (!id) {
    throw new Error("No assignable project manager available for ledger variance workflow");
  }
  return Math.trunc(id);
}

async function findExistingProject(
  client: TripletexClient,
  account: AccountDelta,
): Promise<ProjectRecord | null> {
  const name = projectNameFor(account);
  const response = await client.request("GET", "/project", {
    params: {
      count: 20,
      from: 0,
      name,
      fields: PROJECT_FIELDS,
      isClosed: false,
    },
  });
  const projects = toValues(response).map((item) => toRecord(item));
  const exact = projects.find((project) =>
    project.isInternal === true
    && textContains(project.name, name),
  );
  if (!exact) return null;
  const id = parseFlexibleNumber(exact.id);
  return id ? {
    id: Math.trunc(id),
    name: typeof exact.name === "string" ? exact.name : undefined,
    isInternal: exact.isInternal === true,
    description: typeof exact.description === "string" ? exact.description : undefined,
  } : null;
}

async function createProjectForAccount(
  client: TripletexClient,
  account: AccountDelta,
  window: PeriodWindow,
  projectManagerId: number,
): Promise<ProjectArtifact> {
  const existing = await findExistingProject(client, account);
  if (existing?.id) {
    return {
      id: existing.id,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      increase: account.increase,
      projectName: existing.name ?? projectNameFor(account),
    };
  }

  const body = {
    name: projectNameFor(account),
    startDate: todayIsoInZone(),
    isInternal: true,
    description: projectDescriptionFor(account, window),
    projectManager: { id: projectManagerId },
  };
  const response = await client.request("POST", "/project", { body });
  const created = toRecord(primaryValue(response));
  const id = parseFlexibleNumber(created.id);
  if (!id) throw new Error(`Failed to create internal project for account ${account.accountNumber}`);
  return {
    id: Math.trunc(id),
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    increase: account.increase,
    projectName: typeof created.name === "string" && created.name.trim() ? created.name : body.name,
  };
}

async function fetchProject(client: TripletexClient, id: number): Promise<ProjectRecord | null> {
  const response = await client.request("GET", `/project/${id}`, { params: { fields: PROJECT_FIELDS } });
  const record = toRecord(primaryValue(response));
  const projectId = parseFlexibleNumber(record.id);
  if (!projectId) return null;
  return {
    id: Math.trunc(projectId),
    name: typeof record.name === "string" ? record.name : undefined,
    isInternal: record.isInternal === true,
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

export function matchesLedgerVarianceProjectsWorkflow(spec: LedgerVarianceProjectsSpec): boolean {
  return spec.operation === "create" && spec.entity === "ledger_variance_projects";
}

export function compileLedgerVarianceProjectsPreview(spec: LedgerVarianceProjectsSpec, promptText?: string): ExecutionPlan {
  const values = toRecord(spec.values);
  const window = parseWindow(promptText ?? "", values);
  const steps: PlanStep[] = [];
  pushStep(steps, "GET", "/ledger/posting", {
    params: { dateFrom: window.fromStart, dateTo: window.fromEndExclusive, count: 1000, from: 0, fields: POSTING_FIELDS },
    reason: "Read first comparison period",
  });
  pushStep(steps, "GET", "/ledger/posting", {
    params: { dateFrom: window.toStart, dateTo: window.toEndExclusive, count: 1000, from: 0, fields: POSTING_FIELDS },
    reason: "Read second comparison period",
  });
  pushStep(steps, "GET", "/employee", {
    params: { count: 1, from: 0, fields: "id", assignableProjectManagers: true },
    reason: "Resolve project manager",
  });
  for (let index = 0; index < window.topCount; index += 1) {
    pushStep(steps, "POST", "/project", {
      body: {
        name: `Variance {{account_${index + 1}_number}} {{account_${index + 1}_name}}`,
        startDate: todayIsoInZone(),
        isInternal: true,
        projectManager: { id: "{{project_manager_id}}" },
      },
      reason: "Create internal investigation project",
    });
  }
  return {
    summary: `Create ${window.topCount} internal projects for the largest expense increases`,
    steps,
  };
}

export async function executeLedgerVarianceProjectsWorkflow(
  client: TripletexClient,
  spec: LedgerVarianceProjectsSpec,
  promptText: string,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const preview = compileLedgerVarianceProjectsPreview(spec, promptText);
  if (dryRun) return preview;

  const values = toRecord(spec.values);
  const window = parseWindow(promptText, values);
  const [fromPostings, toPostings] = await Promise.all([
    fetchAllPostings(client, window.fromStart, window.fromEndExclusive),
    fetchAllPostings(client, window.toStart, window.toEndExclusive),
  ]);

  const ranked = rankExpenseIncrease(
    aggregateExpenses(fromPostings),
    aggregateExpenses(toPostings),
    window.topCount,
  );
  if (ranked.length < window.topCount) {
    throw new Error(`Ledger variance workflow found only ${ranked.length} candidate expense accounts`);
  }

  const projectManagerId = await resolveProjectManagerId(client);
  const steps: PlanStep[] = [];
  pushStep(steps, "GET", "/ledger/posting", {
    params: { dateFrom: window.fromStart, dateTo: window.fromEndExclusive, count: 1000, from: 0, fields: POSTING_FIELDS },
    reason: "Read first comparison period",
  });
  pushStep(steps, "GET", "/ledger/posting", {
    params: { dateFrom: window.toStart, dateTo: window.toEndExclusive, count: 1000, from: 0, fields: POSTING_FIELDS },
    reason: "Read second comparison period",
  });
  pushStep(steps, "GET", "/employee", {
    params: { count: 1, from: 0, fields: "id,firstName,lastName,email", assignableProjectManagers: true },
    reason: "Resolve project manager",
  });

  const artifacts: ProjectArtifact[] = [];
  for (const account of ranked) {
    const artifact = await createProjectForAccount(client, account, window, projectManagerId);
    artifacts.push(artifact);
    pushStep(steps, "POST", "/project", {
      body: {
        name: artifact.projectName,
        startDate: todayIsoInZone(),
        isInternal: true,
        description: projectDescriptionFor(account, window),
        projectManager: { id: projectManagerId },
      },
      reason: `Create internal project for account ${account.accountNumber}`,
    });
    pushStep(steps, "GET", `/project/${artifact.id}`, {
      params: { fields: PROJECT_FIELDS },
      reason: "Verify created project",
    });
  }

  values.__ledgerVarianceProjects = artifacts;
  values.analysisFromMonth = window.fromMonth;
  values.analysisToMonth = window.toMonth;
  values.closingYear = window.year;
  values.topCount = window.topCount;

  return {
    summary: `Create ${artifacts.length} internal projects for the largest expense increases`,
    steps,
  };
}

export async function verifyLedgerVarianceProjectsOutcome(
  client: TripletexClient,
  spec: LedgerVarianceProjectsSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const window = parseWindow("", values);
  const artifacts = Array.isArray(values.__ledgerVarianceProjects)
    ? values.__ledgerVarianceProjects
        .map((item) => toRecord(item))
        .map((item) => ({
          id: parseFlexibleNumber(item.id) ? Math.trunc(parseFlexibleNumber(item.id) ?? 0) : 0,
          accountNumber: parseFlexibleNumber(item.accountNumber) ? Math.trunc(parseFlexibleNumber(item.accountNumber) ?? 0) : 0,
          accountName: String(item.accountName ?? ""),
          increase: parseFlexibleNumber(item.increase) ?? 0,
          projectName: String(item.projectName ?? ""),
        }))
        .filter((item) => item.id > 0 && item.accountNumber > 0)
    : [];

  if (artifacts.length === 0) {
    return {
      verified: false,
      detail: "ledger variance workflow did not record created project ids",
      required: true,
    };
  }

  const [fromPostings, toPostings] = await Promise.all([
    fetchAllPostings(client, window.fromStart, window.fromEndExclusive),
    fetchAllPostings(client, window.toStart, window.toEndExclusive),
  ]);
  const expected = rankExpenseIncrease(
    aggregateExpenses(fromPostings),
    aggregateExpenses(toPostings),
    window.topCount,
  );
  if (expected.length < Math.min(window.topCount, artifacts.length)) {
    return {
      verified: false,
      detail: `ledger variance verification found only ${expected.length} ranked expense accounts`,
      required: true,
    };
  }
  const expectedAccountNumbers = expected.slice(0, artifacts.length).map((item) => item.accountNumber).sort((a, b) => a - b);
  const actualAccountNumbers = artifacts.map((item) => item.accountNumber).sort((a, b) => a - b);
  if (expectedAccountNumbers.join(",") !== actualAccountNumbers.join(",")) {
    return {
      verified: false,
      detail: `ledger variance projects do not match ranked expense accounts (expected ${expectedAccountNumbers.join(", ")}, got ${actualAccountNumbers.join(", ")})`,
      required: true,
    };
  }

  for (const artifact of artifacts) {
    const project = await fetchProject(client, artifact.id);
    if (!project) {
      return { verified: false, detail: `project ${artifact.id} not found`, required: true };
    }
    if (project.isInternal !== true) {
      return { verified: false, detail: `project ${artifact.id} is not internal`, required: true };
    }
    if (!textContains(project.name, String(artifact.accountNumber)) || !textContains(project.name, artifact.accountName)) {
      return { verified: false, detail: `project ${artifact.id} name does not reference the selected account`, required: true };
    }
  }

  return {
    verified: true,
    detail: `ledger variance projects verified (${artifacts.length})`,
    required: true,
  };
}
