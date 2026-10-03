import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  retry,
  type RetryOptions,
} from "../../../src/shared/retry";

describe("computeBackoffMs", () => {
  test("computes backoff with default baseMs (100) and capMs (1000) with fixed random", () => {
    const fixedRandom = () => 0.999;

    expect(computeBackoffMs(0, { random: fixedRandom })).toBe(99);
    expect(computeBackoffMs(1, { random: fixedRandom })).toBe(199);
    expect(computeBackoffMs(2, { random: fixedRandom })).toBe(399);
    expect(computeBackoffMs(3, { random: fixedRandom })).toBe(799);
    expect(computeBackoffMs(4, { random: fixedRandom })).toBe(999);
    expect(computeBackoffMs(5, { random: fixedRandom })).toBe(999);
    expect(computeBackoffMs(10, { random: fixedRandom })).toBe(999);
  });

  test("computes backoff with random = 0 returning 0 for all retry indices", () => {
    const zeroRandom = () => 0;

    expect(computeBackoffMs(0, { random: zeroRandom })).toBe(0);
    expect(computeBackoffMs(1, { random: zeroRandom })).toBe(0);
    expect(computeBackoffMs(2, { random: zeroRandom })).toBe(0);
    expect(computeBackoffMs(3, { random: zeroRandom })).toBe(0);
    expect(computeBackoffMs(4, { random: zeroRandom })).toBe(0);
    expect(computeBackoffMs(5, { random: zeroRandom })).toBe(0);
  });

  test("computes backoff with custom baseMs and capMs", () => {
    const fixedRandom = () => 0.5;

    // base 50, cap 300
    // retry 0: 50 * 2^0 = 50 -> 0.5 * 50 = 25
    expect(computeBackoffMs(0, { baseMs: 50, capMs: 300, random: fixedRandom })).toBe(25);
    // retry 1: 50 * 2^1 = 100 -> 0.5 * 100 = 50
    expect(computeBackoffMs(1, { baseMs: 50, capMs: 300, random: fixedRandom })).toBe(50);
    // retry 2: 50 * 2^2 = 200 -> 0.5 * 200 = 100
    expect(computeBackoffMs(2, { baseMs: 50, capMs: 300, random: fixedRandom })).toBe(100);
    // retry 3: 50 * 2^3 = 400 -> min(300, 400) = 300 -> 0.5 * 300 = 150
    expect(computeBackoffMs(3, { baseMs: 50, capMs: 300, random: fixedRandom })).toBe(150);
  });

  test("validates retryIndex is an integer >= 0", () => {
    expect(() => computeBackoffMs(-1)).toThrow(TypeError);
    expect(() => computeBackoffMs(1.5)).toThrow(TypeError);
    expect(() => computeBackoffMs(NaN)).toThrow(TypeError);
    // @ts-expect-error retryIndex must be a number
    expect(() => computeBackoffMs("0")).toThrow(TypeError);
  });

  test("validates baseMs and capMs are positive numbers", () => {
    expect(() => computeBackoffMs(0, { baseMs: 0 })).toThrow(TypeError);
    expect(() => computeBackoffMs(0, { baseMs: -10 })).toThrow(TypeError);
    expect(() => computeBackoffMs(0, { capMs: 0 })).toThrow(TypeError);
    expect(() => computeBackoffMs(0, { capMs: -100 })).toThrow(TypeError);
    // @ts-expect-error random must be a function
    expect(() => computeBackoffMs(0, { random: 123 })).toThrow(TypeError);
  });
});

