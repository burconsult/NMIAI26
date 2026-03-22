import type { ExecutionPlan } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type PayrollSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

const DEFAULT_DEPARTMENT_NAME = "Payroll";
const DEFAULT_DIVISION_NAME = "AI Payroll Unit";
const DEFAULT_DIVISION_ORG_NUMBER = "100000008";
const DEFAULT_DOB = "1990-01-15";

type Verification = { verified: boolean; detail: string; required: boolean };

type EmployeeRecord = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  dateOfBirth?: string;
  companyId?: number;
};

type EmploymentRecord = {
  id: number;
  version?: number;
  divisionId?: number;
};

export function matchesPayrollWorkflow(spec: PayrollSpec): boolean {
  return spec.entity === "salary_transaction" && spec.operation === "create";
}

export function compilePayrollPreview(op: string, values: Record<string, unknown>): ExecutionPlan {
  if (op !== "create") {
    return {
      summary: "List salary transactions",
      steps: [{ method: "GET", path: "/salary/payslip", params: { count: 20, fields: "id,employee(id),year,month" } }],
    };
  }

  const employeeEmail = typeof values.email === "string" ? values.email : undefined;
  const employeeName = typeof values.employeeName === "string" ? values.employeeName : typeof values.name === "string" ? values.name : undefined;
  const title = employeeEmail ?? employeeName ?? "employee";
  return {
    summary: `Create payroll transaction for ${title}`,
    steps: [
      { method: "GET", path: "/employee", params: { count: 5, fields: "id,firstName,lastName,email,dateOfBirth,companyId" } },
      { method: "GET", path: "/department", params: { count: 1, fields: "id,name" } },
      { method: "POST", path: "/employee", body: { email: employeeEmail ?? "employee@example.org" } },
      { method: "GET", path: "/employee/employment", params: { count: 5, fields: "id,version,startDate,endDate,division(id)", employeeId: "{{employee_id}}" } },
      { method: "POST", path: "/employee/employment", body: { employee: { id: "{{employee_id}}" }, startDate: monthStartIso(resolveYearMonth(values).year, resolveYearMonth(values).month), isMainEmployer: true } },
      { method: "GET", path: "/employee/employment/details", params: { count: 5, fields: "id,date,annualSalary,monthlySalary", employmentId: "{{employment_id}}" } },
      { method: "POST", path: "/employee/employment/details", body: { employment: { id: "{{employment_id}}" }, date: monthStartIso(resolveYearMonth(values).year, resolveYearMonth(values).month), employmentType: "ORDINARY", employmentForm: "PERMANENT", remunerationType: "MONTHLY_WAGE", workingHoursScheme: "NOT_SHIFT", percentageOfFullTimeEquivalent: 100, annualSalary: 12 } },
      { method: "GET", path: "/division", params: { count: 5, query: DEFAULT_DIVISION_NAME, fields: "id,name,organizationNumber" } },
      { method: "POST", path: "/division", body: { name: DEFAULT_DIVISION_NAME, organizationNumber: DEFAULT_DIVISION_ORG_NUMBER } },
      { method: "PUT", path: "/employee/employment/{{employment_id}}", body: { division: { id: "{{division_id}}" } } },
      { method: "GET", path: "/salary/type", params: { count: 20, fields: "id,number,name" } },
      { method: "POST", path: "/salary/transaction", body: { month: resolveYearMonth(values).month, year: resolveYearMonth(values).year, payslips: [{ employee: { id: "{{employee_id}}" }, specifications: [] }] } },
      { method: "GET", path: "/salary/payslip", params: { count: 10, fields: "id,employee(id),year,month" } },
    ],
  };
}

