import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createMockPspApp } from "../../../../tools/mock-psp/app";
import type { MockConfig } from "../../../../tools/mock-psp/config";
import { verifyWebhookSignature } from "../../../../src/features/webhooks/webhooks.signature";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderUnexpectedError,
} from "../../../../src/infra/payment-provider/errors";
import { HttpPaymentProvider } from "../../../../src/infra/payment-provider/http.provider";

describe("HttpPaymentProvider (unit)", () => {
  const activeServers: Array<{ stop: (closeActive?: boolean) => void | Promise<void> }> = [];

  afterEach(async () => {
    while (activeServers.length > 0) {
      const s = activeServers.pop();
      try {
        await s?.stop(true);
      } catch {
        // ignore error on close
      }
    }
  });

  function startEphemeralServer(fetchHandler: (req: Request) => Response | Promise<Response>) {
    const server = Bun.serve({
      fetch: fetchHandler,
      port: 0,
    });
    activeServers.push(server);
    return {
      server,
      baseUrl: `http://localhost:${server.port}`,
    };
  }

  function startMockPspServer(
    configOverrides: Partial<MockConfig> = {},
    onRequest?: (req: Request) => void
  ) {
    const config: MockConfig = {
      PORT: 0,
      MOCK_PSP_WEBHOOK_URL: "http://localhost:1/noop",
      WEBHOOK_SECRET: "test-secret-456",
      MOCK_PSP_TIMEOUT_DELAY_MS: 0,
      MOCK_PSP_WEBHOOK_DELAY_MS: 0,
      LOG_LEVEL: "silent",
      ...configOverrides,
    };

    const mockApp = createMockPspApp({ config });
    const { server, baseUrl } = startEphemeralServer((req) => {
      onRequest?.(req);
      return mockApp.fetch(req);
    });

    return { server, baseUrl, mockApp, config };
  }

  test("charge with card_ok succeeds, passes X-Request-Id, and tracks attempts", async () => {
    let capturedRequestId: string | null = null;
    const { baseUrl, mockApp } = startMockPspServer({}, (req) => {
      capturedRequestId = req.headers.get("X-Request-Id");
    });

    const provider = new HttpPaymentProvider(baseUrl, 3000);

    const result = await provider.charge({
      reference: "ref_http_ok_1",
      amount: "150.00",
      currency: "PEN",
      paymentMethod: "card_ok",
      requestId: "req-trace-001",
    });

    expect(result.status).toBe("succeeded");
    expect(result.chargeId.startsWith("ch_")).toBe(true);
    expect(capturedRequestId as string | null).toBe("req-trace-001");

    // Repeat with same reference: idempotency
    const result2 = await provider.charge({
      reference: "ref_http_ok_1",
      amount: "150.00",
      currency: "PEN",
      paymentMethod: "card_declined",
      requestId: "req-trace-002",
    });

    expect(result2.status).toBe("succeeded");
    expect(result2.chargeId).toBe(result.chargeId);

    const adminRes = await mockApp.request("/__admin/charges/ref_http_ok_1");
    const adminJson = (await adminRes.json()) as any;
    expect(adminJson.attempts).toBe(2);
  });

  test("charge with card_declined returns declined with insufficient_funds", async () => {
    const { baseUrl } = startMockPspServer();
    const provider = new HttpPaymentProvider(baseUrl, 3000);

    const result = await provider.charge({
      reference: "ref_http_dec_1",
      amount: "80.00",
      currency: "PEN",
      paymentMethod: "card_declined",
      requestId: "req-dec-001",
    });

    expect(result.status).toBe("declined");
    expect(result.chargeId.startsWith("ch_")).toBe(true);
    if (result.status === "declined") {
      expect(result.failureCode).toBe("insufficient_funds");
    }

    const getRes = await provider.getCharge("ref_http_dec_1");
    expect(getRes).toEqual(result);
  });

  test("card_timeout causes ProviderTimeoutError, getCharge sees succeeded, and webhook verifies", async () => {
    const secret = "shared-secret-timeout-test";
    let webhookReceived: { header: string | null; body: string } | null = null;
    let resolveWebhook: (val: any) => void;
    const webhookPromise = new Promise((resolve) => {
      resolveWebhook = resolve;
    });

    // Start ephemeral webhook receiver
    const webhookApp = new Hono();
    webhookApp.post("/webhooks/payment", async (c) => {
      const header = c.req.header("X-Provider-Signature") ?? null;
      const body = await c.req.text();
      webhookReceived = { header, body };
      resolveWebhook(webhookReceived);
      return c.json({ received: true }, 200);
    });

    const webhookServer = startEphemeralServer(webhookApp.fetch);

    const { baseUrl } = startMockPspServer({
      WEBHOOK_SECRET: secret,
      MOCK_PSP_WEBHOOK_URL: `${webhookServer.baseUrl}/webhooks/payment`,
      MOCK_PSP_TIMEOUT_DELAY_MS: 150,
      MOCK_PSP_WEBHOOK_DELAY_MS: 10,
    });

    // Client timeout of 40ms is smaller than mock delay of 150ms
    const provider = new HttpPaymentProvider(baseUrl, 40);

    let thrownError: unknown;
    try {
      await provider.charge({
        reference: "ref_http_timeout_1",
        amount: "500.00",
        currency: "PEN",
        paymentMethod: "card_timeout",
        requestId: "req-timeout-001",
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(ProviderTimeoutError);
    expect((thrownError as Error).message).toBe("Payment provider request timed out");

    // Immediately check getCharge - it should already be registered as succeeded!
    const getRes = await provider.getCharge("ref_http_timeout_1");
    expect(getRes.status).toBe("succeeded");
    if (getRes.status === "succeeded") {
      expect(getRes.chargeId.startsWith("ch_")).toBe(true);
    }

    // Await webhook reception
    await webhookPromise;
    expect(webhookReceived).not.toBeNull();
    const { header, body } = webhookReceived!;

    // Verify webhook signature with the app's verifyWebhookSignature
    const isValidSignature = verifyWebhookSignature({
      header,
      rawBody: body,
      secret,
      toleranceS: 300,
    });
    expect(isValidSignature).toBe(true);

    const parsedWebhook = JSON.parse(body);
    expect(parsedWebhook.type).toBe("charge.succeeded");
    expect(parsedWebhook.data.reference).toBe("ref_http_timeout_1");
    expect(parsedWebhook.data.amount).toBe(500);
  });

  test("card_flaky responds 503 first time (ProviderUnavailableError) and succeeded second time", async () => {
    const { baseUrl } = startMockPspServer();
    const provider = new HttpPaymentProvider(baseUrl, 3000);

    let firstError: unknown;
    try {
      await provider.charge({
        reference: "ref_http_flaky_1",
        amount: "99.00",
        currency: "PEN",
        paymentMethod: "card_flaky",
        requestId: "req-flaky-001",
      });
    } catch (err) {
      firstError = err;
    }

    expect(firstError).toBeInstanceOf(ProviderUnavailableError);
    expect((firstError as Error).message).toBe("Payment provider is unavailable");

    // Second call with same reference succeeds
    const secondResult = await provider.charge({
      reference: "ref_http_flaky_1",
      amount: "99.00",
      currency: "PEN",
      paymentMethod: "card_flaky",
      requestId: "req-flaky-002",
    });

    expect(secondResult.status).toBe("succeeded");
  });

  test("connection refused throws ProviderUnavailableError with fixed message", async () => {
    // Start ephemeral server and immediately stop it to get an unused closed port
    const { server, baseUrl } = startEphemeralServer(() => new Response("ok"));
    await server.stop(true);

    const provider = new HttpPaymentProvider(baseUrl, 1000);

    let err: unknown;
    try {
      await provider.charge({
        reference: "ref_conn_refused",
        amount: "10.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-conn-001",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toBe("Payment provider is unavailable");
  });

  test("unexpected 4xx throws ProviderUnexpectedError with fixed message", async () => {
    const { baseUrl } = startEphemeralServer(() => {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const provider = new HttpPaymentProvider(baseUrl, 1000);

    let err: unknown;
    try {
      await provider.charge({
        reference: "ref_401",
        amount: "10.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-401",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProviderUnexpectedError);
    expect((err as Error).message).toBe("Unexpected payment provider response");
  });

  test("status 200 with invalid schema throws ProviderUnexpectedError with fixed message", async () => {
    const { baseUrl } = startEphemeralServer(() => {
      return new Response(
        JSON.stringify({ status: "bogus_status", charge_id: "ch_123" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const provider = new HttpPaymentProvider(baseUrl, 1000);

    let err: unknown;
    try {
      await provider.charge({
        reference: "ref_invalid_schema",
        amount: "10.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-schema",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ProviderUnexpectedError);
    expect((err as Error).message).toBe("Unexpected payment provider response");
  });

  test("getCharge returns { status: 'not_found' } for unknown reference", async () => {
    const { baseUrl } = startMockPspServer();
    const provider = new HttpPaymentProvider(baseUrl, 3000);

    const result = await provider.getCharge("non_existent_reference");
    expect(result).toEqual({ status: "not_found" });
  });

  test("getCharge maps 5xx to ProviderUnavailableError and non-404 4xx to ProviderUnexpectedError", async () => {
    const { baseUrl } = startEphemeralServer((req) => {
      const url = new URL(req.url);
      if (url.pathname.includes("server_error")) {
        return new Response("internal error", { status: 500 });
      }
      return new Response("bad request", { status: 400 });
    });

    const provider = new HttpPaymentProvider(baseUrl, 1000);

    await expect(provider.getCharge("server_error")).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    await expect(provider.getCharge("bad_request")).rejects.toBeInstanceOf(
      ProviderUnexpectedError
    );
  });
});
