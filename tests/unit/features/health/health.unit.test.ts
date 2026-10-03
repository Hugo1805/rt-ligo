import { describe, expect, test } from "bun:test";
import { createApp, type AppDeps } from "../../../../src/app";
import { createLogger } from "../../../../src/infra/logger";
import type { Config } from "../../../../src/infra/config";
import type { PrismaClient } from "../../../../src/infra/prisma";
import type { Redis } from "../../../../src/infra/redis";
import type { Lock } from "../../../../src/infra/lock";
import type { PaymentProvider } from "../../../../src/infra/payment-provider/payment-provider";
import { REQUEST_ID_HEADER } from "../../../../src/infra/correlation";

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

function createFakeDeps(
  overrides: {
    prismaHealthy?: boolean;
    redisHealthy?: boolean;
  } = {}
): AppDeps {
  const { prismaHealthy = true, redisHealthy = true } = overrides;

  const fakePrisma = {
    wallet: {
      findFirst: async () => {
        if (!prismaHealthy) {
          throw new Error("Database connection error");
        }
        return { id: "wallet-test-id" };
      },
    },
  } as unknown as PrismaClient;

  const fakeRedis = {
    ping: async () => {
      if (!redisHealthy) {
        throw new Error("Redis connection refused");
      }
      return "PONG";
    },
  } as unknown as Redis;

  const logger = createLogger({ level: "silent", podId: fakeConfig.POD_ID });

  const fakePaymentProvider: PaymentProvider = {
    charge: async () => ({ status: "succeeded", chargeId: "ch_test" }),
    getCharge: async () => ({ status: "not_found" }),
  };

  const fakeLock: Lock = {
    acquire: async () => ({
      status: "acquired",
      release: async () => {},
    }),
  };

  return {
    config: fakeConfig,
    logger,
    prisma: fakePrisma,
    redis: fakeRedis,
    paymentProvider: fakePaymentProvider,
    lock: fakeLock,
  };
}

describe("GET /health (unit)", () => {
  test("responds 200 ok when both Prisma and Redis are healthy", async () => {
    const deps = createFakeDeps({ prismaHealthy: true, redisHealthy: true });
    const app = createApp(deps);

    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      postgres: string;
      redis: string;
    };
    expect(body).toEqual({
      status: "ok",
      postgres: "up",
      redis: "up",
    });

    const requestId = res.headers.get(REQUEST_ID_HEADER);
    expect(requestId).toBeDefined();
    expect(requestId?.length).toBeGreaterThan(0);
  });

  test("responds 200 degraded when Redis is down and Postgres is healthy", async () => {
    const deps = createFakeDeps({ prismaHealthy: true, redisHealthy: false });
    const app = createApp(deps);

    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      postgres: string;
      redis: string;
    };
    expect(body).toEqual({
      status: "degraded",
      postgres: "up",
      redis: "down",
    });

    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();
  });

  test("responds 503 when Postgres is down and Redis is healthy", async () => {
    const deps = createFakeDeps({ prismaHealthy: false, redisHealthy: true });
    const app = createApp(deps);

    const res = await app.request("/health");
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      status: string;
      postgres: string;
      redis: string;
    };
    expect(body).toEqual({
      status: "down",
      postgres: "down",
      redis: "up",
    });

    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();
  });

  test("responds 503 when both Postgres and Redis are down", async () => {
    const deps = createFakeDeps({ prismaHealthy: false, redisHealthy: false });
    const app = createApp(deps);

    const res = await app.request("/health");
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      status: string;
      postgres: string;
      redis: string;
    };
    expect(body).toEqual({
      status: "down",
      postgres: "down",
      redis: "down",
    });
  });

  test("preserves incoming valid X-Request-Id header", async () => {
    const deps = createFakeDeps();
    const app = createApp(deps);

    const customId = "trace-client-abc-123";
    const res = await app.request("/health", {
      headers: {
        [REQUEST_ID_HEADER]: customId,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(customId);
  });
});
