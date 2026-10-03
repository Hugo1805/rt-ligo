import { loadConfig } from "./infra/config";
import { createLogger } from "./infra/logger";
import { createPrismaClient } from "./infra/prisma";
import { createRedisClient } from "./infra/redis";
import { createApp } from "./app";

const config = loadConfig();
const logger = createLogger({
  level: config.LOG_LEVEL,
  podId: config.POD_ID,
});

const prisma = createPrismaClient(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL);

const app = createApp({
  config,
  logger,
  prisma,
  redis,
});

export const server = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
});

logger.info({ port: config.PORT }, `Server started on port ${config.PORT}`);

let isShuttingDown = false;

export async function shutdown(signal: string = "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Shutting down gracefully...");

  try {
    // Stop accepting connections and wait for in-flight requests before disconnecting.
    await server.stop();
  } catch (err) {
    logger.error({ err }, "Error stopping server");
  }

  try {
    await Promise.allSettled([
      prisma.$disconnect(),
      redis.quit().catch(() => redis.disconnect()),
    ]);
  } catch (err) {
    logger.error({ err }, "Error disconnecting database and redis clients");
  }

  logger.info("Graceful shutdown complete");
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => {
    process.exit(0);
  });
});