export async function executePayrollWorkflow(
  client: TripletexClient,
  spec: PayrollSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compilePayrollPreview(spec.operation, values);
  if (dryRun) return preview;

  const period = resolveYearMonth(values);
  const periodDate = toDateIso(values.date) ?? todayIsoInZone();
  const periodStart = monthStartIso(period.year, period.month);
  const baseSalary = toNumber(values.baseSalaryAmount ?? values.baseSalary ?? values.amount);
  if (!baseSalary || baseSalary <= 0) {
    throw new Error("Payroll workflow requires a base salary amount");
  }
  const bonusAmount = Math.max(0, toNumber(values.bonusAmount) ?? 0);

  const employee = await ensurePayrollEmployee(client, values, periodStart);
  values.__employeeId = employee.id;
  let divisionId: number | null = null;
  try {
    divisionId = await ensureManagedDivision(client, employee.companyId, periodStart);
    values.__divisionId = divisionId;
  } catch {
    values.__divisionProvisioningFailed = true;
  }
  const employment = await ensureEmployment(client, employee.id, periodStart, divisionId);
  await ensureEmploymentDetails(client, employment.id, baseSalary, periodStart);
  if (divisionId) {
    await ensureEmploymentDivision(client, employment.id, divisionId);
  }

  const existingPayslip = await findMatchingPayslip(client, employee.id, period.year, period.month, baseSalary, bonusAmount);
  if (existingPayslip) {
    values.__createdPayslipId = Number(existingPayslip.id ?? 0);
    return {
      summary: `Payroll already exists for employee ${employee.id} in ${period.year}-${String(period.month).padStart(2, "0")}`,
      steps: [
        { method: "GET", path: "/salary/payslip", params: { employeeId: employee.id, ...payslipPeriodParams(period.year, period.month), count: 20 } },
        { method: "GET", path: `/salary/payslip/${existingPayslip.id}`, params: { fields: "id,employee(id,email),year,month,specifications(description,rate,count,salaryType(id,number,name))" } },
      ],
    };
  }

  const salaryTypes = await resolveSalaryTypes(client);
  let response: unknown;
  try {
    response = await client.request("POST", "/salary/transaction", {
      params: { generateTaxDeduction: false },
      body: {
        date: periodDate,
        year: period.year,
        month: period.month,
        payslips: [
          {
            employee: { id: employee.id },
            specifications: [
              {
                salaryType: { id: salaryTypes.baseSalaryTypeId },
                description: "Fastlønn",
                count: 1,
                rate: baseSalary,
              },
              ...(bonusAmount > 0
                ? [{ salaryType: { id: salaryTypes.bonusTypeId }, description: "Bonus", count: 1, rate: bonusAmount }]
                : []),
            ],
          },
        ],
      },
    });
  } catch (error) {
    if (error instanceof TripletexError && isRecoverablePayrollConflict(error)) {
      const recoveredPayslip = await findMatchingPayslip(client, employee.id, period.year, period.month, baseSalary, bonusAmount);
      if (recoveredPayslip) {
        values.__createdPayslipId = Number(recoveredPayslip.id ?? 0);
        return {
          summary: `Payroll already exists for employee ${employee.id} in ${period.year}-${String(period.month).padStart(2, "0")}`,
          steps: [
            { method: "GET", path: "/salary/payslip", params: { employeeId: employee.id, ...payslipPeriodParams(period.year, period.month), count: 20 } },
            { method: "GET", path: `/salary/payslip/${recoveredPayslip.id}`, params: { fields: "id,employee(id,email),year,month,specifications(description,rate,count,salaryType(id,number,name))" } },
          ],
        };
      }
    }
    throw error;
  }
  const transaction = primaryValue(response) as Record<string, unknown> | undefined;
  const payslips = Array.isArray(transaction?.payslips) ? transaction?.payslips as Array<Record<string, unknown>> : [];
  const payslipId = Number(payslips[0]?.id ?? 0);
  if (payslipId > 0) values.__createdPayslipId = payslipId;

  return {
    summary: `Create payroll transaction for employee ${employee.id}`,
    steps: [
      { method: "GET", path: "/employee", params: { email: employee.email ?? undefined, count: 5, fields: "id,firstName,lastName,email" } },
      { method: "GET", path: "/employee/employment", params: { employeeId: employee.id, count: 5, fields: "id,version,startDate,endDate,division(id)" } },
      { method: "GET", path: "/employee/employment/details", params: { employmentId: employment.id, count: 5, fields: "id,date,annualSalary,monthlySalary" } },
      { method: "GET", path: "/salary/type", params: { count: 20, fields: "id,number,name" } },
      { method: "POST", path: "/salary/transaction", body: { year: period.year, month: period.month, payslips: [{ employee: { id: employee.id } }] }, saveAs: "salaryTransaction" },
      ...(payslipId > 0
        ? [{ method: "GET" as const, path: `/salary/payslip/${payslipId}`, params: { fields: "id,employee(id,email),year,month,specifications(description,rate,count,salaryType(id,number,name))" } }]
        : []),
    ] satisfies ExecutionPlan["steps"],
  };
}

