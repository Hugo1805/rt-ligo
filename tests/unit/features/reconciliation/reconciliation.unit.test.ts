import { describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import type { OperationStatus } from "../../../../src/generated/prisma/enums";
import { createLogger } from "../../../../src/infra/logger";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderUnexpectedError,
} from "../../../../src/infra/payment-provider/errors";
import type {
  ChargeInput,
  ChargeResult,
  GetChargeResult,
  PaymentProvider,
} from "../../../../src/infra/payment-provider/payment-provider";
import type { PrismaClient } from "../../../../src/infra/prisma";
import type { ApplyCreditInput, ApplyCreditResult } from "../../../../src/features/wallet/wallet.service";
import type {
  ClaimLeaseInput,
  ReconcileOperation,
  ReconciliationRepository,
} from "../../../../src/features/reconciliation/reconciliation.repository";
import { createReconciler, LEASE_DURATION_MS, type ReconcilerConfig } from "../../../../src/features/reconciliation/reconciliation.service";

const CONFIG: ReconcilerConfig = {
  RECONCILE_INTERVAL_MS: 5,
  RECONCILE_STALE_MS: 30_000,
  RECONCILE_MAX_ATTEMPTS: 3,
};
const NOW = new Date("2026-01-01T00:00:00.000Z");
const POD = "pod-a";

interface Row extends ReconcileOperation {
  leaseOwner: string | null;
  lastError: string | null;
  failureCode: string | null;
}

/** Repository double that mimics the conditional writes of the real one. */
class FakeRepo implements ReconciliationRepository {
  rows = new Map<string, Row>();
  calls: string[] = [];
  claims: ClaimLeaseInput[] = [];
  claimResult: number | null = null;
  markProcessingResult: number | null = null;
  lastFindCandidates: { staleBefore: Date; maxAttempts: number; limit: number } | null = null;

