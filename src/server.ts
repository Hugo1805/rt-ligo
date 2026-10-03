import { loadConfig } from "./infra/config";
import { createLogger } from "./infra/logger";
import { createPrismaClient } from "./infra/prisma";
import { createRedisClient } from "./infra/redis";
import { createRedisLock } from "./infra/lock";
import { createApp } from "./app";
import { createReconciler } from "./features/reconciliation/reconciliation.service";
import { createWalletService } from "./features/wallet/wallet.service";
import { FakePaymentProvider } from "./infra/payment-provider/fake.provider";
import { HttpPaymentProvider } from "./infra/payment-provider/http.provider";
import type { PaymentProvider } from "./infra/payment-provider/payment-provider";

const config = loadConfig();
const logger = createLogger({
  level: config.LOG_LEVEL,
  podId: config.POD_ID,
});

const prisma = createPrismaClient(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL);
const lock = createRedisLock(redis);

export const paymentProvider: PaymentProvider =
  config.PROVIDER_MODE === "http"
    ? new HttpPaymentProvider(
        config.PROVIDER_BASE_URL!,
        config.PROVIDER_TIMEOUT_MS,
        logger
      )
    : new FakePaymentProvider();

const app = createApp({
  config,
  logger,
  prisma,
  redis,
  paymentProvider,
  lock,
});

export const server = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
});

logger.info({ port: config.PORT }, `Server started on port ${config.PORT}`);

// Reconciler: runs in every pod, coordinated only through the lease in PostgreSQL.
const walletService = createWalletService({ prisma });
const reconciler = createReconciler({
  prisma,
  paymentProvider,
  applyCredit: walletService.applyCredit,
  logger,
  config,
  podId: config.POD_ID,
});
reconciler.start();

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
    // Wait for the cycle in progress so it never writes to a disconnected Prisma.
    await reconciler.stop();
  } catch (err) {
    logger.error({ err }, "Error stopping reconciler");
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
