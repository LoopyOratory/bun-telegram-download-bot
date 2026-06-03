import type { Bot, Context } from "grammy";

/**
 * Register general (public) handlers: /start, /help, /about.
 */

function getStartMessage(ctx: Context): string {
  const firstName = ctx.from?.first_name || "there";
  return [
    `👋 Hello, ${firstName}!`,
    "",
    "I'm a Telegram video downloader bot.",
    "Send me a video URL and I'll download and send it back to you.",
    "",
    "**Supported platforms:**",
    "• YouTube",
    "• Twitter / X",
    "• TikTok (no watermark)",
    "• Instagram",
    "• Snapchat Spotlight",
    "• 1000+ more (powered by yt-dlp)",
    "",
    "Type /help to learn more.",
    "Type /about for bot info.",
  ].join("\n");
}

const HELP_MESSAGE = [
  "📖 **How to use**",
  "",
  "Send any video URL as a message and I'll download it for you.",
  "",
  "**Examples:**",
  "  `https://www.youtube.com/watch?v=...`",
  "  `https://twitter.com/...`",
  "  `https://www.tiktok.com/...`",
  "  `https://www.instagram.com/...`",
  "",
  "**Supported platforms:**",
  "✅ YouTube",
  "✅ Twitter / X",
  "✅ TikTok (no watermark)",
  "✅ Instagram",
  "✅ Snapchat Spotlight",
  "✅ 1000+ more (yt-dlp)",
  "",
  "**Limits:**",
  "• Max file size: 50 MB (configurable)",
  "• 1 download at a time per user",
  "• 10s cooldown between downloads",
  "",
  "**No watermarks.** No re-encoding. No stored files.",
  "Your privacy is respected — files are deleted immediately after sending.",
].join("\n");

const ABOUT_MESSAGE = [
  "ℹ️ **About this bot**",
  "",
  "Hermes Video Downloader Bot",
  "Version 1.0.0",
  "",
  "Built with:",
  "• Bun runtime",
  "• grammY bot framework",
  "• yt-dlp download engine",
  "• FFmpeg media processing",
  "• SQLite database",
  "",
  "**Key features:**",
  "• Download from 1000+ platforms",
  "• No watermarks — enforced on TikTok",
  "• No files persist after delivery",
  "• Authorized access only",
  "• Full admin dashboard",
  "",
  "Source: github.com/hermes/bun-video-bot",
].join("\n");

export function registerGeneralHandlers(bot: Bot): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(getStartMessage(ctx), { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_MESSAGE, { parse_mode: "Markdown" });
  });

  bot.command("about", async (ctx) => {
    await ctx.reply(ABOUT_MESSAGE, { parse_mode: "Markdown" });
  });
}
