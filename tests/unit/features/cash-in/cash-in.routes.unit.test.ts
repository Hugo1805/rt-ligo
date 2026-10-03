import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { Prisma } from "../../../../src/generated/prisma/client";
import { correlation, REQUEST_ID_HEADER, type AppEnv } from "../../../../src/infra/correlation";
import { createLogger } from "../../../../src/infra/logger";
import type { Config } from "../../../../src/infra/config";
import type { Lock } from "../../../../src/infra/lock";
import type { PaymentProvider } from "../../../../src/infra/payment-provider/payment-provider";
import type { PrismaClient } from "../../../../src/infra/prisma";
import type { Redis } from "../../../../src/infra/redis";
import { AppError } from "../../../../src/shared/errors";
import { errorHandler, notFoundHandler, type ProblemDetails } from "../../../../src/shared/error-handler";
import { createApp, type AppDeps } from "../../../../src/app";
import { createCashInRoutes } from "../../../../src/features/cash-in/cash-in.routes";
import type { CashInService, CashInResult } from "../../../../src/features/cash-in/cash-in.service";
import type { CashInRequest } from "../../../../src/features/cash-in/cash-in.schemas";

const VALID_KEY = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const VALID_BODY: CashInRequest = {
  user_id: "usr_abc123",
  amount: 100.0,
  currency: "PEN",
  payment_method: "card_ok",
};

function createTestApp(service: CashInService, maxAmount = 10000): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const logger = createLogger({ level: "silent", podId: "test-pod" });

  app.use(correlation(logger));
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  const routes = createCashInRoutes(service, { CASH_IN_MAX_AMOUNT: maxAmount });
  app.route("/", routes);

  return app;
}

describe("POST /cash-in (unit routes)", () => {
  test("sin Idempotency-Key y body inválido: 400 IDEMPOTENCY_KEY_MISSING, servicio no llamado", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ invalid: 123 }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("IDEMPOTENCY_KEY_MISSING");
    expect(cashInMock).not.toHaveBeenCalled();
  });

  test("Idempotency-Key: abc: 400 IDEMPOTENCY_KEY_INVALID, servicio no llamado", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "abc",
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(cashInMock).not.toHaveBeenCalled();
  });

  test("body con campo extra: 400 VALIDATION_ERROR con errors y servicio no llamado", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify({
        ...VALID_BODY,
        extra_field: "unexpected",
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(problem.errors.length).toBeGreaterThan(0);
    expect(problem.errors.some((e) => e.field === "extra_field")).toBe(true);
    expect(cashInMock).not.toHaveBeenCalled();
  });

  test("body que no es JSON: 400 VALIDATION_ERROR en application/problem+json", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: "this is not json",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(problem.detail).toBe("El body no es JSON válido.");
    expect(cashInMock).not.toHaveBeenCalled();
  });

  test("amount mayor que CASH_IN_MAX_AMOUNT: 400 VALIDATION_ERROR", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service, 5000);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify({
        ...VALID_BODY,
        amount: 5000.01,
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(cashInMock).not.toHaveBeenCalled();
  });

  test("servicio devuelve COMPLETED: 200 con new_balance numérico", async () => {
    const serviceResult: CashInResult = {
      replayed: false,
      operation: {
        id: "op_completed_1",
        status: "COMPLETED",
        amount: new Prisma.Decimal("100.50"),
        balanceAfter: new Prisma.Decimal("350.75"),
      },
    };
    const cashInMock = mock(async () => serviceResult);
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const body = (await res.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance: number;
    };
    expect(body).toEqual({
      operation_id: "op_completed_1",
      status: "completed",
      amount: 100.5,
      new_balance: 350.75,
    });
    expect(typeof body.amount).toBe("number");
    expect(typeof body.new_balance).toBe("number");
    expect(cashInMock).toHaveBeenCalledTimes(1);
  });

  test("UNKNOWN: 202 con status: 'unknown' y sin new_balance", async () => {
    const serviceResult: CashInResult = {
      replayed: false,
      operation: {
        id: "op_unknown_1",
        status: "UNKNOWN",
        amount: new Prisma.Decimal("100.00"),
        balanceAfter: null,
      },
    };
    const cashInMock = mock(async () => serviceResult);
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(202);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      operation_id: "op_unknown_1",
      status: "unknown",
      amount: 100,
    });
    expect("new_balance" in body).toBe(false);
  });

  test("PENDING / PROCESSING: 202 con status en minúsculas y sin new_balance", async () => {
    for (const status of ["PENDING", "PROCESSING"] as const) {
      const serviceResult: CashInResult = {
        replayed: false,
        operation: {
          id: `op_${status.toLowerCase()}`,
          status,
          amount: new Prisma.Decimal("100.00"),
          balanceAfter: null,
        },
      };
      const cashInMock = mock(async () => serviceResult);
      const service: CashInService = { cashIn: cashInMock };
      const app = createTestApp(service);

      const res = await app.request("/cash-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": VALID_KEY,
        },
        body: JSON.stringify(VALID_BODY),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe(status.toLowerCase());
      expect("new_balance" in body).toBe(false);
    }
  });

  test("FAILED: 422 PAYMENT_DECLINED con operation_id", async () => {
    const serviceResult: CashInResult = {
      replayed: false,
      operation: {
        id: "op_failed_1",
        status: "FAILED",
        amount: new Prisma.Decimal("100.00"),
        balanceAfter: null,
      },
    };
    const cashInMock = mock(async () => serviceResult);
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("PAYMENT_DECLINED");
    expect(problem.operation_id).toBe("op_failed_1");
  });

  test("replayed: true: header Idempotent-Replayed: true en 200, en 202 y en 422 PAYMENT_DECLINED", async () => {
    // 1. Replay on COMPLETED (200)
    {
      const cashInMock = mock(async () => ({
        replayed: true,
        operation: {
          id: "op_replayed_200",
          status: "COMPLETED" as const,
          amount: new Prisma.Decimal("100.00"),
          balanceAfter: new Prisma.Decimal("350.00"),
        },
      }));
      const app = createTestApp({ cashIn: cashInMock });

      const res = await app.request("/cash-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": VALID_KEY,
        },
        body: JSON.stringify(VALID_BODY),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Idempotent-Replayed")).toBe("true");
    }

    // 2. Replay on UNKNOWN (202)
    {
      const cashInMock = mock(async () => ({
        replayed: true,
        operation: {
          id: "op_replayed_202",
          status: "UNKNOWN" as const,
          amount: new Prisma.Decimal("100.00"),
          balanceAfter: null,
        },
      }));
      const app = createTestApp({ cashIn: cashInMock });

      const res = await app.request("/cash-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": VALID_KEY,
        },
        body: JSON.stringify(VALID_BODY),
      });

      expect(res.status).toBe(202);
      expect(res.headers.get("Idempotent-Replayed")).toBe("true");
    }

    // 3. Replay on FAILED (422 PAYMENT_DECLINED)
    {
      const cashInMock = mock(async () => ({
        replayed: true,
        operation: {
          id: "op_replayed_422",
          status: "FAILED" as const,
          amount: new Prisma.Decimal("100.00"),
          balanceAfter: null,
        },
      }));
      const app = createTestApp({ cashIn: cashInMock });

      const res = await app.request("/cash-in", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": VALID_KEY,
        },
        body: JSON.stringify(VALID_BODY),
      });

      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.headers.get("Idempotent-Replayed")).toBe("true");

      const problem = (await res.json()) as ProblemDetails;
      expect(problem.code).toBe("PAYMENT_DECLINED");
      expect(problem.operation_id).toBe("op_replayed_422");
    }
  });

  test("servicio lanza IDEMPOTENCY_KEY_REUSED: 422 sin header Idempotent-Replayed", async () => {
    const cashInMock = mock(async () => {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", { operationId: "op_existing_id" });
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(problem.operation_id).toBe("op_existing_id");
  });

  test("ruta inexistente, por ejemplo GET /nope: 404 NOT_FOUND en application/problem+json", async () => {
    const cashInMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("NOT_FOUND");
  });

  test("toda respuesta trae X-Request-Id y conserva el provisto", async () => {
    const customRequestId = "my-custom-request-id-12345";
    const serviceResult: CashInResult = {
      replayed: false,
      operation: {
        id: "op_test_req_id",
        status: "COMPLETED",
        amount: new Prisma.Decimal("100.00"),
        balanceAfter: new Prisma.Decimal("200.00"),
      },
    };
    const cashInMock = mock(async () => serviceResult);
    const service: CashInService = { cashIn: cashInMock };
    const app = createTestApp(service);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": VALID_KEY,
        [REQUEST_ID_HEADER]: customRequestId,
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(customRequestId);

    const problemRes = await app.request("/nope", {
      headers: {
        [REQUEST_ID_HEADER]: customRequestId,
      },
    });
    expect(problemRes.status).toBe(404);
    expect(problemRes.headers.get(REQUEST_ID_HEADER)).toBe(customRequestId);
  });
});

