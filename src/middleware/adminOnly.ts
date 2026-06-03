import { env } from "../config";
import { logger } from "../utils/logger";
import type { Context } from "grammy";

/**
 * Check if the sender is the bot admin (OWNER_ID from .env).
 */
export function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === env.OWNER_ID;
}

/**
 * Guard for admin-only handlers.
 * Returns true if authorized, false + sends rejection if not.
 *
 * Every admin handler starts with: if (!await requireAdmin(ctx)) return
 */
export async function requireAdmin(ctx: Context): Promise<boolean> {
  if (isAdmin(ctx)) return true;

  logger.warn(
    {
      userId: ctx.from?.id,
      command: ctx.message?.text,
    },
    "Unauthorized admin command attempt",
  );

  await ctx.reply("⛔ This command is restricted to the bot administrator.");
  return false;
}
