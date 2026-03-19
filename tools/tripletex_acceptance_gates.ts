import assert from "node:assert/strict";

import { executePlan, validatePlanForPrompt } from "../api/_lib/planner.ts";
import { TripletexClient } from "../api/_lib/tripletex.ts";
import type { ExecutionPlan } from "../api/_lib/schemas.ts";

type Gate = {
  name: string;
  run: () => Promise<void> | void;
};

type ContractCase = {
  basePath: string;
  entityPrompt: string;
  methods: Array<"GET" | "POST" | "PUT" | "DELETE">;
  idPathRequiredFor?: Array<"PUT" | "DELETE">;
};

const CONTRACT_CASES: ContractCase[] = [
  { basePath: "/employee", entityPrompt: "employee", methods: ["GET", "POST", "PUT"], idPathRequiredFor: ["PUT"] },
  { basePath: "/customer", entityPrompt: "customer", methods: ["GET", "POST", "PUT"], idPathRequiredFor: ["PUT"] },
  { basePath: "/product", entityPrompt: "product", methods: ["GET", "POST"] },
  { basePath: "/invoice", entityPrompt: "invoice", methods: ["GET", "POST"] },
  { basePath: "/order", entityPrompt: "order", methods: ["GET", "POST"] },
  {
    basePath: "/travelExpense",
    entityPrompt: "travel expense",
    methods: ["GET", "POST", "PUT", "DELETE"],
    idPathRequiredFor: ["PUT", "DELETE"],
  },
  { basePath: "/project", entityPrompt: "project", methods: ["GET", "POST"] },
  { basePath: "/department", entityPrompt: "department", methods: ["GET", "POST"] },
  { basePath: "/ledger/account", entityPrompt: "ledger account", methods: ["GET"] },
  { basePath: "/ledger/posting", entityPrompt: "ledger posting", methods: ["GET"] },
  { basePath: "/ledger/voucher", entityPrompt: "ledger voucher", methods: ["GET", "POST", "DELETE"], idPathRequiredFor: ["DELETE"] },
];

function sampleBody(basePath: string): Record<string, unknown> {
  const today = "2026-03-19";
  switch (basePath) {
    case "/employee":
      return { firstName: "Gate", lastName: "Employee" };
    case "/customer":
      return { name: "Gate Customer", isCustomer: true };
    case "/project":
      return { name: "Gate Project", startDate: today, projectManager: { id: 1 } };
    case "/order":
      return { customer: { id: 1 }, orderDate: today, deliveryDate: today };
    case "/invoice":
      return { customer: { id: 1 }, invoiceDate: today, invoiceDueDate: today, orders: [{ id: 1 }] };
    case "/travelExpense":
      return { employee: { id: 1 }, date: today, title: "Gate Expense" };
    case "/department":
      return { name: "Gate Department" };
    case "/product":
      return { name: "Gate Product" };
    case "/ledger/voucher":
      return { date: today, description: "Gate Voucher", postings: [{ amount: 1, account: { id: 1 } }] };
    default:
      return { name: "Gate" };
  }
}

function getPromptForMethod(entityPrompt: string, method: "GET" | "POST" | "PUT" | "DELETE"): string {
  if (method === "GET") return `List one ${entityPrompt} without modifying anything`;
  if (method === "POST") return `Create ${entityPrompt}`;
  if (method === "PUT") return `Update ${entityPrompt}`;
  return `Delete ${entityPrompt}`;
}

function getParamsForMethod(basePath: string, method: "GET" | "POST" | "PUT" | "DELETE"): Record<string, unknown> | undefined {
  if (method !== "GET") return undefined;
  if (basePath === "/ledger/posting" || basePath === "/ledger/voucher") {
    return { dateFrom: "2026-01-01", dateTo: "2026-12-31", count: 1 };
  }
  if (basePath === "/order") {
    return { orderDateFrom: "2026-01-01", orderDateTo: "2026-12-31", count: 1 };
  }
  if (basePath === "/invoice") {
    return { invoiceDateFrom: "2026-01-01", invoiceDateTo: "2026-12-31", count: 1 };
  }
  return { count: 1 };
}