export async function verifyPayrollOutcome(client: TripletexClient, spec: PayrollSpec): Promise<Verification> {
  const values = toRecord(spec.values);
  const employee = await findPayrollEmployee(client, values);
  if (!employee?.id) {
    const employeeName = String(values.employeeName ?? values.name ?? values.email ?? "employee").trim();
    return { verified: false, detail: `employee '${employeeName}' not found for payroll verification`, required: true };
  }

  const period = resolveYearMonth(values);
  const baseSalary = toNumber(values.baseSalaryAmount ?? values.baseSalary ?? values.amount);
  const bonusAmount = Math.max(0, toNumber(values.bonusAmount) ?? 0);
  if (!baseSalary || baseSalary <= 0) {
    return { verified: false, detail: "base salary missing for payroll verification", required: true };
  }

  const createdPayslipId = Number(values.__createdPayslipId ?? 0);
  if (createdPayslipId > 0) {
    const detail = await fetchPayslipDetail(client, createdPayslipId);
    if (payslipMatches(detail, period.year, period.month, baseSalary, bonusAmount)) {
      return { verified: true, detail: "salary transaction verified via returned payslip id", required: true };
    }
  }

  const payslip = await findMatchingPayslip(client, employee.id, period.year, period.month, baseSalary, bonusAmount);
  if (!payslip) {
    return { verified: false, detail: "matching payslip not found after payroll run", required: true };
  }
  return { verified: true, detail: "salary transaction verified via payslip specifications", required: true };
}

async function ensurePayrollEmployee(
  client: TripletexClient,
  values: Record<string, unknown>,
  periodStart: string,
): Promise<EmployeeRecord> {
  const found = await findPayrollEmployee(client, values);
  if (found?.id) return found;

  const departmentId = await ensureDepartmentId(client);
  const person = splitName(String(values.employeeName ?? values.name ?? emailToName(values.email) ?? "Payroll Employee"));
  try {
    const response = await client.request("POST", "/employee", {
      body: {
        firstName: person.firstName,
        lastName: person.lastName,
        email: typeof values.email === "string" ? values.email : undefined,
        dateOfBirth: typeof values.dateOfBirth === "string" ? values.dateOfBirth : DEFAULT_DOB,
        userType: "NO_ACCESS",
        department: { id: departmentId },
        comments: `Created by Tripletex solver for payroll period ${periodStart}`,
      },
    });
    return employeeFromRecord(primaryValue(response));
  } catch (error) {
    if (error instanceof TripletexError && isRecoverablePayrollConflict(error)) {
      const recovered = await findPayrollEmployee(client, values);
      if (recovered?.id) return recovered;
    }
    throw error;
  }
}

async function findPayrollEmployee(client: TripletexClient, values: Record<string, unknown>): Promise<EmployeeRecord | null> {
  const email = typeof values.email === "string" ? values.email : undefined;
  if (email) {
    const response = await client.request("GET", "/employee", {
      params: { email, count: 5, fields: "id,firstName,lastName,email,dateOfBirth,companyId,department(id)" },
    });
    const employee = employeeFromRecord(primaryValue(response));
    if (employee.id) return employee;
  }

  const name = typeof values.employeeName === "string"
    ? values.employeeName
    : typeof values.name === "string"
      ? values.name
      : emailToName(values.email);
  if (!name) return null;
  const person = splitName(name);
  const response = await client.request("GET", "/employee", {
    params: { firstName: person.firstName, lastName: person.lastName, count: 5, fields: "id,firstName,lastName,email,dateOfBirth,companyId,department(id)" },
  });
  const employee = employeeFromRecord(primaryValue(response));
  return employee.id ? employee : null;
}

