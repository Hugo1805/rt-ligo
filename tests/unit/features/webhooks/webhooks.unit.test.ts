import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { Prisma } from "../../../../src/generated/prisma/client";
import type { OperationStatus } from "../../../../src/generated/prisma/enums";
import { createLogger } from "../../../../src/infra/logger";
import type { PrismaClient } from "../../../../src/infra/prisma";
import { withDbRetry } from "../../../../src/shared/db-retry";
import type { ApplyCreditInput, ApplyCreditResult } from "../../../../src/features/wallet/wallet.service";
import type { WebhookOperation, WebhookOutcome, WebhooksRepository } from "../../../../src/features/webhooks/webhooks.repository";
import type { WebhookEvent } from "../../../../src/features/webhooks/webhooks.schemas";
import { createWebhooksService } from "../../../../src/features/webhooks/webhooks.service";

type EventKind = "succeeded" | "failed" | "pending";

const OP_ID = "op_test_0001";

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function makeEvent(kind: EventKind, overrides: Partial<WebhookEvent["data"]> = {}): WebhookEvent {
  return {
    event_id: `evt_${crypto.randomUUID()}`,
    type: `charge.${kind}`,
    created_at: "2026-10-02T15:04:05Z",
    data: {
      charge_id: "ch_123",
      reference: OP_ID,
      amount: 100,
      currency: "PEN",
      failure_code: kind === "failed" ? "card_declined" : null,
      ...overrides,
    },
  };
}

interface HarnessOptions {
  status?: OperationStatus | null;
  amount?: string;
  currency?: string;
  /** Status the operation holds after a lost CAS (applyCredit applied:false or markFailed count 0). */
  statusAfterLostCas?: OperationStatus;
  applyCreditError?: unknown;
  createEventError?: unknown;
}

