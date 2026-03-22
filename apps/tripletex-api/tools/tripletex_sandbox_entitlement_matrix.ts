import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

type TripletexCredentials = {
  base_url: string;
  session_token: string;
};

const DEFAULT_TEMPLATES = [
  "NONE_PRIVILEGES",
  "INVOICING_MANAGER",
  "PERSONELL_MANAGER",
  "ACCOUNTANT",
  "DEPARTMENT_LEADER",
  "ALL_PRIVILEGES",
] as const;

function parseFlag(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

async function readAccountFile(accountPath: string): Promise<TripletexCredentials> {
  const raw = await fs.readFile(accountPath, "utf8");
  const baseUrl = raw.match(/^API URL\s*\n([^\n]+)\s*$/m)?.[1]?.trim();
  const sessionToken = raw.match(/^Session token\s*\n([^\n]+)\s*$/m)?.[1]?.trim();
  assert(baseUrl, `Could not parse API URL from ${accountPath}`);
  assert(sessionToken, `Could not parse session token from ${accountPath}`);
  return {
    base_url: baseUrl,
    session_token: sessionToken,
  };
}

async function resolveTripletexCredentials(): Promise<TripletexCredentials> {
  const baseUrl = process.env.TRIPLETEX_BASE_URL?.trim();
  const sessionToken = process.env.TRIPLETEX_SESSION_TOKEN?.trim();
  if (baseUrl && sessionToken) {
    return { base_url: baseUrl, session_token: sessionToken };
  }
  const repoRoot = process.cwd();
  const accountPath = path.join(repoRoot, "tripletex", "local", "account.txt");
  return readAccountFile(accountPath);
}

function authHeader(sessionToken: string): string {
  return `Basic ${Buffer.from(`0:${sessionToken}`).toString("base64")}`;
}

async function requestJson(
  baseUrl: string,
  sessionToken: string,
  endpoint: string,
  method = "GET",
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { authorization: authHeader(sessionToken) },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} -> ${response.status} ${response.statusText}: ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

function toValues<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.values)) return record.values as T[];
  if (record.value && typeof record.value === "object") return [record.value as T];
  return [];
}

async function resolveEmployeeId(
  creds: TripletexCredentials,
  employeeIdArg?: string,
  employeeEmailArg?: string,
): Promise<number> {
  if (employeeIdArg) {
    const value = Number(employeeIdArg);
    assert(Number.isFinite(value), `Invalid --employee-id: ${employeeIdArg}`);
    return value;
  }
  assert(employeeEmailArg, "Pass --employee-id or --employee-email");
  const payload = await requestJson(
    creds.base_url,
    creds.session_token,
    `/employee?email=${encodeURIComponent(employeeEmailArg)}&count=5&fields=id,email,displayName`,
  );
  const employee = toValues<Record<string, unknown>>(payload)[0];
  assert(employee?.id != null, `No employee found for email ${employeeEmailArg}`);
  return Number(employee.id);
}

function summarizeEntitlements(names: string[]): Record<string, unknown> {
  return {
    count: names.length,
    hasRoleAdministrator: names.includes("ROLE_ADMINISTRATOR"),
    hasCompanyAdmin: names.includes("AUTH_COMPANY_ADMIN"),
    hasClientAccountAdmin: names.includes("AUTH_CLIENT_ACCOUNT_ADMIN"),
    hasCompanyEmployeeAdmin: names.includes("AUTH_COMPANY_EMPLOYEE_ADMIN"),
    hasCompanyWageAdmin: names.includes("AUTH_COMPANY_WAGE_ADMIN"),
    hasInvoicing: names.includes("AUTH_INVOICING"),
    sample: names.filter((name) =>
      /AUTH_INVOICING|AUTH_ORDER_ADMIN|AUTH_PRODUCT_ADMIN|AUTH_COMPANY_ADMIN|AUTH_COMPANY_EMPLOYEE_ADMIN|AUTH_COMPANY_WAGE_ADMIN|AUTH_ALL_VOUCHERS|ROLE_ADMINISTRATOR/.test(
        name,
      ),
    ),
  };
}

async function main(): Promise<void> {
  const employeeIdArg = parseFlag("employee-id");
  const employeeEmailArg = parseFlag("employee-email");
  const templatesArg = parseFlag("templates");
  const templates = (templatesArg ? templatesArg.split(",") : [...DEFAULT_TEMPLATES]).map((item) => item.trim()).filter(Boolean);

  const creds = await resolveTripletexCredentials();
  const employeeId = await resolveEmployeeId(creds, employeeIdArg, employeeEmailArg);

  const employeePayload = await requestJson(
    creds.base_url,
    creds.session_token,
    `/employee/${employeeId}?fields=id,email,displayName`,
  );
  const employee = (employeePayload as Record<string, unknown>).value as Record<string, unknown> | undefined;

  const results: Array<Record<string, unknown>> = [];
  for (const template of templates) {
    await requestJson(
      creds.base_url,
      creds.session_token,
      `/employee/entitlement/:grantEntitlementsByTemplate?employeeId=${encodeURIComponent(String(employeeId))}&template=${encodeURIComponent(template)}`,
      "PUT",
    );
    const entitlementsPayload = await requestJson(
      creds.base_url,
      creds.session_token,
      `/employee/entitlement?employeeId=${encodeURIComponent(String(employeeId))}&count=300&fields=id,name,entitlementId`,
    );
    const names = toValues<Record<string, unknown>>(entitlementsPayload)
      .map((item) => String(item.name ?? ""))
      .filter(Boolean)
      .sort();
    results.push({
      template,
      ...summarizeEntitlements(names),
      names,
    });
  }

  const output = {
    employee: employee ?? { id: employeeId, email: employeeEmailArg ?? null },
    templates: results,
    note: "This probe mutates the sandbox employee's entitlements.",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

await main();
