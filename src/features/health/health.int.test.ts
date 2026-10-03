import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../app";
import { loadConfig } from "../../infra/config";
import { createLogger } from "../../infra/logger";
import { createPrismaClient, type PrismaClient } from "../../infra/prisma";
import { createRedisClient, type Redis } from "../../infra/redis";
import { REQUEST_ID_HEADER } from "../../infra/correlation";

describe("GET /health (integration)", () => {
  let prisma: PrismaClient;
  let redis: Redis;

  beforeAll(() => {
    const config = loadConfig();
    prisma = createPrismaClient(config.DATABASE_URL);
    redis = createRedisClient(config.REDIS_URL);
  });

  afterAll(async () => {
    await Promise.allSettled([
      prisma.$disconnect(),
      redis.quit().catch(() => redis.disconnect()),
    ]);
  });

  test("responds 200 ok with real Postgres and Redis", async () => {
    const config = loadConfig();
    const logger = createLogger({ level: "silent", podId: "pod-int-test" });

    const app = createApp({
      config,
      logger,
      prisma,
      redis,
    });

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

  test("supports multiple concurrent app instances simulating pods", async () => {
    const config = loadConfig();

    const prisma1 = createPrismaClient(config.DATABASE_URL);
    const redis1 = createRedisClient(config.REDIS_URL);
    const app1 = createApp({
      config,
      logger: createLogger({ level: "silent", podId: "pod-1" }),
      prisma: prisma1,
      redis: redis1,
    });

    const prisma2 = createPrismaClient(config.DATABASE_URL);
    const redis2 = createRedisClient(config.REDIS_URL);
    const app2 = createApp({
      config,
      logger: createLogger({ level: "silent", podId: "pod-2" }),
      prisma: prisma2,
      redis: redis2,
    });

    try {
      const [res1, res2] = await Promise.all([
        app1.request("/health"),
        app2.request("/health"),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = (await res1.json()) as { status: string };
      const body2 = (await res2.json()) as { status: string };

      expect(body1.status).toBe("ok");
      expect(body2.status).toBe("ok");

      const reqId1 = res1.headers.get(REQUEST_ID_HEADER);
      const reqId2 = res2.headers.get(REQUEST_ID_HEADER);

      expect(reqId1).toBeDefined();
      expect(reqId2).toBeDefined();
      expect(reqId1).not.toBe(reqId2);
    } finally {
      await Promise.allSettled([
        prisma1.$disconnect(),
        prisma2.$disconnect(),
        redis1.quit().catch(() => redis1.disconnect()),
        redis2.quit().catch(() => redis2.disconnect()),
      ]);
    }
  });
});
