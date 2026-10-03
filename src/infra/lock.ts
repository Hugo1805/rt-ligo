import crypto from "node:crypto";
import type { Logger } from "./logger";
import type { Redis } from "./redis";

export interface LockLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface AcquireLockOptions {
  ttlMs: number;
  logger: LockLogger | Logger;
}

export type AcquireOptions = AcquireLockOptions;

export type LockResult =
  | { status: "acquired"; release: () => Promise<void> }
  | { status: "busy" }
  | { status: "unavailable" };

export interface Lock {
  acquire(key: string, options: AcquireLockOptions): Promise<LockResult>;
}

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

export function createRedisLock(redis: Redis): Lock {
  return {
    async acquire(key: string, options: AcquireLockOptions): Promise<LockResult> {
      const { ttlMs, logger } = options;
      const ownerId = crypto.randomUUID();

      try {
        const result = await redis.set(key, ownerId, "PX", ttlMs, "NX");
        if (result === "OK") {
          let released = false;
          const release = async (): Promise<void> => {
            if (released) {
              return;
            }
            try {
              await redis.eval(RELEASE_SCRIPT, 1, key, ownerId);
              released = true;
            } catch (err) {
              logger.warn({ event: "lock.release_failed", key, err });
            }
          };

          return {
            status: "acquired",
            release,
          };
        }

        return {
          status: "busy",
        };
      } catch (err) {
        logger.warn({ event: "lock.unavailable", key, err });
        return {
          status: "unavailable",
        };
      }
    },
  };
}