  add(op: Partial<Row> & { id: string; status: OperationStatus }): Row {
    const row: Row = {
      amount: new Prisma.Decimal("100.5"),
      currency: "PEN",
      paymentMethod: "card_ok",
      reconcileAttempts: 0,
      leaseOwner: null,
      lastError: null,
      failureCode: null,
      ...op,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findCandidates(input: { staleBefore: Date; maxAttempts: number; limit: number }) {
    this.calls.push("findCandidates");
    this.lastFindCandidates = input;
    return [...this.rows.values()]
      .filter(
        (r) =>
          ["PENDING", "PROCESSING", "UNKNOWN"].includes(r.status) &&
          r.reconcileAttempts < input.maxAttempts
      )
      .map((r) => ({ id: r.id }));
  }

  async claimLease(input: ClaimLeaseInput) {
    this.calls.push("claimLease");
    this.claims.push(input);
    if (this.claimResult !== null) return this.claimResult;
    const row = this.rows.get(input.id)!;
    if (row.reconcileAttempts >= input.maxAttempts) return 0;
    row.leaseOwner = input.podId;
    row.reconcileAttempts += 1;
    return 1;
  }

  async releaseLease(input: { id: string; podId: string; lastError?: string | null }) {
    this.calls.push("releaseLease");
    const row = this.rows.get(input.id)!;
    if (row.leaseOwner !== input.podId) return 0;
    row.leaseOwner = null;
    if (input.lastError !== undefined) row.lastError = input.lastError;
    return 1;
  }

  async findById(id: string) {
    this.calls.push("findById");
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  private cas(id: string, from: OperationStatus[], to: OperationStatus): number {
    const row = this.rows.get(id)!;
    if (!from.includes(row.status)) return 0;
    row.status = to;
    return 1;
  }

  async markProcessing({ id }: { id: string }) {
    this.calls.push("markProcessing");
    if (this.markProcessingResult !== null) return this.markProcessingResult;
    return this.cas(id, ["PENDING"], "PROCESSING");
  }

  async markFailed({ id, failureCode }: { id: string; failureCode: string }) {
    this.calls.push("markFailed");
    const count = this.cas(id, ["PENDING", "PROCESSING", "UNKNOWN"], "FAILED");
    if (count === 1) this.rows.get(id)!.failureCode = failureCode;
    return count;
  }

  async markUnknown({ id }: { id: string }) {
    this.calls.push("markUnknown");
    return this.cas(id, ["PROCESSING"], "UNKNOWN");
  }
}

class StubProvider implements PaymentProvider {
  chargeCalls: ChargeInput[] = [];
  getChargeCalls: string[] = [];
  constructor(
    private readonly getChargeImpl: (ref: string) => Promise<GetChargeResult>,
    private readonly chargeImpl: (input: ChargeInput) => Promise<ChargeResult> = async () => ({
      status: "succeeded",
      chargeId: "ch_new",
    })
  ) {}
  charge(input: ChargeInput) {
    this.chargeCalls.push(input);
    return this.chargeImpl(input);
  }
  getCharge(reference: string) {
    this.getChargeCalls.push(reference);
    return this.getChargeImpl(reference);
  }
}

function setup(provider: StubProvider, repo = new FakeRepo()) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: "debug" },
    { write: (msg: string) => void lines.push(JSON.parse(msg)) }
  );
  const credits: { input: ApplyCreditInput; txArgs: number }[] = [];
  const balances = new Map<string, Prisma.Decimal>();
  const applyCredit = async (
    input: ApplyCreditInput,
    ...rest: unknown[]
  ): Promise<ApplyCreditResult> => {
    credits.push({ input, txArgs: rest.length });
    const row = repo.rows.get(input.operationId)!;
    const from = row.status;
    if (from !== "PROCESSING" && from !== "UNKNOWN") {
      return { applied: false, from, balanceAfter: null };
    }
    row.status = "COMPLETED";
    const balance = (balances.get("w") ?? new Prisma.Decimal(0)).plus(row.amount);
    balances.set("w", balance);
    return { applied: true, from, balanceAfter: balance };
  };
  const reconciler = createReconciler({
    prisma: {} as PrismaClient,
    paymentProvider: provider,
    applyCredit,
    logger,
    config: CONFIG,
    podId: POD,
    now: () => NOW,
    repository: repo,
  });
  return { reconciler, repo, lines, credits, balances };
}

const notFound = async (): Promise<GetChargeResult> => ({ status: "not_found" });

