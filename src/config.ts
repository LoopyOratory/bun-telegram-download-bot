import { z } from "zod";

/**
 * Zod schema for environment configuration.
 * Validated at startup — invalid config crashes with a clear message.
 */
export const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),

  OWNER_ID: z.coerce.number().int().positive(),

  ALLOWED_USERS: z
    .string()
    .default("")
    .transform((s) =>
      s ? s.split(",").map((n) => n.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n)) : [],
    ),

  ALLOWED_GROUPS: z
    .string()
    .default("")
    .transform((s) =>
      s ? s.split(",").map((n) => n.trim()).filter(Boolean).map(Number).filter((n) => !isNaN(n)) : [],
    ),

  TEMP_DIR: z.string().default("/tmp/bun-video-bot"),
  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(50),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_PATH: z.string().default("./data/bot.db"),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PROXY_URL: z.string().optional(),

  PROXY_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  TOR_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
});

/** Parsed environment configuration — fails fast at startup if invalid */
export const env = envSchema.parse(process.env);

/** Type of the parsed environment */
export type Env = z.infer<typeof envSchema>;
