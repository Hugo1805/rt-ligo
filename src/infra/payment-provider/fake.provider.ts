import { randomUUID } from "node:crypto";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "./errors";
import type {
  ChargeInput,
  ChargeResult,
  GetChargeResult,
  PaymentProvider,
} from "./payment-provider";

export class FakePaymentProvider implements PaymentProvider {
  readonly calls: ChargeInput[] = [];
  private readonly charges = new Map<string, ChargeResult>();
  private readonly flakyFailed = new Set<string>();

  async charge(input: ChargeInput): Promise<ChargeResult> {
    this.calls.push({ ...input });

    const existing = this.charges.get(input.reference);
    if (existing) {
      return { ...existing };
    }

    if (input.paymentMethod === "card_declined") {
      const result: ChargeResult = {
        status: "declined",
        chargeId: this.generateChargeId(),
        failureCode: "insufficient_funds",
      };
      this.charges.set(input.reference, result);
      return { ...result };
    }

    if (input.paymentMethod === "card_timeout") {
      const result: ChargeResult = {
        status: "succeeded",
        chargeId: this.generateChargeId(),
      };
      this.charges.set(input.reference, result);
      throw new ProviderTimeoutError("Payment provider request timed out");
    }

    if (input.paymentMethod === "card_flaky") {
      if (!this.flakyFailed.has(input.reference)) {
        this.flakyFailed.add(input.reference);
        throw new ProviderUnavailableError("Payment provider is unavailable");
      }
    }

    const result: ChargeResult = {
      status: "succeeded",
      chargeId: this.generateChargeId(),
    };
    this.charges.set(input.reference, result);
    return { ...result };
  }

  async getCharge(reference: string): Promise<GetChargeResult> {
    const charge = this.charges.get(reference);
    if (!charge) {
      return { status: "not_found" };
    }
    return { ...charge };
  }

  chargeCount(reference: string): number {
    return this.calls.filter((c) => c.reference === reference).length;
  }

  private generateChargeId(): string {
    return `ch_${randomUUID().replace(/-/g, "")}`;
  }
}
