import { beforeEach, describe, expect, test } from "bun:test";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderUnexpectedError,
} from "./errors";
import { FakePaymentProvider } from "./fake.provider";
import type { ChargeInput, ChargeResult, GetChargeResult } from "./payment-provider";

describe("FakePaymentProvider", () => {
  let provider: FakePaymentProvider;

  beforeEach(() => {
    provider = new FakePaymentProvider();
  });

  describe("charge scenarios by payment_method", () => {
    test("card_ok charges successfully and returns succeeded with formatted chargeId", async () => {
      const input: ChargeInput = {
        reference: "ref-ok-1",
        amount: "100.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-1",
      };

      const result = await provider.charge(input);

      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.chargeId).toMatch(/^ch_[0-9a-f]{32}$/);
      }
    });

    test("any unknown payment method defaults to succeeded", async () => {
      const input: ChargeInput = {
        reference: "ref-other-1",
        amount: "50.00",
        currency: "PEN",
        paymentMethod: "yape_qr",
        requestId: "req-2",
      };

      const result = await provider.charge(input);

      expect(result.status).toBe("succeeded");
      if (result.status === "succeeded") {
        expect(result.chargeId).toMatch(/^ch_[0-9a-f]{32}$/);
      }
    });

    test("card_declined returns declined with insufficient_funds and does not throw", async () => {
      const input: ChargeInput = {
        reference: "ref-declined-1",
        amount: "250.00",
        currency: "PEN",
        paymentMethod: "card_declined",
        requestId: "req-3",
      };

      const result = await provider.charge(input);

      expect(result.status).toBe("declined");
      if (result.status === "declined") {
        expect(result.chargeId).toMatch(/^ch_[0-9a-f]{32}$/);
        expect(result.failureCode).toBe("insufficient_funds");
      }
    });

    test("card_timeout saves charge as succeeded and throws ProviderTimeoutError immediately", async () => {
      const input: ChargeInput = {
        reference: "ref-timeout-1",
        amount: "75.00",
        currency: "PEN",
        paymentMethod: "card_timeout",
        requestId: "req-4",
      };

      await expect(provider.charge(input)).rejects.toBeInstanceOf(
        ProviderTimeoutError
      );

      const saved = await provider.getCharge("ref-timeout-1");
      expect(saved.status).toBe("succeeded");
      if (saved.status === "succeeded") {
        expect(saved.chargeId).toMatch(/^ch_[0-9a-f]{32}$/);
      }
    });

    test("card_flaky throws ProviderUnavailableError on first call, succeeds on second call, and subsequent calls return the same chargeId", async () => {
      const input: ChargeInput = {
        reference: "ref-flaky-1",
        amount: "120.00",
        currency: "PEN",
        paymentMethod: "card_flaky",
        requestId: "req-5-1",
      };

      // 1st attempt: throws ProviderUnavailableError without persisting charge
      await expect(provider.charge(input)).rejects.toBeInstanceOf(
        ProviderUnavailableError
      );
      const chargeAfterFirst = await provider.getCharge("ref-flaky-1");
      expect(chargeAfterFirst).toEqual({ status: "not_found" });

      // 2nd attempt: succeeds and persists charge
      const secondResult = await provider.charge({
        ...input,
        requestId: "req-5-2",
      });
      expect(secondResult.status).toBe("succeeded");
      let chargeId = "";
      if (secondResult.status === "succeeded") {
        chargeId = secondResult.chargeId;
        expect(chargeId).toMatch(/^ch_[0-9a-f]{32}$/);
      }

      // 3rd attempt: idempotent replay returns identical result
      const thirdResult = await provider.charge({
        ...input,
        requestId: "req-5-3",
      });
      expect(thirdResult).toEqual(secondResult);
      if (thirdResult.status === "succeeded") {
        expect(thirdResult.chargeId).toBe(chargeId);
      }
    });

    test("card_flaky isolates failure counter per reference", async () => {
      const refA: ChargeInput = {
        reference: "ref-flaky-A",
        amount: "10.00",
        currency: "PEN",
        paymentMethod: "card_flaky",
        requestId: "req-A-1",
      };
      const refB: ChargeInput = {
        reference: "ref-flaky-B",
        amount: "20.00",
        currency: "PEN",
        paymentMethod: "card_flaky",
        requestId: "req-B-1",
      };

      // refA fails first time
      await expect(provider.charge(refA)).rejects.toBeInstanceOf(
        ProviderUnavailableError
      );
      // refA succeeds second time
      const resultA = await provider.charge({ ...refA, requestId: "req-A-2" });
      expect(resultA.status).toBe("succeeded");

      // refB MUST fail on its first call despite refA having succeeded
      await expect(provider.charge(refB)).rejects.toBeInstanceOf(
        ProviderUnavailableError
      );
      // refB succeeds second time
      const resultB = await provider.charge({ ...refB, requestId: "req-B-2" });
      expect(resultB.status).toBe("succeeded");
    });
  });

  describe("reference idempotency", () => {
    test("two charge calls with the same reference return the same chargeId", async () => {
      const input1: ChargeInput = {
        reference: "ref-idem-1",
        amount: "100.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-idem-1",
      };

      const result1 = await provider.charge(input1);
      const result2 = await provider.charge({
        ...input1,
        amount: "999.00", // amount change does not alter existing charge
        paymentMethod: "card_declined",
        requestId: "req-idem-2",
      });

      expect(result1).toEqual(result2);
      if (result1.status === "succeeded" && result2.status === "succeeded") {
        expect(result1.chargeId).toBe(result2.chargeId);
      }
    });

    test("two charge calls with the same reference for card_declined return the same declined chargeId", async () => {
      const input: ChargeInput = {
        reference: "ref-declined-idem",
        amount: "50.00",
        currency: "PEN",
        paymentMethod: "card_declined",
        requestId: "req-dec-1",
      };

      const res1 = await provider.charge(input);
      const res2 = await provider.charge({ ...input, requestId: "req-dec-2" });

      expect(res1).toEqual(res2);
      if (res1.status === "declined" && res2.status === "declined") {
        expect(res1.chargeId).toBe(res2.chargeId);
        expect(res1.failureCode).toBe("insufficient_funds");
      }
    });

    test("charge call after card_timeout returns the saved chargeId without throwing", async () => {
      const input: ChargeInput = {
        reference: "ref-timeout-idem",
        amount: "80.00",
        currency: "PEN",
        paymentMethod: "card_timeout",
        requestId: "req-to-1",
      };

      await expect(provider.charge(input)).rejects.toBeInstanceOf(
        ProviderTimeoutError
      );

      const secondCall = await provider.charge({
        ...input,
        requestId: "req-to-2",
      });
      expect(secondCall.status).toBe("succeeded");

      const queried = await provider.getCharge("ref-timeout-idem");
      expect(queried).toEqual(secondCall);
    });
  });

  describe("getCharge", () => {
    test("returns not_found for unknown reference", async () => {
      const res: GetChargeResult = await provider.getCharge("non-existent-ref");
      expect(res).toEqual({ status: "not_found" });
    });

    test("returns saved succeeded charge", async () => {
      const input: ChargeInput = {
        reference: "ref-get-ok",
        amount: "30.00",
        currency: "PEN",
        paymentMethod: "card_ok",
        requestId: "req-get-1",
      };

      const charged = await provider.charge(input);
      const fetched = await provider.getCharge("ref-get-ok");

      expect(fetched).toEqual(charged);
    });

    test("returns saved declined charge", async () => {
      const input: ChargeInput = {
        reference: "ref-get-declined",
        amount: "40.00",
        currency: "PEN",
        paymentMethod: "card_declined",
        requestId: "req-get-2",
      };

      const charged = await provider.charge(input);
      const fetched = await provider.getCharge("ref-get-declined");

      expect(fetched).toEqual(charged);
    });
  });

  describe("inspection: calls and chargeCount", () => {
    test("calls records requestId and reference of each call, and chargeCount counts failed calls", async () => {
      const ref = "ref-inspect-1";

      await expect(
        provider.charge({
          reference: ref,
          amount: "10.00",
          currency: "PEN",
          paymentMethod: "card_flaky",
          requestId: "req-call-1",
        })
      ).rejects.toThrow();

      await expect(
        provider.charge({
          reference: "ref-other",
          amount: "15.00",
          currency: "PEN",
          paymentMethod: "card_timeout",
          requestId: "req-call-2",
        })
      ).rejects.toThrow();

      await provider.charge({
        reference: ref,
        amount: "10.00",
        currency: "PEN",
        paymentMethod: "card_flaky",
        requestId: "req-call-3",
      });

      expect(provider.calls.length).toBe(3);
      expect(provider.calls[0]!.requestId).toBe("req-call-1");
      expect(provider.calls[0]!.reference).toBe(ref);
      expect(provider.calls[1]!.requestId).toBe("req-call-2");
      expect(provider.calls[1]!.reference).toBe("ref-other");
      expect(provider.calls[2]!.requestId).toBe("req-call-3");
      expect(provider.calls[2]!.reference).toBe(ref);

      expect(provider.chargeCount(ref)).toBe(2);
      expect(provider.chargeCount("ref-other")).toBe(1);
      expect(provider.chargeCount("unknown-ref")).toBe(0);
    });
  });
});