function buildPlan(caseDef: ContractCase, method: "GET" | "POST" | "PUT" | "DELETE"): ExecutionPlan {
  const idPathRequired = (caseDef.idPathRequiredFor ?? []).includes(method as "PUT" | "DELETE");
  return {
    summary: `${caseDef.basePath} ${method} acceptance plan`,
    steps: [
      {
        method,
        path: idPathRequired ? `${caseDef.basePath}/123` : caseDef.basePath,
        params: getParamsForMethod(caseDef.basePath, method),
        body: method === "POST" || method === "PUT" ? sampleBody(caseDef.basePath) : undefined,
      },
    ],
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runGates(): Promise<void> {
  const gates: Gate[] = [];

  for (const caseDef of CONTRACT_CASES) {
    for (const method of caseDef.methods) {
      gates.push({
        name: `validatePlanForPrompt accepts ${method} ${caseDef.basePath}`,
        run: () => {
          const plan = buildPlan(caseDef, method);
          const prompt = getPromptForMethod(caseDef.entityPrompt, method);
          const issues = validatePlanForPrompt(prompt, plan);
          assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
        },
      });
    }
  }

  gates.push({
    name: "validatePlanForPrompt rejects GET /order without required date range",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "bad order read",
        steps: [{ method: "GET", path: "/order", params: { count: 1 } }],
      };
      const issues = validatePlanForPrompt("List one order without modifying anything", plan);
      assert(issues.some((issue) => issue.includes("orderDateFrom")), `missing expected issue: ${issues.join(" | ")}`);
      assert(issues.some((issue) => issue.includes("orderDateTo")), `missing expected issue: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "validatePlanForPrompt rejects GET /invoice without required date range",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "bad invoice read",
        steps: [{ method: "GET", path: "/invoice", params: { count: 1 } }],
      };
      const issues = validatePlanForPrompt("List one invoice without modifying anything", plan);
      assert(issues.some((issue) => issue.includes("invoiceDateFrom")), `missing expected issue: ${issues.join(" | ")}`);
      assert(issues.some((issue) => issue.includes("invoiceDateTo")), `missing expected issue: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "validatePlanForPrompt rejects repeated identical mutations",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "duplicate mutations",
        steps: [
          { method: "POST", path: "/department", body: { name: "Gate" } },
          { method: "POST", path: "/department", body: { name: "Gate" } },
        ],
      };
      const issues = validatePlanForPrompt("Create department", plan);
      assert(issues.some((issue) => issue.includes("repeated identical mutating steps")), `missing expected issue: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "executePlan injects required GET query params (order/invoice/ledger)",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, query, body });
        return jsonResponse(200, { values: [{ id: 1 }] });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan: ExecutionPlan = {
          summary: "query defaults",
          steps: [
            { method: "GET", path: "/order", params: { count: 1 } },
            { method: "GET", path: "/invoice", params: { count: 1 } },
            { method: "GET", path: "/ledger/posting", params: { count: 1 } },
            { method: "GET", path: "/ledger/voucher", params: { count: 1 } },
          ],
        };
        await executePlan(client, plan, false);

        const byPath = (path: string) => {
          const found = calls.find((call) => call.method === "GET" && call.path === path);
          assert(found, `missing GET call for ${path}`);
          return found.query;
        };

        const orderQuery = byPath("/order");
        assert(orderQuery.orderDateFrom, "orderDateFrom missing");
        assert(orderQuery.orderDateTo, "orderDateTo missing");
        assert.equal(orderQuery.count, "1");

        const invoiceQuery = byPath("/invoice");
        assert(invoiceQuery.invoiceDateFrom, "invoiceDateFrom missing");
        assert(invoiceQuery.invoiceDateTo, "invoiceDateTo missing");
        assert.equal(invoiceQuery.count, "1");

        const postingQuery = byPath("/ledger/posting");
        assert(postingQuery.dateFrom, "ledger posting dateFrom missing");
        assert(postingQuery.dateTo, "ledger posting dateTo missing");

        const voucherQuery = byPath("/ledger/voucher");
        assert(voucherQuery.dateFrom, "ledger voucher dateFrom missing");
        assert(voucherQuery.dateTo, "ledger voucher dateTo missing");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan retries project POST after 422 and repairs projectManager",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body: unknown; query: Record<string, string> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [{ id: 301 }] });
        }
        if (method === "GET" && path === "/employee") {
          return jsonResponse(200, { values: [{ id: 302 }] });
        }
        if (method === "POST" && path === "/project") {
          const projectBody = body as Record<string, unknown>;
          const projectManager = projectBody?.projectManager as Record<string, unknown> | undefined;
          if (!projectManager || !projectManager.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "projectManager", message: "Kan ikke være null." }],
            });
          }
          return jsonResponse(201, { value: { id: 555 } });
        }
        return jsonResponse(200, { value: { id: 1 } });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan: ExecutionPlan = {
          summary: "project retry",
          steps: [{ method: "POST", path: "/project", body: { name: "Gate Project" } }],
        };
        await executePlan(client, plan, false);

        const projectPosts = calls.filter((call) => call.method === "POST" && call.path === "/project");
        assert.equal(projectPosts.length, 2, "expected initial POST /project + repaired retry POST /project");

        const repairedBody = projectPosts[1]?.body as Record<string, unknown>;
        assert(repairedBody?.startDate, "repaired project body missing startDate");
        const projectManager = repairedBody?.projectManager as Record<string, unknown> | undefined;
        assert(projectManager?.id, "repaired project body missing projectManager.id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  const failures: Array<{ name: string; error: string }> = [];
  for (const gate of gates) {
    try {
      await gate.run();
      console.log(`PASS  ${gate.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: gate.name, error: message });
      console.log(`FAIL  ${gate.name}`);
      console.log(`      ${message}`);
    }
  }

  console.log(`\nSummary: ${gates.length - failures.length}/${gates.length} gates passed.`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await runGates();
