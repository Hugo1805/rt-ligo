import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

// pg waits forever for a connection by default, so an unreachable database
// would hang each request until the OS TCP timeout instead of failing fast.
const CONNECTION_TIMEOUT_MS = 2000;

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  return new PrismaClient({ adapter });
}

export type { PrismaClient } from "../generated/prisma/client";
