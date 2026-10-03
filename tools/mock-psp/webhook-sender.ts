import { createHmac } from "node:crypto";
import type { Logger } from "pino";

export interface MockWebhookData {
  charge_id: string;
  reference: string;
  amount: number;
  currency: string;
  failure_code: string | null;
}

export interface MockWebhookPayload {
  event_id: string;
  type: string;
  created_at: string;
  data: MockWebhookData;
}

export interface SendWebhookOptions {
  url: string;
  secret: string;
  payload: MockWebhookPayload;
  maxRetries?: number | undefined;
  retryDelayMs?: number | undefined;
  logger?: Logger | undefined;
  fetchFn?: typeof fetch | undefined;
}

export function signPayload(
  secret: string,
  timestamp: number,
  rawBody: string
): string {
  const hmac = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  return `t=${timestamp},v1=${hmac}`;
}

export async function sendWebhook(
  options: SendWebhookOptions
): Promise<boolean> {
  const {
    url,
    secret,
    payload,
    maxRetries = 3,
    retryDelayMs = 100,
    logger,
    fetchFn = fetch,
  } = options;

  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureHeader = signPayload(secret, timestamp, rawBody);

  const totalAttempts = 1 + maxRetries;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      logger?.info(
        {
          attempt,
          eventId: payload.event_id,
          reference: payload.data.reference,
          url,
        },
        "Sending webhook"
      );

      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Provider-Signature": signatureHeader,
        },
        body: rawBody,
      });

      if (response.ok) {
        logger?.info(
          {
            attempt,
            eventId: payload.event_id,
            status: response.status,
          },
          "Webhook delivered successfully"
        );
        return true;
      }

      logger?.warn(
        {
          attempt,
          eventId: payload.event_id,
          status: response.status,
        },
        "Webhook response not 2xx"
      );
    } catch (err) {
      logger?.warn(
        {
          err,
          attempt,
          eventId: payload.event_id,
        },
        "Webhook delivery failed with network error"
      );
    }

    if (attempt < totalAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  logger?.error(
    {
      eventId: payload.event_id,
      attempts: totalAttempts,
    },
    "Webhook delivery exhausted retries"
  );
  return false;
}
