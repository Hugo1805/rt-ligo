import { Prisma } from "../../generated/prisma/client";
import type { OperationStatus } from "../../generated/prisma/enums";
import type { Config } from "../../infra/config";
import type { Lock } from "../../infra/lock";
import type { Logger } from "../../infra/logger";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../infra/payment-provider/errors";
import type { ChargeResult, PaymentProvider } from "../../infra/payment-provider/payment-provider";
import { withDbRetry } from "../../shared/db-retry";
import { AppError } from "../../shared/errors";
import { retry } from "../../shared/retry";
import type { WalletService } from "../wallet/wallet.service";
import type { CashInOperationRecord, CashInRepository, TransitionStatus } from "./cash-in.repository";
import { computeRequestHash } from "./cash-in.request-hash";
import type { CashInRequest } from "./cash-in.schemas";

export interface CashInOperationView {
  id: string;
  status: OperationStatus;
  amount: Prisma.Decimal;
  /** From the ledger entry, so every replay reports the same balance. Null until credited. */
  balanceAfter: Prisma.Decimal | null;
}

export interface CashInResult {
  /** True only when the key already existed with the same request hash. */
  replayed: boolean;
  operation: CashInOperationView;
}

export interface CashInContext {
  requestId: string;
  logger: Logger;
}

