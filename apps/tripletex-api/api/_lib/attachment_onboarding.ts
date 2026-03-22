import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";
import type { TaskOperation, TaskSpec } from "./task_spec.js";

type AttachmentOnboardingSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

type Verification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type EmployeeRecord = {
  id: number;
  version?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  dateOfBirth?: string;
  nationalIdentityNumber?: string;
  bankAccountNumber?: string;
  userType?: string;
  companyId?: number;
  departmentId?: number;
  departmentName?: string;
};

type EmploymentRecord = {
  id: number;
  version?: number;
  startDate?: string;
  endDate?: string;
  divisionId?: number;
};

type EmploymentDetailsRecord = {
  id: number;
  date?: string;
  annualSalary?: number;
  monthlySalary?: number;
  percentageOfFullTimeEquivalent?: number;
  occupationCode?: string;
};

const DEFAULT_DEPARTMENT_NAME = "Employees";
const DEFAULT_DIVISION_NAME = "AI Employee Unit";
const DEFAULT_DIVISION_ORG_NUMBER = "100000009";
const DEFAULT_DOB = "1990-01-15";
const MAX_DEPARTMENT_NAME_LENGTH = 100;

function normalizeDepartmentName(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return DEFAULT_DEPARTMENT_NAME;
  return text.slice(0, MAX_DEPARTMENT_NAME_LENGTH);
}

function normalizeEmail(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : undefined;
}

function normalizeIsoDate(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
}

