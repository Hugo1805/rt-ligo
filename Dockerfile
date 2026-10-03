FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build bunx --bun prisma generate

FROM oven/bun:1
WORKDIR /app

COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/src ./src
COPY --from=builder --chown=bun:bun /app/prisma ./prisma
COPY --from=builder --chown=bun:bun /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=bun:bun /app/tools ./tools
COPY --from=builder --chown=bun:bun /app/package.json ./package.json

USER bun
EXPOSE 3000

CMD ["bun", "src/server.ts"]
