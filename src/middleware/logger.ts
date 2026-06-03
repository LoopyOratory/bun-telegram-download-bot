import { logger } from "../utils/logger";
import type { Context, NextFunction } from "grammy";

/**
 * Request logging middleware — logs every incoming message.
 */
export async function loggerMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const start = performance.now();
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text || ctx.message?.caption || "(no text)";

  await next();

  const ms = (performance.now() - start).toFixed(1);
  logger.info({ userId, chatId, text: text.slice(0, 100), duration: `${ms}ms` }, "Request handled");
}
