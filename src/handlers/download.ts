import { InputFile } from "grammy";
import { env } from "../config";
import { logger } from "../utils/logger";
import { validateUrlOrThrow, detectPlatform } from "../utils/url";
import { downloadVideo } from "../services/downloader";
import { tracker } from "../services/tracker";
import { cleanupFile } from "../cleanup";
import { buildCompactProgress } from "../progress";
import { PROGRESS_UPDATE_THROTTLE_MS } from "../utils/limits";
import { DownloadError, DownloadErrorCode, type DownloadResult } from "../types";
import type { Context } from "grammy";

/**
 * In-memory map of last progress edit times (per chat).
 */
const lastEditTime = new Map<number, number>();

/**
 * Handle an incoming video URL.
 * Validates, downloads, sends, and cleans up.
 *
 * Follows AGENT.md lifecycle:
 *   1. yt-dlp writes file to TEMP_DIR
 *   2. Bot reads + sends via sendVideo
 *   3. IMMEDIATELY after sendVideo resolves → unlink
 *   4. File is gone. Only DB record remains.
 */
export async function handleDownload(ctx: Context): Promise<void> {
  const url = ctx.message?.text?.trim();
  if (!url) return;

  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  // Validate URL
  let cleanedUrl: string;
  try {
    cleanedUrl = validateUrlOrThrow(url);
  } catch (err) {
    const downloadErr = err as DownloadError;
    await ctx.reply(`❌ ${downloadErr.message}`);
    return;
  }

  // Send initial "starting" message
  const statusMsg = await ctx.reply("⏬ Starting download...");

  // Track start
  const downloadId = await tracker.trackStart(
    userId,
    chatId,
    cleanedUrl,
    ctx.from?.username,
    ctx.from?.first_name,
    ctx.from?.last_name,
  );

  let result: DownloadResult | null = null;

  try {
    const platform = detectPlatform(cleanedUrl);

    // Download with progress
    result = await downloadVideo(
      cleanedUrl,
      env.TEMP_DIR,
      (progress) => {
        const now = Date.now();
        const lastEdit = lastEditTime.get(chatId) || 0;
        if (now - lastEdit >= PROGRESS_UPDATE_THROTTLE_MS) {
          lastEditTime.set(chatId, now);
          ctx.api
            .editMessageText(
              chatId,
              statusMsg.message_id,
              buildCompactProgress(progress),
            )
            .catch(() => {});
        }
      },
    );

    // Update status
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `✅ Processing...`,
    );

    // Send the video file
    const fileExists = await Bun.file(result.filePath).exists();
    if (!fileExists) {
      throw new DownloadError(
        DownloadErrorCode.UNKNOWN,
        "File disappeared before sending",
        platform,
      );
    }

    await ctx.api.sendVideo(chatId, new InputFile(result.filePath), {
      supports_streaming: true,
      caption: sanitizeCaption(ctx.message?.text || ""),
    });

    // Mark as completed
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      "✅ Downloaded!",
    );

    // Track completion (AFTER the file is sent but BEFORE cleanup)
    await tracker.trackComplete(
      downloadId,
      result.fileSize,
      result.format,
      userId,
    );
  } catch (err) {
    const downloadErr =
      err instanceof DownloadError
        ? err
        : new DownloadError(
            DownloadErrorCode.UNKNOWN,
            (err as Error).message || "Unknown error",
          );

    logger.error(
      {
        userId,
        url: cleanedUrl.slice(0, 100),
        errorCode: downloadErr.code,
        error: downloadErr.message,
      },
      "Download handler error",
    );

    // Track failure
    await tracker.trackError(downloadId, downloadErr);

    // Notify user
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ ${downloadErr.message}`,
      );
    } catch {
      await ctx.reply(`❌ ${downloadErr.message}`).catch(() => {});
    }
  } finally {
    lastEditTime.delete(chatId);

    // ALWAYS delete the file — success or failure. Non-negotiable per AGENT.md.
    if (result) {
      await cleanupFile(result.filePath);
    }
  }
}

/**
 * Sanitize caption text for the sendVideo call.
 */
function sanitizeCaption(text: string): string {
  // Remove the URL from caption (Telegram already shows the URL in the video card)
  return text.replace(/https?:\/\/\S+/g, "").trim() || (undefined as unknown as string);
}

/**
 * Register download handler with the bot.
 */
export function registerDownloadHandler(bot: import("grammy").Bot): void {
  bot.on(":text", async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    // Only handle messages that start with a URL
    if (/^https?:\/\//i.test(text)) {
      await handleDownload(ctx);
    }
  });
}