async function ensureDepartmentId(client: TripletexClient): Promise<number> {
  const response = await client.request("GET", "/department", { params: { count: 1, fields: "id,name" } });
  const department = primaryValue(response) as Record<string, unknown> | undefined;
  const departmentId = Number(department?.id ?? 0);
  if (departmentId > 0) return departmentId;

  try {
    const created = await client.request("POST", "/department", { body: { name: DEFAULT_DEPARTMENT_NAME } });
    const createdDepartment = primaryValue(created) as Record<string, unknown> | undefined;
    const createdId = Number(createdDepartment?.id ?? 0);
    if (createdId > 0) return createdId;
  } catch (error) {
    if (!(error instanceof TripletexError) || !isRecoverablePayrollConflict(error)) {
      throw error;
    }
  }
  const fallback = await client.request("GET", "/department", { params: { count: 10, fields: "id,name" } });
  const existingDepartment = responseValues(fallback).find((item) => normalizedText(toRecord(item).name) === normalizedText(DEFAULT_DEPARTMENT_NAME));
  const fallbackId = Number(toRecord(existingDepartment).id ?? 0);
  if (fallbackId > 0) return fallbackId;
  throw new Error("Unable to resolve or create department for payroll employee");
}

async function ensureEmployment(client: TripletexClient, employeeId: number, periodStart: string, divisionId: number | null): Promise<EmploymentRecord> {
  const response = await client.request("GET", "/employee/employment", {
    params: { employeeId, count: 10, fields: "id,version,startDate,endDate,division(id)" },
  });
  const values = responseValues(response);
  const active = values.find((item) => isEmploymentActive(item, periodStart));
  if (active) return employmentFromRecord(active);

  try {
    const created = await client.request("POST", "/employee/employment", {
      body: {
        employee: { id: employeeId },
        startDate: periodStart,
        ...(divisionId ? { division: { id: divisionId } } : {}),
        isMainEmployer: true,
      },
    });
    return employmentFromRecord(primaryValue(created));
  } catch (error) {
    if (error instanceof TripletexError && isRecoverablePayrollConflict(error)) {
      const retry = await client.request("GET", "/employee/employment", {
        params: { employeeId, count: 10, fields: "id,version,startDate,endDate,division(id)" },
      });
      const retriedActive = responseValues(retry).find((item) => isEmploymentActive(item, periodStart));
      if (retriedActive) return employmentFromRecord(retriedActive);
    }
    throw error;
  }
}

async function ensureEmploymentDetails(client: TripletexClient, employmentId: number, baseSalary: number, periodStart: string): Promise<void> {
  const response = await client.request("GET", "/employee/employment/details", {
    params: { employmentId, count: 10, fields: "id,date,annualSalary,monthlySalary" },
  });
  const values = responseValues(response);
  const existing = values.find((item) => String(toRecord(item).date ?? "") <= periodStart);
  if (existing) return;

  try {
    await client.request("POST", "/employee/employment/details", {
      body: {
        employment: { id: employmentId },
        date: periodStart,
        employmentType: "ORDINARY",
        employmentForm: "PERMANENT",
        remunerationType: "MONTHLY_WAGE",
        workingHoursScheme: "NOT_SHIFT",
        percentageOfFullTimeEquivalent: 100,
        annualSalary: Math.round(baseSalary * 12 * 100) / 100,
      },
    });
  } catch (error) {
    if (error instanceof TripletexError && isRecoverablePayrollConflict(error)) {
      const retry = await client.request("GET", "/employee/employment/details", {
        params: { employmentId, count: 10, fields: "id,date,annualSalary,monthlySalary" },
      });
      const recovered = responseValues(retry).find((item) => String(toRecord(item).date ?? "") <= periodStart);
      if (recovered) return;
    }
    throw error;
  }
}

async function ensureManagedDivision(client: TripletexClient, companyId: number | undefined, periodStart: string): Promise<number> {
  const existingId = await findManagedDivisionId(client);
  if (existingId > 0) return existingId;

  const municipalityId = await resolveMunicipalityId(client, companyId);
  let created: unknown;
  try {
    created = await client.request("POST", "/division", {
      body: {
        name: DEFAULT_DIVISION_NAME,
        startDate: periodStart,
        organizationNumber: DEFAULT_DIVISION_ORG_NUMBER,
        municipalityDate: periodStart,
        municipality: { id: municipalityId },
      },
    });
  } catch (error) {
    if (error instanceof TripletexError && error.statusCode === 422) {
      const fallbackId = await findManagedDivisionId(client);
      if (fallbackId > 0) return fallbackId;
    }
    throw error;
  }
  const division = primaryValue(created) as Record<string, unknown> | undefined;
  const divisionId = Number(division?.id ?? 0);
  if (divisionId <= 0) {
    throw new Error("Failed to create payroll division");
  }
  return divisionId;
}

