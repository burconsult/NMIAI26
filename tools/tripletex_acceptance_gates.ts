import assert from "node:assert/strict";

import { executePlan, heuristicPlan, validatePlanForPrompt } from "../api/_lib/planner.ts";
import { TripletexClient } from "../api/_lib/tripletex.ts";
import type { ExecutionPlan } from "../api/_lib/schemas.ts";

type Gate = {
  name: string;
  run: () => Promise<void> | void;
};

type ContractCase = {
  basePath: string;
  actionName?: string;
  entityPrompt: string;
  methods: Array<"GET" | "POST" | "PUT" | "DELETE">;
  idPathRequiredFor?: Array<"POST" | "PUT" | "DELETE">;
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
  { basePath: "/invoice", actionName: "payment", entityPrompt: "invoice payment", methods: ["POST"], idPathRequiredFor: ["POST"] },
  {
    basePath: "/invoice",
    actionName: "createCreditNote",
    entityPrompt: "invoice credit note",
    methods: ["POST"],
    idPathRequiredFor: ["POST"],
  },
  { basePath: "/order", actionName: "invoice", entityPrompt: "order invoice", methods: ["POST"], idPathRequiredFor: ["POST"] },
  {
    basePath: "/ledger/voucher",
    actionName: "reverse",
    entityPrompt: "ledger voucher reverse",
    methods: ["POST"],
    idPathRequiredFor: ["POST"],
  },
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

function sampleExecutionBody(
  caseDef: ContractCase,
  method: "GET" | "POST" | "PUT" | "DELETE",
): Record<string, unknown> | undefined {
  if (method !== "POST" && method !== "PUT") return undefined;
  if (caseDef.actionName === "payment") {
    return { paymentDate: "2026-03-19", amount: 10 };
  }
  if (caseDef.actionName === "createCreditNote") {
    return { date: "2026-03-19", reason: "Gate credit note" };
  }
  if (caseDef.actionName === "invoice") {
    return { invoiceDate: "2026-03-19" };
  }
  if (caseDef.actionName === "reverse") {
    return { date: "2026-03-19", description: "Gate reverse" };
  }
  const base = sampleBody(caseDef.basePath);
  if (method === "PUT") {
    return {
      ...base,
      id: 123,
      version: 1,
    };
  }
  return base;
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
  const idPathRequired = (caseDef.idPathRequiredFor ?? []).includes(method as "POST" | "PUT" | "DELETE");
  const path =
    idPathRequired && caseDef.actionName
      ? `${caseDef.basePath}/123/:${caseDef.actionName}`
      : idPathRequired
        ? `${caseDef.basePath}/123`
        : caseDef.basePath;
  return {
    summary: `${caseDef.basePath} ${method} acceptance plan`,
    steps: [
      {
        method,
        path,
        params: getParamsForMethod(caseDef.basePath, method),
        body: sampleExecutionBody(caseDef, method),
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
        name: `validatePlanForPrompt accepts ${method} ${caseDef.basePath}${caseDef.actionName ? `/:${caseDef.actionName}` : ""}`,
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
    name: "executePlan supports full endpoint/method matrix with mocked API",
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

        if (method === "GET") {
          return jsonResponse(200, { values: [{ id: 123, version: 1, name: "Gate Entity" }] });
        }
        if (method === "POST") {
          return jsonResponse(201, { value: { id: 9000 + calls.length, version: 1 } });
        }
        if (method === "PUT") {
          const putBody = (body ?? {}) as Record<string, unknown>;
          if (putBody.id === undefined || putBody.version === undefined) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "id", message: "id and version are required" }],
            });
          }
          return jsonResponse(200, {
            value: {
              id: putBody.id,
              version: Number(putBody.version) + 1,
            },
          });
        }
        return jsonResponse(200, { value: { id: 1 } });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });

        for (const caseDef of CONTRACT_CASES) {
          for (const method of caseDef.methods) {
            const requiresIdPath = (caseDef.idPathRequiredFor ?? []).includes(method as "POST" | "PUT" | "DELETE");
            const path =
              requiresIdPath && caseDef.actionName
                ? `${caseDef.basePath}/123/:${caseDef.actionName}`
                : requiresIdPath
                  ? `${caseDef.basePath}/123`
                  : caseDef.basePath;
            const plan: ExecutionPlan = {
              summary: `matrix ${method} ${caseDef.basePath}`,
              steps: [
                {
                  method,
                  path,
                  params: getParamsForMethod(caseDef.basePath, method),
                  body: sampleExecutionBody(caseDef, method),
                },
              ],
            };
            await executePlan(client, plan, false);
          }
        }

        const expectedMinimumCalls = CONTRACT_CASES.reduce((sum, def) => sum + def.methods.length, 0);
        assert(
          calls.length >= expectedMinimumCalls,
          `expected at least ${expectedMinimumCalls} calls, observed ${calls.length}`,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "validatePlanForPrompt allows GET /order without date range (executor auto-injects)",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "order read without dates",
        steps: [{ method: "GET", path: "/order", params: { count: 1 } }],
      };
      const issues = validatePlanForPrompt("List one order without modifying anything", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "validatePlanForPrompt allows GET /invoice without date range (executor auto-injects)",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "invoice read without dates",
        steps: [{ method: "GET", path: "/invoice", params: { count: 1 } }],
      };
      const issues = validatePlanForPrompt("List one invoice without modifying anything", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
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
    name: "validatePlanForPrompt rejects out-of-scope mutating entity",
    run: () => {
      const plan: ExecutionPlan = {
        summary: "customer request but invoice mutation",
        steps: [
          { method: "GET", path: "/customer", params: { count: 1 } },
          { method: "POST", path: "/invoice", body: { customer: { id: 1 }, invoiceDate: "2026-03-19", invoiceDueDate: "2026-03-19" } },
        ],
      };
      const issues = validatePlanForPrompt("Create customer Acme AS", plan);
      assert(
        issues.some((issue) => issue.includes("outside prompt scope")),
        `missing expected out-of-scope issue: ${issues.join(" | ")}`,
      );
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

  gates.push({
    name: "executePlan hydrates missing product_id template by creating product",
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
          return jsonResponse(200, { values: [{ id: 701 }] });
        }
        if (method === "GET" && path === "/product") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/product") {
          return jsonResponse(201, { value: { id: 702 } });
        }
        if (method === "POST" && path === "/order") {
          const orderBody = body as Record<string, unknown>;
          const product = orderBody?.product as Record<string, unknown> | undefined;
          if (!product?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "product", message: "Kan ikke være null." }],
            });
          }
          return jsonResponse(201, { value: { id: 703 } });
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
          summary: "hydrate missing product id",
          steps: [
            {
              method: "GET",
              path: "/customer",
              params: { organizationNumber: "935400759", count: 1 },
              saveAs: "customer",
            },
            {
              method: "GET",
              path: "/product",
              params: { name: "Data Advisory", count: 1 },
              saveAs: "product",
            },
            {
              method: "POST",
              path: "/order",
              body: {
                customer: { id: "{{customer_id}}" },
                product: { id: "{{product_id}}" },
                orderDate: "2026-03-19",
                deliveryDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        const productCreates = calls.filter((call) => call.method === "POST" && call.path === "/product");
        assert.equal(productCreates.length, 1, "expected product create to hydrate missing product_id");
        const orderPosts = calls.filter((call) => call.method === "POST" && call.path === "/order");
        assert.equal(orderPosts.length, 1, "expected one order create call");
        const orderBody = orderPosts[0]?.body as Record<string, unknown>;
        const product = orderBody?.product as Record<string, unknown> | undefined;
        assert.equal(product?.id, 702, "order should reference hydrated product id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan hydrates missing invoice_id template for payment action",
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

        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, { values: [{ id: 9050 }] });
        }
        if (method === "POST" && path === "/invoice/9050/:payment") {
          return jsonResponse(200, { value: { id: 9051 } });
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
          summary: "hydrate missing invoice id for payment",
          steps: [
            {
              method: "POST",
              path: "/invoice/{{invoice_id}}/:payment",
              body: {
                paymentDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/invoice").length,
          1,
          "expected invoice lookup before action call",
        );
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/invoice/9050/:payment").length,
          1,
          "expected payment action to use hydrated invoice id",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan hydrates missing voucher_id template for reverse action",
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

        if (method === "GET" && path === "/ledger/voucher") {
          return jsonResponse(200, { values: [{ id: 7060 }] });
        }
        if (method === "POST" && path === "/ledger/voucher/7060/:reverse") {
          return jsonResponse(200, { value: { id: 7061 } });
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
          summary: "hydrate missing voucher id for reverse",
          steps: [
            {
              method: "POST",
              path: "/ledger/voucher/{{voucher_id}}/:reverse",
              body: {
                date: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/ledger/voucher").length,
          1,
          "expected voucher lookup before reverse action",
        );
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/ledger/voucher/7060/:reverse").length,
          1,
          "expected reverse action to use hydrated voucher id",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan hydrates multiple missing template ids in same step",
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

        if (method === "GET" && path === "/customer") return jsonResponse(200, { values: [] });
        if (method === "POST" && path === "/customer") return jsonResponse(201, { value: { id: 811 } });
        if (method === "GET" && path === "/product") return jsonResponse(200, { values: [] });
        if (method === "POST" && path === "/product") return jsonResponse(201, { value: { id: 812 } });
        if (method === "POST" && path === "/order") {
          const orderBody = body as Record<string, unknown>;
          const customer = orderBody?.customer as Record<string, unknown> | undefined;
          const product = orderBody?.product as Record<string, unknown> | undefined;
          if (!customer?.id || !product?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "customer", message: "Kan ikke være null." }],
            });
          }
          return jsonResponse(201, { value: { id: 813 } });
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
          summary: "hydrate multiple missing ids",
          steps: [
            {
              method: "GET",
              path: "/customer",
              params: { organizationNumber: "935400759", count: 1 },
              saveAs: "customer",
            },
            {
              method: "GET",
              path: "/product",
              params: { name: "Data Advisory", count: 1 },
              saveAs: "product",
            },
            {
              method: "POST",
              path: "/order",
              body: {
                customer: { id: "{{customerId}}" },
                product: { id: "{{productId}}" },
                orderDate: "2026-03-19",
                deliveryDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/customer").length,
          1,
          "expected customer create during template hydration",
        );
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/product").length,
          1,
          "expected product create during template hydration",
        );
        const orderPosts = calls.filter((call) => call.method === "POST" && call.path === "/order");
        assert.equal(orderPosts.length, 1, "expected one order create call");
        const orderBody = orderPosts[0]?.body as Record<string, unknown>;
        assert.equal((orderBody?.customer as Record<string, unknown> | undefined)?.id, 811);
        assert.equal((orderBody?.product as Record<string, unknown> | undefined)?.id, 812);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan removes unknown mapping fields on 422 and retries",
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

        if (method === "POST" && path === "/invoice") {
          const invoiceBody = body as Record<string, unknown>;
          if (invoiceBody?.sendType || invoiceBody?.sendTypeEmail) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [
                { code: 16000, field: "sendTypeEmail", message: "Cannot map field 'sendTypeEmail'." },
                { code: 16000, field: "sendType", message: "Cannot map field 'sendType'." },
              ],
            });
          }
          return jsonResponse(201, { value: { id: 991 } });
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
          summary: "remove unknown mapping fields",
          steps: [
            {
              method: "POST",
              path: "/invoice",
              body: {
                customer: { id: 1 },
                invoiceDate: "2026-03-19",
                invoiceDueDate: "2026-03-19",
                orders: [{ id: 100 }],
                sendTypeEmail: true,
                sendType: "EMAIL",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        const invoicePosts = calls.filter((call) => call.method === "POST" && call.path === "/invoice");
        assert.equal(invoicePosts.length, 2, "expected initial POST /invoice + repaired retry POST /invoice");
        const firstBody = invoicePosts[0]?.body as Record<string, unknown>;
        const secondBody = invoicePosts[1]?.body as Record<string, unknown>;
        assert(firstBody?.sendTypeEmail !== undefined, "initial body should include unsupported field");
        assert(firstBody?.sendType !== undefined, "initial body should include unsupported field");
        assert.equal(secondBody?.sendTypeEmail, undefined, "retry body must remove sendTypeEmail");
        assert.equal(secondBody?.sendType, undefined, "retry body must remove sendType");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan retries invoice POST on 422 without field hints",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body: unknown; query: Record<string, string> }> = [];
      let invoiceAttempts = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/customer") return jsonResponse(200, { values: [{ id: 4001 }] });
        if (method === "GET" && path === "/order") return jsonResponse(200, { values: [{ id: 4002 }] });
        if (method === "POST" && path === "/invoice") {
          invoiceAttempts += 1;
          const invoiceBody = body as Record<string, unknown>;
          const orders = invoiceBody?.orders as Array<Record<string, unknown>> | undefined;
          if (invoiceAttempts === 1) {
            return jsonResponse(422, {
              status: 422,
              message: "Validation failed",
              validationMessages: [],
            });
          }
          if (!Array.isArray(orders) || orders.length === 0) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "orders", message: "Kan ikke være tom." }],
            });
          }
          return jsonResponse(201, { value: { id: 4999 } });
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
          summary: "invoice retry without explicit fields",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1, fields: "id" }, saveAs: "customer" },
            { method: "GET", path: "/order", params: { count: 1, fields: "id", orderDateFrom: "2026-01-01", orderDateTo: "2026-12-31" }, saveAs: "order" },
            {
              method: "POST",
              path: "/invoice",
              body: {
                customer: { id: "{{customer_id}}" },
                invoiceDate: "2026-03-19",
                invoiceDueDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        const invoicePosts = calls.filter((call) => call.method === "POST" && call.path === "/invoice");
        assert.equal(invoicePosts.length, 2, "expected invoice POST retry when first 422 has no field hints");
        const secondBody = invoicePosts[1]?.body as Record<string, unknown>;
        assert(Array.isArray(secondBody?.orders), "retry should inject orders array");
        assert.equal((secondBody.orders as Array<Record<string, unknown>>)[0]?.id, 4002, "retry should use saved order id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan handles fixed-price project milestone create flow failures",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body: unknown; query: Record<string, string> }> = [];
      let orderHadLines = false;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/customer") return jsonResponse(200, { values: [] });
        if (method === "GET" && path === "/employee") return jsonResponse(200, { values: [] });
        if (method === "GET" && path === "/department") return jsonResponse(200, { values: [{ id: 7001 }] });
        if (method === "GET" && path === "/product") return jsonResponse(200, { values: [] });
        if (method === "GET" && path === "/order") return jsonResponse(200, { values: [] });

        if (method === "POST" && path === "/customer") {
          const customerBody = (body ?? {}) as Record<string, unknown>;
          if (!customerBody.name) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "name", message: "Feltet må fylles ut." }],
            });
          }
          return jsonResponse(201, { value: { id: 7101 } });
        }

        if (method === "POST" && path === "/employee") {
          const employeeBody = (body ?? {}) as Record<string, unknown>;
          const department = employeeBody.department as Record<string, unknown> | undefined;
          if (!employeeBody.email || !department?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [
                { field: "email", message: "Feltet må fylles ut." },
                { field: "department.id", message: "Feltet må fylles ut." },
              ],
            });
          }
          return jsonResponse(201, { value: { id: 7201 } });
        }

        if (method === "POST" && path === "/project") {
          const projectBody = (body ?? {}) as Record<string, unknown>;
          const manager = projectBody.projectManager as Record<string, unknown> | undefined;
          if (!manager?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "projectManager", message: "Kan ikke være null." }],
            });
          }
          return jsonResponse(201, { value: { id: 7301 } });
        }

        if (method === "POST" && path === "/product") {
          const productBody = (body ?? {}) as Record<string, unknown>;
          if (!productBody.name) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "name", message: "Feltet må fylles ut." }],
            });
          }
          return jsonResponse(201, { value: { id: 7401 } });
        }

        if (method === "POST" && path === "/order") {
          const orderBody = (body ?? {}) as Record<string, unknown>;
          const lines = orderBody.orderLines as Array<Record<string, unknown>> | undefined;
          orderHadLines = Array.isArray(lines) && lines.length > 0;
          if (!orderHadLines) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "orderLines", message: "Må ha minst én ordrelinje." }],
            });
          }
          return jsonResponse(201, { value: { id: 7501 } });
        }

        if (method === "POST" && path === "/invoice") {
          if (!orderHadLines) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "orders", message: "Ordren mangler fakturerbare linjer." }],
            });
          }
          return jsonResponse(201, { value: { id: 7601 } });
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
          summary: "fixed-price milestone execution",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1, fields: "id", organizationNumber: "872682023", name: "Clearwater Ltd" }, saveAs: "customer" },
            { method: "GET", path: "/employee", params: { count: 1, fields: "id", email: "oliver.brown@example.org", firstName: "Oliver", lastName: "Brown" }, saveAs: "employee" },
            { method: "POST", path: "/project", body: { name: "Cloud Migration", startDate: "2026-03-19", customer: { id: "{{customer_id}}" }, projectManager: { id: "{{employee_id}}" } }, saveAs: "project" },
            { method: "GET", path: "/product", params: { count: 1, fields: "id", name: "Milestone 25% Cloud Migration" }, saveAs: "product" },
            { method: "POST", path: "/order", body: { customer: { id: "{{customer_id}}" }, orderDate: "2026-03-19", deliveryDate: "2026-03-19" }, saveAs: "order" },
            { method: "POST", path: "/invoice", body: { customer: { id: "{{customer_id}}" }, invoiceDate: "2026-03-19", invoiceDueDate: "2026-03-19", orders: [{ id: "{{order_id}}" }] }, saveAs: "invoice" },
          ],
        };
        await executePlan(client, plan, false);

        const orderPost = calls.find((call) => call.method === "POST" && call.path === "/order");
        const orderBody = (orderPost?.body ?? {}) as Record<string, unknown>;
        const lines = orderBody.orderLines as Array<Record<string, unknown>> | undefined;
        assert(Array.isArray(lines) && lines.length > 0, "order fallback should inject orderLines");

        const employeePost = calls.find((call) => call.method === "POST" && call.path === "/employee");
        const employeeBody = (employeePost?.body ?? {}) as Record<string, unknown>;
        assert(employeeBody.email, "employee fallback should include email");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan repairs missing project manager via broad employee lookup before creating employee",
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
          return jsonResponse(200, { values: [{ id: 8101 }] });
        }
        if (method === "GET" && path === "/employee") {
          const strictLookup = Boolean(query.firstName || query.lastName || query.email);
          if (strictLookup) return jsonResponse(200, { values: [] });
          return jsonResponse(200, { values: [{ id: 8201 }] });
        }
        if (method === "POST" && path === "/project") {
          const managerId = Number(
            ((body as Record<string, unknown>)?.projectManager as Record<string, unknown> | undefined)?.id,
          );
          if (managerId !== 8201) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "projectManager.id", message: "ID-en må referere til et gyldig object." }],
            });
          }
          return jsonResponse(201, { value: { id: 8301 } });
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
          summary: "project manager fallback lookup flow",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1 }, saveAs: "customer" },
            {
              method: "GET",
              path: "/employee",
              params: { count: 1, firstName: "Oliver", lastName: "Brown", email: "oliver.brown@example.org" },
              saveAs: "employee",
            },
            {
              method: "POST",
              path: "/project",
              body: {
                name: "Cloud Migration",
                startDate: "2026-03-19",
                customer: { id: "{{customer_id}}" },
                projectManager: { id: "{{employee_id}}" },
              },
            },
          ],
        };

        await executePlan(client, plan, false);

        const projectPost = calls.find((call) => call.method === "POST" && call.path === "/project");
        const projectBody = (projectPost?.body ?? {}) as Record<string, unknown>;
        const manager = (projectBody.projectManager ?? {}) as Record<string, unknown>;
        assert.equal(Number(manager.id), 8201, "expected fallback to broad employee lookup id");
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/employee").length,
          0,
          "expected no employee creation when broad lookup can provide manager id",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan continues after mutating failure when at least one step succeeds",
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

        if (method === "GET" && path === "/customer") return jsonResponse(200, { values: [{ id: 1001 }] });
        if (method === "POST" && path === "/invoice") {
          return jsonResponse(422, {
            status: 422,
            validationMessages: [{ field: "orders", message: "Kan ikke være tom." }],
          });
        }
        if (method === "GET" && path === "/employee") return jsonResponse(200, { values: [{ id: 1002 }] });
        return jsonResponse(200, { value: { id: 1 } });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan: ExecutionPlan = {
          summary: "continue after mutating failure — partial work preserved",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1 }, saveAs: "customer" },
            {
              method: "POST",
              path: "/invoice",
              body: {
                customer: { id: "{{customer_id}}" },
                invoiceDate: "2026-03-19",
                invoiceDueDate: "2026-03-19",
              },
            },
            { method: "GET", path: "/employee", params: { count: 1 } },
          ],
        };

        await executePlan(client, plan, false);
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/invoice").length >= 1,
          true,
          "expected mutating step to be attempted at least once",
        );
        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/employee").length,
          1,
          "expected execution to continue to subsequent steps after failure",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan injects travel expense paymentType defaults via lookup endpoint",
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

        if (method === "GET" && path === "/employee") return jsonResponse(200, { values: [{ id: 3001 }] });
        if (method === "GET" && path === "/travelExpense/paymentType") {
          return jsonResponse(200, { values: [{ id: 3002, description: "Privat utlegg" }] });
        }
        if (method === "POST" && path === "/travelExpense") {
          const payload = body as Record<string, unknown>;
          const costs = Array.isArray(payload.costs) ? (payload.costs as Array<Record<string, unknown>>) : [];
          const paymentType = (costs[0]?.paymentType ?? {}) as Record<string, unknown>;
          if (!paymentType.id || !paymentType.description) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "costs.paymentType", message: "Feltet må fylles ut." }],
            });
          }
          return jsonResponse(201, { value: { id: 3003 } });
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
          summary: "travel expense paymentType defaults",
          steps: [
            { method: "GET", path: "/employee", params: { count: 1 }, saveAs: "employee" },
            {
              method: "POST",
              path: "/travelExpense",
              body: {
                employee: { id: "{{employee_id}}" },
                date: "2026-03-19",
                title: "Trip",
                costs: [{ comments: "Taxi", amountCurrencyIncVat: 500, date: "2026-03-19" }],
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/travelExpense/paymentType").length,
          1,
          "expected one payment type lookup",
        );
        const travelExpensePost = calls.find((call) => call.method === "POST" && call.path === "/travelExpense");
        assert(travelExpensePost, "expected POST /travelExpense");
        const costs = ((travelExpensePost.body as Record<string, unknown>)?.costs ?? []) as Array<Record<string, unknown>>;
        const paymentType = (costs[0]?.paymentType ?? {}) as Record<string, unknown>;
        assert.equal(paymentType.id, 3002, "expected injected paymentType id");
        assert.equal(paymentType.description, "Privat utlegg", "expected injected paymentType description");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan resolves values.0.id template form against primary value",
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
          return jsonResponse(200, { values: [{ id: 1201, name: "Acme" }] });
        }
        if (method === "POST" && path === "/order") {
          return jsonResponse(201, { value: { id: 1202 } });
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
          summary: "values.0.id compatibility",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1 }, saveAs: "customer" },
            {
              method: "POST",
              path: "/order",
              body: {
                customer: { id: "{{customer.values.0.id}}" },
                orderDate: "2026-03-19",
                deliveryDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        const orderPost = calls.find((call) => call.method === "POST" && call.path === "/order");
        assert(orderPost, "expected POST /order call");
        const customer = (orderPost.body as Record<string, unknown>)?.customer as Record<string, unknown> | undefined;
        assert.equal(customer?.id, 1201, "expected template variable customer.values.0.id to resolve to saved id");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan repairs employee POST on 422 with userType+department defaults",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body: unknown; query: Record<string, string> }> = [];
      let employeePostAttempts = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/department") {
          return jsonResponse(200, { values: [{ id: 838077, name: "Avdeling" }] });
        }
        if (method === "POST" && path === "/employee") {
          employeePostAttempts += 1;
          const employeeBody = body as Record<string, unknown>;
          if (employeePostAttempts === 1 && employeeBody?.employmentDate) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ code: 16000, field: "employmentDate", message: "Feltet eksisterer ikke i objektet." }],
            });
          }
          const department = employeeBody?.department as Record<string, unknown> | undefined;
          if (!department?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "department.id", message: "Feltet må fylles ut." }],
            });
          }
          return jsonResponse(201, { value: { id: 1337 } });
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
          summary: "employee retries",
          steps: [
            {
              method: "POST",
              path: "/employee",
              body: {
                firstName: "Gate",
                lastName: "Employee",
                employmentDate: "2026-03-19",
              },
            },
          ],
        };
        await executePlan(client, plan, false);

        const employeePosts = calls.filter((call) => call.method === "POST" && call.path === "/employee");
        assert.equal(employeePosts.length, 2, "expected initial POST /employee + repaired retry");
        const firstBody = employeePosts[0]?.body as Record<string, unknown>;
        const secondBody = employeePosts[1]?.body as Record<string, unknown>;
        assert(firstBody?.employmentDate, "first attempt should include unsupported employmentDate");
        assert.equal(secondBody?.employmentDate, undefined, "second attempt should remove unsupported employmentDate");
        assert.equal(secondBody?.userType, "STANDARD", "retry flow should set default userType");
        assert.equal(
          (secondBody?.department as Record<string, unknown> | undefined)?.id,
          838077,
          "retry flow should hydrate department.id",
        );
        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/department").length,
          1,
          "expected one department lookup during retry enrichment",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "TripletexClient retries transient network failures",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const previousMaxAttempts = process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS;
      const previousBackoff = process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS;
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        if (attempts <= 2) {
          throw new TypeError("fetch failed");
        }
        return jsonResponse(200, { value: { id: 1 } });
      };

      process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS = "3";
      process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS = "1";

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 2000,
        });
        const response = await client.request("POST", "/customer", {
          body: { name: "Acme", isCustomer: true },
        });
        assert.equal((response as Record<string, unknown>)?.value ? 1 : 0, 1, "expected successful retry response");
        assert.equal(attempts, 3, "expected 3 attempts after transient network failures");
      } finally {
        globalThis.fetch = originalFetch;
        if (previousMaxAttempts === undefined) delete process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS;
        else process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS = previousMaxAttempts;
        if (previousBackoff === undefined) delete process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS;
        else process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS = previousBackoff;
      }
    },
  });

  gates.push({
    name: "TripletexClient retries retryable HTTP status codes",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const previousMaxAttempts = process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS;
      const previousBackoff = process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS;
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(502, { status: 502, message: "Bad gateway" });
        }
        return jsonResponse(201, { value: { id: 2 } });
      };

      process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS = "2";
      process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS = "1";

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 2000,
        });
        const response = await client.request("POST", "/invoice", {
          body: { customer: { id: 1 }, invoiceDate: "2026-03-19", invoiceDueDate: "2026-03-19" },
        });
        assert.equal((response as Record<string, unknown>)?.value ? 1 : 0, 1, "expected successful response after retry");
        assert.equal(attempts, 2, "expected one retry on 502 response");
      } finally {
        globalThis.fetch = originalFetch;
        if (previousMaxAttempts === undefined) delete process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS;
        else process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS = previousMaxAttempts;
        if (previousBackoff === undefined) delete process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS;
        else process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS = previousBackoff;
      }
    },
  });

  gates.push({
    name: "heuristic fallback produces valid order create flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Create order for customer ACME",
        files: [],
        tripletex_credentials: {
          base_url: "https://example.test/v2",
          session_token: "token",
        },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), "expected POST /order in heuristic plan");
      const issues = validatePlanForPrompt("Create order for customer ACME", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects fixed-price milestone invoice flow",
    run: () => {
      const plan = heuristicPlan({
        prompt:
          "Set a fixed price of 202150 NOK on the project \"Cloud Migration\" for Clearwater Ltd (org no. 872682023). The project manager is Oliver Brown (oliver.brown@example.org). Invoice the customer for 25% of the fixed price as a milestone payment.",
        files: [],
        tripletex_credentials: {
          base_url: "https://example.test/v2",
          session_token: "token",
        },
      });
      assert.equal(plan.steps.length, 6, "expected deterministic 6-step fixed-price milestone flow");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/project"), "expected POST /project");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), "expected POST /order");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/invoice"), "expected POST /invoice");

      const orderStep = plan.steps.find((step) => step.method === "POST" && step.path === "/order");
      const orderBody = (orderStep?.body ?? {}) as Record<string, unknown>;
      const lines = orderBody.orderLines as Array<Record<string, unknown>> | undefined;
      assert(Array.isArray(lines) && lines.length > 0, "expected orderLines in milestone flow");
      const price = Number(lines[0]?.unitPriceExcludingVatCurrency);
      assert.equal(price, 50537.5, "expected 25% of 202150 as milestone amount");
    },
  });

  gates.push({
    name: "heuristic fallback produces valid invoice create flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Create invoice for customer ACME",
        files: [],
        tripletex_credentials: {
          base_url: "https://example.test/v2",
          session_token: "token",
        },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), "expected POST /order in heuristic plan");
      assert(
        plan.steps.some((step) => step.method === "POST" && step.path === "/order/{{order_id}}/:invoice"),
        "expected POST /order/{{order_id}}/:invoice in heuristic plan",
      );
      const issues = validatePlanForPrompt("Create invoice for customer ACME", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects invoice payment flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Register payment for invoice 1234 with amount 2500 NOK",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.path === "/invoice/1234/:payment"), "expected invoice payment action path");
      const issues = validatePlanForPrompt("Register payment for invoice 1234 with amount 2500 NOK", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects credit note flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Create credit note for invoice 2345 due to overcharge",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(
        plan.steps.some((step) => step.path === "/invoice/2345/:createCreditNote"),
        "expected createCreditNote action path",
      );
      const issues = validatePlanForPrompt("Create credit note for invoice 2345 due to overcharge", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects voucher reverse flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Reverse voucher 3210",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(
        plan.steps.some((step) => step.path === "/ledger/voucher/3210/:reverse"),
        "expected ledger voucher reverse action path",
      );
      const issues = validatePlanForPrompt("Reverse voucher 3210", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects order invoice flow",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Invoice order 888",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.path === "/order/888/:invoice"), "expected order invoice action path");
      const issues = validatePlanForPrompt("Invoice order 888", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "heuristic detects Norwegian employee create prompt",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Opprett en ansatt med navn Kari Nordmann og e-post kari@firma.no",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/employee"), "expected POST /employee");
      const body = plan.steps.find((step) => step.method === "POST")?.body as Record<string, unknown>;
      assert(body?.firstName || body?.lastName, "expected name fields in body");
    },
  });

  gates.push({
    name: "heuristic detects Spanish customer create prompt",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Crear un cliente llamado Acme SA con correo info@acme.es",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/customer"), "expected POST /customer");
    },
  });

  gates.push({
    name: "heuristic detects department via generic entity detection",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Erstellen Sie eine Abteilung namens Verkauf",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/department"), "expected POST /department");
    },
  });

  gates.push({
    name: "heuristic detects project create and includes prerequisites",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Opprett prosjekt Bygg 2026",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/project"), "expected POST /project");
    },
  });

  gates.push({
    name: "heuristic detects Norwegian travel expense delete",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Slett reiseregning 12345",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "DELETE"), "expected DELETE step");
    },
  });

  gates.push({
    name: "heuristic builds rich travel expense body with per diem and costs",
    run: () => {
      const plan = heuristicPlan({
        prompt:
          "Registe uma despesa de viagem para Rafael Sousa (rafael.sousa@example.org) referente a \"Visita cliente Tromsø\". A viagem durou 5 dias com ajudas de custo (taxa diária 800 NOK). Despesas: bilhete de avião 6000 NOK e táxi 700 NOK.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      const travelStep = plan.steps.find((step) => step.method === "POST" && step.path === "/travelExpense");
      assert(travelStep, "expected POST /travelExpense in heuristic plan");
      const body = (travelStep?.body ?? {}) as Record<string, unknown>;
      const perDiem = Array.isArray(body.perDiemCompensations) ? body.perDiemCompensations : [];
      const costs = Array.isArray(body.costs) ? body.costs : [];
      assert.equal(perDiem.length, 1, "expected one per diem item");
      assert.equal(Number((perDiem[0] as Record<string, unknown>)?.count), 5, "expected extracted day count");
      assert.equal(Number((perDiem[0] as Record<string, unknown>)?.rate), 800, "expected extracted daily rate");
      assert(costs.length >= 2, "expected extracted travel costs");
      const firstCostPaymentType = ((costs[0] as Record<string, unknown>)?.paymentType ?? {}) as Record<string, unknown>;
      assert(firstCostPaymentType.id, "expected templated paymentType id in costs");
      assert(firstCostPaymentType.description, "expected templated paymentType description in costs");
    },
  });

  gates.push({
    name: "executePlan resolves bracket template paths from saved list aliases",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body: unknown; query: Record<string, string> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body, query });
        if (method === "GET" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { values: [{ id: 4242 }] });
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
          summary: "bracket var interpolation",
          steps: [
            {
              method: "GET",
              path: "/ledger/voucher",
              params: { count: 1 },
              saveAs: "vouchers",
            },
            {
              method: "POST",
              path: "/ledger/voucher/{{vouchers.values[0].id}}/:reverse",
              body: { date: "2026-03-19" },
            },
          ],
        };
        await executePlan(client, plan, false);
        const reverseCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/:reverse"));
        assert(reverseCall, "expected reverse call");
        assert.equal(reverseCall?.path, "/ledger/voucher/4242/:reverse", "expected bracket path interpolation");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "heuristic invoice create builds order invoice flow with extracted product lines",
    run: () => {
      const plan = heuristicPlan({
        prompt:
          "Créez une facture pour le client Lumière SARL (nº org. 925760838) avec trois lignes de produit : Maintenance (3644) à 1850 NOK avec 25 % TVA, Licence logicielle (4934) à 14850 NOK avec 15 % TVA, et Service premium (1204) à 920 NOK avec 25 % TVA.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), "expected POST /order");
      assert(
        plan.steps.some((step) => step.method === "POST" && step.path === "/order/{{order_id}}/:invoice"),
        "expected POST /order/{{order_id}}/:invoice",
      );
      const productLookups = plan.steps.filter((step) => step.method === "GET" && step.path === "/product");
      assert(productLookups.length >= 3, "expected product lookups for extracted product lines");
    },
  });

  gates.push({
    name: "heuristic generic fallback still produces a plan with steps",
    run: () => {
      const plan = heuristicPlan({
        prompt: "Do something with the accounting system",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert(plan.steps.length >= 1, "expected at least one step in generic fallback");
      assert(plan.steps[0]?.method === "POST", "expected a POST step as last-resort create");
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
