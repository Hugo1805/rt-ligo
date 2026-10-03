import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import { loadConfig } from "../../../../src/infra/config";
import { createLogger, type Logger } from "../../../../src/infra/logger";
import { ProviderUnavailableError } from "../../../../src/infra/payment-provider/errors";
import { FakePaymentProvider } from "../../../../src/infra/payment-provider/fake.provider";
import type {
  ChargeInput,
  ChargeResult,
  GetChargeResult,
  PaymentProvider,
} from "../../../../src/infra/payment-provider/payment-provider";
import { createPrismaClient, type DbClient, type PrismaClient } from "../../../../src/infra/prisma";
import { createWalletService } from "../../../../src/features/wallet/wallet.service";
import {
  createReconciliationRepository,
  RECONCILABLE_STATUSES,
  type ReconciliationRepository,
} from "../../../../src/features/reconciliation/reconciliation.repository";
import {
  createReconciler,
  LEASE_DURATION_MS,
  type Reconciler,
  type ReconcilerConfig,
} from "../../../../src/features/reconciliation/reconciliation.service";
import {
  createOperation,
  createWallet,
  uniqueUserId,
  type CreateOperationOverrides,
} from "../../../helpers/factories";

const CONFIG: ReconcilerConfig = {
  RECONCILE_INTERVAL_MS: 10_000,
  RECONCILE_STALE_MS: 30_000,
  RECONCILE_MAX_ATTEMPTS: 5,
};

class TestPaymentProvider extends FakePaymentProvider {
  readonly getChargeCalls: string[] = [];

  override async getCharge(reference: string): Promise<GetChargeResult> {
    this.getChargeCalls.push(reference);
    return super.getCharge(reference);
  }

  getChargeCount(reference: string): number {
    return this.getChargeCalls.filter((ref) => ref === reference).length;
  }
}

class AlwaysFailingPaymentProvider extends FakePaymentProvider {
  callCount = 0;

  override async getCharge(_reference: string): Promise<GetChargeResult> {
    this.callCount++;
    throw new ProviderUnavailableError("Payment provider is down");
  }

  override async charge(_input: ChargeInput): Promise<ChargeResult> {
    this.callCount++;
    throw new ProviderUnavailableError("Payment provider is down");
  }
}

function createMemoryLogger(level: "debug" | "info" = "debug") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level },
    {
      write: (msg: string) => {
        try {
          lines.push(JSON.parse(msg));
        } catch {
          // ignore non-json
        }
      },
    }
  );
  return { logger, lines };
}

/**
 * Scopes findCandidates strictly to operations created in the current test.
 * This guarantees the test reconciler never claims or mutates rows from concurrent tests,
 * while still executing real Postgres queries with the exact reconciler filters.
 */
function createScopedReconciliationRepository(
  prisma: DbClient,
  scopedIds: Set<string>
): ReconciliationRepository {
  const realRepo = createReconciliationRepository(prisma);
  return {
    ...realRepo,
    async findCandidates(input) {
      if (scopedIds.size === 0) return [];
      return prisma.cashInOperation.findMany({
        where: {
          id: { in: Array.from(scopedIds) },
          status: { in: RECONCILABLE_STATUSES },
          updatedAt: { lt: input.staleBefore },
          reconcileAttempts: { lt: input.maxAttempts },
        },
        orderBy: { updatedAt: "asc" },
        take: input.limit,
        select: { id: true },
      });
    },
  };
}

