/** SQL schema for SQLite database. Each statement is split on ; and run sequentially. */
export const SCHEMA_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_users_telegram_id   ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_is_allowed    ON users(is_allowed);
CREATE INDEX IF NOT EXISTS idx_downloads_user_id   ON downloads(user_id);
CREATE INDEX IF NOT EXISTS idx_downloads_status    ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_downloads_platform  ON downloads(platform);
CREATE INDEX IF NOT EXISTS idx_downloads_started   ON downloads(started_at);
`;
