import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ERROR_CATALOG,
  type ErrorCode,
  AppError,
  type FieldError,
} from "./errors";
import { REQUEST_ID_HEADER, REQUEST_ID_REGEX } from "../infra/correlation";
import type { Logger } from "../infra/logger";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  request_id: string;
  retryable: boolean;
  errors: FieldError[];
  operation_id?: string | undefined;
}

export interface ToProblemOptions {
  requestId: string;
  detail?: string | undefined;
  operationId?: string | undefined;
  errors?: FieldError[] | undefined;
}

const INTERNAL_ERROR_FIXED_DETAIL = "Ocurrió un error inesperado en el servidor.";
const INVALID_JSON_BODY_DETAIL = "El body no es JSON válido.";

export function toProblem(
  target: ErrorCode | AppError,
  optionsOrRequestId: string | ToProblemOptions
): ProblemDetails {
  const options: ToProblemOptions =
    typeof optionsOrRequestId === "string"
      ? { requestId: optionsOrRequestId }
      : optionsOrRequestId;

  const isAppError = target instanceof AppError;
  const code: ErrorCode = isAppError ? target.code : target;
  const catalog = ERROR_CATALOG[code];

  let detail: string;
  if (code === "INTERNAL_ERROR") {
    detail = INTERNAL_ERROR_FIXED_DETAIL;
  } else if (options.detail !== undefined) {
    detail = options.detail;
  } else if (isAppError) {
    detail = target.detail;
  } else {
    detail = catalog.title;
  }

  const operationId = options.operationId ?? (isAppError ? target.operationId : undefined);
  const errors = options.errors ?? (isAppError ? target.errors : undefined) ?? [];

  const problem: ProblemDetails = {
    type: `https://errors.ligo.pe/cash-in/${code.toLowerCase().replaceAll("_", "-")}`,
    title: catalog.title,
    status: catalog.status,
    code,
    detail,
    request_id: options.requestId,
    retryable: catalog.retryable,
    errors,
  };

  if (operationId !== undefined) {
    problem.operation_id = operationId;
  }

  return problem;
}

function resolveRequestId(c: Context<any>): string {
  const fromVar = (c.var as { requestId?: string } | undefined)?.requestId;
  if (fromVar && typeof fromVar === "string") {
    return fromVar;
  }

  try {
    const fromRes = c.res?.headers?.get(REQUEST_ID_HEADER);
    if (fromRes) {
      return fromRes;
    }
  } catch {
    // Ignore error when inspecting c.res
  }

  const fromReq = c.req.header(REQUEST_ID_HEADER);
  if (fromReq && REQUEST_ID_REGEX.test(fromReq)) {
    return fromReq;
  }

  return crypto.randomUUID();
}

export const errorHandler: ErrorHandler<any> = (err, c) => {
  const requestId = resolveRequestId(c);
  const logger = (c.var as { logger?: Logger } | undefined)?.logger;

  let code: ErrorCode;
  let status: ContentfulStatusCode;
  let detail: string;
  let operationId: string | undefined;
  let errors: FieldError[] = [];

  if (err instanceof AppError) {
    code = err.code;
    status = err.status as ContentfulStatusCode;
    detail =
      code === "INTERNAL_ERROR"
        ? INTERNAL_ERROR_FIXED_DETAIL
        : err.detail;
    operationId = err.operationId;
    errors = err.errors;
  } else if (err instanceof HTTPException && err.status === 400) {
    code = "VALIDATION_ERROR";
    status = 400;
    detail = INVALID_JSON_BODY_DETAIL;
    errors = [];
  } else {
    code = "INTERNAL_ERROR";
    status = 500;
    detail = INTERNAL_ERROR_FIXED_DETAIL;
    errors = [];
  }

  const catalog = ERROR_CATALOG[code];
  const problem = toProblem(code, {
    requestId,
    detail,
    operationId,
    errors,
  });

  const errorObj = err instanceof Error ? err : new Error(String(err));

  if (status >= 500) {
    logger?.error(
      {
        err: errorObj,
        request_id: requestId,
        code,
        status,
      },
      "Internal server error"
    );
  } else {
    logger?.warn(
      {
        err: errorObj,
        request_id: requestId,
        code,
        status,
      },
      detail
    );
  }

  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
  };

  if ("retryAfterS" in catalog && catalog.retryAfterS !== undefined) {
    responseHeaders["Retry-After"] = String(catalog.retryAfterS);
    c.header("Retry-After", String(catalog.retryAfterS));
  }

  c.header("Content-Type", "application/problem+json");
  c.header(REQUEST_ID_HEADER, requestId);

  return c.json(problem, status, responseHeaders);
};

export const notFoundHandler: NotFoundHandler<any> = (c) => {
  const requestId = resolveRequestId(c);
  const logger = (c.var as { logger?: Logger } | undefined)?.logger;

  const catalog = ERROR_CATALOG.NOT_FOUND;
  const problem = toProblem("NOT_FOUND", {
    requestId,
  });

  logger?.warn(
    {
      code: "NOT_FOUND",
      status: 404,
      path: c.req.path,
      method: c.req.method,
      request_id: requestId,
    },
    catalog.title
  );

  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/problem+json",
    [REQUEST_ID_HEADER]: requestId,
  };

  c.header("Content-Type", "application/problem+json");
  c.header(REQUEST_ID_HEADER, requestId);

  return c.json(problem, 404, responseHeaders);
};
