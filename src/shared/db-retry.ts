import { Prisma } from "../generated/prisma/client";
import { AppError } from "./errors";
import { retry } from "./retry";

export const TRANSIENT_DB_ERROR_CODES = [
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
] as const;

export type TransientDbErrorCode = (typeof TRANSIENT_DB_ERROR_CODES)[number];

// With @prisma/adapter-pg a real outage does not surface as P1001 (design §7):
// a refused connection arrives as a known request error whose `code` is the
// Node network code, and a connect timeout arrives as a plain pg pool Error.
export const TRANSIENT_NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
] as const;

const PG_POOL_TRANSIENT_MESSAGES = [
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "timeout exceeded when trying to connect",
] as const;

const transientCodeSet: ReadonlySet<string> = new Set([
  ...TRANSIENT_DB_ERROR_CODES,
  ...TRANSIENT_NETWORK_ERROR_CODES,
]);

/**
 * Extracts the database error code from a Prisma error if available.
 * Returns `code` for PrismaClientKnownRequestError and `errorCode` for PrismaClientInitializationError.
 */
export function getDbErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code;
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return err.errorCode;
  }
  if (typeof err === "object" && err !== null) {
    const candidate = err as {
      name?: unknown;
      constructor?: { name?: unknown };
      code?: unknown;
      errorCode?: unknown;
    };
    if (
      (candidate.name === "PrismaClientKnownRequestError" ||
        candidate.constructor?.name === "PrismaClientKnownRequestError") &&
      typeof candidate.code === "string"
    ) {
      return candidate.code;
    }
    if (
      (candidate.name === "PrismaClientInitializationError" ||
        candidate.constructor?.name === "PrismaClientInitializationError") &&
      typeof candidate.errorCode === "string"
    ) {
      return candidate.errorCode;
    }
  }
  return undefined;
}

/**
 * Returns true if the error is a recognized transient database error: the Prisma
 * codes of design §7, the network codes the pg adapter reports, or a pg pool
 * connection error.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = getDbErrorCode(err);
  if (code !== undefined) {
    return transientCodeSet.has(code);
  }
  return (
    err instanceof Error &&
    !(err instanceof AppError) &&
    PG_POOL_TRANSIENT_MESSAGES.some((message) => err.message === message)
  );
}

export interface DbRetryLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface WithDbRetryOptions {
  logger?: DbRetryLogger | undefined;
  baseMs?: number | undefined;
  capMs?: number | undefined;
  random?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Wraps an idempotent database unit of work with retry logic for transient Prisma errors.
 *
 * Re-executes `fn` up to 3 total attempts using exponential backoff with full jitter
 * when encountering transient PostgreSQL/Prisma errors (P1001, P1002, P1008, P1017, P2024, P2034).
 * If all attempts are exhausted, throws an AppError with code SERVICE_UNAVAILABLE (503).
 *
 * IMPORTANT USAGE GUIDELINES:
 * 1. Do NOT wrap individual queries inside an interactive `$transaction`. When an error
 *    occurs in PostgreSQL, the entire transaction is aborted by the database; retrying an
 *    individual statement inside an aborted transaction will always fail. Always wrap the
 *    ENTIRE `$transaction` call:
 *    ```ts
 *    // CORRECT:
 *    await withDbRetry(() => prisma.$transaction(async (tx) => { ... }));
 *
 *    // INCORRECT:
 *    await prisma.$transaction(async (tx) => {
 *      await withDbRetry(() => tx.wallet.update(...));
 *    });
 *    ```
 * 2. Do NOT wrap external provider calls (such as payment gateway HTTP requests) in `withDbRetry`.
 *    Wrapping provider calls could lead to double charging. Only wrap database operations.
 */
export async function withDbRetry<T>(
  fn: (attempt?: number) => Promise<T> | T,
  options?: WithDbRetryOptions
): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("fn must be a function");
  }

  if (
    options?.logger !== undefined &&
    (typeof options.logger !== "object" ||
      options.logger === null ||
      typeof options.logger.warn !== "function")
  ) {
    throw new TypeError("logger must have a warn function");
  }

  try {
    return await retry(
      (attempt) => fn(attempt),
      {
        maxRetries: 2,
        shouldRetry: (error) => isTransientDbError(error),
        baseMs: options?.baseMs,
        capMs: options?.capMs,
        random: options?.random,
        sleep: options?.sleep,
        onRetry: ({ attempt, error }) => {
          const code = getDbErrorCode(error);
          options?.logger?.warn({
            event: "db.retry",
            attempt,
            code,
          });
        },
      }
    );
  } catch (error) {
    if (isTransientDbError(error)) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
    throw error;
  }
}
