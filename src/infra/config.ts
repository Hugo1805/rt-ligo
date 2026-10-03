import os from "node:os";
import { z } from "zod";

export const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
    PROVIDER_MODE: z.enum(["fake", "http"]).default("fake"),
    PROVIDER_BASE_URL: z.string().optional(),
    PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    PROVIDER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    LOCK_TTL_MS: z.coerce.number().int().positive().default(15000),
    CASH_IN_MAX_AMOUNT: z.coerce.number().int().positive().default(10000),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    RECONCILE_STALE_MS: z.coerce.number().int().positive().default(30000),
    RECONCILE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    WEBHOOK_TOLERANCE_S: z.coerce.number().int().positive().default(300),
    NODE_ENV: z.string().min(1).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    POD_ID: z.string().min(1).default(() => os.hostname()),
  })
  .refine(
    (data) => {
      if (data.PROVIDER_MODE === "http") {
        return Boolean(data.PROVIDER_BASE_URL && data.PROVIDER_BASE_URL.trim().length > 0);
      }
      return true;
    },
    {
      message: "PROVIDER_BASE_URL is required when PROVIDER_MODE is http",
      path: ["PROVIDER_BASE_URL"],
      // Run even when other fields failed, so the error lists every invalid variable.
      when: () => true,
    }
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errorList = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    });

    throw new Error(
      `Invalid environment configuration:\n${errorList
        .map((msg) => `  - ${msg}`)
        .join("\n")}`
    );
  }

  return result.data;
}