describe("retry", () => {
  test("retry without shouldRetry does not compile (verified via @ts-expect-error)", async () => {
    // @ts-expect-error shouldRetry is required in RetryOptions
    const badOptions: RetryOptions = {
      maxRetries: 2,
    };

    expect(() =>
      retry(() => Promise.resolve("ok"), badOptions)
    ).toThrow(TypeError);
  });

  test("success on first attempt: one call, zero delays", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await retry(
      async (attempt) => {
        calls++;
        return `success-${attempt}`;
      },
      {
        maxRetries: 2,
        shouldRetry: () => true,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(result).toBe("success-0");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  test("fails twice and then succeeds with maxRetries: 2: three calls and returns the value", async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await retry(
      async (attempt) => {
        calls++;
        if (attempt < 2) {
          throw new Error(`transient-${attempt}`);
        }
        return "recovered";
      },
      {
        maxRetries: 2,
        shouldRetry: () => true,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );

    expect(result).toBe("recovered");
    expect(calls).toBe(3);
    expect(delays.length).toBe(2);
  });

  test("fails always with maxRetries: 2: three calls and rethrows the last error, exact same instance", async () => {
    let calls = 0;
    const delays: number[] = [];
    const error3 = new Error("third-failure");

    let thrownError: unknown;
    try {
      await retry(
        async (attempt) => {
          calls++;
          if (attempt === 0) throw new Error("first-failure");
          if (attempt === 1) throw new Error("second-failure");
          throw error3;
        },
        {
          maxRetries: 2,
          shouldRetry: () => true,
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(calls).toBe(3);
    expect(thrownError).toBe(error3);
    expect(delays.length).toBe(2);
  });

  test("shouldRetry returns false: single call and rethrows immediately without sleeping", async () => {
    let calls = 0;
    const delays: number[] = [];
    const businessError = new Error("business_declined");

    let thrownError: unknown;
    try {
      await retry(
        async () => {
          calls++;
          throw businessError;
        },
        {
          maxRetries: 3,
          shouldRetry: (err) => err !== businessError,
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch (err) {
      thrownError = err;
    }

    expect(calls).toBe(1);
    expect(thrownError).toBe(businessError);
    expect(delays).toEqual([]);
  });

  test("delays follow random() * min(cap, base * 2^n) with random = () => 0.999", async () => {
    const delays: number[] = [];

    try {
      await retry(
        async () => {
          throw new Error("retryable-error");
        },
        {
          maxRetries: 6,
          baseMs: 100,
          capMs: 1000,
          random: () => 0.999,
          shouldRetry: () => true,
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch {
      // expected
    }

    // 6 retries -> 6 sleeps
    expect(delays).toEqual([99, 199, 399, 799, 999, 999]);
  });

  test("delays are all 0 when random = () => 0", async () => {
    const delays: number[] = [];

    try {
      await retry(
        async () => {
          throw new Error("retryable-error");
        },
        {
          maxRetries: 6,
          baseMs: 100,
          capMs: 1000,
          random: () => 0,
          shouldRetry: () => true,
          sleep: async (ms) => {
            delays.push(ms);
          },
        }
      );
    } catch {
      // expected
    }

    expect(delays).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("fn receives the attempt number starting at 0", async () => {
    const receivedAttempts: number[] = [];

    try {
      await retry(
        async (attempt) => {
          receivedAttempts.push(attempt);
          throw new Error(`err-${attempt}`);
        },
        {
          maxRetries: 3,
          shouldRetry: () => true,
          sleep: async () => {},
        }
      );
    } catch {
      // expected
    }

    expect(receivedAttempts).toEqual([0, 1, 2, 3]);
  });

  test("shouldRetry receives the error and current attempt number", async () => {
    const shouldRetryCalls: { errorMsg: string; attempt: number }[] = [];

    try {
      await retry(
        async (attempt) => {
          throw new Error(`fail-${attempt}`);
        },
        {
          maxRetries: 2,
          shouldRetry: (err, attempt) => {
            shouldRetryCalls.push({
              errorMsg: (err as Error).message,
              attempt,
            });
            return true;
          },
          sleep: async () => {},
        }
      );
    } catch {
      // expected
    }

    expect(shouldRetryCalls).toEqual([
      { errorMsg: "fail-0", attempt: 0 },
      { errorMsg: "fail-1", attempt: 1 },
    ]);
  });

  test("onRetry is called with attempt, delayMs, and error for each retry", async () => {
    const retryLogs: { attempt: number; delayMs: number; errorMsg: string }[] = [];
    const delays: number[] = [];

    try {
      await retry(
        async (attempt) => {
          throw new Error(`err-${attempt}`);
        },
        {
          maxRetries: 2,
          baseMs: 100,
          capMs: 1000,
          random: () => 0.999,
          shouldRetry: () => true,
          sleep: async (ms) => {
            delays.push(ms);
          },
          onRetry: (info) => {
            retryLogs.push({
              attempt: info.attempt,
              delayMs: info.delayMs,
              errorMsg: (info.error as Error).message,
            });
          },
        }
      );
    } catch {
      // expected
    }

    expect(retryLogs).toEqual([
      { attempt: 0, delayMs: 99, errorMsg: "err-0" },
      { attempt: 1, delayMs: 199, errorMsg: "err-1" },
    ]);
    expect(delays).toEqual([99, 199]);
  });

  test("no sleep occurs after the final failed attempt", async () => {
    let sleepCount = 0;
    let fnCallCount = 0;

    try {
      await retry(
        async () => {
          fnCallCount++;
          throw new Error("fatal");
        },
        {
          maxRetries: 1,
          shouldRetry: () => true,
          sleep: async () => {
            sleepCount++;
          },
        }
      );
    } catch {
      // expected
    }

    expect(fnCallCount).toBe(2); // 1 initial + 1 retry
    expect(sleepCount).toBe(1); // 1 sleep before the 1 retry, 0 sleep after final attempt
  });

  test("maxRetries: -1 throws TypeError without calling fn", async () => {
    let fnCalled = false;

    expect(() =>
      retry(
        () => {
          fnCalled = true;
          return Promise.resolve("ok");
        },
        {
          maxRetries: -1,
          shouldRetry: () => true,
        }
      )
    ).toThrow(TypeError);

    expect(fnCalled).toBe(false);
  });

  test("validates options before calling fn", async () => {
    let fnCalled = false;
    const testFn = () => {
      fnCalled = true;
      return Promise.resolve("ok");
    };

    // Non-integer maxRetries
    expect(() =>
      retry(testFn, { maxRetries: 2.5, shouldRetry: () => true })
    ).toThrow(TypeError);

    // Negative or zero baseMs
    expect(() =>
      retry(testFn, { maxRetries: 1, baseMs: 0, shouldRetry: () => true })
    ).toThrow(TypeError);
    expect(() =>
      retry(testFn, { maxRetries: 1, baseMs: -10, shouldRetry: () => true })
    ).toThrow(TypeError);

    // Negative or zero capMs
    expect(() =>
      retry(testFn, { maxRetries: 1, capMs: 0, shouldRetry: () => true })
    ).toThrow(TypeError);
    expect(() =>
      retry(testFn, { maxRetries: 1, capMs: -50, shouldRetry: () => true })
    ).toThrow(TypeError);

    // Invalid random or sleep
    // @ts-expect-error random must be a function
    expect(() => retry(testFn, { maxRetries: 1, random: "bad", shouldRetry: () => true })).toThrow(TypeError);
    // @ts-expect-error sleep must be a function
    expect(() => retry(testFn, { maxRetries: 1, sleep: 123, shouldRetry: () => true })).toThrow(TypeError);
    // @ts-expect-error onRetry must be a function
    expect(() => retry(testFn, { maxRetries: 1, onRetry: "not-a-fn", shouldRetry: () => true })).toThrow(TypeError);

    // Invalid fn
    // @ts-expect-error fn must be a function
    expect(() => retry("not-a-fn", { maxRetries: 1, shouldRetry: () => true })).toThrow(TypeError);

    expect(fnCalled).toBe(false);
  });

  test("works with synchronous functions returning values directly", async () => {
    let calls = 0;
    const result = await retry(
      (attempt) => {
        calls++;
        if (attempt === 0) {
          throw new Error("sync-failure");
        }
        return "sync-success";
      },
      {
        maxRetries: 1,
        shouldRetry: () => true,
        sleep: async () => {},
      }
    );

    expect(result).toBe("sync-success");
    expect(calls).toBe(2);
  });

  test("uses default sleep and random when not explicitly provided", async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new Error("transient");
        }
        return "done";
      },
      {
        maxRetries: 1,
        baseMs: 1,
        capMs: 2,
        shouldRetry: () => true,
      }
    );

    expect(result).toBe("done");
    expect(calls).toBe(2);
  });
});