describe("createApp wiring (unit)", () => {
  test("createApp mounts /cash-in and responds with 400 IDEMPOTENCY_KEY_MISSING when header is omitted", async () => {
    const fakeConfig: Config = {
      DATABASE_URL: "postgresql://fake:fake@localhost:5432/fake",
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_SECRET: "fake-secret",
      PROVIDER_MODE: "fake",
      PROVIDER_BASE_URL: undefined,
      PROVIDER_TIMEOUT_MS: 3000,
      PROVIDER_MAX_RETRIES: 2,
      LOCK_TTL_MS: 15000,
      CASH_IN_MAX_AMOUNT: 10000,
      RECONCILE_INTERVAL_MS: 10000,
      RECONCILE_STALE_MS: 30000,
      RECONCILE_MAX_ATTEMPTS: 5,
      WEBHOOK_TOLERANCE_S: 300,
      NODE_ENV: "test",
      PORT: 3000,
      LOG_LEVEL: "silent",
      POD_ID: "test-pod-1",
    };

    const fakePrisma = {
      cashInOperation: {},
      wallet: {},
    } as unknown as PrismaClient;

    const fakeRedis = {} as unknown as Redis;

    const fakePaymentProvider: PaymentProvider = {
      charge: async () => ({ status: "succeeded", chargeId: "ch_test" }),
      getCharge: async () => ({ status: "not_found" }),
    };

    const fakeLock: Lock = {
      acquire: async () => ({ status: "acquired", release: async () => {} }),
    };

    const deps: AppDeps = {
      config: fakeConfig,
      logger: createLogger({ level: "silent", podId: fakeConfig.POD_ID }),
      prisma: fakePrisma,
      redis: fakeRedis,
      paymentProvider: fakePaymentProvider,
      lock: fakeLock,
    };

    const app = createApp(deps);

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(400);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("IDEMPOTENCY_KEY_MISSING");

    const notFoundRes = await app.request("/unknown-route");
    expect(notFoundRes.status).toBe(404);
    const notFoundProblem = (await notFoundRes.json()) as ProblemDetails;
    expect(notFoundProblem.code).toBe("NOT_FOUND");
  });
});
