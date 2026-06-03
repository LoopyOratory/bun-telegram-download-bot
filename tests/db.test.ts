/**
 * Tests for the database layer.
 *
 * Uses an in-memory SQLite database for isolation.
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { writeQueue } from "../src/db/queue";

// We'll test the DB functions by importing them with a test DB
// Since the module-level functions use a shared `db` variable,
// we test the SQL logic directly with an isolated DB.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  is_owner        INTEGER NOT NULL DEFAULT 0,
  is_allowed      INTEGER NOT NULL DEFAULT 1,
  banned_at       TEXT,
  ban_reason      TEXT,
  total_downloads INTEGER NOT NULL DEFAULT 0,
  total_bytes     INTEGER NOT NULL DEFAULT 0,
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS downloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  chat_id       INTEGER NOT NULL,
  url           TEXT NOT NULL,
  platform      TEXT,
  status        TEXT NOT NULL DEFAULT 'started',
  file_size     INTEGER,
  duration_ms   INTEGER,
  format        TEXT,
  error_code    TEXT,
  error_message TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_downloads_user_id ON downloads(user_id);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
`;

describe("SQLite Schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL;");
    for (const stmt of SCHEMA_SQL.split(";")) {
      const trimmed = stmt.trim();
      if (trimmed) db.run(trimmed);
    }
  });

  test("creates users table", () => {
    const result = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    expect(result).toBeDefined();
  });

  test("creates downloads table", () => {
    const result = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'").get();
    expect(result).toBeDefined();
  });

  test("inserts and reads a user", () => {
    db.run("INSERT INTO users (telegram_id, username) VALUES (?, ?)", 12345, "testuser");
    const user = db.query("SELECT * FROM users WHERE telegram_id = ?").get(12345) as any;
    expect(user.telegram_id).toBe(12345);
    expect(user.username).toBe("testuser");
    expect(user.is_allowed).toBe(1);
  });

  test("upserts user with ON CONFLICT", () => {
    db.run(`
      INSERT INTO users (telegram_id, username) VALUES (?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET username = EXCLUDED.username, updated_at = datetime('now')
    `, 12345, "updateduser");

    const user = db.query("SELECT * FROM users WHERE telegram_id = ?").get(12345) as any;
    expect(user.username).toBe("updateduser");
  });

  test("inserts and tracks a download", () => {
    const user = db.query("SELECT id FROM users WHERE telegram_id = ?").get(12345) as any;
    const stmt = db.prepare(
      "INSERT INTO downloads (user_id, chat_id, url, platform, status) VALUES (?, ?, ?, ?, ?)",
    );
    const result = stmt.run(user.id, -100123, "https://example.com/video", "youtube", "started");
    expect(result.lastInsertRowid).toBeGreaterThan(0);

    // Update to completed
    db.run(
      "UPDATE downloads SET status = 'completed', file_size = ?, completed_at = datetime('now') WHERE id = ?",
      1024, result.lastInsertRowid,
    );

    const download = db.query("SELECT * FROM downloads WHERE id = ?").get(result.lastInsertRowid) as any;
    expect(download.status).toBe("completed");
    expect(download.file_size).toBe(1024);
  });

  test("tracks user stats", () => {
    db.run(
      "UPDATE users SET total_downloads = total_downloads + 1, total_bytes = total_bytes + ?, updated_at = datetime('now') WHERE telegram_id = ?",
      2048, 12345,
    );

    const user = db.query("SELECT total_downloads, total_bytes FROM users WHERE telegram_id = ?").get(12345) as any;
    expect(user.total_downloads).toBe(1);
    expect(user.total_bytes).toBe(2048);
  });

  test("implements ban", () => {
    db.run(
      "UPDATE users SET is_allowed = 0, banned_at = datetime('now'), ban_reason = ?, updated_at = datetime('now') WHERE telegram_id = ?",
      "Spam", 12345,
    );

    const user = db.query("SELECT * FROM users WHERE telegram_id = ?").get(12345) as any;
    expect(user.is_allowed).toBe(0);
    expect(user.ban_reason).toBe("Spam");
  });

  test("implements unban", () => {
    db.run(
      "UPDATE users SET is_allowed = 1, banned_at = NULL, ban_reason = NULL, updated_at = datetime('now') WHERE telegram_id = ?",
      12345,
    );

    const user = db.query("SELECT * FROM users WHERE telegram_id = ?").get(12345) as any;
    expect(user.is_allowed).toBe(1);
    expect(user.banned_at).toBeNull();
  });

  afterAll(() => {
    db.close();
  });
});

describe("WriteQueue", () => {
  test("executes queued writes in order", async () => {
    const results: number[] = [];

    await Promise.all([
      writeQueue.enqueue(() => results.push(1)),
      writeQueue.enqueue(() => results.push(2)),
      writeQueue.enqueue(() => results.push(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  test("reports queue depth", () => {
    expect(writeQueue.queueDepth).toBe(0);
  });

  test("propagates errors from queued functions", async () => {
    try {
      await writeQueue.enqueue(() => {
        throw new Error("test error");
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("test error");
    }
  });
});
