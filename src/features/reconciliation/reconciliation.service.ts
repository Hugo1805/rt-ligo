import { randomUUID } from "node:crypto";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { Config } from "../../infra/config";
import type { Logger } from "../../infra/logger";
import type {
  ChargeResult,
  PaymentProvider,
} from "../../infra/payment-provider/payment-provider";
import type { PrismaClient } from "../../infra/prisma";
import type { WalletService } from "../wallet/wallet.service";
import {
  createReconciliationRepository,
  type ReconcileOperation,
  type ReconciliationRepository,
} from "./reconciliation.repository";

/** Lease duration, fixed by design §7. Not an environment variable. */
export const LEASE_DURATION_MS = 60_000;
/** Maximum operations taken per cycle. */
export const BATCH_SIZE = 50;

const ACTOR = "reconciler";

export type ReconcilerConfig = Pick<
  Config,
  "RECONCILE_INTERVAL_MS" | "RECONCILE_STALE_MS" | "RECONCILE_MAX_ATTEMPTS"
>;

export interface ReconcilerDeps {
  prisma: PrismaClient;
  paymentProvider: PaymentProvider;
  applyCredit: WalletService["applyCredit"];
  logger: Logger;
  config: ReconcilerConfig;
  podId: string;
  now?: () => Date;
  /** Defaults to a repository over `prisma`. Injected by unit tests. */
  repository?: ReconciliationRepository;
}

export interface Reconciler {
  /** Runs a single reconciliation cycle. One failing operation never stops the cycle. */
  runOnce(): Promise<void>;
  /** Starts the loop: each cycle is scheduled only after the previous one finished. */
  start(): void;
  /** Cancels the next cycle and waits for the one in progress. Idempotent. */
  stop(): Promise<void>;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const {
    paymentProvider,
    applyCredit,
    config,
    podId,
    now = () => new Date(),
  } = deps;
  const repo = deps.repository ?? createReconciliationRepository(deps.prisma);
  const log = deps.logger.child({ component: "reconciler" });

  function logTransition(operationId: string, from: OperationStatus, to: OperationStatus): void {
    log.info(
      { event: "operation.transition", operation_id: operationId, from, to, actor: ACTOR },
      "operation transition"
    );
  }

  /**
   * Applies a provider result. `from` is the status the operation is in now
   * (PROCESSING or UNKNOWN). Always resolves the operation one way or another.
   */
  async function applyResult(
    op: ReconcileOperation,
    from: OperationStatus,
    result: ChargeResult
  ): Promise<void> {
    if (result.status === "succeeded") {
      // No tx: applyCredit opens its own transaction.
      const credit = await applyCredit({
        operationId: op.id,
        providerChargeId: result.chargeId,
        actor: ACTOR,
      });
      if (credit.applied) {
        logTransition(op.id, credit.from, "COMPLETED");
      }
      return;
    }

    // declined is the provider's word; FAILED is ours.
    const count = await repo.markFailed({ id: op.id, failureCode: result.failureCode });
    if (count === 1) {
      logTransition(op.id, from, "FAILED");
    }
  }

  function charge(op: ReconcileOperation): Promise<ChargeResult> {
    return paymentProvider.charge({
      // Always the operation id: a new reference is the only way to charge twice.
      reference: op.id,
      amount: op.amount.toFixed(2),
      currency: op.currency,
      paymentMethod: op.paymentMethod,
      // Correlation id of this attempt, not the reference.
      requestId: `reconcile-${randomUUID()}`,
    });
  }

  async function reconcileOne(id: string): Promise<void> {
    const claimedAt = now();
    const claimed = await repo.claimLease({
      id,
      podId,
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + LEASE_DURATION_MS),
      maxAttempts: config.RECONCILE_MAX_ATTEMPTS,
    });
    if (claimed === 0) {
      // Another pod holds the lease, or the operation is no longer reconcilable.
      return;
    }

    const op = await repo.findById(id);
    if (!op) {
      return;
    }

    let status = op.status;
    try {
      if (status === "PENDING") {
        // The charge never left. CAS first, then charge with the same reference.
        const moved = await repo.markProcessing({ id });
        if (moved === 0) {
          await repo.releaseLease({ id, podId });
          return;
        }
        logTransition(id, "PENDING", "PROCESSING");
        status = "PROCESSING";
        await applyResult(op, status, await charge(op));
        return;
      }

      if (status === "PROCESSING" || status === "UNKNOWN") {
        const result = await paymentProvider.getCharge(id);
        if (result.status === "not_found") {
          await applyResult(op, status, await charge(op));
        } else {
          await applyResult(op, status, result);
        }
        return;
      }

      // Terminal status after the claim (cannot happen: the lease filters by status).
      await repo.releaseLease({ id, podId });
    } catch (err) {
      // Provider timeout, unavailable or unexpected response, or a DB failure:
      // nothing is known about the charge, so retry in a later cycle.
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await repo.releaseLease({ id, podId, lastError: message });
      log.warn(
        { event: "reconcile.attempt_failed", operation_id: id, attempts: op.reconcileAttempts, err },
        "reconcile attempt failed"
      );

      if (op.reconcileAttempts >= config.RECONCILE_MAX_ATTEMPTS) {
        if (status === "PROCESSING") {
          const marked = await repo.markUnknown({ id });
          if (marked === 1) {
            logTransition(id, "PROCESSING", "UNKNOWN");
          }
        }
        log.error(
          { event: "reconcile.exhausted", operation_id: id, attempts: op.reconcileAttempts },
          "reconcile attempts exhausted, manual review required"
        );
      }
    }
  }

  async function runOnce(): Promise<void> {
    const candidates = await repo.findCandidates({
      staleBefore: new Date(now().getTime() - config.RECONCILE_STALE_MS),
      maxAttempts: config.RECONCILE_MAX_ATTEMPTS,
      limit: BATCH_SIZE,
    });

    for (const { id } of candidates) {
      try {
        await reconcileOne(id);
      } catch (err) {
        log.error({ event: "reconcile.error", operation_id: id, err }, "reconcile failed");
      }
    }
  }

  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      current = runOnce()
        .catch((err: unknown) => {
          log.error({ event: "reconcile.cycle_failed", err }, "reconcile cycle failed");
        })
        .finally(() => {
          current = null;
          schedule();
        });
    }, config.RECONCILE_INTERVAL_MS);
  }

  return {
    runOnce,

    start() {
      if (started || stopped) return;
      started = true;
      schedule();
    },

    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (current) {
        await current;
      }
    },
  };
}
