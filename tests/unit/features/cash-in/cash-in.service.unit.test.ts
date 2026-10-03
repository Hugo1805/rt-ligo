import { describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import type { Lock, LockResult } from "../../../../src/infra/lock";
import { createLogger } from "../../../../src/infra/logger";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderUnexpectedError,
} from "../../../../src/infra/payment-provider/errors";
import type { ChargeInput, ChargeResult, PaymentProvider } from "../../../../src/infra/payment-provider/payment-provider";
import { AppError } from "../../../../src/shared/errors";
import { allowedSources } from "../../../../src/shared/operation-state-machine";
import type { ApplyCreditResult, WalletService } from "../../../../src/features/wallet/wallet.service";
import type { CashInOperationRecord, CashInRepository } from "../../../../src/features/cash-in/cash-in.repository";
import { computeRequestHash } from "../../../../src/features/cash-in/cash-in.request-hash";
import type { CashInRequest } from "../../../../src/features/cash-in/cash-in.schemas";
import { createCashInService } from "../../../../src/features/cash-in/cash-in.service";

// In-memory doubles live only inside this test. The service itself keeps no state.

const BODY: CashInRequest = { user_id: "usr_abc123", amount: 100, currency: "PEN", payment_method: "card_ok" };
const KEY = "0f3c7a9e-2b1d-4c5e-8f6a-1b2c3d4e5f60";
const REQUEST_ID = "req-test-1";

function makeOperation(overrides: Partial<CashInOperationRecord> = {}): CashInOperationRecord {
  const now = new Date();
  return {
    id: "op_existing",
    userId: BODY.user_id,
    idempotencyKey: KEY,
    requestHash: computeRequestHash(BODY),
    amount: new Prisma.Decimal("100.00"),
    currency: "PEN",
    paymentMethod: BODY.payment_method,
    status: "PENDING",
    providerChargeId: null,
    failureCode: null,
    lastError: null,
    reconcileAttempts: 0,
    leaseOwner: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ledgerEntry: null,
    ...overrides,
  };
}

function fakeRepository(seed: CashInOperationRecord[] = []) {
  const rows = new Map(seed.map((op) => [op.id, op]));
  let nextId = 1;
  const calls = { create: 0, transitions: [] as { id: string; to: string; data: unknown }[] };
  const options = { createReturnsDuplicateOf: null as CashInOperationRecord | null, loseCasTo: null as string | null };

  const repository: CashInRepository = {
    async create(input) {
      calls.create++;
      if (options.createReturnsDuplicateOf) {
        return { kind: "duplicate", operation: options.createReturnsDuplicateOf };
      }
      const operation = makeOperation({ ...input, id: `op_new_${nextId++}`, status: "PENDING" });
      rows.set(operation.id, operation);
      return { kind: "created", operation };
    },
    async findByKey(userId, idempotencyKey) {
      return [...rows.values()].find((op) => op.userId === userId && op.idempotencyKey === idempotencyKey) ?? null;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async transition(id, to, data) {
      calls.transitions.push({ id, to, data });
      const op = rows.get(id);
      if (!op || options.loseCasTo === to || !allowedSources(to).includes(op.status)) {
        return false;
      }
      rows.set(id, { ...op, status: to, ...data });
      return true;
    },
  };
  return { repository, rows, calls, options };
}

function fakeWallet(
  rows: Map<string, CashInOperationRecord>,
  wallet: { currency: string } | null = { currency: "PEN" }
) {
  const calls = { getWallet: 0, applyCredit: [] as unknown[] };
  let override: ((operationId: string) => ApplyCreditResult) | null = null;

  const walletService: Pick<WalletService, "getWallet" | "applyCredit"> = {
    async getWallet(userId) {
      calls.getWallet++;
      return wallet && { id: "wal_1", userId, currency: wallet.currency, balance: new Prisma.Decimal("250.00") };
    },
    async applyCredit(input) {
      calls.applyCredit.push(input);
      if (override) return override(input.operationId);
      const op = rows.get(input.operationId)!;
      const balanceAfter = new Prisma.Decimal("350.00");
      rows.set(op.id, { ...op, status: "COMPLETED", ledgerEntry: { balanceAfter } });
      return { applied: true, from: op.status, balanceAfter };
    },
  };
  return { walletService, calls, setApplyCredit: (fn: typeof override) => (override = fn) };
}

function fakeLock(status: LockResult["status"]) {
  const calls = { acquire: [] as string[], release: 0 };
  const lock: Lock = {
    async acquire(key) {
      calls.acquire.push(key);
      if (status === "acquired") {
        return { status, release: async () => void calls.release++ };
      }
      return { status };
    },
  };
  return { lock, calls };
}

/** Each entry answers one charge call: a result, or an error to throw. */
function scriptedProvider(script: (ChargeResult | Error)[]) {
  const calls: ChargeInput[] = [];
  const paymentProvider: PaymentProvider = {
    async charge(input) {
      calls.push(input);
      const next = script[Math.min(calls.length - 1, script.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    async getCharge() {
      throw new Error("not used by the API flow");
    },
  };
  return { paymentProvider, calls };
}

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ level: "debug", podId: "test" }, { write: (msg: string) => void lines.push(JSON.parse(msg)) });
  return { logger, lines };
}

function setup(
  opts: {
    seed?: CashInOperationRecord[];
    lock?: LockResult["status"];
    wallet?: { currency: string } | null;
    script?: (ChargeResult | Error)[];
  } = {}
) {
  const repo = fakeRepository(opts.seed);
  const wallet = fakeWallet(repo.rows, opts.wallet === undefined ? { currency: "PEN" } : opts.wallet);
  const lock = fakeLock(opts.lock ?? "acquired");
  const provider = scriptedProvider(opts.script ?? [{ status: "succeeded", chargeId: "ch_1" }]);
  const log = captureLogger();
  const service = createCashInService({
    repository: repo.repository,
    walletService: wallet.walletService,
    lock: lock.lock,
    paymentProvider: provider.paymentProvider,
    config: { LOCK_TTL_MS: 15000, PROVIDER_MAX_RETRIES: 2 },
    sleep: async () => {},
  });
  const run = (body: CashInRequest = BODY) =>
    service.cashIn({ idempotencyKey: KEY, body }, { requestId: REQUEST_ID, logger: log.logger });
  return { repo, wallet, lock, provider, log, run };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code as AppError["code"]);
  return error as AppError;
}

