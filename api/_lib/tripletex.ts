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
  onEvent?: (event: TripletexCallLogEvent) => void;
  logPayloads?: boolean;
  maxLogChars?: number;
};

export type TripletexCallLogEvent = {
  kind: "request" | "response" | "network_error";
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  attempt?: number;
  maxAttempts?: number;
  query?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  statusCode?: number;
  ok?: boolean;
  durationMs?: number;
  error?: string;
};

export class TripletexClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly onEvent?: (event: TripletexCallLogEvent) => void;
  private readonly logPayloads: boolean;
  private readonly maxLogChars: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;

  constructor(config: TripletexClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`0:${config.sessionToken}`).toString("base64")}`;
    this.timeoutMs = config.timeoutMs;
    this.onEvent = config.onEvent;
    this.logPayloads = config.logPayloads ?? false;
    this.maxLogChars = Math.max(120, config.maxLogChars ?? 500);
    this.maxAttempts = Math.max(1, Number(process.env.TRIPLETEX_HTTP_MAX_ATTEMPTS || "3"));
    this.retryBackoffMs = Math.max(50, Number(process.env.TRIPLETEX_HTTP_RETRY_BACKOFF_MS || "250"));
  }

  private emit(event: TripletexCallLogEvent): void {
    if (!this.onEvent) return;
    this.onEvent(event);
  }

  private summarizeForLog(value: unknown, depth = 0): unknown {
    if (value === undefined || value === null) return value;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (this.logPayloads) return value.slice(0, this.maxLogChars);
      return { type: "string", length: value.length };
    }

    if (Array.isArray(value)) {
      if (depth >= 1) return { type: "array", length: value.length };
      if (this.logPayloads) {
        return {
          type: "array",
          length: value.length,
          preview: value.slice(0, 3).map((item) => this.summarizeForLog(item, depth + 1)),
        };
      }
      return { type: "array", length: value.length };
    }

    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object);
      if (!this.logPayloads || depth >= 1) return { type: "object", keys: keys.slice(0, 24) };
      const preview: Record<string, unknown> = {};
      for (const key of keys.slice(0, 12)) {
        preview[key] = this.summarizeForLog(object[key], depth + 1);
      }
      return {
        type: "object",
        keys: keys.slice(0, 24),
        preview,
      };
    }

    return String(value).slice(0, this.maxLogChars);
  }

  private serializeQuery(url: URL): Record<string, string> {
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }
    return query;
  }

  private shouldRetryStatus(statusCode: number): boolean {
    if (statusCode >= 500) return true;
    return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429;
  }

  private retryDelayMs(attempt: number): number {
    const exponential = this.retryBackoffMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(4_000, exponential);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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
    const startedAt = Date.now();
    this.emit({
      kind: "request",
      method,
      path: normalizedPath,
      maxAttempts: this.maxAttempts,
      query: this.serializeQuery(url),
      requestBody: this.summarizeForLog(options.body),
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
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
        this.emit({
          kind: "network_error",
          method,
          path: normalizedPath,
          attempt,
          maxAttempts: this.maxAttempts,
          query: this.serializeQuery(url),
          durationMs: Date.now() - startedAt,
          error: String(error),
        });
        if (attempt < this.maxAttempts) {
          await this.sleep(this.retryDelayMs(attempt));
          continue;
        }
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
      this.emit({
        kind: "response",
        method,
        path: normalizedPath,
        attempt,
        maxAttempts: this.maxAttempts,
        query: this.serializeQuery(url),
        statusCode: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
        responseBody: this.summarizeForLog(parsed),
      });

      if (response.ok) {
        return parsed;
      }
      if (attempt < this.maxAttempts && this.shouldRetryStatus(response.status)) {
        await this.sleep(this.retryDelayMs(attempt));
        continue;
      }
      throw new TripletexError("Tripletex API request failed", {
        statusCode: response.status,
        endpoint: `${method} ${normalizedPath}`,
        responseBody: parsed,
      });
    }

    throw new TripletexError("Tripletex API request failed", {
      endpoint: `${method} ${normalizedPath}`,
    });
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
