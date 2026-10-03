import type { Hono } from "hono";
import type { AppEnv } from "../../src/infra/correlation";

export interface PostCashInOptions {
  key?: string;
  requestId?: string;
  headers?: Record<string, string>;
}

export function postCashIn(
  app: Hono<AppEnv>,
  body: unknown,
  options?: PostCashInOptions
): Promise<Response>;
export function postCashIn(
  baseUrl: string,
  key: string,
  body: unknown,
  options?: PostCashInOptions
): Promise<Response>;
export async function postCashIn(
  target: Hono<AppEnv> | string,
  arg2: unknown,
  arg3?: unknown,
  arg4?: PostCashInOptions
): Promise<Response> {
  if (typeof target === "string") {
    const key = arg2 as string;
    const body = arg3;
    const options = arg4 ?? {};
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(options.requestId ? { "X-Request-Id": options.requestId } : {}),
      ...options.headers,
    };
    const url = target.endsWith("/cash-in")
      ? target
      : `${target.replace(/\/$/, "")}/cash-in`;

    return fetch(url, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const body = arg2;
  const options = (arg3 as PostCashInOptions) ?? {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
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

  return target.request("/cash-in", init);
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number = 10000,
  intervalMs: number = 200
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fn();
      if (res !== null && res !== undefined && res !== false) {
        return res;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  try {
    const lastRes = await fn();
    if (lastRes !== null && lastRes !== undefined && lastRes !== false) {
      return lastRes;
    }
  } catch (err) {
    lastError = err;
  }

  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastError ? `: ${String(lastError)}` : ""
    }`
  );
}

