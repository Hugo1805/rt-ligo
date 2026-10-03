import type { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { DbClient } from "../../infra/prisma";
import { allowedSources } from "../../shared/operation-state-machine";

/** Statuses the reconciler may pick up. Terminal statuses are never touched. */
export const RECONCILABLE_STATUSES: OperationStatus[] = ["PENDING", "PROCESSING", "UNKNOWN"];

export interface ReconcileOperation {
  id: string;
  amount: Prisma.Decimal;
  currency: string;
  paymentMethod: string;
  status: OperationStatus;
  reconcileAttempts: number;
}

export interface FindCandidatesInput {
  staleBefore: Date;
  maxAttempts: number;
  limit: number;
}

export interface ClaimLeaseInput {
  id: string;
  podId: string;
  now: Date;
  leaseUntil: Date;
  maxAttempts: number;
}

export interface ReleaseLeaseInput {
  id: string;
  podId: string;
  lastError?: string | null;
}

export interface ReconciliationRepository {
  findCandidates(input: FindCandidatesInput): Promise<{ id: string }[]>;
  /** Returns the updateMany count: 1 when this pod owns the lease, 0 otherwise. */
  claimLease(input: ClaimLeaseInput): Promise<number>;
  releaseLease(input: ReleaseLeaseInput): Promise<number>;
  findById(id: string): Promise<ReconcileOperation | null>;
  markProcessing(input: { id: string }): Promise<number>;
  markFailed(input: { id: string; failureCode: string }): Promise<number>;
  markUnknown(input: { id: string }): Promise<number>;
}

const OPERATION_SELECT = {
  id: true,
  amount: true,
  currency: true,
  paymentMethod: true,
  status: true,
  reconcileAttempts: true,
} as const;

export function createReconciliationRepository(db: DbClient): ReconciliationRepository {
  return {
    findCandidates({ staleBefore, maxAttempts, limit }) {
      return db.cashInOperation.findMany({
        where: {
          status: { in: RECONCILABLE_STATUSES },
          updatedAt: { lt: staleBefore },
          reconcileAttempts: { lt: maxAttempts },
        },
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
    },

    async claimLease({ id, podId, now, leaseUntil, maxAttempts }) {
      // Single conditional write: two pods racing on the same row cannot both win.
      // The attempts filter is repeated here because a candidate list can be stale:
      // another pod may have spent the last attempt and released the lease meanwhile.
      const { count } = await db.cashInOperation.updateMany({
        where: {
          id,
          status: { in: RECONCILABLE_STATUSES },
          reconcileAttempts: { lt: maxAttempts },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        data: {
          leaseOwner: podId,
          leaseUntil,
          reconcileAttempts: { increment: 1 },
        },
      });
      return count;
    },

    async releaseLease({ id, podId, lastError }) {
      const { count } = await db.cashInOperation.updateMany({
        where: { id, leaseOwner: podId },
        data: {
          leaseOwner: null,
          leaseUntil: null,
          ...(lastError !== undefined ? { lastError } : {}),
        },
      });
      return count;
    },

    findById(id) {
      return db.cashInOperation.findUnique({ where: { id }, select: OPERATION_SELECT });
    },

    async markProcessing({ id }) {
      const { count } = await db.cashInOperation.updateMany({
        // allowedSources("PROCESSING") is exactly [PENDING].
        where: { id, status: { in: allowedSources("PROCESSING") } },
        data: { status: "PROCESSING" },
      });
      return count;
    },

    async markFailed({ id, failureCode }) {
      const { count } = await db.cashInOperation.updateMany({
        where: { id, status: { in: allowedSources("FAILED") } },
        data: { status: "FAILED", failureCode },
      });
      return count;
    },

    async markUnknown({ id }) {
      const { count } = await db.cashInOperation.updateMany({
        where: { id, status: { in: allowedSources("UNKNOWN") } },
        data: { status: "UNKNOWN" },
      });
      return count;
    },
  };
}
