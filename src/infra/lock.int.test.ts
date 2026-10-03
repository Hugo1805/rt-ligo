import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { createRedisClient, type Redis } from "./redis";
import { createRedisLock, type Lock } from "./lock";

describe("Redis Lock (integration)", () => {
  let redis: Redis;
  let lock: Lock;
  let redisUrl: string;
  const logger = createLogger({ level: "silent" });

  beforeAll(() => {
    const config = loadConfig();
    redisUrl = config.REDIS_URL;
    redis = createRedisClient(redisUrl);
    lock = createRedisLock(redis);
  });

  afterAll(async () => {
    await redis.quit().catch(() => redis.disconnect());
  });

  test("dos acquire seguidos sobre la misma key: el primero acquired, el segundo busy", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const res1 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res1.status).toBe("acquired");

    const res2 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res2.status).toBe("busy");

    if (res1.status === "acquired") {
      await res1.release();
    }
  });

  test("tras release(), un nuevo acquire obtiene el lock", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const res1 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res1.status).toBe("acquired");

    if (res1.status === "acquired") {
      await res1.release();
    }

    const res2 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res2.status).toBe("acquired");

    if (res2.status === "acquired") {
      await res2.release();
    }
  });

  test("el lock expira solo por TTL", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const res1 = await lock.acquire(key, { ttlMs: 200, logger });
    expect(res1.status).toBe("acquired");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const res2 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res2.status).toBe("acquired");

    if (res2.status === "acquired") {
      await res2.release();
    }
  });

  test("un dueño cuyo lock expiró y fue tomado por otro llama release() y no borra el lock ajeno", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const res1 = await lock.acquire(key, { ttlMs: 150, logger });
    expect(res1.status).toBe("acquired");

    await new Promise((resolve) => setTimeout(resolve, 250));

    const res2 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res2.status).toBe("acquired");

    // Owner 1 releases after expiry
    if (res1.status === "acquired") {
      await res1.release();
    }

    // Owner 3 attempts to acquire - should be busy because Owner 2 still holds the lock
    const res3 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res3.status).toBe("busy");

    if (res2.status === "acquired") {
      await res2.release();
    }

    const res4 = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res4.status).toBe("acquired");

    if (res4.status === "acquired") {
      await res4.release();
    }
  });

  test("release() es idempotente: llamarlo dos veces no falla", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const res = await lock.acquire(key, { ttlMs: 10000, logger });
    expect(res.status).toBe("acquired");

    if (res.status === "acquired") {
      await res.release();
      await expect(res.release()).resolves.toBeUndefined();
    }
  });

  test("con 10 intentos concurrentes desde 3 clientes, exactamente uno obtiene el lock", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const client1 = createRedisClient(redisUrl);
    const client2 = createRedisClient(redisUrl);
    const client3 = createRedisClient(redisUrl);
    const clients = [client1, client2, client3];
    const locks = clients.map((c) => createRedisLock(c));

    try {
      const attempts = Array.from({ length: 10 }, (_, i) => {
        const lockClient = locks[i % 3];
        if (!lockClient) {
          throw new Error("Missing lock client");
        }
        return lockClient.acquire(key, { ttlMs: 15000, logger });
      });

      const results = await Promise.all(attempts);

      const acquired = results.filter((r) => r.status === "acquired");
      const busy = results.filter((r) => r.status === "busy");

      expect(acquired.length).toBe(1);
      expect(busy.length).toBe(9);

      const winner = acquired[0];
      expect(winner).toBeDefined();
      if (winner && winner.status === "acquired") {
        await winner.release();
      }
    } finally {
      await Promise.allSettled(
        clients.map((c) => c.quit().catch(() => c.disconnect()))
      );
    }
  });

  test("con Redis caído, acquire devuelve unavailable en menos de 1 s y se registra un warning", async () => {
    const key = `lock:test:${crypto.randomUUID()}`;

    const warnedEvents: Array<{ event?: string; key?: string; err?: unknown }> = [];
    const testLogger = {
      warn: (obj: Record<string, unknown>) => {
        warnedEvents.push(obj as { event?: string; key?: string; err?: unknown });
      },
    };

    const deadRedis = createRedisClient("redis://localhost:6399");
    const deadLock = createRedisLock(deadRedis);

    try {
      const start = Date.now();
      const result = await deadLock.acquire(key, { ttlMs: 1000, logger: testLogger });
      const elapsed = Date.now() - start;

      expect(result.status).toBe("unavailable");
      expect(elapsed).toBeLessThan(1000);
      expect(warnedEvents.length).toBeGreaterThanOrEqual(1);

      const firstWarning = warnedEvents[0];
      expect(firstWarning).toBeDefined();
      expect(firstWarning?.event).toBe("lock.unavailable");
      expect(firstWarning?.key).toBe(key);
      expect(firstWarning?.err).toBeDefined();
    } finally {
      await deadRedis.quit().catch(() => deadRedis.disconnect());
    }
  });
});
