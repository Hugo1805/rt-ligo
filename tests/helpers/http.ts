import type { Hono } from "hono";
import type { AppEnv } from "../../src/infra/correlation";

export interface PostCashInOptions {
  key?: string;
  requestId?: string;
}

export async function postCashIn(
  app: Hono<AppEnv>,
  body: unknown,
  options: PostCashInOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.key !== undefined) {
    headers["Idempotency-Key"] = options.key;
  }

  if (options.requestId !== undefined) {
    headers["X-Request-Id"] = options.requestId;
  }

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return app.request("/cash-in", init);
}
