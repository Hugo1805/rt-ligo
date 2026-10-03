import { Hono } from "hono";
import type { AppEnv } from "../../infra/correlation";
import type { Config } from "../../infra/config";
import { AppError } from "../../shared/errors";
import { issuesToFieldErrors } from "../../shared/validation";
import { verifyWebhookSignature } from "./webhooks.signature";
import { webhookEventSchema } from "./webhooks.schemas";
import type { WebhooksService } from "./webhooks.service";

export interface WebhooksRoutesDeps {
  config: Pick<Config, "WEBHOOK_SECRET" | "WEBHOOK_TOLERANCE_S">;
  webhooksService: WebhooksService;
  now?: (() => number) | undefined;
}

export function webhooksRoutes(deps: WebhooksRoutesDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/payment", async (c) => {
    const raw = await c.req.text();

    const isValid = verifyWebhookSignature({
      header: c.req.header("X-Provider-Signature"),
      rawBody: raw,
      secret: deps.config.WEBHOOK_SECRET,
      toleranceS: deps.config.WEBHOOK_TOLERANCE_S,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });

    if (!isValid) {
      throw new AppError("WEBHOOK_SIGNATURE_INVALID");
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AppError("VALIDATION_ERROR");
    }

    const result = webhookEventSchema.safeParse(json);
    if (!result.success) {
      const errors = issuesToFieldErrors(result.error.issues);
      throw new AppError("VALIDATION_ERROR", { errors });
    }

    const { duplicate } = await deps.webhooksService.processWebhookEvent(
      result.data,
      c.var.logger
    );

    return c.json({ received: true, duplicate }, 200);
  });

  return router;
}

export const createWebhooksRoutes = webhooksRoutes;