function harness(opts: HarnessOptions = {}) {
  const tx = { __tx: true } as unknown as Prisma.TransactionClient;
  const txSeen: unknown[] = [];
  const seenEventIds = new Set<string>();
  const closed: Array<{ eventId: string; operationId: string | null; outcome: WebhookOutcome }> = [];
  const markFailedCalls: Array<{ id: string; failureCode: string | null }> = [];
  const applyCreditCalls: Array<{ input: ApplyCreditInput; tx: unknown }> = [];

  let op: WebhookOperation | null =
    opts.status === null
      ? null
      : {
          id: OP_ID,
          status: opts.status ?? "PROCESSING",
          amount: new Prisma.Decimal(opts.amount ?? "100.00"),
          currency: opts.currency ?? "PEN",
        };

  const repository: WebhooksRepository = {
    async createEvent(t, { providerEventId }) {
      txSeen.push(t);
      if (opts.createEventError) throw opts.createEventError;
      // Mirrors the @unique providerEventId: a second insert fails with P2002.
      if (seenEventIds.has(providerEventId)) throw p2002();
      seenEventIds.add(providerEventId);
      return { id: `we_${providerEventId}` };
    },
    async findOperation(t) {
      txSeen.push(t);
      return op ? { ...op } : null;
    },
    async markFailed(t, id, failureCode) {
      txSeen.push(t);
      markFailedCalls.push({ id, failureCode });
      if (op && ["PENDING", "PROCESSING", "UNKNOWN"].includes(op.status) && !opts.statusAfterLostCas) {
        op.status = "FAILED";
        return 1;
      }
      if (op && opts.statusAfterLostCas) op.status = opts.statusAfterLostCas;
      return 0;
    },
    async closeEvent(t, eventId, input) {
      txSeen.push(t);
      closed.push({ eventId, ...input });
    },
  };

  async function applyCredit(input: ApplyCreditInput, t?: Prisma.TransactionClient): Promise<ApplyCreditResult> {
    applyCreditCalls.push({ input, tx: t });
    if (opts.applyCreditError) throw opts.applyCreditError;
    if (!op) throw new Error("no operation");
    const from = op.status;
    if (opts.statusAfterLostCas) {
      op.status = opts.statusAfterLostCas;
      return { applied: false, from: op.status, balanceAfter: null };
    }
    op.status = "COMPLETED";
    return { applied: true, from, balanceAfter: new Prisma.Decimal("100.00") };
  }

  const prisma = {
    $transaction: async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  const logger = createLogger({ level: "debug" }, stream).child({ request_id: "req_test" });

  const service = createWebhooksService({ prisma, applyCredit, withDbRetry, repository });

  return {
    tx,
    txSeen,
    closed,
    markFailedCalls,
    applyCreditCalls,
    lines,
    logger,
    service,
    get op() {
      return op;
    },
    anomalies: () => lines.filter((l) => l.event === "webhook.anomaly"),
    transitions: () => lines.filter((l) => l.event === "operation.transition"),
  };
}

const LEVEL = { warn: 40, error: 50 } as const;

interface Cell {
  status: OperationStatus;
  kind: EventKind;
  outcome: WebhookOutcome;
  to?: OperationStatus;
  anomaly?: keyof typeof LEVEL;
}

// design §6 "Orden de llegada", one row per cell.
const TABLE: Cell[] = [
  { status: "PROCESSING", kind: "succeeded", outcome: "APPLIED", to: "COMPLETED" },
  { status: "PROCESSING", kind: "failed", outcome: "APPLIED", to: "FAILED" },
  { status: "PROCESSING", kind: "pending", outcome: "PENDING_NO_CHANGE" },
  { status: "UNKNOWN", kind: "succeeded", outcome: "APPLIED", to: "COMPLETED" },
  { status: "UNKNOWN", kind: "failed", outcome: "APPLIED", to: "FAILED" },
  { status: "UNKNOWN", kind: "pending", outcome: "PENDING_NO_CHANGE" },
  { status: "PENDING", kind: "succeeded", outcome: "IGNORED_OUT_OF_ORDER", anomaly: "warn" },
  { status: "PENDING", kind: "failed", outcome: "APPLIED", to: "FAILED" },
  { status: "PENDING", kind: "pending", outcome: "PENDING_NO_CHANGE" },
  { status: "COMPLETED", kind: "succeeded", outcome: "NOOP_ALREADY_APPLIED" },
  { status: "COMPLETED", kind: "failed", outcome: "IGNORED_OUT_OF_ORDER", anomaly: "warn" },
  { status: "COMPLETED", kind: "pending", outcome: "PENDING_NO_CHANGE" },
  { status: "FAILED", kind: "succeeded", outcome: "IGNORED_OUT_OF_ORDER", anomaly: "error" },
  { status: "FAILED", kind: "failed", outcome: "NOOP_ALREADY_APPLIED" },
  { status: "FAILED", kind: "pending", outcome: "PENDING_NO_CHANGE" },
];

describe("processWebhookEvent: decision table", () => {
  for (const cell of TABLE) {
    test(`${cell.status} + charge.${cell.kind} -> ${cell.outcome}`, async () => {
      const h = harness({ status: cell.status });
      const event = makeEvent(cell.kind);

      const result = await h.service.processWebhookEvent(event, h.logger);

      expect(result).toEqual({ duplicate: false });
      expect(h.closed).toEqual([
        { eventId: `we_${event.event_id}`, operationId: OP_ID, outcome: cell.outcome },
      ]);
      expect(h.op?.status).toBe(cell.to ?? cell.status);

      const credited = cell.to === "COMPLETED";
      expect(h.applyCreditCalls.length).toBe(credited ? 1 : 0);
      expect(h.markFailedCalls.length).toBe(cell.to === "FAILED" ? 1 : 0);

      if (cell.to) {
        expect(h.transitions()).toEqual([
          expect.objectContaining({
            event: "operation.transition",
            operation_id: OP_ID,
            from: cell.status,
            to: cell.to,
            actor: "webhook",
            request_id: "req_test",
            event_id: event.event_id,
          }),
        ]);
      } else {
        expect(h.transitions()).toEqual([]);
      }

      if (cell.anomaly) {
        expect(h.anomalies()).toEqual([
          expect.objectContaining({ level: LEVEL[cell.anomaly], outcome: cell.outcome }),
        ]);
      } else {
        expect(h.anomalies()).toEqual([]);
      }
    });
  }

  test("every operation call uses the single transaction client", async () => {
    const h = harness({ status: "PROCESSING" });
    await h.service.processWebhookEvent(makeEvent("succeeded"), h.logger);
    expect(h.txSeen.length).toBeGreaterThan(0);
    expect(h.txSeen.every((t) => t === h.tx)).toBe(true);
  });

  test("applyCredit receives actor webhook, the charge id and the transaction tx", async () => {
    const h = harness({ status: "UNKNOWN" });
    await h.service.processWebhookEvent(makeEvent("succeeded", { charge_id: "ch_xyz" }), h.logger);
    expect(h.applyCreditCalls).toEqual([
      { input: { operationId: OP_ID, providerChargeId: "ch_xyz", actor: "webhook" }, tx: h.tx },
    ]);
  });

  test("charge.failed stores the provider failure_code", async () => {
    const h = harness({ status: "PROCESSING" });
    await h.service.processWebhookEvent(makeEvent("failed", { failure_code: "insufficient_funds" }), h.logger);
    expect(h.markFailedCalls).toEqual([{ id: OP_ID, failureCode: "insufficient_funds" }]);
  });
});

describe("processWebhookEvent: orphan and mismatch", () => {
  test("orphan closes the event with operationId null and does not throw", async () => {
    const h = harness({ status: null });
    const event = makeEvent("succeeded");

    const result = await h.service.processWebhookEvent(event, h.logger);

    expect(result).toEqual({ duplicate: false });
    expect(h.closed).toEqual([{ eventId: `we_${event.event_id}`, operationId: null, outcome: "ORPHAN" }]);
    expect(h.applyCreditCalls).toEqual([]);
    expect(h.anomalies()).toEqual([expect.objectContaining({ level: LEVEL.warn, outcome: "ORPHAN" })]);
  });

  test("different amount: no credit, AMOUNT_MISMATCH and error anomaly with both amounts", async () => {
    const h = harness({ status: "PROCESSING", amount: "100.00" });
    const result = await h.service.processWebhookEvent(makeEvent("succeeded", { amount: 100.01 }), h.logger);

    expect(result).toEqual({ duplicate: false });
    expect(h.applyCreditCalls).toEqual([]);
    expect(h.op?.status).toBe("PROCESSING");
    expect(h.closed[0]?.outcome).toBe("AMOUNT_MISMATCH");
    expect(h.anomalies()).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        outcome: "AMOUNT_MISMATCH",
        event_amount: "100.01",
        operation_amount: "100.00",
      }),
    ]);
  });

  test("different currency: no credit and AMOUNT_MISMATCH", async () => {
    const h = harness({ status: "PROCESSING" });
    await h.service.processWebhookEvent(makeEvent("succeeded", { currency: "USD" }), h.logger);

    expect(h.applyCreditCalls).toEqual([]);
    expect(h.closed[0]?.outcome).toBe("AMOUNT_MISMATCH");
    expect(h.anomalies()).toEqual([expect.objectContaining({ level: LEVEL.error })]);
  });

  test("a mismatched charge.failed does not mark the operation FAILED", async () => {
    const h = harness({ status: "PROCESSING" });
    await h.service.processWebhookEvent(makeEvent("failed", { amount: 5 }), h.logger);
    expect(h.markFailedCalls).toEqual([]);
    expect(h.closed[0]?.outcome).toBe("AMOUNT_MISMATCH");
  });

  test("amounts are compared as decimals: 100.1 matches 100.10", async () => {
    const h = harness({ status: "PROCESSING", amount: "100.10" });
    await h.service.processWebhookEvent(makeEvent("succeeded", { amount: 100.1 }), h.logger);
    expect(h.closed[0]?.outcome).toBe("APPLIED");
    expect(h.applyCreditCalls.length).toBe(1);
  });
});

