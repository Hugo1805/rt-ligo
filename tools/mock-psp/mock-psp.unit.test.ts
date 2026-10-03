import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createMockPspApp } from "./app";
import type { MockConfig } from "./config";
import {
  sendWebhook,
  signPayload,
  type MockWebhookPayload,
  type SendWebhookOptions,
} from "./webhook-sender";

const baseConfig: MockConfig = {
  PORT: 3001,
  MOCK_PSP_WEBHOOK_URL: "http://localhost:3000/webhooks/payment",
  WEBHOOK_SECRET: "test-webhook-secret-123",
  MOCK_PSP_TIMEOUT_DELAY_MS: 30,
  MOCK_PSP_WEBHOOK_DELAY_MS: 5,
  LOG_LEVEL: "silent",
};

describe("mock-psp app (unit)", () => {
  test("GET /health returns 200 ok", async () => {
    const app = createMockPspApp({ config: baseConfig });
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("POST /charges rejects invalid body with 400", async () => {
    const app = createMockPspApp({ config: baseConfig });

    // Invalid JSON
    const resInvalidJson = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not a json}",
    });
    expect(resInvalidJson.status).toBe(400);

    // Missing fields
    const resMissing = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: "ref_1" }),
    });
    expect(resMissing.status).toBe(400);
  });

  test("POST /charges with card_ok records charge, is idempotent by reference, and tracks attempts", async () => {
    const app = createMockPspApp({ config: baseConfig });

    const req1 = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_ok_1",
        amount: "100.00",
        currency: "PEN",
        payment_method: "card_ok",
      }),
    });

    expect(req1.status).toBe(200);
    const body1 = (await req1.json()) as any;
    expect(body1.status).toBe("succeeded");
    expect(typeof body1.charge_id).toBe("string");
    expect(body1.charge_id.startsWith("ch_")).toBe(true);

    // GET /charges/:reference returns existing charge
    const getRes = await app.request(`/charges/ref_ok_1`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(body1);

    // Second call with same reference returns same charge even if payment_method differs
    const req2 = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_ok_1",
        amount: "100.00",
        currency: "PEN",
        payment_method: "card_declined",
      }),
    });
    expect(req2.status).toBe(200);
    const body2 = (await req2.json()) as any;
    expect(body2.charge_id).toBe(body1.charge_id);
    expect(body2.status).toBe("succeeded");

    // GET /__admin/charges/:reference reports attempts = 2
    const adminRes = await app.request("/__admin/charges/ref_ok_1");
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as any;
    expect(adminBody.attempts).toBe(2);
    expect(adminBody.charge.charge_id).toBe(body1.charge_id);
  });

  test("POST /charges with card_declined returns 200 with status declined and insufficient_funds", async () => {
    const app = createMockPspApp({ config: baseConfig });

    const res = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_dec_1",
        amount: "50.00",
        currency: "PEN",
        payment_method: "card_declined",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("declined");
    expect(body.failure_code).toBe("insufficient_funds");
    expect(body.charge_id.startsWith("ch_")).toBe(true);

    const getRes = await app.request("/charges/ref_dec_1");
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(body);
  });

  test("POST /charges with card_flaky fails with 503 first, succeeds second time, and error is per-reference", async () => {
    const app = createMockPspApp({ config: baseConfig });

    // First call with ref_flaky_1
    const res1 = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_flaky_1",
        amount: "100.00",
        currency: "PEN",
        payment_method: "card_flaky",
      }),
    });
    expect(res1.status).toBe(503);

    // First call does not register charge
    const getRes1 = await app.request("/charges/ref_flaky_1");
    expect(getRes1.status).toBe(404);

    // Second call with ref_flaky_1 succeeds
    const res2 = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_flaky_1",
        amount: "100.00",
        currency: "PEN",
        payment_method: "card_flaky",
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    expect(body2.status).toBe("succeeded");

    // Attempts count is 2
    const adminRes = await app.request("/__admin/charges/ref_flaky_1");
    const adminBody = (await adminRes.json()) as any;
    expect(adminBody.attempts).toBe(2);

    // Another reference ref_flaky_2 must also fail 503 on its first call (per-reference, not global)
    const resOther = await app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_flaky_2",
        amount: "100.00",
        currency: "PEN",
        payment_method: "card_flaky",
      }),
    });
    expect(resOther.status).toBe(503);
  });

  test("POST /charges with card_timeout registers charge before waiting and triggers webhook", async () => {
    const webhookCalls: SendWebhookOptions[] = [];
    const mockWebhookSender = async (opts: SendWebhookOptions) => {
      webhookCalls.push(opts);
      return true;
    };

    const app = createMockPspApp({
      config: {
        ...baseConfig,
        MOCK_PSP_TIMEOUT_DELAY_MS: 30,
        MOCK_PSP_WEBHOOK_DELAY_MS: 5,
      },
      webhookSender: mockWebhookSender,
    });

    const start = Date.now();
    const reqPromise = app.request("/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference: "ref_timeout_1",
        amount: "250.00",
        currency: "PEN",
        payment_method: "card_timeout",
      }),
    });

    // Wait a tick for the POST request to parse body and register the charge
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Check that GET /charges/:reference immediately knows the charge even before POST completes!
    const getResImmediate = await app.request("/charges/ref_timeout_1");
    expect(getResImmediate.status).toBe(200);
    const immediateBody = (await getResImmediate.json()) as any;
    expect(immediateBody.status).toBe("succeeded");
    expect(immediateBody.charge_id.startsWith("ch_")).toBe(true);

    const postRes = await reqPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as any;
    expect(postBody.charge_id).toBe(immediateBody.charge_id);

    // Wait for in-flight webhooks
    await Promise.all(app.inFlightWebhooks);

    expect(webhookCalls.length).toBe(1);
    const firstCall = webhookCalls[0]!;
    expect(firstCall.url).toBe(baseConfig.MOCK_PSP_WEBHOOK_URL);
    expect(firstCall.secret).toBe(baseConfig.WEBHOOK_SECRET);
    expect(firstCall.payload.type).toBe("charge.succeeded");
    expect(firstCall.payload.data.reference).toBe("ref_timeout_1");
    expect(firstCall.payload.data.charge_id).toBe(postBody.charge_id);
    expect(firstCall.payload.data.amount).toBe(250);
  });

  test("GET /charges/:reference returns 404 for unknown reference", async () => {
    const app = createMockPspApp({ config: baseConfig });
    const res = await app.request("/charges/non_existent_ref");
    expect(res.status).toBe(404);
  });

  test("GET /__admin/charges/:reference returns null charge and 0 attempts for unknown reference", async () => {
    const app = createMockPspApp({ config: baseConfig });
    const res = await app.request("/__admin/charges/non_existent_ref");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ charge: null, attempts: 0 });
  });
});