function todayIso(): string {
  return todayIsoInZone();
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function responseValues(response: unknown): Array<Record<string, unknown>> {
  const record = toRecord(response);
  if (Array.isArray(record.values)) {
    return record.values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  const single = primaryValue(response);
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

function textMatches(actual: unknown, expected: unknown): boolean {
  const actualText = normalizeText(actual);
  const expectedText = normalizeText(expected);
  if (!actualText || !expectedText) return false;
  return actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText);
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
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function digitsOnly(value: string | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function computeMod11CheckDigit(digits: number[], weights: number[]): number | null {
  const sum = digits.reduce((total, digit, index) => total + digit * weights[index]!, 0);
  const remainder = 11 - (sum % 11);
  if (remainder === 11) return 0;
  if (remainder === 10) return null;
  return remainder;
}

function isValidNorwegianNationalIdentityNumber(value: string | undefined): boolean {
  const digits = digitsOnly(value);
  if (!/^\d{11}$/.test(digits)) return false;
  const dateDigits = digits.slice(0, 6);
  let day = Number(dateDigits.slice(0, 2));
  let month = Number(dateDigits.slice(2, 4));
  if (day > 40) day -= 40;
  if (month > 40) month -= 40;
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  const parts = digits.split("").map((digit) => Number(digit));
  const k1 = computeMod11CheckDigit(parts.slice(0, 9), [3, 7, 6, 1, 8, 9, 4, 5, 2]);
  if (k1 === null || parts[9] !== k1) return false;
  const k2 = computeMod11CheckDigit(parts.slice(0, 9).concat(k1), [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
  return k2 !== null && parts[10] === k2;
}

function isValidNorwegianBankAccountNumber(value: string | undefined): boolean {
  const digits = digitsOnly(value);
  if (!/^\d{11}$/.test(digits)) return false;
  const parts = digits.split("").map((digit) => Number(digit));
  const checkDigit = computeMod11CheckDigit(parts.slice(0, 10), [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
  return checkDigit !== null && parts[10] === checkDigit;
}

function sanitizeIdentityValues(values: Record<string, unknown>): void {
  if (typeof values.nationalIdentityNumber === "string" && values.nationalIdentityNumber.trim()) {
    const normalized = digitsOnly(values.nationalIdentityNumber);
    if (isValidNorwegianNationalIdentityNumber(normalized)) {
      values.nationalIdentityNumber = normalized;
    } else {
      delete values.nationalIdentityNumber;
    }
  }
  if (typeof values.bankAccountNumber === "string" && values.bankAccountNumber.trim()) {
    const normalized = digitsOnly(values.bankAccountNumber);
    if (isValidNorwegianBankAccountNumber(normalized)) {
      values.bankAccountNumber = normalized;
    } else {
      delete values.bankAccountNumber;
    }
  }
}

function splitName(name: string | undefined): { firstName: string; lastName: string } {
  if (!name) {
    const suffix = Date.now().toString().slice(-6);
    return { firstName: "Generated", lastName: `Employee${suffix}` };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "Employee" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function emailToName(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const local = value.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  if (!local) return null;
  return local
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function employmentStartDate(values: Record<string, unknown>): string {
  const explicit = String(values.employmentDate ?? values.startDate ?? values.date ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(explicit) ? explicit : todayIso();
}

function resolveDisplayName(values: Record<string, unknown>): string {
  const direct = String(values.name ?? values.employeeName ?? "").trim();
  if (direct) return direct;
  const fromEmail = emailToName(values.email);
  if (fromEmail) return fromEmail;
  return "Generated Employee";
}

function resolveUserType(values: Record<string, unknown>): string | undefined {
  const direct = String(values.userType ?? "").trim().toUpperCase();
  if (direct === "STANDARD" || direct === "EXTENDED" || direct === "NO_ACCESS") return direct;
  if (values.isAdmin === true) return "EXTENDED";
  if (values.userAccessRequested === true) return "STANDARD";
  return undefined;
}

function resolveEmploymentPercentage(values: Record<string, unknown>): number | null {
  const direct = toNumber(values.employmentPercentage ?? values.percentageOfFullTimeEquivalent ?? values.percentage);
  if (direct === null) return null;
  return Math.max(1, Math.min(100, roundMoney(direct)));
}

function resolveAnnualSalary(values: Record<string, unknown>): number | null {
  const annual = toNumber(values.annualSalary ?? values.baseSalaryAmount ?? values.salaryAmount ?? values.amount);
  if (annual !== null && annual > 0) return annual;
  const monthly = toNumber(values.monthlySalary);
  if (monthly !== null && monthly > 0) return roundMoney(monthly * 12);
  return null;
}

function resolveOccupationCode(values: Record<string, unknown>): string | null {
  const code = String(values.occupationCode ?? "").trim();
  if (!code) return null;
  return /^\d{3,6}$/.test(code) ? code : null;
}

function shouldApplyEntitlements(values: Record<string, unknown>): boolean {
  return resolveEntitlementTemplate(values) !== null;
}

function entitlementTemplate(values: Record<string, unknown>): string | null {
  const raw = String(values.entitlementTemplate ?? "").trim().toUpperCase();
  if (!raw) return null;
  const allowed = new Set([
    "NONE_PRIVILEGES",
    "ALL_PRIVILEGES",
    "INVOICING_MANAGER",
    "PERSONELL_MANAGER",
    "ACCOUNTANT",
    "AUDITOR",
    "DEPARTMENT_LEADER",
  ]);
  return allowed.has(raw) ? raw : null;
}

function resolveEntitlementTemplate(values: Record<string, unknown>): string | null {
  const explicit = entitlementTemplate(values);
  if (explicit) return explicit;
  if (values.userAccessRequested === true) return "INVOICING_MANAGER";
  return null;
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

function employeeFromRecord(value: unknown): EmployeeRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    version: Number(record.version ?? 0) || undefined,
    firstName: typeof record.firstName === "string" ? record.firstName : undefined,
    lastName: typeof record.lastName === "string" ? record.lastName : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    dateOfBirth: typeof record.dateOfBirth === "string" ? record.dateOfBirth : undefined,
    nationalIdentityNumber: typeof record.nationalIdentityNumber === "string" ? record.nationalIdentityNumber : undefined,
    bankAccountNumber: typeof record.bankAccountNumber === "string" ? record.bankAccountNumber : undefined,
    userType: typeof record.userType === "string" ? record.userType : undefined,
    companyId: Number(record.companyId ?? 0) || undefined,
    departmentId: Number(toRecord(record.department).id ?? 0) || undefined,
    departmentName: typeof toRecord(record.department).name === "string" ? String(toRecord(record.department).name) : undefined,
  };
}

function employmentFromRecord(value: unknown): EmploymentRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    version: Number(record.version ?? 0) || undefined,
    startDate: typeof record.startDate === "string" ? record.startDate : undefined,
    endDate: typeof record.endDate === "string" ? record.endDate : undefined,
    divisionId: Number(toRecord(record.division).id ?? 0) || undefined,
  };
}

function employmentDetailsFromRecord(value: unknown): EmploymentDetailsRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    date: typeof record.date === "string" ? record.date : undefined,
    annualSalary: toNumber(record.annualSalary) ?? undefined,
    monthlySalary: toNumber(record.monthlySalary) ?? undefined,
    percentageOfFullTimeEquivalent: toNumber(record.percentageOfFullTimeEquivalent) ?? undefined,
    occupationCode: typeof toRecord(record.occupationCode).code === "string" ? String(toRecord(record.occupationCode).code) : undefined,
  };
}

async function ensureDepartmentId(client: TripletexClient, values: Record<string, unknown>): Promise<number> {
  const requestedName = normalizeDepartmentName(values.departmentName);
  values.departmentName = requestedName;
  const response = await client.request("GET", "/department", {
    params: { count: 50, fields: "id,name" },
  });
  const existing = responseValues(response).find((item) => textMatches(item.name, requestedName));
  const existingId = Number(toRecord(existing).id ?? 0);
  if (existingId > 0) return existingId;
  try {
    const created = await client.request("POST", "/department", { body: { name: requestedName } });
    const departmentId = Number(toRecord(primaryValue(created)).id ?? 0);
    if (departmentId > 0) return departmentId;
  } catch {
    // Fall through to existing/default recovery.
  }
  const fallback = responseValues(response).find((item) => textMatches(item.name, DEFAULT_DEPARTMENT_NAME))
    ?? responseValues(response).find((item) => Number(toRecord(item).id ?? 0) > 0);
  const fallbackId = Number(toRecord(fallback).id ?? 0);
  if (fallbackId > 0) {
    values.departmentName = String(toRecord(fallback).name ?? DEFAULT_DEPARTMENT_NAME);
    return fallbackId;
  }
  throw new Error("Department creation did not return an id");
}

async function findEmployee(client: TripletexClient, values: Record<string, unknown>): Promise<EmployeeRecord | null> {
  const email = typeof values.email === "string" ? values.email.trim() : "";
  if (email) {
    const response = await client.request("GET", "/employee", {
      params: { email, count: 5, fields: "id,version,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,companyId,department(id,name)" },
    });
    const byEmail = employeeFromRecord(primaryValue(response));
    if (byEmail.id > 0) return byEmail;
  }

  const nid = typeof values.nationalIdentityNumber === "string" ? values.nationalIdentityNumber.trim() : "";
  if (nid) {
    const response = await client.request("GET", "/employee", {
      params: { count: 100, fields: "id,version,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,companyId,department(id,name)" },
    });
    const byNationalId = responseValues(response)
      .map((item) => employeeFromRecord(item))
      .find((item) => normalizeText(item.nationalIdentityNumber) === normalizeText(nid));
    if (byNationalId?.id) return byNationalId;
  }

  if (email || nid) return null;

  const person = splitName(resolveDisplayName(values));
  const response = await client.request("GET", "/employee", {
    params: {
      firstName: person.firstName,
      lastName: person.lastName,
      count: 10,
      fields: "id,version,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,companyId,department(id,name)",
    },
  });
  const byName = responseValues(response)
    .map((item) => employeeFromRecord(item))
    .find((item) => textMatches(item.firstName, person.firstName) && textMatches(item.lastName, person.lastName));
  return byName?.id ? byName : null;
}

async function fetchEmployeeById(client: TripletexClient, employeeId: number): Promise<EmployeeRecord | null> {
  const response = await client.request("GET", `/employee/${employeeId}`, {
    params: { fields: "id,version,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,companyId,department(id,name)" },
  });
  const employee = employeeFromRecord(primaryValue(response));
  return employee.id > 0 ? employee : null;
}

function buildEmployeeBody(values: Record<string, unknown>, departmentId: number): Record<string, unknown> {
  const person = splitName(resolveDisplayName(values));
  const body: Record<string, unknown> = {
    firstName: typeof values.firstName === "string" && values.firstName.trim() ? values.firstName.trim() : person.firstName,
    lastName: typeof values.lastName === "string" && values.lastName.trim() ? values.lastName.trim() : person.lastName,
    dateOfBirth: normalizeIsoDate(values.dateOfBirth) ?? DEFAULT_DOB,
    department: { id: departmentId },
    comments: "Created by Tripletex solver onboarding workflow",
  };
  const email = normalizeEmail(values.email);
  if (email) body.email = email;
  if (typeof values.phoneNumber === "string" && values.phoneNumber.trim()) body.phoneNumberMobile = values.phoneNumber.trim();
  if (typeof values.nationalIdentityNumber === "string" && values.nationalIdentityNumber.trim()) body.nationalIdentityNumber = values.nationalIdentityNumber.trim();
  if (typeof values.bankAccountNumber === "string" && values.bankAccountNumber.trim()) body.bankAccountNumber = values.bankAccountNumber.trim();
  const userType = resolveUserType(values);
  if (userType) body.userType = userType;
  if (values.address || values.postalCode || values.city) {
    body.address = {
      addressLine1: values.address ?? "",
      postalCode: values.postalCode ?? "",
      city: values.city ?? "",
    };
  }
  return body;
}

function validationFieldsFromError(error: unknown): Set<string> {
  if (!(error instanceof TripletexError)) return new Set();
  const body = toRecord(error.responseBody);
  const validationMessages = Array.isArray(body.validationMessages) ? body.validationMessages : [];
  return new Set(
    validationMessages
      .map((item) => toRecord(item).field)
      .filter((field): field is string => typeof field === "string" && field.trim().length > 0),
  );
}

function dropInvalidEmployeeFields(
  body: Record<string, unknown>,
  values: Record<string, unknown>,
  invalidFields: Set<string>,
): boolean {
  let changed = false;
  if (invalidFields.has("email")) {
    delete body.email;
    delete values.email;
    changed = true;
  }
  if (invalidFields.has("dateOfBirth")) {
    body.dateOfBirth = DEFAULT_DOB;
    delete values.dateOfBirth;
    changed = true;
  }
  if (invalidFields.has("nationalIdentityNumber")) {
    body.nationalIdentityNumber = "";
    delete values.nationalIdentityNumber;
    changed = true;
  }
  if (invalidFields.has("bankAccountNumber") || invalidFields.has("employee.bankAccountNumber")) {
    body.bankAccountNumber = "";
    delete values.bankAccountNumber;
    changed = true;
  }
  return changed;
}

async function requestEmployeeMutationWithFallback(
  client: TripletexClient,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await client.request(method, path, { body });
  } catch (error) {
    const invalidFields = validationFieldsFromError(error);
    const retryBody = { ...body };
    const changed = dropInvalidEmployeeFields(retryBody, values, invalidFields);
    if (!changed) throw error;
    return await client.request(method, path, { body: retryBody });
  }
}

async function ensureEmployee(client: TripletexClient, values: Record<string, unknown>, departmentId: number): Promise<EmployeeRecord> {
  const existing = await findEmployee(client, values);
  if (!existing?.id) {
    const created = await requestEmployeeMutationWithFallback(
      client,
      "POST",
      "/employee",
      buildEmployeeBody(values, departmentId),
      values,
    );
    const employee = employeeFromRecord(primaryValue(created));
    if (employee.id <= 0) throw new Error("Employee creation did not return an id");
    const fetched = await fetchEmployeeById(client, employee.id);
    return fetched ?? employee;
  }

  const current = await fetchEmployeeById(client, existing.id) ?? existing;
  const desiredUserType = resolveUserType(values);
  const needsUpdate = (
    (typeof values.email === "string" && values.email.trim() && !textMatches(current.email, values.email))
    || (typeof values.dateOfBirth === "string" && values.dateOfBirth.trim() && !textMatches(current.dateOfBirth, values.dateOfBirth))
    || (typeof values.nationalIdentityNumber === "string" && values.nationalIdentityNumber.trim() && !textMatches(current.nationalIdentityNumber, values.nationalIdentityNumber))
    || (typeof values.bankAccountNumber === "string" && values.bankAccountNumber.trim() && !textMatches(current.bankAccountNumber, values.bankAccountNumber))
    || (desiredUserType && !textMatches(current.userType, desiredUserType))
    || (departmentId > 0 && current.departmentId !== departmentId)
  );

  if (!needsUpdate) return current;

  await requestEmployeeMutationWithFallback(
    client,
    "PUT",
    `/employee/${current.id}`,
    {
      version: current.version ?? 0,
      ...buildEmployeeBody(values, departmentId),
    },
    values,
  );
  return (await fetchEmployeeById(client, current.id)) ?? current;
}

async function findExistingDivisionId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/division", {
    params: { count: 20, fields: "id,name,organizationNumber" },
  });
  const first = responseValues(response).find((item) => Number(toRecord(item).id ?? 0) > 0);
  return Number(toRecord(first).id ?? 0);
}

async function resolveMunicipalityId(client: TripletexClient, companyId: number | undefined): Promise<number> {
  let city = "Oslo";
  if (companyId && Number.isFinite(companyId)) {
    const response = await client.request("GET", `/company/${companyId}`, { params: { fields: "address(city)" } });
    const company = toRecord(primaryValue(response));
    const companyAddress = toRecord(company.address);
    if (typeof companyAddress.city === "string" && companyAddress.city.trim()) {
      city = companyAddress.city.trim();
    }
  }
  const response = await client.request("GET", "/municipality/query", {
    params: { query: city, count: 1, fields: "id,name" },
  });
  const municipalityId = Number(toRecord(primaryValue(response)).id ?? 0);
  if (municipalityId <= 0) throw new Error(`Unable to resolve municipality for city '${city}'`);
  return municipalityId;
}

async function ensureDivisionId(client: TripletexClient, companyId: number | undefined, startDate: string): Promise<number> {
  const existingId = await findExistingDivisionId(client);
  if (existingId > 0) return existingId;
  try {
    const municipalityId = await resolveMunicipalityId(client, companyId);
    const created = await client.request("POST", "/division", {
      body: {
        name: DEFAULT_DIVISION_NAME,
        startDate,
        organizationNumber: DEFAULT_DIVISION_ORG_NUMBER,
        municipalityDate: startDate,
        municipality: { id: municipalityId },
      },
    });
    const divisionId = Number(toRecord(primaryValue(created)).id ?? 0);
    if (divisionId > 0) return divisionId;
  } catch {
    const retryExistingId = await findExistingDivisionId(client);
    if (retryExistingId > 0) return retryExistingId;
  }
  throw new Error("Division creation did not return an id");
}

function employmentIsActive(record: EmploymentRecord, startDate: string): boolean {
  if (!record.startDate) return false;
  if (record.startDate > startDate) return false;
  if (record.endDate && record.endDate < startDate) return false;
  return true;
}

async function ensureEmployment(client: TripletexClient, employeeId: number, startDate: string, divisionId: number | null): Promise<EmploymentRecord> {
  const response = await client.request("GET", "/employee/employment", {
    params: { employeeId, count: 20, fields: "id,version,startDate,endDate,division(id)" },
  });
  const active = responseValues(response)
    .map((item) => employmentFromRecord(item))
    .find((item) => employmentIsActive(item, startDate));
  if (active?.id) {
    if (divisionId && active.divisionId !== divisionId) {
      await client.request("PUT", `/employee/employment/${active.id}`, {
        body: { version: active.version ?? 0, division: { id: divisionId } },
      });
      const refreshed = await client.request("GET", `/employee/employment/${active.id}`, { params: { fields: "id,version,startDate,endDate,division(id)" } });
      return employmentFromRecord(primaryValue(refreshed));
    }
    return active;
  }

  try {
    const body: Record<string, unknown> = {
      employee: { id: employeeId },
      startDate,
      isMainEmployer: true,
    };
    if (divisionId) body.division = { id: divisionId };
    const created = await client.request("POST", "/employee/employment", {
      body,
    });
    const employment = employmentFromRecord(primaryValue(created));
    if (employment.id <= 0) throw new Error("Employment creation did not return an id");
    return employment;
  } catch (error) {
    if (error instanceof TripletexError && error.statusCode === 422) {
      const retry = await client.request("GET", "/employee/employment", {
        params: { employeeId, count: 20, fields: "id,version,startDate,endDate,division(id)" },
      });
      const recovered = responseValues(retry)
        .map((item) => employmentFromRecord(item))
        .find((item) => employmentIsActive(item, startDate));
      if (recovered?.id) return recovered;
    }
    throw error;
  }
}

async function resolveOccupationCodeId(client: TripletexClient, values: Record<string, unknown>): Promise<number | undefined> {
  const code = resolveOccupationCode(values);
  if (!code) return undefined;
  try {
    const response = await client.request("GET", "/employee/employment/occupationCode", {
      params: { code, count: 20, fields: "id,code,nameNO" },
    });
    const exact = responseValues(response).find((item) => textMatches(toRecord(item).code, code));
    const occupationId = Number(toRecord(exact).id ?? 0);
    if (occupationId > 0) return occupationId;
    delete values.occupationCode;
    return undefined;
  } catch {
    delete values.occupationCode;
    return undefined;
  }
}

function employmentDetailsMatch(
  record: EmploymentDetailsRecord,
  startDate: string,
  annualSalary: number | null,
  percentage: number | null,
  occupationCode: string | null,
): boolean {
  if (record.id <= 0) return false;
  if (record.date && record.date > startDate) return false;
  if (annualSalary !== null && annualSalary > 0) {
    const actualAnnual = record.annualSalary ?? (record.monthlySalary ? roundMoney(record.monthlySalary * 12) : undefined);
    if (actualAnnual == null || Math.abs(actualAnnual - annualSalary) > 0.01) return false;
  }
  if (percentage !== null && percentage > 0) {
    if (record.percentageOfFullTimeEquivalent == null || Math.abs(record.percentageOfFullTimeEquivalent - percentage) > 0.01) return false;
  }
  if (occupationCode && !textMatches(record.occupationCode, occupationCode)) return false;
  return true;
}

async function ensureEmploymentDetails(
  client: TripletexClient,
  values: Record<string, unknown>,
  employmentId: number,
  startDate: string,
): Promise<EmploymentDetailsRecord | null> {
  const annualSalary = resolveAnnualSalary(values);
  const percentage = resolveEmploymentPercentage(values) ?? 100;
  const occupationCode = resolveOccupationCode(values);
  const occupationCodeId = await resolveOccupationCodeId(client, values);

  const response = await client.request("GET", "/employee/employment/details", {
    params: { employmentId, count: 20, fields: "id,date,annualSalary,monthlySalary,percentageOfFullTimeEquivalent,occupationCode(id,code,nameNO)" },
  });
  const existing = responseValues(response)
    .map((item) => employmentDetailsFromRecord(item))
    .find((item) => employmentDetailsMatch(item, startDate, annualSalary, percentage, occupationCode));
  if (existing?.id) return existing;

  const body: Record<string, unknown> = {
    employment: { id: employmentId },
    date: startDate,
    employmentType: "ORDINARY",
    employmentForm: "PERMANENT",
    remunerationType: annualSalary !== null && annualSalary > 0 ? "MONTHLY_WAGE" : "NOT_CHOSEN",
    workingHoursScheme: "NOT_SHIFT",
    percentageOfFullTimeEquivalent: percentage,
  };
  if (annualSalary !== null && annualSalary > 0) body.annualSalary = annualSalary;
  if (occupationCodeId) body.occupationCode = { id: occupationCodeId };

  try {
    const created = await client.request("POST", "/employee/employment/details", { body });
    const details = employmentDetailsFromRecord(primaryValue(created));
    if (details.id > 0) return details;
  } catch (error) {
    if (!(error instanceof TripletexError) || error.statusCode !== 422) {
      throw error;
    }
  }

  const retry = await client.request("GET", "/employee/employment/details", {
    params: { employmentId, count: 20, fields: "id,date,annualSalary,monthlySalary,percentageOfFullTimeEquivalent,occupationCode(id,code,nameNO)" },
  });
  const recovered = responseValues(retry)
    .map((item) => employmentDetailsFromRecord(item))
    .find((item) => employmentDetailsMatch(item, startDate, annualSalary, percentage, occupationCode));
  return recovered ?? null;
}

async function applyEntitlements(client: TripletexClient, values: Record<string, unknown>, employeeId: number): Promise<void> {
  const template = resolveEntitlementTemplate(values);
  if (!template) return;
  try {
    await client.request("PUT", "/employee/entitlement/:grantEntitlementsByTemplate", {
      params: { employeeId, template },
    });
  } catch {
    values.__entitlementApplyFailed = true;
  }
}

export function matchesAttachmentOnboardingWorkflow(spec: AttachmentOnboardingSpec): boolean {
  return spec.entity === "attachment_onboarding" && spec.operation === "create";
}

export function compileAttachmentOnboardingPreview(op: TaskOperation, rawValues: Record<string, unknown>): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List employees for onboarding review",
      steps: [{ method: "GET", path: "/employee", params: { count: 20, fields: "id,firstName,lastName,email,dateOfBirth,userType" } }],
    };
  }

  const values = toRecord(rawValues);
  sanitizeIdentityValues(values);
  const displayName = resolveDisplayName(values);
  const startDate = employmentStartDate(values);
  const annualSalary = resolveAnnualSalary(values);
  const percentage = resolveEmploymentPercentage(values) ?? 100;

  const steps: PlanStep[] = [];
  pushStep(steps, "GET", "/department", { params: { count: 50, fields: "id,name" } });
  pushStep(steps, "POST", "/department", { body: { name: values.departmentName ?? DEFAULT_DEPARTMENT_NAME } });
  pushStep(steps, "GET", "/employee", { params: { count: 5, fields: "id,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,companyId,department(id,name)" } });
  pushStep(steps, "POST", "/employee", { body: { email: values.email, dateOfBirth: values.dateOfBirth ?? DEFAULT_DOB } });
  pushStep(steps, "GET", "/division", { params: { count: 20, fields: "id,name,organizationNumber" } });
  pushStep(steps, "POST", "/employee/employment", { body: { employee: { id: "{{employee_id}}" }, startDate, isMainEmployer: true } });
  pushStep(steps, "GET", "/employee/employment/occupationCode", { params: { count: 20, fields: "id,code,nameNO", ...(values.occupationCode ? { code: values.occupationCode } : {}) } });
  pushStep(steps, "POST", "/employee/employment/details", {
    body: {
      employment: { id: "{{employment_id}}" },
      date: startDate,
      employmentType: "ORDINARY",
      employmentForm: "PERMANENT",
      remunerationType: annualSalary ? "MONTHLY_WAGE" : "NOT_CHOSEN",
      workingHoursScheme: "NOT_SHIFT",
      percentageOfFullTimeEquivalent: percentage,
      ...(annualSalary ? { annualSalary } : {}),
    },
  });
  const template = resolveEntitlementTemplate(values);
  if (template) {
    pushStep(steps, "PUT", "/employee/entitlement/:grantEntitlementsByTemplate", { params: { employeeId: "{{employee_id}}", template } });
  }

  return {
    summary: `Onboard employee ${displayName}`,
    steps,
  };
}

