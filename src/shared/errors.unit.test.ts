import { describe, expect, test } from "bun:test";
import {
  ERROR_CATALOG,
  AppError,
  type ErrorCode,
  type FieldError,
} from "./errors";

describe("ERROR_CATALOG", () => {
  test("contains exactly the 12 error codes from design §9", () => {
    const expectedCodes: ErrorCode[] = [
      "VALIDATION_ERROR",
      "IDEMPOTENCY_KEY_MISSING",
      "IDEMPOTENCY_KEY_INVALID",
      "WEBHOOK_SIGNATURE_INVALID",
      "WALLET_NOT_FOUND",
      "OPERATION_IN_PROGRESS",
      "IDEMPOTENCY_KEY_REUSED",
      "CURRENCY_MISMATCH",
      "PAYMENT_DECLINED",
      "NOT_FOUND",
      "INTERNAL_ERROR",
      "SERVICE_UNAVAILABLE",
    ];

    const catalogKeys = Object.keys(ERROR_CATALOG);
    expect(catalogKeys.sort()).toEqual([...expectedCodes].sort());
    expect(catalogKeys.length).toBe(12);
  });

  test("each error code defines the required status, title, and retryable flag", () => {
    expect(ERROR_CATALOG.VALIDATION_ERROR).toEqual({
      status: 400,
      title: "Request inválido",
      retryable: false,
    });

    expect(ERROR_CATALOG.IDEMPOTENCY_KEY_MISSING).toEqual({
      status: 400,
      title: "Idempotency-Key ausente",
      retryable: false,
    });

    expect(ERROR_CATALOG.IDEMPOTENCY_KEY_INVALID).toEqual({
      status: 400,
      title: "Idempotency-Key inválida",
      retryable: false,
    });

    expect(ERROR_CATALOG.WEBHOOK_SIGNATURE_INVALID).toEqual({
      status: 401,
      title: "Firma de webhook inválida",
      retryable: false,
    });

    expect(ERROR_CATALOG.WALLET_NOT_FOUND).toEqual({
      status: 404,
      title: "Wallet no encontrada",
      retryable: false,
    });

    expect(ERROR_CATALOG.OPERATION_IN_PROGRESS).toEqual({
      status: 409,
      title: "Operación en progreso",
      retryable: true,
      retryAfterS: 1,
    });

    expect(ERROR_CATALOG.IDEMPOTENCY_KEY_REUSED).toEqual({
      status: 422,
      title: "Idempotency-Key reutilizada con otro payload",
      retryable: false,
    });

    expect(ERROR_CATALOG.CURRENCY_MISMATCH).toEqual({
      status: 422,
      title: "Moneda no coincide con la wallet",
      retryable: false,
    });

    expect(ERROR_CATALOG.PAYMENT_DECLINED).toEqual({
      status: 422,
      title: "Pago rechazado",
      retryable: false,
    });

    expect(ERROR_CATALOG.NOT_FOUND).toEqual({
      status: 404,
      title: "Ruta no encontrada",
      retryable: false,
    });

    expect(ERROR_CATALOG.INTERNAL_ERROR).toEqual({
      status: 500,
      title: "Error interno del servidor",
      retryable: true,
    });

    expect(ERROR_CATALOG.SERVICE_UNAVAILABLE).toEqual({
      status: 503,
      title: "Servicio no disponible",
      retryable: true,
      retryAfterS: 2,
    });
  });

  test("only OPERATION_IN_PROGRESS and SERVICE_UNAVAILABLE have retryAfterS", () => {
    expect(ERROR_CATALOG.OPERATION_IN_PROGRESS.retryAfterS).toBe(1);
    expect(ERROR_CATALOG.SERVICE_UNAVAILABLE.retryAfterS).toBe(2);

    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      if (code !== "OPERATION_IN_PROGRESS" && code !== "SERVICE_UNAVAILABLE") {
        expect("retryAfterS" in entry).toBe(false);
      }
    }
  });
});

describe("AppError", () => {
  test("creates an instance that inherits from Error and AppError", () => {
    const error = new AppError("WALLET_NOT_FOUND");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe("WALLET_NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe("Wallet no encontrada");
    expect(error.message).toBe("Wallet no encontrada");
    expect(error.errors).toEqual([]);
    expect(error.operationId).toBeUndefined();
  });

  test("status and retryable are always derived from catalog", () => {
    const opInProgress = new AppError("OPERATION_IN_PROGRESS");
    expect(opInProgress.status).toBe(409);
    expect(opInProgress.retryable).toBe(true);

    const declined = new AppError("PAYMENT_DECLINED");
    expect(declined.status).toBe(422);
    expect(declined.retryable).toBe(false);

    const internal = new AppError("INTERNAL_ERROR");
    expect(internal.status).toBe(500);
    expect(internal.retryable).toBe(true);
  });

  test("supports custom detail, operationId, errors, and cause", () => {
    const customErrors: FieldError[] = [
      { field: "amount", message: "Debe ser mayor a 0" },
      { field: "currency", message: "Solo se acepta PEN" },
    ];
    const originalCause = new Error("underlying reason");

    const error = new AppError("VALIDATION_ERROR", {
      detail: "Payload inválido para recarga",
      operationId: "op_test_123",
      errors: customErrors,
      cause: originalCause,
    });

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.detail).toBe("Payload inválido para recarga");
    expect(error.operationId).toBe("op_test_123");
    expect(error.errors).toEqual(customErrors);
    expect(error.cause).toBe(originalCause);
  });

  test("defaults errors to empty array when options are omitted or empty", () => {
    const errWithoutOptions = new AppError("CURRENCY_MISMATCH");
    expect(errWithoutOptions.errors).toEqual([]);

    const errWithEmptyOptions = new AppError("CURRENCY_MISMATCH", {});
    expect(errWithEmptyOptions.errors).toEqual([]);
  });

  test("INTERNAL_ERROR uses fixed detail text when no detail is provided", () => {
    const error = new AppError("INTERNAL_ERROR");
    expect(error.detail).toBe("Ocurrió un error inesperado en el servidor.");
  });
});
