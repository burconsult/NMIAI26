import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

type TripletexCredentials = {
  base_url: string;
  session_token: string;
};

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

async function requestJson(baseUrl: string, sessionToken: string, endpoint: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { authorization: authHeader(sessionToken) },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return JSON.parse(body);
}

async function fetchOpenApi(baseUrl: string): Promise<unknown> {
  const root = baseUrl.replace(/\/v2\/?$/, "");
  const response = await fetch(`${root}/v2/openapi.json`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return JSON.parse(body);
}

function toValues<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.values)) return record.values as T[];
  if (record.value && typeof record.value === "object") return [record.value as T];
  return [];
}

async function main(): Promise<void> {
  const employeeEmail = parseFlag("employee-email");
  const creds = await resolveTripletexCredentials();

  const [modules, departments, divisions, openapi] = await Promise.all([
    requestJson(creds.base_url, creds.session_token, "/company/modules"),
    requestJson(creds.base_url, creds.session_token, "/department?count=20&fields=id,name"),
    requestJson(creds.base_url, creds.session_token, "/division?count=20&fields=id,name,organizationNumber"),
    fetchOpenApi(creds.base_url),
  ]);

  let employeeSummary: Record<string, unknown> | undefined;
  if (employeeEmail) {
    const employeePayload = await requestJson(
      creds.base_url,
      creds.session_token,
      `/employee?email=${encodeURIComponent(employeeEmail)}&count=5&fields=*`,
    );
    const employee = toValues<Record<string, unknown>>(employeePayload)[0];
    if (employee?.id != null) {
      const [employment, entitlements] = await Promise.all([
        requestJson(
          creds.base_url,
          creds.session_token,
          `/employee/employment?employeeId=${encodeURIComponent(String(employee.id))}&count=20&fields=*`,
        ),
        requestJson(
          creds.base_url,
          creds.session_token,
          `/employee/entitlement?employeeId=${encodeURIComponent(String(employee.id))}&count=200&fields=*`,
        ),
      ]);
      employeeSummary = {
        employee,
        employment: toValues<Record<string, unknown>>(employment),
        entitlements: toValues<Record<string, unknown>>(entitlements).map((item) => ({
          id: item.id,
          name: item.name,
          entitlementId: item.entitlementId,
        })),
      };
    } else {
      employeeSummary = { employee: null, employment: [], entitlements: [] };
    }
  }

  const entitlementTemplateEnum =
    (((openapi as Record<string, unknown>).paths as Record<string, unknown>)?.["/employee/entitlement/:grantEntitlementsByTemplate"] as Record<string, unknown> | undefined)
      ?.put as Record<string, unknown> | undefined;

  const entitlementParameters = Array.isArray(entitlementTemplateEnum?.parameters)
    ? entitlementTemplateEnum.parameters as Array<Record<string, unknown>>
    : [];
  const templateParameter = entitlementParameters.find((param) => param?.name === "template");
  const templateEnum = Array.isArray((templateParameter?.schema as Record<string, unknown> | undefined)?.enum)
    ? (templateParameter?.schema as Record<string, unknown>).enum
    : [];

  const result = {
    baseUrlHost: new URL(creds.base_url).host,
    modules,
    departments: toValues<Record<string, unknown>>(departments),
    divisions: toValues<Record<string, unknown>>(divisions),
    entitlementTemplates: templateEnum,
    ...(employeeSummary ? { employeeProbe: employeeSummary } : {}),
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
