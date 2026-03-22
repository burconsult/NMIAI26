import type { ExecutionPlan } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type TravelExpenseSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

type EmployeeRecord = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
};

type PaymentTypeRecord = {
  id: number;
  description: string;
};

const DEFAULT_DOB = "1990-01-15";

export function matchesTravelExpenseWorkflow(spec: TravelExpenseSpec): boolean {
  return spec.entity === "travel_expense" && spec.operation === "create";
}

export async function executeTravelExpenseWorkflow(
  client: TripletexClient,
  spec: TravelExpenseSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileTravelExpensePreview(values);
  if (dryRun) return preview;

  const employee = await ensureTravelExpenseEmployee(client, values);
  values.__employeeId = employee.id;
  const paymentType = await resolveTravelExpensePaymentType(client);
  const travelDate = toDateIso(values.date) ?? todayIsoInZone();
  const travelDays = positiveInteger(values.travelDays) ?? 1;
  const title = String(values.title ?? values.name ?? "Travel expense").trim() || "Travel expense";
  const perDiemRate = toNumber(values.perDiemRate);
  const costs = normalizeCosts(values.costs);

  const response = await client.request("POST", "/travelExpense", {
    body: {
      employee: { id: employee.id },
      date: travelDate,
      title,
      travelDetails: {
        departureDate: travelDate,
        returnDate: shiftIsoDate(travelDate, Math.max(0, travelDays - 1)),
        destination: title,
        purpose: title,
      },
      ...(perDiemRate && perDiemRate > 0
        ? {
          perDiemCompensations: [
            {
              count: travelDays,
              rate: perDiemRate,
              location: title,
            },
          ],
        }
        : {}),
      ...(costs.length > 0
        ? {
          costs: costs.map((cost) => ({
            comments: cost.comments,
            amountCurrencyIncVat: cost.amountCurrencyIncVat,
            date: travelDate,
            paymentType: { id: paymentType.id, description: paymentType.description },
          })),
        }
        : {}),
    },
  });
  const created = toRecord(primaryValue(response));
  const createdId = Number(created.id ?? 0);
  if (createdId > 0) values.__travelExpenseId = createdId;

  return {
    summary: `Create travel expense for employee ${employee.id}`,
    steps: [
      { method: "GET", path: "/employee", params: { email: employee.email ?? undefined, count: 5, fields: "id,firstName,lastName,email" } },
      { method: "GET", path: "/travelExpense/paymentType", params: { count: 10, fields: "id,description" } },
      { method: "POST", path: "/travelExpense", body: { employee: { id: employee.id }, title } },
      ...(createdId > 0
        ? [{ method: "GET" as const, path: `/travelExpense/${createdId}`, params: { fields: "id,title,perDiemCompensations(count,rate),costs(comments,amountCurrencyIncVat)" } }]
        : []),
    ] satisfies ExecutionPlan["steps"],
  };
}

function compileTravelExpensePreview(values: Record<string, unknown>): ExecutionPlan {
  const employeeEmail = typeof values.email === "string" ? values.email : undefined;
  const employeeName = typeof values.employeeName === "string" ? values.employeeName : typeof values.name === "string" ? values.name : undefined;
  return {
    summary: `Create travel expense for ${employeeEmail ?? employeeName ?? "employee"}`,
    steps: [
      { method: "GET", path: "/employee", params: { count: 5, fields: "id,firstName,lastName,email" } },
      { method: "GET", path: "/department", params: { count: 1, fields: "id,name" } },
      { method: "POST", path: "/employee", body: { email: employeeEmail ?? "employee@example.org" } },
      { method: "GET", path: "/travelExpense/paymentType", params: { count: 10, fields: "id,description" } },
      { method: "POST", path: "/travelExpense", body: { employee: { id: "{{employee_id}}" } } },
    ],
  };
}

