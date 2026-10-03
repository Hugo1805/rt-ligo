import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ERROR_CATALOG,
  AppError,
  type ErrorCode,
  type FieldError,
} from "./errors";
import {
  errorHandler,
  notFoundHandler,
  toProblem,
  type ProblemDetails,
} from "./error-handler";
import {
  correlation,
  REQUEST_ID_HEADER,
  type CorrelationEnv,
} from "../infra/correlation";
import { createLogger } from "../infra/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createTestLogger() {
  const logs: Record<string, unknown>[] = [];
  const stream = {
    write(msg: string) {
      logs.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const logger = createLogger({ level: "debug", podId: "test-pod" }, stream);
  return { logger, logs };
}

describe("toProblem", () => {
  test("generates RFC 9457 compliant problem details for every catalog code", () => {
    const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];

    for (const code of codes) {
      const catalog = ERROR_CATALOG[code];
      const problem = toProblem(code, { requestId: "req-123" });

      const expectedKebab = code.toLowerCase().replaceAll("_", "-");
      expect(problem.type).toBe(`https://errors.ligo.pe/cash-in/${expectedKebab}`);
      expect(problem.title).toBe(catalog.title);
      expect(problem.status).toBe(catalog.status);
      expect(problem.code).toBe(code);
      expect(problem.request_id).toBe("req-123");
      expect(problem.retryable).toBe(catalog.retryable);
      expect(problem.errors).toEqual([]);
      expect("operation_id" in problem).toBe(false);
      expect(problem.operation_id).toBeUndefined();
    }
  });

  test("includes operation_id only when provided", () => {
    const withoutOp = toProblem("PAYMENT_DECLINED", { requestId: "req-1" });
    expect("operation_id" in withoutOp).toBe(false);
    expect(JSON.stringify(withoutOp)).not.toContain("operation_id");

    const withOp = toProblem("PAYMENT_DECLINED", {
      requestId: "req-1",
      operationId: "op_abc123",
    });
    expect(withOp.operation_id).toBe("op_abc123");
    expect(JSON.parse(JSON.stringify(withOp)).operation_id).toBe("op_abc123");
  });

  test("accepts an AppError instance directly", () => {
    const appError = new AppError("CURRENCY_MISMATCH", {
      detail: "Solo se acepta PEN",
      operationId: "op_cur_99",
    });

    const problem = toProblem(appError, "req-xyz");
    expect(problem.code).toBe("CURRENCY_MISMATCH");
    expect(problem.status).toBe(422);
    expect(problem.detail).toBe("Solo se acepta PEN");
    expect(problem.operation_id).toBe("op_cur_99");
    expect(problem.request_id).toBe("req-xyz");
    expect(problem.retryable).toBe(false);
    expect(problem.errors).toEqual([]);
  });

  test("preserves validation errors when provided", () => {
    const errors: FieldError[] = [
      { field: "amount", message: "Máximo 2 decimales" },
      { field: "currency", message: "Solo se acepta PEN" },
    ];

    const problem = toProblem("VALIDATION_ERROR", {
      requestId: "req-v",
      errors,
    });

    expect(problem.errors).toEqual(errors);
  });
});

