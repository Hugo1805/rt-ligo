import { Prisma } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/infra/prisma";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const prisma = createPrismaClient(databaseUrl);

const initialWallets = [
  { userId: "usr_abc123", currency: "PEN", balance: new Prisma.Decimal("250.00") },
  { userId: "usr_test_1", currency: "PEN", balance: new Prisma.Decimal("0.00") },
  { userId: "usr_test_2", currency: "PEN", balance: new Prisma.Decimal("0.00") },
];

async function main() {
  for (const wallet of initialWallets) {
    await prisma.wallet.upsert({
      where: { userId: wallet.userId },
      create: {
        userId: wallet.userId,
        currency: wallet.currency,
        balance: wallet.balance,
      },
      update: {},
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
