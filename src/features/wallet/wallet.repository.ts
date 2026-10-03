import type { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { DbClient } from "../../infra/prisma";
import { allowedSources } from "../../shared/operation-state-machine";

export interface WalletRecord {
  id: string;
  userId: string;
  currency: string;
  balance: Prisma.Decimal;
}

export interface CreditableOperation {
  userId: string;
  amount: Prisma.Decimal;
  status: OperationStatus;
  balanceAfter: Prisma.Decimal | null;
}

export interface WalletRepository {
  findByUserId(userId: string): Promise<WalletRecord | null>;
  findOperationForCredit(operationId: string): Promise<CreditableOperation | null>;
  /** CAS to COMPLETED from the creditable states. True only for the actor that won. */
  completeOperation(operationId: string, providerChargeId: string): Promise<boolean>;
  /** Single `balance = balance + amount` statement; returns the wallet after the increment. */
  incrementBalance(userId: string, amount: Prisma.Decimal): Promise<WalletRecord>;
  createLedgerEntry(input: {
    walletId: string;
    operationId: string;
    amount: Prisma.Decimal;
    balanceAfter: Prisma.Decimal;
  }): Promise<void>;
}

const WALLET_SELECT = { id: true, userId: true, currency: true, balance: true } as const;

export function createWalletRepository(db: DbClient): WalletRepository {
  return {
    findByUserId(userId) {
      return db.wallet.findUnique({ where: { userId }, select: WALLET_SELECT });
    },

    async findOperationForCredit(operationId) {
      const operation = await db.cashInOperation.findUnique({
        where: { id: operationId },
        select: {
          userId: true,
          amount: true,
          status: true,
          ledgerEntry: { select: { balanceAfter: true } },
        },
      });
      if (!operation) {
        return null;
      }
      return {
        userId: operation.userId,
        amount: operation.amount,
        status: operation.status,
        balanceAfter: operation.ledgerEntry?.balanceAfter ?? null,
      };
    },

    async completeOperation(operationId, providerChargeId) {
      const { count } = await db.cashInOperation.updateMany({
        where: { id: operationId, status: { in: allowedSources("COMPLETED") } },
        data: { status: "COMPLETED", providerChargeId, completedAt: new Date() },
      });
      return count === 1;
    },

    incrementBalance(userId, amount) {
      return db.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
        select: WALLET_SELECT,
      });
    },

    async createLedgerEntry({ walletId, operationId, amount, balanceAfter }) {
      await db.ledgerEntry.create({
        data: { walletId, operationId, type: "CREDIT", amount, balanceAfter },
      });
    },
  };
}
