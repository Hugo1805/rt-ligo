import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { correlation, REQUEST_ID_HEADER, type AppEnv } from "../../../../src/infra/correlation";
import { createLogger } from "../../../../src/infra/logger";
import type { Config } from "../../../../src/infra/config";
import type { Lock } from "../../../../src/infra/lock";
import type { PaymentProvider } from "../../../../src/infra/payment-provider/payment-provider";
import type { PrismaClient } from "../../../../src/infra/prisma";
import type { Redis } from "../../../../src/infra/redis";
import { errorHandler, notFoundHandler, type ProblemDetails } from "../../../../src/shared/error-handler";
import { signWebhookPayload } from "../../../../src/features/webhooks/webhooks.signature";
import { webhooksRoutes, type WebhooksRoutesDeps } from "../../../../src/features/webhooks/webhooks.routes";
import type { WebhooksService } from "../../../../src/features/webhooks/webhooks.service";
import type { WebhookEvent } from "../../../../src/features/webhooks/webhooks.schemas";
import { createApp, type AppDeps } from "../../../../src/app";

const SECRET = "whsec_test_secret_1234567890";
const TOLERANCE_S = 300;
const FIXED_TIMESTAMP = 1727890000;
const FIXED_NOW_MS = FIXED_TIMESTAMP * 1000;

const VALID_PAYLOAD: WebhookEvent = {
  event_id: "evt_01J9XYZ",
  type: "charge.succeeded",
  created_at: "2026-10-02T15:04:05.000Z",
  data: {
    charge_id: "ch_123",
    reference: "op_9f8e7d",
    amount: 100.0,
    currency: "PEN",
    failure_code: null,
  },
};

function createTestApp(deps: WebhooksRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const logger = createLogger({ level: "silent", podId: "test-pod" });

  app.use(correlation(logger));
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/webhooks", webhooksRoutes(deps));

  return app;
}

