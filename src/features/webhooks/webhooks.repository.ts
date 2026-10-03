import type { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import { allowedSources } from "../../shared/operation-state-machine";

export type WebhookOutcome =
  | "APPLIED"
  | "NOOP_ALREADY_APPLIED"
  | "IGNORED_OUT_OF_ORDER"
  | "ORPHAN"
  | "AMOUNT_MISMATCH"
  | "PENDING_NO_CHANGE";

export interface CreateEventInput {
  providerEventId: string;
  type: string;
  payload: Prisma.InputJsonValue;
}

export interface WebhookOperation {
  id: string;
  status: OperationStatus;
  amount: Prisma.Decimal;
  currency: string;
}

export interface CloseEventInput {
  operationId: string | null;
  outcome: WebhookOutcome;
}

/**
 * Every function takes the webhook's transaction client first: the event
 * insert, the effect and the close must commit or roll back together.
 */
export interface WebhooksRepository {
  /** Plain insert. A repeated providerEventId surfaces as P2002, never checked beforehand. */
  createEvent(tx: Prisma.TransactionClient, input: CreateEventInput): Promise<{ id: string }>;
  findOperation(tx: Prisma.TransactionClient, id: string): Promise<WebhookOperation | null>;
  /** CAS to FAILED from its allowed sources. Returns the number of rows moved (0 or 1). */
  markFailed(
    tx: Prisma.TransactionClient,
    id: string,
    failureCode: string | null
  ): Promise<number>;
  closeEvent(tx: Prisma.TransactionClient, eventId: string, input: CloseEventInput): Promise<void>;
}

export const webhooksRepository: WebhooksRepository = {
  createEvent(tx, { providerEventId, type, payload }) {
    return tx.webhookEvent.create({
      data: { providerEventId, type, payload },
      select: { id: true },
    });
  },

  findOperation(tx, id) {
    return tx.cashInOperation.findUnique({
      where: { id },
      select: { id: true, status: true, amount: true, currency: true },
    });
  },

  async markFailed(tx, id, failureCode) {
    const { count } = await tx.cashInOperation.updateMany({
      where: { id, status: { in: allowedSources("FAILED") } },
      data: { status: "FAILED", failureCode },
    });
    return count;
  },

  async closeEvent(tx, eventId, { operationId, outcome }) {
    await tx.webhookEvent.update({
      where: { id: eventId },
      data: { operationId, outcome, processedAt: new Date() },
    });
  },
};
