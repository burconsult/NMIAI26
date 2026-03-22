import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { TripletexClient } from "../api/_lib/tripletex.ts";

export type TripletexCredentials = {
  base_url: string;
  session_token: string;
};

export type SolveHarnessResult = {
  status: number;
  verified: boolean;
  runId: string;
  solverStatus?: string;
  bodyText: string;
  json?: unknown;
};

export function parseFlag(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

export function localIsoDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function shiftIsoDate(base: string, days: number): string {
  const [year, month, day] = base.split("-").map((item) => Number(item));
  const utc = Date.UTC(year, month - 1, day + days);
  return new Date(utc).toISOString().slice(0, 10);
}

export function uniqueSuffix(): string {
  return `${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
}

export function makeOrgNumber(seed: number): string {
  const base = 900_000_000 + (seed % 99_999_999);
  return String(base).slice(0, 9);
}

export async function readAccountFile(accountPath: string): Promise<TripletexCredentials> {
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

export async function resolveTripletexCredentials(): Promise<TripletexCredentials> {
  const baseUrl = process.env.TRIPLETEX_BASE_URL?.trim();
  const sessionToken = process.env.TRIPLETEX_SESSION_TOKEN?.trim();
  if (baseUrl && sessionToken) {
    return { base_url: baseUrl, session_token: sessionToken };
  }
  const repoRoot = process.cwd();
  const accountPath = path.join(repoRoot, "tripletex", "local", "account.txt");
  return readAccountFile(accountPath);
}

export function resolveSolveEndpoint(): string {
  return parseFlag("endpoint") ?? process.env.TRIPLETEX_SOLVE_URL ?? "https://nmiai26-tripletex.vercel.app/solve?debug=1";
}

export function resolveApiKey(): string | undefined {
  return parseFlag("api-key") ?? process.env.TRIPLETEX_API_KEY?.trim() ?? undefined;
}

export function createClient(creds: TripletexCredentials): TripletexClient {
  return new TripletexClient({
    baseUrl: creds.base_url,
    sessionToken: creds.session_token,
    timeoutMs: 15_000,
  });
}

export function primaryValue<T = Record<string, unknown>>(response: unknown): T {
  if (!response || typeof response !== "object") return response as T;
  const object = response as Record<string, unknown>;
  if (object.value !== undefined) return object.value as T;
  if (Array.isArray(object.values) && object.values.length > 0) return object.values[0] as T;
  return response as T;
}

export function valuesArray<T = Record<string, unknown>>(response: unknown): T[] {
  if (!response || typeof response !== "object") return [];
  const object = response as Record<string, unknown>;
  return Array.isArray(object.values) ? object.values as T[] : [];
}

export async function postSolve(
  endpoint: string,
  apiKey: string | undefined,
  payload: {
    prompt: string;
    files?: Array<{ filename: string; mime_type: string; content_base64: string }>;
    tripletex_credentials: TripletexCredentials;
  },
): Promise<SolveHarnessResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    verified: response.headers.get("x-tripletex-verified") === "1",
    runId: response.headers.get("x-tripletex-run-id") ?? "",
    solverStatus: response.headers.get("x-tripletex-status") ?? undefined,
    bodyText,
    json,
  };
}

export function printHarnessHeader(name: string, endpoint: string, seed: string): void {
  console.log(`${name} harness`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Seed: ${seed}`);
}

export function assertVerifiedResult(result: SolveHarnessResult): void {
  assert.equal(result.status, 200, `Expected HTTP 200, got ${result.status}: ${result.bodyText}`);
  assert.equal(result.verified, true, `Expected verified=1, got run ${result.runId || "-"}: ${result.bodyText}`);
}
