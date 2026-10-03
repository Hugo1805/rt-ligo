import { describe, expect, test } from "bun:test";
import {
  idempotencyKeySchema,
  cashInHeadersSchema,
  createCashInRequestSchema,
} from "./cash-in.schemas";

describe("idempotencyKeySchema", () => {
  test("accepts a valid v4 UUID", () => {
    const validUuid = crypto.randomUUID();
    const result = idempotencyKeySchema.safeParse(validUuid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(validUuid);
    }
  });

  test("fails with IDEMPOTENCY_KEY_MISSING when input is undefined", () => {
    const result = idempotencyKeySchema.safeParse(undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("IDEMPOTENCY_KEY_MISSING");
    }
  });

  test("fails with IDEMPOTENCY_KEY_INVALID when input is not a UUID", () => {
    const invalidInputs = ["", "abc", "12345", "not-a-uuid", "11111111-1111-1111-1111-111111111111"];
    for (const input of invalidInputs) {
      const result = idempotencyKeySchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("IDEMPOTENCY_KEY_INVALID");
      }
    }
  });
});

describe("cashInHeadersSchema", () => {
  test("accepts valid headers containing idempotency-key", () => {
    const validKey = crypto.randomUUID();
    const result = cashInHeadersSchema.safeParse({
      "idempotency-key": validKey,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["idempotency-key"]).toBe(validKey);
    }
  });

  test("allows extra headers without failing (no strict)", () => {
    const validKey = crypto.randomUUID();
    const result = cashInHeadersSchema.safeParse({
      "idempotency-key": validKey,
      "content-type": "application/json",
      "user-agent": "test-agent",
      "x-request-id": crypto.randomUUID(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["idempotency-key"]).toBe(validKey);
      expect("content-type" in result.data).toBe(false);
    }
  });

  test("fails with IDEMPOTENCY_KEY_MISSING when idempotency-key is absent", () => {
    const result = cashInHeadersSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("idempotency-key"));
      expect(issue).toBeDefined();
      expect(issue?.message).toBe("IDEMPOTENCY_KEY_MISSING");
    }
  });

  test("fails with IDEMPOTENCY_KEY_INVALID when idempotency-key is invalid", () => {
    const result = cashInHeadersSchema.safeParse({
      "idempotency-key": "invalid-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("idempotency-key"));
      expect(issue).toBeDefined();
      expect(issue?.message).toBe("IDEMPOTENCY_KEY_INVALID");
    }
  });
});

describe("createCashInRequestSchema", () => {
  const maxAmount = 10000;
  const schema = createCashInRequestSchema(maxAmount);

  const validPayload = {
    user_id: "usr_abc123",
    amount: 100,
    currency: "PEN" as const,
    payment_method: "card_xyz",
  };

  test("accepts valid payloads with integer, 1 decimal, and 2 decimal amounts", () => {
    for (const amount of [100, 100.5, 100.55, 0.01, maxAmount]) {
      const result = schema.safeParse({ ...validPayload, amount });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(amount);
      }
    }
  });

  test("trims whitespace from user_id and payment_method", () => {
    const result = schema.safeParse({
      ...validPayload,
      user_id: "  usr_trimmed  ",
      payment_method: "  card_trimmed  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_id).toBe("usr_trimmed");
      expect(result.data.payment_method).toBe("card_trimmed");
    }
  });

  describe("amount validation", () => {
    test("fails when amount is 0", () => {
      const result = schema.safeParse({ ...validPayload, amount: 0 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("amount"))).toBe(true);
      }
    });

    test("fails when amount is negative", () => {
      const result = schema.safeParse({ ...validPayload, amount: -1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("amount"))).toBe(true);
      }
    });

    test("fails when amount has more than 2 decimals", () => {
      const result = schema.safeParse({ ...validPayload, amount: 100.555 });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes("amount"));
        expect(issue?.message).toBe("Máximo 2 decimales");
      }
    });

    test("fails when amount is a string", () => {
      const result = schema.safeParse({ ...validPayload, amount: "100" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("amount"))).toBe(true);
      }
    });

    test("fails when amount exceeds maxAmount", () => {
      const result = schema.safeParse({ ...validPayload, amount: maxAmount + 0.01 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("amount"))).toBe(true);
      }
    });

    test("fails with scientific notation like 1e-7 due to decimal check", () => {
      const result = schema.safeParse({ ...validPayload, amount: 1e-7 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("amount"))).toBe(true);
      }
    });
  });

  describe("currency validation", () => {
    test("fails when currency is not PEN", () => {
      const result = schema.safeParse({ ...validPayload, currency: "USD" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes("currency"));
        expect(issue?.message).toBe("Solo se acepta PEN");
      }
    });

    test("fails when currency is empty", () => {
      const result = schema.safeParse({ ...validPayload, currency: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes("currency"));
        expect(issue?.message).toBe("Solo se acepta PEN");
      }
    });
  });

  describe("user_id validation", () => {
    test("fails when user_id is empty", () => {
      const result = schema.safeParse({ ...validPayload, user_id: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("user_id"))).toBe(true);
      }
    });

    test("fails when user_id is only whitespace", () => {
      const result = schema.safeParse({ ...validPayload, user_id: "   " });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("user_id"))).toBe(true);
      }
    });

    test("fails when user_id exceeds 64 characters", () => {
      const result = schema.safeParse({ ...validPayload, user_id: "a".repeat(65) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("user_id"))).toBe(true);
      }
    });

    test("passes when user_id is exactly 64 characters", () => {
      const result = schema.safeParse({ ...validPayload, user_id: "a".repeat(64) });
      expect(result.success).toBe(true);
    });
  });

  describe("payment_method validation", () => {
    test("fails when payment_method is empty", () => {
      const result = schema.safeParse({ ...validPayload, payment_method: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("payment_method"))).toBe(true);
      }
    });

    test("fails when payment_method is only whitespace", () => {
      const result = schema.safeParse({ ...validPayload, payment_method: "   " });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("payment_method"))).toBe(true);
      }
    });

    test("fails when payment_method exceeds 64 characters", () => {
      const result = schema.safeParse({ ...validPayload, payment_method: "a".repeat(65) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("payment_method"))).toBe(true);
      }
    });

    test("passes when payment_method is exactly 64 characters", () => {
      const result = schema.safeParse({ ...validPayload, payment_method: "a".repeat(64) });
      expect(result.success).toBe(true);
    });
  });

  describe("strict object validation", () => {
    test("fails when an unrecognized field like ammount is present", () => {
      const result = schema.safeParse({
        ...validPayload,
        ammount: 100,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.code === "unrecognized_keys");
        expect(issue).toBeDefined();
      }
    });

    test("fails when an extra root field is added", () => {
      const result = schema.safeParse({
        ...validPayload,
        unexpected_field: "unexpected",
      });
      expect(result.success).toBe(false);
    });
  });
});
