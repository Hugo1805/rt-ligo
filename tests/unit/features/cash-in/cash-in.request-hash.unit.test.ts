import { describe, expect, test } from "bun:test";
import { Prisma } from "../../../../src/generated/prisma/client";
import {
  computeRequestHash,
  type RequestHashInput,
} from "../../../../src/features/cash-in/cash-in.request-hash";

describe("computeRequestHash", () => {
  const baseInput: RequestHashInput = {
    user_id: "usr_123",
    amount: 100,
    currency: "PEN",
    payment_method: "card",
  };

  test("produces the same hash for 100, 100.0, and '100.00'", () => {
    const hashNumberInt = computeRequestHash({ ...baseInput, amount: 100 });
    const hashNumberFloat = computeRequestHash({ ...baseInput, amount: 100.0 });
    const hashString = computeRequestHash({ ...baseInput, amount: "100.00" });
    const hashDecimal = computeRequestHash({
      ...baseInput,
      amount: new Prisma.Decimal("100.00"),
    });

    expect(hashNumberInt).toBe(hashString);
    expect(hashNumberFloat).toBe(hashString);
    expect(hashDecimal).toBe(hashString);
  });

  test("produces the same hash regardless of input key order", () => {
    const orderedA = computeRequestHash({
      user_id: "usr_123",
      amount: 100,
      currency: "PEN",
      payment_method: "card",
    });

    const orderedB = computeRequestHash({
      payment_method: "card",
      currency: "PEN",
      user_id: "usr_123",
      amount: 100,
    });

    const orderedC = computeRequestHash({
      amount: 100,
      user_id: "usr_123",
      payment_method: "card",
      currency: "PEN",
    });

    expect(orderedB).toBe(orderedA);
    expect(orderedC).toBe(orderedA);
  });

  test("changing any single field produces a different hash", () => {
    const originalHash = computeRequestHash(baseInput);

    const changedUserId = computeRequestHash({
      ...baseInput,
      user_id: "usr_999",
    });
    const changedAmount = computeRequestHash({
      ...baseInput,
      amount: 100.01,
    });
    const changedCurrency = computeRequestHash({
      ...baseInput,
      currency: "USD",
    });
    const changedMethod = computeRequestHash({
      ...baseInput,
      payment_method: "yape",
    });

    expect(changedUserId).not.toBe(originalHash);
    expect(changedAmount).not.toBe(originalHash);
    expect(changedCurrency).not.toBe(originalHash);
    expect(changedMethod).not.toBe(originalHash);
  });

  test("distinguishes between 100.01 and 100.1 (100.10)", () => {
    const hash01 = computeRequestHash({ ...baseInput, amount: 100.01 });
    const hash10 = computeRequestHash({ ...baseInput, amount: 100.1 });
    expect(hash01).not.toBe(hash10);
  });

  test("ignores extra fields in input at runtime", () => {
    const standardHash = computeRequestHash(baseInput);
    const withExtra = computeRequestHash({
      ...baseInput,
      extra_prop: "unexpected",
      idempotency_key: "some-key",
    } as unknown as RequestHashInput);

    expect(withExtra).toBe(standardHash);
  });

  test("output matches 64 lowercase hex characters", () => {
    const hash = computeRequestHash(baseInput);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches fixed regression vector", () => {
    // Canonical JSON: {"amount":"150.50","currency":"PEN","payment_method":"card","user_id":"usr_fixed_vector"}
    const input: RequestHashInput = {
      user_id: "usr_fixed_vector",
      amount: 150.5,
      currency: "PEN",
      payment_method: "card",
    };

    const hash = computeRequestHash(input);
    // sha256('{"amount":"150.50","currency":"PEN","payment_method":"card","user_id":"usr_fixed_vector"}')
    expect(hash).toBe(
      "645019b7788b8a85d6f290110c78f499e753216642e6a8ea36d053425c4d6cc8"
    );
  });
});