async function findManagedDivisionId(client: TripletexClient): Promise<number> {
  for (const query of [DEFAULT_DIVISION_NAME, DEFAULT_DIVISION_ORG_NUMBER]) {
    const existing = await client.request("GET", "/division", {
      params: { query, count: 5, fields: "id,name,organizationNumber" },
    });
    const existingDivision = responseValues(existing).find((item) => {
      const record = toRecord(item);
      return normalizedText(record.name) === normalizedText(DEFAULT_DIVISION_NAME)
        || String(record.organizationNumber ?? "").trim() === DEFAULT_DIVISION_ORG_NUMBER;
    });
    const existingId = Number(toRecord(existingDivision).id ?? 0);
    if (existingId > 0) return existingId;
  }
  return 0;
}

async function ensureEmploymentDivision(client: TripletexClient, employmentId: number, divisionId: number): Promise<void> {
  const response = await client.request("GET", `/employee/employment/${employmentId}`, {
    params: { fields: "id,version,division(id)" },
  });
  const employment = toRecord(primaryValue(response));
  const currentDivisionId = Number(toRecord(employment.division).id ?? 0);
  if (currentDivisionId === divisionId) return;
  const version = Number(employment.version ?? 0);
  await client.request("PUT", `/employee/employment/${employmentId}`, {
    body: {
      version,
      division: { id: divisionId },
    },
  });
}

async function resolveMunicipalityId(client: TripletexClient, companyId: number | undefined): Promise<number> {
  let city = "Oslo";
  if (companyId && Number.isFinite(companyId)) {
    const response = await client.request("GET", `/company/${companyId}`, {
      params: { fields: "address(city)" },
    });
    const company = toRecord(primaryValue(response));
    const companyAddress = toRecord(company.address);
    if (typeof companyAddress.city === "string" && companyAddress.city.trim()) {
      city = companyAddress.city.trim();
    }
  }

  const response = await client.request("GET", "/municipality/query", {
    params: { query: city, count: 1, fields: "id,name" },
  });
  const municipality = primaryValue(response) as Record<string, unknown> | undefined;
  const municipalityId = Number(municipality?.id ?? 0);
  if (municipalityId > 0) return municipalityId;
  throw new Error(`Unable to resolve municipality for city '${city}'`);
}

async function resolveSalaryTypes(client: TripletexClient): Promise<{ baseSalaryTypeId: number; bonusTypeId: number }> {
  const response = await client.request("GET", "/salary/type", {
    params: { count: 50, fields: "id,number,name,description" },
  });
  const values = responseValues(response);
  const baseSalary = values.find((item) => {
    const record = toRecord(item);
    return String(record.number ?? "") === "2000" || normalizedText(record.name).includes("fastlønn");
  });
  const bonus = values.find((item) => {
    const record = toRecord(item);
    return String(record.number ?? "") === "2002" || normalizedText(record.name).includes("bonus");
  });
  const baseSalaryTypeId = Number(toRecord(baseSalary).id ?? 0);
  const bonusTypeId = Number(toRecord(bonus).id ?? 0);
  if (baseSalaryTypeId <= 0 || bonusTypeId <= 0) {
    throw new Error("Required salary types (Fastlønn/Bonus) not available");
  }
  return { baseSalaryTypeId, bonusTypeId };
}

async function findMatchingPayslip(
  client: TripletexClient,
  employeeId: number,
  year: number,
  month: number,
  baseSalary: number,
  bonusAmount: number,
): Promise<Record<string, unknown> | null> {
  const response = await client.request("GET", "/salary/payslip", {
    params: {
      employeeId,
      ...payslipPeriodParams(year, month),
      count: 20,
      fields: "id,employee(id),year,month,grossAmount",
    },
  });
  const payslips = responseValues(response).filter((item) => {
    const record = toRecord(item);
    return Number(record.year ?? 0) === year && Number(record.month ?? 0) === month;
  });

  for (const payslip of payslips) {
    const payslipId = Number(toRecord(payslip).id ?? 0);
    if (payslipId <= 0) continue;
    const detail = await fetchPayslipDetail(client, payslipId);
    if (payslipMatches(detail, year, month, baseSalary, bonusAmount)) return detail;
  }

  return null;
}

