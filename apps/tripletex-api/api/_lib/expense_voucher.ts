import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";
import type { TaskOperation, TaskSpec } from "./task_spec.js";

type Verification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type ExpenseVoucherSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

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
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalized(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function textMatches(actual: unknown, expected: unknown): boolean {
  const left = normalized(actual);
  const right = normalized(expected);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
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
  return { expenseAmount, vatAmount };
}

function defaultExpenseAccountNumber(values: Record<string, unknown>): number {
  const label = normalized(values.description ?? values.name);
  if (/(overnatting|hotell|hotel|lodging|accommodation|reise|travel|flybillett|flight|taxi|transport)/i.test(label)) return 7140;
  if (/(kaffe|coffee|cafe|meeting|mote|møte|meal|restaurant|representation)/i.test(label)) return 7350;
  return 6550;
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
    params: { number: String(number), count: 1, from: 0, fields: "id,number,name" },
  });
  const account = toRecord(primaryValue(response));
  const id = Number(account.id ?? 0);
  if (id <= 0) throw new Error(`Ledger account ${number} could not be resolved`);
  return id;
}

async function resolveBalanceAccount(
  client: TripletexClient,
): Promise<{ id: number; number: number }> {
  for (const candidate of [1920, 2400]) {
    try {
      const id = await resolveAccountId(client, candidate);
      return { id, number: candidate };
    } catch {
      continue;
    }
  }
  const response = await client.request("GET", "/ledger/account", {
    params: { isBalanceAccount: true, count: 10, from: 0, fields: "id,number,name" },
  });
  const record = toRecord(primaryValue(response));
  const id = Number(record.id ?? 0);
  const number = Number(record.number ?? 0);
  if (id <= 0 || number <= 0) throw new Error("Unable to resolve a balance account for expense voucher");
  return { id, number };
}

async function ensureDepartmentId(client: TripletexClient, values: Record<string, unknown>): Promise<number | null> {
  const requestedName = String(values.departmentName ?? "").trim();
  if (!requestedName) return null;
  const response = await client.request("GET", "/department", {
    params: { count: 100, from: 0, fields: "id,name" },
  });
  const existing = toValues(response)
    .map((item) => toRecord(item))
    .find((item) => textMatches(item.name, requestedName));
  const existingId = Number(existing?.id ?? 0);
  if (existingId > 0) return existingId;
  try {
    const created = await client.request("POST", "/department", { body: { name: requestedName } });
    const createdId = Number(toRecord(primaryValue(created)).id ?? 0);
    if (createdId > 0) return createdId;
  } catch {
    // Fall back to no department if the tenant rejects department creation.
  }
  return null;
}

export function matchesExpenseVoucherWorkflow(spec: ExpenseVoucherSpec): boolean {
  const values = toRecord(spec.values);
  return spec.entity === "voucher"
    && spec.operation === "create"
    && values.receiptExpense === true;
}

