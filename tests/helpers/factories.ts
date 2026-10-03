import crypto from "node:crypto";
import { Prisma } from "../../src/generated/prisma/client";
import type { OperationStatus } from "../../src/generated/prisma/enums";
import type { DbClient } from "../../src/infra/prisma";
import { newOperationId } from "../../src/features/cash-in/cash-in.repository";

export function uniqueUserId(): string {
  return `usr_t_${crypto.randomUUID().replaceAll("-", "")}`;
}

export interface CreateWalletOverrides {
  userId?: string;
  currency?: string;
  balance?: Prisma.Decimal | string | number;
}

export async function createWallet(
  prisma: DbClient,
  overrides?: CreateWalletOverrides
) {
  const userId = overrides?.userId ?? uniqueUserId();
  const currency = overrides?.currency ?? "PEN";
  const balance =
    overrides?.balance instanceof Prisma.Decimal
      ? overrides.balance
      : new Prisma.Decimal(overrides?.balance ?? "0.00");

  return prisma.wallet.create({
    data: {
      userId,
      currency,
      balance,
    },
  });
}

export interface CreateOperationOverrides {
  id?: string;
  userId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  amount?: Prisma.Decimal | string | number;
  currency?: string;
  paymentMethod?: string;
  status?: OperationStatus;
  providerChargeId?: string | null;
  failureCode?: string | null;
  lastError?: string | null;
  reconcileAttempts?: number;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  completedAt?: Date | null;
  updatedAt?: Date;
}

export async function createOperation(
  prisma: DbClient,
  overrides?: CreateOperationOverrides
) {
  const id = overrides?.id ?? newOperationId();
  const userId = overrides?.userId ?? uniqueUserId();
  const idempotencyKey = overrides?.idempotencyKey ?? crypto.randomUUID();
  const requestHash = overrides?.requestHash ?? "0".repeat(64);
  const amount =
    overrides?.amount instanceof Prisma.Decimal
      ? overrides.amount
      : new Prisma.Decimal(overrides?.amount ?? "100.00");
  const currency = overrides?.currency ?? "PEN";
  const paymentMethod = overrides?.paymentMethod ?? "CARD";
  const status = overrides?.status ?? "PENDING";

  return prisma.cashInOperation.create({
    data: {
      id,
      userId,
      idempotencyKey,
      requestHash,
      amount,
      currency,
      paymentMethod,
      status,
      ...(overrides?.providerChargeId !== undefined
        ? { providerChargeId: overrides.providerChargeId }
        : {}),
      ...(overrides?.failureCode !== undefined
        ? { failureCode: overrides.failureCode }
        : {}),
      ...(overrides?.lastError !== undefined
        ? { lastError: overrides.lastError }
        : {}),
      ...(overrides?.reconcileAttempts !== undefined
        ? { reconcileAttempts: overrides.reconcileAttempts }
        : {}),
      ...(overrides?.leaseOwner !== undefined
        ? { leaseOwner: overrides.leaseOwner }
        : {}),
      ...(overrides?.leaseUntil !== undefined
        ? { leaseUntil: overrides.leaseUntil }
        : {}),
      ...(overrides?.completedAt !== undefined
        ? { completedAt: overrides.completedAt }
        : {}),
      ...(overrides?.updatedAt !== undefined
        ? { updatedAt: overrides.updatedAt }
        : {}),
    },
  });
}

export interface CreateLedgerEntryOverrides {
  walletId: string;
  operationId: string;
  type?: "CREDIT";
  amount?: Prisma.Decimal | string | number;
  balanceAfter?: Prisma.Decimal | string | number;
}

export async function createLedgerEntry(
  prisma: DbClient,
  overrides: CreateLedgerEntryOverrides
) {
  return prisma.ledgerEntry.create({
    data: {
      walletId: overrides.walletId,
      operationId: overrides.operationId,
      type: overrides.type ?? "CREDIT",
      amount:
        overrides.amount instanceof Prisma.Decimal
          ? overrides.amount
          : new Prisma.Decimal(overrides.amount ?? "100.00"),
      balanceAfter:
        overrides.balanceAfter instanceof Prisma.Decimal
          ? overrides.balanceAfter
          : new Prisma.Decimal(overrides.balanceAfter ?? "100.00"),
    },
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface CashInBodyOverrides {
  amount?: number;
  currency?: "PEN";
  paymentMethod?: string;
  payment_method?: string;
}

export function cashInBody(
  userId: string,
  overrides?: CashInBodyOverrides
) {
  return {
    user_id: userId,
    amount: overrides?.amount ?? 100.0,
    currency: overrides?.currency ?? "PEN",
    payment_method:
      overrides?.paymentMethod ?? overrides?.payment_method ?? "card_ok",
  };
}


