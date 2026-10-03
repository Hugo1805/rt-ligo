import { describe, expect, test } from "bun:test";
import os from "node:os";
import { loadConfig } from "./config";

const validBaseEnv = {
  DATABASE_URL: "postgresql://cashin:cashin@localhost:5432/cashin",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "secret-key-123",
};

describe("loadConfig", () => {
  test("with complete env, returns typed config and applies defaults", () => {
    const config = loadConfig(validBaseEnv);

    expect(config.DATABASE_URL).toBe(validBaseEnv.DATABASE_URL);
    expect(config.REDIS_URL).toBe(validBaseEnv.REDIS_URL);
    expect(config.WEBHOOK_SECRET).toBe(validBaseEnv.WEBHOOK_SECRET);
    expect(config.PROVIDER_MODE).toBe("fake");
    expect(config.PROVIDER_BASE_URL).toBeUndefined();
    expect(config.PROVIDER_TIMEOUT_MS).toBe(3000);
    expect(config.PROVIDER_MAX_RETRIES).toBe(2);
    expect(config.LOCK_TTL_MS).toBe(15000);
    expect(config.CASH_IN_MAX_AMOUNT).toBe(10000);
    expect(config.RECONCILE_INTERVAL_MS).toBe(10000);
    expect(config.RECONCILE_STALE_MS).toBe(30000);
    expect(config.RECONCILE_MAX_ATTEMPTS).toBe(5);
    expect(config.WEBHOOK_TOLERANCE_S).toBe(300);
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.POD_ID).toBe(os.hostname());
  });

  test("accepts and overrides defaults with custom values", () => {
    const customEnv = {
      ...validBaseEnv,
      PROVIDER_MODE: "http",
      PROVIDER_BASE_URL: "http://mock-psp:3001",
      PROVIDER_TIMEOUT_MS: "5000",
      PROVIDER_MAX_RETRIES: "3",
      LOCK_TTL_MS: "20000",
      CASH_IN_MAX_AMOUNT: "50000",
      RECONCILE_INTERVAL_MS: "15000",
      RECONCILE_STALE_MS: "60000",
      RECONCILE_MAX_ATTEMPTS: "10",
      WEBHOOK_TOLERANCE_S: "600",
      NODE_ENV: "production",
      PORT: "8080",
      LOG_LEVEL: "warn",
      POD_ID: "pod-core-42",
    };

    const config = loadConfig(customEnv);

    expect(config.PROVIDER_MODE).toBe("http");
    expect(config.PROVIDER_BASE_URL).toBe("http://mock-psp:3001");
    expect(config.PROVIDER_TIMEOUT_MS).toBe(5000);
    expect(config.PROVIDER_MAX_RETRIES).toBe(3);
    expect(config.LOCK_TTL_MS).toBe(20000);
    expect(config.CASH_IN_MAX_AMOUNT).toBe(50000);
    expect(config.RECONCILE_INTERVAL_MS).toBe(15000);
    expect(config.RECONCILE_STALE_MS).toBe(60000);
    expect(config.RECONCILE_MAX_ATTEMPTS).toBe(10);
    expect(config.WEBHOOK_TOLERANCE_S).toBe(600);
    expect(config.NODE_ENV).toBe("production");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("warn");
    expect(config.POD_ID).toBe("pod-core-42");
  });

  test("without DATABASE_URL, throws an error naming it", () => {
    const { DATABASE_URL: _, ...envWithoutDb } = validBaseEnv;

    expect(() => loadConfig(envWithoutDb)).toThrow(/DATABASE_URL/);
  });

  test("without REDIS_URL, throws an error naming it", () => {
    const { REDIS_URL: _, ...envWithoutRedis } = validBaseEnv;

    expect(() => loadConfig(envWithoutRedis)).toThrow(/REDIS_URL/);
  });

  test("without WEBHOOK_SECRET, throws an error naming it", () => {
    const { WEBHOOK_SECRET: _, ...envWithoutSecret } = validBaseEnv;

    expect(() => loadConfig(envWithoutSecret)).toThrow(/WEBHOOK_SECRET/);
  });

  test("with PROVIDER_MODE=http and without PROVIDER_BASE_URL, throws an error", () => {
    const env = {
      ...validBaseEnv,
      PROVIDER_MODE: "http",
    };

    expect(() => loadConfig(env)).toThrow(/PROVIDER_BASE_URL/);
  });

  test("with PROVIDER_MODE=http and empty PROVIDER_BASE_URL, throws an error", () => {
    const env = {
      ...validBaseEnv,
      PROVIDER_MODE: "http",
      PROVIDER_BASE_URL: "   ",
    };

    expect(() => loadConfig(env)).toThrow(/PROVIDER_BASE_URL/);
  });

  test("non-numeric PROVIDER_TIMEOUT_MS throws an error", () => {
    const env = {
      ...validBaseEnv,
      PROVIDER_TIMEOUT_MS: "not-a-number",
    };

    expect(() => loadConfig(env)).toThrow(/PROVIDER_TIMEOUT_MS/);
  });

  test("non-positive numeric fields throw an error", () => {
    expect(() =>
      loadConfig({
        ...validBaseEnv,
        PORT: "-1",
      })
    ).toThrow(/PORT/);

    expect(() =>
      loadConfig({
        ...validBaseEnv,
        PROVIDER_TIMEOUT_MS: "0",
      })
    ).toThrow(/PROVIDER_TIMEOUT_MS/);
  });

  test("accepts PROVIDER_MAX_RETRIES=0 to disable retries", () => {
    expect(loadConfig({ ...validBaseEnv, PROVIDER_MAX_RETRIES: "0" }).PROVIDER_MAX_RETRIES).toBe(0);
  });

  test("lists every invalid variable at once, including the provider refinement", () => {
    const { DATABASE_URL: _, ...env } = validBaseEnv;

    expect(() => loadConfig({ ...env, PROVIDER_MODE: "http" })).toThrow(
      /DATABASE_URL[\s\S]*PROVIDER_BASE_URL/
    );
  });

  test("error message does not contain secret values like WEBHOOK_SECRET", () => {
    const secretValue = "super-secret-vault-token-xyz-987";
    const env = {
      REDIS_URL: "redis://localhost:6379",
      WEBHOOK_SECRET: secretValue,
      // DATABASE_URL omitted intentionally to trigger an error
    };

    let caughtError: Error | undefined;
    try {
      loadConfig(env);
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toContain("DATABASE_URL");
    expect(caughtError?.message).not.toContain(secretValue);
  });

  test("does not read process.env if env object is provided", () => {
    // Passing an empty object should fail on required variables regardless of process.env
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