export async function executeAttachmentOnboardingWorkflow(
  client: TripletexClient,
  spec: AttachmentOnboardingSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  sanitizeIdentityValues(values);
  const preview = compileAttachmentOnboardingPreview(spec.operation, values);
  if (dryRun) return preview;

  const startDate = employmentStartDate(values);
  const departmentId = await ensureDepartmentId(client, values);
  const employee = await ensureEmployee(client, values, departmentId);
  values.__employeeId = employee.id;
  let divisionId: number | null = null;
  try {
    divisionId = await ensureDivisionId(client, employee.companyId, startDate);
    values.__divisionId = divisionId;
  } catch {
    values.__divisionProvisioningFailed = true;
  }
  const employment = await ensureEmployment(client, employee.id, startDate, divisionId);
  values.__employmentId = employment.id;
  const employmentDetails = await ensureEmploymentDetails(client, values, employment.id, startDate);
  if (employmentDetails?.id) values.__employmentDetailsId = employmentDetails.id;
  await applyEntitlements(client, values, employee.id);

  return {
    summary: `Onboard employee ${resolveDisplayName(values)}`,
    steps: [
      { method: "GET", path: `/employee/${employee.id}`, params: { fields: "id,firstName,lastName,email,dateOfBirth,nationalIdentityNumber,bankAccountNumber,userType,department(id,name)" } },
      { method: "GET", path: "/employee/employment", params: { employeeId: employee.id, count: 20, fields: "id,startDate,endDate,division(id)" } },
      { method: "GET", path: "/employee/employment/details", params: { employmentId: employment.id, count: 20, fields: "id,date,annualSalary,monthlySalary,percentageOfFullTimeEquivalent,occupationCode(id,code,nameNO)" } },
    ],
  };
}