export function compileExpenseVoucherPreview(
  op: TaskOperation,
  rawValues: Record<string, unknown>,
): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List expense vouchers",
      steps: [{ method: "GET", path: "/ledger/voucher", params: { dateFrom: todayIsoInZone(), dateTo: todayIsoInZone(), count: 20, from: 0 } }],
    };
  }

  const values = toRecord(rawValues);
  const amount = Math.abs(toNumber(values.amount) ?? 0);
  const accountNumber = Math.trunc(toNumber(values.accountNumber) ?? defaultExpenseAccountNumber(values));
  const vatRate = toNumber(values.vatRate);
  const { expenseAmount, vatAmount } = computeVoucherAmounts(amount, vatRate);
  const vatAccountNumber = vatAmount > 0 && vatRate !== null ? vatAccountNumberForRate(vatRate) : null;
  const description = typeof values.description === "string" && values.description.trim()
    ? values.description.trim()
    : typeof values.name === "string" && values.name.trim()
      ? values.name.trim()
      : "Receipt expense";

  const postings: Array<Record<string, unknown>> = [
    {
      row: 1,
      account: { id: "{{expenseAccount_id}}" },
      amountGross: expenseAmount,
      amountGrossCurrency: expenseAmount,
      ...(values.departmentName ? { department: { id: "{{department_id}}" } } : {}),
    },
  ];
  if (vatAmount > 0 && vatAccountNumber) {
    postings.push({
      row: postings.length + 1,
      account: { id: "{{vatAccount_id}}" },
      amountGross: vatAmount,
      amountGrossCurrency: vatAmount,
    });
  }
  postings.push({
    row: postings.length + 1,
    account: { id: "{{balanceAccount_id}}" },
    amountGross: -roundMoney(amount),
    amountGrossCurrency: -roundMoney(amount),
  });

  const steps: PlanStep[] = [];
  if (values.departmentName) {
    pushStep(steps, "GET", "/department", { params: { count: 100, from: 0, fields: "id,name" } });
    pushStep(steps, "POST", "/department", { body: { name: values.departmentName } });
  }
  pushStep(steps, "GET", "/ledger/account", {
    params: { number: String(accountNumber), count: 1, from: 0, fields: "id,number,name" },
    saveAs: "expenseAccount",
  });
  if (vatAccountNumber) {
    pushStep(steps, "GET", "/ledger/account", {
      params: { number: String(vatAccountNumber), count: 1, from: 0, fields: "id,number,name" },
      saveAs: "vatAccount",
    });
  }
  pushStep(steps, "GET", "/ledger/account", {
    params: { isBalanceAccount: true, count: 1, from: 0, fields: "id,number,name" },
    saveAs: "balanceAccount",
  });
  pushStep(steps, "POST", "/ledger/voucher", {
    body: {
      date: typeof values.date === "string" && values.date.trim() ? values.date.trim() : todayIsoInZone(),
      description,
      postings,
    },
    saveAs: "voucher",
  });

  return {
    summary: `Register receipt expense ${description}`,
    steps,
  };
}

export async function executeExpenseVoucherWorkflow(
  client: TripletexClient,
  spec: ExpenseVoucherSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileExpenseVoucherPreview(spec.operation, values);
  if (dryRun || spec.operation !== "create") return preview;

  const grossAmount = Math.abs(toNumber(values.amount) ?? 0);
  if (!(grossAmount > 0)) {
    throw new Error("Expense voucher workflow requires a positive amount");
  }

  const expenseAccountNumber = Math.trunc(toNumber(values.accountNumber) ?? defaultExpenseAccountNumber(values));
  const vatRate = toNumber(values.vatRate);
  const { expenseAmount, vatAmount } = computeVoucherAmounts(grossAmount, vatRate);
  const vatAccountNumber = vatAmount > 0 && vatRate !== null ? vatAccountNumberForRate(vatRate) : null;
  const expenseAccountId = await resolveAccountId(client, expenseAccountNumber);
  const vatAccountId = vatAmount > 0 && vatAccountNumber ? await resolveAccountId(client, vatAccountNumber) : null;
  const balanceAccount = await resolveBalanceAccount(client);
  const departmentId = await ensureDepartmentId(client, values);

  const description = typeof values.description === "string" && values.description.trim()
    ? values.description.trim()
    : typeof values.name === "string" && values.name.trim()
      ? values.name.trim()
      : "Receipt expense";
  const voucherDate = typeof values.date === "string" && values.date.trim()
    ? values.date.trim()
    : todayIsoInZone();

  const postings: Array<Record<string, unknown>> = [
    {
      row: 1,
      account: { id: expenseAccountId },
      amountGross: expenseAmount,
      amountGrossCurrency: expenseAmount,
      ...(departmentId ? { department: { id: departmentId } } : {}),
    },
  ];
  if (vatAmount > 0 && vatAccountId) {
    postings.push({
      row: postings.length + 1,
      account: { id: vatAccountId },
      amountGross: vatAmount,
      amountGrossCurrency: vatAmount,
    });
  }
  postings.push({
    row: postings.length + 1,
    account: { id: balanceAccount.id },
    amountGross: -roundMoney(grossAmount),
    amountGrossCurrency: -roundMoney(grossAmount),
  });

  let created: unknown;
  try {
    created = await client.request("POST", "/ledger/voucher", {
      body: {
        date: voucherDate,
        description,
        postings,
      },
    });
  } catch (error) {
    if (!(error instanceof TripletexError) || !departmentId || error.statusCode !== 422) {
      throw error;
    }
    created = await client.request("POST", "/ledger/voucher", {
      body: {
        date: voucherDate,
        description,
        postings: postings.map((posting, index) => (index === 0 ? { ...posting, department: undefined } : posting)),
      },
    });
  }

  const voucher = toRecord(primaryValue(created));
  const voucherId = Number(voucher.id ?? 0);
  if (voucherId <= 0) throw new Error("Expense voucher creation did not return an id");

  values.__expenseVoucherId = voucherId;
  values.__expenseAccountNumber = expenseAccountNumber;
  values.__vatAccountNumber = vatAccountNumber ?? undefined;
  values.__expenseBalanceAccountNumber = balanceAccount.number;

  const steps = preview.steps.filter((step) => step.method !== "POST" || step.path !== "/ledger/voucher");
  pushStep(steps, "POST", "/ledger/voucher", {
    body: {
      date: voucherDate,
      description,
      postings,
    },
    saveAs: "voucher",
  });
  pushStep(steps, "GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,date,description,postings(account(number),amountGross,department(id,name))" },
  });

  return {
    summary: `Register receipt expense ${description}`,
    steps,
  };
}

