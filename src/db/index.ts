import { Database } from "bun:sqlite";
import { env } from "../config";
import { SCHEMA_SQL } from "./schema";
import { logger } from "../utils/logger";
import type { UserRow, DownloadRow } from "../types";

let db: Database;

/**
 * Initialise database: open, set WAL mode, run migrations.
 */
export function initDatabase(): Database {
  db = new Database(env.DATABASE_PATH);

  // Performance and concurrency settings
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA foreign_keys = ON;");

  // Run schema migrations
  for (const stmt of SCHEMA_SQL.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) {
      db.run(trimmed);
    }
  }

  logger.info({ path: env.DATABASE_PATH }, "Database initialised");
  return db;
}

/**
 * Get the database instance. Throws if not yet initialised.
 */
export function getDb(): Database {
  if (!db) throw new Error("Database not initialised — call initDatabase() first");
  return db;
}

// ─── User queries ────────────────────────────────────────────

export function upsertUser(telegramId: number, username?: string | null, firstName?: string | null, lastName?: string | null): void {
  const stmt = db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name),
      updated_at = datetime('now')
  `);
  stmt.run(telegramId, username ?? null, firstName ?? null, lastName ?? null);
}

export function getUserByTelegramId(telegramId: number): UserRow | undefined {
  return db.query("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as UserRow | undefined;
}

export function getUsersCount(active: boolean): number {
  const row = db.query(
    active
      ? "SELECT COUNT(*) as count FROM users WHERE is_allowed = 1"
      : "SELECT COUNT(*) as count FROM users WHERE is_allowed = 0",
  ).get() as { count: number };
  return row.count;
}

export function getTotalDownloads(): number {
  const row = db.query("SELECT COUNT(*) as count FROM downloads").get() as { count: number };
  return row.count;
}

export function getCompletedDownloads(): number {
  const row = db.query("SELECT COUNT(*) as count FROM downloads WHERE status = 'completed'").get() as { count: number };
  return row.count;
}

export function getFailedDownloads(): number {
  const row = db.query("SELECT COUNT(*) as count FROM downloads WHERE status = 'failed'").get() as { count: number };
  return row.count;
}

export function getTodayDownloads(): number {
  const row = db.query(
    "SELECT COUNT(*) as count FROM downloads WHERE date(started_at) = date('now')",
  ).get() as { count: number };
  return row.count;
}

export function getTotalBytes(): number {
  const row = db.query("SELECT COALESCE(SUM(file_size), 0) as total FROM downloads WHERE status = 'completed'").get() as { total: number };
  return row.total;
}

export function getPlatformBreakdown(): Array<{ platform: string; count: number }> {
  return db.query(
    "SELECT platform, COUNT(*) as count FROM downloads WHERE platform IS NOT NULL GROUP BY platform ORDER BY count DESC",
  ).all() as Array<{ platform: string; count: number }>;
}

export function getTopDownloaders(limit = 10): Array<{ telegram_id: number; username: string | null; total_downloads: number; total_bytes: number }> {
  return db.query(
    "SELECT telegram_id, username, total_downloads, total_bytes FROM users WHERE is_allowed = 1 ORDER BY total_downloads DESC LIMIT ?",
  ).all(limit) as Array<{ telegram_id: number; username: string | null; total_downloads: number; total_bytes: number }>;
}

export function getRecentDownloads(limit = 15): Array<DownloadRow> {
  return db.query(
    "SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?",
  ).all(limit) as Array<DownloadRow>;
}

export function getUserDossier(telegramId: number): { user: UserRow | undefined; recentDownloads: Array<DownloadRow> } {
  const user = getUserByTelegramId(telegramId);
  const recentDownloads = user
    ? (db.query(
        "SELECT * FROM downloads WHERE user_id = ? ORDER BY started_at DESC LIMIT 10",
      ).all(user.id) as Array<DownloadRow>)
    : [];
  return { user, recentDownloads };
}

export function searchUsers(query: string): Array<UserRow> {
  // Query can be @username or telegram_id
  const asNumber = Number(query.replace(/^@/, ""));
  if (!isNaN(asNumber)) {
    const user = db.query("SELECT * FROM users WHERE telegram_id = ?").get(asNumber) as UserRow | undefined;
    return user ? [user] : [];
  }
  const likeQuery = query.replace("@", "").toLowerCase();
  return db.query(
    "SELECT * FROM users WHERE LOWER(username) LIKE ? ORDER BY total_downloads DESC LIMIT 10",
  ).all(`%${likeQuery}%`) as Array<UserRow>;
}

export function listUsers(page: number, perPage = 10): { users: Array<UserRow>; total: number; page: number; totalPages: number } {
  const total = (db.query("SELECT COUNT(*) as count FROM users").get() as { count: number }).count;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;
  const users = db.query(
    "SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?",
  ).all(perPage, offset) as Array<UserRow>;
  return { users, total, page, totalPages };
}

export function getBannedUsers(): Array<UserRow> {
  return db.query(
    "SELECT * FROM users WHERE is_allowed = 0 ORDER BY banned_at DESC",
  ).all() as Array<UserRow>;
}

export function banUser(telegramId: number, reason: string, isOwnerId: number): void {
  if (telegramId === isOwnerId) {
    throw new Error("Cannot ban the owner");
  }
  db.run(
    "UPDATE users SET is_allowed = 0, banned_at = datetime('now'), ban_reason = ?, updated_at = datetime('now') WHERE telegram_id = ?",
    reason, telegramId,
  );
}

export function unbanUser(telegramId: number): void {
  db.run(
    "UPDATE users SET is_allowed = 1, banned_at = NULL, ban_reason = NULL, updated_at = datetime('now') WHERE telegram_id = ?",
    telegramId,
  );
}

export function approveUserInDb(telegramId: number): void {
  db.run(
    "UPDATE users SET is_allowed = 1, updated_at = datetime('now') WHERE telegram_id = ?",
    telegramId,
  );
}

export function setUserAsOwner(telegramId: number): void {
  db.run("UPDATE users SET is_owner = 1 WHERE telegram_id = ?", telegramId);
}

// ─── Download queries ────────────────────────────────────────

export function insertDownload(userId: number, chatId: number, url: string, platform: string): number {
  const stmt = db.prepare(
    "INSERT INTO downloads (user_id, chat_id, url, platform, status) VALUES (?, ?, ?, ?, 'started')",
  );
  return stmt.run(userId, chatId, url, platform).lastInsertRowid as number;
}

export function updateDownloadStatus(
  id: number,
  status: string,
  fileSize?: number | null,
  durationMs?: number | null,
  format?: string | null,
  errorCode?: string | null,
  errorMessage?: string | null,
  retryCount?: number,
): void {
  const stmt = db.prepare(`
    UPDATE downloads SET
      status = ?,
      file_size = COALESCE(?, file_size),
      duration_ms = COALESCE(?, duration_ms),
      format = COALESCE(?, format),
      error_code = COALESCE(?, error_code),
      error_message = COALESCE(?, error_message),
      retry_count = COALESCE(?, retry_count),
      completed_at = CASE WHEN ? IN ('completed', 'failed') THEN datetime('now') ELSE completed_at END
    WHERE id = ?
  `);
  stmt.run(status, fileSize ?? null, durationMs ?? null, format ?? null, errorCode ?? null, errorMessage ?? null, retryCount ?? null, status, id);
}

export function incrementUserStats(telegramId: number, fileSize: number): void {
  db.run(
    "UPDATE users SET total_downloads = total_downloads + 1, total_bytes = total_bytes + ?, updated_at = datetime('now') WHERE telegram_id = ?",
    fileSize, telegramId,
  );
}

export function getDbSize(): number {
  try {
    const stat = db.query("SELECT page_count * page_size as size FROM pragma_page_count, pragma_page_size").get() as { size: number } | undefined;
    return stat?.size ?? 0;
  } catch {
    return 0;
  }
}

export function getErrorLogs(limit = 20): Array<{ started_at: string; error_code: string | null; error_message: string | null; platform: string | null }> {
  return db.query(
    "SELECT started_at, error_code, error_message, platform FROM downloads WHERE status = 'failed' ORDER BY started_at DESC LIMIT ?",
  ).all(limit) as Array<{ started_at: string; error_code: string | null; error_message: string | null; platform: string | null }>;
}

/**
 * Get the database instance for use in tracker and admin services.
 * Re-export for convenience.
 */
export { db };
