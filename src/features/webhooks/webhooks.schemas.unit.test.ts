import { describe, expect, test } from "bun:test";
import { webhookEventSchema } from "./webhooks.schemas";

describe("webhookEventSchema", () => {
  const validEvent = {
    event_id: "evt_01J9XYZ",
    type: "charge.succeeded" as const,
    created_at: "2026-10-02T15:04:05Z",
    data: {
      charge_id: "ch_123",
      reference: "op_9f8e7d",
      amount: 100.0,
      currency: "PEN",
      failure_code: null,
    },
  };

  test("accepts a valid webhook event from design §6", () => {
    const result = webhookEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_id).toBe("evt_01J9XYZ");
      expect(result.data.type).toBe("charge.succeeded");
      expect(result.data.data.reference).toBe("op_9f8e7d");
      expect(result.data.data.failure_code).toBeNull();
    }
  });

  test("accepts all valid event types: charge.succeeded, charge.failed, charge.pending", () => {
    const validTypes = [
      "charge.succeeded",
      "charge.failed",
      "charge.pending",
    ] as const;

    for (const type of validTypes) {
      const result = webhookEventSchema.safeParse({ ...validEvent, type });
      expect(result.success).toBe(true);
    }
  });

  test("fails when type is unknown", () => {
    const invalidTypes = ["charge.refunded", "charge.completed", "payment.succeeded", "unknown"];
    for (const type of invalidTypes) {
      const result = webhookEventSchema.safeParse({ ...validEvent, type });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("type"))).toBe(true);
      }
    }
  });

  test("fails when created_at is not an ISO 8601 datetime", () => {
    const invalidDates = ["not-a-date", "2026/10/02", "15:04:05", "1727890000"];
    for (const created_at of invalidDates) {
      const result = webhookEventSchema.safeParse({ ...validEvent, created_at });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("created_at"))).toBe(true);
      }
    }
  });

  test("accepts valid ISO datetime formats", () => {
    const validDates = [
      "2026-10-02T15:04:05Z",
      "2026-10-02T15:04:05.000Z",
      "2026-10-02T15:04:05.123Z",
    ];
    for (const created_at of validDates) {
      const result = webhookEventSchema.safeParse({ ...validEvent, created_at });
      expect(result.success).toBe(true);
    }
  });

  test("accepts failure_code as string and as null", () => {
    const withString = webhookEventSchema.safeParse({
      ...validEvent,
      type: "charge.failed",
      data: { ...validEvent.data, failure_code: "insufficient_funds" },
    });
    expect(withString.success).toBe(true);
    if (withString.success) {
      expect(withString.data.data.failure_code).toBe("insufficient_funds");
    }

    const withNull = webhookEventSchema.safeParse({
      ...validEvent,
      data: { ...validEvent.data, failure_code: null },
    });
    expect(withNull.success).toBe(true);
    if (withNull.success) {
      expect(withNull.data.data.failure_code).toBeNull();
    }
  });

  test("accepts arbitrary currency and amount (R9.9: mismatch handled downstream, not by schema)", () => {
    const withUsd = webhookEventSchema.safeParse({
      ...validEvent,
      data: { ...validEvent.data, currency: "USD", amount: 999999 },
    });
    expect(withUsd.success).toBe(true);
    if (withUsd.success) {
      expect(withUsd.data.data.currency).toBe("USD");
      expect(withUsd.data.data.amount).toBe(999999);
    }
  });

  test("fails when currency is not exactly 3 characters", () => {
    for (const currency of ["US", "USDD", ""]) {
      const result = webhookEventSchema.safeParse({
        ...validEvent,
        data: { ...validEvent.data, currency },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("currency"))).toBe(true);
      }
    }
  });

  test("fails when data.reference is missing or empty", () => {
    const missing = webhookEventSchema.safeParse({
      ...validEvent,
      data: {
        charge_id: "ch_123",
        amount: 100,
        currency: "PEN",
        failure_code: null,
      },
    });
    expect(missing.success).toBe(false);

    const empty = webhookEventSchema.safeParse({
      ...validEvent,
      data: { ...validEvent.data, reference: "" },
    });
    expect(empty.success).toBe(false);
  });

  test("fails when data.charge_id is missing or empty", () => {
    const missing = webhookEventSchema.safeParse({
      ...validEvent,
      data: {
        reference: "op_123",
        amount: 100,
        currency: "PEN",
        failure_code: null,
      },
    });
    expect(missing.success).toBe(false);

    const empty = webhookEventSchema.safeParse({
      ...validEvent,
      data: { ...validEvent.data, charge_id: "" },
    });
    expect(empty.success).toBe(false);
  });

  test("fails when event_id is empty", () => {
    const result = webhookEventSchema.safeParse({ ...validEvent, event_id: "" });
    expect(result.success).toBe(false);
  });

  test("discards unknown fields in root and in data without failing (no strict)", () => {
    const withExtras = {
      ...validEvent,
      unknown_root_prop: "provider_added_field",
      data: {
        ...validEvent.data,
        unknown_data_prop: 12345,
      },
    };

    const result = webhookEventSchema.safeParse(withExtras);
    expect(result.success).toBe(true);
    if (result.success) {
      expect("unknown_root_prop" in result.data).toBe(false);
      expect("unknown_data_prop" in result.data.data).toBe(false);
      expect(result.data.event_id).toBe("evt_01J9XYZ");
    }
  });
});
