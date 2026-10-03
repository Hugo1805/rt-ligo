import { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { Logger } from "../../infra/logger";
import type { PrismaClient } from "../../infra/prisma";
import { getDbErrorCode, type withDbRetry as WithDbRetry } from "../../shared/db-retry";
import { canTransition } from "../../shared/operation-state-machine";
import type { WalletService } from "../wallet/wallet.service";
import {
  webhooksRepository,
  type WebhookOperation,
  type WebhookOutcome,
  type WebhooksRepository,
} from "./webhooks.repository";
import type { WebhookEvent } from "./webhooks.schemas";

export interface WebhooksServiceDeps {
  prisma: Pick<PrismaClient, "$transaction">;
  /** `applyCredit` of wallet.service.ts, injectable so tests can make it fail. */
  applyCredit: WalletService["applyCredit"];
  withDbRetry: typeof WithDbRetry;
  /** Defaults to the Prisma repository; unit tests pass a double. */
  repository?: WebhooksRepository;
}

export interface ProcessWebhookResult {
  duplicate: boolean;
}

export interface WebhooksService {
  /** Applies an already verified and validated provider event, idempotently. */
  processWebhookEvent(event: WebhookEvent, logger: Logger): Promise<ProcessWebhookResult>;
}

type AnomalyLevel = "warn" | "error";

interface Anomaly {
  level: AnomalyLevel;
  reason: string;
  fields?: Record<string, unknown>;
}

interface Transition {
  from: OperationStatus;
  to: OperationStatus;
}

/** What the transaction decided. Logged only after the commit, so a rollback never leaves a lying log. */
interface Decision {
  outcome: WebhookOutcome;
  transition?: Transition;
  anomaly?: Anomaly;
}

// A lost CAS re-reads and decides again. The state only moves forward, so the
// second pass always lands on a terminal state; the bound guards against bugs.
const MAX_DECISION_PASSES = 3;

const ANOMALY_LEVEL: Record<string, AnomalyLevel> = {
  "succeeded:PENDING": "warn",
  "succeeded:FAILED": "error",
  "failed:COMPLETED": "warn",
};

export function createWebhooksService(deps: WebhooksServiceDeps): WebhooksService {
  const { prisma, applyCredit, withDbRetry } = deps;
  const repo = deps.repository ?? webhooksRepository;

  async function decide(
    tx: Prisma.TransactionClient,
    event: WebhookEvent,
    initial: WebhookOperation
  ): Promise<Decision> {
    if (event.type === "charge.pending") {
      return { outcome: "PENDING_NO_CHANGE" };
    }

    const kind = event.type === "charge.succeeded" ? "succeeded" : "failed";
    const target: OperationStatus = kind === "succeeded" ? "COMPLETED" : "FAILED";
    let op = initial;

    for (let pass = 0; pass < MAX_DECISION_PASSES; pass++) {
      if (op.status === target) {
        return { outcome: "NOOP_ALREADY_APPLIED" };
      }

      if (!canTransition(op.status, target)) {
        return {
          outcome: "IGNORED_OUT_OF_ORDER",
          anomaly: {
            level: ANOMALY_LEVEL[`${kind}:${op.status}`] ?? "warn",
            reason: "out_of_order",
            fields: { type: event.type, status: op.status },
          },
        };
      }

      if (kind === "succeeded") {
        const result = await applyCredit(
          { operationId: op.id, providerChargeId: event.data.charge_id, actor: "webhook" },
          tx
        );
        if (result.applied) {
          return { outcome: "APPLIED", transition: { from: result.from, to: "COMPLETED" } };
        }
      } else {
        const count = await repo.markFailed(tx, op.id, event.data.failure_code);
        if (count === 1) {
          return { outcome: "APPLIED", transition: { from: op.status, to: "FAILED" } };
        }
      }

      // Another actor moved the operation first: decide with its real state.
      const current = await repo.findOperation(tx, op.id);
      if (!current) {
        throw new Error(`webhook: operation ${op.id} disappeared inside the transaction`);
      }
      op = current;
    }

    throw new Error(`webhook: no decision for operation ${op.id} after ${MAX_DECISION_PASSES} passes`);
  }

  return {
    async processWebhookEvent(event, logger) {
      const log = logger.child({
        event_id: event.event_id,
        operation_id: event.data.reference,
      });

      // Reset on every attempt of withDbRetry: only a P2002 thrown by this
      // attempt's createEvent means "duplicate". Any other P2002 (e.g. the
      // @unique providerChargeId inside applyCredit) must be rethrown.
      let eventCreated = false;

      try {
        const decision = await withDbRetry(
          () =>
            prisma.$transaction(async (tx): Promise<Decision> => {
              eventCreated = false;
              const { id: eventId } = await repo.createEvent(tx, {
                providerEventId: event.event_id,
                type: event.type,
                payload: event,
              });
              eventCreated = true;

              const op = await repo.findOperation(tx, event.data.reference);
              if (!op) {
                await repo.closeEvent(tx, eventId, { operationId: null, outcome: "ORPHAN" });
                return {
                  outcome: "ORPHAN",
                  anomaly: { level: "warn", reason: "orphan" },
                };
              }

              const eventAmount = new Prisma.Decimal(String(event.data.amount));
              if (!eventAmount.equals(op.amount) || event.data.currency !== op.currency) {
                await repo.closeEvent(tx, eventId, {
                  operationId: op.id,
                  outcome: "AMOUNT_MISMATCH",
                });
                return {
                  outcome: "AMOUNT_MISMATCH",
                  anomaly: {
                    level: "error",
                    reason: "amount_mismatch",
                    fields: {
                      event_amount: eventAmount.toFixed(2),
                      event_currency: event.data.currency,
                      operation_amount: op.amount.toFixed(2),
                      operation_currency: op.currency,
                    },
                  },
                };
              }

              const result = await decide(tx, event, op);
              await repo.closeEvent(tx, eventId, { operationId: op.id, outcome: result.outcome });
              return result;
            }),
          { logger: log }
        );

        // Logged after the commit, as applyCredit expects. operation_id comes
        // from the child bindings (repeating it would duplicate the JSON key).
        if (decision.transition) {
          log.info({
            event: "operation.transition",
            from: decision.transition.from,
            to: decision.transition.to,
            actor: "webhook",
          });
        }
        if (decision.anomaly) {
          log[decision.anomaly.level]({
            event: "webhook.anomaly",
            reason: decision.anomaly.reason,
            outcome: decision.outcome,
            ...decision.anomaly.fields,
          });
        }
        return { duplicate: false };
      } catch (error) {
        if (getDbErrorCode(error) === "P2002" && !eventCreated) {
          log.info({ event: "webhook.duplicate" });
          return { duplicate: true };
        }
        throw error;
      }
    },
  };
}
