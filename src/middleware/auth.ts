import { env } from "../config";
import { logger } from "../utils/logger";
import { getUserByTelegramId } from "../db";
import type { Context, NextFunction } from "grammy";

/**
 * Auth middleware — runs on every message before the handler.
 *
 * Checks:
 * 1. Admin (OWNER_ID) bypasses all checks
 * 2. Banned users (is_allowed=0) are silently ignored
 * 3. Approved users in DB (is_allowed=1) pass through
 * 4. Private chat: must be in ALLOWED_USERS env list or DB-approved
 * 5. Group chat: must be in ALLOWED_GROUPS env list
 *
 * Users can be approved at runtime via /adduser (admin command),
 * which sets is_allowed=1 in the database.
 */
export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!userId) return;

  // Admin bypasses all checks
  if (userId === env.OWNER_ID) return await next();

  // Check if user exists in DB and their status
  const dbUser = getUserByTelegramId(userId);

  // Banned users — silently ignored
  if (dbUser?.is_allowed === 0) {
    logger.warn({ userId }, "Blocked banned user");
    return;
  }

  // Approved in DB — allow through regardless of env list
  if (dbUser?.is_allowed === 1) {
    return await next();
  }

  // Private chat: check env ALLOWED_USERS list (initial seed)
  if (ctx.chat?.type === "private") {
    if (!env.ALLOWED_USERS.includes(userId)) {
      return await ctx.reply("❌ You are not authorized to use this bot.");
    }
    return await next();
  }

  // Group chat: check env ALLOWED_GROUPS list
  if (chatId && env.ALLOWED_GROUPS.includes(chatId)) return await next();

  return await ctx.reply("❌ This chat is not authorized.");
}