describe("Reconciliation (integration)", () => {
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;

  beforeAll(() => {
    const { DATABASE_URL } = loadConfig();
    prismaA = createPrismaClient(DATABASE_URL);
    prismaB = createPrismaClient(DATABASE_URL);
  });

  afterAll(async () => {
    await Promise.allSettled([prismaA.$disconnect(), prismaB.$disconnect()]);
  });

  async function createTestOperation(
    prisma: DbClient,
    scopedIds: Set<string>,
    overrides?: CreateOperationOverrides
  ) {
    const op = await createOperation(prisma, overrides);
    scopedIds.add(op.id);
    return op;
  }

  function makeReconciler(options: {
    prisma: PrismaClient;
    podId: string;
    scopedIds: Set<string>;
    provider: PaymentProvider;
    now: () => Date;
    logger?: Logger;
    config?: ReconcilerConfig;
  }): Reconciler {
    const repo = createScopedReconciliationRepository(options.prisma, options.scopedIds);
    const walletService = createWalletService({ prisma: options.prisma });
    return createReconciler({
      prisma: options.prisma,
      paymentProvider: options.provider,
      applyCredit: walletService.applyCredit,
      logger: options.logger ?? createLogger({ level: "silent" }),
      config: options.config ?? CONFIG,
      podId: options.podId,
      now: options.now,
      repository: repo,
    });
  }

  test("1. Dos reconciliadores concurrentes resuelven una operacion UNKNOWN exactamente una vez", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "200.00" });
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "UNKNOWN",
      amount: "50.00",
    });

    // Succeeded charge pre-exists in the fake provider
    const chargeRes = await provider.charge({
      reference: op.id,
      amount: "50.00",
      currency: "PEN",
      paymentMethod: "card_ok",
      requestId: "req-setup-1",
    });
    provider.getChargeCalls.length = 0;

    const recA = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });
    const recB = makeReconciler({
      prisma: prismaB,
      podId: "pod-b",
      scopedIds,
      provider,
      now: () => testNow,
    });

    await Promise.all([recA.runOnce(), recB.runOnce()]);

    expect(provider.getChargeCount(op.id)).toBe(1);

    const updatedOp = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(updatedOp.status).toBe("COMPLETED");
    expect(updatedOp.reconcileAttempts).toBe(1);
    expect(updatedOp.providerChargeId).toBe(chargeRes.chargeId);

    const entries = await prismaA.ledgerEntry.findMany({
      where: { operationId: op.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.equals(new Prisma.Decimal("50.00"))).toBe(true);
    expect(entries[0]!.balanceAfter.equals(new Prisma.Decimal("250.00"))).toBe(true);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("250.00"))).toBe(true);
  });

  test("2. Muchas operaciones (20 UNKNOWN) con dos reconciliadores concurrentes: cada una tiene exactamente un asiento y la suma de getCharge es 20", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "0.00" });
    const count = 20;
    const amountEach = "10.00";

    const ops = await Promise.all(
      Array.from({ length: count }, () =>
        createTestOperation(prismaA, scopedIds, {
          userId: wallet.userId,
          status: "UNKNOWN",
          amount: amountEach,
        })
      )
    );

    for (const op of ops) {
      await provider.charge({
        reference: op.id,
        amount: amountEach,
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: `setup-${op.id}`,
      });
    }
    provider.getChargeCalls.length = 0;

    const recA = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });
    const recB = makeReconciler({
      prisma: prismaB,
      podId: "pod-b",
      scopedIds,
      provider,
      now: () => testNow,
    });

    await Promise.all([recA.runOnce(), recB.runOnce()]);

    expect(provider.getChargeCalls.length).toBe(20);
    for (const op of ops) {
      expect(provider.getChargeCount(op.id)).toBe(1);
    }

    const storedOps = await prismaA.cashInOperation.findMany({
      where: { id: { in: ops.map((o) => o.id) } },
    });
    expect(storedOps).toHaveLength(20);
    for (const stored of storedOps) {
      expect(stored.status).toBe("COMPLETED");
      expect(stored.reconcileAttempts).toBe(1);
    }

    const entries = await prismaA.ledgerEntry.findMany({
      where: { walletId: wallet.id },
    });
    expect(entries).toHaveLength(20);

    // Each operation must have exactly 1 ledger entry
    const entryOpIds = entries.map((e) => e.operationId);
    expect(new Set(entryOpIds).size).toBe(20);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("200.00"))).toBe(true);
  });

  test("3. not_found: operacion PROCESSING sin cargo en el fake reenvia charge con reference = operation_id y completa", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "0.00" });
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "PROCESSING",
      amount: "75.00",
    });

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });

    await rec.runOnce();

    expect(provider.getChargeCalls).toContain(op.id);
    expect(provider.chargeCount(op.id)).toBe(1);

    const chargeCall = provider.calls.find((c) => c.reference === op.id);
    expect(chargeCall).toBeDefined();
    expect(chargeCall?.reference).toBe(op.id);
    expect(chargeCall?.amount).toBe("75.00");

    const updatedOp = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(updatedOp.status).toBe("COMPLETED");
    expect(updatedOp.providerChargeId).toBeDefined();

    const entries = await prismaA.ledgerEntry.findMany({
      where: { operationId: op.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.equals(new Prisma.Decimal("75.00"))).toBe(true);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("75.00"))).toBe(true);
  });

  test("4. not_found dos veces: primer charge falla con ProviderUnavailableError, luego otro ciclo completa y el fake tiene un solo cargo para esa referencia", async () => {
    const scopedIds = new Set<string>();
    let testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "0.00" });
    // paymentMethod "card_flaky" throws ProviderUnavailableError on the first charge call
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "PROCESSING",
      amount: "60.00",
      paymentMethod: "card_flaky",
    });

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });

    // Cycle 1: getCharge returns not_found -> charge throws ProviderUnavailableError -> lease released
    await rec.runOnce();

    expect(provider.chargeCount(op.id)).toBe(1);
    const opAfterCycle1 = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(opAfterCycle1.status).toBe("PROCESSING");
    expect(opAfterCycle1.reconcileAttempts).toBe(1);
    expect(opAfterCycle1.leaseOwner).toBeNull();
    expect(opAfterCycle1.lastError).toContain("ProviderUnavailableError");

    const entriesAfterCycle1 = await prismaA.ledgerEntry.count({
      where: { operationId: op.id },
    });
    expect(entriesAfterCycle1).toBe(0);

    // In the fake, no charge succeeded yet
    const chargeCheck1 = await provider.getCharge(op.id);
    expect(chargeCheck1.status).toBe("not_found");

    // Cycle 2: Advance time past lease and stale threshold
    testNow = new Date(testNow.getTime() + LEASE_DURATION_MS + CONFIG.RECONCILE_STALE_MS + 5000);
    await rec.runOnce();

    expect(provider.chargeCount(op.id)).toBe(2);

    const chargeCheck2 = await provider.getCharge(op.id);
    expect(chargeCheck2.status).toBe("succeeded");

    const opAfterCycle2 = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(opAfterCycle2.status).toBe("COMPLETED");
    expect(opAfterCycle2.reconcileAttempts).toBe(2);

    const entriesAfterCycle2 = await prismaA.ledgerEntry.findMany({
      where: { operationId: op.id },
    });
    expect(entriesAfterCycle2).toHaveLength(1);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("60.00"))).toBe(true);
  });

  test("5. declined: operacion UNKNOWN con cargo rechazado termina FAILED y el saldo no cambia", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "100.00" });
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "UNKNOWN",
      amount: "50.00",
      paymentMethod: "card_declined",
    });

    // Provider charge was declined
    await provider.charge({
      reference: op.id,
      amount: "50.00",
      currency: "PEN",
      paymentMethod: "card_declined",
      requestId: "req-setup-dec",
    });
    const chargesBefore = provider.calls.length;

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });

    await rec.runOnce();

    expect(provider.getChargeCalls).toContain(op.id);
    // Did not make a new charge call
    expect(provider.calls.length).toBe(chargesBefore);

    const updatedOp = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(updatedOp.status).toBe("FAILED");
    expect(updatedOp.failureCode).toBe("insufficient_funds");

    const entries = await prismaA.ledgerEntry.count({
      where: { operationId: op.id },
    });
    expect(entries).toBe(0);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("100.00"))).toBe(true);
  });

  test("6. Lease vigente: operacion con leaseUntil en el futuro de otro podId, runOnce() no la toca", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();

    const wallet = await createWallet(prismaA, { balance: "50.00" });
    const futureLease = new Date(testNow.getTime() + 120_000);

    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "UNKNOWN",
      amount: "50.00",
      leaseOwner: "pod-other",
      leaseUntil: futureLease,
      reconcileAttempts: 0,
    });

    await provider.charge({
      reference: op.id,
      amount: "50.00",
      currency: "PEN",
      paymentMethod: "card_ok",
      requestId: "req-setup-lease",
    });
    provider.getChargeCalls.length = 0;

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
    });

    await rec.runOnce();

    expect(provider.getChargeCount(op.id)).toBe(0);

    const opInDb = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(opInDb.status).toBe("UNKNOWN");
    expect(opInDb.leaseOwner).toBe("pod-other");
    expect(opInDb.leaseUntil?.getTime()).toBe(futureLease.getTime());
    expect(opInDb.reconcileAttempts).toBe(0);

    const entries = await prismaA.ledgerEntry.count({
      where: { operationId: op.id },
    });
    expect(entries).toBe(0);

    const walletInDb = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(walletInDb.balance.equals(new Prisma.Decimal("50.00"))).toBe(true);
  });

  test("7. Tope de intentos: proveedor que siempre lanza error; tras RECONCILE_MAX_ATTEMPTS queda UNKNOWN con log error reconcile.exhausted y un ciclo mas no llama al proveedor", async () => {
    const scopedIds = new Set<string>();
    let testNow = new Date(Date.now() + 3600_000);
    const provider = new AlwaysFailingPaymentProvider();
    const { logger, lines } = createMemoryLogger("debug");

    const wallet = await createWallet(prismaA, { balance: "0.00" });
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "PROCESSING",
      amount: "50.00",
      reconcileAttempts: 0,
    });

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
      logger,
      config: CONFIG,
    });

    // Execute RECONCILE_MAX_ATTEMPTS cycles, advancing clock each time past lease and stale threshold
    for (let i = 0; i < CONFIG.RECONCILE_MAX_ATTEMPTS; i++) {
      if (i > 0) {
        testNow = new Date(testNow.getTime() + LEASE_DURATION_MS + CONFIG.RECONCILE_STALE_MS + 5000);
      }
      await rec.runOnce();
    }

    const opAfterMax = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(opAfterMax.status).toBe("UNKNOWN");
    expect(opAfterMax.reconcileAttempts).toBe(CONFIG.RECONCILE_MAX_ATTEMPTS);
    expect(opAfterMax.leaseOwner).toBeNull();

    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        event: "reconcile.exhausted",
        operation_id: op.id,
        attempts: CONFIG.RECONCILE_MAX_ATTEMPTS,
      })
    );

    // One more cycle with advanced time
    testNow = new Date(testNow.getTime() + LEASE_DURATION_MS + CONFIG.RECONCILE_STALE_MS + 5000);
    const callsBeforeExtraCycle = provider.callCount;

    await rec.runOnce();

    expect(provider.callCount).toBe(callsBeforeExtraCycle);

    const opAfterExtra = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(opAfterExtra.reconcileAttempts).toBe(CONFIG.RECONCILE_MAX_ATTEMPTS);
    expect(opAfterExtra.status).toBe("UNKNOWN");
  });

  test("8. PENDING atascada: pasa a PROCESSING, cobra con reference = operation_id sin llamar getCharge, y termina COMPLETED con un solo asiento", async () => {
    const scopedIds = new Set<string>();
    const testNow = new Date(Date.now() + 3600_000);
    const provider = new TestPaymentProvider();
    const { logger, lines } = createMemoryLogger("debug");

    const wallet = await createWallet(prismaA, { balance: "0.00" });
    const op = await createTestOperation(prismaA, scopedIds, {
      userId: wallet.userId,
      status: "PENDING",
      amount: "120.00",
    });

    const rec = makeReconciler({
      prisma: prismaA,
      podId: "pod-a",
      scopedIds,
      provider,
      now: () => testNow,
      logger,
    });

    await rec.runOnce();

    expect(provider.getChargeCount(op.id)).toBe(0);
    expect(provider.chargeCount(op.id)).toBe(1);

    const chargeCall = provider.calls.find((c) => c.reference === op.id);
    expect(chargeCall).toBeDefined();
    expect(chargeCall?.reference).toBe(op.id);
    expect(chargeCall?.amount).toBe("120.00");

    const updatedOp = await prismaA.cashInOperation.findUniqueOrThrow({
      where: { id: op.id },
    });
    expect(updatedOp.status).toBe("COMPLETED");

    const entries = await prismaA.ledgerEntry.findMany({
      where: { operationId: op.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount.equals(new Prisma.Decimal("120.00"))).toBe(true);

    const updatedWallet = await prismaA.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(updatedWallet.balance.equals(new Prisma.Decimal("120.00"))).toBe(true);

    const transitions = lines
      .filter((l) => l.event === "operation.transition" && l.operation_id === op.id)
      .map((l) => `${l.from}->${l.to}`);
    expect(transitions).toEqual(["PENDING->PROCESSING", "PROCESSING->COMPLETED"]);
  });
});
