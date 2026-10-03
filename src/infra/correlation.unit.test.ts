import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLogger } from "./logger";
import {
  correlation,
  REQUEST_ID_HEADER,
  type CorrelationEnv,
} from "./correlation";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createTestLogger(podId?: string) {
  const logs: Record<string, unknown>[] = [];
  const stream = {
    write(msg: string) {
      logs.push(JSON.parse(msg) as Record<string, unknown>);
    },
  };
  const logger = createLogger({ podId }, stream);
  return { logger, logs };
}

describe("createLogger", () => {
  test("creates pino logger with base pod_id and iso timestamps", () => {
    const logs: Record<string, unknown>[] = [];
    const stream = {
      write(msg: string) {
        logs.push(JSON.parse(msg) as Record<string, unknown>);
      },
    };

    const logger = createLogger({ level: "debug", podId: "pod-core-1" }, stream);
    expect(logger.level).toBe("debug");
    expect(logger.bindings()).toEqual({ pod_id: "pod-core-1" });

    logger.debug("test log message");

    expect(logs.length).toBe(1);
    const entry = logs[0]!;
    expect(entry["pod_id"]).toBe("pod-core-1");
    expect(entry["msg"]).toBe("test log message");
    expect(entry["level"]).toBe(20);
    expect(typeof entry["time"]).toBe("string");
    expect(entry["time"] as string).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  test("defaults to info level when no level is provided", () => {
    const logger = createLogger();
    expect(logger.level).toBe("info");
  });
});

describe("correlation middleware", () => {
  test("without header, response includes an X-Request-Id with UUID format", async () => {
    const { logger } = createTestLogger("pod-1");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/ping", (c) => c.text("pong"));

    const res = await app.request("/ping");
    const requestId = res.headers.get(REQUEST_ID_HEADER);

    expect(res.status).toBe(200);
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(UUID_REGEX);
  });

  test("with valid header, response returns the exact same value", async () => {
    const { logger } = createTestLogger("pod-1");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/ping", (c) => c.text("pong"));

    const validId = "custom-req-id_123.ABC-xyz";
    const res = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: validId,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(validId);
  });

  test("accepts request id with exactly 128 characters", async () => {
    const { logger } = createTestLogger("pod-1");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/ping", (c) => c.text("pong"));

    const valid128 = "a".repeat(128);
    const res = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: valid128,
      },
    });

    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(valid128);
  });

  test("with invalid header (500 characters, spaces, special chars), generates a new UUID", async () => {
    const { logger } = createTestLogger("pod-1");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/ping", (c) => c.text("pong"));

    // Header exceeding 128 characters (500 chars)
    const longId = "x".repeat(500);
    const resLong = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: longId,
      },
    });
    const idLong = resLong.headers.get(REQUEST_ID_HEADER);
    expect(idLong).toMatch(UUID_REGEX);
    expect(idLong).not.toBe(longId);

    // Header with 129 characters
    const id129 = "x".repeat(129);
    const res129 = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: id129,
      },
    });
    const result129 = res129.headers.get(REQUEST_ID_HEADER);
    expect(result129).toMatch(UUID_REGEX);
    expect(result129).not.toBe(id129);

    // Header with spaces
    const resSpaces = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: "invalid request id with spaces",
      },
    });
    const idSpaces = resSpaces.headers.get(REQUEST_ID_HEADER);
    expect(idSpaces).toMatch(UUID_REGEX);
    expect(idSpaces).not.toContain(" ");

    // Header with forbidden characters (e.g. semicolon, quotes, angle brackets)
    const resSpecial = await app.request("/ping", {
      headers: {
        [REQUEST_ID_HEADER]: '<script>alert("xss")</script>',
      },
    });
    const idSpecial = resSpecial.headers.get(REQUEST_ID_HEADER);
    expect(idSpecial).toMatch(UUID_REGEX);
    expect(idSpecial).not.toContain("<");
  });

  test("with invalid header containing newlines, generates a new UUID", async () => {
    const { logger } = createTestLogger("pod-1");
    const middleware = correlation(logger);

    // Since standard fetch Headers reject newlines at construction,
    // we verify the regex validation logic directly on a request containing newline injection
    const responseHeaders = new Map<string, string>();
    let savedRequestId: string | undefined;

    const mockContext = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === REQUEST_ID_HEADER.toLowerCase()) {
            return "injected-id\r\nInjected-Header: value";
          }
          return undefined;
        },
        method: "GET",
        path: "/test",
      },
      set: (key: string, value: unknown) => {
        if (key === "requestId") {
          savedRequestId = value as string;
        }
      },
      header: (name: string, value: string) => {
        responseHeaders.set(name, value);
      },
      res: {
        headers: {
          set: (name: string, value: string) => responseHeaders.set(name, value),
        },
        status: 200,
      },
    } as any;

    await middleware(mockContext, async () => {});

    expect(savedRequestId).toBeDefined();
    expect(savedRequestId).toMatch(UUID_REGEX);
    expect(savedRequestId).not.toContain("injected");
    expect(responseHeaders.get(REQUEST_ID_HEADER)).toBe(savedRequestId);
  });

  test("handler can read c.var.requestId and c.var.logger", async () => {
    const { logger } = createTestLogger("pod-1");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));

    let capturedRequestId: string | undefined;
    let hasLoggerMethod = false;

    app.get("/context", (c) => {
      capturedRequestId = c.var.requestId;
      hasLoggerMethod = typeof c.var.logger?.info === "function";
      return c.json({ requestId: c.var.requestId });
    });

    const res = await app.request("/context");
    expect(res.status).toBe(200);
    expect(capturedRequestId).toBeDefined();
    expect(capturedRequestId).toMatch(UUID_REGEX);
    expect(hasLoggerMethod).toBe(true);

    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(capturedRequestId!);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(capturedRequestId!);
  });

  test("logs http.request on completion with method, path, status, and duration_ms", async () => {
    const { logger, logs } = createTestLogger("pod-main");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/health", (c) => c.text("ok"));

    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const httpLog = logs.find((l) => l["event"] === "http.request");
    expect(httpLog).toBeDefined();
    expect(httpLog?.["event"]).toBe("http.request");
    expect(httpLog?.["method"]).toBe("GET");
    expect(httpLog?.["path"]).toBe("/health");
    expect(httpLog?.["status"]).toBe(200);
    expect(typeof httpLog?.["duration_ms"]).toBe("number");
    expect((httpLog?.["duration_ms"] as number) >= 0).toBe(true);
    expect(httpLog?.["pod_id"]).toBe("pod-main");
    expect(httpLog?.["request_id"]).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  test("child logger inside handler carries request_id and pod_id", async () => {
    const { logger, logs } = createTestLogger("pod-child");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.post("/items", (c) => {
      c.var.logger.info({ item_id: "item-42" }, "item created");
      return c.text("created", 201);
    });

    const res = await app.request("/items", { method: "POST" });
    const requestId = res.headers.get(REQUEST_ID_HEADER);

    const itemLog = logs.find((l) => l["item_id"] === "item-42");
    expect(itemLog).toBeDefined();
    expect(itemLog?.["item_id"]).toBe("item-42");
    expect(itemLog?.["pod_id"]).toBe("pod-child");
    expect(itemLog?.["request_id"]).toBe(requestId);
  });

  test("sets X-Request-Id and logs http.request when response is created directly", async () => {
    const { logger, logs } = createTestLogger("pod-direct");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/direct", () => new Response("raw response", { status: 200 }));

    const res = await app.request("/direct");
    const requestId = res.headers.get(REQUEST_ID_HEADER);

    expect(requestId).toMatch(UUID_REGEX);

    const httpLog = logs.find((l) => l["event"] === "http.request");
    expect(httpLog).toBeDefined();
    expect(httpLog?.["path"]).toBe("/direct");
    expect(httpLog?.["status"]).toBe(200);
    expect(httpLog?.["request_id"]).toBe(requestId);
  });

  test("sets X-Request-Id and logs http.request when handler throws an error", async () => {
    const { logger, logs } = createTestLogger("pod-err");
    const app = new Hono<CorrelationEnv>();
    app.use(correlation(logger));
    app.get("/failing", () => {
      throw new Error("unexpected explosion");
    });

    const res = await app.request("/failing");
    const requestId = res.headers.get(REQUEST_ID_HEADER);

    expect(res.status).toBe(500);
    expect(requestId).toMatch(UUID_REGEX);

    const httpLog = logs.find((l) => l["event"] === "http.request");
    expect(httpLog).toBeDefined();
    expect(httpLog?.["path"]).toBe("/failing");
    expect(httpLog?.["status"]).toBe(500);
    expect(httpLog?.["request_id"]).toBe(requestId);
  });
});
