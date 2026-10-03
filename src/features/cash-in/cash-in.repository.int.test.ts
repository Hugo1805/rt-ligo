import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../../infra/config";
import { createPrismaClient, type PrismaClient } from "../../infra/prisma";
import { Prisma } from "../../generated/prisma/client";
import {
  createCashInRepository,
  newOperationId,
  type CashInRepository,
} from "./cash-in.repository";
import {
  createOperation,
  createWallet,
  uniqueUserId,
} from "../../../tests/helpers/factories";

describe("CashInRepository (integration)", () => {
  let prisma: PrismaClient;
  let repo: CashInRepository;
  let concurrentClients: PrismaClient[] = [];

  beforeAll(() => {
    const config = loadConfig();
    prisma = createPrismaClient(config.DATABASE_URL);
    repo = createCashInRepository(prisma);

    // Clients for concurrency testing simulating multiple pods
    concurrentClients = [
      createPrismaClient(config.DATABASE_URL),
      createPrismaClient(config.DATABASE_URL),
      createPrismaClient(config.DATABASE_URL),
    ];
  });

  afterAll(async () => {
    await Promise.allSettled([
      prisma.$disconnect(),
      ...concurrentClients.map((c) => c.$disconnect()),
    ]);
  });

  test("newOperationId complies with ^op_[0-9a-f]{32}$ and length 35", () => {
    for (let i = 0; i < 50; i++) {
      const id = newOperationId();
      expect(id).toMatch(/^op_[0-9a-f]{32}$/);
      expect(id).toHaveLength(35);
    }
  });

  test("create nuevo devuelve created con id op_ de 35 caracteres y estado PENDING", async () => {
    const userId = uniqueUserId();
    const idempotencyKey = crypto.randomUUID();
    const requestHash = "1".repeat(64);
    const amount = new Prisma.Decimal("150.00");

    const result = await repo.create({
      userId,
      idempotencyKey,
      requestHash,
      amount,
      currency: "PEN",
      paymentMethod: "CARD",
    });

    expect(result.kind).toBe("created");
    expect(result.operation.id).toMatch(/^op_[0-9a-f]{32}$/);
    expect(result.operation.id).toHaveLength(35);
    expect(result.operation.status).toBe("PENDING");
    expect(result.operation.userId).toBe(userId);
    expect(result.operation.idempotencyKey).toBe(idempotencyKey);
    expect(result.operation.requestHash).toBe(requestHash);
    expect(result.operation.amount).toEqual(amount);
    expect(result.operation.currency).toBe("PEN");
    expect(result.operation.paymentMethod).toBe("CARD");
    expect(result.operation.ledgerEntry).toBeNull();

    // Verify findById and findByKey
    const byId = await repo.findById(result.operation.id);
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe(result.operation.id);

    const byKey = await repo.findByKey(userId, idempotencyKey);
    expect(byKey).not.toBeNull();
    expect(byKey?.id).toBe(result.operation.id);
  });

  test("segundo create con la misma (userId, key) devuelve duplicate con el mismo id", async () => {
    const userId = uniqueUserId();
    const idempotencyKey = crypto.randomUUID();
    const requestHash = "2".repeat(64);

    const first = await repo.create({
      userId,
      idempotencyKey,
      requestHash,
      amount: new Prisma.Decimal("75.00"),
      currency: "PEN",
      paymentMethod: "CARD",
    });
    expect(first.kind).toBe("created");

    const second = await repo.create({
      userId,
      idempotencyKey,
      requestHash,
      amount: new Prisma.Decimal("75.00"),
      currency: "PEN",
      paymentMethod: "CARD",
    });

    expect(second.kind).toBe("duplicate");
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.operation.userId).toBe(userId);
    expect(second.operation.idempotencyKey).toBe(idempotencyKey);
    expect(second.operation.status).toBe(first.operation.status);
  });

  test("misma key con otro userId crea otra operación (alcance por usuario, R2.3)", async () => {
    const idempotencyKey = crypto.randomUUID();
    const user1 = uniqueUserId();
    const user2 = uniqueUserId();

    const res1 = await repo.create({
      userId: user1,
      idempotencyKey,
      requestHash: "3".repeat(64),
      amount: new Prisma.Decimal("100.00"),
      currency: "PEN",
      paymentMethod: "CARD",
    });

    const res2 = await repo.create({
      userId: user2,
      idempotencyKey,
      requestHash: "4".repeat(64),
      amount: new Prisma.Decimal("200.00"),
      currency: "PEN",
      paymentMethod: "CARD",
    });

    expect(res1.kind).toBe("created");
    expect(res2.kind).toBe("created");
    expect(res1.operation.id).not.toBe(res2.operation.id);
    expect(res1.operation.userId).toBe(user1);
    expect(res2.operation.userId).toBe(user2);
    expect(res1.operation.idempotencyKey).toBe(idempotencyKey);
    expect(res2.operation.idempotencyKey).toBe(idempotencyKey);
  });

  test("Promise.all de 10 create con la misma (userId, key) desde 3 clientes Prisma distintos: una sola fila, un created y nueve duplicate, todos con el mismo id", async () => {
    const userId = uniqueUserId();
    const idempotencyKey = crypto.randomUUID();
    const requestHash = "5".repeat(64);
    const repos = concurrentClients.map((c) => createCashInRepository(c));

    const promises = Array.from({ length: 10 }, (_, i) => {
      const clientRepo = repos[i % repos.length]!;
      return clientRepo.create({
        userId,
        idempotencyKey,
        requestHash,
        amount: new Prisma.Decimal("100.00"),
        currency: "PEN",
        paymentMethod: "CARD",
      });
    });

    const results = await Promise.all(promises);

    const created = results.filter((r) => r.kind === "created");
    const duplicates = results.filter((r) => r.kind === "duplicate");

    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(9);

    const expectedId = created[0]!.operation.id;
    expect(expectedId).toMatch(/^op_[0-9a-f]{32}$/);

    for (const res of results) {
      expect(res.operation.id).toBe(expectedId);
      expect(res.operation.userId).toBe(userId);
      expect(res.operation.idempotencyKey).toBe(idempotencyKey);
    }

    // Verify exactly one row in PostgreSQL
    const rows = await prisma.cashInOperation.findMany({
      where: { userId, idempotencyKey },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(expectedId);
  });

  test("transition PENDING→PROCESSING devuelve true. Repetirla devuelve false", async () => {
    const userId = uniqueUserId();
    const created = await repo.create({
      userId,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "6".repeat(64),
      amount: new Prisma.Decimal("50.00"),
      currency: "PEN",
      paymentMethod: "CARD",
    });

    const opId = created.operation.id;

    // First transition: PENDING -> PROCESSING
    const firstTransition = await repo.transition(opId, "PROCESSING");
    expect(firstTransition).toBe(true);

    const opAfterFirst = await repo.findById(opId);
    expect(opAfterFirst?.status).toBe("PROCESSING");

    // Second transition to PROCESSING must return false because current status is PROCESSING
    // and allowedSources("PROCESSING") is only ["PENDING"]
    const secondTransition = await repo.transition(opId, "PROCESSING");
    expect(secondTransition).toBe(false);

    const opAfterSecond = await repo.findById(opId);
    expect(opAfterSecond?.status).toBe("PROCESSING");
  });

  test("transition desde un estado terminal devuelve false y no cambia la fila", async () => {
    // 1. From terminal FAILED
    const userIdFailed = uniqueUserId();
    const failedOp = await createOperation(prisma, {
      userId: userIdFailed,
      status: "FAILED",
      failureCode: "PAYMENT_DECLINED",
      lastError: "Card expired",
    });

    expect(await repo.transition(failedOp.id, "PROCESSING")).toBe(false);
    expect(await repo.transition(failedOp.id, "UNKNOWN")).toBe(false);
    expect(
      await repo.transition(failedOp.id, "FAILED", {
        failureCode: "NEW_CODE",
        lastError: "New error",
      })
    ).toBe(false);

    const afterFailed = await repo.findById(failedOp.id);
    expect(afterFailed?.status).toBe("FAILED");
    expect(afterFailed?.failureCode).toBe("PAYMENT_DECLINED");
    expect(afterFailed?.lastError).toBe("Card expired");

    // 2. From terminal COMPLETED
    const userIdCompleted = uniqueUserId();
    const completedOp = await createOperation(prisma, {
      userId: userIdCompleted,
      status: "COMPLETED",
    });

    expect(await repo.transition(completedOp.id, "PROCESSING")).toBe(false);
    expect(await repo.transition(completedOp.id, "UNKNOWN")).toBe(false);
    expect(await repo.transition(completedOp.id, "FAILED")).toBe(false);

    const afterCompleted = await repo.findById(completedOp.id);
    expect(afterCompleted?.status).toBe("COMPLETED");
  });

  test("10 transition concurrentes PROCESSING→UNKNOWN desde 3 clientes: exactamente una devuelve true", async () => {
    const userId = uniqueUserId();
    const op = await createOperation(prisma, { userId, status: "PROCESSING" });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createCashInRepository(concurrentClients[i % concurrentClients.length]!).transition(
          op.id,
          "UNKNOWN"
        )
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.findById(op.id))?.status).toBe("UNKNOWN");
  });

  // PROCESSING→FAILED and PROCESSING→UNKNOWN racing are not mutually exclusive:
  // UNKNOWN→FAILED is valid, so both can win in that order. What CAS guarantees
  // is that FAILED is terminal whichever order they land in.
  test("tras FAILED, UNKNOWN devuelve false; tras UNKNOWN, FAILED sigue siendo posible", async () => {
    const failedFirst = await createOperation(prisma, { userId: uniqueUserId(), status: "PROCESSING" });
    expect(await repo.transition(failedFirst.id, "FAILED")).toBe(true);
    expect(await repo.transition(failedFirst.id, "UNKNOWN")).toBe(false);
    expect((await repo.findById(failedFirst.id))?.status).toBe("FAILED");

    const unknownFirst = await createOperation(prisma, { userId: uniqueUserId(), status: "PROCESSING" });
    expect(await repo.transition(unknownFirst.id, "UNKNOWN")).toBe(true);
    expect(await repo.transition(unknownFirst.id, "FAILED")).toBe(true);
    expect((await repo.findById(unknownFirst.id))?.status).toBe("FAILED");
  });

  test("transition usado con un cliente de transacción se revierte si la transacción falla", async () => {
    const userId = uniqueUserId();
    const op = await createOperation(prisma, {
      userId,
      status: "PENDING",
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const txRepo = createCashInRepository(tx);
        const ok = await txRepo.transition(op.id, "PROCESSING");
        expect(ok).toBe(true);

        const insideTx = await txRepo.findById(op.id);
        expect(insideTx?.status).toBe("PROCESSING");

        throw new Error("Simulated error to trigger rollback");
      })
    ).rejects.toThrow("Simulated error to trigger rollback");

    // Outside the rolled-back transaction, status must still be PENDING
    const afterRollback = await repo.findById(op.id);
    expect(afterRollback?.status).toBe("PENDING");
  });

  test("findById y findByKey incluyen ledgerEntry.balanceAfter cuando existe", async () => {
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "300.00" });
    const op = await createOperation(prisma, {
      userId,
      status: "COMPLETED",
    });

    await prisma.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        operationId: op.id,
        type: "CREDIT",
        amount: new Prisma.Decimal("100.00"),
        balanceAfter: new Prisma.Decimal("300.00"),
      },
    });

    const byKey = await repo.findByKey(userId, op.idempotencyKey);
    expect(byKey).not.toBeNull();
    expect(byKey?.ledgerEntry).not.toBeNull();
    expect(byKey?.ledgerEntry?.balanceAfter).toEqual(new Prisma.Decimal("300.00"));

    const byId = await repo.findById(op.id);
    expect(byId).not.toBeNull();
    expect(byId?.ledgerEntry).not.toBeNull();
    expect(byId?.ledgerEntry?.balanceAfter).toEqual(new Prisma.Decimal("300.00"));
  });

  test("transition no acepta COMPLETED en sus tipos", () => {
    // @ts-expect-error "COMPLETED" is not assignable to TransitionStatus ("PROCESSING" | "UNKNOWN" | "FAILED")
    const disallowedCall = () => repo.transition("op_test", "COMPLETED");
    expect(disallowedCall).toBeDefined();
  });
});
