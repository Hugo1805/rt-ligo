import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "../../src/generated/prisma/client";
import { createPrismaClient, type PrismaClient } from "../../src/infra/prisma";
import { e2eEnv } from "../helpers/e2e-env";
import {
  cashInBody,
  createWallet,
  newIdempotencyKey,
  uniqueUserId,
} from "../helpers/factories";
import { postCashIn, waitFor } from "../helpers/http";

describe("POST /cash-in (e2e multi-pod)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(e2eEnv.E2E_DATABASE_URL);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("1. Misma key en app1 y app2 en paralelo: 1 operación, 1 intento en mock, 1 asiento y saldo exacto", async () => {
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "100.00" });
    const key = newIdempotencyKey();
    const amount = 50.0;
    const body = cashInBody(userId, { amount, paymentMethod: "card_ok" });

    // 5 requests a app1 y 5 requests a app2 con Promise.all
    const app1Promises = Array.from({ length: 5 }, () =>
      postCashIn(e2eEnv.E2E_APP1_URL, key, body)
    );
    const app2Promises = Array.from({ length: 5 }, () =>
      postCashIn(e2eEnv.E2E_APP2_URL, key, body)
    );

    const responses = await Promise.all([...app1Promises, ...app2Promises]);

    // Cada respuesta es 200 completed, 202 o 409 OPERATION_IN_PROGRESS con Retry-After. Ninguna es 5xx.
    const operationIds: string[] = [];

    for (const res of responses) {
      expect(res.status).toBeLessThan(500);
      expect([200, 202, 409]).toContain(res.status);

      if (res.status === 409) {
        expect(res.headers.get("retry-after")).not.toBeNull();
        const json = (await res.json()) as { code?: string; operation_id?: string };
        expect(json.code).toBe("OPERATION_IN_PROGRESS");
        if (json.operation_id) {
          operationIds.push(json.operation_id);
        }
      } else if (res.status === 200) {
        const json = (await res.json()) as {
          operation_id: string;
          status: string;
          amount: number;
          new_balance: number;
        };
        expect(json.status).toBe("completed");
        expect(json.operation_id).toBeDefined();
        operationIds.push(json.operation_id);
      } else if (res.status === 202) {
        const json = (await res.json()) as {
          operation_id: string;
          status: string;
          amount: number;
        };
        expect(json.operation_id).toBeDefined();
        operationIds.push(json.operation_id);
      }
    }

    // Todas las que traen operation_id traen el mismo
    expect(operationIds.length).toBeGreaterThan(0);
    const primaryOpId = operationIds[0]!;
    for (const opId of operationIds) {
      expect(opId).toBe(primaryOpId);
    }

    // En DB hay exactamente 1 CashInOperation para (userId, key), en COMPLETED, y 1 LedgerEntry
    const ops = await prisma.cashInOperation.findMany({
      where: { userId, idempotencyKey: key },
    });
    expect(ops.length).toBe(1);
    expect(ops[0]!.id).toBe(primaryOpId);
    expect(ops[0]!.status).toBe("COMPLETED");

    const entries = await prisma.ledgerEntry.findMany({
      where: { operationId: primaryOpId },
    });
    expect(entries.length).toBe(1);
    expect(entries[0]!.amount.toFixed(2)).toBe("50.00");
    expect(entries[0]!.balanceAfter.toFixed(2)).toBe("150.00");

    // Attempts en mock para esa referencia es 1
    const mockRes = await fetch(
      `${e2eEnv.E2E_MOCK_PSP_URL}/__admin/charges/${primaryOpId}`
    );
    expect(mockRes.status).toBe(200);
    const mockData = (await mockRes.json()) as { attempts: number; charge: unknown };
    expect(mockData.attempts).toBe(1);

    // El saldo subió exactamente una vez el monto
    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(updatedWallet).not.toBeNull();
    expect(updatedWallet!.balance.toFixed(2)).toBe("150.00");

    // Un replay posterior responde 200, Idempotent-Replayed: true y el mismo new_balance (R8.5)
    const replayRes = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get("Idempotent-Replayed")).toBe("true");
    const replayJson = (await replayRes.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance: number;
    };
    expect(replayJson.operation_id).toBe(primaryOpId);
    expect(replayJson.status).toBe("completed");
    expect(replayJson.new_balance).toBe(150.0);
  }, 15000);

  test("2. Flaky: card_flaky responde 200 completed con 2 intentos en mock y 1 asiento", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "50.00" });
    const key = newIdempotencyKey();
    const amount = 30.0;
    const body = cashInBody(userId, { amount, paymentMethod: "card_flaky" });

    const res = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance: number;
    };
    expect(json.status).toBe("completed");
    expect(json.amount).toBe(30.0);
    expect(json.new_balance).toBe(80.0);
    const opId = json.operation_id;

    // El mock registra attempts = 2 para la referencia operation_id
    const mockRes = await fetch(
      `${e2eEnv.E2E_MOCK_PSP_URL}/__admin/charges/${opId}`
    );
    expect(mockRes.status).toBe(200);
    const mockData = (await mockRes.json()) as { attempts: number; charge: unknown };
    expect(mockData.attempts).toBe(2);

    // Hay 1 cargo y 1 asiento en DB
    const ops = await prisma.cashInOperation.findMany({
      where: { id: opId },
    });
    expect(ops.length).toBe(1);
    expect(ops[0]!.status).toBe("COMPLETED");

    const entries = await prisma.ledgerEntry.findMany({
      where: { operationId: opId },
    });
    expect(entries.length).toBe(1);
    expect(entries[0]!.amount.toFixed(2)).toBe("30.00");
    expect(entries[0]!.balanceAfter.toFixed(2)).toBe("80.00");

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(updatedWallet).not.toBeNull();
    expect(updatedWallet!.balance.toFixed(2)).toBe("80.00");
  }, 15000);

  test("3. Declined: card_declined responde 422 PAYMENT_DECLINED, el saldo no cambia y attempts es 1", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "100.00" });
    const key = newIdempotencyKey();
    const amount = 25.0;
    const body = cashInBody(userId, { amount, paymentMethod: "card_declined" });

    const res = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const json = (await res.json()) as {
      code: string;
      status: number;
      operation_id: string;
      detail: string;
    };
    expect(json.code).toBe("PAYMENT_DECLINED");
    expect(json.operation_id).toBeDefined();
    const opId = json.operation_id;

    // Mock registra attempts = 1
    const mockRes = await fetch(
      `${e2eEnv.E2E_MOCK_PSP_URL}/__admin/charges/${opId}`
    );
    expect(mockRes.status).toBe(200);
    const mockData = (await mockRes.json()) as { attempts: number; charge: unknown };
    expect(mockData.attempts).toBe(1);

    // En DB la operación está en FAILED, saldo no cambia, 0 asientos
    const op = await prisma.cashInOperation.findUnique({
      where: { id: opId },
    });
    expect(op).not.toBeNull();
    expect(op!.status).toBe("FAILED");

    const entries = await prisma.ledgerEntry.findMany({
      where: { operationId: opId },
    });
    expect(entries.length).toBe(0);

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(updatedWallet).not.toBeNull();
    expect(updatedWallet!.balance.toFixed(2)).toBe("100.00");
  }, 10000);

  test("4. Timeout: card_timeout responde 202 unknown, se completa en DB (webhook o reconciliador) con 1 asiento y replay 200", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "20.00" });
    const key = newIdempotencyKey();
    const amount = 45.0;
    const body = cashInBody(userId, { amount, paymentMethod: "card_timeout" });

    const res = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(res.status).toBe(202);

    const json = (await res.json()) as {
      operation_id: string;
      status: string;
      amount: number;
    };
    expect(json.status).toBe("unknown");
    expect(json.operation_id).toBeDefined();
    const opId = json.operation_id;

    // Con waitFor, leer la operación con Prisma hasta COMPLETED
    const completedOp = await waitFor(
      async () => {
        const op = await prisma.cashInOperation.findUnique({
          where: { id: opId },
        });
        return op?.status === "COMPLETED" ? op : null;
      },
      20000,
      200
    );

    expect(completedOp).not.toBeNull();
    expect(completedOp.status).toBe("COMPLETED");

    // Al final hay 1 asiento, attempts es 1 y el saldo subió una vez
    const entries = await prisma.ledgerEntry.findMany({
      where: { operationId: opId },
    });
    expect(entries.length).toBe(1);
    expect(entries[0]!.amount.toFixed(2)).toBe("45.00");
    expect(entries[0]!.balanceAfter.toFixed(2)).toBe("65.00");

    const mockRes = await fetch(
      `${e2eEnv.E2E_MOCK_PSP_URL}/__admin/charges/${opId}`
    );
    expect(mockRes.status).toBe(200);
    const mockData = (await mockRes.json()) as { attempts: number; charge: unknown };
    expect(mockData.attempts).toBe(1);

    const updatedWallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(updatedWallet).not.toBeNull();
    expect(updatedWallet!.balance.toFixed(2)).toBe("65.00");

    // Se cierra por el webhook del mock o por el reconciliador, y el test acepta cualquiera de los dos:
    // lo determina con WebhookEvent.outcome y reconcileAttempts, lo registra en el nombre/log,
    // y verifica que hay como mucho un WebhookEvent con outcome = "APPLIED" para la operación.
    const webhookEvents = await prisma.webhookEvent.findMany({
      where: { operationId: opId },
    });
    const appliedEvents = webhookEvents.filter((e) => e.outcome === "APPLIED");
    expect(appliedEvents.length).toBeLessThanOrEqual(1);

    const closedByWebhook = appliedEvents.length === 1;
    const closedByReconciler =
      !closedByWebhook && completedOp.reconcileAttempts > 0;
    console.log(
      `[card_timeout] Operación ${opId} resuelta por: ${
        closedByWebhook
          ? "webhook"
          : closedByReconciler
          ? "reconciliador"
          : "desconocido"
      }`
    );
    expect(closedByWebhook || closedByReconciler).toBe(true);

    // Luego un replay responde 200 completed con el new_balance del asiento
    const replayRes = await postCashIn(e2eEnv.E2E_NGINX_URL, key, body);
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get("Idempotent-Replayed")).toBe("true");
    const replayJson = (await replayRes.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance: number;
    };
    expect(replayJson.status).toBe("completed");
    expect(replayJson.operation_id).toBe(opId);
    expect(replayJson.new_balance).toBe(entries[0]!.balanceAfter.toNumber());
  }, 25000);

  test("5. Saldo exacto: 20 recargas concurrentes con keys distintas entre app1 y app2 dejan saldo exacto y 20 asientos", async () => {
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "0.00" });

    const amounts = [
      10.15, 20.25, 5.5, 12.33, 7.89, 15.4, 22.11, 3.75, 8.99, 14.2,
      11.11, 19.99, 6.45, 13.8, 2.5, 17.65, 9.3, 4.85, 16.7, 25.0,
    ];

    let expectedTotal = new Prisma.Decimal("0.00");
    const requests = amounts.map((amt, idx) => {
      expectedTotal = expectedTotal.add(new Prisma.Decimal(amt.toFixed(2)));
      const key = newIdempotencyKey();
      const body = cashInBody(userId, { amount: amt, paymentMethod: "card_ok" });
      const targetUrl = idx % 2 === 0 ? e2eEnv.E2E_APP1_URL : e2eEnv.E2E_APP2_URL;
      return postCashIn(targetUrl, key, body);
    });

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe("completed");
    }

    // Saldo final es la suma exacta calculada con Prisma.Decimal
    const updatedWallet = await prisma.wallet.findUnique({
      where: { id: wallet.id },
    });
    expect(updatedWallet).not.toBeNull();
    expect(updatedWallet!.balance.equals(expectedTotal)).toBe(true);

    // Hay 20 asientos y sus balanceAfter son todos distintos
    const entries = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
    });
    expect(entries.length).toBe(20);

    const balanceStrings = entries.map((e) => e.balanceAfter.toString());
    const uniqueBalances = new Set(balanceStrings);
    expect(uniqueBalances.size).toBe(20);
  }, 20000);
});
