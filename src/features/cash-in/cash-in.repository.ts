import { Prisma } from "../../generated/prisma/client";
import type { DbClient } from "../../infra/prisma";
import { allowedSources } from "../../shared/operation-state-machine";

export const OPERATION_INCLUDE = {
  ledgerEntry: {
    select: {
      balanceAfter: true,
    },
  },
} as const;

export type CashInOperationRecord = Prisma.CashInOperationGetPayload<{
  include: typeof OPERATION_INCLUDE;
}>;

export interface CreateCashInOperationInput {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  amount: Prisma.Decimal;
  currency: string;
  paymentMethod: string;
}

export type CreateCashInOperationResult =
  | { kind: "created"; operation: CashInOperationRecord }
  | { kind: "duplicate"; operation: CashInOperationRecord };

export type TransitionStatus = "PROCESSING" | "UNKNOWN" | "FAILED";

export interface TransitionData {
  providerChargeId?: string | null;
  failureCode?: string | null;
  lastError?: string | null;
}

export function newOperationId(): string {
  return "op_" + Bun.randomUUIDv7().replaceAll("-", "");
}

export interface CashInRepository {
  create(input: CreateCashInOperationInput): Promise<CreateCashInOperationResult>;
  findByKey(userId: string, idempotencyKey: string): Promise<CashInOperationRecord | null>;
  findById(id: string): Promise<CashInOperationRecord | null>;
  transition(id: string, to: TransitionStatus, data?: TransitionData): Promise<boolean>;
}

export function createCashInRepository(db: DbClient): CashInRepository {
  async function findByKey(
    userId: string,
    idempotencyKey: string
  ): Promise<CashInOperationRecord | null> {
    return db.cashInOperation.findUnique({
      where: {
        userId_idempotencyKey: {
          userId,
          idempotencyKey,
        },
      },
      include: OPERATION_INCLUDE,
    });
  }

  async function findById(id: string): Promise<CashInOperationRecord | null> {
    return db.cashInOperation.findUnique({
      where: { id },
      include: OPERATION_INCLUDE,
    });
  }

  async function create(
    input: CreateCashInOperationInput
  ): Promise<CreateCashInOperationResult> {
    const id = newOperationId();
    try {
      const operation = await db.cashInOperation.create({
        data: {
          id,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          amount: input.amount,
          currency: input.currency,
          paymentMethod: input.paymentMethod,
          status: "PENDING",
        },
        include: OPERATION_INCLUDE,
      });
      return { kind: "created", operation };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await findByKey(input.userId, input.idempotencyKey);
        if (!existing) {
          throw error;
        }
        return { kind: "duplicate", operation: existing };
      }
      throw error;
    }
  }

  async function transition(
    id: string,
    to: TransitionStatus,
    data?: TransitionData
  ): Promise<boolean> {
    const { count } = await db.cashInOperation.updateMany({
      where: {
        id,
        status: {
          in: allowedSources(to),
        },
      },
      data: {
        status: to,
        ...(data?.providerChargeId !== undefined
          ? { providerChargeId: data.providerChargeId }
          : {}),
        ...(data?.failureCode !== undefined
          ? { failureCode: data.failureCode }
          : {}),
        ...(data?.lastError !== undefined
          ? { lastError: data.lastError }
          : {}),
      },
    });

    return count === 1;
  }

  return {
    create,
    findByKey,
    findById,
    transition,
  };
}
