import Redis, { type RedisOptions } from "ioredis";

export interface CreateRedisClientOptions extends RedisOptions {}

export function createRedisClient(
  url: string,
  options: RedisOptions = {}
): Redis {
  const client = new Redis(url, {
    connectTimeout: 1000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => Math.min(times * 50, 1000),
    ...(options as Record<string, unknown>),
  });

  // Attach a noop error listener to prevent uncaughtException crash
  // when Redis becomes temporarily unavailable. Individual operations
  // will still reject and be handled by the caller or health check.
  client.on("error", () => {});

  return client;
}

export type { Redis, RedisOptions };
