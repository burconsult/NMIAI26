import assert from "node:assert/strict";
import http from "node:http";

import { executePlan } from "../api/_lib/planner.ts";
import { compilePlan, type TaskSpec } from "../api/_lib/task_spec.ts";
import { TripletexClient } from "../api/_lib/tripletex.ts";

type Entity = Record<string, unknown> & { id: number };

type Store = {
  customer: Entity[];
  product: Entity[];
  order: Entity[];
  invoice: Entity[];
  employee: Entity[];
  department: Entity[];
  project: Entity[];
  travelExpense: Entity[];
  voucher: Entity[];
};

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function listResponse(values: Entity[]): { values: Entity[] } {
  return { values };
}

function createMockServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const store: Store = {
    customer: [],
    product: [],
    order: [],
    invoice: [],
    employee: [],
    department: [],
    project: [],
    travelExpense: [],
    voucher: [],
  };
  let seq = 1000;
  const nextId = (): number => {
    seq += 1;
    return seq;
  };

  const server = http.createServer(async (req, res) => {
    const method = req.method?.toUpperCase() ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/v2/, "");
    const body = (await readBody(req)) as Record<string, unknown> | undefined;

    if (method === "GET" && path === "/health") return json(res, 200, { status: "ok" });

    if (method === "GET" && path === "/customer") {
      const name = url.searchParams.get("name");
      const values = name ? store.customer.filter((c) => String(c.name ?? "") === name) : store.customer;
      return json(res, 200, listResponse(values));
    }
    if (method === "POST" && path === "/customer") {
      if (!body?.name) return json(res, 422, { validationMessages: [{ field: "name", message: "Required" }] });
      const value = { id: nextId(), ...body };
      store.customer.push(value);
      return json(res, 201, { value });
    }

    if (method === "GET" && path === "/product") {
      const name = url.searchParams.get("name");
      const values = name ? store.product.filter((p) => String(p.name ?? "") === name) : store.product;
      return json(res, 200, listResponse(values));
    }
    if (method === "POST" && path === "/product") {
      if (!body?.name) return json(res, 422, { validationMessages: [{ field: "name", message: "Required" }] });
      const value = { id: nextId(), ...body };
      store.product.push(value);
      return json(res, 201, { value });
    }

    if (method === "POST" && path === "/order") {
      const customerId = Number((body?.customer as Record<string, unknown> | undefined)?.id);
      if (!customerId) return json(res, 422, { validationMessages: [{ field: "customer.id", message: "Required" }] });
      const customer = store.customer.find((item) => item.id === customerId);
      const preliminaryInvoice = { id: nextId() };
      const value = { id: nextId(), ...body, customer: customer ?? body?.customer, preliminaryInvoice };
      store.order.push(value);
      return json(res, 201, { value });
    }
    if (method === "PUT" && path === "/order/:invoiceMultipleOrders") {
      const orderId = Number(url.searchParams.get("id"));
      const order = store.order.find((item) => item.id === orderId);
      if (!order) return json(res, 404, { status: 404, message: "Order not found" });
      let invoice = store.invoice.find((item) => item.id === Number((order.preliminaryInvoice as Record<string, unknown> | undefined)?.id));
      if (!invoice) {
        invoice = {
          id: Number((order.preliminaryInvoice as Record<string, unknown> | undefined)?.id) || nextId(),
          customer: order.customer,
          invoiceDate: url.searchParams.get("invoiceDate") ?? (order.orderDate as string | undefined) ?? "2026-03-20",
          orderLines: Array.isArray(order.orderLines) ? order.orderLines : [],
          orders: [{ id: order.id }],
          isCharged: true,
          isApproved: true,
        };
        store.invoice.push(invoice);
      }
      return json(res, 200, { value: invoice });
    }
    if (method === "GET" && path === "/order") return json(res, 200, listResponse(store.order));
    if (method === "GET" && path.startsWith("/order/")) {
      const id = Number(path.split("/").pop());
      const value = store.order.find((item) => item.id === id);
      return value ? json(res, 200, { value }) : json(res, 404, { status: 404, message: "Not found" });
    }

    if (method === "POST" && path === "/invoice") {
      const customerId = Number((body?.customer as Record<string, unknown> | undefined)?.id);
      const orderId = Number(((body?.orders as Array<Record<string, unknown>> | undefined)?.[0] ?? {}).id);
      if (!customerId || !orderId) {
        return json(res, 422, { validationMessages: [{ field: "orders", message: "Required" }] });
      }
      const value = { id: nextId(), ...body };
      store.invoice.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/invoice") return json(res, 200, listResponse(store.invoice));
    if (method === "GET" && path.startsWith("/invoice/")) {
      const id = Number(path.split("/").pop());
      const value = store.invoice.find((item) => item.id === id);
      return value ? json(res, 200, { value }) : json(res, 404, { status: 404, message: "Not found" });
    }

    if (method === "POST" && path === "/employee") {
      const value = { id: nextId(), ...body };
      store.employee.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/employee") return json(res, 200, listResponse(store.employee));

    if (method === "POST" && path === "/department") {
      const value = { id: nextId(), ...body };
      store.department.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/department") return json(res, 200, listResponse(store.department));

    if (method === "POST" && path === "/project") {
      const value = { id: nextId(), ...body };
      store.project.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/project") return json(res, 200, listResponse(store.project));

    if (method === "POST" && path === "/travelExpense") {
      const value = { id: nextId(), ...body };
      store.travelExpense.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/travelExpense") return json(res, 200, listResponse(store.travelExpense));

    if (method === "POST" && path === "/ledger/voucher") {
      const value = { id: nextId(), ...body };
      store.voucher.push(value);
      return json(res, 201, { value });
    }
    if (method === "GET" && path === "/ledger/voucher") return json(res, 200, listResponse(store.voucher));

    return json(res, 404, { status: 404, message: `No mock route for ${method} ${path}` });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not bind mock server"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v2`,
        close: async () => {
          await new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())));
        },
      });
    });
  });
}

async function run(): Promise<void> {
  const mock = await createMockServer();
  const client = new TripletexClient({
    baseUrl: mock.baseUrl,
    sessionToken: "mock-token",
    timeoutMs: 5000,
  });

  try {
    const tasks: TaskSpec[] = [
      {
        operation: "create",
        entity: "customer",
        values: { name: "Acme AS", email: "post@acme.no" },
        lookup: undefined,
        attachment_facts: undefined,
      },
      {
        operation: "create",
        entity: "invoice",
        values: { customerName: "Acme AS", invoiceDate: "2026-03-20", invoiceDueDate: "2026-03-27", amount: 1200 },
        lookup: undefined,
        attachment_facts: undefined,
      },
    ];

    for (const task of tasks) {
      const plan = compilePlan(task);
      await executePlan(client, plan, false);
    }

    const customers = (await client.request("GET", "/customer", { params: { count: 50 } })) as Record<string, unknown>;
    const invoices = (await client.request("GET", "/invoice", { params: { count: 50 } })) as Record<string, unknown>;
    assert((customers.values as unknown[]).length >= 1, "expected at least one customer in mock");
    assert((invoices.values as unknown[]).length >= 1, "expected at least one invoice in mock");
    console.log("Mock smoke passed: offline Tripletex flow is working.");
    console.log(`Mock base URL: ${mock.baseUrl}`);
  } finally {
    await mock.close();
  }
}

await run();
