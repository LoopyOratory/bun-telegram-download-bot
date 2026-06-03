import { InputFile, InlineKeyboard } from "grammy";
import { env } from "../config";
import { logger } from "../utils/logger";
import { validateUrlOrThrow, detectPlatform } from "../utils/url";
import { downloadVideo, listFormats } from "../services/downloader";
import { tracker } from "../services/tracker";
import { cleanupFile } from "../cleanup";
import { buildCompactProgress } from "../progress";
import { PROGRESS_UPDATE_THROTTLE_MS } from "../utils/limits";
import { DownloadError, DownloadErrorCode, type DownloadResult, type FormatInfo } from "../types";
import type { Bot, Context } from "grammy";

/**
 * In-memory map of last progress edit times (per chat).
 */
const lastEditTime = new Map<number, number>();

/**
 * In-memory store of pending format selections: callback data → { url, chatId, formats }
 * Keyed by a random ID passed in the callback data.
 */
const pendingSelections = new Map<string, { url: string; chatId: number; formats: FormatInfo[]; statusMsgId: number }>();

/**
 * Handle an incoming video URL.
 * Extracts URL from text, lists formats for YouTube, falls back on short-form platforms.
 */
export async function handleDownload(ctx: Context): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const userId = ctx.from!.id;
  const chatId = ctx.chat!.id;

  // Extract URL from the message (may contain surrounding text)
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return; // No URL found — not a download request

  const rawUrl = urlMatch[0];

  // Validate URL
  let cleanedUrl: string;
  try {
    cleanedUrl = validateUrlOrThrow(rawUrl);
  } catch (err) {
    const downloadErr = err as DownloadError;
    await ctx.reply(`❌ ${downloadErr.message}`);
    return;
  }

  const platform = detectPlatform(cleanedUrl);

  // Short-form platforms (TikTok, Instagram, Snapchat) — skip format listing,
  // download immediately. Their -F often fails and they have limited resolutions anyway.
  if (platform === "tiktok" || platform === "instagram" || platform === "snapchat") {
    const statusMsg = await ctx.reply("⏬ Downloading (best quality)...");
    await doDownload(ctx, cleanedUrl, userId, chatId, statusMsg.message_id);
    return;
  }

  // Send "checking formats" message
  const statusMsg = await ctx.reply("🔍 Checking available resolutions...");

  // List available formats
  const formats = await listFormats(cleanedUrl);

  if (formats.length === 0) {
    // No format listing available — download immediately with best quality
    await ctx.api.editMessageText(chatId, statusMsg.message_id, "⏬ Downloading (best quality)...");
    await doDownload(ctx, cleanedUrl, userId, chatId, statusMsg.message_id);
    return;
  }

  // Show resolution selection buttons
  const keyboard = new InlineKeyboard();
  for (const fmt of formats) {
    const selectionId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    pendingSelections.set(selectionId, {
      url: cleanedUrl,
      chatId,
      formats,
      statusMsgId: statusMsg.message_id,
    });
    keyboard.text(fmt.resolution, `res:${selectionId}:${fmt.code}`).row();
  }
  // Add a "Best" button
  const bestId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  pendingSelections.set(bestId, {
    url: cleanedUrl,
    chatId,
    formats,
    statusMsgId: statusMsg.message_id,
  });
  keyboard.text("⚡ Best", `res:${bestId}:best`);

  await ctx.api.editMessageText(
    chatId,
    statusMsg.message_id,
    `🎬 Select resolution for:\n${cleanedUrl.slice(0, 60)}${cleanedUrl.length > 60 ? "..." : ""}`,
    { reply_markup: keyboard },
  );
}

/**
 * Perform the actual download, send, and cleanup.
 */
async function doDownload(
  ctx: Context,
  cleanedUrl: string,
  userId: number,
  chatId: number,
  statusMsgId: number,
  formatCode?: string,
): Promise<void> {
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
            .editMessageText(chatId, statusMsgId, buildCompactProgress(progress))
            .catch(() => {});
        }
      },
      0,
      formatCode,
    );

    await ctx.api.editMessageText(chatId, statusMsgId, "✅ Processing...");
    await ctx.api.sendVideo(chatId, new InputFile(result.filePath), {
      supports_streaming: true,
    });

    await ctx.api.editMessageText(chatId, statusMsgId, "✅ Downloaded!");
    await tracker.trackComplete(downloadId, result.fileSize, result.format, userId);
  } catch (err) {
    const downloadErr =
      err instanceof DownloadError
        ? err
        : new DownloadError(DownloadErrorCode.UNKNOWN, (err as Error).message || "Unknown error");

    logger.error(
      { userId, url: cleanedUrl.slice(0, 100), errorCode: downloadErr.code, error: downloadErr.message },
      "Download handler error",
    );

    await tracker.trackError(downloadId, downloadErr);

    try {
      await ctx.api.editMessageText(chatId, statusMsgId, `❌ ${downloadErr.message}`);
    } catch {
      await ctx.reply(`❌ ${downloadErr.message}`).catch(() => {});
    }
  } finally {
    lastEditTime.delete(chatId);
    if (result) {
      await cleanupFile(result.filePath);
    }
  }
}

/**
 * Handle resolution selection callback.
 * Called when user clicks a resolution button.
 */
export async function handleResolutionCallback(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData || !callbackData.startsWith("res:")) return;

  await ctx.answerCallbackQuery();

  const parts = callbackData.split(":");
  if (parts.length < 3) return;

  const selectionId = parts[1];
  const formatCode = parts[2];

  const pending = pendingSelections.get(selectionId);
  if (!pending) {
    await ctx.editMessageText("⌛ This selection has expired. Please send the URL again.");
    return;
  }

  const { url, chatId, statusMsgId } = pending;

  // Clean up pending selection
  pendingSelections.delete(selectionId);

  // Remove the keyboard from the selection message
  await ctx.api.editMessageText(
    chatId,
    statusMsgId,
    `⏬ Downloading (${formatCode === "best" ? "best quality" : formatCode})...`,
  );

  // Clone context-like behaviour — use the chatId from the pending selection
  await doDownload(ctx, url, ctx.from!.id, chatId, statusMsgId, formatCode === "best" ? undefined : formatCode);
}

/**
 * Register download handler with the bot.
 */
export function registerDownloadHandler(bot: Bot): void {
  bot.on(":text", async (ctx) => {
    const text = ctx.message?.text?.trim();
    if (!text) return;

    if (/https?:\/\//i.test(text)) {
      await handleDownload(ctx);
    }
  });

  // Register callback handler for resolution buttons
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith("res:")) {
      await handleResolutionCallback(ctx);
    }
  });
}
