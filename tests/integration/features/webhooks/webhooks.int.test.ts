import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import { FakePaymentProvider } from "../../../../src/infra/payment-provider/fake.provider";
import type {
  ChargeInput,
  ChargeResult,
  GetChargeResult,
  PaymentProvider,
} from "../../../../src/infra/payment-provider/payment-provider";
import type { PrismaClient } from "../../../../src/infra/prisma";
import { createApp } from "../../../../src/app";
import { createWalletService, type WalletService } from "../../../../src/features/wallet/wallet.service";
import { createWebhooksService } from "../../../../src/features/webhooks/webhooks.service";
import { withDbRetry } from "../../../../src/shared/db-retry";
import type { ProblemDetails } from "../../../../src/shared/error-handler";
import {
  createLedgerEntry,
  createOperation,
  createWallet,
  uniqueUserId,
} from "../../../helpers/factories";
import { postCashIn } from "../../../helpers/http";
import { closePods, createPods, type Pod } from "../../../helpers/pods";
import { postWebhook, signWebhook } from "../../../helpers/webhook-signature";

function uniqueEventId(): string {
  return `evt_t_${crypto.randomUUID().replaceAll("-", "")}`;
}

function uniqueChargeId(): string {
  return `ch_t_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface WebhookPayloadOverrides {
  eventId?: string;
  type?: "charge.succeeded" | "charge.failed" | "charge.pending";
  createdAt?: string;
  chargeId?: string;
  reference: string;
  amount?: number;
  currency?: string;
  failureCode?: string | null;
}

function makeWebhookPayload(overrides: WebhookPayloadOverrides) {
  return {
    event_id: overrides.eventId ?? uniqueEventId(),
    type: overrides.type ?? "charge.succeeded",
    created_at: overrides.createdAt ?? new Date().toISOString(),
    data: {
      charge_id: overrides.chargeId ?? uniqueChargeId(),
      reference: overrides.reference,
      amount: overrides.amount ?? 100.0,
      currency: overrides.currency ?? "PEN",
      failure_code: overrides.failureCode ?? null,
    },
  };
}

describe("POST /webhooks/payment (integration)", () => {
  let pods: Pod[] = [];
  let provider: FakePaymentProvider;
  let prisma: PrismaClient;

  beforeAll(() => {
    provider = new FakePaymentProvider();
    pods = createPods(2, { provider });
    prisma = pods[0]!.prisma;
  });

  afterAll(async () => {
    await closePods(pods);
  });

  test("1. Duplicado: mismo charge.succeeded dos veces sobre una operación UNKNOWN", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "50.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "100.00",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 100.0,
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    // Primer request: duplicate = false
    const res1 = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { received: boolean; duplicate: boolean };
    expect(body1).toEqual({ received: true, duplicate: false });

    // Verificación DB tras primera entrega
    const opAfter1 = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter1.status).toBe("COMPLETED");

    const entries1 = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries1).toHaveLength(1);
    expect(entries1[0]!.amount.toFixed(2)).toBe("100.00");
    expect(entries1[0]!.balanceAfter.toFixed(2)).toBe("150.00");

    const walletAfter1 = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter1.balance.equals(new Prisma.Decimal("150.00"))).toBe(true);

    const event1 = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event1.outcome).toBe("APPLIED");
    expect(event1.operationId).toBe(op.id);

    // Segundo request: duplicate = true
    const res2 = await postWebhook(pods[1]!.app, rawBody, { signature });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { received: boolean; duplicate: boolean };
    expect(body2).toEqual({ received: true, duplicate: true });

    // Verificación DB tras segunda entrega: sin duplicar asientos ni saldo
    const entries2 = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries2).toHaveLength(1);

    const walletAfter2 = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter2.balance.equals(new Prisma.Decimal("150.00"))).toBe(true);

    const events = await prisma.webhookEvent.findMany({
      where: { providerEventId: payload.event_id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("APPLIED");
  });

  test("2. Duplicado concurrente: el mismo evento enviado con Promise.all a app1 y app2", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "20.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "50.00",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 50.0,
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const [res1, res2] = await Promise.all([
      postWebhook(pods[0]!.app, rawBody, { signature }),
      postWebhook(pods[1]!.app, rawBody, { signature }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const b1 = (await res1.json()) as { received: boolean; duplicate: boolean };
    const b2 = (await res2.json()) as { received: boolean; duplicate: boolean };
    expect(b1.received).toBe(true);
    expect(b2.received).toBe(true);

    const duplicates = [b1.duplicate, b2.duplicate].sort();
    expect(duplicates).toEqual([false, true]);

    const events = await prisma.webhookEvent.findMany({
      where: { providerEventId: payload.event_id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("APPLIED");

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.toFixed(2)).toBe("50.00");
    expect(entries[0]!.balanceAfter.toFixed(2)).toBe("70.00");

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.equals(new Prisma.Decimal("70.00"))).toBe(true);

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("COMPLETED");
  });

  test("3. failed tras COMPLETED: operación completada, llega charge.failed", async () => {
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "150.00" });
    const chargeId = uniqueChargeId();
    const op = await createOperation(prisma, {
      userId,
      status: "COMPLETED",
      amount: "100.00",
      providerChargeId: chargeId,
      completedAt: new Date(),
    });
    await createLedgerEntry(prisma, {
      walletId: wallet.id,
      operationId: op.id,
      amount: "100.00",
      balanceAfter: "150.00",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      type: "charge.failed",
      amount: 100.0,
      failureCode: "insufficient_funds",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("COMPLETED");

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter.balance.equals(new Prisma.Decimal("150.00"))).toBe(true);

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(1);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event.outcome).toBe("IGNORED_OUT_OF_ORDER");
    expect(event.operationId).toBe(op.id);
  });

  test("4. succeeded tras FAILED: operación fallida, llega charge.succeeded", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "50.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "FAILED",
      amount: "100.00",
      failureCode: "card_declined",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      type: "charge.succeeded",
      amount: 100.0,
      failureCode: null,
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("FAILED");

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter.balance.equals(new Prisma.Decimal("50.00"))).toBe(true);

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(0);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event.outcome).toBe("IGNORED_OUT_OF_ORDER");
    expect(event.operationId).toBe(op.id);
  });

  test("5. Webhook antes de la respuesta síncrona (R9.8): POST /cash-in en app1 con proveedor bloqueado, charge.succeeded en app2", async () => {
    const chargeStarted = createDeferred<{ reference: string }>();
    const chargeRelease = createDeferred<ChargeResult>();

    class ControllableProvider implements PaymentProvider {
      async charge(input: ChargeInput): Promise<ChargeResult> {
        chargeStarted.resolve({ reference: input.reference });
        return chargeRelease.promise;
      }
      async getCharge(): Promise<GetChargeResult> {
        return { status: "not_found" };
      }
    }

    const controllableProvider = new ControllableProvider();
    const controlledPods = createPods(2, { provider: controllableProvider });

    try {
      const userId = uniqueUserId();
      await createWallet(controlledPods[0]!.prisma, { userId, balance: "100.00" });
      const key = crypto.randomUUID();

      // Iniciar cash-in en app1 (se quedará esperando en el charge bloqueado)
      const cashInPromise = postCashIn(
        controlledPods[0]!.app,
        {
          user_id: userId,
          amount: 50.0,
          currency: "PEN",
          payment_method: "card_controlled",
        },
        { key }
      );

      // Esperar a que el provider reciba la llamada y capture el operationId
      const { reference: operationId } = await chargeStarted.promise;

      // Mientras app1 espera al provider, llega charge.succeeded a app2
      const webhookPayload = makeWebhookPayload({
        reference: operationId,
        amount: 50.0,
        type: "charge.succeeded",
      });
      const rawWebhook = JSON.stringify(webhookPayload);
      const webhookSig = signWebhook(rawWebhook, controlledPods[1]!.config.WEBHOOK_SECRET);

      const webhookRes = await postWebhook(controlledPods[1]!.app, rawWebhook, {
        signature: webhookSig,
      });
      expect(webhookRes.status).toBe(200);
      const webhookBody = (await webhookRes.json()) as { received: boolean; duplicate: boolean };
      expect(webhookBody).toEqual({ received: true, duplicate: false });

      const event = await controlledPods[0]!.prisma.webhookEvent.findUniqueOrThrow({
        where: { providerEventId: webhookPayload.event_id },
      });
      expect(event.outcome).toBe("APPLIED");

      // Liberar el charge diferido en app1
      chargeRelease.resolve({
        status: "succeeded",
        chargeId: uniqueChargeId(),
      });

      // La respuesta síncrona debe ser 200 completed con el new_balance registrado por el webhook
      const cashInRes = await cashInPromise;
      expect(cashInRes.status).toBe(200);
      const cashInBody = (await cashInRes.json()) as {
        operation_id: string;
        status: string;
        amount: number;
        new_balance: number;
      };
      expect(cashInBody.status).toBe("completed");
      expect(cashInBody.amount).toBe(50);
      expect(cashInBody.new_balance).toBe(150);
      expect(cashInBody.operation_id).toBe(operationId);

      // Verificación en base de datos: un solo asiento de ledger
      const entries = await controlledPods[0]!.prisma.ledgerEntry.findMany({
        where: { operationId },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.amount.toFixed(2)).toBe("50.00");
      expect(entries[0]!.balanceAfter.toFixed(2)).toBe("150.00");

      const wallet = await controlledPods[0]!.prisma.wallet.findUniqueOrThrow({
        where: { userId },
      });
      expect(wallet.balance.equals(new Prisma.Decimal("150.00"))).toBe(true);

      const op = await controlledPods[0]!.prisma.cashInOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      expect(op.status).toBe("COMPLETED");
    } finally {
      await closePods(controlledPods);
    }
  });

  test("6. Monto distinto: evento con amount distinto al de la operación", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "200.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "100.00",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 200.0, // Monto distinto a 100.00
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("UNKNOWN");

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(0);

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter.balance.equals(new Prisma.Decimal("200.00"))).toBe(true);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event.outcome).toBe("AMOUNT_MISMATCH");
    expect(event.operationId).toBe(op.id);
  });

  test("7. Moneda distinta: evento con currency distinta a la de la operación", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "200.00", currency: "PEN" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "100.00",
      currency: "PEN",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 100.0,
      currency: "USD", // Moneda distinta a PEN
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("UNKNOWN");

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(0);

    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter.balance.equals(new Prisma.Decimal("200.00"))).toBe(true);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event.outcome).toBe("AMOUNT_MISMATCH");
    expect(event.operationId).toBe(op.id);
  });

  test("8. Error transitorio: applyCredit inyectado que lanza en la primera llamada", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "100.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "50.00",
    });

    const realWalletService = createWalletService({ prisma: pods[0]!.prisma });
    let failFirstAttempt = true;
    const injectedApplyCredit: WalletService["applyCredit"] = async (input, tx) => {
      if (failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("Simulated transient non-retryable failure in applyCredit");
      }
      return realWalletService.applyCredit(input, tx);
    };

    const customWebhooksService = createWebhooksService({
      prisma: pods[0]!.prisma,
      applyCredit: injectedApplyCredit,
      withDbRetry,
    });

    const customApp = createApp({
      config: pods[0]!.config,
      logger: pods[0]!.logger,
      prisma: pods[0]!.prisma,
      redis: pods[0]!.redis,
      paymentProvider: pods[0]!.paymentProvider,
      lock: pods[0]!.lock,
      webhooksService: customWebhooksService,
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 50.0,
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    // Intento 1: falla con error transitorio no reintentable dentro de la transacción -> respuesta 5xx
    const res1 = await postWebhook(customApp, rawBody, { signature });
    expect(res1.status).toBeGreaterThanOrEqual(500);
    expect(res1.status).toBeLessThan(600);

    // Verificación DB tras el 5xx: WebhookEvent no existe (rollback completo de la transacción)
    const eventAfter5xx = await prisma.webhookEvent.findUnique({
      where: { providerEventId: payload.event_id },
    });
    expect(eventAfter5xx).toBeNull();

    const opAfter5xx = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter5xx.status).toBe("UNKNOWN");

    const entriesAfter5xx = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entriesAfter5xx).toHaveLength(0);

    const walletAfter5xx = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletAfter5xx.balance.equals(new Prisma.Decimal("100.00"))).toBe(true);

    // Intento 2: se reenvía el mismo evento y esta vez se procesa normalmente
    const res2 = await postWebhook(customApp, rawBody, { signature });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { received: boolean; duplicate: boolean };
    expect(body2).toEqual({ received: true, duplicate: false });

    // Verificación DB: COMPLETED, un solo asiento, WebhookEvent outcome APPLIED
    const eventSuccess = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(eventSuccess.outcome).toBe("APPLIED");
    expect(eventSuccess.operationId).toBe(op.id);

    const opSuccess = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opSuccess.status).toBe("COMPLETED");

    const entriesSuccess = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entriesSuccess).toHaveLength(1);
    expect(entriesSuccess[0]!.amount.toFixed(2)).toBe("50.00");
    expect(entriesSuccess[0]!.balanceAfter.toFixed(2)).toBe("150.00");

    const walletSuccess = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(walletSuccess.balance.equals(new Prisma.Decimal("150.00"))).toBe(true);
  });

  test("9. Firma inválida: 401 WEBHOOK_SIGNATURE_INVALID, ningún WebhookEvent creado", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "100.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "50.00",
    });

    const payload = makeWebhookPayload({
      reference: op.id,
      amount: 50.0,
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const invalidSignature = signWebhook(rawBody, "invalid_secret_key_12345");

    const res = await postWebhook(pods[0]!.app, rawBody, { signature: invalidSignature });
    expect(res.status).toBe(401);
    const problem = (await res.json()) as ProblemDetails;
    expect(problem.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    const event = await prisma.webhookEvent.findUnique({
      where: { providerEventId: payload.event_id },
    });
    expect(event).toBeNull();

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("UNKNOWN");

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(0);
  });

  test("10. Huérfano: reference inexistente guardada con operationId null y outcome ORPHAN", async () => {
    const nonExistentReference = `op_orphan_${crypto.randomUUID().replaceAll("-", "")}`;
    const payload = makeWebhookPayload({
      reference: nonExistentReference,
      amount: 50.0,
      type: "charge.succeeded",
    });
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: payload.event_id },
    });
    expect(event.operationId).toBeNull();
    expect(event.outcome).toBe("ORPHAN");
  });

  test("11. Campo desconocido: charge.succeeded firmado con campos extras en raíz y en data", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "100.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "UNKNOWN",
      amount: "75.00",
    });

    const basePayload = makeWebhookPayload({
      reference: op.id,
      amount: 75.0,
      type: "charge.succeeded",
    });
    const payloadWithExtras = {
      ...basePayload,
      unknown_root_param: "extra_root_value",
      data: {
        ...basePayload.data,
        unknown_nested_param: 98765,
      },
    };

    const rawBody = JSON.stringify(payloadWithExtras);
    const signature = signWebhook(rawBody, pods[0]!.config.WEBHOOK_SECRET);

    const res = await postWebhook(pods[0]!.app, rawBody, { signature });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; duplicate: boolean };
    expect(body).toEqual({ received: true, duplicate: false });

    const opAfter = await prisma.cashInOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(opAfter.status).toBe("COMPLETED");

    const entries = await prisma.ledgerEntry.findMany({ where: { operationId: op.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.toFixed(2)).toBe("75.00");
    expect(entries[0]!.balanceAfter.toFixed(2)).toBe("175.00");

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance.equals(new Prisma.Decimal("175.00"))).toBe(true);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { providerEventId: basePayload.event_id },
    });
    expect(event.outcome).toBe("APPLIED");
    expect(event.operationId).toBe(op.id);
  });
});
