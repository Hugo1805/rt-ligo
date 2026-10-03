import { z } from "zod";

export const e2eEnvSchema = z.object({
  E2E_NGINX_URL: z.string().url(),
  E2E_APP1_URL: z.string().url(),
  E2E_APP2_URL: z.string().url(),
  E2E_MOCK_PSP_URL: z.string().url(),
  E2E_DATABASE_URL: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
});

export type E2EEnv = z.infer<typeof e2eEnvSchema>;

export function loadE2EEnv(
  env: Record<string, string | undefined> = process.env
): E2EEnv {
  const result = e2eEnvSchema.safeParse(env);
  if (!result.success) {
    const errorList = result.error.issues.map((issue) => {
      const field = issue.path.join(".");
      return field ? `  - ${field}: ${issue.message}` : `  - ${issue.message}`;
    });
    throw new Error(
      `Invalid or missing E2E environment configuration:\n${errorList.join("\n")}`
    );
  }
  return result.data;
}

export const e2eEnv = loadE2EEnv();