async function ensureTravelExpenseEmployee(client: TripletexClient, values: Record<string, unknown>): Promise<EmployeeRecord> {
  const existing = await findTravelExpenseEmployee(client, values);
  if (existing?.id) return existing;

  const departmentId = await ensureDepartmentId(client);
  const person = splitName(String(values.employeeName ?? values.name ?? emailToName(values.email) ?? "Travel Employee"));
  const response = await client.request("POST", "/employee", {
    body: {
      firstName: person.firstName,
      lastName: person.lastName,
      email: typeof values.email === "string" ? values.email : undefined,
      dateOfBirth: typeof values.dateOfBirth === "string" ? values.dateOfBirth : DEFAULT_DOB,
      department: { id: departmentId },
      userType: "NO_ACCESS",
    },
  });
  return employeeFromRecord(primaryValue(response));
}

async function findTravelExpenseEmployee(client: TripletexClient, values: Record<string, unknown>): Promise<EmployeeRecord | null> {
  const email = typeof values.email === "string" ? values.email.trim() : "";
  if (email) {
    const response = await client.request("GET", "/employee", {
      params: { email, count: 20, from: 0, fields: "id,firstName,lastName,email" },
    });
    const candidates = toValues(response).map(employeeFromRecord).filter((item) => item.id > 0);
    const exact = candidates.find((item) => normalized(item.email) === normalized(email));
    if (exact) return exact;
    if (candidates[0]) return candidates[0];
  }

  const name = typeof values.employeeName === "string"
    ? values.employeeName
    : typeof values.name === "string"
      ? values.name
      : emailToName(values.email);
  if (!name) return null;
  const person = splitName(name);
  const response = await client.request("GET", "/employee", {
    params: { firstName: person.firstName, lastName: person.lastName, count: 20, from: 0, fields: "id,firstName,lastName,email" },
  });
  const candidates = toValues(response).map(employeeFromRecord).filter((item) => item.id > 0);
  const exact = candidates.find((item) => normalized([item.firstName, item.lastName].filter(Boolean).join(" ")) === normalized(name));
  return exact ?? candidates[0] ?? null;
}

async function ensureDepartmentId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/department", { params: { count: 1, fields: "id,name" } });
  const department = toRecord(primaryValue(response));
  const id = Number(department.id ?? 0);
  if (id <= 0) throw new Error("No department available for travel expense employee");
  return id;
}

async function resolveTravelExpensePaymentType(client: TripletexClient): Promise<PaymentTypeRecord> {
  const response = await client.request("GET", "/travelExpense/paymentType", {
    params: { count: 20, from: 0, fields: "id,description" },
  });
  const candidates = toValues(response)
    .map((item) => toRecord(item))
    .map((item) => ({ id: Number(item.id ?? 0), description: String(item.description ?? "").trim() }))
    .filter((item) => item.id > 0 && item.description);
  const preferred = candidates.find((item) => /utlegg|expense|reis/i.test(item.description));
  const paymentType = preferred ?? candidates[0];
  if (!paymentType) throw new Error("No travel expense payment type available");
  return paymentType;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toValues(value: unknown): unknown[] {
  const record = toRecord(value);
  if (Array.isArray(record.values)) return record.values as unknown[];
  const primary = primaryValue(value);
  return primary ? [primary] : [];
}

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: parts[0] ?? "Travel", lastName: "Employee" };
  }
  return {
    firstName: parts[0] ?? "Travel",
    lastName: parts.slice(1).join(" ") || "Employee",
  };
}

function employeeFromRecord(value: unknown): EmployeeRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    firstName: typeof record.firstName === "string" ? record.firstName : undefined,
    lastName: typeof record.lastName === "string" ? record.lastName : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalizedValue = value.trim().replace(/\s+/g, "").replace(",", ".");
  const parsed = Number(normalizedValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return Math.max(1, Math.round(parsed));
}

function normalizeCosts(value: unknown): Array<{ comments: string; amountCurrencyIncVat: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      comments: String(item.comments ?? "").trim(),
      amountCurrencyIncVat: toNumber(item.amountCurrencyIncVat) ?? 0,
    }))
    .filter((item) => item.comments && item.amountCurrencyIncVat > 0);
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  const anchor = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  const nextYear = String(anchor.getUTCFullYear()).padStart(4, "0");
  const nextMonth = String(anchor.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(anchor.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function toDateIso(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function emailToName(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const local = value.split("@")[0] ?? "";
  if (!local) return null;
  return local
    .split(/[._-]+/)
    .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : "")
    .filter(Boolean)
    .join(" ");
}

function normalized(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
