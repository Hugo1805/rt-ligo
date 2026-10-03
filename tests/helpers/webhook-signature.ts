import type { Hono } from "hono";
import type { AppEnv } from "../../src/infra/correlation";
import { signWebhookPayload } from "../../src/features/webhooks/webhooks.signature";

export function signWebhook(rawBody: string, secret: string, t?: number): string {
  const timestamp = t ?? Math.floor(Date.now() / 1000);
  return signWebhookPayload({
    secret,
    timestamp,
    rawBody,
  });
}

export interface PostWebhookOptions {
  signature?: string;
  secret?: string;
  timestamp?: number;
  headers?: Record<string, string>;
}

export async function postWebhook(
  app: Hono<AppEnv>,
  rawBody: string,
  options: PostWebhookOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (options.signature !== undefined) {
    headers["X-Provider-Signature"] = options.signature;
  } else if (options.secret !== undefined) {
    headers["X-Provider-Signature"] = signWebhook(rawBody, options.secret, options.timestamp);
  }

  return app.request("/webhooks/payment", {
    method: "POST",
    headers,
    body: rawBody,
  });
}
