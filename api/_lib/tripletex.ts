export class TripletexError extends Error {
  readonly statusCode?: number;
  readonly endpoint: string;
  readonly responseBody?: unknown;

  constructor(message: string, opts: { statusCode?: number; endpoint: string; responseBody?: unknown }) {
    super(message);
    this.name = "TripletexError";
    this.statusCode = opts.statusCode;
    this.endpoint = opts.endpoint;
    this.responseBody = opts.responseBody;
  }
}

export type TripletexClientConfig = {
  baseUrl: string;
  sessionToken: string;
  timeoutMs: number;
};

export class TripletexClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(config: TripletexClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`0:${config.sessionToken}`).toString("base64")}`;
    this.timeoutMs = config.timeoutMs;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { params?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          accept: "application/json",
          authorization: this.authHeader,
          "content-type": "application/json",
          "user-agent": "tripletex-vercel-agent/0.1",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new TripletexError(`Tripletex network failure: ${String(error)}`, {
        endpoint: `${method} ${normalizedPath}`,
      });
    }
    clearTimeout(timeout);

    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!response.ok) {
      throw new TripletexError("Tripletex API request failed", {
        statusCode: response.status,
        endpoint: `${method} ${normalizedPath}`,
        responseBody: parsed,
      });
    }
    return parsed;
  }
}

export function dig(value: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      const idx = Number(part);
      current = current[idx];
      continue;
    }
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

export function primaryValue(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const object = response as Record<string, unknown>;
  if (object.value !== undefined) return object.value;
  if (Array.isArray(object.values) && object.values.length > 0) return object.values[0];
  return response;
}