export interface CashInServiceDeps {
  repository: CashInRepository;
  walletService: Pick<WalletService, "getWallet" | "applyCredit">;
  lock: Lock;
  paymentProvider: PaymentProvider;
  config: Pick<Config, "LOCK_TTL_MS" | "PROVIDER_MAX_RETRIES">;
  /** Backoff sleep between technical provider retries. Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CashInService {
  cashIn(input: { idempotencyKey: string; body: CashInRequest }, ctx: CashInContext): Promise<CashInResult>;
}

type ChargeOutcome =
  | { kind: "result"; result: ChargeResult }
  // Timeout, exhausted technical retries or an out-of-contract response:
  // we cannot know whether the provider charged, so it is never FAILED.
  | { kind: "unknown"; errorName: string };

function toView(operation: CashInOperationRecord): CashInOperationView {
  return {
    id: operation.id,
    status: operation.status,
    amount: operation.amount,
    balanceAfter: operation.ledgerEntry?.balanceAfter ?? null,
  };
}

export function createCashInService(deps: CashInServiceDeps): CashInService {
  const { repository, walletService, lock, paymentProvider, config } = deps;

  async function reread(id: string): Promise<CashInOperationView> {
    const operation = await withDbRetry(() => repository.findById(id));
    if (!operation) {
      throw new Error(`cash-in: operation ${id} disappeared`);
    }
    return toView(operation);
  }

  /** Same idempotency key: same hash is a replay, a different hash is a reused key. */
  function replayOf(existing: CashInOperationRecord, hash: string): CashInResult {
    if (existing.requestHash !== hash) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", { operationId: existing.id });
    }
    return { replayed: true, operation: toView(existing) };
  }

  /** CAS that never throws on a lost race: another actor moved it, so report the real state. */
  async function transitionOrReread(
    operation: { id: string; status: OperationStatus },
    to: TransitionStatus,
    data: Parameters<CashInRepository["transition"]>[2],
    logger: Logger
  ): Promise<CashInOperationView> {
    const won = await withDbRetry(() => repository.transition(operation.id, to, data));
    if (won) {
      logger.info({ event: "operation.transition", operation_id: operation.id, from: operation.status, to, actor: "api" });
      return reread(operation.id);
    }
    logger.info({ event: "operation.cas_lost", operation_id: operation.id, to });
    return reread(operation.id);
  }

  async function charge(
    operation: CashInOperationRecord,
    paymentMethod: string,
    requestId: string,
    logger: Logger
  ): Promise<ChargeOutcome> {
    try {
      // Never inside withDbRetry: this is the provider, not the database.
      // Retries reuse the same reference, so the provider can never charge twice.
      const result = await retry(
        () =>
          paymentProvider.charge({
            reference: operation.id,
            amount: operation.amount.toFixed(2),
            currency: operation.currency,
            paymentMethod,
            requestId,
          }),
        {
          maxRetries: config.PROVIDER_MAX_RETRIES,
          // Only technical failures. A timeout may have charged; a decline is a result, not an error.
          shouldRetry: (error) => error instanceof ProviderUnavailableError,
          sleep: deps.sleep,
          onRetry: ({ attempt, delayMs }) =>
            logger.warn({ event: "provider.retry", operation_id: operation.id, attempt, delay_ms: delayMs }),
        }
      );
      return { kind: "result", result };
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const level = error instanceof ProviderTimeoutError || error instanceof ProviderUnavailableError ? "warn" : "error";
      logger[level]({ event: "provider.charge_unknown", operation_id: operation.id, error: errorName });
      return { kind: "unknown", errorName };
    }
  }

  async function cashIn(
    { idempotencyKey, body }: { idempotencyKey: string; body: CashInRequest },
    ctx: CashInContext
  ): Promise<CashInResult> {
    const logger = ctx.logger.child({ user_id: body.user_id, idempotency_key: idempotencyKey });
    const hash = computeRequestHash(body);

    const lockResult = await lock.acquire(`lock:cashin:${body.user_id}:${idempotencyKey}`, {
      ttlMs: config.LOCK_TTL_MS,
      logger,
    });

    try {
      // Look at the DB before answering "busy": if the operation exists, return it (R3.2).
      const existing = await withDbRetry(() => repository.findByKey(body.user_id, idempotencyKey));
      if (existing) {
        return replayOf(existing, hash);
      }
      // "unavailable" means Redis is down: go on without the lock, the DB unique key decides (R4.4).
      if (lockResult.status === "busy") {
        throw new AppError("OPERATION_IN_PROGRESS");
      }

      // Validate before creating, so a bad request never leaves an operation behind.
      const wallet = await withDbRetry(() => walletService.getWallet(body.user_id));
      if (!wallet) {
        throw new AppError("WALLET_NOT_FOUND");
      }
      if (wallet.currency !== body.currency) {
        throw new AppError("CURRENCY_MISMATCH");
      }

      // Persisted before calling the provider. Decimal from the string: the schema allows max 2 decimals.
      const created = await withDbRetry(() =>
        repository.create({
          userId: body.user_id,
          idempotencyKey,
          requestHash: hash,
          amount: new Prisma.Decimal(String(body.amount)),
          currency: body.currency,
          paymentMethod: body.payment_method,
        })
      );
      if (created.kind === "duplicate") {
        return replayOf(created.operation, hash);
      }

      const operation = created.operation;

      const processing = await withDbRetry(() => repository.transition(operation.id, "PROCESSING"));
      if (!processing) {
        logger.info({ event: "operation.cas_lost", operation_id: operation.id, to: "PROCESSING" });
        return { replayed: false, operation: await reread(operation.id) };
      }
      logger.info({ event: "operation.transition", operation_id: operation.id, from: "PENDING", to: "PROCESSING", actor: "api" });
      const inFlight = { id: operation.id, status: "PROCESSING" as const };

      const outcome = await charge(operation, body.payment_method, ctx.requestId, logger);

      if (outcome.kind === "unknown") {
        const view = await transitionOrReread(inFlight, "UNKNOWN", { lastError: outcome.errorName }, logger);
        return { replayed: false, operation: view };
      }

      const { result } = outcome;
      if (result.status === "declined") {
        const view = await transitionOrReread(
          inFlight,
          "FAILED",
          { providerChargeId: result.chargeId, failureCode: result.failureCode },
          logger
        );
        return { replayed: false, operation: view };
      }

      const credit = await withDbRetry(() =>
        walletService.applyCredit({ operationId: operation.id, providerChargeId: result.chargeId, actor: "api" })
      );
      if (credit.applied) {
        logger.info({ event: "operation.transition", operation_id: operation.id, from: credit.from, to: "COMPLETED", actor: "api" });
        return {
          replayed: false,
          operation: { id: operation.id, status: "COMPLETED", amount: operation.amount, balanceAfter: credit.balanceAfter },
        };
      }
      // The webhook got there first (R9.8): answer with what it recorded.
      logger.info({ event: "operation.cas_lost", operation_id: operation.id, to: "COMPLETED" });
      return { replayed: false, operation: await reread(operation.id) };
    } finally {
      if (lockResult.status === "acquired") {
        await lockResult.release();
      }
    }
  }

  return { cashIn };
}