describe("FakePaymentProvider isolation", () => {
  test("mutating a returned result does not alter the stored charge", async () => {
    const provider = new FakePaymentProvider();
    const input = { reference: "op_iso", amount: "10.00", currency: "PEN", paymentMethod: "card_ok", requestId: "r" };
    const first = await provider.charge(input);
    (first as { chargeId: string }).chargeId = "tampered";
    const fetched = await provider.getCharge("op_iso");
    (fetched as { status: string }).status = "declined";

    const again = await provider.charge(input);
    expect(again.chargeId).not.toBe("tampered");
    expect((await provider.getCharge("op_iso")).status).toBe("succeeded");
  });
});

describe("Payment Provider Errors", () => {
  test("ProviderTimeoutError extends Error, sets name and preserves cause", () => {
    const cause = new Error("network timeout");
    const err = new ProviderTimeoutError("custom timeout", { cause });

    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderTimeoutError");
    expect(err.message).toBe("custom timeout");
    expect(err.cause).toBe(cause);

    const defaultErr = new ProviderTimeoutError();
    expect(defaultErr.name).toBe("ProviderTimeoutError");
    expect(defaultErr.message).toBe("Payment provider request timed out");
  });

  test("ProviderUnavailableError extends Error, sets name and preserves cause", () => {
    const cause = { status: 503 };
    const err = new ProviderUnavailableError("service down", { cause });

    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderUnavailableError");
    expect(err.message).toBe("service down");
    expect(err.cause).toBe(cause);

    const defaultErr = new ProviderUnavailableError();
    expect(defaultErr.name).toBe("ProviderUnavailableError");
    expect(defaultErr.message).toBe("Payment provider is unavailable");
  });

  test("ProviderUnexpectedError extends Error, sets name and preserves cause", () => {
    const cause = new Error("schema validation failed");
    const err = new ProviderUnexpectedError("unexpected body", { cause });

    expect(err).toBeInstanceOf(ProviderUnexpectedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderUnexpectedError");
    expect(err.message).toBe("unexpected body");
    expect(err.cause).toBe(cause);

    const defaultErr = new ProviderUnexpectedError();
    expect(defaultErr.name).toBe("ProviderUnexpectedError");
    expect(defaultErr.message).toBe("Unexpected payment provider response");
  });
});
