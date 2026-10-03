import pino from "pino";
import { createMockPspApp } from "./app";
import { loadMockConfig } from "./config";

const config = loadMockConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
});

const app = createMockPspApp({ config, logger });

export const server = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
});

logger.info({ port: config.PORT }, `mock-psp started on port ${config.PORT}`);

let isShuttingDown = false;

export async function shutdown(signal: string = "SIGTERM"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Shutting down mock-psp gracefully...");

  try {
    await server.stop();
  } catch (err) {
    logger.error({ err }, "Error stopping mock-psp server");
  }

  logger.info("Graceful shutdown complete");
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => {
    process.exit(0);
  });
});