export async function verifyAttachmentOnboardingOutcome(
  client: TripletexClient,
  spec: AttachmentOnboardingSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const expectedName = resolveDisplayName(values);
  const employeeId = Number(values.__employeeId ?? 0);
  const employee = employeeId > 0
    ? await fetchEmployeeById(client, employeeId)
    : await findEmployee(client, values);

  if (!employee?.id) {
    return { verified: false, detail: `employee '${expectedName}' not found after onboarding`, required: true };
  }

  const fullName = `${employee.firstName ?? ""} ${employee.lastName ?? ""}`.trim();
  if (!textMatches(fullName, expectedName)) {
    return { verified: false, detail: "employee name mismatch after onboarding", required: true };
  }
  if (typeof values.email === "string" && values.email.trim() && !textMatches(employee.email, values.email)) {
    return { verified: false, detail: "employee email mismatch after onboarding", required: true };
  }
  if (typeof values.dateOfBirth === "string" && values.dateOfBirth.trim() && !textMatches(employee.dateOfBirth, values.dateOfBirth)) {
    return { verified: false, detail: "employee birth date mismatch after onboarding", required: true };
  }
  if (typeof values.nationalIdentityNumber === "string" && values.nationalIdentityNumber.trim() && !textMatches(employee.nationalIdentityNumber, values.nationalIdentityNumber)) {
    return { verified: false, detail: "employee national identity mismatch after onboarding", required: true };
  }
  if (typeof values.bankAccountNumber === "string" && values.bankAccountNumber.trim() && !textMatches(employee.bankAccountNumber, values.bankAccountNumber)) {
    return { verified: false, detail: "employee bank account mismatch after onboarding", required: true };
  }
  if (typeof values.departmentName === "string" && values.departmentName.trim() && !textMatches(employee.departmentName, values.departmentName)) {
    return { verified: false, detail: "employee department mismatch after onboarding", required: true };
  }
  const entitlementTemplateName = resolveEntitlementTemplate(values);
  if (entitlementTemplateName) {
    const entitlementResponse = await client.request("GET", "/employee/entitlement", {
      params: { employeeId: employee.id, count: 200, fields: "id,name" },
    });
    const entitlementCount = responseValues(entitlementResponse).length;
    if (entitlementCount <= 0) {
      return { verified: false, detail: "employee access entitlements missing after onboarding", required: true };
    }
  }

  const startDate = employmentStartDate(values);
  const employmentResponse = await client.request("GET", "/employee/employment", {
    params: { employeeId: employee.id, count: 20, fields: "id,version,startDate,endDate,division(id)" },
  });
  const employment = responseValues(employmentResponse)
    .map((item) => employmentFromRecord(item))
    .find((item) => textMatches(item.startDate, startDate) || employmentIsActive(item, startDate));
  if (!employment?.id) {
    return { verified: false, detail: "employment start date not found after onboarding", required: true };
  }

  const annualSalary = resolveAnnualSalary(values);
  const percentage = resolveEmploymentPercentage(values);
  const occupationCode = resolveOccupationCode(values);
  const detailsResponse = await client.request("GET", "/employee/employment/details", {
    params: { employmentId: employment.id, count: 20, fields: "id,date,annualSalary,monthlySalary,percentageOfFullTimeEquivalent,occupationCode(id,code,nameNO)" },
  });
  const details = responseValues(detailsResponse)
    .map((item) => employmentDetailsFromRecord(item))
    .find((item) => employmentDetailsMatch(item, startDate, annualSalary, percentage, occupationCode));
  if (!details?.id) {
    return { verified: false, detail: "employment details mismatch after onboarding", required: true };
  }

  return { verified: true, detail: "attachment onboarding verified via employee/employment/details", required: true };
}
