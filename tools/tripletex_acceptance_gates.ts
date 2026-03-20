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
    name: "executePlan keeps running but surfaces mutating step failures",
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
          summary: "continue after mutating failure but fail attempt",
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

        let threw = false;
        try {
          await executePlan(client, plan, false);
        } catch (error) {
          threw = true;
          const message = error instanceof Error ? error.message : String(error);
          assert(message.includes("mutating steps"), `unexpected error: ${message}`);
        }
        assert(threw, "expected executePlan to throw on mutating step failure");
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
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/invoice"), "expected POST /invoice in heuristic plan");
      const issues = validatePlanForPrompt("Create invoice for customer ACME", plan);
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
