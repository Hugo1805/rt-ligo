import { describe, expect, test } from "bun:test";
import { Prisma } from "../../../src/generated/prisma/client";
import { AppError } from "../../../src/shared/errors";
import {
  isTransientDbError,
  withDbRetry,
  TRANSIENT_DB_ERROR_CODES,
  type DbRetryLogger,
} from "../../../src/shared/db-retry";

describe("isTransientDbError", () => {
  test("recognizes all 6 transient codes on PrismaClientKnownRequestError", () => {
    for (const code of TRANSIENT_DB_ERROR_CODES) {
      const err = new Prisma.PrismaClientKnownRequestError("database transient error", {
        code,
        clientVersion: "test",
      });
      expect(isTransientDbError(err)).toBe(true);
    }
  });

  test("recognizes all 6 transient codes on PrismaClientInitializationError via errorCode", () => {
    for (const code of TRANSIENT_DB_ERROR_CODES) {
      const err = new Prisma.PrismaClientInitializationError(
        "database connection initialization error",
        "test",
        code
      );
      expect(isTransientDbError(err)).toBe(true);
    }
  });

  test("returns false for non-transient Prisma codes such as P2002 (unique constraint violation)", () => {
    const err = new Prisma.PrismaClientKnownRequestError("unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(isTransientDbError(err)).toBe(false);
  });

  test("returns false for non-transient Prisma codes such as P1000 (auth failed) and P2025 (not found)", () => {
    const errAuth = new Prisma.PrismaClientKnownRequestError("auth failed", {
      code: "P1000",
      clientVersion: "test",
    });
    const errNotFound = new Prisma.PrismaClientKnownRequestError("record not found", {
      code: "P2025",
      clientVersion: "test",
    });
    expect(isTransientDbError(errAuth)).toBe(false);
    expect(isTransientDbError(errNotFound)).toBe(false);
  });

  test("returns false for PrismaClientInitializationError without errorCode or with non-transient errorCode", () => {
    const withoutCode = new Prisma.PrismaClientInitializationError(
      "initialization failed without code",
      "test"
    );
    const withOtherCode = new Prisma.PrismaClientInitializationError(
      "initialization failed",
      "test",
      "P1000"
    );
    expect(isTransientDbError(withoutCode)).toBe(false);
    expect(isTransientDbError(withOtherCode)).toBe(false);
  });

  test("returns false for business AppError instances (e.g. WALLET_NOT_FOUND)", () => {
    const appError = new AppError("WALLET_NOT_FOUND");
    expect(isTransientDbError(appError)).toBe(false);
  });

  test("returns false for generic Error instances", () => {
    const genericErr = new Error("Generic database error");
    const genericWithCodeText = new Error("P1001");
    expect(isTransientDbError(genericErr)).toBe(false);
    expect(isTransientDbError(genericWithCodeText)).toBe(false);
  });

  test("returns false for non-object and null values", () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError("P1001")).toBe(false);
    expect(isTransientDbError(1001)).toBe(false);
    expect(isTransientDbError({})).toBe(false);
  });
});

