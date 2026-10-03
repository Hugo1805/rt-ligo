export type FieldError = {
  field: string;
  message: string;
};

export const ERROR_CATALOG = {
  VALIDATION_ERROR: {
    status: 400,
    title: "Request inválido",
    retryable: false,
  },
  IDEMPOTENCY_KEY_MISSING: {
    status: 400,
    title: "Idempotency-Key ausente",
    retryable: false,
  },
  IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    title: "Idempotency-Key inválida",
    retryable: false,
  },
  WEBHOOK_SIGNATURE_INVALID: {
    status: 401,
    title: "Firma de webhook inválida",
    retryable: false,
  },
  WALLET_NOT_FOUND: {
    status: 404,
    title: "Wallet no encontrada",
    retryable: false,
  },
  OPERATION_IN_PROGRESS: {
    status: 409,
    title: "Operación en progreso",
    retryable: true,
    retryAfterS: 1,
  },
  IDEMPOTENCY_KEY_REUSED: {
    status: 422,
    title: "Idempotency-Key reutilizada con otro payload",
    retryable: false,
  },
  CURRENCY_MISMATCH: {
    status: 422,
    title: "Moneda no coincide con la wallet",
    retryable: false,
  },
  PAYMENT_DECLINED: {
    status: 422,
    title: "Pago rechazado",
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    title: "Ruta no encontrada",
    retryable: false,
  },
  INTERNAL_ERROR: {
    status: 500,
    title: "Error interno del servidor",
    retryable: true,
  },
  SERVICE_UNAVAILABLE: {
    status: 503,
    title: "Servicio no disponible",
    retryable: true,
    retryAfterS: 2,
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface AppErrorOptions {
  detail?: string | undefined;
  operationId?: string | undefined;
  errors?: FieldError[] | undefined;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: (typeof ERROR_CATALOG)[ErrorCode]["status"];
  readonly retryable: boolean;
  readonly detail: string;
  readonly operationId?: string | undefined;
  readonly errors: FieldError[];
  override readonly cause?: unknown;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const catalog = ERROR_CATALOG[code];
    const detail =
      options.detail ??
      (code === "INTERNAL_ERROR"
        ? "Ocurrió un error inesperado en el servidor."
        : catalog.title);

    super(detail, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = catalog.status;
    this.retryable = catalog.retryable;
    this.detail = detail;
    this.operationId = options.operationId;
    this.errors = options.errors ?? [];
    this.cause = options.cause;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
