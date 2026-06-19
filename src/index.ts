import { GrammyError } from "grammy";
import { createBot, setBotCommands } from "./bot";
import { initDatabase } from "./db";
import { env } from "./config";
import { logger } from "./utils/logger";
import { registerGeneralHandlers } from "./handlers/general";
import { registerDownloadHandler } from "./handlers/download";
import { registerAdminHandlers } from "./handlers/admin";
import { cleanupOrphans, registerShutdownHandlers } from "./cleanup";
import { initProxyPool } from "./services/proxy";

/**
 * Application entry point.
 *
 * Initialises:
 * 1. Database (SQLite + migrations)
 * 2. Bot (grammy instance + middleware)
 * 3. Handlers (general, download, admin)
 * 4. Starts polling
 */
async function main(): Promise<void> {
  logger.info({ nodeEnv: env.NODE_ENV }, "Starting bun-video-bot");

  // 1. Clean up orphaned temp files from last run
  await cleanupOrphans();

  // 2. Init database
  initDatabase();
  logger.info("Database initialised");

  // 3. Init proxy pool (non-blocking — builds in background)
  initProxyPool();

  // 4. Create bot
  const bot = createBot();
  logger.info("Bot instance created");

  // 4. Register handlers (order matters — general first, then admin, then download catch-all)
  registerGeneralHandlers(bot);
  registerAdminHandlers(bot);
  registerDownloadHandler(bot);

  // 5. Register shutdown handlers
  registerShutdownHandlers();

  // 6. Register commands with Telegram (shows in / menu)
  await setBotCommands();

  // 7. Start polling with retry on 409 Conflict
  logger.info("Starting bot polling...");
  const MAX_START_RETRIES = 10;
  const START_RETRY_BASE_MS = 5_000; // 5s initial backoff
  for (let attempt = 0; ; attempt++) {
    try {
      await bot.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            `Bot @${botInfo.username} is online`,
          );
        },
        drop_pending_updates: true,
      });
      return; // started successfully
    } catch (err) {
      const is409 = err instanceof GrammyError && err.error_code === 409;
      if (!is409 || attempt >= MAX_START_RETRIES - 1) throw err;
      const delay = START_RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn(
        { attempt: attempt + 1, maxRetries: MAX_START_RETRIES, delayMs: delay },
        "409 Conflict detected — old container still polling. Retrying...",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