describe("webhook-sender (unit)", () => {
  test("signPayload produces valid t=...,v1=... format and valid HMAC", () => {
    const secret = "my-secret-key";
    const timestamp = 1700000000;
    const rawBody = JSON.stringify({ hello: "world" });

    const header = signPayload(secret, timestamp, rawBody);
    expect(header.startsWith(`t=${timestamp},v1=`)).toBe(true);

    const v1 = header.split("v1=")[1];
    const expectedHmac = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex");
    expect(v1).toBe(expectedHmac);
  });

  test("sendWebhook sends identical body, signature, and event_id across retries", async () => {
    const capturedHeaders: string[] = [];
    const capturedBodies: string[] = [];
    let attemptsCount = 0;

    const mockFetch = async (_url: any, init?: any) => {
      attemptsCount++;
      capturedHeaders.push(init?.headers?.["X-Provider-Signature"]);
      capturedBodies.push(init?.body);

      // Fail first 2 attempts with 500, succeed on 3rd attempt
      if (attemptsCount < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    };

    const payload: MockWebhookPayload = {
      event_id: "evt_test_123",
      type: "charge.succeeded",
      created_at: new Date().toISOString(),
      data: {
        charge_id: "ch_test_1",
        reference: "ref_test_1",
        amount: 100,
        currency: "PEN",
        failure_code: null,
      },
    };

    const success = await sendWebhook({
      url: "http://example.com/webhook",
      secret: "secret-key",
      payload,
      maxRetries: 3,
      retryDelayMs: 5,
      fetchFn: mockFetch as any,
    });

    expect(success).toBe(true);
    expect(attemptsCount).toBe(3);
    expect(capturedBodies.length).toBe(3);
    // All retried bodies must be identical
    expect(capturedBodies[0]).toBe(capturedBodies[1]);
    expect(capturedBodies[1]).toBe(capturedBodies[2]);
    // All retried signature headers must be identical
    expect(capturedHeaders[0]).toBe(capturedHeaders[1]);
    expect(capturedHeaders[1]).toBe(capturedHeaders[2]);
  });
});
