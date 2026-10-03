export interface ChargeInput {
  reference: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  requestId: string;
}

export type ChargeResult =
  | { status: "succeeded"; chargeId: string }
  | { status: "declined"; chargeId: string; failureCode: string };

export type GetChargeResult = ChargeResult | { status: "not_found" };

export interface PaymentProvider {
  charge(input: ChargeInput): Promise<ChargeResult>;
  getCharge(reference: string): Promise<GetChargeResult>;
}
