import { z } from "zod";
import type { Logger } from "../logger";
import {
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderUnexpectedError,
} from "./errors";
import type {
  ChargeInput,
  ChargeResult,
  GetChargeResult,
  PaymentProvider,
} from "./payment-provider";

const chargeSuccessResponseSchema = z.object({
  status: z.literal("succeeded"),
  charge_id: z.string().min(1),
});

const chargeDeclinedResponseSchema = z.object({
  status: z.literal("declined"),
  charge_id: z.string().min(1),
  failure_code: z.string().min(1),
});

const chargeResponseSchema = z.discriminatedUnion("status", [
  chargeSuccessResponseSchema,
  chargeDeclinedResponseSchema,
]);

export interface HttpPaymentProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  logger?: Logger | undefined;
}

export class HttpPaymentProvider implements PaymentProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(baseUrl: string, timeoutMs: number, logger?: Logger | undefined);
  constructor(options: HttpPaymentProviderOptions);
  constructor(
    baseUrlOrOptions: string | HttpPaymentProviderOptions,
    timeoutMs?: number,
    logger?: Logger
  ) {
    if (typeof baseUrlOrOptions === "string") {
      this.baseUrl = baseUrlOrOptions.replace(/\/+$/, "");
      this.timeoutMs = timeoutMs ?? 3000;
      this.logger = logger;
    } else {
      this.baseUrl = baseUrlOrOptions.baseUrl.replace(/\/+$/, "");
      this.timeoutMs = baseUrlOrOptions.timeoutMs;
      this.logger = baseUrlOrOptions.logger;
    }
  }

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const url = `${this.baseUrl}/charges`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": input.requestId,
        },
        body: JSON.stringify({
          reference: input.reference,
          amount: input.amount,
          currency: input.currency,
          payment_method: input.paymentMethod,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const isTimeout =
        (err instanceof Error && err.name === "TimeoutError") ||
        (err as { name?: string })?.name === "TimeoutError";

      if (isTimeout) {
        this.logger?.warn(
          { reference: input.reference, requestId: input.requestId },
          "Provider request timed out during charge"
        );
        throw new ProviderTimeoutError("Payment provider request timed out", {
          cause: err,
        });
      }

      this.logger?.error(
        { reference: input.reference, requestId: input.requestId },
        "Provider network error during charge"
      );
      throw new ProviderUnavailableError("Payment provider is unavailable", {
        cause: err,
      });
    }

    return this.parseChargeResponse(response, input.requestId, input.reference);
  }

  async getCharge(reference: string): Promise<GetChargeResult> {
    const url = `${this.baseUrl}/charges/${encodeURIComponent(reference)}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const isTimeout =
        (err instanceof Error && err.name === "TimeoutError") ||
        (err as { name?: string })?.name === "TimeoutError";

      if (isTimeout) {
        this.logger?.warn(
          { reference },
          "Provider request timed out during getCharge"
        );
        throw new ProviderTimeoutError("Payment provider request timed out", {
          cause: err,
        });
      }

      this.logger?.error(
        { reference },
        "Provider network error during getCharge"
      );
      throw new ProviderUnavailableError("Payment provider is unavailable", {
        cause: err,
      });
    }

    if (response.status === 404) {
      return { status: "not_found" };
    }

    return this.parseChargeResponse(response, undefined, reference);
  }

  private async parseChargeResponse(
    response: Response,
    requestId?: string,
    reference?: string
  ): Promise<ChargeResult> {
    if (response.status >= 500) {
      this.logger?.error(
        { status: response.status, requestId, reference },
        "Provider returned 5xx status"
      );
      throw new ProviderUnavailableError("Payment provider is unavailable");
    }

    if (response.status !== 200) {
      this.logger?.error(
        { status: response.status, requestId, reference },
        "Provider returned unexpected HTTP status"
      );
      throw new ProviderUnexpectedError("Unexpected payment provider response");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      this.logger?.error(
        { err, status: response.status, requestId, reference },
        "Failed to parse provider JSON response"
      );
      throw new ProviderUnexpectedError("Unexpected payment provider response");
    }

    const parsed = chargeResponseSchema.safeParse(body);
    if (!parsed.success) {
      this.logger?.error(
        { issues: parsed.error.issues, body, requestId, reference },
        "Provider response body failed schema validation"
      );
      throw new ProviderUnexpectedError("Unexpected payment provider response");
    }

    if (parsed.data.status === "succeeded") {
      return {
        status: "succeeded",
        chargeId: parsed.data.charge_id,
      };
    }

    return {
      status: "declined",
      chargeId: parsed.data.charge_id,
      failureCode: parsed.data.failure_code,
    };
  }
}
