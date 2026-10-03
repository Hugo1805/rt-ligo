import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Prisma } from "../../generated/prisma/client";
import { loadConfig } from "../../infra/config";
import { createPrismaClient, type PrismaClient } from "../../infra/prisma";
import { createOperation, createWallet, uniqueUserId } from "../../../tests/helpers/factories";
import { createWalletService, type WalletService } from "./wallet.service";

// providerChargeId is @unique and test data persists, so every charge id is fresh.
const chargeId = (label: string) => `ch_${label}_${crypto.randomUUID().replaceAll("-", "")}`;

describe("WalletService.applyCredit (integration)", () => {
  let prisma: PrismaClient;
  let wallets: WalletService;
  // Separate clients simulate separate pods, each with its own connection pool.
  let pods: PrismaClient[] = [];

  beforeAll(() => {
    const { DATABASE_URL } = loadConfig();
    prisma = createPrismaClient(DATABASE_URL);
    wallets = createWalletService({ prisma });
    pods = [1, 2, 3].map(() => createPrismaClient(DATABASE_URL));
  });

  afterAll(async () => {
    await Promise.allSettled([prisma, ...pods].map((client) => client.$disconnect()));
  });

  async function walletWithOperation(status: "PROCESSING" | "UNKNOWN" | "FAILED" | "PENDING") {
    const userId = uniqueUserId();
    const wallet = await createWallet(prisma, { userId, balance: "250.00" });
    const operation = await createOperation(prisma, { userId, status, amount: "100.00" });
    return { userId, wallet, operation };
  }

  async function balanceOf(userId: string) {
    return (await prisma.wallet.findUniqueOrThrow({ where: { userId } })).balance;
  }

  test("credits a PROCESSING operation once, in one transaction", async () => {
    const { userId, operation } = await walletWithOperation("PROCESSING");

    const providerChargeId = chargeId("ok");
    const result = await wallets.applyCredit({ operationId: operation.id, providerChargeId, actor: "api" });

    expect(result.applied).toBe(true);
    expect(result.from).toBe("PROCESSING");
    expect(result.balanceAfter?.toFixed(2)).toBe("350.00");
    expect((await balanceOf(userId)).toFixed(2)).toBe("350.00");

    const stored = await prisma.cashInOperation.findUniqueOrThrow({
      where: { id: operation.id },
      include: { ledgerEntry: true },
    });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.providerChargeId).toBe(providerChargeId);
    expect(stored.completedAt).toBeInstanceOf(Date);
    expect(stored.ledgerEntry?.type).toBe("CREDIT");
    expect(stored.ledgerEntry?.amount.toFixed(2)).toBe("100.00");
    expect(stored.ledgerEntry?.balanceAfter.toFixed(2)).toBe("350.00");
  });

  test("credits from UNKNOWN too", async () => {
    const { operation } = await walletWithOperation("UNKNOWN");
    const result = await wallets.applyCredit({
      operationId: operation.id,
      providerChargeId: chargeId("unknown"),
      actor: "webhook",
    });
    expect(result).toMatchObject({ applied: true, from: "UNKNOWN" });
  });

  test("a second call is a no-op that reports the original balanceAfter", async () => {
    const { userId, operation } = await walletWithOperation("PROCESSING");
    const input = { operationId: operation.id, providerChargeId: chargeId("twice"), actor: "api" as const };

    const first = await wallets.applyCredit(input);
    const second = await wallets.applyCredit(input);

    expect(second.applied).toBe(false);
    expect(second.from).toBe("COMPLETED");
    expect(second.balanceAfter?.equals(first.balanceAfter!)).toBe(true);
    expect((await balanceOf(userId)).toFixed(2)).toBe("350.00");
    expect(await prisma.ledgerEntry.count({ where: { operationId: operation.id } })).toBe(1);
  });

  test.each(["FAILED", "PENDING"] as const)("does not credit from %s", async (status) => {
    const { userId, operation } = await walletWithOperation(status);

    const result = await wallets.applyCredit({
      operationId: operation.id,
      providerChargeId: chargeId("never"),
      actor: "reconciler",
    });

    expect(result).toEqual({ applied: false, from: status, balanceAfter: null });
    expect((await balanceOf(userId)).toFixed(2)).toBe("250.00");
    expect(await prisma.ledgerEntry.count({ where: { operationId: operation.id } })).toBe(0);
  });

  test("10 concurrent calls on the same operation from 3 pods credit exactly once", async () => {
    const { userId, operation } = await walletWithOperation("PROCESSING");
    const providerChargeId = chargeId("race");

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createWalletService({ prisma: pods[i % pods.length]! }).applyCredit({
          operationId: operation.id,
          providerChargeId,
          actor: i % 2 === 0 ? "api" : "webhook",
        })
      )
    );

    const winners = results.filter((r) => r.applied);
    expect(winners).toHaveLength(1);
    expect((await balanceOf(userId)).toFixed(2)).toBe("350.00");
    expect(await prisma.ledgerEntry.count({ where: { operationId: operation.id } })).toBe(1);
    // Losers waited for the winner's commit, so they report the real state, not a stale read.
    for (const loser of results.filter((r) => !r.applied)) {
      expect(loser.from).toBe("COMPLETED");
      expect(loser.balanceAfter?.toFixed(2)).toBe("350.00");
    }
  });

  test("50 concurrent credits to the same wallet add up to the exact Decimal sum", async () => {
    const userId = uniqueUserId();
    await createWallet(prisma, { userId, balance: "0.00" });
    const amounts = Array.from({ length: 50 }, (_, i) => ["10.01", "0.10", "99.99"][i % 3]!);
    const operations = await Promise.all(
      amounts.map((amount) => createOperation(prisma, { userId, status: "PROCESSING", amount }))
    );

    const results = await Promise.all(
      operations.map((operation, i) =>
        createWalletService({ prisma: pods[i % pods.length]! }).applyCredit({
          operationId: operation.id,
          providerChargeId: chargeId(`sum${i}`),
          actor: "api",
        })
      )
    );

    const expected = amounts.reduce((sum, a) => sum.plus(a), new Prisma.Decimal(0));
    const finalBalance = await balanceOf(userId);
    expect(finalBalance.equals(expected)).toBe(true);
    expect(results.every((r) => r.applied)).toBe(true);

    const entries = await prisma.ledgerEntry.findMany({
      where: { wallet: { userId } },
      select: { balanceAfter: true },
    });
    expect(entries).toHaveLength(50);
    const afters = entries.map((e) => e.balanceAfter.toFixed(2));
    expect(new Set(afters).size).toBe(50);
    const max = entries.reduce((m, e) => (e.balanceAfter.greaterThan(m) ? e.balanceAfter : m), new Prisma.Decimal(0));
    expect(max.equals(finalBalance)).toBe(true);
  });

  test("with an external tx that throws afterwards, nothing is persisted", async () => {
    const { userId, operation } = await walletWithOperation("PROCESSING");

    await expect(
      prisma.$transaction(async (tx) => {
        const result = await wallets.applyCredit(
          { operationId: operation.id, providerChargeId: chargeId("rollback"), actor: "webhook" },
          tx
        );
        expect(result.applied).toBe(true);
        throw new Error("rollback after credit");
      })
    ).rejects.toThrow("rollback after credit");

    expect((await prisma.cashInOperation.findUniqueOrThrow({ where: { id: operation.id } })).status).toBe(
      "PROCESSING"
    );
    expect((await balanceOf(userId)).toFixed(2)).toBe("250.00");
    expect(await prisma.ledgerEntry.count({ where: { operationId: operation.id } })).toBe(0);
  });

  test("getWallet returns the wallet or null", async () => {
    const { userId } = await walletWithOperation("PENDING");
    expect((await wallets.getWallet(userId))?.balance.toFixed(2)).toBe("250.00");
    expect(await wallets.getWallet(uniqueUserId())).toBeNull();
  });
});
