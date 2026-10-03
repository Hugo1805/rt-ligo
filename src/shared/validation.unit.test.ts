import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { issuesToFieldErrors, validationHook } from "./validation";
import {
  cashInHeadersSchema,
  createCashInRequestSchema,
  idempotencyHeaderHook,
} from "../features/cash-in/cash-in.schemas";
import { errorHandler } from "./error-handler";
import {
  correlation,
  REQUEST_ID_HEADER,
  type CorrelationEnv,
} from "../infra/correlation";
import { createLogger } from "../infra/logger";

function createSilentLogger() {
  const stream = { write() {} };
  return createLogger({ level: "silent", podId: "test-pod" }, stream);
}

describe("issuesToFieldErrors", () => {
  test("maps flat and nested issues to FieldError objects", () => {
    const issues = [
      { path: ["amount"], message: "Máximo 2 decimales" },
      { path: ["data", "reference"], message: "Required" },
      { path: [], message: "Root issue" },
    ];

    const result = issuesToFieldErrors(issues);
    expect(result).toEqual([
      { field: "amount", message: "Máximo 2 decimales" },
      { field: "data.reference", message: "Required" },
      { field: "", message: "Root issue" },
    ]);
  });

  test("reports each key rejected by .strict() as its own field", () => {
    const result = createCashInRequestSchema(10000).safeParse({
      user_id: "usr_1",
      amount: 100,
      currency: "PEN",
      payment_method: "card_ok",
      ammount: 5,
      foo: 1,
    });

    expect(result.success).toBe(false);
    expect(issuesToFieldErrors(result.error!.issues)).toEqual([
      { field: "ammount", message: "Campo no permitido" },
      { field: "foo", message: "Campo no permitido" },
    ]);
  });
});

describe("validation hooks integration", () => {
  const logger = createSilentLogger();

  function createApp() {
    let handlerCalled = false;
    const app = new Hono<CorrelationEnv>();
    app.onError(errorHandler);
    app.use(correlation(logger));

    app.post(
      "/cash-in",
      zValidator("header", cashInHeadersSchema, idempotencyHeaderHook),
      zValidator("json", createCashInRequestSchema(10000), validationHook),
      (c) => {
        handlerCalled = true;
        const validBody = c.req.valid("json");
        return c.json({ ok: true, data: validBody });
      }
    );

    return {
      app,
      wasHandlerCalled: () => handlerCalled,
      resetHandlerCalled: () => {
        handlerCalled = false;
      },
    };
  }

  test("missing key with invalid body returns 400 IDEMPOTENCY_KEY_MISSING (key validation wins)", async () => {
    const { app, wasHandlerCalled } = createApp();

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: -10 }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("IDEMPOTENCY_KEY_MISSING");
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/idempotency-key-missing");
    expect(body.title).toBe("Idempotency-Key ausente");
    expect(body.errors).toEqual([]);
    expect(wasHandlerCalled()).toBe(false);
  });

  test("invalid key with invalid body returns 400 IDEMPOTENCY_KEY_INVALID (key validation wins)", async () => {
    const { app, wasHandlerCalled } = createApp();

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "not-a-valid-uuid",
      },
      body: JSON.stringify({ amount: -10 }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/idempotency-key-invalid");
    expect(body.title).toBe("Idempotency-Key inválida");
    expect(body.errors).toEqual([]);
    expect(wasHandlerCalled()).toBe(false);
  });

  test("valid key with invalid body returns 400 VALIDATION_ERROR with errors per field", async () => {
    const { app, wasHandlerCalled } = createApp();

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        user_id: "",
        amount: 100.555,
        currency: "USD",
        payment_method: "   ",
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const body = (await res.json()) as {
      code: string;
      type: string;
      errors: Array<{ field: string; message: string }>;
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/validation-error");
    expect(body.errors.length).toBeGreaterThanOrEqual(4);

    const fields = body.errors.map((e) => e.field);
    expect(fields).toContain("user_id");
    expect(fields).toContain("amount");
    expect(fields).toContain("currency");
    expect(fields).toContain("payment_method");
    expect(wasHandlerCalled()).toBe(false);
  });

  test("non-JSON body with application/json header returns 400 VALIDATION_ERROR", async () => {
    const { app, wasHandlerCalled } = createApp();

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: "{no json",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");

    const body = (await res.json()) as { code: string; detail: string; errors: unknown[] };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.detail).toBe("El body no es JSON válido.");
    expect(body.errors).toEqual([]);
    expect(wasHandlerCalled()).toBe(false);
  });

  test("valid key and valid body executes handler and returns 200", async () => {
    const { app, wasHandlerCalled } = createApp();
    const idempotencyKey = crypto.randomUUID();

    const res = await app.request("/cash-in", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        user_id: "usr_valid",
        amount: 250.75,
        currency: "PEN",
        payment_method: "card_visa",
      }),
    });

    expect(res.status).toBe(200);
    expect(wasHandlerCalled()).toBe(true);

    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.user_id).toBe("usr_valid");
    expect(body.data.amount).toBe(250.75);
    expect(body.data.currency).toBe("PEN");
  });
});
