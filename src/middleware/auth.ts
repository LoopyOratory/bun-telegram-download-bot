import { env } from "../config";
import { logger } from "../utils/logger";
import { getUserByTelegramId } from "../db";
import type { Context, NextFunction } from "grammy";

/**
 * Auth middleware — runs on every message before the handler.
 *
 * Checks:
 * 1. Admin (OWNER_ID) bypasses all checks
 * 2. Banned users are silently ignored
 * 3. Private chat: must be in ALLOWED_USERS list
 * 4. Group chat: must be in ALLOWED_GROUPS list
 */
export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId) return;

  // Admin bypasses all checks
  if (userId === env.OWNER_ID) return await next();

  // Check if user is banned in DB
  const user = getUserByTelegramId(userId);
  if (user?.is_allowed === 0) {
    logger.warn({ userId }, "Blocked banned user");
    return; // silently ignore
  }

  // Private chat: check ALLOWED_USERS list
  if (ctx.chat?.type === "private") {
    if (!env.ALLOWED_USERS.includes(userId)) {
      return await ctx.reply("❌ You are not authorized to use this bot.");
    }
    return await next();
  }

  // Group chat: check ALLOWED_GROUPS list
  if (chatId && env.ALLOWED_GROUPS.includes(chatId)) return await next();

  return await ctx.reply("❌ This chat is not authorized.");
}
