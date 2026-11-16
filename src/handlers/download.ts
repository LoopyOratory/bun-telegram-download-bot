import { GrammyError, InputFile, InlineKeyboard } from "grammy";
import { env } from "../config";
import { logger } from "../utils/logger";
import { validateUrlOrThrow, detectPlatform } from "../utils/url";
import { downloadVideo, listFormats } from "../services/downloader";
import { compressVideo } from "../services/compress";
import { shareFile } from "../services/sharebox";
import type { ShareResult } from "../services/sharebox";
import { tracker } from "../services/tracker";
import { cleanupFile } from "../cleanup";
import { buildCompactProgress, buildUploadProgress } from "../progress";
import { PROGRESS_UPDATE_THROTTLE_MS } from "../utils/limits";
import { DownloadError, DownloadErrorCode, type DownloadResult, type FormatInfo } from "../types";
import type { Bot, Context } from "grammy";

/**
 * In-memory map of last progress edit times (per chat).
 */
const lastEditTime = new Map<number, number>();

const SELECTION_TTL_MS = 10 * 60 * 1_000;
const pendingSelections = new Map<string, {
  url: string;
  chatId: number;
  formats: FormatInfo[];
  statusMsgId: number;
}>();

/**
 * Upload a downloaded file to the configured FileCodeBox and return the share
 * link + passcode. The link uses SHAREBOX_PUBLIC_URL so recipients can reach
 * it even when the bot talks to the box on an internal address. Files last
 * two hours and are never shown here below SHAREBOX_MIN_SIZE_MB.
 */
function shareViaBox(filePath: string, onChunk?: (done: number, total: number) => void): Promise<ShareResult> {
  return shareFile(filePath, {
    baseUrl: env.SHAREBOX_URL!,
    token: env.SHAREBOX_TOKEN,
    publicUrl: env.SHAREBOX_PUBLIC_URL,
    expireValue: 2,
    expireStyle: "hour",
    onChunk,
  });
}

/**
 * Read a file in chunks, reporting bytes read as they're streamed out.
 * Passed to `InputFile` so grammY uploads directly from disk while we get a
 * progress callback — Telegram's Bot API gives no upload progress of its
 * own, so this is the only way to show real feedback during the upload.
 */
async function* streamWithProgress(
  filePath: string,
  totalBytes: number,
  onProgress: (sentBytes: number) => void,
): AsyncIterable<Uint8Array> {
  const file = Bun.file(filePath);
  let sent = 0;
  for await (const chunk of file.stream()) {
    sent += chunk.byteLength;
    onProgress(sent);
    yield chunk;
  }
  if (totalBytes && sent !== totalBytes) {
    // Informational only — Bun's chunk sizes aren't guaranteed to sum
    // exactly to stat().size in every edge case, but this would flag a
    // truncated read.
    logger.debug({ filePath, sent, totalBytes }, "Stream byte count differs from file size");
  }
}

/**
 * Upload a video to Telegram while editing `statusMsgId` with live progress.
 */
