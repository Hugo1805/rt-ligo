import type { Hono } from "hono";
import { createApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/infra/config";
import type { AppEnv } from "../../src/infra/correlation";
import { createRedisLock, type Lock } from "../../src/infra/lock";
import { createLogger, type Logger } from "../../src/infra/logger";
import type { PaymentProvider } from "../../src/infra/payment-provider/payment-provider";
import { createPrismaClient, type PrismaClient } from "../../src/infra/prisma";
import { createRedisClient, type Redis } from "../../src/infra/redis";

export interface Pod {
  app: Hono<AppEnv>;
  prisma: PrismaClient;
  redis: Redis;
  lock: Lock;
  logger: Logger;
  config: Config;
  paymentProvider: PaymentProvider;
}

export interface CreatePodsOptions {
  provider: PaymentProvider;
  redisUrl?: string;
}

export function createPods(n: number, options: CreatePodsOptions): Pod[] {
  const baseConfig = loadConfig();
  const pods: Pod[] = [];

  for (let i = 0; i < n; i++) {
    const config: Config = {
      ...baseConfig,
      POD_ID: `test-pod-${i + 1}`,
      ...(options.redisUrl ? { REDIS_URL: options.redisUrl } : {}),
    };
    const logger = createLogger({ level: "silent", podId: config.POD_ID });
    const prisma = createPrismaClient(config.DATABASE_URL);
    const redis = createRedisClient(config.REDIS_URL);
    const lock = createRedisLock(redis);
    const app = createApp({
      config,
      logger,
      prisma,
      redis,
      paymentProvider: options.provider,
      lock,
    });

    pods.push({
      app,
      prisma,
      redis,
      lock,
      logger,
      config,
      paymentProvider: options.provider,
    });
  }

  return pods;
}

export async function closePods(pods: Pod[]): Promise<void> {
  await Promise.allSettled(
    pods.map(async (pod) => {
      await pod.prisma.$disconnect().catch(() => {});
      try {
        await Promise.race([
          pod.redis.quit(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("redis quit timeout")), 300)
          ),
        ]);
      } catch {
        pod.redis.disconnect();
      }
    })
  );
}
