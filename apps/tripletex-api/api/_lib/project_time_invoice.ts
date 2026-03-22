import type { ExecutionPlan, PlanStep } from "./schemas.js";
import { shiftIsoDateInZone, todayIsoInZone } from "./dates.js";
import { TripletexClient, TripletexError, primaryValue } from "./tripletex.js";
import type { TaskSpec } from "./task_spec.js";

type ProjectTimeInvoiceSpec = Pick<TaskSpec, "operation" | "entity" | "values" | "lookup">;

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
  firstName?: string;
  lastName?: string;
  email?: string;
};

type ActivityRecord = {
  id: number;
  name?: string;
  activityType?: string;
  isChargeable?: boolean;
};

type ProjectRecord = {
  id: number;
  name?: string;
  customerId?: number;
  customerName?: string;
  customerOrganizationNumber?: string;
};

const DEFAULT_EMPLOYEE_DOB = "1990-01-15";
const DEFAULT_DEPARTMENT_NAME = "Project Delivery";
const MAX_HOURS_PER_ENTRY = 24;
const ENTRY_LOOKAHEAD_DAYS = 45;

function todayIso(): string {
  return todayIsoInZone();
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function responseValues(response: unknown): Array<unknown> {
  const record = toRecord(response);
  return Array.isArray(record.values) ? record.values : record.value ? [record.value] : [];
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textMatches(actual: unknown, expected: unknown): boolean {
  const actualText = normalizedText(actual);
  const expectedText = normalizedText(expected);
  if (!actualText || !expectedText) return false;
  return actualText === expectedText;
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
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function addDaysIso(baseIsoDate: string, days: number): string {
  const [year, month, day] = baseIsoDate.split("-").map((part) => Number(part));
  const anchor = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
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

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100);
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function resolveProjectName(values: Record<string, unknown>): string {
  return String(values.projectName ?? values.name ?? "").trim();
}

function resolveCustomerName(values: Record<string, unknown>): string {
  return String(values.customerName ?? "").trim();
}

function resolveOrgNumber(values: Record<string, unknown>): string {
  return String(values.organizationNumber ?? "").trim();
}

function resolveEmployeeDisplay(values: Record<string, unknown>): string {
  return String(values.employeeName ?? values.name ?? values.email ?? "").trim();
}

function resolveActivityName(values: Record<string, unknown>): string {
  return String(values.activityName ?? values.description ?? "").trim();
}

function resolveHours(values: Record<string, unknown>): number | null {
  const direct = toNumber(values.hours ?? values.chargeableHours ?? values.projectChargeableHours);
  if (direct !== null && direct > 0) return direct;
  const amount = toNumber(values.amount);
  const rate = resolveHourlyRate(values);
  if (amount !== null && rate !== null && rate > 0) {
    const derived = roundMoney(amount / rate);
    if (derived > 0) return derived;
  }
  return null;
}

function resolveHourlyRate(values: Record<string, unknown>): number | null {
  const rate = toNumber(values.hourlyRate ?? values.price ?? values.unitPriceExcludingVatCurrency);
  return rate !== null && rate > 0 ? rate : null;
}

function resolveBaseDate(values: Record<string, unknown>): string {
  const direct = String(values.date ?? values.invoiceDate ?? values.orderDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  return todayIso();
}

function splitHours(totalHours: number): number[] {
  const chunks: number[] = [];
  let remaining = roundMoney(totalHours);
  while (remaining > MAX_HOURS_PER_ENTRY) {
    chunks.push(MAX_HOURS_PER_ENTRY);
    remaining = roundMoney(remaining - MAX_HOURS_PER_ENTRY);
  }
  if (remaining > 0) chunks.push(remaining);
  return chunks;
}

function buildTimesheetComment(
  projectName: string,
  activityName: string,
  employeeDisplay: string,
  index: number,
  total: number,
): string {
  const base = `${projectName} / ${activityName} / ${employeeDisplay}`.trim().slice(0, 150);
  return total > 1 ? `${base} (${index + 1}/${total})` : base;
}

function buildOrderLineDescription(
  projectName: string,
  activityName: string,
  employeeDisplay: string,
  totalHours: number,
): string {
  return `${projectName} / ${activityName} / ${employeeDisplay} / ${formatHours(totalHours)} hours`.slice(0, 240);
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

export function matchesProjectTimeInvoiceWorkflow(spec: ProjectTimeInvoiceSpec): boolean {
  if (spec.operation !== "create" || spec.entity !== "invoice") return false;
  const values = toRecord(spec.values);
  return Boolean(
    resolveProjectName(values)
    && (resolveCustomerName(values) || resolveOrgNumber(values))
    && resolveEmployeeDisplay(values)
    && resolveActivityName(values)
    && resolveHours(values)
    && resolveHourlyRate(values),
  );
}

export function compileProjectTimeInvoicePreview(
  operation: string,
  rawValues: Record<string, unknown>,
): ExecutionPlan {
  if (operation !== "create") {
    return {
      summary: "List project time invoice candidates",
      steps: [{ method: "GET", path: "/timesheet/entry", params: { count: 20, dateFrom: shiftIsoDateInZone({ days: -30 }), dateTo: shiftIsoDateInZone({ days: 1 }) } }],
    };
  }

  const values = toRecord(rawValues);
  const projectName = resolveProjectName(values) || "Project";
  const customerName = resolveCustomerName(values) || "Customer";
  const employeeDisplay = resolveEmployeeDisplay(values) || "Employee";
  const activityName = resolveActivityName(values) || "Activity";
  const hours = resolveHours(values) ?? 1;
  const rate = resolveHourlyRate(values) ?? 1;
  const chunks = splitHours(hours);
  const baseDate = resolveBaseDate(values);
  const orderDescription = buildOrderLineDescription(projectName, activityName, employeeDisplay, hours);

  const steps: PlanStep[] = [];
  pushStep(steps, "GET", "/customer", {
    params: { count: 5, from: 0, fields: "id,name,organizationNumber", ...(resolveOrgNumber(values) ? { organizationNumber: resolveOrgNumber(values) } : { name: customerName }) },
    saveAs: "customer",
    reason: "Resolve or create customer for project invoice",
  });
  pushStep(steps, "GET", "/employee", {
    params: { count: 5, from: 0, fields: "id,firstName,lastName,email", ...(values.email ? { email: values.email } : {}) },
    saveAs: "employee",
    reason: "Resolve or create employee for timesheet registration",
  });
  pushStep(steps, "GET", "/project", {
    params: { count: 20, from: 0, name: projectName, fields: "id,name,customer(id,name,organizationNumber),projectHourlyRates(*),participants(*),projectActivities(activity(id,name))" },
    saveAs: "project",
    reason: "Resolve or create project",
  });
  pushStep(steps, "GET", "/activity", {
    params: { count: 20, from: 0, name: activityName, isProjectActivity: true, fields: "id,name,activityType,isChargeable" },
    saveAs: "activity",
    reason: "Resolve or create project activity",
  });
  pushStep(steps, "GET", "/employee", {
    params: { count: 1, from: 0, assignableProjectManagers: true, fields: "id,firstName,lastName,email" },
    saveAs: "projectManager",
    reason: "Find assignable project manager for project creation fallback",
  });
  pushStep(steps, "POST", "/project", {
    body: { name: projectName, startDate: baseDate, customer: { id: "{{customer_id}}" }, projectManager: { id: "{{projectManager_id}}" } },
    saveAs: "project",
  });
  pushStep(steps, "POST", "/project/participant", {
    body: { project: { id: "{{project_id}}" }, employee: { id: "{{employee_id}}" }, adminAccess: false },
  });
  pushStep(steps, "PUT", "/project/hourlyRates/{{projectHourlyRate_id}}", {
    body: {
      project: { id: "{{project_id}}" },
      startDate: baseDate,
      showInProjectOrder: true,
      hourlyRateModel: "TYPE_FIXED_HOURLY_RATE",
      fixedRate: rate,
    },
  });
  pushStep(steps, "POST", "/project/projectActivity", {
    body: { project: { id: "{{project_id}}" }, activity: { id: "{{activity_id}}" }, startDate: baseDate },
  });
  chunks.forEach((chunk, index) => {
    pushStep(steps, "POST", "/timesheet/entry", {
      body: {
        project: { id: "{{project_id}}" },
        activity: { id: "{{activity_id}}" },
        employee: { id: "{{employee_id}}" },
        date: addDaysIso(baseDate, index),
        hours: chunk,
        projectChargeableHours: chunk,
        comment: buildTimesheetComment(projectName, activityName, employeeDisplay, index, chunks.length),
      },
    });
  });
  pushStep(steps, "POST", "/order", {
    body: {
      customer: { id: "{{customer_id}}" },
      project: { id: "{{project_id}}" },
      orderDate: baseDate,
      deliveryDate: baseDate,
      orderLines: [{ description: orderDescription, count: hours, unitPriceExcludingVatCurrency: rate }],
    },
    saveAs: "order",
  });
  pushStep(steps, "PUT", "/order/:invoiceMultipleOrders", {
    params: {
      id: "{{order_id}}",
      invoiceDate: baseDate,
      sendToCustomer: false,
    },
    saveAs: "invoice",
    reason: "Create invoice from generated order",
  });

  return {
    summary: `Log ${formatHours(hours)} hours on project ${projectName} and create a customer invoice`,
    steps,
  };
}

export async function executeProjectTimeInvoiceWorkflow(
  client: TripletexClient,
  spec: ProjectTimeInvoiceSpec,
  dryRun: boolean,
): Promise<ExecutionPlan> {
  const values = toRecord(spec.values);
  const preview = compileProjectTimeInvoicePreview(spec.operation, values);
  if (dryRun) return preview;

  const projectName = resolveProjectName(values);
  const customerName = resolveCustomerName(values);
  const organizationNumber = resolveOrgNumber(values);
  const employeeDisplay = resolveEmployeeDisplay(values);
  const activityName = resolveActivityName(values);
  const totalHours = resolveHours(values);
  const hourlyRate = resolveHourlyRate(values);
  const baseDate = resolveBaseDate(values);

  if (!projectName || !employeeDisplay || !activityName || !totalHours || !hourlyRate) {
    throw new Error("Project time invoice workflow requires project, employee, activity, hours, and hourly rate");
  }

  const steps: PlanStep[] = [];
  const customer = await resolveOrCreateCustomer(client, customerName, organizationNumber, steps);
  values.__customerId = customer.id;
  const employee = await resolveOrCreateEmployee(client, values, steps);
  values.__employeeId = employee.id;
  const projectManagerId = await resolveProjectManagerId(client, values, steps);
  const project = await resolveOrCreateProject(client, {
    projectName,
    customer,
    projectManagerId,
    baseDate,
    steps,
  });
  values.__projectId = project.id;
  const activity = await resolveOrCreateActivity(client, activityName, steps);
  values.__activityId = activity.id;

  await ensureProjectParticipant(client, project.id, employee.id, steps);
  await ensureProjectActivity(client, project.id, activity.id, baseDate, steps);
  await ensureProjectHourlyRate(client, project.id, hourlyRate, baseDate, steps);

  const entryChunks = splitHours(totalHours);
  await ensureTimesheetEntries(client, {
    employee,
    project,
    activity,
    totalHours,
    hourlyRate,
    baseDate,
    entryChunks,
    commentBase: `${projectName} / ${activityName} / ${employeeDisplay}`.slice(0, 150),
    steps,
  });

  await ensureOrderWithPreliminaryInvoice(client, {
    customer,
    projectId: project.id,
    projectName,
    activityName,
    employeeDisplay,
    totalHours,
    hourlyRate,
    baseDate,
    steps,
    values,
  });

  return {
    summary: `Log ${formatHours(totalHours)} hours on ${projectName} and create an invoice`,
    steps,
  };
}

export async function verifyProjectTimeInvoiceOutcome(
  client: TripletexClient,
  spec: ProjectTimeInvoiceSpec,
): Promise<Verification> {
  const values = toRecord(spec.values);
  const projectName = resolveProjectName(values);
  const customerName = resolveCustomerName(values);
  const organizationNumber = resolveOrgNumber(values);
  const employeeDisplay = resolveEmployeeDisplay(values);
  const activityName = resolveActivityName(values);
  const totalHours = resolveHours(values);
  const hourlyRate = resolveHourlyRate(values);
  const baseDate = resolveBaseDate(values);

  if (!projectName || !employeeDisplay || !activityName || !totalHours || !hourlyRate) {
    return {
      verified: false,
      detail: "project time invoice verification requires project, employee, activity, hours, and hourly rate",
      required: true,
    };
  }

  const customer =
    await fetchCustomerById(client, positiveInteger(values.__customerId))
    ?? await findCustomer(client, customerName, organizationNumber);
  if (!customer?.id) {
    return { verified: false, detail: "customer not found for project time invoice verification", required: true };
  }

  const employee =
    await fetchEmployeeById(client, positiveInteger(values.__employeeId))
    ?? await findEmployee(client, values);
  if (!employee?.id) {
    return { verified: false, detail: "employee not found for project time invoice verification", required: true };
  }

  const project =
    await fetchProjectDetail(client, positiveInteger(values.__projectId) ?? 0)
    ?? await findProject(client, projectName, customer);
  if (!project?.id) {
    return { verified: false, detail: "project not found for project time invoice verification", required: true };
  }

  const activity =
    await fetchActivityById(client, positiveInteger(values.__activityId))
    ?? await findActivity(client, activityName);
  if (!activity?.id) {
    return { verified: false, detail: "activity not found for project time invoice verification", required: true };
  }

  const timesheetVerification = await verifyTimesheetEntries(client, {
    employee,
    project,
    activity,
    totalHours,
    hourlyRate,
    baseDate,
    commentBase: `${projectName} / ${activityName} / ${employeeDisplay}`.slice(0, 150),
  });
  if (!timesheetVerification.verified) return timesheetVerification;

  const invoiceVerification = await verifyPreliminaryInvoiceOrder(client, {
    customer,
    projectName,
    activityName,
    employeeDisplay,
    totalHours,
    hourlyRate,
    baseDate,
    directInvoiceId: positiveInteger(values.__invoiceId),
  });
  if (!invoiceVerification.verified) return invoiceVerification;

  return {
    verified: true,
    detail: "project hours and invoice verified",
    required: true,
  };
}

async function resolveOrCreateCustomer(
  client: TripletexClient,
  customerName: string,
  organizationNumber: string,
  steps: PlanStep[],
): Promise<CustomerRecord> {
  const found = await findCustomer(client, customerName, organizationNumber, steps);
  if (found?.id) return found;

  const createBody: Record<string, unknown> = {
    name: customerName || `Generated Customer ${Date.now().toString().slice(-6)}`,
    isCustomer: true,
  };
  if (organizationNumber) createBody.organizationNumber = organizationNumber;
  const created = await client.request("POST", "/customer", { body: createBody });
  pushStep(steps, "POST", "/customer", { body: createBody, saveAs: "customer" });
  const record = customerFromValue(primaryValue(created));
  if (record.id <= 0) throw new Error("Failed to create customer for project invoice");
  return record;
}

async function findCustomer(
  client: TripletexClient,
  customerName: string,
  organizationNumber: string,
  steps?: PlanStep[],
): Promise<CustomerRecord | null> {
  const params: Record<string, unknown> = {
    count: 20,
    from: 0,
    fields: "id,name,organizationNumber",
  };
  if (organizationNumber) params.organizationNumber = organizationNumber;
  if (customerName) params.name = customerName;
  const response = await client.request("GET", "/customer", { params });
  if (steps) pushStep(steps, "GET", "/customer", { params, saveAs: "customer" });
  const values = responseValues(response).map(customerFromValue).filter((item) => item.id > 0);
  const exact = values.find((item) =>
    (!organizationNumber || textMatches(item.organizationNumber, organizationNumber))
    && (!customerName || textMatches(item.name, customerName))
  );
  if (exact) return exact;
  const byOrg = organizationNumber ? values.find((item) => textMatches(item.organizationNumber, organizationNumber)) : null;
  if (byOrg) return byOrg;
  const byName = customerName ? values.find((item) => textMatches(item.name, customerName)) : null;
  return byName ?? null;
}

async function fetchCustomerById(
  client: TripletexClient,
  customerId: number | null,
): Promise<CustomerRecord | null> {
  if (!customerId || customerId <= 0) return null;
  try {
    const response = await client.request("GET", `/customer/${customerId}`, {
      params: { fields: "id,name,organizationNumber" },
    });
    const customer = customerFromValue(primaryValue(response));
    return customer.id > 0 ? customer : null;
  } catch {
    return null;
  }
}

async function resolveOrCreateEmployee(
  client: TripletexClient,
  values: Record<string, unknown>,
  steps: PlanStep[],
): Promise<EmployeeRecord> {
  const found = await findEmployee(client, values, steps);
  if (found?.id) return found;

  const departmentId = await ensureDepartmentId(client, steps);
  const person = splitName(resolveEmployeeDisplay(values) || undefined);
  const body: Record<string, unknown> = {
    firstName: person.firstName,
    lastName: person.lastName,
    email: typeof values.email === "string" ? values.email : undefined,
    dateOfBirth: typeof values.dateOfBirth === "string" ? values.dateOfBirth : DEFAULT_EMPLOYEE_DOB,
    userType: "NO_ACCESS",
    department: { id: departmentId },
  };
  const created = await client.request("POST", "/employee", { body });
  pushStep(steps, "POST", "/employee", { body, saveAs: "employee" });
  const employee = employeeFromValue(primaryValue(created));
  if (employee.id <= 0) throw new Error("Failed to create employee for project invoice");
  return employee;
}

async function findEmployee(
  client: TripletexClient,
  values: Record<string, unknown>,
  steps?: PlanStep[],
): Promise<EmployeeRecord | null> {
  const email = typeof values.email === "string" ? values.email.trim() : "";
  if (email) {
    const params = { email, count: 10, from: 0, fields: "id,firstName,lastName,email" };
    const response = await client.request("GET", "/employee", { params });
    if (steps) pushStep(steps, "GET", "/employee", { params, saveAs: "employee" });
    const exact = responseValues(response).map(employeeFromValue).find((item) => item.id > 0 && textMatches(item.email, email));
    if (exact) return exact;
  }

  const person = splitName(resolveEmployeeDisplay(values) || undefined);
  const params = {
    firstName: person.firstName,
    lastName: person.lastName,
    count: 20,
    from: 0,
    fields: "id,firstName,lastName,email",
  };
  const response = await client.request("GET", "/employee", { params });
  if (steps) pushStep(steps, "GET", "/employee", { params, saveAs: "employee" });
  const exact = responseValues(response)
    .map(employeeFromValue)
    .find((item) => item.id > 0 && textMatches(item.firstName, person.firstName) && textMatches(item.lastName, person.lastName));
  return exact ?? null;
}

async function fetchEmployeeById(
  client: TripletexClient,
  employeeId: number | null,
): Promise<EmployeeRecord | null> {
  if (!employeeId || employeeId <= 0) return null;
  try {
    const response = await client.request("GET", `/employee/${employeeId}`, {
      params: { fields: "id,firstName,lastName,email" },
    });
    const employee = employeeFromValue(primaryValue(response));
    return employee.id > 0 ? employee : null;
  } catch {
    return null;
  }
}

async function ensureDepartmentId(client: TripletexClient, steps: PlanStep[]): Promise<number> {
  const params = { count: 5, from: 0, fields: "id,name" };
  const response = await client.request("GET", "/department", { params });
  pushStep(steps, "GET", "/department", { params, saveAs: "department" });
  const existing = responseValues(response)
    .map((item) => toRecord(item))
    .find((item) => Number(item.id ?? 0) > 0);
  const existingId = Number(existing?.id ?? 0);
  if (existingId > 0) return existingId;

  const created = await client.request("POST", "/department", { body: { name: DEFAULT_DEPARTMENT_NAME } });
  pushStep(steps, "POST", "/department", { body: { name: DEFAULT_DEPARTMENT_NAME }, saveAs: "department" });
  const createdId = Number(toRecord(primaryValue(created)).id ?? 0);
  if (createdId <= 0) throw new Error("Unable to resolve or create department for project invoice employee");
  return createdId;
}

async function resolveProjectManagerId(
  client: TripletexClient,
  values: Record<string, unknown>,
  steps: PlanStep[],
): Promise<number> {
  const managerName = String(values.projectManagerName ?? values.managerName ?? "").trim();
  const managerEmail = String(values.projectManagerEmail ?? "").trim();
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
    && (!managerName || `${item.firstName ?? ""} ${item.lastName ?? ""}`.trim().toLowerCase() === managerName.toLowerCase())
  );
  if (exact?.id) return exact.id;
  if (matches[0]?.id) return matches[0].id;
  const fallbackParams = {
    assignableProjectManagers: true,
    count: 1,
    from: 0,
    fields: "id,firstName,lastName,email",
  };
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
    baseDate: string;
    steps: PlanStep[];
  },
): Promise<ProjectRecord> {
  const found = await findProject(client, input.projectName, input.customer, input.steps);
  if (found?.id) return found;

  const body = {
    name: input.projectName,
    startDate: input.baseDate,
    customer: { id: input.customer.id },
    projectManager: { id: input.projectManagerId },
  };
  const created = await client.request("POST", "/project", { body });
  pushStep(input.steps, "POST", "/project", { body, saveAs: "project" });
  const createdRecord = projectFromValue(primaryValue(created));
  if (createdRecord.id <= 0) throw new Error("Failed to create project for project invoice workflow");
  const detail = await fetchProjectDetail(client, createdRecord.id, input.steps);
  return detail ?? createdRecord;
}

async function findProject(
  client: TripletexClient,
  projectName: string,
  customer: CustomerRecord,
  steps?: PlanStep[],
): Promise<ProjectRecord | null> {
  const params = {
    name: projectName,
    count: 20,
    from: 0,
    fields: "id,name,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email),projectHourlyRates(id,version,startDate,showInProjectOrder,hourlyRateModel,fixedRate),participants(id,employee(id,email)),projectActivities(id,activity(id,name,activityType),startDate,endDate),preliminaryInvoice(id)",
  };
  const response = await client.request("GET", "/project", { params });
  if (steps) pushStep(steps, "GET", "/project", { params, saveAs: "project" });
  const matches = responseValues(response).map(projectFromValue).filter((item) =>
    item.id > 0
    && textMatches(item.name, projectName)
    && (!customer.id || item.customerId === customer.id || (customer.organizationNumber && textMatches(item.customerOrganizationNumber, customer.organizationNumber)))
  );
  return matches[0] ?? null;
}

async function fetchProjectDetail(client: TripletexClient, projectId: number, steps?: PlanStep[]): Promise<ProjectRecord | null> {
  const params = {
    fields: "id,name,customer(id,name,organizationNumber),projectManager(id,firstName,lastName,email),projectHourlyRates(id,version,startDate,showInProjectOrder,hourlyRateModel,fixedRate),participants(id,employee(id,email)),projectActivities(id,activity(id,name,activityType),startDate,endDate),preliminaryInvoice(id)",
  };
  const response = await client.request("GET", `/project/${projectId}`, { params });
  if (steps) pushStep(steps, "GET", `/project/${projectId}`, { params, saveAs: "project" });
  const project = projectFromValue(primaryValue(response));
  return project.id > 0 ? project : null;
}

async function fetchProjectDetailRecord(client: TripletexClient, projectId: number): Promise<Record<string, unknown>> {
  const response = await client.request("GET", `/project/${projectId}`, {
    params: {
      fields: "id,name,projectActivities(id,activity(id,name,activityType),startDate,endDate),participants(id,employee(id,email)),projectHourlyRates(id,version,startDate,showInProjectOrder,hourlyRateModel,fixedRate),preliminaryInvoice(id)",
    },
  });
  return toRecord(primaryValue(response));
}

async function resolveOrCreateActivity(
  client: TripletexClient,
  activityName: string,
  steps: PlanStep[],
): Promise<ActivityRecord> {
  const found = await findActivity(client, activityName, steps);
  if (found?.id) return found;

  const body = {
    name: activityName,
    activityType: "PROJECT_GENERAL_ACTIVITY",
    isChargeable: true,
  };
  const created = await client.request("POST", "/activity", { body });
  pushStep(steps, "POST", "/activity", { body, saveAs: "activity" });
  const activity = activityFromValue(primaryValue(created));
  if (activity.id <= 0) throw new Error("Failed to create activity for project invoice workflow");
  return activity;
}

async function findActivity(
  client: TripletexClient,
  activityName: string,
  steps?: PlanStep[],
): Promise<ActivityRecord | null> {
  const params = {
    name: activityName,
    isProjectActivity: true,
    count: 20,
    from: 0,
    fields: "id,name,activityType,isChargeable",
  };
  const response = await client.request("GET", "/activity", { params });
  if (steps) pushStep(steps, "GET", "/activity", { params, saveAs: "activity" });
  const matches = responseValues(response)
    .map(activityFromValue)
    .filter((item) =>
      item.id > 0
      && textMatches(item.name, activityName)
      && (item.activityType === "PROJECT_GENERAL_ACTIVITY" || item.activityType === "PROJECT_SPECIFIC_ACTIVITY")
    );
  return matches[0] ?? null;
}

async function fetchActivityById(
  client: TripletexClient,
  activityId: number | null,
): Promise<ActivityRecord | null> {
  if (!activityId || activityId <= 0) return null;
  try {
    const response = await client.request("GET", `/activity/${activityId}`, {
      params: { fields: "id,name,activityType,isChargeable" },
    });
    const activity = activityFromValue(primaryValue(response));
    return activity.id > 0 ? activity : null;
  } catch {
    return null;
  }
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

  const body = {
    project: { id: projectId },
    employee: { id: employeeId },
    adminAccess: false,
  };
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
  const responseRecord = await fetchProjectDetailRecord(client, projectId);
  const activities = Array.isArray(responseRecord.projectActivities) ? responseRecord.projectActivities : [];
  const exists = activities.some((item) => Number(toRecord(toRecord(item).activity).id ?? 0) === activityId);
  if (exists) return;

  const body = {
    project: { id: projectId },
    activity: { id: activityId },
    startDate: baseDate,
  };
  try {
    await client.request("POST", "/project/projectActivity", { body });
    pushStep(steps, "POST", "/project/projectActivity", { body });
  } catch (error) {
    if (!(error instanceof TripletexError) || error.statusCode !== 409) throw error;
  }
}

async function ensureProjectHourlyRate(
  client: TripletexClient,
  projectId: number,
  hourlyRate: number,
  baseDate: string,
  steps: PlanStep[],
): Promise<void> {
  const params = {
    projectId,
    count: 20,
    from: 0,
    fields: "id,version,startDate,showInProjectOrder,hourlyRateModel,fixedRate,project(id)",
  };
  const response = await client.request("GET", "/project/hourlyRates", { params });
  pushStep(steps, "GET", "/project/hourlyRates", { params, saveAs: "projectHourlyRate" });
  const existing = responseValues(response)
    .map((item) => toRecord(item))
    .find((item) => String(item.hourlyRateModel ?? "") === "TYPE_FIXED_HOURLY_RATE");
  if (existing) {
    const currentRate = toNumber(existing.fixedRate) ?? 0;
    const showInProjectOrder = Boolean(existing.showInProjectOrder);
    if (Math.abs(currentRate - hourlyRate) < 0.01 && showInProjectOrder) return;
    const hourlyRateId = Number(existing.id ?? 0);
    const version = Number(existing.version ?? 0);
    if (hourlyRateId <= 0) throw new Error("Existing project hourly rate is missing ID");
    const body = {
      version,
      project: { id: projectId },
      startDate: String(existing.startDate ?? baseDate),
      showInProjectOrder: true,
      hourlyRateModel: "TYPE_FIXED_HOURLY_RATE",
      fixedRate: hourlyRate,
    };
    await client.request("PUT", `/project/hourlyRates/${hourlyRateId}`, { body });
    pushStep(steps, "PUT", `/project/hourlyRates/${hourlyRateId}`, { body });
    return;
  }

  const body = {
    project: { id: projectId },
    startDate: baseDate,
    showInProjectOrder: true,
    hourlyRateModel: "TYPE_FIXED_HOURLY_RATE",
    fixedRate: hourlyRate,
  };
  await client.request("POST", "/project/hourlyRates", { body });
  pushStep(steps, "POST", "/project/hourlyRates", { body });
}

async function ensureTimesheetEntries(
  client: TripletexClient,
  input: {
    employee: EmployeeRecord;
    project: ProjectRecord;
    activity: ActivityRecord;
    totalHours: number;
    hourlyRate: number;
    baseDate: string;
    entryChunks: number[];
    commentBase: string;
    steps: PlanStep[];
  },
): Promise<void> {
  const rangeEnd = addDaysIso(input.baseDate, ENTRY_LOOKAHEAD_DAYS);
  const searchParams = {
    employeeId: input.employee.id,
    projectId: input.project.id,
    activityId: input.activity.id,
    dateFrom: input.baseDate,
    dateTo: rangeEnd,
    count: 200,
    from: 0,
    fields: "id,date,hours,chargeableHours,comment,invoice(id),hourlyRate,activity(id,name),project(id,name),employee(id,email)",
  };
  const response = await client.request("GET", "/timesheet/entry", { params: searchParams });
  pushStep(input.steps, "GET", "/timesheet/entry", { params: searchParams });
  const existingEntries = responseValues(response).map((item) => toRecord(item));

  let nextDate = input.baseDate;
  for (let index = 0; index < input.entryChunks.length; index += 1) {
    const chunkHours = input.entryChunks[index]!;
    const comment = input.entryChunks.length > 1
      ? `${input.commentBase} (${index + 1}/${input.entryChunks.length})`.slice(0, 180)
      : input.commentBase;

    const exactExisting = existingEntries.find((item) =>
      textMatches(item.comment, comment)
      && Math.abs((toNumber(item.hours) ?? 0) - chunkHours) < 0.01
      && Math.abs((toNumber(item.projectChargeableHours ?? item.chargeableHours) ?? 0) - chunkHours) < 0.01
    );
    if (exactExisting) continue;

    let candidateDate = nextDate;
    while (candidateDate <= rangeEnd) {
      const conflict = existingEntries.some((item) =>
        String(item.date ?? "") === candidateDate
        && Number(toRecord(item.project).id ?? 0) === input.project.id
        && Number(toRecord(item.activity).id ?? 0) === input.activity.id
        && Number(toRecord(item.employee).id ?? 0) === input.employee.id
      );
      if (!conflict) break;
      candidateDate = addDaysIso(candidateDate, 1);
    }
    if (candidateDate > rangeEnd) {
      throw new Error("Unable to allocate unique dates for project time entries");
    }

    const body = {
      project: { id: input.project.id },
      activity: { id: input.activity.id },
      employee: { id: input.employee.id },
      date: candidateDate,
      hours: chunkHours,
      projectChargeableHours: chunkHours,
      comment,
    };
    const created = await client.request("POST", "/timesheet/entry", { body });
    pushStep(input.steps, "POST", "/timesheet/entry", { body });
    existingEntries.push(toRecord(primaryValue(created)));
    nextDate = addDaysIso(candidateDate, 1);
  }
}

async function ensureOrderWithPreliminaryInvoice(
  client: TripletexClient,
  input: {
    customer: CustomerRecord;
    projectId: number;
    projectName: string;
    activityName: string;
    employeeDisplay: string;
    totalHours: number;
    hourlyRate: number;
    baseDate: string;
    steps: PlanStep[];
    values: Record<string, unknown>;
  },
): Promise<void> {
  const description = buildOrderLineDescription(
    input.projectName,
    input.activityName,
    input.employeeDisplay,
    input.totalHours,
  );
  const existing = await findMatchingOrder(client, {
    customerId: input.customer.id,
    description,
    totalHours: input.totalHours,
    hourlyRate: input.hourlyRate,
    baseDate: input.baseDate,
    steps: input.steps,
  });
  if (existing) return;

  const body = {
    customer: { id: input.customer.id },
    project: { id: input.projectId },
    orderDate: input.baseDate,
    deliveryDate: input.baseDate,
    orderLines: [
      {
        description,
        count: input.totalHours,
        unitPriceExcludingVatCurrency: input.hourlyRate,
      },
    ],
  };
  const created = await client.request("POST", "/order", { body });
  pushStep(input.steps, "POST", "/order", { body, saveAs: "order" });
  const order = toRecord(primaryValue(created));
  if (Number(order.id ?? 0) > 0) input.values.__orderId = Number(order.id);
  const invoiceParams = {
    id: Number(order.id ?? 0),
    invoiceDate: input.baseDate,
    sendToCustomer: false,
  };
  const invoiced = await client.request("PUT", "/order/:invoiceMultipleOrders", { params: invoiceParams });
  pushStep(input.steps, "PUT", "/order/:invoiceMultipleOrders", { params: invoiceParams, saveAs: "invoice" });
  const invoice = toRecord(primaryValue(invoiced));
  if (Number(invoice.id ?? 0) > 0) input.values.__invoiceId = Number(invoice.id);
  if (Number(invoice.id ?? 0) <= 0) {
    throw new Error("Order invoice batch endpoint did not return an invoice id");
  }
}

async function verifyTimesheetEntries(
  client: TripletexClient,
  input: {
    employee: EmployeeRecord;
    project: ProjectRecord;
    activity: ActivityRecord;
    totalHours: number;
    hourlyRate: number;
    baseDate: string;
    commentBase: string;
  },
): Promise<Verification> {
  const searchParams = {
    employeeId: input.employee.id,
    projectId: input.project.id,
    activityId: input.activity.id,
    comment: input.commentBase,
    dateFrom: input.baseDate,
    dateTo: addDaysIso(input.baseDate, ENTRY_LOOKAHEAD_DAYS),
    count: 200,
    from: 0,
    fields: "id,date,hours,chargeableHours,projectChargeableHours,comment,hourlyRate,activity(id,name),project(id,name),employee(id,email)",
  };
  const response = await client.request("GET", "/timesheet/entry", { params: searchParams });
  const entries = responseValues(response).map((item) => toRecord(item)).filter((item) => normalizedText(item.comment).includes(normalizedText(input.commentBase)));
  if (entries.length === 0) {
    return { verified: false, detail: "matching timesheet entries not found after project-hour workflow", required: true };
  }

  const totalRegisteredHours = roundMoney(
    entries.reduce((sum, item) => sum + (toNumber(item.projectChargeableHours ?? item.chargeableHours ?? item.hours) ?? 0), 0),
  );
  if (Math.abs(totalRegisteredHours - input.totalHours) > 0.01) {
    return {
      verified: false,
      detail: `timesheet hours mismatch after project-hour workflow (expected ${formatHours(input.totalHours)}, got ${formatHours(totalRegisteredHours)})`,
      required: true,
    };
  }

  const rateMatches = entries.every((item) => {
    const rate = toNumber(item.hourlyRate);
    return rate !== null && Math.abs(rate - input.hourlyRate) < 0.01;
  });
  if (!rateMatches) {
    return { verified: false, detail: "timesheet entries found, but hourly rate does not match", required: true };
  }

  return { verified: true, detail: "project time entries verified", required: true };
}

async function verifyPreliminaryInvoiceOrder(
  client: TripletexClient,
  input: {
    customer: CustomerRecord;
    projectName: string;
    activityName: string;
    employeeDisplay: string;
    totalHours: number;
    hourlyRate: number;
    baseDate: string;
    directInvoiceId: number | null;
  },
): Promise<Verification> {
  if (input.directInvoiceId && input.directInvoiceId > 0) {
    try {
      const response = await client.request("GET", `/invoice/${input.directInvoiceId}`, {
        params: {
          fields: "id,orderLines(description,displayName,count,unitPriceExcludingVatCurrency),customer(id,name,organizationNumber)",
        },
      });
      const directInvoice = toRecord(primaryValue(response));
      const orderLines = Array.isArray(directInvoice.orderLines) ? directInvoice.orderLines : [];
      const matches = orderLines.some((line) => {
        const record = toRecord(line);
        return textMatches(record.description ?? record.displayName, buildOrderLineDescription(
          input.projectName,
          input.activityName,
          input.employeeDisplay,
          input.totalHours,
        ))
          && Math.abs((toNumber(record.count) ?? 0) - input.totalHours) < 0.01
          && Math.abs((toNumber(record.unitPriceExcludingVatCurrency) ?? 0) - input.hourlyRate) < 0.01;
      });
      if (matches) {
        return { verified: true, detail: "invoice verified via returned id", required: true };
      }
    } catch {
      // Fall back to search-based verification below.
    }
  }

  const description = buildOrderLineDescription(
    input.projectName,
    input.activityName,
    input.employeeDisplay,
    input.totalHours,
  );
  const order = await findMatchingOrder(client, {
    customerId: input.customer.id,
    description,
    totalHours: input.totalHours,
    hourlyRate: input.hourlyRate,
    baseDate: input.baseDate,
  });
  if (!order) {
    return { verified: false, detail: "matching invoice not found after project-hour workflow", required: true };
  }
  return { verified: true, detail: "invoice verified", required: true };
}

async function findMatchingOrder(
  client: TripletexClient,
  input: {
    customerId: number;
    description: string;
    totalHours: number;
    hourlyRate: number;
    baseDate: string;
    steps?: PlanStep[];
  },
): Promise<Record<string, unknown> | null> {
  const params = {
    customerId: input.customerId,
    count: 50,
    from: 0,
    invoiceDateFrom: addDaysIso(input.baseDate, -14),
    invoiceDateTo: addDaysIso(input.baseDate, 31),
    fields: "id,invoiceNumber,invoiceDate,customer(id,name,organizationNumber),orderLines(description,displayName,count,unitPriceExcludingVatCurrency)",
  };
  const response = await client.request("GET", "/invoice", { params });
  if (input.steps) pushStep(input.steps, "GET", "/invoice", { params, saveAs: "invoice" });
  const invoices = responseValues(response).map((item) => toRecord(item));
  return invoices.find((item) => {
    const orderLines = Array.isArray(item.orderLines) ? item.orderLines : [];
    return orderLines.some((line) => {
      const record = toRecord(line);
      return textMatches(record.description ?? record.displayName, input.description)
        && Math.abs((toNumber(record.count) ?? 0) - input.totalHours) < 0.01
        && Math.abs((toNumber(record.unitPriceExcludingVatCurrency) ?? 0) - input.hourlyRate) < 0.01;
    });
  }) ?? null;
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
  return {
    id: Number(record.id ?? 0),
    firstName: typeof record.firstName === "string" ? record.firstName : undefined,
    lastName: typeof record.lastName === "string" ? record.lastName : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
  };
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
  return {
    id: Number(record.id ?? 0),
    name: typeof record.name === "string" ? record.name : undefined,
    customerId: Number(customer.id ?? 0) || undefined,
    customerName: typeof customer.name === "string" ? customer.name : undefined,
    customerOrganizationNumber: typeof customer.organizationNumber === "string" ? customer.organizationNumber : undefined,
  };
}