describe("errorHandler", () => {
  test("AppError PAYMENT_DECLINED responds 422, problem+json, operation_id and matching request_id", async () => {
    const { logger } = createTestLogger();
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.onError(errorHandler);

    app.post("/test-decline", () => {
      throw new AppError("PAYMENT_DECLINED", { operationId: "op_1" });
    });

    const res = await app.request("/test-decline", {
      method: "POST",
      headers: {
        [REQUEST_ID_HEADER]: "test-corr-req-id-1",
      },
    });

    expect(res.status).toBe(422);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("test-corr-req-id-1");

    const body = (await res.json()) as ProblemDetails;
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/payment-declined");
    expect(body.title).toBe("Pago rechazado");
    expect(body.status).toBe(422);
    expect(body.code).toBe("PAYMENT_DECLINED");
    expect(body.request_id).toBe("test-corr-req-id-1");
    expect(body.operation_id).toBe("op_1");
    expect(body.retryable).toBe(false);
    expect(body.errors).toEqual([]);
  });

  test("OPERATION_IN_PROGRESS includes Retry-After: 1 header", async () => {
    const app = new Hono();
    app.onError(errorHandler);

    app.get("/lock-busy", () => {
      throw new AppError("OPERATION_IN_PROGRESS");
    });

    const res = await app.request("/lock-busy");
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get("Retry-After")).toBe("1");

    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("OPERATION_IN_PROGRESS");
    expect(body.retryable).toBe(true);
  });

  test("SERVICE_UNAVAILABLE includes Retry-After: 2 header", async () => {
    const app = new Hono();
    app.onError(errorHandler);

    app.get("/db-down", () => {
      throw new AppError("SERVICE_UNAVAILABLE");
    });

    const res = await app.request("/db-down");
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get("Retry-After")).toBe("2");

    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.retryable).toBe(true);
  });

  test("unknown error responds 500 INTERNAL_ERROR without leaking message or stack", async () => {
    const { logger, logs } = createTestLogger();
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.onError(errorHandler);

    app.get("/crash", () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    });

    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");

    const text = await res.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("5432");
    expect(text).not.toContain("stack");

    const body = JSON.parse(text) as ProblemDetails;
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/internal-error");
    expect(body.title).toBe("Error interno del servidor");
    expect(body.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.detail).toBe("Ocurrió un error inesperado en el servidor.");
    expect(body.retryable).toBe(true);
    expect(body.errors).toEqual([]);
    expect("operation_id" in body).toBe(false);
    expect(body.request_id).toMatch(UUID_REGEX);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.request_id);

    // Verify stack appears in logger, not in response
    const errorLogs = logs.filter((l) => l["level"] === 50); // 50 is pino error level
    expect(errorLogs.length).toBeGreaterThan(0);
    const errLog = errorLogs[0]!;
    expect(errLog["code"]).toBe("INTERNAL_ERROR");
    expect(errLog["err"]).toBeDefined();
    const serializedErr = errLog["err"] as Record<string, unknown>;
    expect(serializedErr["message"]).toBe("connect ECONNREFUSED 10.0.0.5:5432");
    expect(typeof serializedErr["stack"]).toBe("string");
  });

  test("HTTPException(400) maps to VALIDATION_ERROR without copying its message", async () => {
    const app = new Hono();
    app.onError(errorHandler);

    app.post("/malformed-json", () => {
      throw new HTTPException(400, {
        message: "Malformed JSON in request body",
      });
    });

    const res = await app.request("/malformed-json", { method: "POST" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");

    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.title).toBe("Request inválido");
    expect(body.status).toBe(400);
    expect(body.detail).toBe("El body no es JSON válido.");
    expect(body.detail).not.toContain("Malformed JSON");
    expect(body.errors).toEqual([]);
    expect(body.retryable).toBe(false);
  });

  test("VALIDATION_ERROR with errors returns them untouched", async () => {
    const app = new Hono();
    app.onError(errorHandler);

    const fieldErrors: FieldError[] = [
      { field: "amount", message: "Máximo 2 decimales" },
      { field: "currency", message: "Solo se acepta PEN" },
    ];

    app.post("/validate", () => {
      throw new AppError("VALIDATION_ERROR", {
        detail: "El body no cumple el contrato de POST /cash-in.",
        errors: fieldErrors,
      });
    });

    const res = await app.request("/validate", { method: "POST" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");

    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.detail).toBe("El body no cumple el contrato de POST /cash-in.");
    expect(body.errors).toEqual(fieldErrors);
    expect(body.retryable).toBe(false);
  });

  test("logs 4xx errors with warn level and 5xx errors with error level", async () => {
    const { logger, logs } = createTestLogger();
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.onError(errorHandler);

    app.get("/client-err", () => {
      throw new AppError("WALLET_NOT_FOUND");
    });
    app.get("/server-err", () => {
      throw new Error("unhandled db crash");
    });

    await app.request("/client-err");
    const warnLogs = logs.filter((l) => l["level"] === 40); // 40 is pino warn level
    expect(warnLogs.length).toBeGreaterThan(0);
    const clientWarn = warnLogs.find((l) => l["code"] === "WALLET_NOT_FOUND");
    expect(clientWarn).toBeDefined();
    expect(clientWarn?.["status"]).toBe(404);

    await app.request("/server-err");
    const errLogs = logs.filter((l) => l["level"] === 50); // 50 is pino error level
    expect(errLogs.length).toBeGreaterThan(0);
    const serverErr = errLogs.find((l) => l["code"] === "INTERNAL_ERROR");
    expect(serverErr).toBeDefined();
    expect(serverErr?.["status"]).toBe(500);
  });

  test("generates a new UUID request_id if correlation middleware did not run", async () => {
    const app = new Hono();
    app.onError(errorHandler);

    app.get("/no-middleware", () => {
      throw new AppError("IDEMPOTENCY_KEY_MISSING");
    });

    const res = await app.request("/no-middleware");
    expect(res.status).toBe(400);

    const body = (await res.json()) as ProblemDetails;
    expect(body.request_id).toMatch(UUID_REGEX);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.request_id);
  });
});

describe("notFoundHandler", () => {
  test("responds 404 NOT_FOUND in problem+json with errors: [] and matching request_id", async () => {
    const { logger, logs } = createTestLogger();
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.notFound(notFoundHandler);

    const res = await app.request("/non-existent-route", {
      headers: {
        [REQUEST_ID_HEADER]: "test-not-found-id",
      },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("test-not-found-id");

    const body = (await res.json()) as ProblemDetails;
    expect(body.type).toBe("https://errors.ligo.pe/cash-in/not-found");
    expect(body.title).toBe("Ruta no encontrada");
    expect(body.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(body.detail).toBe("Ruta no encontrada");
    expect(body.request_id).toBe("test-not-found-id");
    expect(body.retryable).toBe(false);
    expect(body.errors).toEqual([]);
    expect("operation_id" in body).toBe(false);

    // Verify warn log was produced
    const warnLogs = logs.filter((l) => l["level"] === 40);
    const notFoundLog = warnLogs.find((l) => l["code"] === "NOT_FOUND");
    expect(notFoundLog).toBeDefined();
    expect(notFoundLog?.["path"]).toBe("/non-existent-route");
    expect(notFoundLog?.["status"]).toBe(404);
  });

  test("notFoundHandler generates request_id when correlation middleware did not run", async () => {
    const app = new Hono();
    app.notFound(notFoundHandler);

    const res = await app.request("/no-middleware-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");

    const body = (await res.json()) as ProblemDetails;
    expect(body.request_id).toMatch(UUID_REGEX);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.request_id);
    expect(body.errors).toEqual([]);
  });
});