describe("cash-in service", () => {
  test("new key with card_ok charges once with reference = operation id and completes", async () => {
    const t = setup();
    const result = await t.run();

    expect(result.replayed).toBe(false);
    expect(result.operation.status).toBe("COMPLETED");
    expect(result.operation.balanceAfter?.toFixed(2)).toBe("350.00");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.provider.calls[0]).toEqual({
      reference: result.operation.id,
      amount: "100.00",
      currency: "PEN",
      paymentMethod: "card_ok",
      requestId: REQUEST_ID,
    });
    expect(t.wallet.calls.applyCredit).toHaveLength(1);
    expect(t.lock.calls.acquire).toEqual([`lock:cashin:${BODY.user_id}:${KEY}`]);
  });

  test("existing key with the same hash is a replay without create or charge", async () => {
    const t = setup({ seed: [makeOperation({ status: "COMPLETED", ledgerEntry: { balanceAfter: new Prisma.Decimal("350.00") } })] });
    const result = await t.run();

    expect(result.replayed).toBe(true);
    expect(result.operation).toMatchObject({ id: "op_existing", status: "COMPLETED" });
    expect(result.operation.balanceAfter?.toFixed(2)).toBe("350.00");
    expect(t.repo.calls.create).toBe(0);
    expect(t.provider.calls).toHaveLength(0);
  });

  test("existing key with a different hash throws IDEMPOTENCY_KEY_REUSED with the operation id", async () => {
    const t = setup({ seed: [makeOperation({ status: "COMPLETED" })] });
    const error = await expectAppError(t.run({ ...BODY, amount: 200 }), "IDEMPOTENCY_KEY_REUSED");

    expect(error.operationId).toBe("op_existing");
    expect(t.provider.calls).toHaveLength(0);
  });

  test("busy lock and no operation throws OPERATION_IN_PROGRESS without create", async () => {
    const t = setup({ lock: "busy" });
    await expectAppError(t.run(), "OPERATION_IN_PROGRESS");
    expect(t.repo.calls.create).toBe(0);
  });

  test("busy lock with an existing operation returns it instead of 409", async () => {
    const t = setup({ lock: "busy", seed: [makeOperation({ status: "PROCESSING" })] });
    const result = await t.run();
    expect(result).toMatchObject({ replayed: true, operation: { status: "PROCESSING" } });
  });

  test("unavailable lock (Redis down) proceeds normally and does not release", async () => {
    const t = setup({ lock: "unavailable" });
    const result = await t.run();
    expect(result.operation.status).toBe("COMPLETED");
    expect(t.lock.calls.release).toBe(0);
  });

  test("create returning duplicate replays without charging, and still checks the hash", async () => {
    const t = setup();
    t.repo.options.createReturnsDuplicateOf = makeOperation({ status: "PROCESSING" });
    expect(await t.run()).toMatchObject({ replayed: true, operation: { id: "op_existing" } });
    expect(t.provider.calls).toHaveLength(0);

    t.repo.options.createReturnsDuplicateOf = makeOperation({ requestHash: "f".repeat(64) });
    await expectAppError(t.run(), "IDEMPOTENCY_KEY_REUSED");
  });

  test("missing wallet or currency mismatch fail before create and charge", async () => {
    const noWallet = setup({ wallet: null });
    await expectAppError(noWallet.run(), "WALLET_NOT_FOUND");
    expect(noWallet.repo.calls.create).toBe(0);
    expect(noWallet.provider.calls).toHaveLength(0);

    const usdWallet = setup({ wallet: { currency: "USD" } });
    await expectAppError(usdWallet.run(), "CURRENCY_MISMATCH");
    expect(usdWallet.repo.calls.create).toBe(0);
    expect(usdWallet.provider.calls).toHaveLength(0);
  });

  test("declined goes to FAILED with failureCode, no credit and no retry", async () => {
    const t = setup({ script: [{ status: "declined", chargeId: "ch_d", failureCode: "insufficient_funds" }] });
    const result = await t.run();

    expect(result.operation.status).toBe("FAILED");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.wallet.calls.applyCredit).toHaveLength(0);
    expect(t.repo.calls.transitions.at(-1)).toMatchObject({
      to: "FAILED",
      data: { providerChargeId: "ch_d", failureCode: "insufficient_funds" },
    });
  });

  test("timeout charges once and leaves UNKNOWN with the error name only", async () => {
    const t = setup({ script: [new ProviderTimeoutError("socket hang up at 10.0.0.5")] });
    const result = await t.run();

    expect(result.operation.status).toBe("UNKNOWN");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.repo.calls.transitions.at(-1)).toMatchObject({ to: "UNKNOWN", data: { lastError: "ProviderTimeoutError" } });
  });

  test.each([
    ["ProviderUnexpectedError", new ProviderUnexpectedError()],
    ["any other error", new TypeError("boom")],
  ])("%s charges once and leaves UNKNOWN, never FAILED", async (_label, error) => {
    const t = setup({ script: [error] });
    const result = await t.run();

    expect(result.operation.status).toBe("UNKNOWN");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.repo.calls.transitions.some((c) => c.to === "FAILED")).toBe(false);
  });

  test("unavailable once then success retries with the same reference", async () => {
    const t = setup({ script: [new ProviderUnavailableError(), { status: "succeeded", chargeId: "ch_2" }] });
    const result = await t.run();

    expect(result.operation.status).toBe("COMPLETED");
    expect(t.provider.calls).toHaveLength(2);
    expect(new Set(t.provider.calls.map((c) => c.reference))).toEqual(new Set([result.operation.id]));
  });

  test("unavailable every time makes PROVIDER_MAX_RETRIES + 1 calls with one reference and leaves UNKNOWN", async () => {
    const t = setup({ script: [new ProviderUnavailableError()] });
    const result = await t.run();

    expect(result.operation.status).toBe("UNKNOWN");
    expect(t.provider.calls).toHaveLength(3);
    expect(new Set(t.provider.calls.map((c) => c.reference)).size).toBe(1);
  });

  test("webhook before the response: applyCredit not applied, answer with the recorded COMPLETED", async () => {
    const t = setup();
    t.wallet.setApplyCredit((operationId) => {
      const op = t.repo.rows.get(operationId)!;
      t.repo.rows.set(operationId, { ...op, status: "COMPLETED", ledgerEntry: { balanceAfter: new Prisma.Decimal("350.00") } });
      return { applied: false, from: "COMPLETED", balanceAfter: new Prisma.Decimal("350.00") };
    });

    const result = await t.run();
    expect(result.operation.status).toBe("COMPLETED");
    expect(result.operation.balanceAfter?.toFixed(2)).toBe("350.00");
    expect(t.log.lines.some((l) => l["event"] === "operation.cas_lost" && l["to"] === "COMPLETED")).toBe(true);
  });

  test("a lost CAS to UNKNOWN rereads instead of throwing", async () => {
    const t = setup({ script: [new ProviderTimeoutError()] });
    t.repo.options.loseCasTo = "UNKNOWN";
    const result = await t.run();
    expect(result.operation.status).toBe("PROCESSING");
  });

  test("release runs once even when the flow throws", async () => {
    const t = setup({ wallet: null });
    await expectAppError(t.run(), "WALLET_NOT_FOUND");
    expect(t.lock.calls.release).toBe(1);
  });

  test("SERVICE_UNAVAILABLE after the charge propagates and never triggers another charge", async () => {
    const t = setup();
    t.wallet.setApplyCredit(() => {
      throw new AppError("SERVICE_UNAVAILABLE");
    });

    await expectAppError(t.run(), "SERVICE_UNAVAILABLE");
    expect(t.provider.calls).toHaveLength(1);
    expect(t.lock.calls.release).toBe(1);
  });

  test("every transition is logged with operation_id, from, to and actor api", async () => {
    const t = setup();
    const result = await t.run();
    const transitions = t.log.lines
      .filter((l) => l["event"] === "operation.transition")
      .map((l) => [l["operation_id"], l["from"], l["to"], l["actor"]]);

    expect(transitions).toEqual([
      [result.operation.id, "PENDING", "PROCESSING", "api"],
      [result.operation.id, "PROCESSING", "COMPLETED", "api"],
    ]);
    // Only the R13.3 fields, never the whole body.
    expect(t.log.lines.every((l) => !("payment_method" in l) && !("body" in l))).toBe(true);
    expect(t.log.lines.every((l) => l["user_id"] === BODY.user_id && l["idempotency_key"] === KEY)).toBe(true);
  });
});
