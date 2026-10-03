import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import { FakePaymentProvider } from "../../../../src/infra/payment-provider/fake.provider";
import type { PrismaClient } from "../../../../src/infra/prisma";
import type { ProblemDetails } from "../../../../src/shared/error-handler";
import { createWallet, uniqueUserId } from "../../../helpers/factories";
import { postCashIn } from "../../../helpers/http";
import { closePods, createPods, type Pod } from "../../../helpers/pods";

describe("POST /cash-in (integration)", () => {
  let pods: Pod[] = [];
  let provider: FakePaymentProvider;
  let prisma: PrismaClient;

  beforeAll(() => {
    provider = new FakePaymentProvider();
    pods = createPods(3, { provider });
    prisma = pods[0]!.prisma;
  });

  afterAll(async () => {
    await closePods(pods);
  });

  test("1. Éxito: wallet en 250.00, cobro 100.00 con card_ok", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const body = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_ok",
    };

    const res = await postCashIn(pods[0]!.app, body, { key });
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance: number;
    };
    expect(json.status).toBe("completed");
    expect(json.amount).toBe(100);
    expect(json.new_balance).toBe(350);
    expect(json.operation_id).toBeDefined();

    const op = await prisma.cashInOperation.findUniqueOrThrow({
      where: { id: json.operation_id },
      include: { ledgerEntry: true },
    });
    expect(op.status).toBe("COMPLETED");
    expect(op.amount.toFixed(2)).toBe("100.00");
    expect(op.providerChargeId).toBeDefined();
    expect(op.completedAt).toBeInstanceOf(Date);
    expect(op.ledgerEntry).toBeDefined();
    expect(op.ledgerEntry?.type).toBe("CREDIT");
    expect(op.ledgerEntry?.amount.toFixed(2)).toBe("100.00");
    expect(op.ledgerEntry?.balanceAfter.toFixed(2)).toBe("350.00");

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("350.00");

    expect(provider.chargeCount(json.operation_id)).toBe(1);
  });

  test("2. Replay del 1 con la misma key y body", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const body = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_ok",
    };

    const res1 = await postCashIn(pods[0]!.app, body, { key });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };

    const res2 = await postCashIn(pods[1]!.app, body, { key });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");

    const json2 = (await res2.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };
    expect(json2.operation_id).toBe(json1.operation_id);
    expect(json2.new_balance).toBe(json1.new_balance);
    expect(json2.new_balance).toBe(350);
    expect(json2.status).toBe("completed");

    expect(provider.chargeCount(json1.operation_id)).toBe(1);

    const ops = await prisma.cashInOperation.findMany({
      where: { userId, idempotencyKey: key },
    });
    expect(ops).toHaveLength(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("350.00");
  });

  test("3. amount 100 y luego 100.00 con la misma key: se trata como replay", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const rawBody1 = JSON.stringify({
      user_id: userId,
      amount: 100,
      currency: "PEN",
      payment_method: "card_ok",
    });
    const res1 = await postCashIn(pods[0]!.app, rawBody1, { key });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };

    const rawBody2 = `{"user_id":"${userId}","amount":100.00,"currency":"PEN","payment_method":"card_ok"}`;
    const res2 = await postCashIn(pods[1]!.app, rawBody2, { key });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");

    const json2 = (await res2.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };
    expect(json2.operation_id).toBe(json1.operation_id);
    expect(json2.new_balance).toBe(json1.new_balance);
    expect(provider.chargeCount(json1.operation_id)).toBe(1);
  });

  test("4. Key reutilizada con otro amount: 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const body1 = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_ok",
    };
    const res1 = await postCashIn(pods[0]!.app, body1, { key });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { operation_id: string };
    const callsBefore = provider.calls.length;

    const body2 = {
      user_id: userId,
      amount: 150.0,
      currency: "PEN",
      payment_method: "card_ok",
    };
    const res2 = await postCashIn(pods[1]!.app, body2, { key });
    expect(res2.status).toBe(422);
    expect(res2.headers.get("Idempotent-Replayed")).toBeNull();

    const problem = (await res2.json()) as ProblemDetails;
    expect(problem.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(problem.operation_id).toBe(json1.operation_id);

    expect(provider.calls.length).toBe(callsBefore);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("350.00");
  });

  test("5. Misma key en otro usuario: crea otra operación", async () => {
    const user1 = uniqueUserId();
    const user2 = uniqueUserId();
    await createWallet(prisma, { userId: user1, balance: "250.00" });
    await createWallet(prisma, { userId: user2, balance: "100.00" });
    const key = crypto.randomUUID();

    const res1 = await postCashIn(
      pods[0]!.app,
      { user_id: user1, amount: 50.0, currency: "PEN", payment_method: "card_ok" },
      { key }
    );
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { operation_id: string };

    const res2 = await postCashIn(
      pods[1]!.app,
      { user_id: user2, amount: 50.0, currency: "PEN", payment_method: "card_ok" },
      { key }
    );
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { operation_id: string };

    expect(json1.operation_id).not.toBe(json2.operation_id);

    const op1 = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: json1.operation_id } });
    const op2 = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: json2.operation_id } });
    expect(op1.userId).toBe(user1);
    expect(op2.userId).toBe(user2);
    expect(op1.idempotencyKey).toBe(key);
    expect(op2.idempotencyKey).toBe(key);
  });

  test("6. Concurrencia: 20 requests con la misma key repartidos en 3 pods con Promise.all", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const body = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_ok",
    };

    const requests = Array.from({ length: 20 }, (_, i) => {
      const pod = pods[i % pods.length]!;
      return postCashIn(pod.app, body, { key });
    });

    const responses = await Promise.all(requests);

    for (const res of responses) {
      expect([200, 202, 409]).toContain(res.status);
      if (res.status === 409) {
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expect(res.headers.get("retry-after")).toBe("1");
        const prob = (await res.clone().json()) as ProblemDetails;
        expect(prob.code).toBe("OPERATION_IN_PROGRESS");
      }
    }

    const ops = await prisma.cashInOperation.findMany({
      where: { userId, idempotencyKey: key },
    });
    expect(ops).toHaveLength(1);
    const operation = ops[0]!;

    const ledgerEntries = await prisma.ledgerEntry.findMany({
      where: { operationId: operation.id },
    });
    expect(ledgerEntries).toHaveLength(1);

    expect(provider.chargeCount(operation.id)).toBe(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("350.00");
  });

  test("7. Saldo exacto: 60 keys distintas del mismo usuario en 3 pods con Promise.all", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "0.00" });

    const pattern = ["10.01", "0.10", "99.99"];
    const amounts = Array.from({ length: 60 }, (_, i) => pattern[i % pattern.length]!);

    const requests = amounts.map((amountStr, i) => {
      const pod = pods[i % pods.length]!;
      const key = crypto.randomUUID();
      return postCashIn(
        pod.app,
        {
          user_id: userId,
          amount: Number(amountStr),
          currency: "PEN",
          payment_method: "card_ok",
        },
        { key }
      );
    });

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const expectedTotal = amounts.reduce(
      (sum, a) => sum.plus(new Prisma.Decimal(a)),
      new Prisma.Decimal("0.00")
    );

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.equals(expectedTotal)).toBe(true);
    expect(wallet.balance.toFixed(2)).toBe(expectedTotal.toFixed(2));

    const ops = await prisma.cashInOperation.findMany({
      where: { userId },
    });
    expect(ops).toHaveLength(60);
    expect(ops.every((op) => op.status === "COMPLETED")).toBe(true);

    const entries = await prisma.ledgerEntry.findMany({
      where: { wallet: { userId } },
    });
    expect(entries).toHaveLength(60);
  });

  test("8. Rechazo con card_declined: 422 PAYMENT_DECLINED, FAILED, saldo sin cambio, chargeCount 1", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_declined",
      },
      { key }
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("PAYMENT_DECLINED");
    expect(problem.operation_id).toBeDefined();

    const op = await prisma.cashInOperation.findUniqueOrThrow({
      where: { id: problem.operation_id! },
      include: { ledgerEntry: true },
    });
    expect(op.status).toBe("FAILED");
    expect(op.failureCode).toBe("insufficient_funds");
    expect(op.ledgerEntry).toBeNull();

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("250.00");

    expect(provider.chargeCount(problem.operation_id!)).toBe(1);
  });

  test("9. Replay del 8: 422 PAYMENT_DECLINED, Idempotent-Replayed: true, chargeCount sigue en 1", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const body = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_declined",
    };

    const res1 = await postCashIn(pods[0]!.app, body, { key });
    expect(res1.status).toBe(422);
    const prob1 = (await res1.json()) as ProblemDetails;

    const res2 = await postCashIn(pods[1]!.app, body, { key });
    expect(res2.status).toBe(422);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");

    const prob2 = (await res2.json()) as ProblemDetails;
    expect(prob2.code).toBe("PAYMENT_DECLINED");
    expect(prob2.operation_id).toBe(prob1.operation_id);

    expect(provider.chargeCount(prob1.operation_id!)).toBe(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("250.00");
  });

  test("10. Timeout con card_timeout: 202, status: unknown, UNKNOWN, saldo sin cambio, chargeCount 1", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_timeout",
      },
      { key }
    );

    expect(res.status).toBe(202);
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();

    const json = (await res.json()) as {
      operation_id: string;
      status: string;
      amount: number;
      new_balance?: number;
    };
    expect(json.status).toBe("unknown");
    expect(json.operation_id).toBeDefined();
    expect("new_balance" in json).toBe(false);

    const op = await prisma.cashInOperation.findUniqueOrThrow({
      where: { id: json.operation_id },
      include: { ledgerEntry: true },
    });
    expect(op.status).toBe("UNKNOWN");
    expect(op.lastError).toBe("ProviderTimeoutError");
    expect(op.ledgerEntry).toBeNull();

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("250.00");

    expect(provider.chargeCount(json.operation_id)).toBe(1);
  });

  test("11. Replay del 10: 202 unknown, Idempotent-Replayed: true, chargeCount sigue en 1", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const body = {
      user_id: userId,
      amount: 100.0,
      currency: "PEN",
      payment_method: "card_timeout",
    };

    const res1 = await postCashIn(pods[0]!.app, body, { key });
    expect(res1.status).toBe(202);
    const json1 = (await res1.json()) as { operation_id: string };

    const res2 = await postCashIn(pods[1]!.app, body, { key });
    expect(res2.status).toBe(202);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");

    const json2 = (await res2.json()) as {
      operation_id: string;
      status: string;
      new_balance?: number;
    };
    expect(json2.status).toBe("unknown");
    expect(json2.operation_id).toBe(json1.operation_id);
    expect("new_balance" in json2).toBe(false);

    expect(provider.chargeCount(json1.operation_id)).toBe(1);

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.toFixed(2)).toBe("250.00");
  });

  test("12. Error técnico con card_flaky: 200 completed, chargeCount 2 y ambas llamadas con reference igual a operation_id", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_flaky",
      },
      { key }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      operation_id: string;
      status: string;
      new_balance: number;
    };
    expect(json.status).toBe("completed");
    expect(json.new_balance).toBe(350);

    expect(provider.chargeCount(json.operation_id)).toBe(2);

    const calls = provider.calls.filter((c) => c.reference === json.operation_id);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.reference).toBe(json.operation_id);
    expect(calls[1]!.reference).toBe(json.operation_id);
  });

  test("13. Redis caído: pods con redisUrl a un puerto sin servidor, 20 requests con la misma key en 3 pods", async () => {
    const deadPods = createPods(3, {
      provider,
      redisUrl: "redis://localhost:6399",
    });

    try {
      const userId = uniqueUserId();
      await createWallet(prisma, { userId, balance: "250.00" });
      const key = crypto.randomUUID();
      const body = {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_ok",
      };

      const requests = Array.from({ length: 20 }, (_, i) => {
        const pod = deadPods[i % deadPods.length]!;
        return postCashIn(pod.app, body, { key });
      });

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect([200, 202]).toContain(res.status);
      }

      const ops = await prisma.cashInOperation.findMany({
        where: { userId, idempotencyKey: key },
      });
      expect(ops).toHaveLength(1);
      const op = ops[0]!;

      const entries = await prisma.ledgerEntry.findMany({
        where: { operationId: op.id },
      });
      expect(entries).toHaveLength(1);

      expect(provider.chargeCount(op.id)).toBe(1);

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
      expect(wallet.balance.toFixed(2)).toBe("350.00");
    } finally {
      await closePods(deadPods);
    }
  });

  test("14. Sin wallet: 404 WALLET_NOT_FOUND, sin fila de operación y calls no cambia", async () => {
    const userId = uniqueUserId();
    const key = crypto.randomUUID();
    const callsBefore = provider.calls.length;

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_ok",
      },
      { key }
    );

    expect(res.status).toBe(404);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WALLET_NOT_FOUND");

    const op = await prisma.cashInOperation.findFirst({
      where: { userId },
    });
    expect(op).toBeNull();
    expect(provider.calls.length).toBe(callsBefore);
  });

  test("15. Wallet en USD y body en PEN: 422 CURRENCY_MISMATCH, sin operación y calls no cambia", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, currency: "USD", balance: "250.00" });
    const key = crypto.randomUUID();
    const callsBefore = provider.calls.length;

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_ok",
      },
      { key }
    );

    expect(res.status).toBe(422);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("CURRENCY_MISMATCH");

    const op = await prisma.cashInOperation.findFirst({
      where: { userId },
    });
    expect(op).toBeNull();
    expect(provider.calls.length).toBe(callsBefore);
  });

  test("16. Body inválido con key válida: 400 VALIDATION_ERROR, sin operación y calls no cambia", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const callsBefore = provider.calls.length;

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: -50.0,
        currency: "PEN",
        payment_method: "card_ok",
      },
      { key }
    );

    expect(res.status).toBe(400);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("VALIDATION_ERROR");

    const op = await prisma.cashInOperation.findFirst({
      where: { userId },
    });
    expect(op).toBeNull();
    expect(provider.calls.length).toBe(callsBefore);
  });

  test("17. X-Request-Id propio: respuesta lo devuelve y calls lo registra", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();
    const customRequestId = `req_custom_${crypto.randomUUID()}`;

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_ok",
      },
      { key, requestId: customRequestId }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe(customRequestId);

    const json = (await res.json()) as { operation_id: string };
    const call = provider.calls.find((c) => c.reference === json.operation_id);
    expect(call).toBeDefined();
    expect(call?.requestId).toBe(customRequestId);
  });

  test("18. Operación persistida antes de cobrar: en card_timeout, la fila existe con reference igual al operation_id en calls", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "250.00" });
    const key = crypto.randomUUID();

    const res = await postCashIn(
      pods[0]!.app,
      {
        user_id: userId,
        amount: 100.0,
        currency: "PEN",
        payment_method: "card_timeout",
      },
      { key }
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { operation_id: string };

    const call = provider.calls.find((c) => c.reference === json.operation_id);
    expect(call).toBeDefined();
    expect(call?.reference).toBe(json.operation_id);

    const op = await prisma.cashInOperation.findUniqueOrThrow({
      where: { id: json.operation_id },
    });
    expect(op.id).toBe(call!.reference);
    expect(op.status).toBe("UNKNOWN");
    expect(op.idempotencyKey).toBe(key);
  });
});
