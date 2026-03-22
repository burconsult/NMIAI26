import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { shiftIsoDateInZone, todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskOperation, TaskSpec } from "./task_spec.js";

type VerificationResult = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type DimensionNameRecord = {
  id: number;
  version?: number;
  dimensionName?: string;
  description?: string;
  dimensionIndex?: number;
  active?: boolean;
};

type DimensionValueRecord = {
  id: number;
  version?: number;
  displayName?: string;
  dimensionIndex?: number;
  number?: string;
  showInVoucherRegistration?: boolean;
  active?: boolean;
};

function todayIso(): string {
  return todayIsoInZone();
}

function dateRangeParams(prefix: string): Record<string, string> {
  return {
    [`${prefix}From`]: shiftIsoDateInZone({ years: -1 }),
    [`${prefix}To`]: shiftIsoDateInZone({ days: 1 }),
  };
}

function parseFlexibleNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  const compact = normalized.replace(/\s+/g, "");
  const comma = compact.includes(",");
  const dot = compact.includes(".");
  let candidate = compact;

  if (comma && dot) {
    candidate = compact.lastIndexOf(",") > compact.lastIndexOf(".")
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, "");
  } else if (comma) {
    candidate = compact.replace(",", ".");
  }

  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function uniqueStrings(values: Array<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function managedDimensionDescription(requested: unknown): string {
  const description = String(requested ?? "").trim();
  return description || "managed by tripletex agent";
}

function isAgentManagedDimension(dimension: DimensionNameRecord): boolean {
  const description = String(dimension.description ?? "").trim().toLowerCase();
  return (
    description.includes("managed by tripletex agent")
    || description === "smoke"
    || description.startsWith("generated voucher for ")
  );
}

function sortDimensions(dimensions: DimensionNameRecord[]): DimensionNameRecord[] {
  return [...dimensions].sort((left, right) => {
    const leftIndex = Number(left.dimensionIndex ?? 99);
    const rightIndex = Number(right.dimensionIndex ?? 99);
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return Number(left.id) - Number(right.id);
  });
}

function chooseReusableDimension(dimensions: DimensionNameRecord[]): DimensionNameRecord | null {
  const sorted = sortDimensions(dimensions);
  return (
    sorted.find((dimension) => !dimension.active && isAgentManagedDimension(dimension))
    ?? sorted.find((dimension) => !dimension.active)
    ?? sorted.find((dimension) => isAgentManagedDimension(dimension))
    // Last resort: reuse the lowest-index dimension rather than fail permanently once the tenant is saturated.
    ?? sorted[0]
    ?? null
  );
}

function nextValueNumber(
  dimensionIndex: number,
  existingValues: DimensionValueRecord[],
  seed: string,
): string {
  const used = new Set(
    existingValues
      .map((value) => String(value.number ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  const token = seed.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "VAL";
  for (let counter = 1; counter <= 999; counter += 1) {
    const candidate = `D${dimensionIndex}${token}${counter}`;
    if (!used.has(candidate)) return candidate;
  }
  return `D${dimensionIndex}${Date.now().toString().slice(-6)}`;
}

function buildVoucherPosting(
  accountId: number,
  dimensionIndex: number,
  dimensionValueId: number,
  amount: number,
): Record<string, unknown> {
  const posting: Record<string, unknown> = {
    row: 1,
    amountGross: amount,
    amountGrossCurrency: amount,
    account: { id: accountId },
  };
  posting[`freeAccountingDimension${dimensionIndex}`] = { id: dimensionValueId };
  return posting;
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

function extractValueNames(values: Record<string, unknown>): string[] {
  const requestedValues = Array.isArray(values.dimensionValues) ? values.dimensionValues : [];
  return uniqueStrings([
    ...requestedValues,
    values.dimensionValueName,
  ]);
}

export function compileAccountingDimensionPreview(
  op: TaskOperation,
  values: Record<string, unknown>,
): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List accounting dimensions",
      steps: [
        {
          method: "GET",
          path: "/ledger/accountingDimensionName",
          params: { count: 20, from: 0, fields: "id,dimensionName,dimensionIndex,active,description" },
        },
      ],
    };
  }

  const dimensionName = String(values.dimensionName ?? values.name ?? `Dimension ${Date.now().toString().slice(-6)}`).trim();
  const requestedValues = extractValueNames(values);
  const amount = typeof values.amount === "number"
    ? Math.abs(values.amount)
    : Math.abs(parseFlexibleNumber(String(values.amount ?? "")) ?? 0);

  const steps: PlanStep[] = [
    {
      method: "GET",
      path: "/ledger/accountingDimensionName",
      params: { count: 20, from: 0, fields: "id,version,dimensionName,dimensionIndex,active,description" },
    },
    {
      method: "POST",
      path: "/ledger/accountingDimensionName",
      body: {
        dimensionName,
        description: managedDimensionDescription(values.description ?? values.comment),
        active: true,
      },
    },
    {
      method: "GET",
      path: "/ledger/accountingDimensionValue/search",
      params: { dimensionIndex: 1, count: 100, from: 0, fields: "id,displayName,dimensionIndex,number,active" },
    },
  ];

  requestedValues.forEach((displayName, index) => {
    steps.push({
      method: "POST",
      path: "/ledger/accountingDimensionValue",
      body: {
        displayName,
        dimensionIndex: 1,
        number: `D1VAL${index + 1}`,
        showInVoucherRegistration: true,
        active: true,
      },
    });
  });

  if (amount > 0 && values.accountNumber && requestedValues.length > 0) {
    steps.push(
      {
        method: "GET",
        path: "/ledger/account",
        params: {
          number: String(values.accountNumber),
          count: 1,
          from: 0,
          fields: "id,number,name",
        },
      },
      {
        method: "GET",
        path: "/ledger/account",
        params: {
          isBalanceAccount: true,
          count: 1,
          from: 0,
          fields: "id,number,name",
        },
      },
      {
        method: "POST",
        path: "/ledger/voucher",
        body: {
          date: String(values.date ?? todayIso()),
          description: String(values.description ?? values.comment ?? `Generated voucher for ${dimensionName}`),
          postings: [
            {
              row: 1,
              amountGross: amount,
              amountGrossCurrency: amount,
              account: { id: 1 },
              freeAccountingDimension1: { id: 1 },
            },
            {
              row: 2,
              amountGross: -amount,
              amountGrossCurrency: -amount,
              account: { id: 2 },
            },
          ],
        },
      },
    );
  }

  return {
    summary: `Resolve or create accounting dimension ${dimensionName}`,
    steps,
  };
}

export async function executeAccountingDimensionWorkflow(
  client: TripletexClient,
  spec: TaskSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = asRecord(spec.values);
  const preview = compileAccountingDimensionPreview(spec.operation, values);
  if (dryRun || spec.operation !== "create") return preview;

  const dimensionName = String(values.dimensionName ?? values.name ?? "").trim();
  if (!dimensionName) {
    throw new Error("Accounting dimension workflow requires dimensionName");
  }

  const requestedValues = extractValueNames(values);
  const selectedValueName = String(values.dimensionValueName ?? requestedValues[0] ?? "").trim();
  const amount = typeof values.amount === "number"
    ? Math.abs(values.amount)
    : Math.abs(parseFlexibleNumber(String(values.amount ?? "")) ?? 0);
  const voucherDescription = String(values.description ?? values.comment ?? `Generated voucher for ${dimensionName}`).trim();
  const dimensionDescription = managedDimensionDescription(values.description ?? values.comment);
  const executedSteps: PlanStep[] = [];

  const dimensionsResponse = await client.request("GET", "/ledger/accountingDimensionName", {
    params: { count: 20, from: 0, fields: "id,version,dimensionName,dimensionIndex,active,description" },
  });
  pushStep(executedSteps, "GET", "/ledger/accountingDimensionName", {
    params: { count: 20, from: 0, fields: "id,version,dimensionName,dimensionIndex,active,description" },
  });
  const dimensions = Array.isArray(asRecord(dimensionsResponse).values)
    ? asRecord(dimensionsResponse).values as DimensionNameRecord[]
    : [];

  let dimension = sortDimensions(dimensions).find(
    (item) => String(item.dimensionName ?? "").trim().toLowerCase() === dimensionName.toLowerCase(),
  );

  if (!dimension && dimensions.length < 3) {
    const body = {
      dimensionName,
      description: dimensionDescription,
      active: true,
    };
    const created = await client.request("POST", "/ledger/accountingDimensionName", { body });
    pushStep(executedSteps, "POST", "/ledger/accountingDimensionName", { body });
    dimension = primaryValue(created) as DimensionNameRecord | undefined;
  }

  if (!dimension) {
    const reusable = chooseReusableDimension(dimensions);
    if (!reusable?.id) {
      throw new Error("No reusable accounting dimension slot available");
    }
    const body = {
      id: reusable.id,
      version: reusable.version ?? 0,
      dimensionName,
      description: dimensionDescription,
      active: true,
    };
    const updated = await client.request("PUT", `/ledger/accountingDimensionName/${reusable.id}`, { body });
    pushStep(executedSteps, "PUT", `/ledger/accountingDimensionName/${reusable.id}`, { body });
    dimension = primaryValue(updated) as DimensionNameRecord | undefined;
  } else if (dimension.id && (!dimension.active || isAgentManagedDimension(dimension))) {
    const body = {
      id: dimension.id,
      version: dimension.version ?? 0,
      dimensionName,
      description: dimensionDescription,
      active: true,
    };
    const updated = await client.request("PUT", `/ledger/accountingDimensionName/${dimension.id}`, { body });
    pushStep(executedSteps, "PUT", `/ledger/accountingDimensionName/${dimension.id}`, { body });
    dimension = primaryValue(updated) as DimensionNameRecord | undefined;
  }

  const dimensionIndex = Number(dimension?.dimensionIndex ?? 0);
  if (!dimension?.id || !Number.isFinite(dimensionIndex) || dimensionIndex < 1) {
    throw new Error("Accounting dimension resolution failed");
  }

  const valuesParams = {
    dimensionIndex,
    count: 100,
    from: 0,
    fields: "id,version,displayName,dimensionIndex,number,showInVoucherRegistration,active",
  };
  const dimensionValuesResponse = await client.request("GET", "/ledger/accountingDimensionValue/search", {
    params: valuesParams,
  });
  pushStep(executedSteps, "GET", "/ledger/accountingDimensionValue/search", { params: valuesParams });
  const existingValues = Array.isArray(asRecord(dimensionValuesResponse).values)
    ? asRecord(dimensionValuesResponse).values as DimensionValueRecord[]
    : [];
  const valuesByName = new Map<string, DimensionValueRecord>();
  for (const value of existingValues) {
    const key = String(value.displayName ?? "").trim().toLowerCase();
    if (key) valuesByName.set(key, value);
  }

  for (const displayName of requestedValues) {
    const key = displayName.toLowerCase();
    if (valuesByName.has(key)) continue;
    const body = {
      displayName,
      dimensionIndex,
      number: nextValueNumber(dimensionIndex, [...valuesByName.values()], displayName),
      showInVoucherRegistration: true,
      active: true,
    };
    const created = await client.request("POST", "/ledger/accountingDimensionValue", { body });
    pushStep(executedSteps, "POST", "/ledger/accountingDimensionValue", { body });
    const createdValue = primaryValue(created) as DimensionValueRecord | undefined;
    if (createdValue) {
      valuesByName.set(key, createdValue);
    }
  }

  if (amount > 0 && values.accountNumber && selectedValueName) {
    const targetValue = valuesByName.get(selectedValueName.toLowerCase());
    if (!targetValue?.id) {
      throw new Error(`Accounting dimension value '${selectedValueName}' could not be resolved`);
    }

    const accountParams = {
      number: String(values.accountNumber),
      count: 1,
      from: 0,
      fields: "id,number,name",
    };
    const targetAccountResponse = await client.request("GET", "/ledger/account", { params: accountParams });
    pushStep(executedSteps, "GET", "/ledger/account", { params: accountParams });
    const targetAccount = primaryValue(targetAccountResponse) as Record<string, unknown> | undefined;

    const offsetParams = {
      isBalanceAccount: true,
      count: 1,
      from: 0,
      fields: "id,number,name",
    };
    const offsetAccountResponse = await client.request("GET", "/ledger/account", { params: offsetParams });
    pushStep(executedSteps, "GET", "/ledger/account", { params: offsetParams });
    const offsetAccount = primaryValue(offsetAccountResponse) as Record<string, unknown> | undefined;

    const targetAccountId = Number(targetAccount?.id ?? 0);
    const offsetAccountId = Number(offsetAccount?.id ?? 0);
    if (!targetAccountId || !offsetAccountId) {
      throw new Error("Accounting dimension voucher accounts could not be resolved");
    }

    const body = {
      date: String(values.date ?? todayIso()),
      description: voucherDescription,
      postings: [
        buildVoucherPosting(targetAccountId, dimensionIndex, Number(targetValue.id), amount),
        {
          row: 2,
          amountGross: -amount,
          amountGrossCurrency: -amount,
          account: { id: offsetAccountId },
        },
      ],
    };
    await client.request("POST", "/ledger/voucher", { body });
    pushStep(executedSteps, "POST", "/ledger/voucher", { body });
  }

  return {
    summary: `Resolve or create accounting dimension ${dimensionName}`,
    steps: executedSteps,
  };
}

export async function verifyAccountingDimensionOutcome(
  client: TripletexClient,
  spec: TaskSpec,
): Promise<VerificationResult> {
  const values = asRecord(spec.values);
  const dimensionName = String(values.dimensionName ?? values.name ?? "").trim();
  if (!dimensionName) {
    return { verified: false, detail: "missing dimensionName for verification", required: true };
  }

  try {
    const dimensionResponse = await client.request("GET", "/ledger/accountingDimensionName", {
      params: { count: 20, from: 0, fields: "id,dimensionName,dimensionIndex,active,description" },
    });
    const dimensions = Array.isArray(asRecord(dimensionResponse).values)
      ? asRecord(dimensionResponse).values as Array<Record<string, unknown>>
      : [];
    const matchedDimension = dimensions.find(
      (item) => String(item.dimensionName ?? "").trim().toLowerCase() === dimensionName.toLowerCase(),
    );
    if (!matchedDimension?.dimensionIndex) {
      return { verified: false, detail: `accounting dimension '${dimensionName}' not found`, required: true };
    }

    const requestedValues = extractValueNames(values);
    const valuesResponse = await client.request("GET", "/ledger/accountingDimensionValue/search", {
      params: {
        dimensionIndex: matchedDimension.dimensionIndex,
        count: 100,
        from: 0,
        fields: "id,displayName,dimensionIndex,number,showInVoucherRegistration,active",
      },
    });
    const dimensionValues = Array.isArray(asRecord(valuesResponse).values)
      ? asRecord(valuesResponse).values as Array<Record<string, unknown>>
      : [];

    for (const expectedValue of requestedValues) {
      const found = dimensionValues.find(
        (item) => String(item.displayName ?? "").trim().toLowerCase() === expectedValue.toLowerCase(),
      );
      if (!found) {
        return { verified: false, detail: `dimension value '${expectedValue}' not found`, required: true };
      }
    }

    const accountNumber = String(values.accountNumber ?? "").trim();
    const amount = typeof values.amount === "number"
      ? Math.abs(values.amount)
      : Math.abs(parseFlexibleNumber(String(values.amount ?? "")) ?? 0);
    const targetValueName = String(values.dimensionValueName ?? requestedValues[0] ?? "").trim();
    if (accountNumber && amount > 0 && targetValueName) {
      const accountResponse = await client.request("GET", "/ledger/account", {
        params: { number: accountNumber, count: 1, from: 0, fields: "id,number,name" },
      });
      const account = primaryValue(accountResponse) as Record<string, unknown> | undefined;
      const targetValue = dimensionValues.find(
        (item) => String(item.displayName ?? "").trim().toLowerCase() === targetValueName.toLowerCase(),
      );
      if (!account?.id || !targetValue?.id) {
        return { verified: false, detail: "account or dimension value missing for voucher verification", required: true };
      }

      for (const slot of [1, 2, 3]) {
        const postingResponse = await client.request("GET", "/ledger/posting", {
          params: {
            ...dateRangeParams("date"),
            count: 20,
            from: 0,
            accountId: account.id,
            [`accountingDimensionValue${slot}Id`]: targetValue.id,
            fields: "id,description,account(number),amountGross,voucher(id,description,date),freeAccountingDimension1(displayName),freeAccountingDimension2(displayName),freeAccountingDimension3(displayName)",
          },
        });
        const postings = Array.isArray(asRecord(postingResponse).values)
          ? asRecord(postingResponse).values as Array<Record<string, unknown>>
          : [];
        if (postings.length > 0) {
          return { verified: true, detail: "accounting dimension and voucher verified", required: true };
        }
      }
      return { verified: false, detail: "no voucher posting found for accounting dimension value", required: true };
    }

    return { verified: true, detail: "accounting dimension verified", required: true };
  } catch (error) {
    return {
      verified: false,
      detail: `verification GET failed: ${error instanceof Error ? error.message : String(error)}`,
      required: true,
    };
  }
}
