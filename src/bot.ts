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
 * Register bot commands with Telegram so they appear in the / menu.
 * Public commands show for all users; admin commands are scoped to OWNER_ID only.
 */
export async function setBotCommands(): Promise<void> {
  if (!bot) throw new Error("Bot not initialised — call createBot() first");

  // Public commands — visible to everyone
  const publicCommands = [
    { command: "menu", description: "📋 Interactive command menu" },
    { command: "start", description: "👋 Welcome message" },
    { command: "help", description: "📖 Supported platforms and usage" },
    { command: "about", description: "ℹ️ Bot info and tech stack" },
  ];

  // Admin commands — visible only to OWNER_ID
  const adminCommands = [
    { command: "panel", description: "👑 Admin command centre" },
    { command: "pulse", description: "💓 Bot health and uptime" },
    { command: "stats", description: "📊 Full bot statistics" },
    { command: "beat", description: "📡 Live activity feed" },
    { command: "top", description: "🏆 Top downloaders" },
    { command: "genre", description: "🎬 Platform breakdown" },
    { command: "roster", description: "👥 User list" },
    { command: "lookup", description: "🔍 Search for a user" },
    { command: "dossier", description: "📋 Full user deep dive" },
    { command: "quarantine", description: "🚫 Ban a user" },
    { command: "pardon", description: "✅ Unban a user" },
    { command: "lockup", description: "🔒 List banned users" },
    { command: "sweep", description: "🧹 Clean temp files" },
    { command: "log", description: "📋 View error logs" },
  ];

  // Register public commands (default scope = all users)
  await bot.api.setMyCommands(publicCommands);

  // Register admin commands scoped to owner only
  await bot.api.setMyCommands(adminCommands, {
    scope: { type: "chat", chat_id: env.OWNER_ID },
  });

  logger.info({ ownerId: env.OWNER_ID }, "Bot commands registered (public + admin-scoped)");
}

/**
 * Get the bot instance. Throws if not yet created.
 */
export function getBot(): Bot {
  if (!bot) throw new Error("Bot not initialised — call createBot() first");
  return bot;
}
