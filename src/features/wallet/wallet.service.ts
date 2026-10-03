import type { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { PrismaClient } from "../../infra/prisma";
import { createWalletRepository, type WalletRecord } from "./wallet.repository";

export type CreditActor = "api" | "webhook" | "reconciler";

export interface ApplyCreditInput {
  operationId: string;
  providerChargeId: string;
  actor: CreditActor;
}

export interface ApplyCreditResult {
  /** True only for the call that moved the operation to COMPLETED and credited the wallet. */
  applied: boolean;
  /** Status the operation was in when this call evaluated it. */
  from: OperationStatus;
  /** Balance recorded in the ledger entry, or null when the operation was never credited. */
  balanceAfter: Prisma.Decimal | null;
}

export interface WalletService {
  getWallet(userId: string): Promise<WalletRecord | null>;
  /**
   * The only way to credit a wallet. CAS to COMPLETED, balance increment and
   * ledger entry run in one transaction; if the operation is not creditable
   * anymore it is a no-op. Does not log: the caller logs the transition with
   * its `actor` after the commit, so a rollback can never make the log lie.
   *
   * Pass `tx` to run inside the caller's transaction (the webhook does, to keep
   * the event insert atomic with the credit). No new transaction is opened then.
   */
  applyCredit(input: ApplyCreditInput, tx?: Prisma.TransactionClient): Promise<ApplyCreditResult>;
}

export function createWalletService({ prisma }: { prisma: PrismaClient }): WalletService {
  async function applyCreditIn(
    tx: Prisma.TransactionClient,
    { operationId, providerChargeId }: ApplyCreditInput
  ): Promise<ApplyCreditResult> {
    const repo = createWalletRepository(tx);

    // userId and amount come from the operation itself, never from the caller.
    const operation = await repo.findOperationForCredit(operationId);
    if (!operation) {
      throw new Error(`applyCredit: operation ${operationId} does not exist`);
    }

    // Lock order: operation row first (CAS), then wallet row (increment).
    const won = await repo.completeOperation(operationId, providerChargeId);
    if (!won) {
      // Another actor may have completed it after our read. The CAS waited for
      // its commit, so a fresh read reports the real state and its ledger balance.
      const current = await repo.findOperationForCredit(operationId);
      return {
        applied: false,
        from: current?.status ?? operation.status,
        balanceAfter: current?.balanceAfter ?? null,
      };
    }

    const wallet = await repo.incrementBalance(operation.userId, operation.amount);
    await repo.createLedgerEntry({
      walletId: wallet.id,
      operationId,
      amount: operation.amount,
      balanceAfter: wallet.balance,
    });

    return { applied: true, from: operation.status, balanceAfter: wallet.balance };
  }

  return {
    getWallet(userId) {
      return createWalletRepository(prisma).findByUserId(userId);
    },

    applyCredit(input, tx) {
      if (tx) {
        return applyCreditIn(tx, input);
      }
      return prisma.$transaction((innerTx) => applyCreditIn(innerTx, input));
    },
  };
}