describe("isTransientDbError with real pg adapter outages", () => {
  test("a refused connection reported with a network code is transient", () => {
    const err = new Prisma.PrismaClientKnownRequestError("", {
      code: "ECONNREFUSED",
      clientVersion: "test",
    });
    expect(isTransientDbError(err)).toBe(true);
  });

  test("the pg pool connect timeout is transient", () => {
    expect(isTransientDbError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  test("invalid credentials and unrelated errors are not transient", () => {
    const auth = new Prisma.PrismaClientKnownRequestError("", { code: "P1000", clientVersion: "test" });
    expect(isTransientDbError(auth)).toBe(false);
    expect(isTransientDbError(new Error("Connection terminated due to connection timeout, extra"))).toBe(false);
  });
});

describe("withDbRetry", () => {
  const instantSleep = async () => {};

  test("success on first attempt: one call, zero delays, returns value", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await withDbRetry(
      async () => {
        calls++;
        return { ok: true, balance: 100 };
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(result).toEqual({ ok: true, balance: 100 });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  test("P1001 and then success: two calls, sleeps once, returns value", async () => {
    let calls = 0;
    const delays: number[] = [];
    const transientErr = new Prisma.PrismaClientKnownRequestError("connection failed", {
      code: "P1001",
      clientVersion: "test",
    });

    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw transientErr;
        }
        return "recovered-value";
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(result).toBe("recovered-value");
    expect(calls).toBe(2);
    expect(delays.length).toBe(1);
  });

  test("PrismaClientInitializationError with P1001 and then success: two calls, returns value", async () => {
    let calls = 0;
    const transientInitErr = new Prisma.PrismaClientInitializationError(
      "init failed",
      "test",
      "P1001"
    );

    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw transientInitErr;
        }
        return "recovered-from-init";
      },
      {
        sleep: instantSleep,
      }
    );

    expect(result).toBe("recovered-from-init");
    expect(calls).toBe(2);
  });

  test("P2034 three times: exactly 3 calls, sleeps twice, and throws AppError with code SERVICE_UNAVAILABLE", async () => {
    let calls = 0;
    const delays: number[] = [];
    const thirdError = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test",
    });

    let caughtError: unknown;
    try {
      await withDbRetry(
        async () => {
          calls++;
          if (calls === 3) {
            throw thirdError;
          }
          throw new Prisma.PrismaClientKnownRequestError("conflict", {
            code: "P2034",
            clientVersion: "test",
          });
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(calls).toBe(3);
    expect(delays.length).toBe(2);
    expect(caughtError).toBeInstanceOf(AppError);

    const appErr = caughtError as AppError;
    expect(appErr.code).toBe("SERVICE_UNAVAILABLE");
    expect(appErr.status).toBe(503);
    expect(appErr.retryable).toBe(true);
    // Prisma message must NOT be in detail; it goes in cause
    expect(appErr.detail).toBe("Servicio no disponible");
    expect(appErr.cause).toBe(thirdError);
  });

  test("P2002 is not retried: one call, rethrows exact same error instance immediately without delay", async () => {
    let calls = 0;
    const delays: number[] = [];
    const duplicateErr = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "test",
    });

    let caughtError: unknown;
    try {
      await withDbRetry(
        async () => {
          calls++;
          throw duplicateErr;
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(caughtError).toBe(duplicateErr);
  });

  test("business AppError (e.g. WALLET_NOT_FOUND) is not retried: one call, rethrows same instance", async () => {
    let calls = 0;
    const delays: number[] = [];
    const businessErr = new AppError("WALLET_NOT_FOUND");

    let caughtError: unknown;
    try {
      await withDbRetry(
        async () => {
          calls++;
          throw businessErr;
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(caughtError).toBe(businessErr);
  });

  test("generic Error is not retried: one call, rethrows same instance", async () => {
    let calls = 0;
    const delays: number[] = [];
    const genericErr = new Error("Unexpected memory failure");

    let caughtError: unknown;
    try {
      await withDbRetry(
        async () => {
          calls++;
          throw genericErr;
        },
        {
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(caughtError).toBe(genericErr);
  });

  test("transient error on attempt 1 followed by non-transient on attempt 2: stops immediately and rethrows non-transient", async () => {
    let calls = 0;
    const nonTransientErr = new Prisma.PrismaClientKnownRequestError("unique failed", {
      code: "P2002",
      clientVersion: "test",
    });

    let caughtError: unknown;
    try {
      await withDbRetry(
        async () => {
          calls++;
          if (calls === 1) {
            throw new Prisma.PrismaClientKnownRequestError("pool timeout", {
              code: "P2024",
              clientVersion: "test",
            });
          }
          throw nonTransientErr;
        },
        {
          sleep: instantSleep,
        }
      );
    } catch (err) {
      caughtError = err;
    }

    expect(calls).toBe(2);
    expect(caughtError).toBe(nonTransientErr);
  });

  test("calls logger.warn with { event: 'db.retry', attempt, code } for each retry", async () => {
    const loggedEvents: Record<string, unknown>[] = [];
    const mockLogger: DbRetryLogger = {
      warn: (obj) => {
        loggedEvents.push(obj);
      },
    };

    let calls = 0;
    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new Prisma.PrismaClientKnownRequestError("connection closed", {
            code: "P1017",
            clientVersion: "test",
          });
        }
        if (calls === 2) {
          throw new Prisma.PrismaClientKnownRequestError("query timeout", {
            code: "P1008",
            clientVersion: "test",
          });
        }
        return "success-after-two-retries";
      },
      {
        logger: mockLogger,
        sleep: instantSleep,
      }
    );

    expect(result).toBe("success-after-two-retries");
    expect(calls).toBe(3);
    expect(loggedEvents).toEqual([
      { event: "db.retry", attempt: 0, code: "P1017" },
      { event: "db.retry", attempt: 1, code: "P1008" },
    ]);
  });

  test("uses custom random and backoff options", async () => {
    const delays: number[] = [];
    let calls = 0;

    await withDbRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Prisma.PrismaClientKnownRequestError("timeout", {
            code: "P1002",
            clientVersion: "test",
          });
        }
        return "ok";
      },
      {
        baseMs: 50,
        capMs: 300,
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(calls).toBe(3);
    // retry 0: 50 * 2^0 = 50 -> 0.5 * 50 = 25
    // retry 1: 50 * 2^1 = 100 -> 0.5 * 100 = 50
    expect(delays).toEqual([25, 50]);
  });

  test("validates fn is a function", async () => {
    // @ts-expect-error fn must be a function
    expect(() => withDbRetry("not-a-fn")).toThrow(TypeError);
  });

  test("validates logger if provided", async () => {
    // @ts-expect-error invalid logger
    expect(() => withDbRetry(async () => "ok", { logger: "not-a-logger" })).toThrow(TypeError);
    // @ts-expect-error logger without warn
    expect(() => withDbRetry(async () => "ok", { logger: {} })).toThrow(TypeError);
  });
});
