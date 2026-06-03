import { readdir, unlink } from "node:fs/promises";
import { env } from "../config";
import { logger } from "../utils/logger";
import {
  getUsersCount,
  getTotalDownloads,
  getCompletedDownloads,
  getFailedDownloads,
  getTodayDownloads,
  getTotalBytes,
  getPlatformBreakdown,
  getTopDownloaders,
  getRecentDownloads,
  getUserDossier,
  searchUsers,
  listUsers,
  getBannedUsers,
  banUser as dbBanUser,
  unbanUser as dbUnbanUser,
  getDbSize,
  getErrorLogs,
} from "../db";
import { formatFileSize } from "../utils/format";
import type { UserRow } from "../types";

/**
 * Admin service — builds formatted response strings for all admin commands.
 * All DB reads are done directly (WAL mode allows concurrent reads).
 */
export const adminService = {
  // ─── Analytics ────────────────────────────────────────

  buildPulse(): string {
    const uptime = formatUptime(process.uptime());
    const tempDir = env.TEMP_DIR;
    const dbSize = formatFileSize(getDbSize());

    return [
      "💓 Bot Pulse\n",
      `Status    ● Online`,
      `Uptime    ${uptime}`,
      `Temp      ${tempDir}`,
      `DB size   ${dbSize}`,
      `Log level ${env.LOG_LEVEL}`,
    ].join("\n");
  },

  buildStats(): string {
    const totalUsers = getUsersCount(true);
    const bannedUsers = getUsersCount(false);
    const total = getTotalDownloads();
    const completed = getCompletedDownloads();
    const failed = getFailedDownloads();
    const today = getTodayDownloads();
    const totalBytes = getTotalBytes();
    const topUsers = getTopDownloaders(1);
    const topUser = topUsers[0];

    const lines: string[] = [
      "📊 Bot Statistics\n",
      `👥 Users: ${totalUsers + bannedUsers}`,
      `  └ Active: ${totalUsers} | Banned: ${bannedUsers}`,
      `📥 Downloads: ${total}`,
      `  └ ✅ ${completed} completed | ❌ ${failed} failed`,
      `  └ 📈 +${today} today`,
      ``,
      `💾 Total bandwidth: ${formatFileSize(totalBytes)}`,
    ];

    if (topUser) {
      lines.push(`🏆 Top user: @${topUser.username || topUser.telegram_id} (${topUser.total_downloads} downloads)`);
    }

    return lines.join("\n");
  },

  buildBeat(limit = 15): string {
    const recent = getRecentDownloads(limit);
    if (recent.length === 0) {
      return "📡 No recent downloads.";
    }

    const lines: string[] = ["📡 Live Feed (last 15 downloads)\n"];
    for (const d of recent) {
      const time = d.started_at?.slice(11, 16) || "??:??";
      const icon = d.status === "completed" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      const size = formatFileSize(d.file_size);
      lines.push(`${time}  ${icon}  ${d.platform || "?"}  ${size}`);
    }

    lines.push("\nUse /beat 25 to show more");
    return lines.join("\n");
  },

  buildTop(): string {
    const top = getTopDownloaders(10);
    if (top.length === 0) {
      return "🏆 No downloads yet.";
    }

    const lines: string[] = [
      "🏆 Top Downloaders\n",
      "Rank  User          Downloads    Data",
    ];

    for (let i = 0; i < top.length; i++) {
      const u = top[i];
      const username = u.username ? `@${u.username}` : String(u.telegram_id);
      const padded = username.padEnd(14).slice(0, 14);
      lines.push(
        `#${i + 1}    ${padded}  ${String(u.total_downloads).padEnd(10)} ${formatFileSize(u.total_bytes).padStart(8)}`,
      );
    }

    return lines.join("\n");
  },

  buildGenre(): string {
    const breakdown = getPlatformBreakdown();
    if (breakdown.length === 0) {
      return "🎬 No downloads yet.";
    }

    const maxCount = breakdown[0]?.count || 1;
    const total = breakdown.reduce((sum, b) => sum + b.count, 0);
    const barWidth = 20;

    const lines: string[] = ["🎬 Platform Breakdown\n"];
    for (const b of breakdown) {
      const barLen = Math.round((b.count / maxCount) * barWidth);
      const bar = "▰".repeat(barLen).padEnd(barWidth);
      const pct = ((b.count / total) * 100).toFixed(0);
      lines.push(`${(b.platform || "other").padEnd(12)} ${bar} ${String(b.count).padStart(4)} (${pct}%)`);
    }

    return lines.join("\n");
  },

  // ─── User Management ─────────────────────────────────

  buildRoster(page: number): string {
    const { users, total, page: currentPage, totalPages } = listUsers(page);

    if (users.length === 0) {
      return "👥 No users found.";
    }

    const lines: string[] = [
      `👥 User Roster (Page ${currentPage}/${totalPages})\n`,
    ];

    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const rank = (page - 1) * 10 + i + 1;
      const username = u.username ? `@${u.username}` : "—";
      const status = u.is_allowed === 0 ? "🔒 Banned" : "✅";
      lines.push(
        `  #${rank}  ${u.telegram_id}  ${username.padEnd(15)} ${String(u.total_downloads).padEnd(5)} dl  ${formatFileSize(u.total_bytes).padStart(8)}  ${status}`,
      );
    }

    if (currentPage < totalPages) {
      lines.push(`\nUse /roster ${currentPage + 1} to see next page`);
    }

    return lines.join("\n");
  },

  buildLookup(query: string): string {
    const results = searchUsers(query);
    if (results.length === 0) {
      return "🔍 No user found.";
    }

    const lines: string[] = ["🔍 User Lookup Results\n"];
    for (const u of results) {
      const username = u.username ? `@${u.username}` : "—";
      const status = u.is_allowed === 0 ? "🔒 Banned" : "✅";
      lines.push(`  ${u.telegram_id}  ${username}  ${u.total_downloads} dl  ${formatFileSize(u.total_bytes)}  ${status}`);
    }

    return lines.join("\n");
  },

  buildDossier(telegramId: number): string {
    const { user, recentDownloads } = getUserDossier(telegramId);
    if (!user) {
      return "📋 User not found.";
    }

    const username = user.username ? `@${user.username}` : "—";
    const status = user.is_allowed === 0 ? "🔒 Banned" : "✅";
    const successRate = user.total_downloads > 0
      ? ((user.total_downloads - recentDownloads.filter(d => d.status === "failed").length) / user.total_downloads * 100).toFixed(1)
      : "N/A";

    const lines: string[] = [
      `📋 User Dossier: ${username}\n`,
      `╔══════════════════════════════════╗`,
      `║ Profile`,
      `║  Telegram ID: ${user.telegram_id}`,
      `║  Username:    ${username}`,
      `║  First seen:  ${user.first_seen?.slice(0, 10) || "—"}`,
      `║  Last active: ${user.updated_at?.slice(0, 16) || "—"}`,
      `║  Status:      ${status}`,
      `╠══════════════════════════════════╣`,
      `║ Activity`,
      `║  Downloads:  ${user.total_downloads} total`,
      `║  Data:       ${formatFileSize(user.total_bytes)}`,
      `║  Success:    ${successRate}%`,
      `╠══════════════════════════════════╣`,
      `║ Last Downloads`,
    ];

    for (const d of recentDownloads.slice(0, 10)) {
      const icon = d.status === "completed" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      const time = d.started_at?.slice(11, 16) || "??:??";
      const size = formatFileSize(d.file_size);
      lines.push(`║  ${time} ${icon} ${(d.platform || "?").padEnd(10)} ${size.padStart(7)}`);
    }

    lines.push(`╚══════════════════════════════════╝`);

    return lines.join("\n");
  },

  // ─── Moderation ──────────────────────────────────────

  buildBanNotice(telegramId: number, reason: string): string {
    const user = getUserDossier(telegramId).user;
    const username = user?.username ? `@${user.username}` : String(telegramId);

    return [
      "🚫 QUARANTINE ORDER\n",
      `User:      ${username} (${telegramId})`,
      `Reason:    ${reason}`,
      `Duration:  Indefinite`,
      `Issued:    ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n`,
      "They won't even know we exist anymore.",
    ].join("\n");
  },

  buildPardonNotice(telegramId: number): string {
    const user = getUserDossier(telegramId).user;
    const username = user?.username ? `@${user.username}` : String(telegramId);

    return [
      "✅ PARDON GRANTED\n",
      `User:      ${username} (${telegramId})`,
      `Restored:  ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n`,
      "They're back. Let's see if they behave.",
    ].join("\n");
  },

  buildLockup(): string {
    const banned = getBannedUsers();
    if (banned.length === 0) {
      return "🔒 The lockup is empty. No banned users.";
    }

    const lines: string[] = [
      "🔒 The Lockup (Banned Users)\n",
    ];

    for (const u of banned) {
      const username = u.username ? `@${u.username}` : "—";
      lines.push(
        `${u.telegram_id}  ${username.padEnd(15)} ${String(u.total_downloads).padStart(4)} dl  ${u.banned_at?.slice(0, 10) || "—"}  ${u.ban_reason || "No reason"}`,
      );
    }

    lines.push(`\nTotal: ${banned.length} inmate${banned.length !== 1 ? "s" : ""}`);
    return lines.join("\n");
  },

  // ─── System ──────────────────────────────────────────

  async sweepTempFiles(): Promise<string> {
    const tempDir = env.TEMP_DIR;

    try {
      const files = await readdir(tempDir);
      const mediaFiles = files.filter(
        (f) => f.endsWith(".mp4") || f.endsWith(".webm") || f.endsWith(".mp3") || f.endsWith(".part") || f.endsWith(".ytdl"),
      );

      let cleaned = 0;
      let freed = 0;

      for (const file of mediaFiles) {
        const filePath = `${tempDir}/${file}`;
        try {
          const bunFile = Bun.file(filePath);
          freed += (await bunFile.stat()).size;
          await unlink(filePath);
          cleaned++;
        } catch { /* file may be in use */ }
      }

      logger.info({ cleaned, freed }, "Temp sweep completed");

      return [
        "🧹 Sweep Complete\n",
        `Cleaned:  ${cleaned} temp files`,
        `Freed:    ${formatFileSize(freed)}`,
      ].join("\n");
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        return "🧹 Temp directory does not exist — nothing to clean.";
      }
      throw err;
    }
  },

  buildLogs(lines = 20): string {
    const errors = getErrorLogs(lines);
    if (errors.length === 0) {
      return "📋 No errors logged.";
    }

    const result: string[] = [`📋 Recent Errors (last ${Math.min(errors.length, lines)} lines)\n`];
    for (const e of errors) {
      const time = e.started_at?.slice(11, 16) || "??:??";
      const code = e.error_code ? `[${e.error_code}]` : "[ERROR]";
      const msg = (e.error_message || "Unknown error").slice(0, 80);
      result.push(`${time} ${code} ${msg}`);
    }

    return result.join("\n");
  },

  // ─── Mutations ───────────────────────────────────────

  approveUser(telegramId: number): void {
    const db = require("../db");
    // Upsert user with is_allowed=1 (create if doesn't exist)
    db.upsertUser(telegramId, null, null, null);
    db.approveUserInDb(telegramId);
    logger.info({ telegramId }, "User approved via /adduser");
  },

  banUser(telegramId: number, reason: string): void {
    if (telegramId === env.OWNER_ID) {
      throw new Error("Cannot ban the owner");
    }
    dbBanUser(telegramId, reason, env.OWNER_ID);
    logger.warn({ telegramId, reason }, "User banned");
  },

  unbanUser(telegramId: number): void {
    dbUnbanUser(telegramId);
    logger.info({ telegramId }, "User unbanned");
  },
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}
