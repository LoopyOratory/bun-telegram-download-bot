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

  // 7. Start polling
  logger.info("Starting bot polling...");
  await bot.start({
    onStart: (botInfo) => {
      logger.info(
        {
          username: botInfo.username,
          id: botInfo.id,
        },
        `Bot @${botInfo.username} is online`,
      );
    },
    drop_pending_updates: true,
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
