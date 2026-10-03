import pino, {
  type DestinationStream,
  type LevelWithSilentOrString,
  type Logger,
} from "pino";

export interface CreateLoggerOptions {
  level?: LevelWithSilentOrString | undefined;
  podId?: string | undefined;
}

export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: DestinationStream
): Logger {
  const { level = "info", podId } = options;

  return pino(
    {
      level,
      ...(podId !== undefined ? { base: { pod_id: podId } } : {}),
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination
  );
}

export type { Logger };
