import { env } from "../config";
import { logger } from "../utils/logger";
import { requireAdmin } from "../middleware/adminOnly";
import { adminService } from "../services/admin";
import { writeQueue } from "../db/queue";
import type { Bot } from "grammy";

/**
 * Register all admin command handlers.
 * Every handler starts with requireAdmin().
 */
export function registerAdminHandlers(bot: Bot): void {
  // ─── Panel ─────────────────────────────────────────

  bot.command("panel", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(
      [
        "👑 Admin Command Centre\n",
        "╔══════════════════════════════════════╗",
        "║  📊 ANALYTICS                       ║",
        "║  /pulse     — Bot health & uptime   ║",
        "║  /stats     — Full bot statistics   ║",
        "║  /beat      — Live activity feed    ║",
        "║  /top       — Top downloaders       ║",
        "║  /genre     — Platform breakdown    ║",
        "╠══════════════════════════════════════╣",
        "║  👥 USER MANAGEMENT                 ║",
        "║  /roster    — List all users        ║",
        "║  /lookup    — Search/find a user    ║",
        "║  /dossier   — Full user deep dive   ║",
        "╠══════════════════════════════════════╣",
        "║  ⚖️ MODERATION                      ║",
        "║  /quarantine — Ban a user           ║",
        "║  /pardon     — Unban a user         ║",
        "║  /lockup     — List banned users    ║",
        "╠══════════════════════════════════════╣",
        "║  🧹 SYSTEM                          ║",
        "║  /sweep     — Clean temp files      ║",
        "║  /log       — View error logs       ║",
        "╚══════════════════════════════════════╝",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // ─── Analytics ─────────────────────────────────────

  bot.command("pulse", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(adminService.buildPulse());
  });

  bot.command("stats", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(adminService.buildStats());
  });

  bot.command("beat", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const limit = parseInt(ctx.match) || 15;
    await ctx.reply(adminService.buildBeat(limit));
  });

  bot.command("top", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(adminService.buildTop());
  });

  bot.command("genre", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(adminService.buildGenre());
  });

  // ─── User Management ──────────────────────────────

  bot.command("roster", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const page = parseInt(ctx.match) || 1;
    await ctx.reply(adminService.buildRoster(page));
  });

  bot.command("lookup", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply(
        "🔍 User Lookup\n\nUsage: /lookup @username\n       /lookup 123456789\n\nExamples:\n  /lookup @johndoe\n  /lookup 987654321",
      );
      return;
    }
    await ctx.reply(adminService.buildLookup(query));
  });

  bot.command("dossier", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const id = parseInt(ctx.match);
    if (!id) {
      await ctx.reply("Usage: /dossier <telegram_id>");
      return;
    }
    await ctx.reply(adminService.buildDossier(id));
  });

  // ─── Moderation ────────────────────────────────────

  bot.command("adduser", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const id = parseInt(ctx.match);
    if (!id) {
      await ctx.reply("Usage: /adduser <telegram_id>");
      return;
    }
    await writeQueue.enqueue(() => adminService.approveUser(id));
    await ctx.reply(
      `✅ User approved!\n\nTelegram ID: ${id}\nThey can now use the bot.`,
    );
  });

  bot.command("quarantine", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const [idStr, ...reasonParts] = ctx.match?.split(" ") || [];
    const id = parseInt(idStr);
    if (!id) {
      await ctx.reply("Usage: /quarantine <telegram_id> [reason]");
      return;
    }
    if (id === env.OWNER_ID) {
      await ctx.reply("⛔ Cannot quarantine the admin.");
      return;
    }

    const reason = reasonParts.join(" ") || "No reason specified";
    await writeQueue.enqueue(() => adminService.banUser(id, reason));
    await ctx.reply(adminService.buildBanNotice(id, reason));
  });

  bot.command("pardon", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const id = parseInt(ctx.match);
    if (!id) {
      await ctx.reply("Usage: /pardon <telegram_id>");
      return;
    }
    await writeQueue.enqueue(() => adminService.unbanUser(id));
    await ctx.reply(adminService.buildPardonNotice(id));
  });

  bot.command("lockup", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    await ctx.reply(adminService.buildLockup());
  });

  // ─── System ────────────────────────────────────────

  bot.command("sweep", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const result = await adminService.sweepTempFiles();
    await ctx.reply(result);
  });

  bot.command("log", async (ctx) => {
    if (!await requireAdmin(ctx)) return;
    const lines = parseInt(ctx.match) || 20;
    await ctx.reply(adminService.buildLogs(lines));
  });
}