async function fetchPayslipDetail(client: TripletexClient, payslipId: number): Promise<Record<string, unknown>> {
  const detailResponse = await client.request("GET", `/salary/payslip/${payslipId}`, {
    params: { fields: "id,employee(id,email),year,month,grossAmount,specifications(description,rate,count,amount,salaryType(id,number,name))" },
  });
  return toRecord(primaryValue(detailResponse));
}

function payslipMatches(
  detail: Record<string, unknown>,
  year: number,
  month: number,
  baseSalary: number,
  bonusAmount: number,
): boolean {
  if (Number(detail.year ?? 0) !== year || Number(detail.month ?? 0) !== month) return false;
  const specs = Array.isArray(detail.specifications) ? detail.specifications as Array<unknown> : [];
  const baseMatch = specs.some((item) => specificationMatches(item, ["2000", "fastlønn"], baseSalary));
  const bonusMatch = bonusAmount > 0 ? specs.some((item) => specificationMatches(item, ["2002", "bonus"], bonusAmount)) : true;
  return baseMatch && bonusMatch;
}

function specificationMatches(item: unknown, typeHints: string[], expectedAmount: number): boolean {
  const specification = toRecord(item);
  const salaryType = toRecord(specification.salaryType);
  const typeNumber = normalizedText(salaryType.number);
  const typeName = normalizedText(salaryType.name);
  const rate = toNumber(specification.rate);
  const amount = toNumber(specification.amount);
  const count = toNumber(specification.count) ?? 1;
  const effectiveAmount = amount ?? ((rate ?? 0) * count);
  const typeMatches = typeHints.some((hint) => typeNumber === hint || typeName.includes(normalizedText(hint)));
  return typeMatches && Math.abs((effectiveAmount ?? 0) - expectedAmount) < 0.01;
}

function resolveYearMonth(values: Record<string, unknown>): { year: number; month: number } {
  const sourceDate = toDateIso(values.date) ?? todayIsoInZone();
  const [yearPart, monthPart] = sourceDate.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  return {
    year: Number.isFinite(year) && year > 1900 ? year : new Date().getUTCFullYear(),
    month: Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1,
  };
}

function monthStartIso(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function payslipPeriodParams(year: number, month: number): Record<string, number> {
  return {
    yearFrom: year,
    yearTo: year + 1,
    monthFrom: month,
    monthTo: month === 12 ? 13 : month + 1,
  };
}

function employeeFromRecord(value: unknown): EmployeeRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    firstName: typeof record.firstName === "string" ? record.firstName : undefined,
    lastName: typeof record.lastName === "string" ? record.lastName : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    dateOfBirth: typeof record.dateOfBirth === "string" ? record.dateOfBirth : undefined,
    companyId: Number(record.companyId ?? 0) || undefined,
  };
}

function employmentFromRecord(value: unknown): EmploymentRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    version: Number(record.version ?? 0) || undefined,
    divisionId: Number(toRecord(record.division).id ?? 0) || undefined,
  };
}

function isEmploymentActive(value: unknown, periodStart: string): boolean {
  const record = toRecord(value);
  const startDate = String(record.startDate ?? "");
  const endDate = String(record.endDate ?? "");
  if (!startDate) return false;
  if (startDate > periodStart) return false;
  if (endDate && endDate < periodStart) return false;
  return true;
}

function responseValues(response: unknown): Array<unknown> {
  const record = toRecord(response);
  return Array.isArray(record.values) ? record.values : record.value ? [record.value] : [];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecoverablePayrollConflict(error: TripletexError): boolean {
  if (error.statusCode === 409 || error.statusCode === 422) return true;
  if (error.statusCode !== 400) return false;
  const body = error.responseBody as Record<string, unknown> | undefined;
  const message = `${String(body?.message ?? "")} ${String(body?.developerMessage ?? "")}`.toLowerCase();
  return (
    message.includes("already")
    || message.includes("exists")
    || message.includes("duplicate")
    || message.includes("conflict")
    || message.includes("finnes")
  );
}

function toDateIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Generated", lastName: "Employee" };
  if (parts.length === 1) return { firstName: parts[0] ?? "Generated", lastName: "Employee" };
  return { firstName: parts[0] ?? "Generated", lastName: parts.slice(1).join(" ") || "Employee" };
}

function emailToName(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const local = value.split("@")[0] ?? "";
  const parts = local
    .split(/[._+-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return parts.length > 0 ? parts.join(" ") : null;
}