describe("POST /webhooks/payment (unit routes)", () => {
  const baseConfig = {
    WEBHOOK_SECRET: SECRET,
    WEBHOOK_TOLERANCE_S: TOLERANCE_S,
  };

  test("firma válida y payload válido: 200 { received: true, duplicate: false }", async () => {
    const processWebhookEventMock = mock(
      async (_event: WebhookEvent, _logger: unknown) => ({ duplicate: false })
    );
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });
    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
    const firstCall = processWebhookEventMock.mock.calls[0];
    expect(firstCall?.[0]).toEqual(VALID_PAYLOAD);
  });

  test("servicio devuelve duplicado: 200 { received: true, duplicate: true }", async () => {
    const processWebhookEventMock = mock(async () => ({ duplicate: true }));
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: true });
    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
  });

  test("firma válida con un campo desconocido extra: 200 y el servicio recibe el evento sin ese campo", async () => {
    let capturedEvent: WebhookEvent | null = null;
    const processWebhookEventMock = mock(async (event: WebhookEvent) => {
      capturedEvent = event;
      return { duplicate: false };
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const payloadWithExtras = {
      ...VALID_PAYLOAD,
      unknown_root_prop: "provider_added_field",
      data: {
        ...VALID_PAYLOAD.data,
        unknown_nested_prop: 9999,
      },
    };

    const rawBody = JSON.stringify(payloadWithExtras);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
    expect(capturedEvent).not.toBeNull();
    expect("unknown_root_prop" in (capturedEvent as unknown as Record<string, unknown>)).toBe(false);
    expect(
      "unknown_nested_prop" in
        ((capturedEvent as unknown as { data: Record<string, unknown> }).data)
    ).toBe(false);
    expect((capturedEvent as unknown as WebhookEvent).event_id).toBe(VALID_PAYLOAD.event_id);
    expect((capturedEvent as unknown as WebhookEvent).data.reference).toBe(VALID_PAYLOAD.data.reference);
  });

  test("header ausente: 401 WEBHOOK_SIGNATURE_INVALID y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeDefined();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("firma inválida: 401 WEBHOOK_SIGNATURE_INVALID y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: "wrong_secret_1234567890",
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("timestamp fuera de tolerancia (pasado): 401 WEBHOOK_SIGNATURE_INVALID y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP - TOLERANCE_S - 1,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("timestamp fuera de tolerancia (futuro): 401 WEBHOOK_SIGNATURE_INVALID y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP + TOLERANCE_S + 1,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("header malformado: 401 WEBHOOK_SIGNATURE_INVALID y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const rawBody = JSON.stringify(VALID_PAYLOAD);

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": "t=invalid,v1=not-a-valid-hex",
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("firma válida con body que no es JSON: 400 VALIDATION_ERROR y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const nonJsonBody = "invalid-body-not-json { hello";
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody: nonJsonBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: nonJsonBody,
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("firma válida con payload que no cumple el schema: 400 VALIDATION_ERROR con errors no vacío y el servicio no se llama", async () => {
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const invalidPayload = {
      event_id: "",
      type: "charge.unknown_type",
      created_at: "not-a-date",
      data: {
        amount: "not-a-number",
      },
    };

    const rawBody = JSON.stringify(invalidPayload);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");
    expect(problem.errors.length).toBeGreaterThan(0);
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  test("todas las respuestas de error son application/problem+json con request_id y conservan el provisto", async () => {
    const customRequestId = "custom-req-id-webhook-999";
    const processWebhookEventMock = mock(async () => {
      throw new Error("Should not be called");
    });
    const service: WebhooksService = { processWebhookEvent: processWebhookEventMock };
    const app = createTestApp({
      config: baseConfig,
      webhooksService: service,
      now: () => FIXED_NOW_MS,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REQUEST_ID_HEADER]: customRequestId,
      },
      body: JSON.stringify(VALID_PAYLOAD),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(customRequestId);

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.request_id).toBe(customRequestId);
  });
});

describe("createApp wiring for webhooks (unit)", () => {
  const fakeConfig: Config = {
    DATABASE_URL: "postgresql://fake:fake@localhost:5432/fake",
    REDIS_URL: "redis://localhost:6379",
    WEBHOOK_SECRET: SECRET,
    PROVIDER_MODE: "fake",
    PROVIDER_BASE_URL: undefined,
    PROVIDER_TIMEOUT_MS: 3000,
    PROVIDER_MAX_RETRIES: 2,
    LOCK_TTL_MS: 15000,
    CASH_IN_MAX_AMOUNT: 10000,
    RECONCILE_INTERVAL_MS: 10000,
    RECONCILE_STALE_MS: 30000,
    RECONCILE_MAX_ATTEMPTS: 5,
    WEBHOOK_TOLERANCE_S: TOLERANCE_S,
    NODE_ENV: "test",
    PORT: 3000,
    LOG_LEVEL: "silent",
    POD_ID: "test-pod-1",
  };

  const fakePrisma = {
    cashInOperation: {},
    wallet: {},
  } as unknown as PrismaClient;

  const fakeRedis = {} as unknown as Redis;

  const fakePaymentProvider: PaymentProvider = {
    charge: async () => ({ status: "succeeded", chargeId: "ch_test" }),
    getCharge: async () => ({ status: "not_found" }),
  };

  const fakeLock: Lock = {
    acquire: async () => ({ status: "acquired", release: async () => {} }),
  };

  test("createApp mounts /webhooks/payment and processes valid webhook", async () => {
    const processWebhookEventMock = mock(async () => ({ duplicate: false }));
    const fakeWebhooksService: WebhooksService = {
      processWebhookEvent: processWebhookEventMock,
    };

    const deps: AppDeps = {
      config: fakeConfig,
      logger: createLogger({ level: "silent", podId: fakeConfig.POD_ID }),
      prisma: fakePrisma,
      redis: fakeRedis,
      paymentProvider: fakePaymentProvider,
      lock: fakeLock,
      webhooksService: fakeWebhooksService,
      now: () => FIXED_NOW_MS,
    };

    const app = createApp(deps);

    const rawBody = JSON.stringify(VALID_PAYLOAD);
    const signature = signWebhookPayload({
      secret: SECRET,
      timestamp: FIXED_TIMESTAMP,
      rawBody,
    });

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provider-Signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });
    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
  });

  test("createApp mounts /webhooks/payment and rejects missing signature with 401", async () => {
    const processWebhookEventMock = mock(async () => ({ duplicate: false }));
    const fakeWebhooksService: WebhooksService = {
      processWebhookEvent: processWebhookEventMock,
    };

    const deps: AppDeps = {
      config: fakeConfig,
      logger: createLogger({ level: "silent", podId: fakeConfig.POD_ID }),
      prisma: fakePrisma,
      redis: fakeRedis,
      paymentProvider: fakePaymentProvider,
      lock: fakeLock,
      webhooksService: fakeWebhooksService,
    };

    const app = createApp(deps);

    const res = await app.request("/webhooks/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(VALID_PAYLOAD),
    });

    expect(res.status).toBe(401);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });
});
