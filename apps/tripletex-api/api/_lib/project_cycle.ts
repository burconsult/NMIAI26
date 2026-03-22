import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { todayIsoInZone } from "./dates.js";
import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type ProjectCycleSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

type Verification = {
  verified: boolean;
  detail: string;
  required: boolean;
};

type CustomerRecord = {
  id: number;
  name?: string;
  organizationNumber?: string;
};

type EmployeeRecord = {
  id: number;
  version?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  userType?: string;
  departmentId?: number;
};

type ProjectRecord = {
  id: number;
  name?: string;
  customerId?: number;
  customerName?: string;
  customerOrganizationNumber?: string;
  projectManagerId?: number;
  projectManagerName?: string;
  projectManagerEmail?: string;
  description?: string;
  isPriceCeiling?: boolean;
  priceCeilingAmount?: number | null;
};

type ActivityRecord = {
  id: number;
  name?: string;
  activityType?: string;
  isChargeable?: boolean;
};

type Assignment = {
  name: string;
  email?: string;
  hours: number;
  isManager?: boolean;
};

const DEFAULT_ACTIVITY_NAME = "Project Work";
const DEFAULT_EMPLOYEE_DOB = "1990-01-15";
const ENTRY_LOOKAHEAD_DAYS = 45;

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

function splitName(name: string | undefined): { firstName: string; lastName: string } {
  if (!name) {
    const suffix = Date.now().toString().slice(-6);
    return { firstName: "Generated", lastName: `ProjectUser${suffix}` };
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "Generated" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function addDaysIso(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function splitHours(totalHours: number): number[] {
  const chunks: number[] = [];
  let remaining = Math.max(0.01, roundMoney(totalHours));
  while (remaining > 24) {
    chunks.push(24);
    remaining = roundMoney(remaining - 24);
  }
  if (remaining > 0.009) chunks.push(roundMoney(remaining));
  return chunks;
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

function quotedProjectName(prompt: string): string | null {
  const match = prompt.match(/['"“”]([^'"“”]{2,120})['"“”]/);
  return match?.[1]?.trim() || null;
}

function resolveProjectName(values: Record<string, unknown>, prompt: string): string {
  const explicit = String(values.projectName ?? values.name ?? "").trim();
  if (explicit) return explicit;
  return quotedProjectName(prompt) ?? `Project Cycle ${Date.now().toString().slice(-6)}`;
}

function resolveCustomerName(values: Record<string, unknown>, prompt: string): string {
  const explicit = String(values.customerName ?? "").trim();
  if (explicit) return explicit;
  const patterns = [
    /\(([^()]+?)\s*,\s*org(?:\.|-)?\s*(?:nr|no|nummer|number)?\s*\.?\s*\d{9}\)/i,
    /\bfor\s+([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ0-9'&.\- ]{2,90}?)(?:\s*\(|[.,\n]|$)/i,
  ];
  for (const pattern of patterns) {
    const candidate = prompt.match(pattern)?.[1]?.trim();
    if (candidate) return candidate;
  }
  return "Generated Customer";
}

function resolveOrganizationNumber(values: Record<string, unknown>, prompt: string): string {
  const explicit = String(values.organizationNumber ?? "").trim();
  if (explicit) return explicit;
  return prompt.match(/\b(\d{9})\b/)?.[1] ?? "";
}

function resolveBudgetAmount(values: Record<string, unknown>, prompt: string): number | null {
  const direct = toNumber(values.budgetAmount ?? values.fixedPriceAmount);
  if (direct !== null && direct > 0) return direct;
  const budgetMatch = prompt.match(
    /(?:budget|budsjett|presupuesto|orcamento|orçamento|budget de|budget von|budgeto)[^\d-]{0,24}(-?\d[\d\s.,]*)/i,
  );
  const parsed = toNumber(budgetMatch?.[1]);
  if (parsed !== null && parsed > 0) return parsed;
  const amount = toNumber(values.amount);
  return amount !== null && amount > 0 ? amount : null;
}

function resolveHourlyRate(values: Record<string, unknown>, prompt: string): number | null {
  const direct = toNumber(values.hourlyRate ?? values.price);
  if (direct !== null && direct > 0) return direct;
  const match = prompt.match(/(?:hourly rate|timesats|timepris|stundensatz|tarifa hor[áa]ria|taux horaire)[^\d-]{0,24}(-?\d[\d\s.,]*)/i);
  const parsed = toNumber(match?.[1]);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function resolveBaseDate(values: Record<string, unknown>): string {
  const explicit = String(values.date ?? values.startDate ?? values.orderDate ?? values.invoiceDate ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(explicit) ? explicit : todayIsoInZone();
}

function wantsPayment(prompt: string): boolean {
  return /\b(?:register payment|registrer betaling|registrer full betaling|full payment|betaling|pagamento|paiement|zahlung|pay the invoice|betaling på denne fakturaen)\b/i.test(prompt);
}

function assignmentComment(projectName: string, assignment: Assignment, chunkIndex: number, chunkCount: number): string {
  const base = `Project cycle ${projectName} ${assignment.name}`.slice(0, 150);
  return chunkCount > 1 ? `${base} (${chunkIndex + 1}/${chunkCount})`.slice(0, 180) : base;
}

function extractAssignments(prompt: string, values: Record<string, unknown>): Assignment[] {
  const assignments: Assignment[] = [];
  const pattern = /([A-ZÆØÅÀ-ÖØ-Ý][A-Za-zÆØÅæøåÀ-ÖØ-öø-ÿ'’.\- ]{1,80})\s*\(([^)]*?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})[^)]*)\)\s*(\d+(?:[.,]\d+)?)\s*(?:hours?|timer|timar|heures?|horas?|stunden)\b/gi;
  for (const match of prompt.matchAll(pattern)) {
    const name = String(match[1] ?? "").trim();
    const meta = String(match[2] ?? "");
    const email = String(match[3] ?? "").trim();
    const hours = toNumber(match[4]);
    if (!name || !email || hours === null || hours <= 0) continue;
    assignments.push({
      name,
      email,
      hours,
      isManager: /\b(?:project manager|prosjektleiar|prosjektleder|projektleiter|chef de projet|gerente de projeto)\b/i.test(meta),
    });
  }
  if (assignments.length > 0) return dedupeAssignments(assignments);

  const fallbackName = String(values.employeeName ?? values.name ?? "").trim();
  const fallbackEmail = String(values.email ?? "").trim();
  const fallbackHours = toNumber(values.hours);
  if (fallbackName && fallbackHours !== null && fallbackHours > 0) {
    return [{ name: fallbackName, email: fallbackEmail || undefined, hours: fallbackHours }];
  }
  return [];
}

function dedupeAssignments(items: Assignment[]): Assignment[] {
  const deduped = new Map<string, Assignment>();
  for (const item of items) {
    const key = normalizeText(item.email || item.name);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...item });
      continue;
    }
    existing.hours = roundMoney(existing.hours + item.hours);
    existing.isManager = existing.isManager || item.isManager;
  }
  return [...deduped.values()];
}

function customerFromValue(value: unknown): CustomerRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    name: typeof record.name === "string" ? record.name : undefined,
    organizationNumber: typeof record.organizationNumber === "string" ? record.organizationNumber : undefined,
  };
}

function employeeFromValue(value: unknown): EmployeeRecord {
  const record = toRecord(value);
  const department = toRecord(record.department);
  return {
    id: Number(record.id ?? 0),
    version: Number(record.version ?? 0) || undefined,
    firstName: typeof record.firstName === "string" ? record.firstName : undefined,
    lastName: typeof record.lastName === "string" ? record.lastName : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    userType: typeof record.userType === "string" ? record.userType : undefined,
    departmentId: Number(department.id ?? 0) || undefined,
  };
}

async function fetchEmployeeById(client: TripletexClient, employeeId: number, steps?: PlanStep[]): Promise<EmployeeRecord | null> {
  if (employeeId <= 0) return null;
  const params = { fields: "id,version,firstName,lastName,email,userType,department(id,name)" };
  const response = await client.request("GET", `/employee/${employeeId}`, { params });
  if (steps) pushStep(steps, "GET", `/employee/${employeeId}`, { params, saveAs: "employee" });
  const employee = employeeFromValue(primaryValue(response));
  return employee.id > 0 ? employee : null;
}

function buildProjectCycleEmployeeBody(
  assignment: Assignment,
  departmentId: number,
  preferredUserType: "STANDARD" | "NO_ACCESS",
): Record<string, unknown> {
  const person = splitName(assignment.name);
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    email: assignment.email || undefined,
    dateOfBirth: DEFAULT_EMPLOYEE_DOB,
    userType: preferredUserType,
    department: { id: departmentId },
  };
}

async function findExactAssignableProjectManager(
  client: TripletexClient,
  assignment: Assignment,
  steps?: PlanStep[],
): Promise<EmployeeRecord | null> {
  const params: Record<string, unknown> = {
    assignableProjectManagers: true,
    count: 20,
    from: 0,
    fields: "id,version,firstName,lastName,email,userType,department(id,name)",
  };
  if (assignment.email) params.email = assignment.email;
  const person = splitName(assignment.name);
  params.firstName = person.firstName;
  params.lastName = person.lastName;
  const response = await client.request("GET", "/employee", { params });
  if (steps) pushStep(steps, "GET", "/employee", { params, saveAs: "projectManager" });
  const exact = responseValues(response)
    .map(employeeFromValue)
    .find((item) =>
      item.id > 0
      && (!assignment.email || textMatches(item.email, assignment.email))
      && textMatches(`${item.firstName ?? ""} ${item.lastName ?? ""}`.trim(), assignment.name)
    );
  return exact ?? null;
}

async function ensureSpecificProjectManager(
  client: TripletexClient,
  employee: EmployeeRecord,
  assignment: Assignment,
  steps: PlanStep[],
): Promise<EmployeeRecord> {
  const exactAssignable = await findExactAssignableProjectManager(client, assignment, steps);
  if (exactAssignable?.id) return exactAssignable;

  const current = await fetchEmployeeById(client, employee.id, steps) ?? employee;
  const departmentId = current.departmentId ?? await ensureDepartmentId(client, steps);
  const body = {
    id: current.id,
    version: current.version ?? 0,
    ...buildProjectCycleEmployeeBody(assignment, departmentId, "STANDARD"),
  };
  const updated = await client.request("PUT", `/employee/${current.id}`, { body });
  pushStep(steps, "PUT", `/employee/${current.id}`, { body, saveAs: "employee" });
  const refreshed = employeeFromValue(primaryValue(updated));
  const assignableAfterUpdate = await findExactAssignableProjectManager(client, assignment, steps);
  if (assignableAfterUpdate?.id) return assignableAfterUpdate;

  try {
    const params = { employeeId: refreshed.id || current.id, template: "DEPARTMENT_LEADER" };
    await client.request("PUT", "/employee/entitlement/:grantEntitlementsByTemplate", { params });
    pushStep(steps, "PUT", "/employee/entitlement/:grantEntitlementsByTemplate", { params });
  } catch {
    // Fall through to exact assignable re-check and eventual verifier failure.
  }

  const assignableAfterEntitlements = await findExactAssignableProjectManager(client, assignment, steps);
  return assignableAfterEntitlements ?? (await fetchEmployeeById(client, refreshed.id || current.id, steps)) ?? refreshed ?? current;
}

function activityFromValue(value: unknown): ActivityRecord {
  const record = toRecord(value);
  return {
    id: Number(record.id ?? 0),
    name: typeof record.name === "string" ? record.name : undefined,
    activityType: typeof record.activityType === "string" ? record.activityType : undefined,
    isChargeable: typeof record.isChargeable === "boolean" ? record.isChargeable : undefined,
  };
}

function projectFromValue(value: unknown): ProjectRecord {
  const record = toRecord(value);
  const customer = toRecord(record.customer);
  const projectManager = toRecord(record.projectManager);
  const projectManagerName = [projectManager.firstName, projectManager.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return {
    id: Number(record.id ?? 0),
    name: typeof record.name === "string" ? record.name : undefined,
    customerId: Number(customer.id ?? 0) || undefined,
    customerName: typeof customer.name === "string" ? customer.name : undefined,
    customerOrganizationNumber: typeof customer.organizationNumber === "string" ? customer.organizationNumber : undefined,
    projectManagerId: Number(projectManager.id ?? 0) || undefined,
    projectManagerName: projectManagerName || undefined,
    projectManagerEmail: typeof projectManager.email === "string" ? projectManager.email : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    isPriceCeiling: typeof record.isPriceCeiling === "boolean" ? record.isPriceCeiling : undefined,
    priceCeilingAmount: toNumber(record.priceCeilingAmount),
  };
}

function managerMatches(
  project: ProjectRecord,
  expected: { id?: number; name?: string; email?: string },
): boolean {
  if (expected.id && project.projectManagerId) return expected.id === project.projectManagerId;
  if (expected.email) return textMatches(project.projectManagerEmail, expected.email);
  if (expected.name) return textMatches(project.projectManagerName, expected.name);
  return Boolean(project.projectManagerId || project.projectManagerEmail || project.projectManagerName);
}

function budgetMatches(project: ProjectRecord, budgetAmount: number | null): boolean {
  if (budgetAmount === null || budgetAmount <= 0) return true;
  const priceCeilingAmount = toNumber(project.priceCeilingAmount);
  if (project.isPriceCeiling === true && priceCeilingAmount !== null && Math.abs(priceCeilingAmount - budgetAmount) < 0.01) {
    return true;
  }
  return textMatches(project.description, `Budget ${budgetAmount} NOK`);
}

async function resolveOrCreateCustomer(
  client: TripletexClient,
  customerName: string,
  organizationNumber: string,
  steps: PlanStep[],
): Promise<CustomerRecord> {
  const params: Record<string, unknown> = { count: 20, from: 0, fields: "id,name,organizationNumber" };
  if (organizationNumber) params.organizationNumber = organizationNumber;
  if (customerName) params.name = customerName;
  const response = await client.request("GET", "/customer", { params });
  pushStep(steps, "GET", "/customer", { params, saveAs: "customer" });
  const values = responseValues(response).map(customerFromValue).filter((item) => item.id > 0);
  const found = values.find((item) =>
    (!organizationNumber || textMatches(item.organizationNumber, organizationNumber))
    && (!customerName || textMatches(item.name, customerName))
  ) ?? values.find((item) => organizationNumber && textMatches(item.organizationNumber, organizationNumber))
    ?? values.find((item) => customerName && textMatches(item.name, customerName));
  if (found) return found;

  const body: Record<string, unknown> = { name: customerName || `Generated Customer ${Date.now().toString().slice(-6)}`, isCustomer: true };
  if (organizationNumber) body.organizationNumber = organizationNumber;
  const created = await client.request("POST", "/customer", { body });
  pushStep(steps, "POST", "/customer", { body, saveAs: "customer" });
  const record = customerFromValue(primaryValue(created));
  if (record.id <= 0) throw new Error("Failed to create customer for project cycle");
  return record;
}

async function ensureDepartmentId(client: TripletexClient, steps: PlanStep[]): Promise<number> {
  const params = { count: 5, from: 0, fields: "id,name" };
  const response = await client.request("GET", "/department", { params });
  pushStep(steps, "GET", "/department", { params, saveAs: "department" });
  const existing = responseValues(response).map((item) => toRecord(item)).find((item) => Number(item.id ?? 0) > 0);
  const existingId = Number(existing?.id ?? 0);
  if (existingId > 0) return existingId;

  const body = { name: "Employees" };
  const created = await client.request("POST", "/department", { body });
  pushStep(steps, "POST", "/department", { body, saveAs: "department" });
  const createdId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (createdId <= 0) throw new Error("Unable to resolve or create department for project cycle");
  return createdId;
}

async function resolveOrCreateEmployee(
  client: TripletexClient,
  assignment: Assignment,
  steps: PlanStep[],
): Promise<EmployeeRecord> {
  if (assignment.email) {
    const params = { email: assignment.email, count: 10, from: 0, fields: "id,firstName,lastName,email" };
    const response = await client.request("GET", "/employee", { params });
    pushStep(steps, "GET", "/employee", { params, saveAs: "employee" });
    const found = responseValues(response).map(employeeFromValue).find((item) => item.id > 0 && textMatches(item.email, assignment.email));
    if (found) {
      return assignment.isManager ? ensureSpecificProjectManager(client, found, assignment, steps) : found;
    }
  }

  const person = splitName(assignment.name);
  const params = { firstName: person.firstName, lastName: person.lastName, count: 20, from: 0, fields: "id,firstName,lastName,email" };
  const response = await client.request("GET", "/employee", { params });
  pushStep(steps, "GET", "/employee", { params, saveAs: "employee" });
  const byName = responseValues(response)
    .map(employeeFromValue)
    .find((item) => item.id > 0 && textMatches(item.firstName, person.firstName) && textMatches(item.lastName, person.lastName));
  if (byName) {
    return assignment.isManager ? ensureSpecificProjectManager(client, byName, assignment, steps) : byName;
  }

  const departmentId = await ensureDepartmentId(client, steps);
  const body = buildProjectCycleEmployeeBody(assignment, departmentId, assignment.isManager ? "STANDARD" : "NO_ACCESS");
  const created = await client.request("POST", "/employee", { body });
  pushStep(steps, "POST", "/employee", { body, saveAs: "employee" });
  const employee = employeeFromValue(primaryValue(created));
  if (employee.id <= 0) throw new Error("Failed to create employee for project cycle");
  return assignment.isManager ? ensureSpecificProjectManager(client, employee, assignment, steps) : employee;
}

async function resolveAssignableProjectManagerId(
  client: TripletexClient,
  values: Record<string, unknown>,
  assignments: Assignment[],
  steps: PlanStep[],
): Promise<number> {
  const explicitManager = assignments.find((item) => item.isManager);
  const managerName = explicitManager?.name || String(values.projectManagerName ?? "").trim();
  const managerEmail = explicitManager?.email || String(values.projectManagerEmail ?? "").trim();
  const params: Record<string, unknown> = {
    assignableProjectManagers: true,
    count: 20,
    from: 0,
    fields: "id,firstName,lastName,email",
  };
  if (managerEmail) params.email = managerEmail;
  if (managerName) {
    const person = splitName(managerName);
    params.firstName = person.firstName;
    params.lastName = person.lastName;
  }
  const response = await client.request("GET", "/employee", { params });
  pushStep(steps, "GET", "/employee", { params, saveAs: "projectManager" });
  const matches = responseValues(response).map(employeeFromValue).filter((item) => item.id > 0);
  const exact = matches.find((item) =>
    (!managerEmail || textMatches(item.email, managerEmail))
    && (!managerName || textMatches(`${item.firstName ?? ""} ${item.lastName ?? ""}`.trim(), managerName))
  );
  if (exact?.id) return exact.id;
  if (matches[0]?.id) return matches[0].id;

  const fallbackParams = { assignableProjectManagers: true, count: 1, from: 0, fields: "id,firstName,lastName,email" };
  const fallbackResponse = await client.request("GET", "/employee", { params: fallbackParams });
  pushStep(steps, "GET", "/employee", { params: fallbackParams, saveAs: "projectManager" });
  const fallback = employeeFromValue(primaryValue(fallbackResponse));
  if (fallback.id > 0) return fallback.id;
  throw new Error("No assignable project manager available in the Tripletex tenant");
}

async function resolveOrCreateProject(
  client: TripletexClient,
  input: {
    projectName: string;
    customer: CustomerRecord;
    projectManagerId: number;
    fallbackProjectManagerId?: number;
    projectManagerName?: string;
    projectManagerEmail?: string;
    budgetAmount: number | null;
    baseDate: string;
    steps: PlanStep[];
  },
): Promise<ProjectRecord> {
  const params = {
    name: input.projectName,
    count: 20,
    from: 0,
    fields: "id,name,description,isPriceCeiling,priceCeilingAmount,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email),participants(id,employee(id,email)),projectActivities(id,activity(id,name,activityType),startDate,endDate),preliminaryInvoice(id)",
  };
  const response = await client.request("GET", "/project", { params });
  pushStep(input.steps, "GET", "/project", { params, saveAs: "project" });
  let found = responseValues(response)
    .map(projectFromValue)
    .find((item) =>
      item.id > 0
      && textMatches(item.name, input.projectName)
      && (item.customerId === input.customer.id || textMatches(item.customerOrganizationNumber, input.customer.organizationNumber))
    );

  const desiredBody: Record<string, unknown> = {
    name: input.projectName,
    startDate: input.baseDate,
    customer: { id: input.customer.id },
    projectManager: { id: input.projectManagerId },
    description: input.budgetAmount !== null ? `Budget ${input.budgetAmount} NOK` : undefined,
  };
  if (input.budgetAmount !== null) {
    desiredBody.isPriceCeiling = true;
    desiredBody.priceCeilingAmount = input.budgetAmount;
  }

  const applyMutation = async (projectId?: number): Promise<ProjectRecord> => {
    const attemptIds = [input.projectManagerId];
    if (
      input.fallbackProjectManagerId
      && input.fallbackProjectManagerId > 0
      && input.fallbackProjectManagerId !== input.projectManagerId
    ) {
      attemptIds.push(input.fallbackProjectManagerId);
    }

    let lastError: unknown;
    for (const managerId of attemptIds) {
      const body = {
        ...desiredBody,
        projectManager: { id: managerId },
        description:
          managerId === input.projectManagerId
            ? desiredBody.description
            : [String(desiredBody.description ?? "").trim(), input.projectManagerName || input.projectManagerEmail ? `Requested manager ${input.projectManagerName || input.projectManagerEmail}` : ""]
                .filter(Boolean)
                .join(" | "),
      };
      try {
        if (projectId && projectId > 0) {
          const updated = await client.request("PUT", `/project/${projectId}`, { body });
          pushStep(input.steps, "PUT", `/project/${projectId}`, { body, saveAs: "project" });
          return projectFromValue(primaryValue(updated));
        }
        const created = await client.request("POST", "/project", { body });
        pushStep(input.steps, "POST", "/project", { body, saveAs: "project" });
        return projectFromValue(primaryValue(created));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to create project for project cycle");
  };

  if (found?.id) {
    const needsUpdate =
      found.customerId !== input.customer.id
      || !managerMatches(found, {
        id: input.projectManagerId,
        name: input.projectManagerName,
        email: input.projectManagerEmail,
      })
      || !budgetMatches(found, input.budgetAmount);
    if (!needsUpdate) return found;
    found = await applyMutation(found.id);
    if (found.id > 0) return found;
  }

  const project = await applyMutation();
  if (project.id <= 0) throw new Error("Failed to create project for project cycle");
  return project;
}

async function resolveOrCreateActivity(
  client: TripletexClient,
  steps: PlanStep[],
): Promise<ActivityRecord> {
  const params = { name: DEFAULT_ACTIVITY_NAME, isProjectActivity: true, count: 20, from: 0, fields: "id,name,activityType,isChargeable" };
  const response = await client.request("GET", "/activity", { params });
  pushStep(steps, "GET", "/activity", { params, saveAs: "activity" });
  const found = responseValues(response)
    .map(activityFromValue)
    .find((item) =>
      item.id > 0
      && textMatches(item.name, DEFAULT_ACTIVITY_NAME)
      && (item.activityType === "PROJECT_GENERAL_ACTIVITY" || item.activityType === "PROJECT_SPECIFIC_ACTIVITY")
    );
  if (found) return found;

  const body = { name: DEFAULT_ACTIVITY_NAME, activityType: "PROJECT_GENERAL_ACTIVITY", isChargeable: true };
  const created = await client.request("POST", "/activity", { body });
  pushStep(steps, "POST", "/activity", { body, saveAs: "activity" });
  const activity = activityFromValue(primaryValue(created));
  if (activity.id <= 0) throw new Error("Failed to create activity for project cycle");
  return activity;
}

async function fetchProjectDetailRecord(client: TripletexClient, projectId: number): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `/project/${projectId}`, {
    params: {
      fields: "id,name,participants(id,employee(id,email)),projectActivities(id,activity(id,name,activityType),startDate,endDate),preliminaryInvoice(id),customer(id,name,organizationNumber)",
    },
  });
  return toRecord(primaryValue(response));
}

async function ensureProjectParticipant(
  client: TripletexClient,
  projectId: number,
  employeeId: number,
  steps: PlanStep[],
): Promise<void> {
  const projectRecord = await fetchProjectDetailRecord(client, projectId);
  const participants = Array.isArray(projectRecord.participants) ? projectRecord.participants : [];
  const exists = participants.some((item) => Number(toRecord(toRecord(item).employee).id ?? 0) === employeeId);
  if (exists) return;
  const body = { project: { id: projectId }, employee: { id: employeeId }, adminAccess: false };
  try {
    await client.request("POST", "/project/participant", { body });
    pushStep(steps, "POST", "/project/participant", { body });
  } catch (error) {
    if (!(error instanceof TripletexError) || error.statusCode !== 409) throw error;
  }
}

async function ensureProjectActivity(
  client: TripletexClient,
  projectId: number,
  activityId: number,
  baseDate: string,
  steps: PlanStep[],
): Promise<void> {
  const projectRecord = await fetchProjectDetailRecord(client, projectId);
  const activities = Array.isArray(projectRecord.projectActivities) ? projectRecord.projectActivities : [];
  const exists = activities.some((item) => Number(toRecord(toRecord(item).activity).id ?? 0) === activityId);
  if (exists) return;
  const body = { project: { id: projectId }, activity: { id: activityId }, startDate: baseDate };
  try {
    await client.request("POST", "/project/projectActivity", { body });
    pushStep(steps, "POST", "/project/projectActivity", { body });
  } catch (error) {
    if (!(error instanceof TripletexError) || error.statusCode !== 409) throw error;
  }
}

async function ensureTimesheetEntries(
  client: TripletexClient,
  input: {
    employee: EmployeeRecord;
    project: ProjectRecord;
    activity: ActivityRecord;
    assignment: Assignment;
    baseDate: string;
    steps: PlanStep[];
    values: Record<string, unknown>;
  },
): Promise<void> {
  const chunks = splitHours(input.assignment.hours);
  const searchParams = {
    employeeId: input.employee.id,
    projectId: input.project.id,
    activityId: input.activity.id,
    dateFrom: input.baseDate,
    dateTo: addDaysIso(input.baseDate, ENTRY_LOOKAHEAD_DAYS),
    count: 200,
    from: 0,
    fields: "id,date,hours,projectChargeableHours,chargeableHours,comment,project(id),activity(id),employee(id,email)",
  };
  const response = await client.request("GET", "/timesheet/entry", { params: searchParams });
  pushStep(input.steps, "GET", "/timesheet/entry", { params: searchParams });
  const existingEntries = responseValues(response).map((item) => toRecord(item));
  const createdIds: number[] = [];

  let nextDate = input.baseDate;
  for (let index = 0; index < chunks.length; index += 1) {
    const hours = chunks[index]!;
    const comment = assignmentComment(String(input.project.name ?? ""), input.assignment, index, chunks.length);
    const exactExisting = existingEntries.find((item) =>
      textMatches(item.comment, comment)
      && Math.abs((toNumber(item.hours) ?? 0) - hours) < 0.01
    );
    if (exactExisting) {
      const existingId = Number(exactExisting.id ?? 0);
      if (existingId > 0) createdIds.push(existingId);
      continue;
    }
    const body = {
      project: { id: input.project.id },
      activity: { id: input.activity.id },
      employee: { id: input.employee.id },
      date: nextDate,
      hours,
      projectChargeableHours: hours,
      comment,
    };
    const created = await client.request("POST", "/timesheet/entry", { body });
    pushStep(input.steps, "POST", "/timesheet/entry", { body });
    const record = toRecord(primaryValue(created));
    const createdId = Number(record.id ?? 0);
    if (createdId > 0) createdIds.push(createdId);
    existingEntries.push(record);
    nextDate = addDaysIso(nextDate, 1);
  }

  const bucket = Array.isArray(input.values.__projectCycleTimesheetIds) ? input.values.__projectCycleTimesheetIds as unknown[] : [];
  bucket.push(...createdIds);
  input.values.__projectCycleTimesheetIds = bucket;
}

async function createProjectInvoice(
  client: TripletexClient,
  input: {
    customer: CustomerRecord;
    project: ProjectRecord;
    assignments: Assignment[];
    invoiceAmount: number;
    baseDate: string;
    steps: PlanStep[];
    values: Record<string, unknown>;
  },
): Promise<number> {
  const employeeSummary = input.assignments.map((item) => `${item.name} ${roundMoney(item.hours)}h`).join(", ").slice(0, 160);
  const body = {
    customer: { id: input.customer.id },
    orderDate: input.baseDate,
    deliveryDate: input.baseDate,
    orderLines: [
      {
        description: `Project cycle ${input.project.name}: ${employeeSummary}`.slice(0, 180),
        count: 1,
        unitPriceExcludingVatCurrency: input.invoiceAmount,
      },
    ],
  };
  const created = await client.request("POST", "/order", { body });
  pushStep(input.steps, "POST", "/order", { body, saveAs: "order" });
  const orderId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (orderId <= 0) throw new Error("Failed to create order for project cycle");
  input.values.__projectCycleOrderId = orderId;

  const invoiceParams = {
    id: orderId,
    invoiceDate: input.baseDate,
    sendToCustomer: false,
  };
  const invoiced = await client.request("PUT", "/order/:invoiceMultipleOrders", { params: invoiceParams });
  pushStep(input.steps, "PUT", "/order/:invoiceMultipleOrders", { params: invoiceParams, saveAs: "invoice" });
  const invoiceId = Number(toRecord(primaryValue(invoiced)).id ?? 0);
  if (invoiceId <= 0) throw new Error("Project cycle invoice did not return an invoice id");
  input.values.__projectCycleInvoiceId = invoiceId;
  return invoiceId;
}

async function settleInvoiceIfRequested(
  client: TripletexClient,
  prompt: string,
  invoiceId: number,
  invoiceAmount: number,
  baseDate: string,
  steps: PlanStep[],
  values: Record<string, unknown>,
): Promise<void> {
  if (!wantsPayment(prompt)) return;
  const paymentTypeResponse = await client.request("GET", "/invoice/paymentType", {
    params: { count: 1, from: 0, fields: "id,description" },
  });
  pushStep(steps, "GET", "/invoice/paymentType", { params: { count: 1, from: 0, fields: "id,description" }, saveAs: "invoicePaymentType" });
  const paymentTypeId = Number(toRecord(primaryValue(paymentTypeResponse)).id ?? 0);
  if (paymentTypeId <= 0) throw new Error("No invoice payment type available for project cycle payment");
  await client.request("PUT", `/invoice/${invoiceId}/:payment`, {
    params: {
      paymentDate: baseDate,
      paymentTypeId,
      paidAmount: invoiceAmount,
    },
  });
  pushStep(steps, "PUT", `/invoice/${invoiceId}/:payment`, {
    params: { paymentDate: baseDate, paymentTypeId, paidAmount: invoiceAmount },
  });
  values.__projectCyclePaidInvoiceId = invoiceId;
}

export function matchesProjectCycleWorkflow(spec: ProjectCycleSpec): boolean {
  return spec.operation === "create" && spec.entity === "project_cycle";
}

export function compileProjectCyclePreview(operation: string, rawValues: Record<string, unknown>): ExecutionPlan {
  const projectName = String(rawValues.projectName ?? rawValues.name ?? "Project Cycle").trim() || "Project Cycle";
  return {
    summary: operation === "create" ? `Complete project cycle for ${projectName}` : `Inspect project cycle for ${projectName}`,
    steps: operation === "create"
      ? [
          { method: "GET", path: "/customer", params: { count: 5, from: 0, fields: "id,name,organizationNumber" }, saveAs: "customer" },
          { method: "GET", path: "/employee", params: { assignableProjectManagers: true, count: 1, from: 0, fields: "id,firstName,lastName,email" }, saveAs: "projectManager" },
          { method: "POST", path: "/project", body: { name: projectName }, saveAs: "project" },
          { method: "POST", path: "/timesheet/entry", body: { project: { id: "{{project_id}}" } } },
          { method: "POST", path: "/order", body: { customer: { id: "{{customer_id}}" } }, saveAs: "order" },
          { method: "PUT", path: "/order/:invoiceMultipleOrders", params: { id: "{{order_id}}", invoiceDate: todayIsoInZone(), sendToCustomer: false }, saveAs: "invoice" },
        ]
      : [{ method: "GET", path: "/project", params: { count: 20, from: 0, fields: "id,name,customer(id,name,organizationNumber)" } }],
  };
}

export async function executeProjectCycleWorkflow(
  client: TripletexClient,
  spec: ProjectCycleSpec,
  prompt: string,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileProjectCyclePreview(spec.operation, values);
  if (dryRun) return preview;

  const projectName = resolveProjectName(values, prompt);
  const customerName = resolveCustomerName(values, prompt);
  const organizationNumber = resolveOrganizationNumber(values, prompt);
  const budgetAmount = resolveBudgetAmount(values, prompt);
  const hourlyRate = resolveHourlyRate(values, prompt);
  const baseDate = resolveBaseDate(values);
  const assignments = extractAssignments(prompt, values);
  if (assignments.length === 0) {
    throw new Error("Project cycle prompt did not contain any recognizable employee hour registrations");
  }

  const employeeIds: number[] = [];
  const employeeByKey = new Map<string, EmployeeRecord>();
  const assignmentSnapshots: Array<Record<string, unknown>> = [];
  const steps: PlanStep[] = [];
  const customer = await resolveOrCreateCustomer(client, customerName, organizationNumber, steps);
  values.__projectCycleCustomerId = customer.id;
  for (const assignment of assignments) {
    const employee = await resolveOrCreateEmployee(client, assignment, steps);
    employeeIds.push(employee.id);
    employeeByKey.set(normalizeText(assignment.email || assignment.name), employee);
    assignmentSnapshots.push({
      employeeId: employee.id,
      email: employee.email ?? assignment.email,
      name: assignment.name,
      hours: assignment.hours,
      isManager: assignment.isManager === true,
    });
  }
  values.__projectCycleEmployeeIds = employeeIds;
  values.__projectCycleAssignments = assignmentSnapshots;

  const explicitManager = assignments.find((item) => item.isManager);
  const requestedManagerName = explicitManager?.name || String(values.projectManagerName ?? "").trim();
  const requestedManagerEmail = explicitManager?.email || String(values.projectManagerEmail ?? "").trim();
  const requestedManager = employeeByKey.get(normalizeText(requestedManagerEmail || requestedManagerName || ""));
  const fallbackProjectManagerId = await resolveAssignableProjectManagerId(client, values, assignments, steps);
  const projectManagerId = requestedManager?.id ?? fallbackProjectManagerId;
  values.__projectCycleProjectManagerId = projectManagerId;
  if (requestedManagerName) values.__projectCycleProjectManagerName = requestedManagerName;
  if (requestedManagerEmail) values.__projectCycleProjectManagerEmail = requestedManagerEmail;

  const project = await resolveOrCreateProject(client, {
    projectName,
    customer,
    projectManagerId,
    fallbackProjectManagerId,
    projectManagerName: requestedManagerName || undefined,
    projectManagerEmail: requestedManagerEmail || undefined,
    budgetAmount,
    baseDate,
    steps,
  });
  values.__projectCycleProjectId = project.id;

  const activity = await resolveOrCreateActivity(client, steps);
  values.__projectCycleActivityId = activity.id;
  await ensureProjectActivity(client, project.id, activity.id, baseDate, steps);

  for (const assignment of assignments) {
    const employee = employeeByKey.get(normalizeText(assignment.email || assignment.name));
    if (!employee) continue;
    await ensureProjectParticipant(client, project.id, employee.id, steps);
    await ensureTimesheetEntries(client, {
      employee,
      project,
      activity,
      assignment,
      baseDate,
      steps,
      values,
    });
  }

  const totalHours = roundMoney(assignments.reduce((sum, item) => sum + item.hours, 0));
  const invoiceAmount = budgetAmount ?? (hourlyRate !== null ? roundMoney(totalHours * hourlyRate) : Math.max(1, roundMoney(totalHours * 1000)));
  values.__projectCycleInvoiceAmount = invoiceAmount;
  values.__projectCyclePrompt = prompt;
  const invoiceId = await createProjectInvoice(client, {
    customer,
    project,
    assignments,
    invoiceAmount,
    baseDate,
    steps,
    values,
  });
  await settleInvoiceIfRequested(client, prompt, invoiceId, invoiceAmount, baseDate, steps, values);

  return {
    summary: `Complete project cycle for ${projectName}`,
    steps,
  };
}

async function fetchProjectById(client: TripletexClient, projectId: number): Promise<ProjectRecord | null> {
  if (projectId <= 0) return null;
  try {
    const response = await client.request("GET", `/project/${projectId}`, {
      params: {
        fields: "id,name,description,isPriceCeiling,priceCeilingAmount,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email),preliminaryInvoice(id)",
      },
    });
    const project = projectFromValue(primaryValue(response));
    return project.id > 0 ? project : null;
  } catch {
    return null;
  }
}

async function fetchInvoiceById(client: TripletexClient, invoiceId: number): Promise<Record<string, unknown> | null> {
  if (invoiceId <= 0) return null;
  try {
    const response = await client.request("GET", `/invoice/${invoiceId}`, {
      params: {
        fields: "id,invoiceNumber,amount,amountOutstanding,amountCurrencyOutstanding,amountOutstandingTotal,amountCurrencyOutstandingTotal,customer(id,name,organizationNumber)",
      },
    });
    return toRecord(primaryValue(response));
  } catch {
    return null;
  }
}

export async function verifyProjectCycleOutcome(
  client: TripletexClient,
  spec: ProjectCycleSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const projectId = Number(values.__projectCycleProjectId ?? 0);
  const invoiceId = Number(values.__projectCycleInvoiceId ?? 0);
  const employeeIds = Array.isArray(values.__projectCycleEmployeeIds)
    ? (values.__projectCycleEmployeeIds as unknown[]).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];

  if (projectId <= 0 || invoiceId <= 0 || employeeIds.length === 0) {
    return { verified: false, detail: "project cycle artifacts missing from execution", required: true };
  }

  const project = await fetchProjectById(client, projectId);
  if (!project?.id) return { verified: false, detail: "project cycle project not found by returned id", required: true };

  const customerName = String(values.customerName ?? "").trim();
  const organizationNumber = String(values.organizationNumber ?? "").trim();
  if (customerName && !textMatches(project.customerName, customerName) && !(organizationNumber && textMatches(project.customerOrganizationNumber, organizationNumber))) {
    return { verified: false, detail: "project cycle project customer did not match requested customer", required: true };
  }

  const expectedManagerId = Number(values.__projectCycleProjectManagerId ?? 0);
  const expectedManagerName = String(values.__projectCycleProjectManagerName ?? values.projectManagerName ?? "").trim();
  const expectedManagerEmail = String(values.__projectCycleProjectManagerEmail ?? values.projectManagerEmail ?? "").trim();
  if (!managerMatches(project, {
    id: expectedManagerId > 0 ? expectedManagerId : undefined,
    name: expectedManagerName || undefined,
    email: expectedManagerEmail || undefined,
  })) {
    return { verified: false, detail: "project cycle project manager did not match the requested manager", required: true };
  }

  const budgetAmount = toNumber(values.budgetAmount ?? values.fixedPriceAmount);
  if (!budgetMatches(project, budgetAmount)) {
    return { verified: false, detail: "project cycle budget or price ceiling did not match the prompt", required: true };
  }

  const assignmentSnapshots = Array.isArray(values.__projectCycleAssignments)
    ? (values.__projectCycleAssignments as unknown[]).map((item) => toRecord(item))
    : [];

  for (const employeeId of employeeIds) {
    const response = await client.request("GET", "/timesheet/entry", {
      params: {
        employeeId,
        projectId,
        dateFrom: resolveBaseDate(values),
        dateTo: addDaysIso(resolveBaseDate(values), ENTRY_LOOKAHEAD_DAYS),
        count: 200,
        from: 0,
        fields: "id,hours,comment,project(id),employee(id,email)",
      },
    });
    const entries = responseValues(response).map((item) => toRecord(item));
    if (entries.length === 0) {
      return { verified: false, detail: `project cycle timesheet entries missing for employee ${employeeId}`, required: true };
    }
    const assignment = assignmentSnapshots.find((item) => Number(item.employeeId ?? 0) === employeeId);
    const expectedHours = toNumber(assignment?.hours);
    if (expectedHours !== null) {
      const actualHours = roundMoney(entries.reduce((sum, item) => sum + (toNumber(item.hours) ?? 0), 0));
      if (Math.abs(actualHours - expectedHours) > 0.01) {
        return {
          verified: false,
          detail: `project cycle timesheet hours for employee ${employeeId} did not match the requested hours`,
          required: true,
        };
      }
    }
  }

  const invoice = await fetchInvoiceById(client, invoiceId);
  if (!invoice?.id) return { verified: false, detail: "project cycle invoice not found by returned id", required: true };
  if (wantsPayment(String(values.__projectCyclePrompt ?? ""))) {
    const outstandingCandidates = [
      toNumber(invoice.amountOutstanding),
      toNumber(invoice.amountCurrencyOutstanding),
      toNumber(invoice.amountOutstandingTotal),
      toNumber(invoice.amountCurrencyOutstandingTotal),
    ].filter((item): item is number => item !== null);
    if (outstandingCandidates.some((item) => Math.abs(item) > 0.01)) {
      return { verified: false, detail: "project cycle invoice exists, but payment was not fully registered", required: true };
    }
  }

  return { verified: true, detail: "project cycle verified via returned ids", required: true };
}
