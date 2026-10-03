import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { MockConfig } from "./config";
import { sendWebhook } from "./webhook-sender";

export type MockCharge =
  | { status: "succeeded"; charge_id: string }
  | { status: "declined"; charge_id: string; failure_code: string };

export const createChargeBodySchema = z.object({
  reference: z.string().trim().min(1),
  amount: z.union([
    z.string().trim().min(1),
    z.number(),
  ]),
  currency: z.string().trim().min(1),
  payment_method: z.string().trim().min(1),
});

export type CreateChargeBody = z.infer<typeof createChargeBodySchema>;

export interface MockPspAppDeps {
  config: MockConfig;
  logger?: Logger | undefined;
  webhookSender?: typeof sendWebhook | undefined;
}

export function createMockPspApp(deps: MockPspAppDeps) {
  const { config, logger, webhookSender = sendWebhook } = deps;
  const app = new Hono();

  const charges = new Map<string, MockCharge>();
  const attempts = new Map<string, number>();
  const flakyFailed = new Set<string>();
  const inFlightWebhooks: Promise<boolean>[] = [];

  function generateChargeId(): string {
    return `ch_${randomUUID().replace(/-/g, "")}`;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  app.get("/health", (c) => {
    return c.json({ status: "ok" }, 200);
  });

  app.post("/charges", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = createChargeBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", issues: parsed.error.issues },
        400
      );
    }

    const { reference, amount, currency, payment_method } = parsed.data;

    const currentAttempts = (attempts.get(reference) ?? 0) + 1;
    attempts.set(reference, currentAttempts);

    // Idempotency: return existing charge if already recorded
    const existing = charges.get(reference);
    if (existing) {
      return c.json(existing, 200);
    }

    if (payment_method === "card_declined") {
      const charge: MockCharge = {
        status: "declined",
        charge_id: generateChargeId(),
        failure_code: "insufficient_funds",
      };
      charges.set(reference, charge);
      return c.json(charge, 200);
    }

    if (payment_method === "card_flaky") {
      if (!flakyFailed.has(reference)) {
        flakyFailed.add(reference);
        return c.json({ error: "Service Unavailable" }, 503);
      }
      // Second attempt with card_flaky succeeds
      const charge: MockCharge = {
        status: "succeeded",
        charge_id: generateChargeId(),
      };
      charges.set(reference, charge);
      return c.json(charge, 200);
    }

    if (payment_method === "card_timeout") {
      const charge: MockCharge = {
        status: "succeeded",
        charge_id: generateChargeId(),
      };
      // Register charge BEFORE sleeping so GET /charges/:reference sees it
      charges.set(reference, charge);

      const parsedAmount =
        typeof amount === "number" ? amount : Number(amount);

      const webhookPromise = (async () => {
        if (config.MOCK_PSP_WEBHOOK_DELAY_MS > 0) {
          await sleep(config.MOCK_PSP_WEBHOOK_DELAY_MS);
        }
        return webhookSender({
          url: config.MOCK_PSP_WEBHOOK_URL,
          secret: config.WEBHOOK_SECRET,
          payload: {
            event_id: `evt_${randomUUID().replace(/-/g, "")}`,
            type: "charge.succeeded",
            created_at: new Date().toISOString(),
            data: {
              charge_id: charge.charge_id,
              reference,
              amount: parsedAmount,
              currency,
              failure_code: null,
            },
          },
          logger,
        });
      })();

      inFlightWebhooks.push(webhookPromise);

      if (config.MOCK_PSP_TIMEOUT_DELAY_MS > 0) {
        await sleep(config.MOCK_PSP_TIMEOUT_DELAY_MS);
      }

      return c.json(charge, 200);
    }

    // Default: card_ok or any other payment method
    const charge: MockCharge = {
      status: "succeeded",
      charge_id: generateChargeId(),
    };
    charges.set(reference, charge);
    return c.json(charge, 200);
  });

  app.get("/charges/:reference", (c) => {
    const reference = c.req.param("reference");
    const charge = charges.get(reference);
    if (!charge) {
      return c.json({ error: "Charge not found" }, 404);
    }
    return c.json(charge, 200);
  });

  app.get("/__admin/charges/:reference", (c) => {
    const reference = c.req.param("reference");
    const charge = charges.get(reference) ?? null;
    const count = attempts.get(reference) ?? 0;
    return c.json({ charge, attempts: count }, 200);
  });

  return Object.assign(app, {
    charges,
    attempts,
    inFlightWebhooks,
  });
}
