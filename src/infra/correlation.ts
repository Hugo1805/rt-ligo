import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "./logger";

export const REQUEST_ID_HEADER = "X-Request-Id";
export const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export type CorrelationVariables = {
  requestId: string;
  logger: Logger;
};

export type CorrelationEnv = {
  Variables: CorrelationVariables;
};

export type AppVariables = CorrelationVariables;
export type AppEnv = CorrelationEnv;

export function correlation(logger: Logger): MiddlewareHandler<CorrelationEnv> {
  return createMiddleware<CorrelationEnv>(async (c, next) => {
    const incomingId = c.req.header(REQUEST_ID_HEADER);
    const requestId =
      incomingId && REQUEST_ID_REGEX.test(incomingId)
        ? incomingId
        : crypto.randomUUID();

    const requestLogger = logger.child({ request_id: requestId });

    c.set("requestId", requestId);
    c.set("logger", requestLogger);
    c.header(REQUEST_ID_HEADER, requestId);

    const start = performance.now();

    try {
      await next();
    } finally {
      if (c.res) {
        try {
          c.res.headers.set(REQUEST_ID_HEADER, requestId);
        } catch {
          // Guard in case response headers are immutable
        }
      }

      const duration_ms = Math.round((performance.now() - start) * 100) / 100;

      requestLogger.info({
        event: "http.request",
        method: c.req.method,
        path: c.req.path,
        status: c.res ? c.res.status : 500,
        duration_ms,
      });
    }
  });
}
