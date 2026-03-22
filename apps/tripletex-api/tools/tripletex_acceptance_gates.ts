import assert from "node:assert/strict";

import { executeAccountingDimensionWorkflow } from "../api/_lib/accounting_dimension.ts";
import { executeAttachmentOnboardingWorkflow } from "../api/_lib/attachment_onboarding.ts";
import { executeBankReconciliationWorkflow } from "../api/_lib/bank_reconciliation.ts";
import { shiftIsoDateInZone, todayIsoInZone } from "../api/_lib/dates.ts";
import { executeExpenseVoucherWorkflow } from "../api/_lib/expense_voucher.ts";
import { executeInvoicePaymentWorkflow } from "../api/_lib/invoice_payment.ts";
import { executeInvoiceReminderWorkflow } from "../api/_lib/invoice_reminder.ts";
import { executeLedgerErrorCorrectionWorkflow } from "../api/_lib/ledger_error_correction.ts";
import { executeLedgerVarianceProjectsWorkflow } from "../api/_lib/ledger_variance_projects.ts";
import { executeMonthEndClosingWorkflow } from "../api/_lib/month_end_closing.ts";
import { executePayrollWorkflow } from "../api/_lib/payroll.ts";
import { executePlan, heuristicPlan, validatePlanForPrompt, type ExecutePlanResult } from "../api/_lib/planner.ts";
import { executeProjectCycleWorkflow } from "../api/_lib/project_cycle.ts";
import { compileProjectTimeInvoicePreview } from "../api/_lib/project_time_invoice.ts";
import { executeReturnedPaymentWorkflow } from "../api/_lib/returned_payment.ts";
import { executeSupplierInvoiceWorkflow } from "../api/_lib/supplier_invoice.ts";
import { compilePlan, heuristicExtract, normalizeTaskSpec, verifyOutcome, type TaskSpec } from "../api/_lib/task_spec.ts";
import { TripletexClient } from "../api/_lib/tripletex.ts";
import type { ExecutionPlan } from "../api/_lib/schemas.ts";
import { detectFamily } from "./tripletex_feedback/families.ts";
import { TRIPLETEX_SCENARIO_MATRIX } from "./tripletex_scenario_matrix.ts";

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
  { basePath: "/supplier", entityPrompt: "supplier", methods: ["GET", "POST", "PUT"], idPathRequiredFor: ["PUT"] },
  { basePath: "/product", entityPrompt: "product", methods: ["GET", "POST"] },
  { basePath: "/invoice", entityPrompt: "invoice", methods: ["GET", "POST"] },
  { basePath: "/invoice/paymentType", entityPrompt: "invoice payment type", methods: ["GET"] },
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
  { basePath: "/ledger/accountingDimensionName", entityPrompt: "accounting dimension", methods: ["GET", "POST"] },
  { basePath: "/ledger/accountingDimensionValue", entityPrompt: "accounting dimension value", methods: ["POST"] },
  { basePath: "/ledger/accountingDimensionValue/search", entityPrompt: "accounting dimension value", methods: ["GET"] },
  { basePath: "/ledger/posting", entityPrompt: "ledger posting", methods: ["GET"] },
  { basePath: "/ledger/voucher", entityPrompt: "ledger voucher", methods: ["GET", "POST", "DELETE"], idPathRequiredFor: ["DELETE"] },
  { basePath: "/invoice", actionName: "payment", entityPrompt: "invoice payment", methods: ["POST", "PUT"], idPathRequiredFor: ["POST", "PUT"] },
  {
    basePath: "/invoice",
    actionName: "createCreditNote",
    entityPrompt: "invoice credit note",
    methods: ["POST", "PUT"],
    idPathRequiredFor: ["POST", "PUT"],
  },
  { basePath: "/order", actionName: "invoice", entityPrompt: "order invoice", methods: ["POST", "PUT"], idPathRequiredFor: ["POST", "PUT"] },
  {
    basePath: "/ledger/voucher",
    actionName: "reverse",
    entityPrompt: "ledger voucher reverse",
    methods: ["POST", "PUT"],
    idPathRequiredFor: ["POST", "PUT"],
  },
];

