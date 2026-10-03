import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPrismaClient, type PrismaClient } from "../../src/infra/prisma";
import { e2eEnv } from "../helpers/e2e-env";
import {
  cashInBody,
  createWallet,
  newIdempotencyKey,
  uniqueUserId,
} from "../helpers/factories";
import { postCashIn } from "../helpers/http";
import { postWebhook } from "../helpers/webhook-signature";

describe("POST /webhooks/payment (e2e multi-pod)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(e2eEnv.E2E_DATABASE_URL);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("6. Webhook repetido responde duplicate: true, no acredita de nuevo y deja un solo WebhookEvent", async () => {
    // Crear una operación card_ok completada
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "100.00" });
    const key = newIdempotencyKey();
    const amount = 50.0;
    const body = cashInBody(userId, { amount, paymentMethod: "card_ok" });

    const cashInRes = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(cashInRes.status).toBe(200);
    const cashInJson = (await cashInRes.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };
    expect(cashInJson.status).toBe("completed");
    const opId = cashInJson.operation_id;

    // Verificar estado inicial en DB
    const entriesBefore = await prisma.ledgerEntry.findMany({
      where: { operationId: opId },
    });
    expect(entriesBefore.length).toBe(1);

    const walletBefore = await prisma.wallet.findUnique({
      where: { id: wallet.id },
    });
    expect(walletBefore).not.toBeNull();
    expect(walletBefore!.balance.toFixed(2)).toBe("150.00");

    // Firmar un charge.succeeded con un event_id único y su reference
    const eventId = `evt_t_${crypto.randomUUID().replaceAll("-", "")}`;
    const payload = {
      event_id: eventId,
      type: "charge.succeeded",
      created_at: new Date().toISOString(),
      data: {
        charge_id: `ch_t_${crypto.randomUUID().replaceAll("-", "")}`,
        reference: opId,
        amount,
        currency: "PEN",
        failure_code: null,
      },
    };
    const rawBody = JSON.stringify(payload);

    // Enviar primera vez a nginx
    const res1 = await postWebhook(e2eEnv.E2E_NGINX_URL, rawBody, {
      secret: e2eEnv.WEBHOOK_SECRET,
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as {
      received: boolean;
      duplicate: boolean;
    };
    expect(json1.received).toBe(true);
    expect(json1.duplicate).toBe(false);

    // Enviar segunda vez a nginx
    const res2 = await postWebhook(e2eEnv.E2E_NGINX_URL, rawBody, {
      secret: e2eEnv.WEBHOOK_SECRET,
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as {
      received: boolean;
      duplicate: boolean;
    };
    expect(json2.received).toBe(true);
    expect(json2.duplicate).toBe(true);

    // Sigue habiendo 1 asiento, el saldo no cambia y hay un solo WebhookEvent con ese event_id, con outcome = "NOOP_ALREADY_APPLIED"
    const entriesAfter = await prisma.ledgerEntry.findMany({
      where: { operationId: opId },
    });
    expect(entriesAfter.length).toBe(1);

    const walletAfter = await prisma.wallet.findUnique({
      where: { id: wallet.id },
    });
    expect(walletAfter).not.toBeNull();
    expect(walletAfter!.balance.toFixed(2)).toBe("150.00");

    const events = await prisma.webhookEvent.findMany({
      where: { providerEventId: eventId },
    });
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe("NOOP_ALREADY_APPLIED");
    expect(events[0]!.operationId).toBe(opId);
  }, 10000);
});
