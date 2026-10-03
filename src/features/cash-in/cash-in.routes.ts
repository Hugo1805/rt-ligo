import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { Prisma } from "../../generated/prisma/client";
import type { AppEnv } from "../../infra/correlation";
import type { Config } from "../../infra/config";
import { AppError } from "../../shared/errors";
import { validationHook } from "../../shared/validation";
import {
  cashInHeadersSchema,
  createCashInRequestSchema,
  idempotencyHeaderHook,
} from "./cash-in.schemas";
import type { CashInService } from "./cash-in.service";

export function createCashInRoutes(
  service: CashInService,
  config: Pick<Config, "CASH_IN_MAX_AMOUNT">
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const cashInRequestSchema = createCashInRequestSchema(config.CASH_IN_MAX_AMOUNT);

  router.post(
    "/cash-in",
    zValidator("header", cashInHeadersSchema, idempotencyHeaderHook),
    zValidator("json", cashInRequestSchema, validationHook),
    async (c) => {
      const headers = c.req.valid("header");
      const idempotencyKey = headers["idempotency-key"];
      const body = c.req.valid("json");

      const result = await service.cashIn(
        { idempotencyKey, body },
        { requestId: c.var.requestId, logger: c.var.logger }
      );

      if (result.replayed) {
        c.header("Idempotent-Replayed", "true");
      }

      if (result.operation.status === "FAILED") {
        throw new AppError("PAYMENT_DECLINED", {
          operationId: result.operation.id,
        });
      }

      if (result.operation.status === "COMPLETED") {
        return c.json(
          {
            operation_id: result.operation.id,
            status: "completed",
            amount: Number(result.operation.amount.toFixed(2)),
            new_balance: Number(
              (result.operation.balanceAfter ?? new Prisma.Decimal(0)).toFixed(2)
            ),
          },
          200
        );
      }

      return c.json(
        {
          operation_id: result.operation.id,
          status: result.operation.status.toLowerCase(),
          amount: Number(result.operation.amount.toFixed(2)),
        },
        202
      );
    }
  );

  return router;
}
