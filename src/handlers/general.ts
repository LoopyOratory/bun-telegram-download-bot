import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { env } from "../config";
import { adminService } from "../services/admin";

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
    "Type /menu to see all commands.",
    "Type /help to learn more.",
  ].join("\n");
}

const HELP_MESSAGE = [
  "📖 **How to use**",
  "",
  "Send any video URL as a message and I'll download it for you.",
  "Now with **resolution selection** — choose 1080p, 720p, 480p, or Best.",
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
  "Ekow Video Downloader Bot",
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
  "• Resolution selection (up to 1080p)",
  "• No watermarks — enforced on TikTok",
  "• No files persist after delivery",
  "• Authorized access only",
  "• Full admin dashboard",
  "",
  "Source: github.com/LoopyOratory/bun-telegram-download-bot",
].join("\n");

/**
 * Build the interactive menu keyboard.
 * Admin sees all commands; regular users see only public commands.
 */
function buildMenuKeyboard(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Public — everyone sees these
  kb.text("📹 Download Video", "menu:download_info").row();
  kb.text("👋 /start", "menu:start")
    .text("📖 /help", "menu:help")
    .text("ℹ️ /about", "menu:about").row();

  // Admin-only section
  if (isAdmin) {
    kb.text("📊 /pulse", "menu:pulse")
      .text("📊 /stats", "menu:stats")
      .text("📡 /beat", "menu:beat").row();

    kb.text("🏆 /top", "menu:top")
      .text("🎬 /genre", "menu:genre").row();

    kb.text("👥 /roster", "menu:roster")
      .text("🔍 /lookup", "menu:lookup")
      .text("📋 /dossier", "menu:dossier").row();

    kb.text("🚫 /quarantine", "menu:quarantine")
      .text("✅ /pardon", "menu:pardon")
      .text("🔒 /lockup", "menu:lockup").row();

    kb.text("➕ /adduser", "menu:adduser").row();

    kb.text("🧹 /sweep", "menu:sweep")
      .text("📋 /log", "menu:log").row();
  }

  return kb;
}

/**
 * Handle menu button callbacks — execute the corresponding command.
 * Admin commands are blocked for non-admin users.
 */
async function handleMenuCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("menu:")) return;

  await ctx.answerCallbackQuery();
  const cmd = data.replace("menu:", "");
  const isAdmin = ctx.from?.id === env.OWNER_ID;

  // Admin commands — reject non-admin
  const adminCmds = ["pulse", "stats", "beat", "top", "genre", "roster", "lookup",
    "dossier", "quarantine", "pardon", "lockup", "adduser", "sweep", "log"];
  if (adminCmds.includes(cmd) && !isAdmin) {
    await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
    return;
  }

  // Remove the inline keyboard
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  switch (cmd) {
    case "download_info":
      await ctx.editMessageText(
        "📹 **Download a Video**\n\nSimply send any video URL and choose the resolution you want.\n\nExamples:\n• `https://youtube.com/watch?v=...`\n• `https://tiktok.com/@user/video/...`\n• `https://twitter.com/user/status/...`",
        { parse_mode: "Markdown" },
      );
      break;
    case "start":
      await ctx.editMessageText(getStartMessage(ctx), { parse_mode: "Markdown" });
      break;
    case "help":
      await ctx.editMessageText(HELP_MESSAGE, { parse_mode: "Markdown" });
      break;
    case "about":
      await ctx.editMessageText(ABOUT_MESSAGE, { parse_mode: "Markdown" });
      break;
    case "pulse":
      await ctx.editMessageText(adminService.buildPulse());
      break;
    case "stats":
      await ctx.editMessageText(adminService.buildStats());
      break;
    case "beat":
      await ctx.editMessageText(adminService.buildBeat());
      break;
    case "top":
      await ctx.editMessageText(adminService.buildTop());
      break;
    case "genre":
      await ctx.editMessageText(adminService.buildGenre());
      break;
    case "roster":
      await ctx.editMessageText(adminService.buildRoster(1));
      break;
    case "lookup":
      await ctx.editMessageText(
        "🔍 **User Lookup**\n\nUsage: `/lookup @username`\n       `/lookup 123456789`\n\nSend the command directly to search.",
        { parse_mode: "Markdown" },
      );
      break;
    case "dossier":
      await ctx.editMessageText(
        "📋 **User Dossier**\n\nUsage: `/dossier <telegram_id>`\n\nSend the command directly to view a full user profile.",
        { parse_mode: "Markdown" },
      );
      break;
    case "quarantine":
      await ctx.editMessageText(
        "🚫 **Quarantine**\n\nUsage: `/quarantine <telegram_id> [reason]`\n\nSend the command directly to ban a user.",
        { parse_mode: "Markdown" },
      );
      break;
    case "pardon":
      await ctx.editMessageText(
        "✅ **Pardon**\n\nUsage: `/pardon <telegram_id>`\n\nSend the command directly to unban a user.",
        { parse_mode: "Markdown" },
      );
      break;
    case "lockup":
      await ctx.editMessageText(adminService.buildLockup());
      break;
    case "adduser":
      await ctx.editMessageText(
        "➕ **Add User**\n\nUsage: `/adduser <telegram_id>`\n\nApproves a new user so they can use the bot.\nSend the command directly with the user's ID.",
        { parse_mode: "Markdown" },
      );
      break;
    case "sweep":
      const sweepResult = await adminService.sweepTempFiles();
      await ctx.editMessageText(sweepResult);
      break;
    case "log":
      await ctx.editMessageText(adminService.buildLogs());
      break;
  }
}

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

  bot.command("menu", async (ctx) => {
    const isAdmin = ctx.from?.id === env.OWNER_ID;
    await ctx.reply(
      "📋 **Command Menu**\nTap a button below:",
      { parse_mode: "Markdown", reply_markup: buildMenuKeyboard(isAdmin) },
    );
  });

  // Handle menu inline keyboard callbacks
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith("menu:")) {
      await handleMenuCallback(ctx);
      return;
    }
    await next();
  });
}