describe("processWebhookEvent: lost CAS re-reads the real state", () => {
  test("applyCredit applied:false and operation now COMPLETED -> NOOP_ALREADY_APPLIED, no transition log", async () => {
    const h = harness({ status: "PROCESSING", statusAfterLostCas: "COMPLETED" });
    await h.service.processWebhookEvent(makeEvent("succeeded"), h.logger);

    expect(h.applyCreditCalls.length).toBe(1);
    expect(h.closed[0]?.outcome).toBe("NOOP_ALREADY_APPLIED");
    expect(h.transitions()).toEqual([]);
  });

  test("applyCredit applied:false and operation now FAILED -> IGNORED_OUT_OF_ORDER with error anomaly", async () => {
    const h = harness({ status: "UNKNOWN", statusAfterLostCas: "FAILED" });
    await h.service.processWebhookEvent(makeEvent("succeeded"), h.logger);

    expect(h.closed[0]?.outcome).toBe("IGNORED_OUT_OF_ORDER");
    expect(h.anomalies()).toEqual([expect.objectContaining({ level: LEVEL.error })]);
    expect(h.transitions()).toEqual([]);
  });

  test("markFailed count 0 and operation now COMPLETED -> IGNORED_OUT_OF_ORDER with warn anomaly", async () => {
    const h = harness({ status: "PROCESSING", statusAfterLostCas: "COMPLETED" });
    await h.service.processWebhookEvent(makeEvent("failed"), h.logger);

    expect(h.markFailedCalls.length).toBe(1);
    expect(h.closed[0]?.outcome).toBe("IGNORED_OUT_OF_ORDER");
    expect(h.anomalies()).toEqual([expect.objectContaining({ level: LEVEL.warn })]);
  });

  test("markFailed count 0 and operation now FAILED -> NOOP_ALREADY_APPLIED", async () => {
    const h = harness({ status: "UNKNOWN", statusAfterLostCas: "FAILED" });
    await h.service.processWebhookEvent(makeEvent("failed"), h.logger);
    expect(h.closed[0]?.outcome).toBe("NOOP_ALREADY_APPLIED");
    expect(h.anomalies()).toEqual([]);
  });
});