async function sendVideoWithProgress(
  ctx: Context,
  chatId: number,
  statusMsgId: number,
  filePath: string,
  fileSize: number,
): Promise<void> {
  let lastEdit = 0;
  const fileName = filePath.split(/[/\\]/).pop() || "video.mp4";

  const input = new InputFile(
    streamWithProgress(filePath, fileSize, (sentBytes) => {
      const now = Date.now();
      if (now - lastEdit < PROGRESS_UPDATE_THROTTLE_MS) return;
      lastEdit = now;
      const percent = fileSize > 0 ? Math.min(100, (sentBytes / fileSize) * 100) : 0;
      ctx.api
        .editMessageText(chatId, statusMsgId, buildUploadProgress(percent, sentBytes, fileSize))
        .catch(() => {});
    }),
    fileName,
  );

  await ctx.api.sendVideo(chatId, input, { supports_streaming: true });
}

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
    const statusMsg = await ctx.reply("📥 Downloading (best quality)...");
    await doDownload(ctx, cleanedUrl, userId, chatId, statusMsg.message_id);
    return;
  }

  // Send "checking formats" message
  const statusMsg = await ctx.reply("🔍 Checking available resolutions...");

  // List available formats
  const formats = await listFormats(cleanedUrl);

  if (formats.length === 0) {
    // No format listing available — download immediately with best quality
    await ctx.api.editMessageText(chatId, statusMsg.message_id, "📥 Downloading (best quality)...");
    await doDownload(ctx, cleanedUrl, userId, chatId, statusMsg.message_id);
    return;
  }

  // Show resolution selection buttons
  const keyboard = new InlineKeyboard();
  const selectionId = crypto.randomUUID();
  pendingSelections.set(selectionId, { url: cleanedUrl, chatId, formats, statusMsgId: statusMsg.message_id });
  setTimeout(() => pendingSelections.delete(selectionId), SELECTION_TTL_MS).unref();
  for (const [index, format] of formats.entries()) {
    keyboard.text(format.resolution, `res:${selectionId}:${index}`).row();
  }
  keyboard.text("⚡ Best", `res:${selectionId}:best`);

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
  let uploadedPath: string | null = null;

  try {
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

    const sendShare = async (download: DownloadResult) => {
      await ctx.api.editMessageText(chatId, statusMsgId, "📦 Uploading to File Box…").catch(() => {});
      const share = await shareViaBox(download.filePath, (done, total) => {
        ctx.api.editMessageText(chatId, statusMsgId, `📦 Uploading to File Box… ${done}/${total}`).catch(() => {});
      });
      await ctx.api.editMessageText(
        chatId,
        statusMsgId,
        `📦 Download: ${share.link}\n🔑 Passcode: ${share.code}\n\nExpires in 2 hours.`,
      );
    };

    const compressAndSend = async (download: DownloadResult) => {
      await ctx.api.editMessageText(chatId, statusMsgId, "📦 Over Telegram's 50MB upload limit — compressing…").catch(() => {});
      uploadedPath = await compressVideo(download.filePath, `${download.filePath}.small.mp4`);
      await sendVideoWithProgress(ctx, chatId, statusMsgId, uploadedPath, Bun.file(uploadedPath).size);
    };

    const overInlineLimit = result.fileSize > 50 * 1024 * 1024;
    const useShareBox = env.SHAREBOX_URL &&
      (overInlineLimit || result.fileSize >= env.SHAREBOX_MIN_SIZE_MB * 1024 * 1024);
    let shared = false;

    if (useShareBox) {
      await sendShare(result);
      shared = true;
    } else if (overInlineLimit) {
      await compressAndSend(result);
    } else {
      try {
        await sendVideoWithProgress(ctx, chatId, statusMsgId, result.filePath, result.fileSize);
      } catch (err) {
        if (!(err instanceof GrammyError &&
          (err.error_code === 413 || (err.error_code === 400 && /file is too big/i.test(err.description))))) throw err;
        if (env.SHAREBOX_URL) {
          await sendShare(result);
          shared = true;
        } else {
          await compressAndSend(result);
        }
      }
    }

    if (!shared) await ctx.api.editMessageText(chatId, statusMsgId, "✅ Done!").catch(() => {});
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
    if (result) await cleanupFile(result.filePath);
    if (uploadedPath && uploadedPath !== result?.filePath) await cleanupFile(uploadedPath);
  }
}

/**
 * Handle resolution selection callback.
 * Called when user clicks a resolution button.
 */
export async function handleResolutionCallback(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData || !callbackData.startsWith("res:")) return;

  const [, selectionId, choice] = callbackData.split(":");
  const pending = pendingSelections.get(selectionId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "This selection is no longer available. Send the URL again." });
    return;
  }

  const { url, chatId, formats, statusMsgId } = pending;
  if (ctx.chat?.id !== chatId || ctx.callbackQuery?.message?.message_id !== statusMsgId) {
    await ctx.answerCallbackQuery();
    return;
  }

  const format = /^\d+$/.test(choice ?? "") ? formats[Number(choice)] : undefined;
  if (choice !== "best" && !format) {
    await ctx.answerCallbackQuery();
    return;
  }
  pendingSelections.delete(selectionId);
  await ctx.answerCallbackQuery().catch(() => {});

  await ctx.api.editMessageText(
    chatId,
    statusMsgId,
    `📥 Downloading (${format?.resolution ?? "best quality"})...`,
  );

  await doDownload(ctx, url, ctx.from!.id, chatId, statusMsgId, format?.code);
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
