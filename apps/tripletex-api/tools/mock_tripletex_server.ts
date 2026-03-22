import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

type Entity = Record<string, unknown> & { id: number };

type Store = {
  customer: Entity[];
  employee: Entity[];
  product: Entity[];
  department: Entity[];
  order: Entity[];
  invoice: Entity[];
  project: Entity[];
  travelExpense: Entity[];
  ledgerVoucher: Entity[];
};

const port = Number(process.env.TRIPLETEX_MOCK_PORT || "8787");
const prefix = "/v2";

const store: Store = {
  customer: [],
  employee: [],
  product: [],
  department: [],
  order: [],
  invoice: [],
  project: [],
  travelExpense: [],
  ledgerVoucher: [],
};

const counters: Record<string, number> = {
  customer: 1000,
  employee: 2000,
  product: 3000,
  department: 4000,
  order: 5000,
  invoice: 6000,
  project: 7000,
  travelExpense: 8000,
  ledgerVoucher: 9000,
};

function nextId(entity: keyof Store): number {
  counters[entity] += 1;
  return counters[entity];
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function listResponse(values: Entity[]): Record<string, unknown> {
  return { fullResultSize: values.length, from: 0, count: values.length, values };
}

function entityName(entity: Entity): string {
  if (typeof entity.name === "string") return entity.name;
  const first = typeof entity.firstName === "string" ? entity.firstName : "";
  const last = typeof entity.lastName === "string" ? entity.lastName : "";
  return `${first} ${last}`.trim();
}

function matchByQuery(row: Entity, query: URLSearchParams): boolean {
  const count = query.get("count");
  if (count) {
    // ignored; pagination not needed for local flow tests
  }
  const name = query.get("name");
  if (name && !entityName(row).toLowerCase().includes(name.toLowerCase())) return false;
  const email = query.get("email");
  if (email && String(row.email ?? "").toLowerCase() !== email.toLowerCase()) return false;
  const org = query.get("organizationNumber");
  if (org && String(row.organizationNumber ?? "") !== org) return false;
  const firstName = query.get("firstName");
  if (firstName && String(row.firstName ?? "").toLowerCase() !== firstName.toLowerCase()) return false;
  const lastName = query.get("lastName");
  if (lastName && String(row.lastName ?? "").toLowerCase() !== lastName.toLowerCase()) return false;
  return true;
}

function withId(body: Record<string, unknown>, id: number): Entity {
  return { ...body, id };
}

function resolveCollection(path: string): keyof Store | null {
  if (path === "/customer") return "customer";
  if (path === "/employee") return "employee";
  if (path === "/product") return "product";
  if (path === "/department") return "department";
  if (path === "/order") return "order";
  if (path === "/invoice") return "invoice";
  if (path === "/project") return "project";
  if (path === "/travelExpense") return "travelExpense";
  if (path === "/ledger/voucher") return "ledgerVoucher";
  return null;
}

function parseIdPath(path: string): { collection: keyof Store; id: number } | null {
  const patterns: Array<{ regex: RegExp; collection: keyof Store }> = [
    { regex: /^\/customer\/(\d+)$/, collection: "customer" },
    { regex: /^\/employee\/(\d+)$/, collection: "employee" },
    { regex: /^\/travelExpense\/(\d+)$/, collection: "travelExpense" },
    { regex: /^\/ledger\/voucher\/(\d+)$/, collection: "ledgerVoucher" },
  ];
  for (const pattern of patterns) {
    const match = path.match(pattern.regex);
    if (match?.[1]) return { collection: pattern.collection, id: Number(match[1]) };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const rawUrl = req.url || "/";
  const url = new URL(rawUrl, `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", service: "tripletex-mock" });
    return;
  }
  if (!url.pathname.startsWith(prefix)) {
    sendJson(res, 404, { status: 404, message: "Use /v2/* paths" });
    return;
  }
  const path = url.pathname.slice(prefix.length) || "/";

  if (method === "GET" && path === "/travelExpense/paymentType") {
    sendJson(res, 200, { values: [{ id: 1, description: "Privat utlegg" }] });
    return;
  }
  if (method === "GET" && path === "/invoice/paymentType") {
    sendJson(res, 200, { values: [{ id: 1, description: "Bank transfer" }] });
    return;
  }
  if (method === "GET" && (path === "/ledger/account" || path === "/ledger/posting")) {
    sendJson(res, 200, { values: [] });
    return;
  }
  if ((method === "PUT" || method === "POST") && /^\/invoice\/\d+\/:payment$/.test(path)) {
    sendJson(res, 200, { value: { id: Number(path.split("/")[2]), paid: true } });
    return;
  }
  if ((method === "PUT" || method === "POST") && /^\/invoice\/\d+\/:createCreditNote$/.test(path)) {
    sendJson(res, 200, { value: { id: 61001, sourceInvoiceId: Number(path.split("/")[2]) } });
    return;
  }
  if ((method === "PUT" || method === "POST") && /^\/order\/\d+\/:invoice$/.test(path)) {
    const invoiceId = nextId("invoice");
    store.invoice.push({ id: invoiceId, orders: [{ id: Number(path.split("/")[2]) }] });
    sendJson(res, 200, { value: { id: invoiceId } });
    return;
  }
  if ((method === "PUT" || method === "POST") && /^\/ledger\/voucher\/\d+\/:reverse$/.test(path)) {
    sendJson(res, 200, { value: { id: Number(path.split("/")[3]), reversed: true } });
    return;
  }

  const collection = resolveCollection(path);
  if (collection && method === "GET") {
    const filtered = store[collection].filter((row) => matchByQuery(row, url.searchParams));
    const countRaw = Number(url.searchParams.get("count") || filtered.length);
    const count = Number.isFinite(countRaw) ? Math.max(0, Math.min(filtered.length, countRaw)) : filtered.length;
    sendJson(res, 200, listResponse(filtered.slice(0, count)));
    return;
  }
  if (collection && method === "POST") {
    const body = await readJson(req);
    const id = nextId(collection);
    const row = withId(body, id);
    store[collection].push(row);
    sendJson(res, 201, { value: row });
    return;
  }

  const idPath = parseIdPath(path);
  if (idPath && method === "GET") {
    const found = store[idPath.collection].find((row) => row.id === idPath.id);
    if (!found) {
      sendJson(res, 404, { status: 404, message: "Not found" });
      return;
    }
    sendJson(res, 200, { value: found });
    return;
  }
  if (idPath && method === "PUT") {
    const body = await readJson(req);
    const index = store[idPath.collection].findIndex((row) => row.id === idPath.id);
    if (index < 0) {
      sendJson(res, 404, { status: 404, message: "Not found" });
      return;
    }
    const updated = { ...store[idPath.collection][index], ...body, id: idPath.id };
    store[idPath.collection][index] = updated;
    sendJson(res, 200, { value: updated });
    return;
  }
  if (idPath && method === "DELETE") {
    const index = store[idPath.collection].findIndex((row) => row.id === idPath.id);
    if (index < 0) {
      sendJson(res, 404, { status: 404, message: "Not found" });
      return;
    }
    store[idPath.collection].splice(index, 1);
    sendJson(res, 200, { status: "deleted", id: idPath.id });
    return;
  }

  sendJson(res, 404, { status: 404, message: `Unhandled mock route: ${method} ${path}` });
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      status: "tripletex-mock-ready",
      base_url: `http://127.0.0.1:${port}${prefix}`,
      health: `http://127.0.0.1:${port}/health`,
    }),
  );
});
