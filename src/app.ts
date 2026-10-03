import { Hono } from "hono";
import { correlation, type AppEnv } from "./infra/correlation";
import type { Config } from "./infra/config";
import type { Logger } from "./infra/logger";
import type { PrismaClient } from "./infra/prisma";
import type { Redis } from "./infra/redis";
import type { Lock } from "./infra/lock";
import type { PaymentProvider } from "./infra/payment-provider/payment-provider";
import { createHealthRoutes } from "./features/health/health.routes";
import { createCashInRoutes } from "./features/cash-in/cash-in.routes";
import { createCashInRepository } from "./features/cash-in/cash-in.repository";
import { createWalletService } from "./features/wallet/wallet.service";
import { createCashInService } from "./features/cash-in/cash-in.service";
import { errorHandler, notFoundHandler } from "./shared/error-handler";

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  paymentProvider: PaymentProvider;
  lock: Lock;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(correlation(deps.logger));

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  const healthRoutes = createHealthRoutes({
    prisma: deps.prisma,
    redis: deps.redis,
  });

  const cashInRepository = createCashInRepository(deps.prisma);
  const walletService = createWalletService({ prisma: deps.prisma });
  const cashInService = createCashInService({
    repository: cashInRepository,
    walletService,
    lock: deps.lock,
    paymentProvider: deps.paymentProvider,
    config: deps.config,
  });

  const cashInRoutes = createCashInRoutes(cashInService, deps.config);

  app.route("/", healthRoutes);
  app.route("/", cashInRoutes);

  return app;
}
