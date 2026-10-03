import { Hono } from "hono";
import { correlation, type AppEnv } from "./infra/correlation";
import type { Config } from "./infra/config";
import type { Logger } from "./infra/logger";
import type { PrismaClient } from "./infra/prisma";
import type { Redis } from "./infra/redis";
import { createHealthRoutes } from "./features/health/health.routes";

export interface AppDeps {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(correlation(deps.logger));

  app.onError((err, c) => {
    c.var.logger?.error({ err }, "Unhandled error");
    return c.json({ error: "Internal Server Error" }, 500);
  });

  const healthRoutes = createHealthRoutes({
    prisma: deps.prisma,
    redis: deps.redis,
  });

  app.route("/", healthRoutes);

  return app;
}
