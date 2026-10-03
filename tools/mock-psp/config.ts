import { z } from "zod";

export const mockConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  MOCK_PSP_WEBHOOK_URL: z.string().min(1, "MOCK_PSP_WEBHOOK_URL is required"),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  MOCK_PSP_TIMEOUT_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5000),
  MOCK_PSP_WEBHOOK_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(1000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type MockConfig = z.infer<typeof mockConfigSchema>;

export function loadMockConfig(
  env: Record<string, string | undefined> = process.env
): MockConfig {
  const result = mockConfigSchema.safeParse(env);

  if (!result.success) {
    const errorList = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    });

    throw new Error(
      `Invalid mock-psp configuration:\n${errorList
        .map((msg) => `  - ${msg}`)
        .join("\n")}`
    );
  }

  return result.data;
}