describe("reconciler: runOnce", () => {
  test("uses the injected clock for the stale threshold and the lease", async () => {
    const { reconciler, repo } = setup(new StubProvider(notFound));
    repo.add({ id: "op_clock", status: "UNKNOWN" });

    await reconciler.runOnce();

    expect(repo.lastFindCandidates).toEqual({
      staleBefore: new Date(NOW.getTime() - CONFIG.RECONCILE_STALE_MS),
      maxAttempts: CONFIG.RECONCILE_MAX_ATTEMPTS,
      limit: expect.any(Number),
    });
    expect(repo.claims[0]).toEqual({
      id: "op_clock",
      podId: POD,
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + LEASE_DURATION_MS),
      maxAttempts: CONFIG.RECONCILE_MAX_ATTEMPTS,
    });
  });

  test("succeeded credits with applyCredit (no tx, actor reconciler) and completes", async () => {
    const provider = new StubProvider(async () => ({ status: "succeeded", chargeId: "ch_1" }));
    const { reconciler, repo, credits, lines } = setup(provider);
    repo.add({ id: "op_ok", status: "UNKNOWN" });

    await reconciler.runOnce();

    expect(provider.getChargeCalls).toEqual(["op_ok"]);
    expect(provider.chargeCalls).toHaveLength(0);
    expect(credits).toEqual([
      {
        input: { operationId: "op_ok", providerChargeId: "ch_1", actor: "reconciler" },
        txArgs: 0,
      },
    ]);
    expect(repo.rows.get("op_ok")!.status).toBe("COMPLETED");
    expect(lines).toContainEqual(
      expect.objectContaining({
        component: "reconciler",
        event: "operation.transition",
        operation_id: "op_ok",
        from: "UNKNOWN",
        to: "COMPLETED",
        actor: "reconciler",
      })
    );
  });

  test("declined marks FAILED with failureCode and does not credit", async () => {
    const provider = new StubProvider(async () => ({
      status: "declined",
      chargeId: "ch_2",
      failureCode: "insufficient_funds",
    }));
    const { reconciler, repo, credits, balances, lines } = setup(provider);
    repo.add({ id: "op_dec", status: "PROCESSING" });

    await reconciler.runOnce();

    const row = repo.rows.get("op_dec")!;
    expect(row.status).toBe("FAILED");
    expect(row.failureCode).toBe("insufficient_funds");
    expect(credits).toHaveLength(0);
    expect(balances.size).toBe(0);
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: "operation.transition",
        operation_id: "op_dec",
        from: "PROCESSING",
        to: "FAILED",
        actor: "reconciler",
      })
    );
  });

  test("not_found re-sends charge with reference equal to the operation id", async () => {
    const provider = new StubProvider(notFound);
    const { reconciler, repo, credits } = setup(provider);
    repo.add({ id: "op_nf", status: "PROCESSING" });

    await reconciler.runOnce();

    expect(provider.chargeCalls).toHaveLength(1);
    const call = provider.chargeCalls[0]!;
    expect(call.reference).toBe("op_nf");
    expect(call.amount).toBe("100.50");
    expect(call.currency).toBe("PEN");
    expect(call.paymentMethod).toBe("card_ok");
    expect(call.requestId).toMatch(/^reconcile-[0-9a-f-]{36}$/);
    expect(call.requestId).not.toBe(call.reference);
    expect(credits[0]!.input.providerChargeId).toBe("ch_new");
    expect(repo.rows.get("op_nf")!.status).toBe("COMPLETED");
  });

  test("not_found then declined charge marks FAILED", async () => {
    const provider = new StubProvider(notFound, async () => ({
      status: "declined",
      chargeId: "ch_d",
      failureCode: "card_blocked",
    }));
    const { reconciler, repo, credits } = setup(provider);
    repo.add({ id: "op_nfd", status: "UNKNOWN" });

    await reconciler.runOnce();

    expect(provider.chargeCalls[0]!.reference).toBe("op_nfd");
    expect(repo.rows.get("op_nfd")!.status).toBe("FAILED");
    expect(credits).toHaveLength(0);
  });

  test("stale PENDING goes to PROCESSING by CAS and charges with the same reference, without getCharge", async () => {
    const provider = new StubProvider(notFound);
    const { reconciler, repo, lines } = setup(provider);
    repo.add({ id: "op_pend", status: "PENDING" });

    await reconciler.runOnce();

    expect(provider.getChargeCalls).toHaveLength(0);
    expect(provider.chargeCalls.map((c) => c.reference)).toEqual(["op_pend"]);
    const order = repo.calls.filter((c) => c === "markProcessing" || c === "claimLease");
    expect(order).toEqual(["claimLease", "markProcessing"]);
    expect(repo.rows.get("op_pend")!.status).toBe("COMPLETED");
    const transitions = lines
      .filter((l) => l.event === "operation.transition")
      .map((l) => `${l.from}->${l.to}`);
    expect(transitions).toEqual(["PENDING->PROCESSING", "PROCESSING->COMPLETED"]);
  });

  test("markProcessing with count 0 releases the lease and never calls the provider", async () => {
    const provider = new StubProvider(notFound);
    const repo = new FakeRepo();
    repo.markProcessingResult = 0;
    const { reconciler } = setup(provider, repo);
    repo.add({ id: "op_moved", status: "PENDING" });

    await reconciler.runOnce();

    expect(provider.chargeCalls).toHaveLength(0);
    expect(provider.getChargeCalls).toHaveLength(0);
    expect(repo.calls).toContain("releaseLease");
    expect(repo.rows.get("op_moved")!.leaseOwner).toBeNull();
  });

  test("claimLease with count 0 skips the operation without calling the provider", async () => {
    const provider = new StubProvider(notFound);
    const repo = new FakeRepo();
    repo.claimResult = 0;
    const { reconciler, credits } = setup(provider, repo);
    repo.add({ id: "op_taken", status: "UNKNOWN" });
    repo.add({ id: "op_taken_p", status: "PENDING" });

    await reconciler.runOnce();

    expect(provider.getChargeCalls).toHaveLength(0);
    expect(provider.chargeCalls).toHaveLength(0);
    expect(credits).toHaveLength(0);
    expect(repo.calls).not.toContain("findById");
    expect(repo.calls).not.toContain("markProcessing");
  });

  for (const ErrorClass of [ProviderTimeoutError, ProviderUnavailableError, ProviderUnexpectedError]) {
    test(`${ErrorClass.name} releases the lease, stores lastError and logs warn`, async () => {
      const provider = new StubProvider(async () => {
        throw new ErrorClass("boom");
      });
      const { reconciler, repo, lines, credits } = setup(provider);
      repo.add({ id: "op_err", status: "UNKNOWN" });

      await reconciler.runOnce();

      const row = repo.rows.get("op_err")!;
      expect(row.leaseOwner).toBeNull();
      expect(row.lastError).toContain("boom");
      expect(row.lastError).toContain(ErrorClass.name);
      expect(row.status).toBe("UNKNOWN");
      expect(provider.chargeCalls).toHaveLength(0);
      expect(credits).toHaveLength(0);
      expect(lines).toContainEqual(
        expect.objectContaining({ level: 40, operation_id: "op_err" })
      );
      expect(lines.some((l) => l.event === "reconcile.exhausted")).toBe(false);
    });
  }

  test("a timeout is never treated as not_found", async () => {
    const provider = new StubProvider(async () => {
      throw new ProviderTimeoutError();
    });
    const { reconciler, repo } = setup(provider);
    repo.add({ id: "op_to", status: "PROCESSING" });

    await reconciler.runOnce();

    expect(provider.chargeCalls).toHaveLength(0);
    expect(repo.rows.get("op_to")!.status).toBe("PROCESSING");
  });

  test("final attempt on PROCESSING marks UNKNOWN, logs reconcile.exhausted and is not taken again", async () => {
    const provider = new StubProvider(async () => {
      throw new ProviderUnavailableError();
    });
    const { reconciler, repo, lines } = setup(provider);
    repo.add({
      id: "op_exh",
      status: "PROCESSING",
      reconcileAttempts: CONFIG.RECONCILE_MAX_ATTEMPTS - 1,
    });

    await reconciler.runOnce();

    const row = repo.rows.get("op_exh")!;
    expect(row.status).toBe("UNKNOWN");
    expect(row.reconcileAttempts).toBe(CONFIG.RECONCILE_MAX_ATTEMPTS);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 50,
        event: "reconcile.exhausted",
        operation_id: "op_exh",
        attempts: CONFIG.RECONCILE_MAX_ATTEMPTS,
      })
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "operation.transition", from: "PROCESSING", to: "UNKNOWN" })
    );

    const before = provider.getChargeCalls.length;
    await reconciler.runOnce();
    expect(provider.getChargeCalls.length).toBe(before);
    expect(repo.claims).toHaveLength(1);
  });

  test("final attempt on a PENDING that moved to PROCESSING this cycle ends UNKNOWN", async () => {
    const provider = new StubProvider(notFound, async () => {
      throw new ProviderTimeoutError();
    });
    const { reconciler, repo, lines } = setup(provider);
    repo.add({
      id: "op_exh_p",
      status: "PENDING",
      reconcileAttempts: CONFIG.RECONCILE_MAX_ATTEMPTS - 1,
    });

    await reconciler.runOnce();

    expect(repo.rows.get("op_exh_p")!.status).toBe("UNKNOWN");
    expect(provider.chargeCalls.map((c) => c.reference)).toEqual(["op_exh_p"]);
    expect(lines.some((l) => l.event === "reconcile.exhausted")).toBe(true);
  });

  test("final attempt on UNKNOWN stays UNKNOWN without an invalid transition", async () => {
    const provider = new StubProvider(async () => {
      throw new ProviderTimeoutError();
    });
    const { reconciler, repo, lines } = setup(provider);
    repo.add({
      id: "op_exh_u",
      status: "UNKNOWN",
      reconcileAttempts: CONFIG.RECONCILE_MAX_ATTEMPTS - 1,
    });

    await reconciler.runOnce();

    expect(repo.rows.get("op_exh_u")!.status).toBe("UNKNOWN");
    expect(repo.calls).not.toContain("markUnknown");
    expect(lines.some((l) => l.event === "reconcile.exhausted")).toBe(true);
  });

  test("an error in one operation does not stop the cycle", async () => {
    const provider = new StubProvider(async (ref) => {
      if (ref === "op_bad") throw new ProviderUnexpectedError();
      return { status: "succeeded", chargeId: `ch_${ref}` };
    });
    const repo = new FakeRepo();
    const { reconciler } = setup(provider, repo);
    repo.add({ id: "op_bad", status: "UNKNOWN" });
    repo.add({ id: "op_good", status: "UNKNOWN" });

    await reconciler.runOnce();

    expect(repo.rows.get("op_good")!.status).toBe("COMPLETED");
  });

  test("a repository failure in one operation does not stop the cycle", async () => {
    const provider = new StubProvider(async (ref) => ({ status: "succeeded", chargeId: `ch_${ref}` }));
    const repo = new FakeRepo();
    const originalFind = repo.findById.bind(repo);
    repo.findById = async (id: string) => {
      if (id === "op_db") throw new Error("db down");
      return originalFind(id);
    };
    const { reconciler, lines } = setup(provider, repo);
    repo.add({ id: "op_db", status: "UNKNOWN" });
    repo.add({ id: "op_fine", status: "UNKNOWN" });

    await reconciler.runOnce();

    expect(repo.rows.get("op_fine")!.status).toBe("COMPLETED");
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, operation_id: "op_db" }));
  });
});