function sampleBody(basePath: string): Record<string, unknown> {
  const today = "2026-03-19";
  switch (basePath) {
    case "/employee":
      return { firstName: "Gate", lastName: "Employee" };
    case "/customer":
      return { name: "Gate Customer", isCustomer: true };
    case "/supplier":
      return { name: "Gate Supplier", isSupplier: true, isCustomer: false };
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
    case "/ledger/accountingDimensionName":
      return { dimensionName: "Gate Dimension", description: "Gate dimension", active: true };
    case "/ledger/accountingDimensionValue":
      return { displayName: "Gate Value", dimensionIndex: 1, number: "G1", showInVoucherRegistration: true, active: true };
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
    return { paymentDate: "2026-03-19", paymentTypeId: 1, paidAmount: 10 };
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
  if (basePath === "/ledger/accountingDimensionValue/search") {
    return { dimensionIndex: 1, count: 1, from: 0 };
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

function parseJsonBody(body: RequestInit["body"]): Record<string, unknown> | null {
  if (typeof body !== "string" || !body.trim()) return null;
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
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
    name: "compilePlan uses invoice payment type lookup before invoice payment action",
    run: () => {
      const plan = compilePlan({
        operation: "pay_invoice",
        entity: "invoice",
        values: { amount: 2500 },
        lookup: { id: 1234 },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.path, "/invoice/paymentType");
      assert.equal(plan.steps[1]?.path, "/invoice/1234/:payment");
    },
  });

  gates.push({
    name: "compilePlan builds product create flow with VAT and ledger account lookup",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "product",
        values: {
          name: "System Development",
          productNumber: "5511",
          price: 28500,
          cost: 12000,
          vatRate: 25,
          accountNumber: "3400",
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.path, "/ledger/account");
      assert.equal(plan.steps[0]?.method, "GET");
      assert.equal(plan.steps[1]?.path, "/product");
      assert.equal(plan.steps[1]?.method, "POST");
      assert.deepEqual(plan.steps[1]?.body?.vatType, { id: 3 });
      assert.equal(plan.steps[1]?.body?.account?.id, "{{account_id}}");
      assert.equal(plan.steps[1]?.body?.priceExcludingVatCurrency, 28500);
      assert.equal(plan.steps[1]?.body?.costExcludingVatCurrency, 12000);
    },
  });

  gates.push({
    name: "verifyOutcome checks product price VAT and account, not just id",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/v2/product/501") {
          return jsonResponse(200, {
            value: {
              id: 501,
              name: "System Development",
              number: "5511",
              priceExcludingVatCurrency: 28500,
              costExcludingVatCurrency: 12000,
              vatType: { id: 3, percentage: 25 },
              account: { id: 3401 },
            },
          });
        }
        if (method === "GET" && url.pathname === "/v2/ledger/account/3401") {
          return jsonResponse(200, { value: { id: 3401, number: 3400, name: "Sales" } });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test/v2",
          sessionToken: "token",
          timeoutMs: 5000,
        });
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "product",
          values: {
            name: "System Development",
            productNumber: "5511",
            price: 28500,
            cost: 12000,
            vatRate: 25,
            accountNumber: "3400",
          },
        } satisfies TaskSpec, {
          stepCount: 1,
          successCount: 1,
          mutatingAttempted: 1,
          mutatingSucceeded: 1,
          vars: { product_id: 501, product: { id: 501 } },
          failedSteps: [],
          stepResults: [{ step: 1, method: "POST", path: "/product", saveAs: "product", primary: { id: 501 } }],
        } satisfies ExecutePlanResult);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeInvoicePaymentWorkflow resolves the matching invoice instead of paying the first candidate",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path, query });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [{ id: 8101, name: "Windkraft GmbH", organizationNumber: "954808483" }] });
        }
        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 9101,
                customer: { id: 8101, name: "Windkraft GmbH", organizationNumber: "954808483" },
                amountExcludingVat: 47600,
                amountOutstanding: 47600,
                orderLines: [{ description: "Hosting", product: { name: "Hosting" } }],
              },
              {
                id: 9102,
                customer: { id: 8101, name: "Windkraft GmbH", organizationNumber: "954808483" },
                amountExcludingVat: 47600,
                amountOutstanding: 47600,
                orderLines: [{ description: "Systementwicklung", product: { name: "Systementwicklung" } }],
              },
            ],
          });
        }
        if (method === "GET" && path === "/invoice/paymentType") {
          return jsonResponse(200, { values: [{ id: 77, description: "Bank" }] });
        }
        if (method === "PUT" && path === "/invoice/9102/:payment") {
          assert.equal(query.paymentTypeId, "77");
          assert.equal(query.paidAmount, "47600");
          return jsonResponse(200, { value: { id: 9102 } });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        const spec = {
          operation: "pay_invoice",
          entity: "invoice",
          values: {
            customerName: "Windkraft GmbH",
            organizationNumber: "954808483",
            amount: 47600,
            description: "Systementwicklung",
          },
          lookup: {},
        } satisfies TaskSpec;

        const plan = await executeInvoicePaymentWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.path === "/invoice/9102/:payment"), "expected payment step for the matched invoice");
        assert.equal(spec.values.__paidInvoiceId, 9102);
        assert(calls.some((call) => call.method === "PUT" && call.path === "/invoice/9102/:payment"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome accepts settled pay_invoice when org number and amount match even if labels drift",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;
        if (method === "GET" && path === "/invoice/9103") {
          return jsonResponse(200, {
            value: {
              id: 9103,
              customer: { id: 8101, name: "Canary 259519tol AS", organizationNumber: "900259519" },
              amountExcludingVat: 1500,
              amountOutstanding: 0,
              orderLines: [{ displayName: "914588 Generated product 473878" }],
            },
          });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        const verification = await verifyOutcome(client, {
          operation: "pay_invoice",
          entity: "invoice",
          values: {
            __paidInvoiceId: 9103,
            customerName: "Canary 259519tol AS",
            organizationNumber: "900259519",
            amount: 1500,
            description: "Canary Licence 259519tol",
          },
          lookup: {},
        } satisfies TaskSpec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.required, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeInvoicePaymentWorkflow pays full outstanding amount, not just the prompt's ex-VAT identifier",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let paidAmount: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [{ id: 8101, name: "Canary 259519tol AS", organizationNumber: "900259519" }] });
        }
        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 9103,
                customer: { id: 8101, name: "Canary 259519tol AS", organizationNumber: "900259519" },
                amount: 1825,
                amountExcludingVat: 1500,
                amountOutstanding: 1825,
                orderLines: [{ displayName: "914588 Generated product 473878" }],
              },
            ],
          });
        }
        if (method === "GET" && path === "/invoice/paymentType") {
          return jsonResponse(200, { values: [{ id: 77, description: "Bank" }] });
        }
        if (method === "PUT" && path === "/invoice/9103/:payment") {
          paidAmount = query.paidAmount;
          return jsonResponse(200, { value: { id: 9103 } });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        await executeInvoicePaymentWorkflow(client, {
          operation: "pay_invoice",
          entity: "invoice",
          values: {
            customerName: "Canary 259519tol AS",
            organizationNumber: "900259519",
            amount: 1500,
            description: "Canary Licence 259519tol",
          },
          lookup: {},
        }, false);
        assert.equal(paidAmount, "1825");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeInvoicePaymentWorkflow creates prerequisite invoice when no matching open invoice exists",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        calls.push({ method, path, query, body });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/customer") {
          return jsonResponse(201, { value: { id: 8201, name: "Windkraft GmbH", organizationNumber: "954808483" } });
        }
        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/order") {
          return jsonResponse(201, { value: { id: 9301 } });
        }
        if (method === "PUT" && path === "/order/:invoiceMultipleOrders") {
          return jsonResponse(200, { value: { id: 9401 } });
        }
        if (method === "GET" && path === "/invoice/9401") {
          return jsonResponse(200, {
            value: {
              id: 9401,
              customer: { id: 8201, name: "Windkraft GmbH", organizationNumber: "954808483" },
              amount: 47600,
              amountExcludingVat: 47600,
              amountOutstanding: 47600,
              orderLines: [{ description: "Systementwicklung" }],
            },
          });
        }
        if (method === "GET" && path === "/invoice/paymentType") {
          return jsonResponse(200, { values: [{ id: 77, description: "Bank" }] });
        }
        if (method === "PUT" && path === "/invoice/9401/:payment") {
          return jsonResponse(200, { value: { id: 9401 } });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        const spec = {
          operation: "pay_invoice",
          entity: "invoice",
          values: {
            customerName: "Windkraft GmbH",
            organizationNumber: "954808483",
            amount: 47600,
            description: "Systementwicklung",
            vatRate: 0,
          },
          lookup: {},
        } satisfies TaskSpec;
        const plan = await executeInvoicePaymentWorkflow(client, spec, false);
        assert.equal(spec.values.__paidInvoiceId, 9401);
        assert(plan.steps.some((step) => step.path === "/invoice/9401/:payment"));
        assert(calls.some((call) => call.method === "POST" && call.path === "/customer"));
        assert(calls.some((call) => call.method === "POST" && call.path === "/order"));
        const orderCall = calls.find((call) => call.method === "POST" && call.path === "/order");
        const orderLine = (((orderCall?.body ?? {}).orderLines ?? []) as Array<Record<string, unknown>>)[0] ?? {};
        assert.deepEqual(orderLine.vatType, { id: 5 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome requires settled invoice for pay_invoice tasks",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;
        if (method === "GET" && path === "/invoice/9102") {
          return jsonResponse(200, {
            value: {
              id: 9102,
              customer: { id: 8101, name: "Windkraft GmbH", organizationNumber: "954808483" },
              amountExcludingVat: 47600,
              amountOutstanding: 1250,
              orderLines: [{ description: "Systementwicklung", product: { name: "Systementwicklung" } }],
            },
          });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        const verification = await verifyOutcome(client, {
          operation: "pay_invoice",
          entity: "invoice",
          values: {
            __paidInvoiceId: 9102,
            customerName: "Windkraft GmbH",
            organizationNumber: "954808483",
            amount: 47600,
            description: "Systementwicklung",
          },
          lookup: {},
        } satisfies TaskSpec, null);
        assert.equal(verification.verified, false);
        assert.equal(verification.required, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "compilePlan credit note action uses documented date field",
    run: () => {
      const plan = compilePlan({
        operation: "create_credit_note",
        entity: "invoice",
        values: { date: "2026-03-19", comment: "Gate credit note" },
        lookup: { id: 1234 },
      } satisfies TaskSpec);
      const body = (plan.steps[0]?.body ?? {}) as Record<string, unknown>;
      assert.equal(body.date, "2026-03-19");
      assert.equal("creditNoteDate" in body, false);
    },
  });

  gates.push({
    name: "compilePlan does not emit unsupported DELETE /order/{id}",
    run: () => {
      const plan = compilePlan({
        operation: "delete",
        entity: "order",
        values: {},
        lookup: { id: 1234 },
      } satisfies TaskSpec);
      assert.equal(plan.steps.some((step) => step.method === "DELETE"), false);
      assert.equal(plan.steps[0]?.method, "GET");
    },
  });

  gates.push({
    name: "compilePlan supports multi-department create batches",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "department",
        values: {
          names: ["Administrasjon", "Kundeservice", "Markedsforing"],
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps.length, 3);
      assert.equal(plan.steps.every((step) => step.method === "POST" && step.path === "/department"), true);
    },
  });

  gates.push({
    name: "normalizeTaskSpec backfills project customer org number and manager email from the prompt",
    run: () => {
      const payload = {
        prompt: 'Opprett prosjektet "Implementering Tindra" knyttet til kunden Tindra AS (org.nr 886715536). Prosjektleder er Jonas Haugen (jonas.haugen@example.org).',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "create",
        entity: "project",
        values: {
          name: "Implementering Tindra",
          customerName: "Tindra AS",
          projectManagerName: "Jonas Haugen",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.values.organizationNumber, "886715536");
      assert.equal(normalized.values.projectManagerEmail, "jonas.haugen@example.org");
    },
  });

  gates.push({
    name: "heuristic task-spec extraction keeps project prompts on project instead of customer",
    run: () => {
      const payload = {
        prompt: 'Opprett prosjektet "Implementering Tindra" knyttet til kunden Tindra AS (org.nr 886715536). Prosjektleder er Jonas Haugen (jonas.haugen@example.org).',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const spec = heuristicExtract(payload);
      assert.equal(spec.entity, "project");
    },
  });

  gates.push({
    name: "heuristicExtract captures German Projektleiter manager identity",
    run: () => {
      const payload = {
        prompt: 'Erstellen Sie das Projekt "Integration Windkraft" verknüpft mit dem Kunden Windkraft GmbH (Org.-Nr. 804172807). Projektleiter ist Hannah Weber (hannah.weber@example.org).',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const spec = heuristicExtract(payload);
      assert.equal(spec.entity, "project");
      assert.equal(spec.values.projectName, "Integration Windkraft");
      assert.equal(spec.values.projectManagerName, "Hannah Weber");
      assert.equal(spec.values.projectManagerEmail, "hannah.weber@example.org");
      assert.equal(spec.values.customerName, "Windkraft GmbH");
    },
  });

  gates.push({
    name: "normalizeTaskSpec keeps quoted project name separate from customer name",
    run: () => {
      const spec = normalizeTaskSpec({
        prompt: 'Opprett prosjektet "Migrasjon Vestfjord" knytt til kunden Vestfjord AS (org.nr 887727872). Prosjektleiar er Liv Stølsvik (liv.stlsvik@example.org).',
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      }, {
        operation: "create",
        entity: "project",
        values: {
          name: "Vestfjord AS",
          customerName: "Vestfjord AS",
          organizationNumber: "887727872",
          projectManagerEmail: "liv.stlsvik@example.org",
        },
      } satisfies TaskSpec);
      assert.equal(spec.entity, "project");
      assert.equal(spec.values.projectName, "Migrasjon Vestfjord");
      assert.equal(spec.values.name, "Migrasjon Vestfjord");
      assert.equal(spec.values.customerName, "Vestfjord AS");
    },
  });

  gates.push({
    name: "compilePlan resolves project customer and manager before create",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "project",
        values: {
          name: "Implementering Tindra",
          customerName: "Tindra AS",
          organizationNumber: "886715536",
          projectManagerName: "Jonas Haugen",
          projectManagerEmail: "jonas.haugen@example.org",
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.method, "GET");
      assert.equal(plan.steps[0]?.path, "/customer");
      assert.equal(plan.steps[1]?.method, "GET");
      assert.equal(plan.steps[1]?.path, "/employee");
      const employeeParams = (plan.steps[1]?.params ?? {}) as Record<string, unknown>;
      assert.equal(employeeParams.assignableProjectManagers, true);
      assert.equal(plan.steps[2]?.method, "POST");
      assert.equal(plan.steps[2]?.path, "/project");
      const body = (plan.steps[2]?.body ?? {}) as Record<string, unknown>;
      assert.deepEqual(body.customer, { id: "{{customer_id}}" });
      assert.deepEqual(body.projectManager, { id: "{{employee_id}}" });
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts fixed-price milestone prompts into invoice creation",
    run: () => {
      const payload = {
        prompt: 'Establezca un precio fijo de 375250 NOK en el proyecto "Desarrollo e-commerce" para Estrella SL (org. nº 816896770). El director del proyecto es Laura Rodríguez (laura.rodriguez@example.org). Facture al cliente el 33 % del precio fijo como un pago por hito.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "update",
        entity: "project",
        values: {
          name: "Desarrollo e-commerce",
          customerName: "Estrella SL",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "create");
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.values.projectName, "Desarrollo e-commerce");
      assert.equal(normalized.values.fixedPriceAmount, 375250);
      assert.equal(normalized.values.milestonePercent, 33);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts Norwegian fixed-price partial invoice prompts into invoice creation",
    run: () => {
      const payload = {
        prompt: 'Sett fastpris 206950 kr på prosjektet "Datasikkerhet" for Tindra AS (org.nr 833180568). Prosjektleder er Karin Bakken (karin.bakken@example.org). Fakturer kunden for 33 % av fastprisen som en delbetaling.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "update",
        entity: "project",
        values: {
          name: "Datasikkerhet",
          customerName: "Tindra AS",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "create");
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.values.projectName, "Datasikkerhet");
      assert.equal(normalized.values.fixedPriceAmount, 206950);
      assert.equal(normalized.values.milestonePercent, 33);
    },
  });

  gates.push({
    name: "normalizeTaskSpec keeps project create prompts on project even when client is mentioned",
    run: () => {
      const payload = {
        prompt: 'Créez le projet "Migration Lumière" lié au client Lumière SARL (nº org. 849572458). Le chef de projet est Nathan Dubois (nathan.dubois@example.org).',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "create",
        entity: "customer",
        values: {
          customerName: "Lumière SARL",
          organizationNumber: "849572458",
          projectManagerName: "Nathan Dubois",
          projectManagerEmail: "nathan.dubois@example.org",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.entity, "project");
      assert.equal(normalized.values.projectName, "Migration Lumière");
      assert.equal(normalized.values.customerName, "Lumière SARL");
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts composite order invoice payment prompts into invoice workflow",
    run: () => {
      const payload = {
        prompt: "Erstellen Sie einen Auftrag für den Kunden Brückentor GmbH (Org.-Nr. 907980634) mit den Produkten Analysebericht (8563) zu 20400 NOK und Wartung (3063) zu 15250 NOK. Wandeln Sie den Auftrag in eine Rechnung um und registrieren Sie die vollständige Zahlung.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "create",
        entity: "order",
        values: {
          customerName: "Brückentor GmbH",
          organizationNumber: "907980634",
          invoiceLines: [
            { productName: "Analysebericht", productNumber: "8563", amount: 20400 },
            { productName: "Wartung", productNumber: "3063", amount: 15250 },
          ],
        },
      } satisfies TaskSpec);
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.values.registerPayment, true);
    },
  });

  gates.push({
    name: "compilePlan builds fixed-price milestone invoice flow with project scaffold",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "invoice",
        values: {
          projectName: "Desarrollo e-commerce",
          customerName: "Estrella SL",
          organizationNumber: "816896770",
          projectManagerName: "Laura Rodríguez",
          projectManagerEmail: "laura.rodriguez@example.org",
          fixedPriceAmount: 375250,
          milestonePercent: 33,
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.path, "/customer");
      assert.equal(plan.steps[1]?.path, "/employee");
      const employeeParams = (plan.steps[1]?.params ?? {}) as Record<string, unknown>;
      assert.equal(employeeParams.assignableProjectManagers, true);
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/project"), "expected POST /project");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), "expected POST /order");
      const projectStep = plan.steps.find((step) => step.method === "POST" && step.path === "/project");
      const projectBody = (projectStep?.body ?? {}) as Record<string, unknown>;
      assert.equal(projectBody.isFixedPrice, true);
      assert.equal(projectBody.fixedprice, 375250);
      const orderStep = plan.steps.find((step) => step.method === "POST" && step.path === "/order");
      const orderBody = (orderStep?.body ?? {}) as Record<string, unknown>;
      assert.deepEqual(orderBody.project, { id: "{{project_id}}" });
      assert.equal(plan.steps.at(-1)?.path, "/order/:invoiceMultipleOrders");
    },
  });

  gates.push({
    name: "normalizeTaskSpec infers invoice subject as product line",
    run: () => {
      const payload = {
        prompt: "Create and send an invoice to the customer Ridgepoint Ltd (org no. 941587437) for 40400 NOK excluding VAT. The invoice is for Maintenance.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Ridgepoint Ltd",
          organizationNumber: "941587437",
          amount: 40400,
          description: "Maintenance",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.values.productName, "Maintenance");
      const lines = Array.isArray(normalized.values.invoiceLines) ? normalized.values.invoiceLines as Array<Record<string, unknown>> : [];
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.productName, "Maintenance");
      assert.equal(lines[0]?.amount, 40400);
    },
  });

  gates.push({
    name: "normalizeTaskSpec infers zero VAT for 'without VAT' invoice prompts",
    run: () => {
      const payload = {
        prompt: 'Der Kunde Windkraft GmbH (Org.-Nr. 954808483) hat eine offene Rechnung über 47600 NOK ohne MwSt. für "Systementwicklung". Registrieren Sie die vollständige Zahlung dieser Rechnung.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.operation, "pay_invoice");
      assert.equal(normalized.values.vatRate, 0);
    },
  });

  gates.push({
    name: "normalizeTaskSpec captures French invoice subject and hors TVA as zero-VAT invoice line",
    run: () => {
      const payload = {
        prompt: "Créez et envoyez une facture au client Colline SARL (nº org. 944164340) de 44750 NOK hors TVA. La facture concerne Service réseau.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.operation, "create");
      assert.equal(normalized.values.customerName, "Colline SARL");
      assert.equal(normalized.values.organizationNumber, "944164340");
      assert.equal(normalized.values.sendInvoice, true);
      assert.equal(normalized.values.vatRate, 0);
      assert.equal(normalized.values.productName, "Service réseau");
      const lines = Array.isArray(normalized.values.invoiceLines) ? normalized.values.invoiceLines as Array<Record<string, unknown>> : [];
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.description, "Service réseau");
      assert.equal(lines[0]?.amount, 44750);
      assert.equal(lines[0]?.vatRate, 0);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts project timesheet billing prompts into invoice creation with hours and activity",
    run: () => {
      const payload = {
        prompt: 'Log 29 hours for Ella Williams (ella.williams@example.org) on the activity "Testing" in the project "Platform Integration" for Windmill Ltd (org no. 839360274). Hourly rate: 1350 NOK/h. Generate a project invoice to the customer.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Windmill Ltd",
          organizationNumber: "839360274",
          employeeName: "Ella Williams",
        },
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "create");
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.values.projectName, "Platform Integration");
      assert.equal(normalized.values.activityName, "Testing");
      assert.equal(normalized.values.hours, 29);
      assert.equal(normalized.values.hourlyRate, 1350);
      assert.equal(normalized.values.amount, 39150);
    },
  });

  gates.push({
    name: "isProjectTimeInvoicePrompt recognizes Portuguese fatura wording",
    run: () => {
      const payload = {
        prompt: 'Registe 4 horas para Maria Example (maria@example.org) na atividade "Utvikling" do projeto "Canary App" para Canary AS (org. nº 900919973). Taxa horária: 1050 NOK/h. Gere uma fatura de projeto ao cliente.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.entity, "invoice");
      assert.equal(normalized.values.projectName, "Canary App");
      assert.equal(normalized.values.activityName, "Utvikling");
    },
  });

  gates.push({
    name: "heuristic extraction captures project timesheet billing details",
    run: () => {
      const payload = {
        prompt: 'Log 29 hours for Ella Williams (ella.williams@example.org) on the activity "Testing" in the project "Platform Integration" for Windmill Ltd (org no. 839360274). Hourly rate: 1350 NOK/h. Generate a project invoice to the customer.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const spec = heuristicExtract(payload);
      assert.equal(spec.entity, "invoice");
      assert.equal(spec.values.projectName, "Platform Integration");
      assert.equal(spec.values.activityName, "Testing");
      assert.equal(spec.values.hours, 29);
      assert.equal(spec.values.hourlyRate, 1350);
    },
  });

  gates.push({
    name: "compilePlan builds composite project timesheet invoice preview and splits >24h entries",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Windmill Ltd",
          organizationNumber: "839360274",
          employeeName: "Ella Williams",
          email: "ella.williams@example.org",
          activityName: "Testing",
          projectName: "Platform Integration",
          hours: 29,
          hourlyRate: 1350,
        },
      } satisfies TaskSpec);
      const entrySteps = plan.steps.filter((step) => step.path === "/timesheet/entry" && step.method === "POST");
      assert.equal(entrySteps.length, 2);
      assert(plan.steps.some((step) => step.path === "/project/participant" && step.method === "POST"));
      assert(plan.steps.some((step) => step.path === "/project/projectActivity" && step.method === "POST"));
      assert(plan.steps.some((step) => step.path === "/order" && step.method === "POST"));
      assert.equal(plan.steps.at(-1)?.path, "/order/:invoiceMultipleOrders");
      const firstEntryBody = entrySteps[0]?.body as Record<string, unknown>;
      const secondEntryBody = entrySteps[1]?.body as Record<string, unknown>;
      assert.equal(firstEntryBody.hours, 24);
      assert.equal(secondEntryBody.hours, 5);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts returned-payment prompts into voucher reversal",
    run: () => {
      const payload = {
        prompt: 'Betalinga frå Strandvik AS (org.nr 863217873) for fakturaen "Programvarelisens" (17250 kr ekskl. MVA) vart returnert av banken. Reverser betalinga slik at fakturaen igjen viser uteståande beløp.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "update",
        entity: "invoice",
        values: {},
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "reverse_voucher");
      assert.equal(normalized.entity, "voucher");
      assert.equal(normalized.values.customerName, "Strandvik AS");
      assert.equal(normalized.values.organizationNumber, "863217873");
      assert.equal(normalized.values.name, "Programvarelisens");
      assert.equal(normalized.values.amount, 17250);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts French returned-payment prompts into voucher reversal",
    run: () => {
      const payload = {
        prompt: 'Le paiement de Lumière SARL (org.nr 839360274) pour la facture "Abonnement annuel" (40400 NOK HT) a été retourné par la banque. Annulez le paiement afin que la facture redevienne impayée.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "pay_invoice",
        entity: "salary_transaction",
        values: {},
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "reverse_voucher");
      assert.equal(normalized.entity, "voucher");
      assert.equal(normalized.values.customerName, "Lumière SARL");
      assert.equal(normalized.values.organizationNumber, "839360274");
      assert.equal(normalized.values.name, "Abonnement annuel");
      assert.equal(normalized.values.amount, 40400);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts Portuguese returned-payment prompts into voucher reversal",
    run: () => {
      const payload = {
        prompt: 'O pagamento de Montanha Lda (org. nº 912922324) referente à fatura "Consultoria de dados" (15400 NOK sem IVA) foi devolvido pelo banco. Reverta o pagamento para que a fatura volte a mostrar o montante em aberto.',
        files: [],
        tripletex_credentials: { base_url: "https://example.test", session_token: "gate-token" },
      };
      const normalized = normalizeTaskSpec(payload, {
        operation: "pay_invoice",
        entity: "invoice",
        values: {},
      } satisfies TaskSpec);
      assert.equal(normalized.operation, "reverse_voucher");
      assert.equal(normalized.entity, "voucher");
      assert.equal(normalized.values.customerName, "Montanha Lda");
      assert.equal(normalized.values.organizationNumber, "912922324");
      assert.equal(normalized.values.name, "Consultoria de dados");
      assert.equal(normalized.values.amount, 15400);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts German returned-payment prompts into voucher reversal",
    run: () => {
      const payload = {
        prompt:
          'Die Zahlung von Brückentor GmbH (Org.-Nr. 944848479) für die Rechnung "Wartung" (42200 NOK ohne MwSt.) wurde von der Bank zurückgebucht. Stornieren Sie die Zahlung, damit die Rechnung wieder den offenen Betrag anzeigt.',
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.operation, "reverse_voucher");
      assert.equal(normalized.entity, "voucher");
      assert.equal(normalized.values.organizationNumber, "944848479");
      assert.equal(normalized.values.name, "Wartung");
      assert.equal(normalized.values.amount, 42200);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts Spanish returned-payment prompts into voucher reversal",
    run: () => {
      const payload = {
        prompt:
          'El pago de Sierra SL (org. nº 910318144) por la factura "Almacenamiento en la nube" (19250 NOK sin IVA) fue devuelto por el banco. Revierta el pago para que la factura vuelva a mostrar el importe pendiente.',
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.operation, "reverse_voucher");
      assert.equal(normalized.entity, "voucher");
      assert.equal(normalized.values.organizationNumber, "910318144");
      assert.equal(normalized.values.customerName, "Sierra SL");
      assert.equal(normalized.values.name, "Almacenamiento en la nube");
      assert.equal(normalized.values.amount, 19250);
    },
  });

  gates.push({
    name: "heuristicExtract parses OCR-style European currency amounts",
    run: () => {
      const payload = {
        prompt: "Precisamos da despesa deste recibo: Hotel 4.200,00 NOK com IVA 25 %.",
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const extracted = heuristicExtract(payload);
      assert.equal(extracted.values.amount, 4200);
    },
  });

  gates.push({
    name: "feedback family detection recognizes returned payment and accounting dimension prompts",
    run: () => {
      assert.equal(
        detectFamily('Le paiement de Lumière SARL a été retourné par la banque. Annulez le paiement.'),
        "returned_payment",
      );
      assert.equal(
        detectFamily('Die Zahlung von Brückentor GmbH wurde von der Bank zurückgebucht. Stornieren Sie die Zahlung.'),
        "returned_payment",
      );
      assert.equal(
        detectFamily('Opprett en fri regnskapsdimensjon "Region" og bokfør deretter et bilag.'),
        "accounting_dimension",
      );
      assert.equal(
        detectFamily("Precisamos da despesa de Tastatur deste recibo registada no departamento HR. Use a conta de despesas correta e garanta o tratamento correto do IVA."),
        "expense_voucher",
      );
      assert.equal(
        detectFamily("Voce recebeu uma fatura de fornecedor (ver PDF anexo). Registe a fatura no Tripletex."),
        "supplier_invoice",
      );
    },
  });

  gates.push({
    name: "compilePlan uses customer payment posting lookup for returned-payment reversal",
    run: () => {
      const plan = compilePlan({
        operation: "reverse_voucher",
        entity: "voucher",
        values: {
          customerName: "Strandvik AS",
          organizationNumber: "863217873",
          name: "Programvarelisens",
          amount: 17250,
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.path, "/customer");
      assert.equal(plan.steps[1]?.path, "/ledger/posting");
      const postingParams = (plan.steps[1]?.params ?? {}) as Record<string, unknown>;
      assert.equal(postingParams.type, "INCOMING_PAYMENT");
      assert.equal(plan.steps[2]?.path, "/ledger/voucher/{{paymentPosting.voucher.id}}/:reverse");
    },
  });

  gates.push({
    name: "executeReturnedPaymentWorkflow resolves invoice payment voucher before reversal",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        calls.push({ method, path, query, body });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [{ id: 9101, name: "Strandvik AS", organizationNumber: "863217873" }] });
        }
        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 9201,
                invoiceNumber: 12001,
                amount: 21562.5,
                amountExcludingVat: 17250,
                amountOutstanding: 0,
                amountOutstandingTotal: 0,
                orderLines: [
                  {
                    description: "Programvarelisens",
                    displayName: "Programvarelisens",
                    unitPriceExcludingVatCurrency: 17250,
                    product: { name: "Programvarelisens" },
                  },
                ],
                postings: [
                  { type: "OUTGOING_INVOICE_CUSTOMER_POSTING", amount: 21562.5, voucher: { id: 9301, number: 1001 } },
                  { type: "INCOMING_PAYMENT", amount: -21562.5, voucher: { id: 9302, number: 1002 } },
                ],
              },
            ],
          });
        }
        if (method === "PUT" && path === "/ledger/voucher/9302/:reverse") {
          return jsonResponse(200, { value: { id: 9303 } });
        }
        return jsonResponse(404, { message: `Unhandled ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executeReturnedPaymentWorkflow(client, {
          operation: "reverse_voucher",
          entity: "voucher",
          values: {
            customerName: "Strandvik AS",
            organizationNumber: "863217873",
            name: "Programvarelisens",
            amount: 17250,
          },
        }, false);
        assert.equal(plan.steps.at(-1)?.path, "/ledger/voucher/9302/:reverse");
        assert.equal(calls.some((call) => call.method === "PUT" && call.path === "/ledger/voucher/9302/:reverse"), true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome confirms returned payment reopens the invoice",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        calls.push({ method, path, query, body });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [{ id: 9101, name: "Strandvik AS", organizationNumber: "863217873" }] });
        }
        if (method === "GET" && path === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 9201,
                invoiceNumber: 12001,
                amount: 21562.5,
                amountExcludingVat: 17250,
                amountOutstanding: 0,
                amountOutstandingTotal: 0,
                orderLines: [
                  {
                    description: "Programvarelisens",
                    displayName: "Programvarelisens",
                    unitPriceExcludingVatCurrency: 17250,
                    product: { name: "Programvarelisens" },
                  },
                ],
                postings: [
                  { type: "OUTGOING_INVOICE_CUSTOMER_POSTING", amount: 21562.5, voucher: { id: 9301, number: 1001 } },
                  { type: "INCOMING_PAYMENT", amount: -21562.5, voucher: { id: 9302, number: 1002 } },
                ],
              },
            ],
          });
        }
        if (method === "PUT" && path === "/ledger/voucher/9302/:reverse") {
          return jsonResponse(200, { value: { id: 9303 } });
        }
        if (method === "GET" && path === "/invoice/9201") {
          return jsonResponse(200, {
            value: {
              id: 9201,
              amountOutstanding: 21562.5,
              amountOutstandingTotal: 21562.5,
              postings: [
                { type: "OUTGOING_INVOICE_CUSTOMER_POSTING", amount: 21562.5, voucher: { id: 9301, number: 1001 } },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `Unhandled ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "reverse_voucher",
          entity: "voucher",
          values: {
            customerName: "Strandvik AS",
            organizationNumber: "863217873",
            name: "Programvarelisens",
            amount: 17250,
          },
        } satisfies TaskSpec;
        await executeReturnedPaymentWorkflow(client, spec, false);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(
          calls.some((call) => call.method === "GET" && call.path === "/invoice/9201"),
          true,
          "expected direct invoice verification lookup",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome rejects project create when only the name matches",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/project") {
          return jsonResponse(200, {
            values: [
              {
                id: 9001,
                name: "Implementering Tindra",
                customer: null,
                projectManager: {
                  id: 9002,
                  firstName: "Burconsult",
                  lastName: "a69d472e",
                  email: "burconsult@gmail.com",
                },
              },
            ],
          });
        }
        return jsonResponse(200, { values: [] });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "project",
          values: {
            name: "Implementering Tindra",
            customerName: "Tindra AS",
            organizationNumber: "886715536",
            projectManagerName: "Jonas Haugen",
            projectManagerEmail: "jonas.haugen@example.org",
          },
        } satisfies TaskSpec, null);
        assert.equal(verification.verified, false);
        assert.match(verification.detail, /customer linkage/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "compilePlan creates invoice through order invoice batch flow",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Ridgepoint Ltd",
          organizationNumber: "935400759",
          invoiceLines: [
            { productNumber: "1001", productName: "Software License", amount: 1000, vatRate: 25 },
            { description: "Consulting", amount: 500, vatRate: 15 },
          ],
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.method, "GET");
      assert.equal(plan.steps[0]?.path, "/customer");
      assert.equal(plan.steps.some((step) => step.method === "POST" && step.path === "/invoice"), false);
      assert.equal(plan.steps.some((step) => step.method === "PUT" && step.path === "/order/{{order_id}}/:invoice"), false);
      assert.equal(plan.steps.some((step) => step.method === "POST" && step.path === "/order"), true);
      assert.equal(plan.steps.at(-1)?.path, "/order/:invoiceMultipleOrders");
    },
  });

  gates.push({
    name: "compilePlan sends standard invoices when prompt requests create and send",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Ridgepoint Ltd",
          organizationNumber: "941587437",
          sendInvoice: true,
          invoiceLines: [{ productName: "Maintenance", amount: 40400 }],
        },
      } satisfies TaskSpec);

      const sendStep = plan.steps.find((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders");
      assert.equal(sendStep?.params?.sendToCustomer, true);
    },
  });

  gates.push({
    name: "compilePlan adds payment step for composite order invoice payment workflow",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "invoice",
        values: {
          customerName: "Brückentor GmbH",
          organizationNumber: "907980634",
          registerPayment: true,
          invoiceLines: [
            { productName: "Analysebericht", productNumber: "8563", amount: 20400 },
            { productName: "Wartung", productNumber: "3063", amount: 15250 },
          ],
        },
      } satisfies TaskSpec);
      assert(plan.steps.some((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders"));
      assert(plan.steps.some((step) => step.method === "GET" && step.path === "/invoice/paymentType"));
      assert(plan.steps.some((step) => step.method === "PUT" && step.path === "/invoice/{{invoice_id}}/:payment"));
    },
  });

  gates.push({
    name: "verifyOutcome prefers returned customer id over broad list search",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let listSearchCalled = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/customer/321") {
          return jsonResponse(200, {
            value: {
              id: 321,
              name: "Acme AS",
              email: "post@acme.no",
              organizationNumber: "935400759",
              isCustomer: true,
              isSupplier: false,
              postalAddress: {
                addressLine1: "Karl Johans gate 1",
                postalCode: "0154",
                city: "Oslo",
              },
            },
          });
        }
        if (method === "GET" && url.pathname === "/customer") {
          listSearchCalled = true;
          return jsonResponse(200, { values: [] });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const executionResult: ExecutePlanResult = {
          stepCount: 1,
          successCount: 1,
          mutatingAttempted: 1,
          mutatingSucceeded: 1,
          vars: { customer_id: 321 },
          failedSteps: [],
          stepResults: [{ step: 1, method: "POST", path: "/customer", saveAs: "customer", primary: { id: 321 } }],
        };
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "customer",
          values: {
            name: "Acme AS",
            email: "post@acme.no",
            organizationNumber: "935400759",
            address: "Karl Johans gate 1",
            postalCode: "0154",
            city: "Oslo",
          },
        } satisfies TaskSpec, executionResult);
        assert.equal(verification.verified, true);
        assert.match(verification.detail, /returned id/i);
        assert.equal(listSearchCalled, false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome prefers returned invoice id for invoice create",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let customerSearchCalled = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/invoice/991") {
          return jsonResponse(200, {
            value: {
              id: 991,
              invoiceNumber: 991,
              customer: { id: 77, name: "Ridgepoint Ltd", organizationNumber: "935400759" },
              orderLines: [
                {
                  description: "Software License",
                  displayName: "Software License",
                  unitPriceExcludingVatCurrency: 1000,
                  vatType: { percentage: 25 },
                  product: { name: "Software License", number: "1001" },
                },
                {
                  description: "Consulting",
                  displayName: "Consulting",
                  unitPriceExcludingVatCurrency: 500,
                  vatType: { percentage: 15 },
                  product: { name: "Consulting", number: "2002" },
                },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/customer") {
          customerSearchCalled = true;
          return jsonResponse(200, { values: [] });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const executionResult: ExecutePlanResult = {
          stepCount: 3,
          successCount: 3,
          mutatingAttempted: 1,
          mutatingSucceeded: 1,
          vars: { order_id: 654, invoice_id: 991 },
          failedSteps: [],
          stepResults: [{ step: 3, method: "PUT", path: "/order/:invoiceMultipleOrders", saveAs: "invoice", primary: { id: 991 } }],
        };
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "invoice",
          values: {
            customerName: "Ridgepoint Ltd",
            organizationNumber: "935400759",
            invoiceLines: [
              { productNumber: "1001", productName: "Software License", amount: 1000, vatRate: 25 },
              { productNumber: "2002", productName: "Consulting", amount: 500, vatRate: 15 },
            ],
          },
        } satisfies TaskSpec, executionResult);
        assert.equal(verification.verified, true);
        assert.match(verification.detail, /returned id/i);
        assert.equal(customerSearchCalled, false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome requires fixed-price project context for milestone invoices",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/invoice/991") {
          return jsonResponse(200, {
            value: {
              id: 991,
              invoiceNumber: 991,
              customer: { id: 77, name: "Ironbridge Ltd", organizationNumber: "832020141" },
              orderLines: [
                {
                  description: "Milestone 25% of fixed price",
                  displayName: "Milestone 25% of fixed price",
                  unitPriceExcludingVatCurrency: 107137.5,
                  product: { name: "Milestone 25% CRM Integration", number: "1001" },
                },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/project/777") {
          return jsonResponse(200, {
            value: {
              id: 777,
              name: "CRM Integration",
              isFixedPrice: true,
              fixedprice: 428550,
              customer: { id: 77, name: "Ironbridge Ltd", organizationNumber: "832020141" },
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const executionResult: ExecutePlanResult = {
          stepCount: 5,
          successCount: 5,
          mutatingAttempted: 2,
          mutatingSucceeded: 2,
          vars: { invoice_id: 991, project_id: 777 },
          failedSteps: [],
          stepResults: [
            { step: 3, method: "POST", path: "/project", saveAs: "project", primary: { id: 777 } },
            { step: 5, method: "PUT", path: "/order/:invoiceMultipleOrders", saveAs: "invoice", primary: { id: 991 } },
          ],
        };
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "invoice",
          values: {
            customerName: "Ironbridge Ltd",
            organizationNumber: "832020141",
            projectName: "CRM Integration",
            fixedPriceAmount: 428550,
            milestonePercent: 25,
            invoiceLines: [{ productName: "Milestone 25% CRM Integration", amount: 107137.5 }],
          },
        } satisfies TaskSpec, executionResult);
        assert.equal(verification.verified, true);
        assert.match(verification.detail, /returned id/i);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome requires outstanding amount to be zero when invoice payment is requested",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.pathname === "/invoice/991") {
          return jsonResponse(200, {
            value: {
              id: 991,
              invoiceNumber: 991,
              amountOutstanding: 0,
              customer: { id: 77, name: "Brückentor GmbH", organizationNumber: "907980634" },
              orderLines: [
                {
                  description: "Analysebericht",
                  displayName: "Analysebericht",
                  unitPriceExcludingVatCurrency: 20400,
                  product: { name: "Analysebericht", number: "8563" },
                },
                {
                  description: "Wartung",
                  displayName: "Wartung",
                  unitPriceExcludingVatCurrency: 15250,
                  product: { name: "Wartung", number: "3063" },
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const executionResult: ExecutePlanResult = {
          stepCount: 4,
          successCount: 4,
          mutatingAttempted: 2,
          mutatingSucceeded: 2,
          vars: { invoice_id: 991 },
          failedSteps: [],
          stepResults: [
            { step: 3, method: "PUT", path: "/order/:invoiceMultipleOrders", saveAs: "invoice", primary: { id: 991, amountOutstanding: 35650 } },
            { step: 4, method: "PUT", path: "/invoice/991/:payment", primary: { id: 991 } },
          ],
        };
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "invoice",
          values: {
            customerName: "Brückentor GmbH",
            organizationNumber: "907980634",
            registerPayment: true,
            invoiceLines: [
              { productName: "Analysebericht", productNumber: "8563", amount: 20400 },
              { productName: "Wartung", productNumber: "3063", amount: 15250 },
            ],
          },
        } satisfies TaskSpec, executionResult);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "invoice reminder workflow resolves overdue invoice and verifies created reminder",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const reminderDate = todayIsoInZone();
      let reminderCreated = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();

        if (method === "GET" && url.pathname === "/customer") {
          return jsonResponse(200, {
            values: [{
              id: 801,
              name: "Reminder Test AS",
              organizationNumber: "900112233",
              email: "debug@example.org",
              invoiceEmail: "debug@example.org",
            }],
          });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          return jsonResponse(200, {
            values: [{
              id: 8100,
              invoiceNumber: "INV-REM-1",
              invoiceDate: "2026-03-01",
              invoiceDueDate: "2026-03-05",
              amount: 1000,
              amountOutstanding: 1000,
              amountOutstandingTotal: reminderCreated ? 1039.2 : 1000,
              isCharged: true,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
              orderLines: [{ description: "Late fee canary", product: { name: "Late fee canary", number: "R1" } }],
              reminders: reminderCreated ? [{ id: 23001, type: "REMINDER", charge: 35, interests: 4.2, reminderDate }] : [],
            }],
          });
        }
        if (method === "GET" && url.pathname === "/product") {
          assert.match(String(url.searchParams.get("productNumber") ?? ""), /^9\d{6}$/);
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/invoice/8100") {
          return jsonResponse(200, {
            value: {
              id: 8100,
              invoiceNumber: "INV-REM-1",
              invoiceDate: "2026-03-01",
              invoiceDueDate: "2026-03-05",
              amount: 1000,
              amountOutstanding: 1000,
              amountOutstandingTotal: reminderCreated ? 1039.2 : 1000,
              isCharged: true,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
              orderLines: [{ description: "Late fee canary", product: { name: "Late fee canary", number: "R1" } }],
              reminders: reminderCreated ? [{ id: 23001, type: "REMINDER", charge: 35, interests: 4.2, reminderDate }] : [],
            },
          });
        }
        if (method === "PUT" && url.pathname === "/invoice/8100/:createReminder") {
          reminderCreated = true;
          assert.equal(url.searchParams.get("type"), "REMINDER");
          assert.equal(url.searchParams.get("includeCharge"), "true");
          return jsonResponse(200, { value: 999001 });
        }
        if (method === "POST" && url.pathname === "/product") {
          return jsonResponse(201, { value: { id: 8123 } });
        }
        if (method === "GET" && url.pathname === "/reminder/23001") {
          return jsonResponse(200, {
            value: {
              id: 23001,
              type: "REMINDER",
              charge: 35,
              interests: 4.2,
              reminderDate,
              termOfPayment: reminderDate,
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const payload = {
          prompt: "Um dos seus clientes, Reminder Test AS (org. nº 900112233), tem uma fatura vencida de 1000 NOK. Registe uma purring com taxa de lembrete e juros de mora.",
          files: [],
          tripletex_credentials: { base_url: "https://example.test", session_token: "token" },
        } satisfies SolveRequest;
        const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
        assert.equal(spec.entity, "invoice_reminder");
        assert.equal(spec.values.reminderType, "REMINDER");

        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executeInvoiceReminderWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.path === "/invoice/8100/:createReminder"), "expected reminder action");

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "invoice reminder workflow creates and sends separate reminder fee invoice when explicitly requested",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const reminderDate = todayIsoInZone();
      let reminderCreated = false;
      let feeInvoiceSent = false;
      let feeProductCreated = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        if (method === "GET" && url.pathname === "/customer") {
          return jsonResponse(200, {
            values: [{
              id: 801,
              name: "Reminder Test AS",
              organizationNumber: "900112233",
              email: "debug@example.org",
              invoiceEmail: "debug@example.org",
            }],
          });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          return jsonResponse(200, {
            values: [{
              id: 8100,
              invoiceNumber: "INV-REM-1",
              invoiceDate: "2026-03-01",
              invoiceDueDate: "2026-03-05",
              amount: 1000,
              amountOutstanding: 1000,
              amountOutstandingTotal: 1000,
              isCharged: true,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
              orderLines: [{ description: "Late fee canary", product: { name: "Late fee canary", number: "R1" } }],
              reminders: reminderCreated ? [{ id: 23001, type: "REMINDER", charge: 0, interests: 0, reminderDate }] : [],
            }],
          });
        }
        if (method === "GET" && url.pathname === "/invoice/8100") {
          return jsonResponse(200, {
            value: {
              id: 8100,
              invoiceNumber: "INV-REM-1",
              invoiceDate: "2026-03-01",
              invoiceDueDate: "2026-03-05",
              amount: 1000,
              amountOutstanding: 1000,
              amountOutstandingTotal: 1000,
              isCharged: true,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
              orderLines: [{ description: "Late fee canary", product: { name: "Late fee canary", number: "R1" } }],
              reminders: reminderCreated ? [{ id: 23001, type: "REMINDER", charge: 0, interests: 0, reminderDate }] : [],
            },
          });
        }
        if (method === "PUT" && url.pathname === "/invoice/8100/:createReminder") {
          reminderCreated = true;
          assert.equal(url.searchParams.get("includeCharge"), "false");
          return jsonResponse(200, { value: 999001 });
        }
        if (method === "GET" && url.pathname === "/reminder/23001") {
          return jsonResponse(200, {
            value: {
              id: 23001,
              type: "REMINDER",
              charge: 0,
              interests: 0,
              reminderDate,
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          assert.equal(url.searchParams.get("number"), "3400");
          return jsonResponse(200, { value: { id: 3400, number: 3400, name: "Reminder revenue" } });
        }
        if (method === "GET" && url.pathname === "/product") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/product") {
          feeProductCreated = true;
          assert.equal(body?.account?.id, 3400);
          assert.equal(body?.priceExcludingVatCurrency, 50);
          return jsonResponse(200, { value: { id: 8450 } });
        }
        if (method === "POST" && url.pathname === "/order") {
          assert.equal(body?.customer?.id, 801);
          assert.equal(body?.orderLines?.[0]?.product?.id, 8450);
          assert.equal(body?.orderLines?.[0]?.unitPriceExcludingVatCurrency, 50);
          return jsonResponse(200, { value: { id: 8801 } });
        }
        if (method === "PUT" && url.pathname === "/order/:invoiceMultipleOrders") {
          assert.equal(url.searchParams.get("id"), "8801");
          return jsonResponse(200, { value: { id: 8802 } });
        }
        if (method === "PUT" && url.pathname === "/invoice/8802/:send") {
          feeInvoiceSent = true;
          assert.equal(url.searchParams.get("sendType"), "EMAIL");
          assert.equal(url.searchParams.get("overrideEmailAddress"), "debug@example.org");
          return jsonResponse(200, { value: { id: 8802 } });
        }
        if (method === "GET" && url.pathname === "/invoice/8802") {
          return jsonResponse(200, {
            value: {
              id: 8802,
              invoiceNumber: "INV-FEE-1",
              invoiceDate: reminderDate,
              amount: 50,
              amountExcludingVat: 50,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233" },
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const payload = {
          prompt: "En av kundene dine har en forfalt faktura. Finn den forfalte fakturaen og bokfor et purregebyr pa 50 kr. Debet kundefordringer (1500), kredit purregebyr (3400). Opprett også en faktura for purregebyret til kunden og send den.",
          files: [],
          tripletex_credentials: { base_url: "https://example.test", session_token: "token" },
        } satisfies SolveRequest;
        const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
        assert.equal(spec.entity, "invoice_reminder");
        assert.equal(spec.values.createReminderFeeInvoice, true);
        assert.equal(spec.values.sendReminderFeeInvoice, true);
        assert.equal(spec.values.customerName, undefined);

        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executeInvoiceReminderWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.path === "/invoice/8100/:createReminder"), "expected reminder action");
        assert(plan.steps.some((step) => step.path === "/invoice/8802/:send"), "expected fee invoice send action");
        assert.equal(feeInvoiceSent, true);
        assert.equal(feeProductCreated, true);

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "invoice reminder workflow ignores charged invoices that are not yet overdue",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const reminderDate = todayIsoInZone();
      let reminderCreated = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();

        if (method === "GET" && url.pathname === "/customer") {
          return jsonResponse(200, {
            values: [{
              id: 801,
              name: "Reminder Test AS",
              organizationNumber: "900112233",
              email: "debug@example.org",
              invoiceEmail: "debug@example.org",
            }],
          });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 8101,
                invoiceNumber: "INV-NOT-DUE",
                invoiceDate: "2026-03-20",
                invoiceDueDate: "2099-03-25",
                amount: 1000,
                amountOutstanding: 1000,
                isCharged: true,
                isApproved: true,
                customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
                orderLines: [{ description: "Reminder candidate", product: { name: "Reminder candidate", number: "R1" } }],
                reminders: [],
              },
              {
                id: 8100,
                invoiceNumber: "INV-OVERDUE",
                invoiceDate: "2026-03-01",
                invoiceDueDate: "2026-03-05",
                amount: 1000,
                amountOutstanding: 1000,
                isCharged: true,
                isApproved: true,
                customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
                orderLines: [{ description: "Reminder candidate", product: { name: "Reminder candidate", number: "R1" } }],
                reminders: [],
              },
            ],
          });
        }
        if (method === "PUT" && url.pathname === "/invoice/8100/:createReminder") {
          reminderCreated = true;
          return jsonResponse(200, { value: 999001 });
        }
        if (method === "GET" && url.pathname === "/reminder/999001") {
          return jsonResponse(200, {
            value: {
              id: 999001,
              type: "REMINDER",
              charge: 50,
              interests: 0,
              reminderDate,
              termOfPayment: reminderDate,
            },
          });
        }
        if (method === "GET" && url.pathname === "/invoice/8100") {
          return jsonResponse(200, {
            value: {
              id: 8100,
              invoiceNumber: "INV-OVERDUE",
              invoiceDate: "2026-03-01",
              invoiceDueDate: "2026-03-05",
              amount: 1000,
              amountOutstanding: reminderCreated ? 1050 : 1000,
              amountOutstandingTotal: reminderCreated ? 1050 : 1000,
              isCharged: true,
              isApproved: true,
              customer: { id: 801, name: "Reminder Test AS", organizationNumber: "900112233", email: "debug@example.org", invoiceEmail: "debug@example.org" },
              orderLines: [{ description: "Reminder candidate", product: { name: "Reminder candidate", number: "R1" } }],
              reminders: reminderCreated ? [{ id: 999001, type: "REMINDER", charge: 50, interests: 0, reminderDate, termOfPayment: reminderDate }] : [],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const payload = {
          prompt: "En av kundene dine har en forfalt faktura. Finn den forfalte fakturaen og bokfor et purregebyr pa 50 kr.",
          files: [],
          tripletex_credentials: { base_url: "https://example.test", session_token: "token" },
        } satisfies SolveRequest;
        const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executeInvoiceReminderWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.path === "/invoice/8100/:createReminder"), "expected overdue invoice reminder action");
        assert(plan.steps.every((step) => step.path !== "/invoice/8101/:createReminder"), "should not select non-overdue invoice");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "compilePlan previews accounting dimension workflow with lookup and single voucher write",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "accounting_dimension",
        values: {
          dimensionName: "Kostsenter",
          dimensionValues: ["Salg", "Marked"],
          dimensionValueName: "Marked",
          accountNumber: "6540",
          amount: 2500,
          description: "Dimension voucher",
        },
      } satisfies TaskSpec);
      assert.equal(plan.steps[0]?.method, "GET");
      assert.equal(plan.steps[0]?.path, "/ledger/accountingDimensionName");
      assert.equal(plan.steps.some((step) => step.path === "/ledger/accountingDimensionValue/search"), true);
      const voucherSteps = plan.steps.filter((step) => step.path === "/ledger/voucher");
      assert.equal(voucherSteps.length, 1);
      const firstVoucher = (voucherSteps[0]?.body ?? {}) as Record<string, unknown>;
      const postings = Array.isArray(firstVoucher.postings) ? firstVoucher.postings as Array<Record<string, unknown>> : [];
      assert.equal(postings.length, 2);
      assert.equal(postings[0]?.row, 1);
      assert.equal(postings[1]?.row, 2);
      assert.equal(postings[0]?.amountGross, 2500);
      assert.equal(postings[1]?.amountGross, -2500);
    },
  });

  gates.push({
    name: "executeAccountingDimensionWorkflow reuses managed slots and posts on the resolved dimension index",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        requests.push({ method, path: url.pathname, body });

        if (method === "GET" && url.pathname === "/ledger/accountingDimensionName") {
          return jsonResponse(200, {
            values: [
              { id: 11, version: 0, dimensionName: "Legacy Slot", description: "managed by tripletex agent", dimensionIndex: 2, active: true },
              { id: 12, version: 0, dimensionName: "User Slot", description: "Important user data", dimensionIndex: 1, active: true },
              { id: 13, version: 0, dimensionName: "Another Slot", description: "Other", dimensionIndex: 3, active: true },
            ],
          });
        }
        if (method === "PUT" && url.pathname === "/ledger/accountingDimensionName/11") {
          return jsonResponse(200, {
            value: {
              id: 11,
              version: 1,
              dimensionName: "Kostsenter",
              description: "Dimension voucher",
              dimensionIndex: 2,
              active: true,
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/accountingDimensionValue/search") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/ledger/accountingDimensionValue") {
          return jsonResponse(201, {
            value: {
              id: 22,
              displayName: "Marked",
              dimensionIndex: 2,
              number: "D2MARK1",
              active: true,
              showInVoucherRegistration: true,
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          if (url.searchParams.get("number") === "6540") {
            return jsonResponse(200, { values: [{ id: 33, number: "6540", name: "Inventar" }] });
          }
          if (url.searchParams.get("isBalanceAccount") === "true") {
            return jsonResponse(200, { values: [{ id: 44, number: "1920", name: "Bank" }] });
          }
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(201, { value: { id: 55 } });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executeAccountingDimensionWorkflow(client, {
          operation: "create",
          entity: "accounting_dimension",
          values: {
            dimensionName: "Kostsenter",
            dimensionValues: ["Marked"],
            dimensionValueName: "Marked",
            accountNumber: "6540",
            amount: 2500,
            description: "Dimension voucher",
          },
        } satisfies TaskSpec, false);

        assert.equal(plan.steps.some((step) => step.method === "POST" && step.path === "/ledger/accountingDimensionName"), false);
        assert.equal(plan.steps.some((step) => step.method === "PUT" && step.path === "/ledger/accountingDimensionName/11"), true);
        const voucherStep = plan.steps.find((step) => step.method === "POST" && step.path === "/ledger/voucher");
        assert.ok(voucherStep);
        const postings = Array.isArray(voucherStep.body?.postings) ? voucherStep.body?.postings as Array<Record<string, unknown>> : [];
        assert.deepEqual(postings[0]?.freeAccountingDimension2, { id: 22 });
        assert.equal("freeAccountingDimension1" in (postings[0] ?? {}), false);
        assert.equal(requests.some((request) => request.method === "PUT" && request.path === "/ledger/accountingDimensionName/11"), true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "normalizeTaskSpec preserves multi-department names from quoted prompt",
    run: () => {
      const spec = normalizeTaskSpec({
        prompt: 'Erstellen Sie drei Abteilungen in Tripletex: "Administrasjon", "Kundeservice" und "Markedsforing".',
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      }, {
        operation: "create",
        entity: "department",
        values: { name: "Administrasjon" },
      } satisfies TaskSpec);

      assert.deepEqual(spec.values.names, ["Administrasjon", "Kundeservice", "Markedsforing"]);
    },
  });

  gates.push({
    name: "normalizeTaskSpec canonicalizes accounting dimension names from quoted prompt",
    run: () => {
      const spec = normalizeTaskSpec({
        prompt: 'Opprett en fri regnskapsdimensjon "Prosjekttype" med verdiene "Eksternt" og "Forskning".',
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      }, {
        operation: "create",
        entity: "accounting_dimension",
        values: { name: "Prosjekttype", names: ["Prosjekttype", "Eksternt", "Forskning", "Forskning"] },
      } satisfies TaskSpec);

      assert.deepEqual(spec.values.names, ["Prosjekttype", "Eksternt", "Forskning"]);
      assert.equal(spec.values.name, "Prosjekttype");
      assert.deepEqual(spec.values.dimensionValues, ["Eksternt", "Forskning"]);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts payroll prompt into salary transaction",
    run: () => {
      const spec = normalizeTaskSpec({
        prompt: "Exécutez la paie de Manon Leroy (manon.leroy@example.org) pour ce mois. Le salaire de base est de 43050 NOK. Ajoutez une prime unique de 11150 NOK en plus du salaire de base.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      }, {
        operation: "update",
        entity: "employee",
        values: {},
      } satisfies TaskSpec);

      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "salary_transaction");
      assert.equal(spec.values.employeeName, "Manon Leroy");
      assert.equal(spec.values.email, "manon.leroy@example.org");
      assert.equal(spec.values.baseSalaryAmount, 43050);
      assert.equal(spec.values.bonusAmount, 11150);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts Nynorsk payroll prompt into salary transaction",
    run: () => {
      const prompt = "Køyr løn for Brita Stølsvik (brita.stlsvik@example.org) for denne månaden. Grunnløn er 36000 kr. Legg til ein eingongsbonus på 15400 kr i tillegg til grunnløna.";
      const spec = normalizeTaskSpec(
        { prompt, files: [] } as any,
        heuristicExtract({ prompt, files: [] } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "salary_transaction");
      assert.equal(spec.values.employeeName, "Brita Stølsvik");
      assert.equal(spec.values.email, "brita.stlsvik@example.org");
      assert.equal(spec.values.baseSalaryAmount, 36000);
      assert.equal(spec.values.bonusAmount, 15400);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts Spanish payroll prompt into salary transaction",
    run: () => {
      const prompt =
        "Ejecute la nómina de Fernando López (fernando.lopez@example.org) para este mes. El salario base es de 37850 NOK. Añada una bonificación única de 9200 NOK además del salario base.";
      const spec = normalizeTaskSpec(
        { prompt, files: [] } as any,
        heuristicExtract({ prompt, files: [] } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "salary_transaction");
      assert.equal(spec.values.employeeName, "Fernando López");
      assert.equal(spec.values.email, "fernando.lopez@example.org");
      assert.equal(spec.values.baseSalaryAmount, 37850);
      assert.equal(spec.values.bonusAmount, 9200);
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts exact live Nynorsk payroll bonus prompt into salary transaction",
    run: () => {
      const prompt =
        "Køyr løn for Brita Berge (brita.berge@example.org) for denne månaden. Grunnløn er 36800 kr. Legg til ein eingongsbonus på 14100 kr i tillegg til grunnløna.";
      const spec = normalizeTaskSpec(
        { prompt, files: [] } as any,
        heuristicExtract({ prompt, files: [] } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "salary_transaction");
      assert.equal(spec.values.employeeName, "Brita Berge");
      assert.equal(spec.values.email, "brita.berge@example.org");
      assert.equal(spec.values.baseSalaryAmount, 36800);
      assert.equal(spec.values.bonusAmount, 14100);
    },
  });

  gates.push({
    name: "compilePlan previews payroll workflow with salary transaction step",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "salary_transaction",
        values: {
          employeeName: "Manon Leroy",
          email: "manon.leroy@example.org",
          baseSalaryAmount: 43050,
          bonusAmount: 11150,
          date: "2026-03-21",
        },
      } satisfies TaskSpec);

      assert(plan.steps.some((step) => step.path === "/salary/transaction" && step.method === "POST"), "expected payroll transaction step");
      assert(plan.steps.some((step) => step.path === "/employee/employment/details" && step.method === "POST"), "expected employment details step");
    },
  });

  gates.push({
    name: "executePayrollWorkflow scaffolds employee employment and salary transaction",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (method === "GET" && url.pathname === "/employee") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/department") {
          return jsonResponse(200, { values: [{ id: 10, name: "Avdeling" }] });
        }
        if (method === "POST" && url.pathname === "/employee") {
          return jsonResponse(201, { value: { id: 11, email: "manon.leroy@example.org", companyId: 12 } });
        }
        if (method === "GET" && url.pathname === "/employee/employment") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/employee/employment") {
          return jsonResponse(201, { value: { id: 13, version: 0, division: null } });
        }
        if (method === "GET" && url.pathname === "/employee/employment/details") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/employee/employment/details") {
          return jsonResponse(201, { value: { id: 14 } });
        }
        if (method === "GET" && url.pathname === "/division") {
          return jsonResponse(200, { values: [{ id: 15, name: "AI Payroll Unit", organizationNumber: "100000008" }] });
        }
        if (method === "GET" && url.pathname === "/employee/employment/13") {
          return jsonResponse(200, { value: { id: 13, version: 0, division: null } });
        }
        if (method === "PUT" && url.pathname === "/employee/employment/13") {
          return jsonResponse(200, { value: { id: 13, version: 1, division: { id: 15 } } });
        }
        if (method === "GET" && url.pathname === "/salary/type") {
          return jsonResponse(200, {
            values: [
              { id: 2000, number: "2000", name: "Fastlønn" },
              { id: 2002, number: "2002", name: "Bonus" },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/salary/payslip") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/salary/transaction") {
          return jsonResponse(201, { value: { id: 16, payslips: [{ id: 17 }] } });
        }
        if (method === "GET" && url.pathname === "/salary/payslip/17") {
          return jsonResponse(200, { value: { id: 17 } });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const plan = await executePayrollWorkflow(client, {
          operation: "create",
          entity: "salary_transaction",
          values: {
            employeeName: "Manon Leroy",
            email: "manon.leroy@example.org",
            baseSalaryAmount: 43050,
            bonusAmount: 11150,
            date: "2026-03-21",
          },
        } satisfies TaskSpec, false);
        assert(plan.steps.some((step) => step.path === "/salary/transaction" && step.method === "POST"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePayrollWorkflow keeps payroll alive when division provisioning fails",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let employmentWithoutDivision = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (method === "GET" && url.pathname === "/employee") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/department") {
          return jsonResponse(200, { values: [{ id: 10, name: "Avdeling" }] });
        }
        if (method === "POST" && url.pathname === "/employee") {
          return jsonResponse(201, { value: { id: 11, email: "chloe.dubois@example.org", companyId: 12 } });
        }
        if (method === "GET" && url.pathname === "/employee/employment") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/employee/employment") {
          const body = parseJsonBody(init?.body);
          employmentWithoutDivision = body?.division == null;
          return jsonResponse(201, { value: { id: 13, version: 0, division: null } });
        }
        if (method === "GET" && url.pathname === "/employee/employment/details") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/employee/employment/details") {
          return jsonResponse(201, { value: { id: 14 } });
        }
        if (method === "GET" && url.pathname === "/division") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/company/12") {
          return jsonResponse(200, { value: { id: 12, address: { city: "Paris" } } });
        }
        if (method === "GET" && url.pathname === "/municipality/query") {
          return jsonResponse(200, { value: {} });
        }
        if (method === "GET" && url.pathname === "/salary/type") {
          return jsonResponse(200, {
            values: [
              { id: 2000, number: "2000", name: "Fastlønn" },
              { id: 2002, number: "2002", name: "Bonus" },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/salary/payslip") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/salary/transaction") {
          return jsonResponse(201, { value: { id: 16, payslips: [{ id: 17 }] } });
        }
        if (method === "GET" && url.pathname === "/salary/payslip/17") {
          return jsonResponse(200, {
            value: {
              id: 17,
              year: 2026,
              month: 3,
              specifications: [
                { salaryType: { id: 2000, number: "2000", name: "Fastlønn" }, count: 1, rate: 58350 },
                { salaryType: { id: 2002, number: "2002", name: "Bonus" }, count: 1, rate: 9300 },
              ],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "salary_transaction",
          values: {
            employeeName: "Chloé Dubois",
            email: "chloe.dubois@example.org",
            baseSalaryAmount: 58350,
            bonusAmount: 9300,
            date: "2026-03-22",
          },
        } satisfies TaskSpec;
        const plan = await executePayrollWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.path === "/salary/transaction" && step.method === "POST"));
        assert.equal(employmentWithoutDivision, true);
        assert.equal(spec.values.__divisionProvisioningFailed, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "heuristicExtract routes attachment onboarding from attached contract facts",
    run: () => {
      const payload = {
        prompt: "Du har mottatt et tilbudsbrev i vedlagt PDF. Utfør komplett onboarding for den nye ansatte.",
        files: [
          {
            filename: "offer-letter.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "offer-letter.pdf",
          mimeType: "application/pdf",
          sizeBytes: 512,
          extractionSource: "docai",
          textExcerpt: "Employee Lea Thomas lea.thomas@example.org fødselsnummer 12060012345 startdato 2026-10-08 avdeling Salg occupation code 2512 stillingsprosent 80 % årslønn 720000 bank account 12345678901 user access",
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.email, "lea.thomas@example.org");
      assert.equal(spec.values.nationalIdentityNumber, "12060012345");
      assert.equal(spec.values.employmentDate, "2026-10-08");
      assert.equal(spec.values.occupationCode, "2512");
      assert.equal(spec.values.employmentPercentage, 80);
      assert.equal(spec.values.annualSalary, 720000);
      assert.equal(spec.values.bankAccountNumber, "12345678901");
      assert.equal(spec.values.userType, "STANDARD");
    },
  });

  gates.push({
    name: "heuristicExtract keeps plain new employee prompts on employee without attachment",
    run: () => {
      const spec = heuristicExtract({
        prompt: "We have a new employee named Sophie Clark, born 3. March 1981. Please create them as an employee with email sophie.clark@example.org and start date 3. July 2026.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      assert.equal(spec.entity, "employee");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes Portuguese month-end closing wording to month_end_closing",
    run: () => {
      const payload = {
        prompt: "Realize o encerramento mensal de março de 2026. Registe a reversão de acréscimos (14600 NOK por mês da conta 1720 para despesa). Registe a depreciação mensal de um ativo fixo com custo de aquisição 292100 NOK e vida útil 6 anos.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      };
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "heuristicExtract preserves line-oriented onboarding facts and detects brukeradgang",
    run: () => {
      const payload = {
        prompt: "Du har mottatt et tilbudsbrev i vedlagt dokument. Utfør komplett onboarding for den nye ansatte med brukeradgang.",
        files: [
          {
            filename: "offer-letter.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "offer-letter.pdf",
          mimeType: "application/pdf",
          sizeBytes: 640,
          extractionSource: "ai",
          textExcerpt: [
            "Employee: Nora Berg",
            "Email: nora.berg@example.org",
            "Date of birth: 1997-02-14",
            "National identity number: 14029712345",
            "Start date: 2026-11-01",
            "Department: Kundeservice",
            "Occupation code: 4110",
            "Employment percentage: 60 %",
            "Annual salary: 540000 NOK",
            "Bank account number: 12345678901",
            "Brukeradgang: standardbruker",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.name, "Nora Berg");
      assert.equal(spec.values.email, "nora.berg@example.org");
      assert.equal(spec.values.departmentName, "Kundeservice");
      assert.equal(spec.values.employmentDate, "2026-11-01");
      assert.equal(spec.values.employmentPercentage, 60);
      assert.equal(spec.values.annualSalary, 540000);
      assert.equal(spec.values.userType, "STANDARD");
      assert.equal(spec.values.userAccessRequested, true);
    },
  });

  gates.push({
    name: "heuristicExtract supports Portuguese onboarding labels from attachment facts",
    run: () => {
      const payload = {
        prompt: "Voce recebeu uma carta de oferta (ver PDF anexo) para um novo funcionario. Complete a integracao.",
        files: [
          {
            filename: "contrato.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "contrato.pdf",
          mimeType: "application/pdf",
          sizeBytes: 700,
          extractionSource: "ai",
          textExcerpt: [
            "Funcionário: Joao Silva",
            "Email: joao.silva@example.org",
            "Data de nascimento: 1995-04-18",
            "Número de identificação: 18049512345",
            "Data de início: 2026-10-15",
            "Departamento: Operações",
            "Código de profissão: 4110",
            "Percentagem de emprego: 75 %",
            "Salário anual: 650000 NOK",
            "Conta bancária: 12345678901",
            "Acesso de utilizador: standard user",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.values.name, "Joao Silva");
      assert.equal(spec.values.email, "joao.silva@example.org");
      assert.equal(spec.values.dateOfBirth, "1995-04-18");
      assert.equal(spec.values.departmentName, "Operações");
      assert.equal(spec.values.occupationCode, "4110");
      assert.equal(spec.values.employmentPercentage, 75);
      assert.equal(spec.values.annualSalary, 650000);
      assert.equal(spec.values.userType, "STANDARD");
      assert.equal(spec.values.userAccessRequested, true);
    },
  });

  gates.push({
    name: "heuristicExtract supports prose English offer letters for onboarding",
    run: () => {
      const payload = {
        prompt: "You received an offer letter (see attached PDF) for a new employee. Complete the onboarding and configure user access.",
        files: [
          {
            filename: "offer-letter.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "offer-letter.pdf",
          mimeType: "application/pdf",
          sizeBytes: 900,
          extractionSource: "docai",
          textExcerpt: [
            "Dear Emma Carter,",
            "We are pleased to offer you employment in the Customer Success department.",
            "Your start date will be 1 October 2026.",
            "Your annual base salary will be 780000 NOK.",
            "Your role is 80% of full-time equivalent.",
            "Occupation code 2512.",
            "Email: emma.carter@example.org",
            "Date of birth: 17 April 1992",
            "Bank account number: 12345678901",
            "User access: standard user",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.values.name, "Emma Carter");
      assert.equal(spec.values.departmentName, "Customer Success");
      assert.equal(spec.values.employmentDate, "2026-10-01");
      assert.equal(spec.values.employmentPercentage, 80);
      assert.equal(spec.values.annualSalary, 780000);
      assert.equal(spec.values.userType, "STANDARD");
    },
  });

  gates.push({
    name: "heuristicExtract supports prose Spanish offer letters for onboarding",
    run: () => {
      const payload = {
        prompt: "Has recibido una carta de oferta (ver PDF adjunto) para un nuevo empleado. Completa la incorporación.",
        files: [
          {
            filename: "carta-oferta.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "carta-oferta.pdf",
          mimeType: "application/pdf",
          sizeBytes: 950,
          extractionSource: "docai",
          textExcerpt: [
            "Estimado Diego Flores:",
            "Le ofrecemos el puesto en el departamento de Operaciones.",
            "La fecha de inicio es 15 de octubre de 2026.",
            "El salario bruto anual será 690000 NOK.",
            "La jornada será 75% equivalente a tiempo completo.",
            "Código de ocupación 4110.",
            "Correo: diego.flores@example.org",
            "Fecha de nacimiento: 1994-05-21",
            "Acceso de usuario: standard user",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.values.name, "Diego Flores");
      assert.equal(spec.values.departmentName, "Operaciones");
      assert.equal(spec.values.employmentDate, "2026-10-15");
      assert.equal(spec.values.employmentPercentage, 75);
      assert.equal(spec.values.annualSalary, 690000);
      assert.equal(spec.values.userType, "STANDARD");
    },
  });

  gates.push({
    name: "heuristicExtract supports French onboarding labels from attachment facts",
    run: () => {
      const payload = {
        prompt: "Vous avez recu une lettre d'offre (voir PDF ci-joint) pour un nouvel employe. Effectuez l'integration complete avec acces utilisateur.",
        files: [
          {
            filename: "lettre-offre.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "lettre-offre.pdf",
          mimeType: "application/pdf",
          sizeBytes: 910,
          extractionSource: "docai",
          textExcerpt: [
            "Nom: Jean Dupont",
            "E-mail: jean.dupont@example.org",
            "Date de naissance: 1989-04-12",
            "Numero d'identite: 12048912345",
            "Date de debut: 2026-04-01",
            "Departement: Conseil",
            "Code profession: 2130",
            "Pourcentage d'emploi: 100 %",
            "Salaire annuel: 720000 NOK",
            "Compte bancaire: 15038844556",
            "Acces utilisateur: utilisateur standard",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.values.name, "Jean Dupont");
      assert.equal(spec.values.email, "jean.dupont@example.org");
      assert.equal(spec.values.dateOfBirth, "1989-04-12");
      assert.equal(spec.values.nationalIdentityNumber, "12048912345");
      assert.equal(spec.values.employmentDate, "2026-04-01");
      assert.equal(spec.values.departmentName, "Conseil");
      assert.equal(spec.values.occupationCode, "2130");
      assert.equal(spec.values.employmentPercentage, 100);
      assert.equal(spec.values.annualSalary, 720000);
      assert.equal(spec.values.bankAccountNumber, "15038844556");
      assert.equal(spec.values.userType, "STANDARD");
      assert.equal(spec.values.userAccessRequested, true);
    },
  });

  gates.push({
    name: "heuristicExtract supports German contract onboarding labels from attachment facts",
    run: () => {
      const payload = {
        prompt: "Sie haben einen Arbeitsvertrag erhalten (siehe beigefügte PDF). Erstellen Sie den Mitarbeiter in Tripletex mit allen Details aus dem Vertrag und richten Sie Benutzerzugang ein.",
        files: [
          {
            filename: "arbeitsvertrag.pdf",
            mime_type: "application/pdf",
            content_base64: "",
          },
        ],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, [
        {
          filename: "arbeitsvertrag.pdf",
          mimeType: "application/pdf",
          sizeBytes: 880,
          extractionSource: "docai",
          textExcerpt: [
            "Arbeitsvertrag",
            "Mitarbeiter: Mia Weber",
            "E-Mail: mia.weber@example.org",
            "Geburtsdatum: 2000-06-12",
            "Personalnummer: 4412",
            "Abteilung: Vertrieb",
            "Berufsschluessel: 2512",
            "Beschaeftigungsgrad: 80 %",
            "Jahresgehalt: 720000 NOK",
            "Eintrittsdatum: 2026-10-08",
            "Benutzerzugang: Standardbenutzer",
          ].join("\n"),
        },
      ]));

      assert.equal(spec.entity, "attachment_onboarding");
      assert.equal(spec.values.name, "Mia Weber");
      assert.equal(spec.values.email, "mia.weber@example.org");
      assert.equal(spec.values.departmentName, "Vertrieb");
      assert.equal(spec.values.occupationCode, "2512");
      assert.equal(spec.values.employmentPercentage, 80);
      assert.equal(spec.values.annualSalary, 720000);
      assert.equal(spec.values.employmentDate, "2026-10-08");
      assert.equal(spec.values.userType, "STANDARD");
      assert.equal(spec.values.userAccessRequested, true);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes Spanish month-end closing wording to actionable month_end_closing",
    run: () => {
      const payload = {
        prompt: "Realice el cierre mensual de marzo de 2026. Registre la periodificación (3950 NOK por mes de la cuenta 1720 a gasto). Contabilice la depreciación mensual de un activo fijo con costo de adquisición 153900 NOK y vida útil 5 años.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      };
      const normalized = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(normalized.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "executeAttachmentOnboardingWorkflow scaffolds employee employment and details",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (method === "GET" && url.pathname === "/department") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/department") return jsonResponse(201, { value: { id: 21, name: "Salg" } });
        if (method === "GET" && url.pathname === "/employee") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee") return jsonResponse(201, { value: { id: 22 } });
        if (method === "GET" && url.pathname === "/employee/22") {
          return jsonResponse(200, { value: { id: 22, version: 0, firstName: "Lea", lastName: "Thomas", email: "lea.thomas@example.org", companyId: 23, department: { id: 21, name: "Salg" }, userType: "STANDARD", nationalIdentityNumber: "12060012345", bankAccountNumber: "12345678901", dateOfBirth: "2000-06-12" } });
        }
        if (method === "GET" && url.pathname === "/division") return jsonResponse(200, { values: [{ id: 24, name: "AI Employee Unit" }] });
        if (method === "GET" && url.pathname === "/employee/employment") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment") return jsonResponse(201, { value: { id: 25, version: 0, startDate: "2026-10-08", division: { id: 24 } } });
        if (method === "GET" && url.pathname === "/employee/employment/occupationCode") return jsonResponse(200, { values: [{ id: 26, code: "2512", nameNO: "Utvikler" }] });
        if (method === "GET" && url.pathname === "/employee/employment/details") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment/details") return jsonResponse(201, { value: { id: 27, annualSalary: 720000, percentageOfFullTimeEquivalent: 80, occupationCode: { id: 26, code: "2512" } } });
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "attachment_onboarding",
          values: {
            name: "Lea Thomas",
            email: "lea.thomas@example.org",
            dateOfBirth: "2000-06-12",
            employmentDate: "2026-10-08",
            nationalIdentityNumber: "12060012345",
            bankAccountNumber: "12345678901",
            departmentName: "Salg",
            userType: "STANDARD",
            occupationCode: "2512",
            employmentPercentage: 80,
            annualSalary: 720000,
          },
        } satisfies TaskSpec;
        const plan = await executeAttachmentOnboardingWorkflow(client, spec, false);
        assert.equal(spec.values.__employeeId, 22);
        assert.equal(spec.values.__employmentId, 25);
        assert.equal(spec.values.__employmentDetailsId, 27);
        assert(plan.steps.some((step) => step.path === "/employee/employment/details" && step.method === "GET"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeAttachmentOnboardingWorkflow falls back on invalid extracted department/email and ignores entitlement apply failure",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method === "GET" && url.pathname === "/department") return jsonResponse(200, { values: [{ id: 21, name: "Employees" }] });
        if (method === "POST" && url.pathname === "/department") return jsonResponse(422, { validationMessages: [{ field: "name" }] });
        if (method === "GET" && url.pathname === "/employee") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee") {
          assert.equal(body?.email, undefined);
          assert.equal(body?.department?.id, 21);
          return jsonResponse(201, { value: { id: 22 } });
        }
        if (method === "GET" && url.pathname === "/employee/22") {
          return jsonResponse(200, { value: { id: 22, version: 0, firstName: "Joao", lastName: "Silva", email: "", companyId: 23, department: { id: 21, name: "Employees" }, userType: "STANDARD", dateOfBirth: "1990-01-15" } });
        }
        if (method === "GET" && url.pathname === "/division") return jsonResponse(200, { values: [{ id: 24, name: "AI Employee Unit" }] });
        if (method === "GET" && url.pathname === "/employee/employment") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment") return jsonResponse(201, { value: { id: 25, version: 0, startDate: "2026-10-15", division: { id: 24 } } });
        if (method === "GET" && url.pathname === "/employee/employment/occupationCode") return jsonResponse(422, { validationMessages: [{ field: "code" }] });
        if (method === "GET" && url.pathname === "/employee/employment/details") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment/details") return jsonResponse(201, { value: { id: 27, annualSalary: 650000, percentageOfFullTimeEquivalent: 75 } });
        if (method === "PUT" && url.pathname === "/employee/entitlement/:grantEntitlementsByTemplate") return jsonResponse(422, { validationMessages: [{ field: "template" }] });
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "attachment_onboarding",
          values: {
            name: "Joao Silva",
            email: "not-an-email",
            dateOfBirth: "invalid-date",
            employmentDate: "2026-10-15",
            departmentName: "Departamento de Operações muito muito muito longo que excede o tamanho permitido e precisa ser reduzido automaticamente",
            userType: "STANDARD",
            userAccessRequested: true,
            occupationCode: "9999",
            employmentPercentage: 75,
            annualSalary: 650000,
          },
        } satisfies TaskSpec;
        const plan = await executeAttachmentOnboardingWorkflow(client, spec, false);
        assert.equal(spec.values.__employeeId, 22);
        assert.equal(spec.values.__employmentId, 25);
        assert.equal(spec.values.__employmentDetailsId, 27);
        assert.equal(spec.values.__entitlementApplyFailed, true);
        assert(plan.steps.some((step) => step.path === "/employee/22" && step.method === "GET"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeAttachmentOnboardingWorkflow keeps onboarding alive when division provisioning fails",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method === "GET" && url.pathname === "/department") return jsonResponse(200, { values: [{ id: 21, name: "Operaciones" }] });
        if (method === "GET" && url.pathname === "/employee") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee") return jsonResponse(201, { value: { id: 22 } });
        if (method === "GET" && url.pathname === "/employee/22") {
          return jsonResponse(200, { value: { id: 22, version: 0, firstName: "Diego", lastName: "Flores", email: "diego.flores@example.org", companyId: 23, department: { id: 21, name: "Operaciones" } } });
        }
        if (method === "GET" && url.pathname === "/division") return jsonResponse(200, { values: [] });
        if (method === "GET" && url.pathname === "/company/23") return jsonResponse(200, { value: { address: { city: "Oslo" } } });
        if (method === "GET" && url.pathname === "/municipality/query") return jsonResponse(200, { value: {} });
        if (method === "GET" && url.pathname === "/employee/employment") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment") {
          assert.equal(body?.division, undefined);
          return jsonResponse(201, { value: { id: 25, version: 0, startDate: "2026-10-15" } });
        }
        if (method === "GET" && url.pathname === "/employee/employment/occupationCode") return jsonResponse(200, { values: [] });
        if (method === "GET" && url.pathname === "/employee/employment/details") return jsonResponse(200, { values: [] });
        if (method === "POST" && url.pathname === "/employee/employment/details") return jsonResponse(201, { value: { id: 27, annualSalary: 690000, percentageOfFullTimeEquivalent: 75 } });
        if (method === "PUT" && url.pathname === "/employee/entitlement/:grantEntitlementsByTemplate") return jsonResponse(200, { value: { ok: true } });
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "attachment_onboarding",
          values: {
            name: "Diego Flores",
            email: "diego.flores@example.org",
            employmentDate: "2026-10-15",
            departmentName: "Operaciones",
            userAccessRequested: true,
            annualSalary: 690000,
            employmentPercentage: 75,
          },
        } satisfies TaskSpec;
        const plan = await executeAttachmentOnboardingWorkflow(client, spec, false);
        assert.equal(spec.values.__employeeId, 22);
        assert.equal(spec.values.__employmentId, 25);
        assert.equal(spec.values.__divisionProvisioningFailed, true);
        assert(plan.steps.some((step) => step.path === "/employee/employment" && step.method === "GET"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeExpenseVoucherWorkflow creates and verifies structured receipt expense voucher",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method === "GET" && url.pathname === "/department") return jsonResponse(200, { values: [{ id: 71, name: "Produksjon" }] });
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("number") === "6550") {
          return jsonResponse(200, { value: { id: 81, number: 6550, name: "Office supplies" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("number") === "2710") {
          return jsonResponse(200, { value: { id: 82, number: 2710, name: "Input VAT 25%" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("isBalanceAccount") === "true") {
          return jsonResponse(200, { value: { id: 83, number: 1920, name: "Bank" } });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          assert.equal(body?.date, "2026-03-18");
          assert.equal(body?.description, "Skrivebordlampe");
          assert.equal(Array.isArray(body?.postings), true);
          assert.equal(body?.postings?.length, 3);
          assert.equal(body?.postings?.[0]?.department?.id, 71);
          assert.equal(body?.postings?.[0]?.account?.id, 81);
          assert.equal(body?.postings?.[1]?.account?.id, 82);
          assert.equal(body?.postings?.[2]?.account?.id, 83);
          return jsonResponse(201, { value: { id: 91 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/91") {
          return jsonResponse(200, {
            value: {
              id: 91,
              date: "2026-03-18",
              description: "Skrivebordlampe",
              postings: [
                { account: { number: 6550 }, amountGross: 1000, department: { id: 71, name: "Produksjon" } },
                { account: { number: 2710 }, amountGross: 250 },
                { account: { number: 1920 }, amountGross: -1250 },
              ],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "voucher",
          values: {
            receiptExpense: true,
            name: "Skrivebordlampe",
            description: "Skrivebordlampe",
            departmentName: "Produksjon",
            date: "2026-03-18",
            amount: 1250,
            accountNumber: "6550",
            vatRate: 25,
          },
        } satisfies TaskSpec;
        const plan = await executeExpenseVoucherWorkflow(client, spec, false);
        assert.equal(spec.values.__expenseVoucherId, 91);
        assert(plan.steps.some((step) => step.path === "/ledger/voucher" && step.method === "POST"));
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.detail, "expense voucher verified");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeExpenseVoucherWorkflow defaults lodging receipts to travel expense account",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (method === "GET" && url.pathname === "/department") return jsonResponse(200, { values: [{ id: 71, name: "Utvikling" }] });
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("number") === "7140") {
          return jsonResponse(200, { value: { id: 84, number: 7140, name: "Travel" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("number") === "2712") {
          return jsonResponse(200, { value: { id: 85, number: 2712, name: "Input VAT 12%" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account" && url.searchParams.get("isBalanceAccount") === "true") {
          return jsonResponse(200, { value: { id: 83, number: 1920, name: "Bank" } });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          assert.equal(body?.description, "Overnatting");
          assert.equal(body?.postings?.[0]?.account?.id, 84);
          assert.equal(body?.postings?.[0]?.department?.id, 71);
          return jsonResponse(201, { value: { id: 92 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/92") {
          return jsonResponse(200, {
            value: {
              id: 92,
              date: "2026-03-22",
              description: "Overnatting",
              postings: [
                { account: { number: 7140 }, amountGross: 3750, department: { id: 71, name: "Utvikling" } },
                { account: { number: 2712 }, amountGross: 450 },
                { account: { number: 1920 }, amountGross: -4200 },
              ],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "voucher",
          values: {
            receiptExpense: true,
            name: "Overnatting",
            description: "Overnatting",
            departmentName: "Utvikling",
            amount: 4200,
            vatRate: 12,
          },
        } satisfies TaskSpec;
        const plan = await executeExpenseVoucherWorkflow(client, spec, false);
        assert.equal(spec.values.__expenseVoucherId, 92);
        assert(plan.steps.some((step) => step.path === "/ledger/voucher" && step.method === "POST"));
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.detail, "expense voucher verified");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome validates attachment onboarding fields via employee lifecycle",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/employee/22") {
          return jsonResponse(200, { value: { id: 22, version: 0, firstName: "Lea", lastName: "Thomas", email: "lea.thomas@example.org", dateOfBirth: "2000-06-12", nationalIdentityNumber: "12060012345", bankAccountNumber: "12345678901", userType: "STANDARD", department: { id: 21, name: "Salg" } } });
        }
        if (url.pathname === "/employee/employment") {
          return jsonResponse(200, { values: [{ id: 25, version: 0, startDate: "2026-10-08", division: { id: 24 } }] });
        }
        if (url.pathname === "/employee/employment/details") {
          return jsonResponse(200, { values: [{ id: 27, date: "2026-10-08", annualSalary: 720000, percentageOfFullTimeEquivalent: 80, occupationCode: { id: 26, code: "2512" } }] });
        }
        throw new Error(`Unexpected request ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "attachment_onboarding",
          values: {
            __employeeId: 22,
            name: "Lea Thomas",
            email: "lea.thomas@example.org",
            dateOfBirth: "2000-06-12",
            employmentDate: "2026-10-08",
            nationalIdentityNumber: "12060012345",
            bankAccountNumber: "12345678901",
            departmentName: "Salg",
            userType: "STANDARD",
            occupationCode: "2512",
            employmentPercentage: 80,
            annualSalary: 720000,
          },
        } satisfies TaskSpec, null);
        assert.equal(result.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome tolerates sparse attachment onboarding values without forcing employment details defaults",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/employee/22") {
          return jsonResponse(200, {
            value: {
              id: 22,
              version: 0,
              firstName: "Mia",
              lastName: "Weber",
              email: "mia.weber@example.org",
              dateOfBirth: "2000-06-12",
              userType: "STANDARD",
              department: { id: 21, name: "Vertrieb" },
            },
          });
        }
        if (url.pathname === "/employee/employment") {
          return jsonResponse(200, { values: [{ id: 25, version: 0, startDate: "2026-10-08", division: { id: 24 } }] });
        }
        if (url.pathname === "/employee/employment/details") {
          return jsonResponse(200, { values: [{ id: 27, date: "2026-10-08", annualSalary: null, percentageOfFullTimeEquivalent: 80, occupationCode: null }] });
        }
        throw new Error(`Unexpected request ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const spec = {
          operation: "create",
          entity: "attachment_onboarding",
          values: {
            __employeeId: 22,
            name: "Mia Weber",
            email: "mia.weber@example.org",
            dateOfBirth: "2000-06-12",
            employmentDate: "2026-10-08",
            departmentName: "Vertrieb",
            occupationCode: "Gehalt",
          },
        } satisfies TaskSpec;
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "compilePlan builds structured travel expense create body",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "travel_expense",
        values: {
          employeeName: "Charlotte Smith",
          email: "charlotte.smith@example.org",
          title: "Conference Tromso",
          travelDays: 2,
          perDiemRate: 800,
          costs: [
            { comments: "flight ticket", amountCurrencyIncVat: 6400 },
            { comments: "taxi", amountCurrencyIncVat: 600 },
          ],
        },
      } satisfies TaskSpec);

      const travelStep = plan.steps.find((step) => step.path === "/travelExpense" && step.method === "POST");
      assert(travelStep, "expected POST /travelExpense step");
      const body = (travelStep?.body ?? {}) as Record<string, unknown>;
      const travelDetails = (body.travelDetails ?? {}) as Record<string, unknown>;
      assert.equal(travelDetails.departureDate, todayIsoInZone());
      assert.equal(travelDetails.returnDate, shiftIsoDateInZone({ days: 1 }));
      const perDiem = Array.isArray(body.perDiemCompensations) ? body.perDiemCompensations : [];
      assert.equal(Number((perDiem[0] as Record<string, unknown>)?.count), 2);
      assert.equal(Number((perDiem[0] as Record<string, unknown>)?.rate), 800);
      const costs = Array.isArray(body.costs) ? body.costs : [];
      assert.equal(costs.length, 2);
    },
  });

  gates.push({
    name: "verifyOutcome validates structured travel expense creation",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (url.pathname === "/employee") {
          return jsonResponse(200, { values: [{ id: 77, firstName: "Charlotte", lastName: "Smith", email: "charlotte.smith@example.org" }] });
        }
        if (url.pathname === "/travelExpense") {
          return jsonResponse(200, {
            values: [{
              id: 88,
              title: "Conference Tromso",
              perDiemCompensations: [{ count: 2, rate: 800, location: "Conference Tromso" }],
              costs: [
                { comments: "flight ticket", amountCurrencyIncVat: 6400 },
                { comments: "taxi", amountCurrencyIncVat: 600 },
              ],
            }],
          });
        }
        throw new Error(`Unexpected request ${url.pathname}`);
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "travel_expense",
          values: {
            employeeName: "Charlotte Smith",
            email: "charlotte.smith@example.org",
            title: "Conference Tromso",
            travelDays: 2,
            perDiemRate: 800,
            date: todayIsoInZone(),
            costs: [
              { comments: "flight ticket", amountCurrencyIncVat: 6400 },
              { comments: "taxi", amountCurrencyIncVat: 600 },
            ],
          },
        } satisfies TaskSpec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome fails closed when verification GET fails",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (): Promise<Response> => {
        throw new Error("verification offline");
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "customer",
          values: { name: "Gate Customer" },
        } satisfies TaskSpec, null);
        assert.equal(result.verified, false);
        assert.equal(result.required, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome uses exclusive upper date bound for invoice verification",
    run: async () => {
      const originalFetch = globalThis.fetch;
      let seenDateTo = "";
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        seenDateTo = url.searchParams.get("orderDateTo") ?? url.searchParams.get("invoiceDateTo") ?? seenDateTo;
        if (url.pathname === "/customer") {
          return jsonResponse(200, { values: [{ id: 1, name: "Gate Customer" }] });
        }
        if (url.pathname === "/invoice") {
          return jsonResponse(200, { values: [{ id: 2, invoiceNumber: 2, orderLines: [] }] });
        }
        return jsonResponse(200, { values: [{ id: 1 }] });
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "invoice",
          values: {},
        } satisfies TaskSpec, null);
        assert.equal(result.verified, true);
        assert.equal(seenDateTo, shiftIsoDateInZone({ days: 1 }));
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "todayIsoInZone uses Europe/Oslo local date semantics",
    run: () => {
      assert.match(todayIsoInZone(), /^\d{4}-\d{2}-\d{2}$/);
    },
  });

  gates.push({
    name: "verifyOutcome accepts invoice create via matching invoice",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/customer") {
          return jsonResponse(200, { values: [{ id: 901, name: "Ridgepoint Ltd", organizationNumber: "935400759" }] });
        }
        if (url.pathname === "/invoice") {
          return jsonResponse(200, {
            values: [
              {
                id: 8888,
                customer: { id: 901, name: "Ridgepoint Ltd" },
                orderLines: [
                  {
                    description: "",
                    displayName: "1001 Software License",
                    unitPriceExcludingVatCurrency: 1000,
                    vatType: { percentage: 25 },
                    product: { number: "1001", name: "Software License" },
                  },
                  {
                    description: "Consulting",
                    displayName: "Consulting",
                    unitPriceExcludingVatCurrency: 500,
                    vatType: { percentage: 15 },
                    product: null,
                  },
                ],
              },
            ],
          });
        }
        return jsonResponse(200, { values: [] });
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "invoice",
          values: {
            customerName: "Ridgepoint Ltd",
            organizationNumber: "935400759",
            invoiceLines: [
              { productNumber: "1001", productName: "Software License", amount: 1000, vatRate: 25 },
              { description: "Consulting", amount: 500, vatRate: 15 },
            ],
          },
        } satisfies TaskSpec, null);
        assert.equal(result.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome checks each department name in multi-create flows",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        const name = new URL(url).searchParams.get("name");
        if (name === "Administrasjon") return jsonResponse(200, { values: [{ id: 1, name }] });
        if (name === "Kundeservice") return jsonResponse(200, { values: [{ id: 2, name }] });
        return jsonResponse(200, { values: [] });
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "department",
          values: { names: ["Administrasjon", "Kundeservice", "Markedsforing"] },
        } satisfies TaskSpec, null);
        assert.equal(result.verified, false);
        assert.match(result.detail, /Markedsforing/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "verifyOutcome validates accounting dimensions and tagged postings",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === "/ledger/accountingDimensionName") {
          return jsonResponse(200, { values: [{ id: 11, dimensionName: "Kostsenter", dimensionIndex: 1, active: true }] });
        }
        if (url.pathname === "/ledger/accountingDimensionValue/search") {
          return jsonResponse(200, { values: [{ id: 22, displayName: "Marked", dimensionIndex: 1, active: true }] });
        }
        if (url.pathname === "/ledger/account") {
          return jsonResponse(200, { values: [{ id: 33, number: 6540, name: "Inventar" }] });
        }
        if (url.pathname === "/ledger/posting") {
          return jsonResponse(200, { values: [{ id: 44, description: "Dimension voucher" }] });
        }
        return jsonResponse(200, { values: [] });
      };
      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 5000,
        });
        const result = await verifyOutcome(client, {
          operation: "create",
          entity: "accounting_dimension",
          values: {
            dimensionName: "Kostsenter",
            dimensionValues: ["Marked"],
            dimensionValueName: "Marked",
            accountNumber: "6540",
            amount: 2500,
            description: "Dimension voucher",
          },
        } satisfies TaskSpec, null);
        assert.equal(result.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

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
          if (path.includes("/:")) {
            return jsonResponse(200, { value: { id: 9000 + calls.length, version: 1 } });
          }
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
    name: "executePlan retries action endpoints with PUT and maps body fields to query params",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, query, body });
        if (method === "PUT" && url.pathname === "/invoice/123/:payment") {
          return jsonResponse(200, { value: { id: 1 } });
        }
        if (method === "POST" && url.pathname === "/invoice/123/:payment") {
          return jsonResponse(400, { status: 400, message: "HTTP 405 Method Not Allowed" });
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
          summary: "action method + query mapping",
          steps: [
            {
              method: "POST",
              path: "/invoice/123/:payment",
              body: {
                paymentDate: "2026-03-19",
                paymentTypeId: 7,
                paidAmount: 2500,
              },
            },
          ],
        };
        await executePlan(client, plan, false);
        const putCall = calls.find((call) => call.method === "PUT" && call.path === "/invoice/123/:payment");
        assert(putCall, "expected PUT retry call for action endpoint");
        assert.equal(putCall?.query.paymentDate, "2026-03-19");
        assert.equal(putCall?.query.paymentTypeId, "7");
        assert.equal(putCall?.query.paidAmount, "2500");
        assert.equal(putCall?.body, undefined, "expected action payload to be mapped to query params");
      } finally {
        globalThis.fetch = originalFetch;
      }
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
    name: "executePlan broadens product lookup before creating duplicate product",
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
        if (method === "GET" && path === "/product" && query.number === "1722" && query.vatTypeId === "31") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && path === "/product" && query.number === "1722" && !query.vatTypeId) {
          return jsonResponse(200, { values: [{ id: 7722, number: "1722", name: "Maintenance" }] });
        }
        if (method === "POST" && path === "/order") {
          const orderBody = body as Record<string, unknown>;
          const orderLines = Array.isArray(orderBody?.orderLines) ? orderBody.orderLines as Array<Record<string, unknown>> : [];
          const product = (orderLines[0]?.product ?? {}) as Record<string, unknown>;
          if (!product?.id) {
            return jsonResponse(422, {
              status: 422,
              validationMessages: [{ field: "orderLines[0].product", message: "Kan ikke være null." }],
            });
          }
          return jsonResponse(201, { value: { id: 703, preliminaryInvoice: { id: 704 } } });
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
          summary: "hydrate missing product id with broad lookup",
          steps: [
            {
              method: "GET",
              path: "/customer",
              params: { organizationNumber: "834343096", count: 1 },
              saveAs: "customer",
            },
            {
              method: "GET",
              path: "/product",
              params: { number: "1722", vatTypeId: 31, count: 1 },
              saveAs: "product2",
            },
            {
              method: "POST",
              path: "/order",
              body: {
                customer: { id: "{{customer_id}}" },
                orderDate: "2026-03-21",
                deliveryDate: "2026-03-21",
                orderLines: [{ product: { id: "{{product2_id}}" }, count: 1, unitPriceExcludingVatCurrency: 11550 }],
              },
            },
          ],
        };

        await executePlan(client, plan, false);

        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/product").length,
          0,
          "expected broad GET fallback to resolve product without creating a duplicate",
        );
        const broadGets = calls.filter((call) => call.method === "GET" && call.path === "/product" && call.query.number === "1722");
        assert.equal(broadGets.length, 3, "expected plan lookup, hydration retry, and broad number lookup");
        const orderPosts = calls.filter((call) => call.method === "POST" && call.path === "/order");
        const orderLines = (((orderPosts[0]?.body ?? {}) as Record<string, unknown>).orderLines ?? []) as Array<Record<string, unknown>>;
        const product = (orderLines[0]?.product ?? {}) as Record<string, unknown>;
        assert.equal(product?.id, 7722, "order should reference broad-lookup product id");
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
        if (method === "PUT" && path === "/invoice/9050/:payment") {
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
          calls.filter((call) => call.method === "PUT" && call.path === "/invoice/9050/:payment").length,
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
        if (method === "PUT" && path === "/ledger/voucher/7060/:reverse") {
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
          calls.filter((call) => call.method === "PUT" && call.path === "/ledger/voucher/7060/:reverse").length,
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
    name: "executePlan creates a specifically requested project manager instead of falling back to an arbitrary employee",
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
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/employee") {
          const employeeBody = (body ?? {}) as Record<string, unknown>;
          assert.equal(employeeBody.firstName, "Oliver");
          assert.equal(employeeBody.lastName, "Brown");
          assert.equal(employeeBody.email, "oliver.brown@example.org");
          return jsonResponse(201, { value: { id: 8202 } });
        }
        if (method === "POST" && path === "/project") {
          const managerId = Number(
            ((body as Record<string, unknown>)?.projectManager as Record<string, unknown> | undefined)?.id,
          );
          if (managerId !== 8202) {
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
        assert.equal(Number(manager.id), 8202, "expected explicit employee creation to provide manager id");
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/employee").length,
          1,
          "expected one employee creation for the specifically requested manager",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan does not replace a specifically requested project manager with a broad assignable fallback",
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
          if (query.assignableProjectManagers === "true" && !query.email) {
            return jsonResponse(200, { values: [{ id: 8999, firstName: "Fallback", lastName: "Manager" }] });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/employee") {
          const employeeBody = (body ?? {}) as Record<string, unknown>;
          assert.equal(employeeBody.firstName, "Hilde");
          assert.equal(employeeBody.lastName, "Hansen");
          assert.equal(employeeBody.email, "hilde.hansen@example.org");
          return jsonResponse(201, { value: { id: 8202 } });
        }
        if (method === "POST" && path === "/project") {
          const managerId = Number(
            ((body as Record<string, unknown>)?.projectManager as Record<string, unknown> | undefined)?.id,
          );
          assert.equal(managerId, 8202);
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
          summary: "specific project manager should win over broad assignable fallback",
          steps: [
            { method: "GET", path: "/customer", params: { count: 1 }, saveAs: "customer" },
            {
              method: "GET",
              path: "/employee",
              params: {
                count: 1,
                fields: "id,firstName,lastName,email",
                assignableProjectManagers: true,
                firstName: "Hilde",
                lastName: "Hansen",
                email: "hilde.hansen@example.org",
              },
              saveAs: "employee",
            },
            {
              method: "POST",
              path: "/project",
              body: {
                name: "Digital transformasjon",
                startDate: "2026-03-22",
                customer: { id: "{{customer_id}}" },
                projectManager: { id: "{{employee_id}}" },
              },
            },
          ],
        };

        await executePlan(client, plan, false);
        assert.equal(
          calls.filter((call) => call.method === "POST" && call.path === "/employee").length,
          1,
          "expected explicit requested manager creation instead of broad fallback reuse",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executePlan throws when all mutating steps fail even if GETs succeed",
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
          summary: "all mutating steps fail — should throw",
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
        } catch (e) {
          threw = true;
          assert.ok(
            (e as Error).message.includes("all mutating steps failed"),
            `expected 'all mutating steps failed' in error, got: ${(e as Error).message}`,
          );
        }
        assert.equal(threw, true, "expected executePlan to throw when all mutating steps fail");
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
    name: "executePlan recovers existing employee and overlapping employment conflicts",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }> = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const path = url.pathname;
        const method = String(init?.method ?? "GET").toUpperCase();
        const query = Object.fromEntries(url.searchParams.entries());
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, query, body });

        if (method === "POST" && path === "/employee") {
          return jsonResponse(422, {
            status: 422,
            validationMessages: [{ field: "email", message: "Det finnes allerede en bruker med denne e-postadressen." }],
          });
        }
        if (method === "GET" && path === "/employee" && query.email === "gate.employee@example.org") {
          return jsonResponse(200, {
            values: [{ id: 4111, firstName: "Gate", lastName: "Employee", email: "gate.employee@example.org", dateOfBirth: "2000-06-30" }],
          });
        }
        if (method === "POST" && path === "/employee/employment") {
          return jsonResponse(422, {
            status: 422,
            validationMessages: [{ field: "startDate", message: "Overlappende perioder." }],
          });
        }
        if (method === "GET" && path === "/employee/employment" && query.employeeId === "4111") {
          return jsonResponse(200, {
            values: [{ id: 5222, startDate: "2026-10-08", employee: { id: 4111 }, division: { id: 99, name: "Default" } }],
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
        const result = await executePlan(client, {
          summary: "recover employee duplicates",
          steps: [
            {
              method: "POST",
              path: "/employee",
              body: {
                firstName: "Gate",
                lastName: "Employee",
                email: "gate.employee@example.org",
                dateOfBirth: "2000-06-30",
              },
              saveAs: "employee",
            },
            {
              method: "POST",
              path: "/employee/employment",
              body: {
                employee: { id: "{{employee_id}}" },
                startDate: "2026-10-08",
                division: { id: 99 },
                isMainEmployer: true,
              },
              saveAs: "employment",
            },
          ],
        }, false);

        assert.equal(result.vars.employee_id, 4111, "expected duplicate employee recovery to hydrate employee_id");
        assert.equal(result.vars.employment_id, 5222, "expected overlapping employment recovery to hydrate employment_id");
        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/employee" && call.query.email === "gate.employee@example.org").length,
          1,
          "expected exactly one employee lookup for duplicate recovery",
        );
        assert.equal(
          calls.filter((call) => call.method === "GET" && call.path === "/employee/employment" && call.query.employeeId === "4111").length,
          1,
          "expected exactly one employment lookup for overlap recovery",
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
        plan.steps.some((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders"),
        "expected PUT /order/:invoiceMultipleOrders in heuristic plan",
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
    name: "heuristic detects foreign-currency invoice payment flow with exchange difference",
    run: () => {
      const payload = {
        prompt: "We sent an invoice for 2052 EUR to Northwave Ltd (Org. no. 804172807). The invoice was booked at 10.97 NOK/EUR. The customer has now paid the full amount when the rate is 10.01 NOK/EUR. Register the payment and post the exchange rate difference.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      };
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, []));
      assert.equal(spec.operation, "pay_invoice");
      assert.equal(spec.entity, "invoice");
      assert.equal(spec.values.currencyCode, "EUR");
      assert.equal(spec.values.originalExchangeRate, 10.97);
      assert.equal(spec.values.paymentExchangeRate, 10.01);
      assert.equal(spec.values.postExchangeDifference, true);
    },
  });

  gates.push({
    name: "heuristic detects Nynorsk foreign-currency invoice payment flow without drifting to ledger_account",
    run: () => {
      const payload = {
        prompt: "Me sende ein faktura på 10143 EUR til Fjelltopp AS (org.nr 954884791) då kursen var 10.54 NOK/EUR. Kunden har no betalt, men kursen er 10.23 NOK/EUR. Registrer betalinga og bokfør valutadifferansen (disagio) på rett konto.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      };
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload, []));
      assert.equal(spec.operation, "pay_invoice");
      assert.equal(spec.entity, "invoice");
      assert.equal(spec.values.customerName, "Fjelltopp AS");
      assert.equal(spec.values.organizationNumber, "954884791");
      assert.equal(spec.values.amount, 10143);
      assert.equal(spec.values.currencyCode, "EUR");
      assert.equal(spec.values.originalExchangeRate, 10.54);
      assert.equal(spec.values.paymentExchangeRate, 10.23);
      assert.equal(spec.values.postExchangeDifference, true);
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
      assert(plan.steps.some((step) => step.path === "/order/:invoiceMultipleOrders"), "expected order invoice batch path");
      const issues = validatePlanForPrompt("Invoice order 888", plan);
      assert.equal(issues.length, 0, `unexpected issues: ${issues.join(" | ")}`);
    },
  });

  gates.push({
    name: "compileProjectTimeInvoicePreview creates a project-linked order before invoicing",
    run: () => {
      const plan = compileProjectTimeInvoicePreview("create", {
        projectName: "Canary App",
        customerName: "Aurora Drift AS",
        organizationNumber: "914774621",
        employeeName: "Maria Nilsen",
        email: "maria.nilsen@example.org",
        activityName: "Desenvolvimento",
        hours: 4,
        hourlyRate: 1050,
        date: "2026-03-22",
      });
      const orderStep = plan.steps.find((step) => step.method === "POST" && step.path === "/order");
      assert(orderStep, "expected POST /order in project time invoice preview");
      assert.equal((orderStep.body as Record<string, any>)?.project?.id, "{{project_id}}");
      const invoiceStep = plan.steps.find((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders");
      assert(invoiceStep, "expected invoice batch step after order creation");
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
    name: "heuristic extracts mixed-format employee birth and employment dates",
    run: () => {
      const payload = {
        prompt: "Créez un employé nommé Léa Thomas, né le 30. June 2000, avec l'e-mail lea.thomas@example.org et la date de début 8. October 2026.",
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "employee");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.email, "lea.thomas@example.org");
      assert.equal(spec.values.dateOfBirth, "2000-06-30");
      assert.equal(spec.values.employmentDate, "2026-10-08");
    },
  });

  gates.push({
    name: "normalizeTaskSpec keeps Portuguese employee master-data prompts out of customer fallback",
    run: () => {
      const payload = {
        prompt: "Temos um novo funcionário chamado Rita Almeida, nascida em 1995-12-29, com o e-mail rita.almeida@example.org e data de início 2026-06-07.",
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "employee");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.name, "Rita Almeida");
      assert.equal(spec.values.email, "rita.almeida@example.org");
      assert.equal(spec.values.dateOfBirth, "1995-12-29");
      assert.equal(spec.values.employmentDate, "2026-06-07");
    },
  });

  gates.push({
    name: "normalizeTaskSpec preserves accented Portuguese employee names",
    run: () => {
      const payload = {
        prompt:
          "Temos um novo funcionário chamado André Ferreira, nascido em 20. July 1992. Crie-o como funcionário com o e-mail andre.ferreira@example.org e data de início 2. August 2026.",
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "employee");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.name, "André Ferreira");
      assert.equal(spec.values.email, "andre.ferreira@example.org");
      assert.equal(spec.values.dateOfBirth, "1992-07-20");
      assert.equal(spec.values.employmentDate, "2026-08-02");
    },
  });

  gates.push({
    name: "compilePlan adds employment step when employee start date is provided",
    run: () => {
      const plan = compilePlan({
        operation: "create",
        entity: "employee",
        values: {
          firstName: "Léa",
          lastName: "Thomas",
          email: "lea.thomas@example.org",
          dateOfBirth: "2000-06-30",
          employmentDate: "2026-10-08",
        },
      } satisfies TaskSpec);
      assert(plan.steps.some((step) => step.method === "GET" && step.path === "/division"), "expected division lookup");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/employee"), "expected employee create");
      assert(plan.steps.some((step) => step.method === "POST" && step.path === "/employee/employment"), "expected employment create");
    },
  });

  gates.push({
    name: "verifyOutcome requires employment start date for employee prompts that specify it",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = String(init?.method ?? "GET").toUpperCase();
        const path = url.pathname;

        if (method === "GET" && path === "/employee/18618484") {
          return jsonResponse(200, {
            value: {
              id: 18618484,
              firstName: "Léa",
              lastName: "Thomas",
              email: "lea.thomas@example.org",
              dateOfBirth: "2000-06-30",
            },
          });
        }
        if (method === "GET" && path === "/employee/employment") {
          return jsonResponse(200, {
            values: [
              { id: 9001, startDate: "2026-10-08", employee: { id: 18618484 }, division: { id: 1, name: "AI Payroll Unit" } },
            ],
          });
        }
        return jsonResponse(404, { message: `Unexpected ${method} ${path}` });
      };

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "gate-token",
          timeoutMs: 1000,
        });
        const verification = await verifyOutcome(client, {
          operation: "create",
          entity: "employee",
          values: {
            firstName: "Léa",
            lastName: "Thomas",
            email: "lea.thomas@example.org",
            dateOfBirth: "2000-06-30",
            employmentDate: "2026-10-08",
          },
        } satisfies TaskSpec, {
          stepCount: 2,
          successCount: 2,
          mutatingAttempted: 2,
          mutatingSucceeded: 2,
          vars: { employee_id: 18618484 },
          failedSteps: [],
          stepResults: [{ step: 1, method: "POST", path: "/employee", saveAs: "employee", primary: { id: 18618484 } }],
        });
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
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
    name: "normalized travel expense handles accented day counts and trims conjunctions",
    run: () => {
      const spec = normalizeTaskSpec(
        {
          prompt:
            'Registre una nota de gastos de viaje para Pablo Rodríguez (pablo.rodriguez@example.org) por "Conferencia Ålesund". El viaje duró 5 días con dietas (tarifa diaria 800 NOK). Gastos: billete de avión 2750 NOK y taxi 700 NOK.',
          files: [],
        } as any,
        heuristicExtract({
          prompt:
            'Registre una nota de gastos de viaje para Pablo Rodríguez (pablo.rodriguez@example.org) por "Conferencia Ålesund". El viaje duró 5 días con dietas (tarifa diaria 800 NOK). Gastos: billete de avión 2750 NOK y taxi 700 NOK.',
          files: [],
        } as any),
      );
      assert.equal(spec.entity, "travel_expense");
      assert.equal(spec.values.travelDays, 5);
      assert.equal(spec.values.perDiemRate, 800);
      const costs = Array.isArray(spec.values.costs) ? spec.values.costs as Array<Record<string, unknown>> : [];
      assert.equal(costs.length, 2);
      assert.equal(costs[0]?.comments, "billete de avión");
      assert.equal(costs[1]?.comments, "taxi");
    },
  });

  gates.push({
    name: "travel expense extraction does not duplicate per diem as a normal cost line",
    run: () => {
      const prompt =
        'Registrer ei reiserekning for Åse Kvamme (ase.kvamme@example.org) for "Kundebesøk Drammen". Reisa varte 5 dagar med diett (dagssats 800 kr). Utlegg: flybillett 5050 kr og taxi 750 kr.';
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [],
        } as any,
        heuristicExtract({
          prompt,
          files: [],
        } as any),
      );
      assert.equal(spec.entity, "travel_expense");
      assert.equal(spec.values.perDiemRate, 800);
      const costs = Array.isArray(spec.values.costs) ? spec.values.costs as Array<Record<string, unknown>> : [];
      assert.equal(costs.length, 2);
      assert.equal(costs.some((item) => String(item.comments ?? "").toLowerCase().includes("dagssats")), false);
      assert.equal(costs.some((item) => String(item.comments ?? "").toLowerCase().includes("diett")), false);
      assert.equal(costs[0]?.comments, "flybillett");
      assert.equal(costs[1]?.comments, "taxi");
    },
  });

  gates.push({
    name: "normalizeTaskSpec keeps travel expense employee name separate from quoted trip title",
    run: () => {
      const prompt =
        'Registrer en reiseregning for Ragnhild Bakken (ragnhild.bakken@example.org) for "Kundebesøk Kristiansand". Reisen varte 4 dager med diett (dagsats 800 kr). Utlegg: flybillett 5450 kr og taxi 550 kr.';
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [],
        } as any,
        heuristicExtract({
          prompt,
          files: [],
        } as any),
      );
      assert.equal(spec.entity, "travel_expense");
      assert.equal(spec.values.employeeName, "Ragnhild Bakken");
      assert.equal(spec.values.name, "Ragnhild Bakken");
      assert.equal(spec.values.title, "Kundebesøk Kristiansand");
      assert.equal(spec.values.description, "Kundebesøk Kristiansand");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes receipt expense prompts to voucher instead of department",
    run: () => {
      const payload = {
        prompt:
          "Precisamos da despesa de Kaffemøte deste recibo registada no departamento Utvikling. Use a conta de despesas correta e garanta o tratamento correto do IVA.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "voucher");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.receiptExpense, true);
      assert.equal(spec.values.departmentName, "Utvikling");
      assert.equal(spec.values.description, "Kaffemøte");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes French receipt expense prompts to voucher and keeps the expense label",
    run: () => {
      const payload = {
        prompt:
          "Nous avons besoin de la depense Skrivebordlampe de ce recu enregistree au departement Produksjon. Utilisez le bon compte de charges et assurez le traitement correct de la TVA.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "voucher");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.receiptExpense, true);
      assert.equal(spec.values.departmentName, "Produksjon");
      assert.equal(spec.values.name, "Skrivebordlampe");
      assert.equal(spec.values.description, "Skrivebordlampe");
    },
  });

  gates.push({
    name: "normalizeTaskSpec preserves OCR-style European receipt amounts",
    run: () => {
      const payload = {
        prompt:
          "Precisamos da despesa de Overnatting deste recibo registada no departamento Utvikling. Use a conta de despesas correta e garanta o tratamento correto do IVA.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      } as const;
      const spec = normalizeTaskSpec(
        payload,
        heuristicExtract(payload, [
          {
            fileName: "overnatting.pdf",
            contentType: "application/pdf",
            source: "docai",
            textExcerpt: [
              "Description: Overnatting",
              "Date: 2026-03-22",
              "Amount incl. VAT: 4.200,00 NOK",
              "VAT: 12 %",
              "Department: Utvikling",
            ].join("\n"),
          },
        ] as any),
      );
      assert.equal(spec.entity, "voucher");
      assert.equal(spec.operation, "create");
      assert.equal(spec.values.receiptExpense, true);
      assert.equal(spec.values.amount, 4200);
      assert.equal(spec.values.vatRate, 12);
      assert.equal(spec.values.description, "Overnatting");
    },
  });

  gates.push({
    name: "supplier prompt stays on supplier master data",
    run: () => {
      const spec = normalizeTaskSpec(
        {
          prompt: "Registe o fornecedor Luz do Sol Lda com número de organização 962006930. E-mail: faktura@luzdosollda.no.",
          files: [],
        } as any,
        heuristicExtract({
          prompt: "Registe o fornecedor Luz do Sol Lda com número de organização 962006930. E-mail: faktura@luzdosollda.no.",
          files: [],
        } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "supplier");
      assert.equal(spec.values.name, "Luz do Sol Lda");
      assert.equal(spec.values.organizationNumber, "962006930");
    },
  });

  gates.push({
    name: "customer prompt captures address and does not turn postal code into amount",
    run: () => {
      const spec = normalizeTaskSpec(
        {
          prompt: "Crie o cliente Porto Alegre Lda com número de organização 834147254. O endereço é Storgata 65, 4611 Kristiansand. E-mail: post@porto.no.",
          files: [],
        } as any,
        heuristicExtract({
          prompt: "Crie o cliente Porto Alegre Lda com número de organização 834147254. O endereço é Storgata 65, 4611 Kristiansand. E-mail: post@porto.no.",
          files: [],
        } as any),
      );
      assert.equal(spec.entity, "customer");
      assert.equal(spec.values.name, "Porto Alegre Lda");
      assert.equal(spec.values.organizationNumber, "834147254");
      assert.equal(spec.values.address, "Storgata 65");
      assert.equal(spec.values.postalCode, "4611");
      assert.equal(spec.values.city, "Kristiansand");
      assert.equal(spec.values.amount, undefined);
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
        const reverseCall = calls.find((call) => call.method === "PUT" && call.path.endsWith("/:reverse"));
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
        plan.steps.some((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders"),
        "expected PUT /order/:invoiceMultipleOrders",
      );
      const productLookups = plan.steps.filter((step) => step.method === "GET" && step.path === "/product");
      assert(productLookups.length >= 3, "expected product lookups for extracted product lines");
    },
  });

  gates.push({
    name: "heuristic invoice extraction strips Spanish product-list lead-ins for composite order invoice payment prompts",
    run: () => {
      const spec = heuristicExtract({
        prompt: "Crea un pedido para el cliente Luna SL (org. nº 989093630) con los productos Almacenamiento en la nube (5981) a 29950 NOK y Diseño web (6784) a 20450 NOK. Convierte el pedido en factura y registra el pago completo.",
        files: [],
        tripletex_credentials: { base_url: "https://example.test/v2", session_token: "token" },
      });
      const lines = Array.isArray(spec.values.invoiceLines) ? spec.values.invoiceLines as Array<Record<string, unknown>> : [];
      assert.equal(lines.length, 2);
      assert.equal(lines[0]?.productName, "Almacenamiento en la nube");
      assert.equal(lines[1]?.productName, "Diseño web");
    },
  });

  gates.push({
    name: "invoice customer lookup preserves both organization number and customer name",
    run: () => {
      const spec = normalizeTaskSpec(
        {
          prompt: "Créez une facture pour le client Prairie SARL (nº org. 834343096) avec une ligne de produit : Maintenance (1722) à 11550 NOK avec 15 % TVA.",
          files: [],
        } as any,
        heuristicExtract({
          prompt: "Créez une facture pour le client Prairie SARL (nº org. 834343096) avec une ligne de produit : Maintenance (1722) à 11550 NOK avec 15 % TVA.",
          files: [],
        } as any),
      );
      const plan = compilePlan(spec);
      const customerLookup = plan.steps.find((step) => step.method === "GET" && step.path === "/customer");
      assert(customerLookup, "expected customer lookup step");
      const params = (customerLookup?.params ?? {}) as Record<string, unknown>;
      assert.equal(params.organizationNumber, "834343096");
      assert.equal(params.name, "Prairie SARL");
    },
  });

  gates.push({
    name: "normalizeTaskSpec converts supplier invoice prompt into supplier_invoice entity",
    run: () => {
      const prompt =
        "Vi har mottatt faktura INV-2026-8551 fra leverandøren Bergvik AS (org.nr 989568469) på 14850 kr inklusiv MVA. Beløpet gjelder kontortjenester (konto 6300). Registrer leverandørfakturaen med korrekt inngående MVA (25 %).";
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [],
        } as any,
        heuristicExtract({
          prompt,
          files: [],
        } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "supplier_invoice");
      assert.equal(spec.values.name, "Bergvik AS");
      assert.equal(spec.values.organizationNumber, "989568469");
      assert.equal(spec.values.invoiceNumber, "INV-2026-8551");
      assert.equal(spec.values.accountNumber, "6300");
      assert.equal(spec.values.amount, 14850);
      assert.equal(spec.values.vatRate, 25);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes Portuguese supplier invoice wording to supplier_invoice",
    run: () => {
      const prompt =
        "Recebemos a fatura INV-2026-7230 do fornecedor Solmar Lda (org. nº 973188410) no valor de 7700 NOK com IVA incluído. O montante refere-se a serviços de escritório (conta 7140). Registe a fatura do fornecedor com o IVA de 25 %.";
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [],
        } as any,
        heuristicExtract({
          prompt,
          files: [],
        } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "supplier_invoice");
      assert.equal(spec.values.name, "Solmar Lda");
      assert.equal(spec.values.organizationNumber, "973188410");
      assert.equal(spec.values.invoiceNumber, "INV-2026-7230");
      assert.equal(spec.values.accountNumber, "7140");
      assert.equal(spec.values.amount, 7700);
      assert.equal(spec.values.vatRate, 25);
    },
  });

  gates.push({
    name: "normalizeTaskSpec keeps attachment supplier invoice prompts on create workflow when prompt says supplier does not exist",
    run: () => {
      const prompt =
        "Du har mottatt en leverandorfaktura (se vedlagt PDF). Registrer fakturaen i Tripletex. Opprett leverandoren hvis den ikke finnes. Bruk riktig utgiftskonto og inngående MVA.";
      const attachmentText =
        "Leverandørfaktura\nFakturanummer: INV-2026-8506\nLeverandør: Bergvik AS\nOrganisasjonsnummer: 919398051\nFakturadato: 2026-02-01\nForfallsdato: 2026-03-03\nBeløp inkl. MVA: 62500 NOK\nUtgiftskonto: 6500\nMVA: 25%\nBeskrivelse: Kontorrekvisita";
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [{ filename: "invoice.pdf", mime_type: "application/pdf", content_base64: "x" }],
        } as any,
        heuristicExtract(
          {
            prompt,
            files: [{ filename: "invoice.pdf", mime_type: "application/pdf", content_base64: "x" }],
          } as any,
          [{ filename: "invoice.pdf", mimeType: "application/pdf", source: "text", summary: attachmentText, extractedText: attachmentText, textExcerpt: attachmentText }] as any,
        ),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "supplier_invoice");
      assert.equal(spec.values.name, "Bergvik AS");
      assert.equal(spec.values.organizationNumber, "919398051");
      assert.equal(spec.values.invoiceNumber, "INV-2026-8506");
      assert.equal(spec.values.accountNumber, "6500");
      assert.equal(spec.values.amount, 62500);
      assert.equal(spec.values.vatRate, 25);
    },
  });

  gates.push({
    name: "normalizeTaskSpec extracts French attachment supplier invoice fields",
    run: () => {
      const prompt =
        "Vous avez recu une facture fournisseur (voir PDF ci-joint). Enregistrez la facture dans Tripletex. Creez le fournisseur s'il n'existe pas. Utilisez le bon compte de charges et la TVA deductible.";
      const attachmentText =
        "Facture fournisseur\nFournisseur: Lumière SARL\nNuméro d'organisation: 839360274\nFacture numéro: FAC-2026-442\nDate facture: 2026-02-12\nDate d'échéance: 2026-03-14\nMontant TTC: 18 625,00 NOK\nCompte de charges: 6860\nTVA deductible: 25%\nDescription: Services de nettoyage";
      const spec = normalizeTaskSpec(
        {
          prompt,
          files: [{ filename: "invoice.pdf", mime_type: "application/pdf", content_base64: "x" }],
        } as any,
        heuristicExtract(
          {
            prompt,
            files: [{ filename: "invoice.pdf", mime_type: "application/pdf", content_base64: "x" }],
          } as any,
          [{ filename: "invoice.pdf", mimeType: "application/pdf", source: "docai", summary: attachmentText, extractedText: attachmentText, textExcerpt: attachmentText }] as any,
        ),
      );
      assert.equal(spec.entity, "supplier_invoice");
      assert.equal(spec.values.name, "Lumière SARL");
      assert.equal(spec.values.organizationNumber, "839360274");
      assert.equal(spec.values.invoiceNumber, "FAC-2026-442");
      assert.equal(spec.values.accountNumber, "6860");
      assert.equal(spec.values.amount, 18625);
      assert.equal(spec.values.vatRate, 25);
    },
  });

  gates.push({
    name: "executeSupplierInvoiceWorkflow creates supplier-linked voucher with expense, VAT, and payable postings",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });

        if (method === "GET" && url.pathname.endsWith("/supplier")) {
          return jsonResponse(200, { values: [{ id: 108332761, name: "Bergvik AS", organizationNumber: "989568469" }] });
        }
        if (method === "GET" && url.pathname.endsWith("/ledger/account")) {
          const number = Number(url.searchParams.get("number") ?? "0");
          const accountIdMap: Record<number, number> = {
            6300: 424306968,
            2710: 424306794,
            2400: 424306772,
          };
          return jsonResponse(200, { values: [{ id: accountIdMap[number], number }] });
        }
        if (method === "POST" && url.pathname.endsWith("/ledger/voucher")) {
          return jsonResponse(200, {
            value: {
              id: 608999001,
              date: "2026-03-21",
              description: "Leverandørfaktura INV-2026-8551 Bergvik AS",
              externalVoucherNumber: "INV-2026-8551",
              postings: body.postings,
            },
          });
        }
        if (method === "GET" && url.pathname.endsWith("/ledger/voucher/608999001")) {
          return jsonResponse(200, {
            value: {
              id: 608999001,
              date: "2026-03-21",
              description: "Leverandørfaktura INV-2026-8551 Bergvik AS",
              externalVoucherNumber: "INV-2026-8551",
              postings: [
                { account: { number: 6300 }, supplier: { id: 108332761, name: "Bergvik AS", organizationNumber: "989568469" }, amountGross: 11880 },
                { account: { number: 2710 }, supplier: { id: 108332761, name: "Bergvik AS", organizationNumber: "989568469" }, amountGross: 2970 },
                { account: { number: 2400 }, supplier: { id: 108332761, name: "Bergvik AS", organizationNumber: "989568469" }, amountGross: -14850 },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "supplier_invoice",
          values: {
            name: "Bergvik AS",
            organizationNumber: "989568469",
            invoiceNumber: "INV-2026-8551",
            amount: 14850,
            vatRate: 25,
            accountNumber: "6300",
            description: "Kontortjenester",
            date: "2026-03-21",
          },
          lookup: undefined,
        };

        const plan = await executeSupplierInvoiceWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.method === "POST" && step.path === "/ledger/voucher"));
        const voucherCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/ledger/voucher"));
        assert(voucherCall, "expected supplier voucher POST");
        assert.equal(voucherCall?.body?.externalVoucherNumber, "INV-2026-8551");
        assert.equal(Array.isArray(voucherCall?.body?.postings), true);
        assert.equal(voucherCall?.body?.postings?.length, 3);
        assert.equal(voucherCall?.body?.postings?.every((posting: any) => posting?.supplier?.id === 108332761), true);

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.detail, "supplier invoice voucher verified");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeSupplierInvoiceWorkflow prefers incoming invoice registration when supported",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname.endsWith("/supplier")) {
          return jsonResponse(200, { values: [{ id: 108332761, name: "Bergvik AS", organizationNumber: "989568469" }] });
        }
        if (method === "GET" && url.pathname.endsWith("/ledger/account")) {
          return jsonResponse(200, { values: [{ id: 424306968, number: 6300 }] });
        }
        if (method === "POST" && url.pathname.endsWith("/incomingInvoice")) {
          return jsonResponse(201, {
            value: {
              id: 8101,
              voucherId: 9101,
              invoiceHeader: {
                vendorId: 108332761,
                invoiceNumber: "INV-2026-8551",
                invoiceAmount: 14850,
                description: "Kontortjenester",
              },
            },
          });
        }
        if (method === "GET" && url.pathname.endsWith("/incomingInvoice/8101")) {
          return jsonResponse(200, {
            value: {
              id: 8101,
              voucherId: 9101,
              invoiceHeader: {
                vendorId: 108332761,
                invoiceNumber: "INV-2026-8551",
                invoiceAmount: 14850,
                description: "Kontortjenester",
              },
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "supplier_invoice",
          values: {
            name: "Bergvik AS",
            organizationNumber: "989568469",
            invoiceNumber: "INV-2026-8551",
            amount: 14850,
            vatRate: 25,
            accountNumber: "6300",
            description: "Kontortjenester",
            date: "2026-03-21",
            invoiceDueDate: "2026-03-31",
          },
          lookup: undefined,
        };

        const plan = await executeSupplierInvoiceWorkflow(client, spec, false);
        assert(plan.steps.some((step) => step.method === "POST" && step.path === "/incomingInvoice"));
        assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/incomingInvoice")), true);
        assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/ledger/voucher")), false);

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.detail, "supplier invoice verified via incoming invoice");
        assert.equal((spec.values as Record<string, unknown>).__supplierIncomingInvoiceId, 8101);
        assert.equal((spec.values as Record<string, unknown>).__supplierIncomingVoucherId, 9101);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes CSV bank matching prompts to bank_reconciliation",
    run: () => {
      const csv = Buffer.from("date;description;amount\n2026-03-31;Invoice INV-2026-1001 Aurora AS;12500\n", "utf8").toString("base64");
      const payload = {
        prompt: "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex. Associez les paiements aux factures clientes et fournisseurs.",
        files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "bank_reconciliation");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes complete project cycle prompts to project_cycle",
    run: () => {
      const payload = {
        prompt: "Gjennomfør heile prosjektsyklusen for 'Skymigrering Sjøbris' (Sjøbris AS, org.nr 912361152): 1) Prosjektet har budsjett 354050 kr. 2) Registrer timar: Arne Brekke (prosjektleiar, arne.brekke@example.org) 43 timar og Solveig Dahl (solveig.dahl@example.org) 27 timar. 3) Fakturer kunden.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "project_cycle");
      assert.equal(spec.values.projectName, "Skymigrering Sjøbris");
      assert.equal(spec.values.customerName, "Sjøbris AS");
      assert.equal(spec.values.organizationNumber, "912361152");
      assert.equal(spec.values.budgetAmount, 354050);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes complete project lifecycle prompts to project_cycle",
    run: () => {
      const payload = {
        prompt: "Execute the complete project lifecycle for 'System Upgrade Greenfield' (Greenfield Ltd, org no. 873288949): 1) The project has a budget of 206300 NOK. 2) Log time: Oliver Wilson (project manager, oliver.wilson@example.org) 36 hours and Victoria Taylor (consultant, victoria.taylor@example.org) 150 hours. 3) Invoice the customer.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "project_cycle");
      assert.equal(spec.values.projectName, "System Upgrade Greenfield");
      assert.equal(spec.values.customerName, "Greenfield Ltd");
      assert.equal(spec.values.organizationNumber, "873288949");
      assert.equal(spec.values.budgetAmount, 206300);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes French complete project life-cycle prompts to project_cycle",
    run: () => {
      const payload = {
        prompt: "Exécutez le cycle de vie complet du projet 'Implémentation ERP Soleil' (Soleil SARL, nº org. 987838345) : 1) Le projet a un budget de 382300 NOK. 2) Enregistrez le temps : Jules Richard (chef de projet, jules.richard@example.org) 41 heures et Clara Martin (clara.martin@example.org) 29 heures. 3) Facturez le client.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "project_cycle");
      assert.equal(spec.values.projectName, "Implémentation ERP Soleil");
      assert.equal(spec.values.customerName, "Soleil SARL");
      assert.equal(spec.values.organizationNumber, "987838345");
      assert.equal(spec.values.budgetAmount, 382300);
    },
  });

  gates.push({
    name: "normalizeTaskSpec extracts Spanish customer master data without polluting name or address",
    run: () => {
      const payload = {
        prompt: "Crea el cliente Dorada SL con número de organización 823073917. La dirección es Kirkegata 46, 4006 Stavanger. Correo: post@dorada.no.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "customer");
      assert.equal(spec.values.name, "Dorada SL");
      assert.equal(spec.values.organizationNumber, "823073917");
      assert.equal(spec.values.address, "Kirkegata 46");
      assert.equal(spec.values.postalCode, "4006");
      assert.equal(spec.values.city, "Stavanger");
    },
  });

  gates.push({
    name: "normalizeTaskSpec extracts German customer master data without falling back to email local-part",
    run: () => {
      const payload = {
        prompt: "Erstellen Sie den Kunden Grünfeld GmbH mit der Organisationsnummer 886669445. Die Adresse ist Kirkegata 87, 6003 Ålesund. E-Mail: post@grunfeld.no.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.entity, "customer");
      assert.equal(spec.values.name, "Grünfeld GmbH");
      assert.equal(spec.values.organizationNumber, "886669445");
      assert.equal(spec.values.address, "Kirkegata 87");
      assert.equal(spec.values.postalCode, "6003");
      assert.equal(spec.values.city, "Ålesund");
      assert.equal(spec.values.email, "post@grunfeld.no");
      assert.equal(spec.values.phoneNumber, undefined);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes generic supplier master-data prompts to supplier",
    run: () => {
      const payload = {
        prompt: "Registrer leverandøren Havbris AS med organisasjonsnummer 846635408. E-post: faktura@havbris.no.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "supplier");
      assert.equal(spec.values.name, "Havbris AS");
      assert.equal(spec.values.organizationNumber, "846635408");
      assert.equal(spec.values.email, "faktura@havbris.no");
      assert.equal(spec.values.isSupplier, true);
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes month-end prompts to month_end_closing",
    run: () => {
      const payload = {
        prompt: "Perform month-end closing for March 2026. Post accrual reversal (6850 NOK per month from account 1700 to expense account 6800). Record monthly depreciation for a fixed asset with acquisition cost 228600 NOK and useful life 9 years using depreciation expense account 6010 and accumulated depreciation account 1290.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes annual closing prompts to month_end_closing",
    run: () => {
      const payload = {
        prompt: "Gjer forenkla årsoppgjer for 2025: Rekn ut og bokfør årlege avskrivingar for tre eigedelar: Inventar (170000 kr, 4 år lineært, konto 1240), Kontormaskiner (176500 kr, 5 år, konto 1200), IT-utstyr (360100 kr, 9 år, konto 1210). Bruk konto 6010 for avskrivingskostnad og 1209 for akkumulerte avskrivingar.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes Norwegian month-end prompts to month_end_closing",
    run: () => {
      const payload = {
        prompt: "Utfør månedsavslutning for mars 2026. Periodiser forskuddsbetalt kostnad (6500 kr per måned fra konto 1700 til kostkonto). Bokfør månedlig avskrivning for et driftsmiddel med anskaffelseskost 104900 kr og levetid 5 år.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes French annual closing prompts to month_end_closing",
    run: () => {
      const spec = normalizeTaskSpec(
        {
          prompt: "Effectuez la clôture annuelle simplifiée pour 2025 : calculez et comptabilisez l'amortissement annuel de trois immobilisations.",
          files: [],
        } as any,
        heuristicExtract({
          prompt: "Effectuez la clôture annuelle simplifiée pour 2025 : calculez et comptabilisez l'amortissement annuel de trois immobilisations.",
          files: [],
        } as any),
      );
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "month_end_closing");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes ledger variance prompts to ledger_variance_projects",
    run: () => {
      const payload = {
        prompt: "Os custos totais aumentaram de janeiro para fevereiro de 2026. Identifique as 3 contas de despesa com maior aumento e crie um projeto interno para cada uma.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "ledger_variance_projects");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes exact Spanish ledger variance prompt to ledger_variance_projects",
    run: () => {
      const payload = {
        prompt: "Los costos totales aumentaron significativamente de enero a febrero de 2026. Analice el libro mayor e identifique las tres cuentas de gastos con el mayor incremento en monto. Cree un proyecto interno para cada una de las cuentas seleccionadas.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "ledger_variance_projects");
    },
  });

  gates.push({
    name: "normalizeTaskSpec routes ledger audit prompts to ledger_error_correction",
    run: () => {
      const payload = {
        prompt: "We have discovered errors in the general ledger for January and February 2026. Review all vouchers, find the 4 errors, and correct them. Log every change as audit note.",
        files: [],
      } as any;
      const spec = normalizeTaskSpec(payload, heuristicExtract(payload));
      assert.equal(spec.operation, "create");
      assert.equal(spec.entity, "ledger_error_correction");
    },
  });

  gates.push({
    name: "executeProjectCycleWorkflow creates and verifies project manager, budget, timesheets, and invoice for multiple employees",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      let managerCreated = false;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        const path = url.pathname.replace(/^\/v2/, "") || "/";
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/customer") {
          return jsonResponse(200, { value: { id: 9101, name: body?.name, organizationNumber: body?.organizationNumber } });
        }
        if (method === "GET" && path === "/employee" && url.searchParams.get("assignableProjectManagers") === "true") {
          const email = String(url.searchParams.get("email") ?? "");
          if (managerCreated && email === "arne.brekke@example.org") {
            return jsonResponse(200, { values: [{ id: 7101, version: 1, firstName: "Arne", lastName: "Brekke", email, userType: "STANDARD", department: { id: 301 } }] });
          }
          return jsonResponse(200, { values: [{ id: 501, firstName: "Fallback", lastName: "Manager", email: "manager@example.org", userType: "STANDARD", department: { id: 301 } }] });
        }
        if (method === "GET" && path === "/employee") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && path === "/department") {
          return jsonResponse(200, { values: [{ id: 301, name: "Employees" }] });
        }
        if (method === "POST" && path === "/employee") {
          const email = String(body?.email ?? "");
          const id = email.includes("arne") ? 7101 : 7102;
          if (id === 7101) {
            managerCreated = true;
            assert.equal(body?.userType, "STANDARD");
          } else {
            assert.equal(body?.userType, "NO_ACCESS");
          }
          return jsonResponse(200, { value: { id, version: 1, firstName: body?.firstName, lastName: body?.lastName, email, userType: body?.userType, department: { id: 301 } } });
        }
        if (method === "GET" && path === "/project") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/project") {
          return jsonResponse(200, {
            value: {
              id: 6201,
              name: body?.name,
              description: body?.description,
              isPriceCeiling: body?.isPriceCeiling,
              priceCeilingAmount: body?.priceCeilingAmount,
              customer: { id: 9101, name: "Sjøbris AS", organizationNumber: "912361152" },
              projectManager: body?.projectManager?.id === 7101
                ? { id: 7101, firstName: "Arne", lastName: "Brekke", email: "arne.brekke@example.org" }
                : { id: 501, firstName: "Fallback", lastName: "Manager", email: "manager@example.org" },
            },
          });
        }
        if (method === "GET" && path === "/project/6201") {
          const latestProjectMutation = [...calls]
            .reverse()
            .find((call) => (call.method === "POST" && call.path === "/project") || (call.method === "PUT" && call.path === "/project/6201"));
          return jsonResponse(200, {
            value: {
              id: 6201,
              name: "Skymigrering Sjøbris",
              description: latestProjectMutation?.body?.description,
              isPriceCeiling: latestProjectMutation?.body?.isPriceCeiling ?? false,
              priceCeilingAmount: latestProjectMutation?.body?.priceCeilingAmount,
              customer: { id: 9101, name: "Sjøbris AS", organizationNumber: "912361152" },
              projectManager: latestProjectMutation?.body?.projectManager?.id === 7101
                ? { id: 7101, firstName: "Arne", lastName: "Brekke", email: "arne.brekke@example.org" }
                : { id: 501, firstName: "Fallback", lastName: "Manager", email: "manager@example.org" },
              participants: calls
                .filter((call) => call.method === "POST" && call.path === "/project/participant")
                .map((call) => ({ employee: { id: call.body?.employee?.id, email: call.body?.employee?.id === 7101 ? "arne.brekke@example.org" : "solveig.dahl@example.org" } })),
              projectActivities: calls
                .filter((call) => call.method === "POST" && call.path === "/project/projectActivity")
                .map(() => ({ activity: { id: 801, name: "Project Work", activityType: "PROJECT_GENERAL_ACTIVITY" } })),
            },
          });
        }
        if (method === "GET" && path === "/activity") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/activity") {
          return jsonResponse(200, { value: { id: 801, name: body?.name, activityType: "PROJECT_GENERAL_ACTIVITY", isChargeable: true } });
        }
        if (method === "POST" && path === "/project/participant") {
          return jsonResponse(200, { value: { id: Date.now() } });
        }
        if (method === "POST" && path === "/project/projectActivity") {
          return jsonResponse(200, { value: { id: 1 } });
        }
        if (method === "GET" && path === "/timesheet/entry") {
          const employeeId = Number(url.searchParams.get("employeeId") ?? "0");
          return jsonResponse(200, {
            values: calls
              .filter((call) => call.method === "POST" && call.path === "/timesheet/entry" && Number(call.body?.employee?.id ?? 0) === employeeId)
              .map((call, index) => ({
                id: 9501 + index,
                hours: call.body?.hours,
                comment: call.body?.comment,
                employee: { id: call.body?.employee?.id, email: call.body?.employee?.id === 7101 ? "arne.brekke@example.org" : "solveig.dahl@example.org" },
                project: { id: 6201 },
              })),
          });
        }
        if (method === "POST" && path === "/timesheet/entry") {
          const nextId = 9500 + calls.filter((call) => call.method === "POST" && call.path === "/timesheet/entry").length;
          return jsonResponse(200, { value: { id: nextId, ...body } });
        }
        if (method === "POST" && path === "/order") {
          return jsonResponse(200, { value: { id: 8801 } });
        }
        if (method === "PUT" && path === "/order/:invoiceMultipleOrders") {
          return jsonResponse(200, { value: { id: 9901 } });
        }
        if (method === "GET" && path === "/invoice/9901") {
          return jsonResponse(200, {
            value: {
              id: 9901,
              amountOutstanding: 354050,
              customer: { id: 9101, name: "Sjøbris AS", organizationNumber: "912361152" },
            },
          });
        }

        return jsonResponse(404, { status: 404, message: `Unhandled ${method} ${path}` });
      }) as typeof globalThis.fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://mock.tripletex.dev/v2",
          sessionToken: "mock-token",
          timeoutMs: 5000,
        });
        const prompt = "Gjennomfør heile prosjektsyklusen for 'Skymigrering Sjøbris' (Sjøbris AS, org.nr 912361152): 1) Prosjektet har budsjett 354050 kr. 2) Registrer timar: Arne Brekke (prosjektleiar, arne.brekke@example.org) 43 timar og Solveig Dahl (solveig.dahl@example.org) 27 timar. 3) Fakturer kunden.";
        const spec = normalizeTaskSpec(
          {
            prompt,
            files: [],
          } as any,
          heuristicExtract({
            prompt,
            files: [],
          } as any),
        );
        const plan = await executeProjectCycleWorkflow(client, spec, prompt, false);
        assert.equal(plan.steps.some((step) => step.method === "POST" && step.path === "/project"), true);
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/timesheet/entry").length >= 4, true);
        assert.equal(plan.steps.some((step) => step.method === "PUT" && step.path === "/order/:invoiceMultipleOrders"), true);
        const projectCreate = calls.find((call) => call.method === "POST" && call.path === "/project");
        assert.equal(projectCreate?.body?.projectManager?.id, 7101);
        assert.equal(projectCreate?.body?.isPriceCeiling, true);
        assert.equal(projectCreate?.body?.priceCeilingAmount, 354050);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeProjectCycleWorkflow creates the specifically requested manager as assignable instead of falling back",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      let managerCreated = false;
      let managerPromoted = false;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        const path = url.pathname.replace(/^\/v2/, "") || "/";
        calls.push({ method, path, body, query });

        if (method === "GET" && path === "/customer") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/customer") {
          return jsonResponse(200, { value: { id: 9101, name: body?.name, organizationNumber: body?.organizationNumber } });
        }
        if (method === "GET" && path === "/department") {
          return jsonResponse(200, { values: [{ id: 301, name: "Employees" }] });
        }
        if (method === "GET" && path === "/employee" && url.searchParams.get("assignableProjectManagers") === "true") {
          const email = String(url.searchParams.get("email") ?? "");
          if (managerCreated && managerPromoted && email === "charlotte.williams@example.org") {
            return jsonResponse(200, {
              values: [{ id: 8101, version: 1, firstName: "Charlotte", lastName: "Williams", email, userType: "STANDARD", department: { id: 301 } }],
            });
          }
          return jsonResponse(200, { values: [{ id: 501, firstName: "Fallback", lastName: "Manager", email: "manager@example.org", userType: "STANDARD", department: { id: 301 } }] });
        }
        if (method === "GET" && path === "/employee") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/employee") {
          const email = String(body?.email ?? "");
          if (email === "charlotte.williams@example.org") {
            managerCreated = true;
            assert.equal(body?.userType, "STANDARD");
            return jsonResponse(200, { value: { id: 8101, version: 1, firstName: "Charlotte", lastName: "Williams", email, userType: "STANDARD", department: { id: 301 } } });
          }
          assert.equal(body?.userType, "NO_ACCESS");
          return jsonResponse(200, { value: { id: 8102, version: 1, firstName: body?.firstName, lastName: body?.lastName, email, userType: "NO_ACCESS", department: { id: 301 } } });
        }
        if (method === "GET" && path === "/employee/8101") {
          return jsonResponse(200, {
            value: {
              id: 8101,
              version: 1,
              firstName: "Charlotte",
              lastName: "Williams",
              email: "charlotte.williams@example.org",
              userType: "STANDARD",
              department: { id: 301 },
            },
          });
        }
        if (method === "PUT" && path === "/employee/8101") {
          assert.equal(body?.userType, "STANDARD");
          return jsonResponse(200, {
            value: {
              id: 8101,
              version: 1,
              firstName: "Charlotte",
              lastName: "Williams",
              email: "charlotte.williams@example.org",
              userType: "STANDARD",
              department: { id: 301 },
            },
          });
        }
        if (method === "PUT" && path === "/employee/entitlement/:grantEntitlementsByTemplate") {
          assert.equal(query.employeeId, "8101");
          assert.equal(query.template, "DEPARTMENT_LEADER");
          managerPromoted = true;
          return jsonResponse(200, { value: true });
        }
        if (method === "GET" && path === "/project") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/project") {
          assert.equal(body?.projectManager?.id, 8101);
          return jsonResponse(200, {
            value: {
              id: 6201,
              name: body?.name,
              description: body?.description,
              isPriceCeiling: body?.isPriceCeiling,
              priceCeilingAmount: body?.priceCeilingAmount,
              customer: { id: 9101, name: "Windmill Ltd", organizationNumber: "882329348" },
              projectManager: { id: 8101, firstName: "Charlotte", lastName: "Williams", email: "charlotte.williams@example.org" },
            },
          });
        }
        if (method === "GET" && path === "/project/6201") {
          return jsonResponse(200, {
            value: {
              id: 6201,
              name: "Cloud Migration Windmill",
              description: "Budget 470800 NOK",
              isPriceCeiling: true,
              priceCeilingAmount: 470800,
              customer: { id: 9101, name: "Windmill Ltd", organizationNumber: "882329348" },
              projectManager: { id: 8101, firstName: "Charlotte", lastName: "Williams", email: "charlotte.williams@example.org" },
              participants: calls.filter((call) => call.method === "POST" && call.path === "/project/participant").map((call) => ({ employee: { id: call.body?.employee?.id, email: call.body?.employee?.id === 8101 ? "charlotte.williams@example.org" : "victoria.taylor@example.org" } })),
              projectActivities: calls.filter((call) => call.method === "POST" && call.path === "/project/projectActivity").map(() => ({ activity: { id: 801, name: "Project Work", activityType: "PROJECT_GENERAL_ACTIVITY" } })),
              preliminaryInvoice: { id: 9901 },
            },
          });
        }
        if (method === "GET" && path === "/activity") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && path === "/activity") {
          return jsonResponse(200, { value: { id: 801, name: body?.name, activityType: "PROJECT_GENERAL_ACTIVITY", isChargeable: true } });
        }
        if (method === "POST" && path === "/project/participant") {
          return jsonResponse(200, { value: { id: Date.now() } });
        }
        if (method === "POST" && path === "/project/projectActivity") {
          return jsonResponse(200, { value: { id: 1 } });
        }
        if (method === "GET" && path === "/timesheet/entry") {
          const employeeId = Number(url.searchParams.get("employeeId") ?? "0");
          return jsonResponse(200, {
            values: calls
              .filter((call) => call.method === "POST" && call.path === "/timesheet/entry" && Number(call.body?.employee?.id ?? 0) === employeeId)
              .map((call, index) => ({
                id: 9501 + index,
                hours: call.body?.hours,
                comment: call.body?.comment,
                employee: { id: call.body?.employee?.id, email: call.body?.employee?.id === 8101 ? "charlotte.williams@example.org" : "victoria.taylor@example.org" },
                project: { id: 6201 },
              })),
          });
        }
        if (method === "POST" && path === "/timesheet/entry") {
          return jsonResponse(200, { value: { id: 9500 + calls.filter((call) => call.method === "POST" && call.path === "/timesheet/entry").length, ...body } });
        }
        if (method === "POST" && path === "/order") {
          return jsonResponse(200, { value: { id: 8801 } });
        }
        if (method === "PUT" && path === "/order/:invoiceMultipleOrders") {
          return jsonResponse(200, { value: { id: 9901 } });
        }
        if (method === "GET" && path === "/invoice/9901") {
          return jsonResponse(200, {
            value: {
              id: 9901,
              amountOutstanding: 470800,
              customer: { id: 9101, name: "Windmill Ltd", organizationNumber: "882329348" },
            },
          });
        }

        return jsonResponse(404, { status: 404, message: `Unhandled ${method} ${path}` });
      }) as typeof globalThis.fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://mock.tripletex.dev/v2",
          sessionToken: "mock-token",
          timeoutMs: 5000,
        });
        const prompt = "Execute the complete project lifecycle for 'Cloud Migration Windmill' (Windmill Ltd, org no. 882329348): 1) The project has a budget of 470800 NOK. 2) Log time: Charlotte Williams (project manager, charlotte.williams@example.org) 34 hours and Victoria Taylor (victoria.taylor@example.org) 18 hours. 3) Invoice the customer.";
        const spec = normalizeTaskSpec(
          {
            prompt,
            files: [],
          } as any,
          heuristicExtract({
            prompt,
            files: [],
          } as any),
        );
        const plan = await executeProjectCycleWorkflow(client, spec, prompt, false);
        assert.equal(plan.steps.some((step) => step.method === "POST" && step.path === "/project"), true);
        const managerPost = calls.find((call) => call.method === "POST" && call.path === "/employee" && call.body?.email === "charlotte.williams@example.org");
        assert.equal(managerPost?.body?.userType, "STANDARD");
        const promoteCall = calls.find((call) => call.method === "PUT" && call.path === "/employee/entitlement/:grantEntitlementsByTemplate");
        assert.equal(promoteCall?.query.template, "DEPARTMENT_LEADER");
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow creates and verifies accrual and depreciation vouchers",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1700: 1700, 6800: 6800, 6010: 6010, 1290: 1290 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber, name: `Account ${accountNumber}` }] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          const description = String(body?.description ?? "");
          const voucherId = description.includes("depreciation") ? 7002 : 7001;
          return jsonResponse(200, { value: { id: voucherId } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7001") {
          return jsonResponse(200, {
            value: {
              id: 7001,
              date: "2026-03-31",
              description: "Month-end closing 2026-03 accrual reversal",
              postings: [
                { account: { number: 6800 }, amountGross: 6850 },
                { account: { number: 1700 }, amountGross: -6850 },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7002") {
          return jsonResponse(200, {
            value: {
              id: 7002,
              date: "2026-03-31",
              description: "Month-end closing 2026-03 depreciation",
              postings: [
                { account: { number: 6010 }, amountGross: 2116.67 },
                { account: { number: 1290 }, amountGross: -2116.67 },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {
            date: "2026-03-31",
            accrualAmount: 6850,
            accrualFromAccountNumber: 1700,
            accrualToAccountNumber: 6800,
            assetCost: 228600,
            usefulLifeYears: 9,
            depreciationExpenseAccountNumber: 6010,
            accumulatedDepreciationAccountNumber: 1290,
          },
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Perform month-end closing for March 2026. Post accrual reversal (6850 NOK per month from account 1700 to expense account 6800). Record monthly depreciation for a fixed asset with acquisition cost 228600 NOK and useful life 9 years using depreciation expense account 6010 and accumulated depreciation account 1290.",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 2);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/ledger/voucher").length, 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow supports annual closing depreciation across multiple assets",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 6010: 6010, 1209: 1209 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber, name: `Account ${accountNumber}` }] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          const description = String(body?.description ?? "");
          const voucherIdMap: Record<string, number> = {
            "Year-end closing 2025-12 depreciation Inventar": 7101,
            "Year-end closing 2025-12 depreciation Kontormaskiner": 7102,
            "Year-end closing 2025-12 depreciation IT-utstyr": 7103,
          };
          return jsonResponse(200, { value: { id: voucherIdMap[description] ?? 7199 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7101") {
          return jsonResponse(200, {
            value: {
              id: 7101,
              date: "2025-12-31",
              description: "Year-end closing 2025-12 depreciation Inventar",
              postings: [
                { account: { number: 6010 }, amountGross: 42500 },
                { account: { number: 1209 }, amountGross: -42500 },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7102") {
          return jsonResponse(200, {
            value: {
              id: 7102,
              date: "2025-12-31",
              description: "Year-end closing 2025-12 depreciation Kontormaskiner",
              postings: [
                { account: { number: 6010 }, amountGross: 35300 },
                { account: { number: 1209 }, amountGross: -35300 },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7103") {
          return jsonResponse(200, {
            value: {
              id: 7103,
              date: "2025-12-31",
              description: "Year-end closing 2025-12 depreciation IT-utstyr",
              postings: [
                { account: { number: 6010 }, amountGross: 40011.11 },
                { account: { number: 1209 }, amountGross: -40011.11 },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {},
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Gjer forenkla årsoppgjer for 2025: Rekn ut og bokfør årlege avskrivingar for tre eigedelar: Inventar (170000 kr, 4 år lineært, konto 1240), Kontormaskiner (176500 kr, 5 år, konto 1200), IT-utstyr (360100 kr, 9 år, konto 1210). Bruk konto 6010 for avskrivingskostnad og 1209 for akkumulerte avskrivingar.",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 3);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/ledger/voucher").length, 3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow supports German month-end accrual and depreciation wording",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1710: 1710, 6800: 6800, 6010: 6010, 1290: 1290 };
          return jsonResponse(200, { values: accountIds[accountNumber] ? [{ id: accountIds[accountNumber], number: accountNumber, name: `Account ${accountNumber}` }] : [] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          const description = String(body?.description ?? "");
          const voucherIdMap: Record<string, number> = {
            "Month-end closing 2026-03 accrual reversal": 7301,
            "Month-end closing 2026-03 depreciation Inventar": 7302,
            "Month-end closing 2026-03 depreciation Maschine": 7303,
          };
          return jsonResponse(200, { value: { id: voucherIdMap[description] ?? 7399 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7301") {
          return jsonResponse(200, { value: { id: 7301, date: "2026-03-31", description: "Month-end closing 2026-03 accrual reversal", postings: [{ account: { number: 6800 }, amountGross: 6157 }, { account: { number: 1710 }, amountGross: -6157 }] } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7302") {
          return jsonResponse(200, { value: { id: 7302, date: "2026-03-31", description: "Month-end closing 2026-03 depreciation Inventar", postings: [{ account: { number: 6010 }, amountGross: 1512.26 }, { account: { number: 1290 }, amountGross: -1512.26 }] } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7303") {
          return jsonResponse(200, { value: { id: 7303, date: "2026-03-31", description: "Month-end closing 2026-03 depreciation Maschine", postings: [{ account: { number: 6010 }, amountGross: 1121.58 }, { account: { number: 1290 }, amountGross: -1121.58 }] } });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {},
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Führen Sie den Monatsabschluss für März 2026 durch. Buchen Sie die Rechnungsabgrenzung (6157 NOK pro Monat von Konto 1710 auf Aufwandskonto 6800). Erfassen Sie die monatliche Abschreibung für zwei Anlagen: Inventar (181471 NOK, 10 Jahre, Konto 1240) und Maschine (94213 NOK, 7 Jahre, Konto 1200). Verwenden Sie Konto 6010 für Abschreibungskosten und Konto 1290 für kumulierte Abschreibungen.",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 3);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/ledger/voucher").length, 3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow falls back to a resolvable expense account when prompt only says 'to expense'",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/account") {
          const explicitNumber = url.searchParams.get("number");
          if (!explicitNumber) {
            return jsonResponse(200, {
              values: [
                { id: 1700, number: 1700, name: "Forskuddsbetalt kostnad" },
                { id: 6800, number: 6800, name: "Other operating expense" },
                { id: 6010, number: 6010, name: "Depreciation expense" },
                { id: 1290, number: 1290, name: "Accumulated depreciation" },
              ],
            });
          }
          const accountNumber = Number(explicitNumber);
          const accountIds: Record<number, number> = { 1700: 1700, 6800: 6800, 6010: 6010, 1290: 1290 };
          return jsonResponse(200, { values: accountIds[accountNumber] ? [{ id: accountIds[accountNumber], number: accountNumber, name: `Account ${accountNumber}` }] : [] });
        }
        if (method === "GET" && url.pathname === "/ledger/posting") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          const description = String(body?.description ?? "");
          const voucherIdMap: Record<string, number> = {
            "Month-end closing 2026-03 accrual reversal": 7401,
            "Month-end closing 2026-03 depreciation": 7402,
          };
          return jsonResponse(200, { value: { id: voucherIdMap[description] ?? 7499 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7401") {
          return jsonResponse(200, { value: { id: 7401, date: "2026-03-31", description: "Month-end closing 2026-03 accrual reversal", postings: [{ account: { number: 6800 }, amountGross: 6250 }, { account: { number: 1700 }, amountGross: -6250 }] } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7402") {
          return jsonResponse(200, { value: { id: 7402, date: "2026-03-31", description: "Month-end closing 2026-03 depreciation", postings: [{ account: { number: 6010 }, amountGross: 1076.39 }, { account: { number: 1290 }, amountGross: -1076.39 }] } });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {},
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Perform month-end closing for March 2026. Post accrual reversal (6250 NOK per month from account 1700 to expense). Record monthly depreciation for a fixed asset with acquisition cost 77500 NOK and useful life 6 years (straight-line).",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 2);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow supports French annual closing depreciation wording",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 6010: 6010, 1209: 1209 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber, name: `Account ${accountNumber}` }] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          const description = String(body?.description ?? "");
          const voucherIdMap: Record<string, number> = {
            "Year-end closing 2025-12 depreciation Inventar": 7201,
            "Year-end closing 2025-12 depreciation Kontormaskiner": 7202,
            "Year-end closing 2025-12 depreciation IT-utstyr": 7203,
          };
          return jsonResponse(200, { value: { id: voucherIdMap[description] ?? 7299 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7201") {
          return jsonResponse(200, { value: { id: 7201, date: "2025-12-31", description: "Year-end closing 2025-12 depreciation Inventar", postings: [{ account: { number: 6010 }, amountGross: 20081.25 }, { account: { number: 1209 }, amountGross: -20081.25 }] } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7202") {
          return jsonResponse(200, { value: { id: 7202, date: "2025-12-31", description: "Year-end closing 2025-12 depreciation Kontormaskiner", postings: [{ account: { number: 6010 }, amountGross: 8630 }, { account: { number: 1209 }, amountGross: -8630 }] } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7203") {
          return jsonResponse(200, { value: { id: 7203, date: "2025-12-31", description: "Year-end closing 2025-12 depreciation IT-utstyr", postings: [{ account: { number: 6010 }, amountGross: 10800 }, { account: { number: 1209 }, amountGross: -10800 }] } });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {},
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Effectuez la clôture annuelle simplifiée pour 2025 : Calculez et comptabilisez l'amortissement annuel de trois immobilisations : Inventar (160650 NOK, 8 ans linéaire, compte 1240), Kontormaskiner (86300 NOK, 10 ans, compte 1280), IT-utstyr (54000 NOK, 5 ans, compte 1230). Utilisez le compte 6010 pour la charge d'amortissement et 1209 pour l'amortissement cumulé.",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 3);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeMonthEndClosingWorkflow falls back when explicit accumulated depreciation account is unavailable",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          if (accountNumber === 6010) {
            return jsonResponse(200, { values: [{ id: 6010, number: 6010, name: "Account 6010" }] });
          }
          if (accountNumber === 1290) {
            return jsonResponse(200, { values: [{ id: 1290, number: 1290, name: "Account 1290" }] });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 7201 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/7201") {
          return jsonResponse(200, {
            value: {
              id: 7201,
              date: "2025-12-31",
              description: "Year-end closing 2025-12 depreciation Inventar",
              postings: [
                { account: { number: 6010 }, amountGross: 42500 },
                { account: { number: 1290 }, amountGross: -42500 },
              ],
            },
          });
        }
        throw new Error(`Unmocked ${method} ${url.pathname} body=${JSON.stringify(body)}`);
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "month_end_closing",
          values: {},
          lookup: undefined,
        };

        const plan = await executeMonthEndClosingWorkflow(
          client,
          spec,
          "Gjer forenkla årsoppgjer for 2025: Rekn ut og bokfør årlege avskrivingar for Inventar (170000 kr, 4 år lineært, konto 1240). Bruk konto 6010 for avskrivingskostnad og 1209 for akkumulerte avskrivingar.",
          false,
        );
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 1);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow processes customer and supplier statement rows",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      let supplierCloseGroupId = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          const invoiceNumber = url.searchParams.get("invoiceNumber");
          if (invoiceNumber === "INV-2026-1001") {
            return jsonResponse(200, {
              values: [{
                id: 8101,
                invoiceNumber: "INV-2026-1001",
                amount: 12500,
                amountOutstanding: 12500,
                customer: { id: 901, name: "Aurora AS", organizationNumber: "998877665" },
                orderLines: [{ description: "Consulting", product: { name: "Consulting", number: "3644" } }],
              }],
            });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "PUT" && url.pathname === "/invoice/8101/:payment") {
          return jsonResponse(200, { value: { id: 8101 } });
        }
        if (method === "GET" && url.pathname === "/invoice/8101") {
          return jsonResponse(200, {
            value: {
              id: 8101,
              invoiceNumber: "INV-2026-1001",
              amount: 12500,
              amountOutstanding: 0,
              customer: { id: 901, name: "Aurora AS", organizationNumber: "998877665" },
              orderLines: [{ description: "Consulting", product: { name: "Consulting", number: "3644" } }],
            },
          });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          const invoiceNumber = url.searchParams.get("invoiceNumber");
          if (invoiceNumber === "SUP-2026-44") {
            return jsonResponse(200, {
              values: [{
                id: 9201,
                voucherId: 9101,
                invoiceHeader: { vendorId: 720, invoiceNumber: "SUP-2026-44", invoiceAmount: 4200, description: "Office supplies" },
                metadata: { voucherNumber: "9101" },
              }],
            });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1920: 1920, 2400: 2400 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber }] });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9101") {
          return jsonResponse(200, {
            value: {
              id: 9101,
              postings: [
                {
                  id: 91011,
                  account: { number: 2400 },
                  supplier: { id: 720, name: "Nordic Supplies" },
                  amountGross: -4200,
                  ...(supplierCloseGroupId > 0 ? { closeGroup: { id: supplierCloseGroupId } } : {}),
                },
              ],
            },
          });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 9102 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9102") {
          return jsonResponse(200, {
            value: {
              id: 9102,
              postings: [
                {
                  id: 91021,
                  account: { number: 2400 },
                  supplier: { id: 720, name: "Nordic Supplies" },
                  amountGross: 4200,
                  ...(supplierCloseGroupId > 0 ? { closeGroup: { id: supplierCloseGroupId } } : {}),
                },
              ],
            },
          });
        }
        if (method === "PUT" && url.pathname === "/ledger/posting/:closePostings") {
          supplierCloseGroupId = 777;
          return jsonResponse(200, { value: true });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/9201") {
          return jsonResponse(200, { value: { id: 9201, voucherId: 9101 } });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "date;description;amount\n2026-03-31;Invoice INV-2026-1001 Aurora AS;12500\n2026-03-31;Supplier SUP-2026-44 Nordic Supplies;-4200\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(plan.steps.length, 3);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert(calls.some((call) => call.method === "PUT" && call.path === "/invoice/8101/:payment"), "expected customer invoice payment");
        assert(calls.some((call) => call.method === "PUT" && call.path === "/ledger/posting/:closePostings"), "expected posting close");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow accepts CSV-like bank exports with excel mime and credit/debit headers",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          if (url.searchParams.get("invoiceNumber") === "INV-2026-2001") {
            return jsonResponse(200, {
              values: [{
                id: 8201,
                invoiceNumber: "INV-2026-2001",
                amount: 18750,
                amountOutstanding: 18750,
                customer: { id: 902, name: "Atlas AS", organizationNumber: "998877664" },
                orderLines: [{ description: "Hosting", product: { name: "Hosting", number: "8100" } }],
              }],
            });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "PUT" && url.pathname === "/invoice/8201/:payment") {
          return jsonResponse(200, { value: { id: 8201 } });
        }
        if (method === "GET" && url.pathname === "/invoice/8201") {
          return jsonResponse(200, {
            value: {
              id: 8201,
              invoiceNumber: "INV-2026-2001",
              amount: 18750,
              amountOutstanding: 0,
              customer: { id: 902, name: "Atlas AS", organizationNumber: "998877664" },
              orderLines: [{ description: "Hosting", product: { name: "Hosting", number: "8100" } }],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "booking date,counterparty,reference,credit_amount,debit_amount\n2026-03-31,Atlas AS,INV-2026-2001,18750,0\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Reconcile the bank statement (attached CSV) against open invoices in Tripletex.",
          files: [{ filename: "statement-export.txt", mime_type: "application/vnd.ms-excel", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(plan.steps.length, 1);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert(calls.some((call) => call.method === "PUT" && call.path === "/invoice/8201/:payment"), "expected customer invoice payment");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow leaves unmatched rows for manual follow-up",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation/settings") {
          return jsonResponse(200, { value: null });
        }
        if (method === "POST" && url.pathname === "/bank/reconciliation/settings") {
          return jsonResponse(201, { value: { id: 401, numberOfMatchesPerPage: "ITEMS_10" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1920: 1920 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber }] });
        }
        if (method === "GET" && url.pathname === "/ledger/accountingPeriod") {
          return jsonResponse(200, {
            values: [
              { id: 202603, start: "2026-03-01", end: "2026-04-01", isClosed: false },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/bank/reconciliation") {
          return jsonResponse(201, {
            value: {
              id: 9901,
              account: { id: 1920 },
              accountingPeriod: { id: 202603, start: "2026-03-01", end: "2026-04-01" },
              isClosed: false,
              type: "MANUAL",
            },
          });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation/9901") {
          return jsonResponse(200, {
            value: {
              id: 9901,
              account: { id: 1920 },
              accountingPeriod: { id: 202603, start: "2026-03-01", end: "2026-04-01" },
              isClosed: false,
              type: "MANUAL",
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "date;description;amount\n2026-03-31;Unknown incoming customer payment;3500\n2026-03-31;Unknown supplier payment;-1400\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Import the attached CSV bank statement, reconcile known rows, and leave unmatched transactions for manual follow-up.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(plan.steps.some((step) => step.path === "/bank/reconciliation/settings"), true);
        assert.equal(plan.steps.some((step) => step.path === "/bank/reconciliation"), true);
        assert.equal(Number(spec.values?.__bankManualFollowUpRows ?? 0), 2);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow parses Spanish and German CSV headers and handles partial supplier payment",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          return jsonResponse(200, {
            values: [{
              id: 8101,
              invoiceNumber: "INV-2026-1001",
              amount: 12500,
              amountOutstanding: 12500,
              amountOutstandingTotal: 12500,
              customer: { id: 500, name: "Aurora AS", organizationNumber: "912345678" },
              orderLines: [{ description: "Consulting", product: { name: "Consulting", number: "R1" } }],
            }],
          });
        }
        if (method === "PUT" && url.pathname === "/invoice/8101/:payment") {
          return jsonResponse(200, { value: true });
        }
        if (method === "GET" && url.pathname === "/invoice/8101") {
          return jsonResponse(200, {
            value: {
              id: 8101,
              invoiceNumber: "INV-2026-1001",
              amount: 12500,
              amountOutstanding: 7500,
              amountOutstandingTotal: 7500,
              customer: { id: 500, name: "Aurora AS", organizationNumber: "912345678" },
              orderLines: [{ description: "Consulting", product: { name: "Consulting", number: "R1" } }],
            },
          });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          return jsonResponse(200, {
            values: [{
              id: 9201,
              voucherId: 9101,
              invoiceHeader: {
                vendorId: 720,
                invoiceNumber: "SUP-2026-44",
                invoiceAmount: 4200,
                description: "Nordic Supplies",
              },
            }],
          });
        }
        if (method === "POST" && url.pathname === "/incomingInvoice/9201/addPayment") {
          assert.equal(body?.partialPayment, true);
          assert.equal(body?.amountCurrency, 2000);
          return jsonResponse(200, { value: true });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/9201") {
          return jsonResponse(200, {
            value: {
              id: 9201,
              voucherId: 9101,
              invoiceHeader: { invoiceNumber: "SUP-2026-44", invoiceAmount: 4200 },
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "fecha;concepto;abono;cargo;referencia;cliente;proveedor\n2026-03-31;Pago parcial INV-2026-1001 Aurora AS;5000;;INV-2026-1001;Aurora AS;\n31.03.2026;Teilzahlung SUP-2026-44 Nordic Supplies;;2000;SUP-2026-44;;Nordic Supplies\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Concilia el extracto bancario (CSV adjunto) con las facturas abiertas en Tripletex. Relaciona los pagos entrantes con las facturas de clientes y los pagos salientes con las facturas de proveedores. Maneja los pagos parciales correctamente.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(Number(spec.values?.__bankProcessedRows ?? 0), 2);
        assert.equal(Number(spec.values?.__bankManualFollowUpRows ?? 0), 0);
        assert(plan.steps.some((step) => step.path === "/invoice/8101/:payment"), "expected customer payment step");
        assert(plan.steps.some((step) => step.path === "/incomingInvoice/9201/addPayment"), "expected supplier partial payment step");
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow falls back to supplier vouchers when incomingInvoice is unavailable",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          return jsonResponse(403, {
            status: 403,
            code: 9000,
            message: "You do not have permission to access this feature.",
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1920: 1920, 2400: 2400 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber }] });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, {
            values: [{
              id: 9101,
              description: "Supplier invoice SUP-2026-44 Nordic Supplies",
              externalVoucherNumber: "SUP-2026-44",
              vendorInvoiceNumber: "SUP-2026-44",
              postings: [{
                id: 91011,
                amountGross: -4200,
                account: { number: 2400 },
                supplier: { id: 720, name: "Nordic Supplies" },
              }],
            }],
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9101") {
          return jsonResponse(200, {
            value: {
              id: 9101,
              description: "Supplier invoice SUP-2026-44 Nordic Supplies",
              postings: [{
                id: 91011,
                amountGross: -4200,
                account: { number: 2400 },
                supplier: { id: 720, name: "Nordic Supplies" },
              }],
            },
          });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 9102 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9102") {
          return jsonResponse(200, {
            value: {
              id: 9102,
              description: "Bank payment SUP-2026-44",
              postings: [{
                id: 91021,
                amountGross: 2000,
                account: { number: 2400 },
                supplier: { id: 720, name: "Nordic Supplies" },
              }],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "date;description;amount\n2026-03-31;Supplier SUP-2026-44 Nordic Supplies;-2000\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex. Gérez correctement les paiements partiels fournisseurs.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(Number(spec.values?.__bankProcessedRows ?? 0), 1);
        assert.equal(Number(spec.values?.__bankManualFollowUpRows ?? 0), 0);
        assert(plan.steps.some((step) => step.path === "/ledger/voucher"), "expected supplier voucher fallback payment step");
        assert.equal(plan.steps.some((step) => String(step.path).includes("/incomingInvoice/")), false);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow paginates supplier voucher fallback to find exact invoice numbers",
    run: async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          return jsonResponse(403, {
            status: 403,
            code: 9000,
            message: "You do not have permission to access this feature.",
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          const accountIds: Record<number, number> = { 1920: 1920, 2400: 2400 };
          return jsonResponse(200, { values: [{ id: accountIds[accountNumber], number: accountNumber }] });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher") {
          const from = Number(url.searchParams.get("from") ?? "0");
          if (from === 0) {
            return jsonResponse(200, {
              values: Array.from({ length: 100 }, (_, index) => ({
                id: 9001 + index,
                description: `Older unrelated supplier voucher ${index + 1}`,
                externalVoucherNumber: `SUP-OLDER-${index + 1}`,
                vendorInvoiceNumber: `SUP-OLDER-${index + 1}`,
                postings: [{
                  id: 90011 + index,
                  amountGross: -4200,
                  account: { number: 2400 },
                  supplier: { id: 721, name: "Other Supplier" },
                }],
              })),
            });
          }
          if (from === 100) {
            return jsonResponse(200, {
              values: [{
                id: 9101,
                description: "Supplier invoice SUP-2026-44 Nordic Supplies",
                externalVoucherNumber: "SUP-2026-44",
                vendorInvoiceNumber: "SUP-2026-44",
                postings: [{
                  id: 91011,
                  amountGross: -4200,
                  account: { number: 2400 },
                  supplier: { id: 720, name: "Nordic Supplies" },
                }],
              }],
            });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9101") {
          return jsonResponse(200, {
            value: {
              id: 9101,
              description: "Supplier invoice SUP-2026-44 Nordic Supplies",
              postings: [{
                id: 91011,
                amountGross: -4200,
                account: { number: 2400 },
                supplier: { id: 720, name: "Nordic Supplies" },
                closeGroup: { id: 5521 },
              }],
            },
          });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 9102 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9102") {
          return jsonResponse(200, {
            value: {
              id: 9102,
              description: "Bank payment SUP-2026-44",
              postings: [{
                id: 91021,
                amountGross: 4200,
                account: { number: 2400 },
                supplier: { id: 720, name: "Nordic Supplies" },
                closeGroup: { id: 5521 },
              }],
            },
          });
        }
        if (method === "PUT" && url.pathname === "/ledger/posting/:closePostings") {
          assert.deepEqual(body, [91011, 91021]);
          return jsonResponse(200, { value: true });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "date;description;amount\n2026-03-31;Supplier SUP-2026-44 Nordic Supplies;-4200\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        const plan = await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert.equal(Number(spec.values?.__bankProcessedRows ?? 0), 1);
        assert.equal(Number(spec.values?.__bankManualFollowUpRows ?? 0), 0);
        assert(plan.steps.some((step) => step.path === "/ledger/voucher"));
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeBankReconciliationWorkflow matches short numeric invoice numbers from labeled CSV descriptions",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/invoice/paymentType") {
          return jsonResponse(200, { value: { id: 11, description: "Bank" } });
        }
        if (method === "GET" && url.pathname === "/invoice") {
          const invoiceNumber = url.searchParams.get("invoiceNumber");
          if (invoiceNumber === "88") {
            return jsonResponse(200, {
              values: [{
                id: 8801,
                invoiceNumber: "88",
                amount: 12500,
                amountOutstanding: 12500,
                amountOutstandingTotal: 12500,
                customer: { id: 501, name: "Debug Bank 159556d41 AS", organizationNumber: "900203556" },
                orderLines: [{ description: "Debug bank line 159556d41", product: { name: "Consulting", number: "R1" } }],
              }],
            });
          }
          return jsonResponse(200, {
            values: [{
              id: 8701,
              invoiceNumber: "87",
              amount: 12500,
              amountOutstanding: 12500,
              amountOutstandingTotal: 12500,
              customer: { id: 500, name: "Bank Harness 108162mnv AS", organizationNumber: "900152162" },
              orderLines: [{ description: "Bank harness customer line 108162mnv", product: { name: "Consulting", number: "R1" } }],
            }],
          });
        }
        if (method === "PUT" && url.pathname === "/invoice/8801/:payment") {
          return jsonResponse(200, { value: true });
        }
        if (method === "GET" && url.pathname === "/invoice/8801") {
          return jsonResponse(200, {
            value: {
              id: 8801,
              invoiceNumber: "88",
              amount: 12500,
              amountOutstanding: 0,
              amountOutstandingTotal: 0,
              customer: { id: 501, name: "Debug Bank 159556d41 AS", organizationNumber: "900203556" },
              orderLines: [{ description: "Debug bank line 159556d41", product: { name: "Consulting", number: "R1" } }],
            },
          });
        }
        if (method === "GET" && url.pathname === "/incomingInvoice/search") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation/settings") {
          return jsonResponse(200, { value: null });
        }
        if (method === "POST" && url.pathname === "/bank/reconciliation/settings") {
          return jsonResponse(201, { value: { id: 401, numberOfMatchesPerPage: "ITEMS_10" } });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const accountNumber = Number(url.searchParams.get("number") ?? "0");
          return jsonResponse(200, { values: [{ id: accountNumber, number: accountNumber }] });
        }
        if (method === "GET" && url.pathname === "/ledger/accountingPeriod") {
          return jsonResponse(200, {
            values: [{ id: 202603, start: "2026-03-01", end: "2026-04-01", isClosed: false }],
          });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/bank/reconciliation") {
          return jsonResponse(201, {
            value: { id: 9901, account: { id: 1920 }, accountingPeriod: { id: 202603 }, isClosed: false, type: "MANUAL" },
          });
        }
        if (method === "GET" && url.pathname === "/bank/reconciliation/9901") {
          return jsonResponse(200, {
            value: { id: 9901, account: { id: 1920 }, accountingPeriod: { id: 202603 }, isClosed: false, type: "MANUAL" },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const csv = Buffer.from(
          "date;description;amount\n2026-03-22;Invoice 88 Debug Bank 159556d41 AS;12500\n2026-03-22;Unknown transfer 159556d41;3500\n",
          "utf8",
        ).toString("base64");
        const payload = {
          prompt: "Rapprochez le relevé bancaire (CSV ci-joint) avec les factures ouvertes dans Tripletex. Laissez la ligne non rapprochée pour suivi manuel.",
          files: [{ filename: "statement.csv", mime_type: "text/csv", content_base64: csv }],
        } as const;
        const spec: TaskSpec = {
          operation: "create",
          entity: "bank_reconciliation",
          values: {},
          lookup: undefined,
        };

        await executeBankReconciliationWorkflow(client, spec, payload, undefined, false);
        assert(calls.some((call) => call.method === "GET" && call.path === "/invoice" && call.query.invoiceNumber === "88"), "expected direct invoice number lookup");
        assert(calls.some((call) => call.method === "PUT" && call.path === "/invoice/8801/:payment"), "expected payment on short-number invoice");
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeLedgerVarianceProjectsWorkflow ranks expense increases and creates internal projects",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      const createdProjects = new Map<number, any>();
      let nextProjectId = 9700;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/posting") {
          const dateFrom = url.searchParams.get("dateFrom");
          if (dateFrom === "2026-01-01") {
            return jsonResponse(200, {
              values: [
                { id: 1, amount: -5000, account: { id: 6100, number: 6100, name: "Rent", type: "EXPENSE" } },
                { id: 2, amount: -1000, account: { id: 7140, number: 7140, name: "Travel", type: "EXPENSE" } },
                { id: 3, amount: -2000, account: { id: 7300, number: 7300, name: "Marketing", type: "EXPENSE" } },
              ],
            });
          }
          if (dateFrom === "2026-02-01") {
            return jsonResponse(200, {
              values: [
                { id: 4, amount: -9000, account: { id: 6100, number: 6100, name: "Rent", type: "EXPENSE" } },
                { id: 5, amount: -2800, account: { id: 7140, number: 7140, name: "Travel", type: "EXPENSE" } },
                { id: 6, amount: -4500, account: { id: 7300, number: 7300, name: "Marketing", type: "EXPENSE" } },
                { id: 7, amount: -200, account: { id: 6800, number: 6800, name: "Software", type: "EXPENSE" } },
              ],
            });
          }
          return jsonResponse(200, { values: [] });
        }
        if (method === "GET" && url.pathname === "/employee") {
          return jsonResponse(200, {
            values: [{ id: 77, firstName: "Project", lastName: "Manager", email: "pm@example.test" }],
          });
        }
        if (method === "GET" && url.pathname === "/project") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/project") {
          const id = nextProjectId++;
          const created = { id, ...body };
          createdProjects.set(id, created);
          return jsonResponse(201, { value: created });
        }
        if (method === "GET" && /^\/project\/\d+$/.test(url.pathname)) {
          const id = Number(url.pathname.split("/").pop());
          const created = createdProjects.get(id);
          if (!created) return jsonResponse(404, { message: "not found" });
          return jsonResponse(200, { value: created });
        }

        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "ledger_variance_projects" as TaskSpec["entity"],
          values: {
            analysisFromMonth: 1,
            analysisToMonth: 2,
            closingYear: 2026,
            topCount: 3,
          },
          lookup: undefined,
        };

        const plan = await executeLedgerVarianceProjectsWorkflow(
          client,
          spec,
          "The total costs increased from January to February 2026. Identify the top 3 expense accounts with the largest increase and create an internal project for each.",
          false,
        );
        assert.equal(plan.steps.length, 9);

        const projectPosts = calls.filter((call) => call.method === "POST" && call.path === "/project");
        assert.equal(projectPosts.length, 3);
        assert.equal(projectPosts.every((call) => call.body?.isInternal === true), true);
        assert.deepEqual(
          projectPosts.map((call) => String(call.body?.name ?? "")),
          ["Variance 6100 Rent", "Variance 7300 Marketing", "Variance 7140 Travel"],
        );

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(verification.detail, "ledger variance projects verified (3)");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeLedgerVarianceProjectsWorkflow uses net increase, not absolute turnover",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const createdProjects = new Map<number, Record<string, unknown>>();
      let nextProjectId = 9100;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        if (method === "GET" && url.pathname === "/ledger/posting") {
          const dateFrom = String(url.searchParams.get("dateFrom") ?? "");
          if (dateFrom.startsWith("2026-01")) {
            return jsonResponse(200, {
              values: [
                { account: { number: 6100, name: "Rent" }, amountGross: 10000 },
                { account: { number: 7300, name: "Marketing" }, amountGross: 1000 },
                { account: { number: 7140, name: "Travel" }, amountGross: 500 },
              ],
            });
          }
          return jsonResponse(200, {
            values: [
              { account: { number: 6100, name: "Rent" }, amountGross: 12000 },
              { account: { number: 6100, name: "Rent" }, amountGross: -8000 },
              { account: { number: 7300, name: "Marketing" }, amountGross: 9000 },
              { account: { number: 7140, name: "Travel" }, amountGross: 3000 },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/employee") {
          return jsonResponse(200, { values: [{ id: 42, firstName: "Ada", lastName: "Manager", email: "ada@example.org" }] });
        }
        if (method === "GET" && url.pathname === "/project") {
          return jsonResponse(200, { values: [] });
        }
        if (method === "POST" && url.pathname === "/project") {
          const id = nextProjectId++;
          const created = { id, ...body };
          createdProjects.set(id, created);
          return jsonResponse(201, { value: created });
        }
        if (method === "GET" && /^\/project\/\d+$/.test(url.pathname)) {
          const id = Number(url.pathname.split("/").pop());
          const created = createdProjects.get(id);
          if (!created) return jsonResponse(404, { message: "not found" });
          return jsonResponse(200, { value: created });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "ledger_variance_projects" as TaskSpec["entity"],
          values: {
            analysisFromMonth: 1,
            analysisToMonth: 2,
            closingYear: 2026,
            topCount: 2,
          },
          lookup: undefined,
        };

        await executeLedgerVarianceProjectsWorkflow(
          client,
          spec,
          "The total costs increased from January to February 2026. Identify the top 2 expense accounts with the largest increase and create an internal project for each.",
          false,
        );
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.deepEqual(
          [...createdProjects.values()].map((item) => String(item.name ?? "")),
          ["Variance 7300 Marketing", "Variance 7140 Travel"],
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeLedgerErrorCorrectionWorkflow applies analyzer-provided reverse and adjustment corrections",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/voucher" && !/^\/ledger\/voucher\/\d+$/.test(url.pathname)) {
          return jsonResponse(200, {
            values: [
              {
                id: 5101,
                date: "2026-01-12",
                description: "Duplicate supplier invoice",
                postings: [
                  { row: 1, amountGross: 1000, account: { number: 6800, name: "Office" } },
                  { row: 2, amountGross: -1000, account: { number: 2400, name: "Supplier payable" } },
                ],
              },
              {
                id: 5102,
                date: "2026-02-08",
                description: "Posted to wrong expense account",
                postings: [
                  { row: 1, amountGross: 2000, account: { number: 6100, name: "Rent" } },
                  { row: 2, amountGross: -2000, account: { number: 1920, name: "Bank" } },
                ],
              },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const number = Number(url.searchParams.get("number") ?? "0");
          return jsonResponse(200, { values: [{ id: number, number, name: `Account ${number}` }] });
        }
        if (method === "PUT" && url.pathname === "/ledger/voucher/5101/:reverse") {
          return jsonResponse(200, { value: { id: 9101 } });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 9102 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9101") {
          return jsonResponse(200, {
            value: {
              id: 9101,
              description: "Audit correction for voucher 5101: Duplicate voucher",
              postings: [
                { amountGross: -1000, account: { number: 6800 } },
                { amountGross: 1000, account: { number: 2400 } },
              ],
            },
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9102") {
          return jsonResponse(200, {
            value: {
              id: 9102,
              description: "Audit correction for voucher 5102: Reclassify to travel expense",
              postings: [
                { amountGross: 2000, account: { number: 7140 } },
                { amountGross: -2000, account: { number: 6100 } },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "ledger_error_correction" as TaskSpec["entity"],
          values: {},
          lookup: undefined,
        };

        const plan = await executeLedgerErrorCorrectionWorkflow(
          client,
          spec,
          "We have discovered errors in the general ledger for January and February 2026. Review all vouchers, find the 2 errors, and correct them. Log every change as audit note.",
          false,
          async () => ({
            issues: [
              {
                voucherId: 5101,
                confidence: 0.97,
                issueType: "duplicate_voucher",
                reason: "Duplicate voucher",
                action: "reverse_voucher",
                correctionDate: "2026-02-28",
              },
              {
                voucherId: 5102,
                confidence: 0.88,
                issueType: "wrong_account",
                reason: "Reclassify to travel expense",
                action: "post_adjustment",
                correctionDate: "2026-02-28",
                postings: [
                  { accountNumber: 7140, amount: 2000 },
                  { accountNumber: 6100, amount: -2000 },
                ],
              },
            ],
          }),
        );
        assert.equal(plan.steps.filter((step) => step.method === "PUT" && step.path === "/ledger/voucher/5101/:reverse").length, 1);
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 1);
        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
        assert.equal(calls.some((call) => call.method === "PUT" && call.path === "/ledger/voucher/5101/:reverse"), true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });

  gates.push({
    name: "executeLedgerErrorCorrectionWorkflow paginates vouchers and deterministically fixes explicit wrong-account hints",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ method: string; path: string; body?: any; query: Record<string, string> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const query = Object.fromEntries(url.searchParams.entries());
        calls.push({ method, path: url.pathname, body, query });

        if (method === "GET" && url.pathname === "/ledger/voucher" && query.from === "0") {
          return jsonResponse(200, {
            values: Array.from({ length: 200 }, (_, index) => ({
              id: 6000 + index,
              date: "2026-01-10",
              description: `Voucher ${index + 1}`,
              postings: [
                { row: 1, amountGross: 1500, account: { number: 6100, name: "Rent" } },
                { row: 2, amountGross: -1500, account: { number: 1920, name: "Bank" } },
              ],
            })),
          });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher" && query.from === "200") {
          return jsonResponse(200, {
            values: [
              {
                id: 6201,
                date: "2026-02-20",
                description: "Posted to wrong account",
                postings: [
                  { row: 1, amountGross: 3150, account: { number: 6540, name: "Inventory" } },
                  { row: 2, amountGross: -3150, account: { number: 1920, name: "Bank" } },
                ],
              },
            ],
          });
        }
        if (method === "GET" && url.pathname === "/ledger/account") {
          const number = Number(url.searchParams.get("number") ?? "0");
          return jsonResponse(200, { values: [{ id: number, number, name: `Account ${number}` }] });
        }
        if (method === "POST" && url.pathname === "/ledger/voucher") {
          return jsonResponse(200, { value: { id: 9201 } });
        }
        if (method === "GET" && url.pathname === "/ledger/voucher/9201") {
          return jsonResponse(200, {
            value: {
              id: 9201,
              description: "Audit correction for voucher 6201: Reclassify 3150 from 6540 to 6860",
              postings: [
                { amountGross: 3150, account: { number: 6860 } },
                { amountGross: -3150, account: { number: 6540 } },
              ],
            },
          });
        }
        return jsonResponse(404, { message: `${method} ${url.pathname} not mocked` });
      }) as typeof fetch;

      try {
        const client = new TripletexClient({
          baseUrl: "https://example.test",
          sessionToken: "token",
          timeoutMs: 1000,
        });
        const spec: TaskSpec = {
          operation: "create",
          entity: "ledger_error_correction" as TaskSpec["entity"],
          values: {},
          lookup: undefined,
        };

        const plan = await executeLedgerErrorCorrectionWorkflow(
          client,
          spec,
          "Wir haben Fehler im Hauptbuch für Januar und Februar 2026 entdeckt. Überprüfen Sie alle Belege und finden Sie den 1 Fehler: eine Buchung auf das falsche Konto (Konto 6540 statt 6860, Betrag 3150 NOK).",
          false,
          async () => ({ issues: [] }),
        );

        assert.equal(calls.filter((call) => call.method === "GET" && call.path === "/ledger/voucher").length, 2);
        assert.equal(plan.steps.filter((step) => step.method === "POST" && step.path === "/ledger/voucher").length, 1);
        const created = calls.find((call) => call.method === "POST" && call.path === "/ledger/voucher");
        assert.deepEqual(created?.body?.postings?.map((posting: any) => ({ id: posting.account?.id, amountGross: posting.amountGross })), [
          { id: 6860, amountGross: 3150 },
          { id: 6540, amountGross: -3150 },
        ]);

        const verification = await verifyOutcome(client, spec, null);
        assert.equal(verification.verified, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
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

  for (const scenario of TRIPLETEX_SCENARIO_MATRIX) {
    if (scenario.family !== "unknown") {
      gates.push({
        name: `detectFamily matches scenario ${scenario.id}`,
        run: () => {
          assert.equal(detectFamily(scenario.prompt), scenario.family);
        },
      });
    }
    gates.push({
      name: `semantic routing matches scenario ${scenario.id}`,
      run: () => {
        const payload = {
          prompt: scenario.prompt,
          files: [],
          attachment_facts: scenario.attachmentFacts ?? [],
          tripletex_credentials: { base_url: "https://example.test/v2", session_token: "gate-token" },
        };
        const summaries = (scenario.attachmentFacts ?? []).length > 0
          ? [
              {
                filename: `${scenario.id}.txt`,
                mimeType: "text/plain",
                sizeBytes: 0,
                textExcerpt: (scenario.attachmentFacts ?? []).join("\n"),
                extractionSource: "text" as const,
              },
            ]
          : [];
        const extracted = heuristicExtract({
          ...payload,
        }, summaries);
        const normalized = normalizeTaskSpec(payload, extracted);
        assert.equal(normalized.entity, scenario.expected.entity);
        assert.equal(normalized.operation, scenario.expected.operation);
      },
    });
  }

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
