abstract class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No response within the timeout. The charge may or may not have happened. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message = "Payment provider request timed out", options?: ErrorOptions) {
    super(message, options);
  }
}

/** Technical failure such as a refused connection or a 5xx. Safe to retry with the same reference. */
export class ProviderUnavailableError extends ProviderError {
  constructor(message = "Payment provider is unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}

/** Response outside the contract. Never treated as a decline. */
export class ProviderUnexpectedError extends ProviderError {
  constructor(message = "Unexpected payment provider response", options?: ErrorOptions) {
    super(message, options);
  }
}
