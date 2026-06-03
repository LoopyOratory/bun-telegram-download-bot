import { Bot, GrammyError, HttpError } from "grammy";
import { env } from "./config";
import { logger } from "./utils/logger";
import { authMiddleware } from "./middleware/auth";
import { loggerMiddleware } from "./middleware/logger";
import { ratelimitMiddleware } from "./middleware/ratelimit";

let bot: Bot;

/**
 * Create and configure the grammy Bot instance with middleware.
 */
export function createBot(): Bot {
  bot = new Bot(env.BOT_TOKEN);

  // Register middleware (order matters!)
  bot.use(loggerMiddleware);
  bot.use(authMiddleware);
  bot.use(ratelimitMiddleware);

  // Error handler
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error(
      {
        err: err.error,
        userId: ctx.from?.id,
        chatId: ctx.chat?.id,
        updateId: ctx.update.update_id,
      },
      "Bot error caught",
    );

    // Notify user on GrammyError / HttpError
    if (err.error instanceof GrammyError || err.error instanceof HttpError) {
      ctx.reply("⚠️ An internal error occurred. Please try again later.").catch(() => {});
    }
  });

  return bot;
}

/**
 * Get the bot instance. Throws if not yet created.
 */
export function getBot(): Bot {
  if (!bot) throw new Error("Bot not initialised — call createBot() first");
  return bot;
}