export async function verifyExpenseVoucherOutcome(
  client: TripletexClient,
  spec: ExpenseVoucherSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const voucherId = Number(values.__expenseVoucherId ?? 0);
  if (voucherId <= 0) {
    return { verified: false, detail: "expense voucher id missing", required: true };
  }

  const response = await client.request("GET", `/ledger/voucher/${voucherId}`, {
    params: { fields: "id,date,description,postings(account(number),amountGross,department(id,name))" },
  });
  const voucher = toRecord(primaryValue(response));
  const postings = Array.isArray(voucher.postings) ? voucher.postings.map((item) => toRecord(item)) : [];
  if (postings.length < 2) {
    return { verified: false, detail: "expense voucher missing expected postings", required: true };
  }

  const expectedDate = typeof values.date === "string" && values.date.trim() ? values.date.trim() : "";
  if (expectedDate && String(voucher.date ?? "") !== expectedDate) {
    return { verified: false, detail: "expense voucher date mismatch", required: true };
  }

  const expectedDescription = typeof values.description === "string" && values.description.trim()
    ? values.description.trim()
    : typeof values.name === "string" && values.name.trim()
      ? values.name.trim()
      : "";
  if (expectedDescription && !textMatches(voucher.description, expectedDescription)) {
    return { verified: false, detail: "expense voucher description mismatch", required: true };
  }

  const grossAmount = Math.abs(toNumber(values.amount) ?? 0);
  const vatRate = toNumber(values.vatRate);
  const { expenseAmount, vatAmount } = computeVoucherAmounts(grossAmount, vatRate);
  const expenseAccountNumber = Math.trunc(toNumber(values.__expenseAccountNumber ?? values.accountNumber) ?? defaultExpenseAccountNumber(values));
  const vatAccountNumber = Math.trunc(toNumber(values.__vatAccountNumber) ?? 0);
  const balanceAccountNumber = Math.trunc(toNumber(values.__expenseBalanceAccountNumber) ?? 0);

  const expensePosting = postings.find((posting) => {
    const accountNumber = Number(toRecord(posting.account).number ?? 0);
    const amount = toNumber(posting.amountGross);
    const departmentName = toRecord(posting.department).name;
    const departmentMatches = typeof values.departmentName === "string" && values.departmentName.trim()
      ? textMatches(departmentName, values.departmentName)
      : true;
    return accountNumber === expenseAccountNumber && amount !== null && nearlyEqual(amount, expenseAmount) && departmentMatches;
  });
  if (!expensePosting) {
    return { verified: false, detail: "expense voucher missing expected expense posting", required: true };
  }

  if (vatAmount > 0) {
    const vatPosting = postings.find((posting) => {
      const accountNumber = Number(toRecord(posting.account).number ?? 0);
      const amount = toNumber(posting.amountGross);
      return accountNumber === vatAccountNumber && amount !== null && nearlyEqual(amount, vatAmount);
    });
    if (!vatPosting) {
      return { verified: false, detail: "expense voucher missing expected VAT posting", required: true };
    }
  }

  if (balanceAccountNumber > 0) {
    const balancePosting = postings.find((posting) => {
      const accountNumber = Number(toRecord(posting.account).number ?? 0);
      const amount = toNumber(posting.amountGross);
      return accountNumber === balanceAccountNumber && amount !== null && nearlyEqual(amount, -roundMoney(grossAmount));
    });
    if (!balancePosting) {
      return { verified: false, detail: "expense voucher missing balancing posting", required: true };
    }
  }

  return { verified: true, detail: "expense voucher verified", required: true };
}
