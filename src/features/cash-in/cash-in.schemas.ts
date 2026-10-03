import type { Hook } from "@hono/zod-validator";
import { z } from "zod";
import { AppError } from "../../shared/errors";

export const idempotencyKeySchema = z.uuid({
  error: (issue) =>
    issue.input === undefined
      ? "IDEMPOTENCY_KEY_MISSING"
      : "IDEMPOTENCY_KEY_INVALID",
});

export const cashInHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema,
});

export const createCashInRequestSchema = (maxAmount: number) =>
  z
    .object({
      user_id: z.string().trim().min(1).max(64),
      amount: z
        .number()
        .positive()
        .max(maxAmount)
        .refine(
          (v) => /^\d+(\.\d{1,2})?$/.test(String(v)),
          "Máximo 2 decimales"
        ),
      currency: z.literal("PEN", { error: "Solo se acepta PEN" }),
      payment_method: z.string().trim().min(1).max(64),
    })
    .strict();

export type CashInRequest = z.infer<ReturnType<typeof createCashInRequestSchema>>;
export type CashInHeaders = z.infer<typeof cashInHeadersSchema>;

export const idempotencyHeaderHook: Hook<any, any, any> = (result) => {
  if (!result.success) {
    const keyIssue =
      result.error.issues.find((issue) =>
        issue.path.includes("idempotency-key")
      ) ?? result.error.issues[0];

    const code =
      keyIssue?.message === "IDEMPOTENCY_KEY_MISSING"
        ? "IDEMPOTENCY_KEY_MISSING"
        : "IDEMPOTENCY_KEY_INVALID";

    throw new AppError(code, { errors: [] });
  }
};