describe("processWebhookEvent: duplicates and P2002", () => {
  test("P2002 in createEvent is a duplicate: no effects, event not closed", async () => {
    const h = harness({ status: "PROCESSING", createEventError: p2002() });
    const result = await h.service.processWebhookEvent(makeEvent("succeeded"), h.logger);

    expect(result).toEqual({ duplicate: true });
    expect(h.applyCreditCalls).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.lines.some((l) => l.event === "webhook.duplicate")).toBe(true);
  });

  test("the same event_id twice: second call is duplicate and does not repeat effects", async () => {
    const h = harness({ status: "PROCESSING" });
    const event = makeEvent("succeeded");

    const first = await h.service.processWebhookEvent(event, h.logger);
    const second = await h.service.processWebhookEvent(event, h.logger);

    expect(first).toEqual({ duplicate: false });
    expect(second).toEqual({ duplicate: true });
    expect(h.applyCreditCalls.length).toBe(1);
    expect(h.closed.length).toBe(1);
    expect(h.transitions().length).toBe(1);
  });

  test("P2002 raised after createEvent (applyCredit) is rethrown, not a duplicate", async () => {
    const error = p2002();
    const h = harness({ status: "PROCESSING", applyCreditError: error });

    await expect(h.service.processWebhookEvent(makeEvent("succeeded"), h.logger)).rejects.toBe(error);
    expect(h.lines.some((l) => l.event === "webhook.duplicate")).toBe(false);
    expect(h.transitions()).toEqual([]);
  });

  test("any other error is rethrown and nothing is logged as applied", async () => {
    const error = new Error("boom");
    const h = harness({ status: "PROCESSING", applyCreditError: error });

    await expect(h.service.processWebhookEvent(makeEvent("succeeded"), h.logger)).rejects.toBe(error);
    expect(h.transitions()).toEqual([]);
    expect(h.anomalies()).toEqual([]);
  });

  test("a transient error retries the whole transaction and resets the duplicate flag", async () => {
    let attempts = 0;
    const tx = {} as Prisma.TransactionClient;
    const closed: WebhookOutcome[] = [];
    const repository: WebhooksRepository = {
      async createEvent() {
        attempts++;
        return { id: `we_${attempts}` };
      },
      async findOperation() {
        return { id: OP_ID, status: "PROCESSING", amount: new Prisma.Decimal("100.00"), currency: "PEN" };
      },
      async markFailed() {
        return 1;
      },
      async closeEvent(_t, _id, { outcome }) {
        closed.push(outcome);
      },
    };
    const applyCredit = async (): Promise<ApplyCreditResult> => {
      if (attempts === 1) {
        throw new Prisma.PrismaClientKnownRequestError("deadlock", { code: "P2034", clientVersion: "test" });
      }
      return { applied: true, from: "PROCESSING", balanceAfter: new Prisma.Decimal("100.00") };
    };
    const prisma = {
      $transaction: async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient;
    const service = createWebhooksService({
      prisma,
      applyCredit,
      withDbRetry: (fn, options) => withDbRetry(fn, { ...options, sleep: async () => {} }),
      repository,
    });

    const result = await service.processWebhookEvent(makeEvent("succeeded"), createLogger({ level: "silent" }));

    expect(result).toEqual({ duplicate: false });
    expect(attempts).toBe(2);
    expect(closed).toEqual(["APPLIED"]);
  });
});
