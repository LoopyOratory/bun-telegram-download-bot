import pino from "pino";
import { env } from "../config";

/**
 * Build the pino logger configuration.
 *
 * In development (NODE_ENV=development), uses pino-pretty for readable output.
 * In production, uses plain JSON for structured logging (container/aggregator friendly).
 *
 * Falls back safely if pino-pretty isn't installed (e.g., production Docker image
 * where it's a devDependency and not bundled).
 */
function buildLoggerConfig(): pino.LoggerOptions {
  if (env.NODE_ENV === "development") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require.resolve("pino-pretty");
      return {
        level: env.LOG_LEVEL,
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
        redact: { paths: ["BOT_TOKEN"], censor: "***" },
      };
    } catch {
      // pino-pretty not installed — use plain JSON
    }
  }

  // Production or fallback: structured JSON logging
  return {
    level: env.LOG_LEVEL,
    redact: { paths: ["BOT_TOKEN"], censor: "***" },
  };
}

export const logger = pino(buildLoggerConfig());
