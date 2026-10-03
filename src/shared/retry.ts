export type BackoffOptions = {
  baseMs?: number | undefined;
  capMs?: number | undefined;
  random?: (() => number) | undefined;
};

export type RetryOptions = {
  maxRetries: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  baseMs?: number | undefined;
  capMs?: number | undefined;
  random?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  onRetry?: ((info: { attempt: number; delayMs: number; error: unknown }) => void) | undefined;
};

const defaultSleep = (ms: number): Promise<void> => {
  if (typeof Bun !== "undefined" && typeof Bun.sleep === "function") {
    return Bun.sleep(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export function computeBackoffMs(
  retryIndex: number,
  options: BackoffOptions = {}
): number {
  if (typeof retryIndex !== "number" || !Number.isInteger(retryIndex) || retryIndex < 0) {
    throw new TypeError("retryIndex must be an integer >= 0");
  }

  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new TypeError("options must be an object");
  }

  const {
    baseMs = 100,
    capMs = 1000,
    random = Math.random,
  } = options;

  if (typeof baseMs !== "number" || !Number.isFinite(baseMs) || baseMs <= 0) {
    throw new TypeError("baseMs must be a positive number");
  }
  if (typeof capMs !== "number" || !Number.isFinite(capMs) || capMs <= 0) {
    throw new TypeError("capMs must be a positive number");
  }
  if (typeof random !== "function") {
    throw new TypeError("random must be a function");
  }

  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** retryIndex));
}

function validateRetryOptions(options: RetryOptions): {
  maxRetries: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  baseMs: number;
  capMs: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  onRetry: ((info: { attempt: number; delayMs: number; error: unknown }) => void) | undefined;
} {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const {
    maxRetries,
    shouldRetry,
    baseMs = 100,
    capMs = 1000,
    random = Math.random,
    sleep = defaultSleep,
    onRetry,
  } = options;

  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be an integer >= 0");
  }
  if (typeof shouldRetry !== "function") {
    throw new TypeError("shouldRetry must be a function");
  }
  if (typeof baseMs !== "number" || !Number.isFinite(baseMs) || baseMs <= 0) {
    throw new TypeError("baseMs must be a positive number");
  }
  if (typeof capMs !== "number" || !Number.isFinite(capMs) || capMs <= 0) {
    throw new TypeError("capMs must be a positive number");
  }
  if (typeof random !== "function") {
    throw new TypeError("random must be a function");
  }
  if (typeof sleep !== "function") {
    throw new TypeError("sleep must be a function");
  }
  if (onRetry !== undefined && typeof onRetry !== "function") {
    throw new TypeError("onRetry must be a function");
  }

  return {
    maxRetries,
    shouldRetry,
    baseMs,
    capMs,
    random,
    sleep,
    onRetry,
  };
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T> | T,
  options: RetryOptions
): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("fn must be a function");
  }

  const validated = validateRetryOptions(options);

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      if (attempt < validated.maxRetries && validated.shouldRetry(error, attempt)) {
        const delayMs = computeBackoffMs(attempt, {
          baseMs: validated.baseMs,
          capMs: validated.capMs,
          random: validated.random,
        });
        validated.onRetry?.({ attempt, delayMs, error });
        await validated.sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
}