describe("reconciler: start/stop", () => {
  test("stop() resolves only after the cycle in progress finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const provider = new StubProvider(async () => {
      await gate;
      finished = true;
      return { status: "succeeded", chargeId: "ch_slow" };
    });
    const { reconciler, repo } = setup(provider);
    repo.add({ id: "op_slow", status: "UNKNOWN" });

    reconciler.start();
    while (provider.getChargeCalls.length === 0) {
      await Bun.sleep(1);
    }

    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(20);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    expect(repo.rows.get("op_slow")!.status).toBe("COMPLETED");

    // No further cycle after stop, and stop is idempotent.
    const calls = repo.calls.filter((c) => c === "findCandidates").length;
    await Bun.sleep(CONFIG.RECONCILE_INTERVAL_MS * 4);
    expect(repo.calls.filter((c) => c === "findCandidates").length).toBe(calls);
    await reconciler.stop();
  });

  test("cycles never overlap: the next one starts after the previous finishes", async () => {
    let active = 0;
    let maxActive = 0;
    const repo = new FakeRepo();
    const provider = new StubProvider(notFound);
    const { reconciler } = setup(provider, repo);
    repo.findCandidates = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(CONFIG.RECONCILE_INTERVAL_MS * 3);
      active -= 1;
      repo.calls.push("findCandidates");
      return [];
    };

    reconciler.start();
    reconciler.start(); // second start is a no-op
    await Bun.sleep(CONFIG.RECONCILE_INTERVAL_MS * 15);
    await reconciler.stop();

    expect(repo.calls.filter((c) => c === "findCandidates").length).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
  });

  test("stop() before start resolves and prevents starting", async () => {
    const repo = new FakeRepo();
    const { reconciler } = setup(new StubProvider(notFound), repo);
    await reconciler.stop();
    reconciler.start();
    await Bun.sleep(CONFIG.RECONCILE_INTERVAL_MS * 4);
    expect(repo.calls).toHaveLength(0);
  });
});
