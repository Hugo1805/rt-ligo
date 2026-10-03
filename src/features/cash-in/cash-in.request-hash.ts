import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";

export type RequestHashInput = {
  user_id: string;
  amount: number | string | Prisma.Decimal;
  currency: string;
  payment_method: string;
};

const CANONICAL_KEYS: (keyof RequestHashInput)[] = [
  "amount",
  "currency",
  "payment_method",
  "user_id",
];

export function computeRequestHash(input: RequestHashInput): string {
  const normalizedAmount = new Prisma.Decimal(input.amount).toFixed(2);
  const canonical = {
    amount: normalizedAmount,
    currency: input.currency,
    payment_method: input.payment_method,
    user_id: input.user_id,
  };

  const json = JSON.stringify(canonical, CANONICAL_KEYS);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
