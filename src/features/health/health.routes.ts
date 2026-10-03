import { Hono } from "hono";
import type { AppEnv } from "../../infra/correlation";

export type HealthStatus = "ok" | "degraded" | "down";
export type ServiceStatus = "up" | "down";

export interface HealthResponse {
  status: HealthStatus;
  postgres: ServiceStatus;
  redis: ServiceStatus;
}

export interface HealthPrismaClient {
  wallet: {
    findFirst(args?: unknown): Promise<unknown>;
  };
}

export interface HealthRedisClient {
  ping(): Promise<unknown>;
}

export interface HealthDeps {
  prisma: HealthPrismaClient;
  redis: HealthRedisClient;
}

export function createHealthRoutes(deps: HealthDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/health", async (c) => {
    let postgresOk = false;
    let redisOk = false;

    const [pgResult, redisResult] = await Promise.allSettled([
      deps.prisma.wallet.findFirst({ select: { id: true } }),
      deps.redis.ping(),
    ]);

    if (pgResult.status === "fulfilled") {
      postgresOk = true;
    } else {
      c.var.logger?.error(
        { err: pgResult.reason },
        "PostgreSQL health check failed"
      );
    }

    if (redisResult.status === "fulfilled") {
      redisOk = true;
    } else {
      c.var.logger?.warn(
        { err: redisResult.reason },
        "Redis health check failed"
      );
    }

    const postgres: ServiceStatus = postgresOk ? "up" : "down";
    const redis: ServiceStatus = redisOk ? "up" : "down";

    if (!postgresOk) {
      return c.json<HealthResponse>(
        {
          status: "down",
          postgres,
          redis,
        },
        503
      );
    }

    if (!redisOk) {
      return c.json<HealthResponse>(
        {
          status: "degraded",
          postgres,
          redis,
        },
        200
      );
    }

    return c.json<HealthResponse>(
      {
        status: "ok",
        postgres,
        redis,
      },
      200
    );
  });

  return router;
}
