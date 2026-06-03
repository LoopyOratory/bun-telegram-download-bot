import { logger } from "../utils/logger";
import {
  MAX_CONCURRENT_PER_USER,
  DOWNLOAD_COOLDOWN_MS,
} from "../utils/limits";
import type { Context, NextFunction } from "grammy";

/**
 * In-memory rate limiter state.
 * Rate limits reset on bot restart — acceptable for single-container deployment.
 */
const concurrentDownloads = new Map<number, number>();
const lastDownloadTime = new Map<number, number>();

/**
 * Rate limit middleware.
 *
 * - Max 1 concurrent download per user
 * - 10s cooldown between downloads per user
 */
export async function ratelimitMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return await next();

  // Only apply to text messages that look like URLs
  const text = ctx.message?.text;
  if (!text || !/^https?:\/\//i.test(text)) return await next();

  // Check concurrent limit
  const current = concurrentDownloads.get(userId) || 0;
  if (current >= MAX_CONCURRENT_PER_USER) {
    logger.warn({ userId }, "Rate limit hit — concurrent downloads maxed");
    await ctx.reply("⏳ You already have a download in progress. Please wait.");
    return;
  }

  // Check cooldown
  const lastTime = lastDownloadTime.get(userId) || 0;
  const elapsed = Date.now() - lastTime;
  if (elapsed < DOWNLOAD_COOLDOWN_MS) {
    const remaining = Math.ceil((DOWNLOAD_COOLDOWN_MS - elapsed) / 1000);
    logger.warn({ userId, remaining }, "Rate limit hit — cooldown active");
    await ctx.reply(`⏳ Please wait ${remaining}s before your next download.`);
    return;
  }

  // Track
  concurrentDownloads.set(userId, current + 1);

  try {
    await next();
  } finally {
    // Decrement concurrent count
    const remaining = (concurrentDownloads.get(userId) || 1) - 1;
    if (remaining <= 0) {
      concurrentDownloads.delete(userId);
    } else {
      concurrentDownloads.set(userId, remaining);
    }
    lastDownloadTime.set(userId, Date.now());
  }
}

/**
 * Release a concurrent download slot (call on completion/error).
 */
export function releaseConcurrentSlot(userId: number): void {
  const current = concurrentDownloads.get(userId) || 0;
  if (current <= 1) {
    concurrentDownloads.delete(userId);
  } else {
    concurrentDownloads.set(userId, current - 1);
  }
}
