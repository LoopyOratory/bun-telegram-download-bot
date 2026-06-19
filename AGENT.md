# Hermes Video Bot — AGENT.md

## Project Overview

Telegram video downloader bot. Send any video URL — YouTube, Twitter/X, TikTok, Instagram, Snapchat Spotlight, or any of 1000+ sites supported by yt-dlp — the bot downloads it and sends the file back to you in Telegram. *No watermarks, no persisted files.

Only authorized users/groups (configured in .env) can use the bot. The admin (OWNER_ID) has full control: stats, user logs, bans, and system management — all queried from SQLite.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Bun | All-in-one: runtime, package manager, SQLite, test runner |
| Bot framework | grammy (grammy.dev) | Telegram Bot API framework, polling-first, Bun-native |
| Config validation | Zod | Schema validation for .env at startup — fail fast, not silently |
| Database | Bun SQLite (`bun:sqlite`) | Zero-dependency, embedded, synchronous |
| Download engine | yt-dlp (CLI) | Covers YouTube, Twitter, TikTok, Instagram, Snapchat Spotlight + 1000+ sites |
| Media processing | FFmpeg | Merging DASH streams, format conversion |
| Structured logging | pino | Fast, structured JSON logs with levels |
| Container | Docker | Single image for deployment on Haloy |

## Project Files

```
bun-video-bot/
├── src/
│   ├── index.ts            # Entry: init DB, validate .env, start bot
│   ├── bot.ts              # Grammy bot instance + middleware pipeline
│   ├── config.ts           # Zod-validated .env schema + config export
│   ├── db/
│   │   ├── index.ts        # DB init, WAL mode, migrations
│   │   ├── schema.ts       # Table definitions as SQL constants
│   │   ├── migrations.ts   # Auto-run on startup: CREATE TABLE IF NOT EXISTS
│   │   └── queue.ts        # Serial write queue (SQLite: single-writer)
│   ├── services/
│   │   ├── downloader.ts   # yt-dlp CLI wrapper (Bun.spawn), emits progress events
│   │   ├── proxy.ts        # Three-tier proxy system: PROXY_URL → free pool → Tor
│   │   ├── tracker.ts      # Download logging + user upsert
│   │   └── admin.ts        # Admin queries: stats, user lookup, ban/unban
│   ├── middleware/
│   │   ├── auth.ts         # Authorization: check ALLOWED_USERS/GROUPS, check bans
│   │   ├── adminOnly.ts    # Admin guard: verify OWNER_ID
│   │   ├── ratelimit.ts    # Per-user rate limiting
│   │   └── logger.ts       # Request logging middleware
│   ├── handlers/
│   │   ├── download.ts     # URL handler: validate, download, send
│   │   ├── admin.ts        # All admin commands
│   │   └── general.ts      # /start, /help, /about
│   ├── progress.ts         # Progress bar renderer + Telegram message updater
│   ├── cleanup.ts          # File deletion: runs immediately after sendVideo, also handles crash/SIGTERM orphan cleanup
│   ├── types.ts            # Shared types
│   └── utils/
│       ├── url.ts          # URL validation, platform detection
│       ├── format.ts       # File size formatting, duration
│       └── limits.ts       # File size limits
├── data/
│   └── bot.db              # SQLite database (created at runtime)
├── Dockerfile              # bun + yt-dlp + ffmpeg in single image
├── .env.example
├── package.json
├── tsconfig.json
└── AGENT.md                # This file
```

## Architecture

Polling mode only.* No HTTP server — grammy's `bot.start()` keeps a long-lived TCP connection to Telegram. One Bun process, one container.

``` (1/9)
[03/06/2026 02:46] eko-herm: User sends URL
  → auth middleware: check ALLOWED_USERS/GROUPS + DB ban status
  → ratelimit middleware: 1 concurrent download, 10s cooldown
  → download handler: validate URL → upsert user → insert download record
  → Bun.spawn(["yt-dlp", "--newline", ...]) — capture stderr for progress
  → Parse progress % from stderr, edit status message (throttled ~2s):
       ⠋ 📥 Downloading 45.2%
       ▰▰▰▰▰▱▱▱▱▱
       ⚡ 2.5MiB/s  ⏱ 0:45
  → On 100%: edit "🧩 Merging streams..."
  → Immediately after: edit "📤 Uploading to Telegram..."
  → bot.api.sendVideo(chatId, InputFile(readable))
  → Edit status: "✅ Done!"
  → Immediately delete file from disk: await fs.unlink(filePath)
  → Queue write: update DB (status=completed, file_size, duration)
  → On error: queue write status=failed, edit "❌ [minimal message]"
     → Also delete partial/zero-byte file if it exists

Admin sends any command → adminOnly guard checks OWNER_ID → handler runs

## Configuration (.env)

Validated with Zod at startup. Invalid config crashes with a clear message.

env
BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
OWNER_ID=123456789

Comma-separated Telegram user IDs allowed to use the bot
ALLOWED_USERS=123456789,987654321

Comma-separated Telegram group/channel IDs allowed (negative values)
ALLOWED_GROUPS=-1001234567890,-1009876543210

Bot behavior
TEMP_DIR=/tmp/bun-video-bot
MAX_FILE_SIZE_MB=50
LOG_LEVEL=info

Database path (relative paths resolve from project root)
DATABASE_PATH=./data/bot.db

### Config schema (config.ts)

typescript
import { z } from 'zod'

export const env = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  OWNER_ID: z.coerce.number().int().positive(),

  ALLOWED_USERS: z.string()
    .default("")
    .transform(s => s ? s.split(",").map(Number).filter(n => !isNaN(n)) : []),

  ALLOWED_GROUPS: z.string()
    .default("")
    .transform(s => s ? s.split(",").map(Number).filter(n => !isNaN(n)) : []),

  TEMP_DIR: z.string().default("/tmp/bun-video-bot"),
  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(50),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_PATH: z.string().default("./data/bot.db"),
}).parse(process.env)

## Database Schema

Auto-migrated on startup. WAL mode for read concurrency.

 (2/9)
[03/06/2026 02:46] eko-herm: sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  is_owner        INTEGER NOT NULL DEFAULT 0,
  is_allowed      INTEGER NOT NULL DEFAULT 1,       -- 1 = active, 0 = banned
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
  status        TEXT NOT NULL DEFAULT 'started',     -- started, downloading, completed, failed
  file_size     INTEGER,
  duration_ms   INTEGER,
  format        TEXT,
  error_message TEXT,
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

## SQLite Write Queue (db/queue.ts)

SQLite allows only one writer at a time. With concurrent downloads, all writes go through a serial queue.

typescript
// db/queue.ts
import { logger } from '../utils/logger'

type WriteFn<T = unknown> = () => T

class WriteQueue {
  private queue: WriteFn[] = []
  private processing = false

  enqueue<T>(fn: WriteFn<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        try { resolve(fn()) }
        catch (err) { reject(err) }
      })
      if (!this.processing) this.process()
    })
  }

  private process(): void {
    this.processing = true
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!
      fn()
    }
    this.processing = false
  }
}

export const writeQueue = new WriteQueue()

**Rules:**
- All writes go through `writeQueue.enqueue()` — never call `db.run()` directly
- Reads (SELECT) are direct — WAL mode allows concurrent reads during writes
- Queue is synchronous — each write completes before the next starts
- Downloads are already gated by rate limiter (1 concurrent per user), so the queue stays short

**Usage:**

typescript
await writeQueue.enqueue(() => {
  db.run("UPDATE users SET is_allowed = 0 WHERE telegram_id = ?", userId)
})

## Admin Verification (middleware/adminOnly.ts)

Every admin command starts with `requireAdmin()` — a single guard function that checks OWNER_ID.

 (3/9)
[03/06/2026 02:46] eko-herm: typescript
// middleware/adminOnly.ts
import { env } from '../config'
import { logger } from '../utils/logger'
import type { Context } from 'grammy'

/**
 * Check if the sender is the bot admin (OWNER_ID from .env).
 * Separated from auth middleware so admin commands get their own explicit guard.
 */
export function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === env.OWNER_ID
}

/**
 * Guard for admin-only handlers.
 * Returns true if authorized, false + sends rejection message if not.
 * Every admin handler starts with: if (!await requireAdmin(ctx)) return
 */
export async function requireAdmin(ctx: Context): Promise<boolean> {
  if (isAdmin(ctx)) return true

  logger.warn({
    userId: ctx.from?.id,
    command: ctx.message?.text,
  }, "Unauthorized admin command attempt")

  await ctx.reply("⛔ This command is restricted to the bot administrator.")
  return false
}

## Authorization (middleware/auth.ts)

Applied as grammy middleware — runs on every message before the handler.

typescript
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id
  const chatId = ctx.chat?.id
  if (!userId) return

  // Admin bypasses all checks
  if (userId === env.OWNER_ID) return await next()

  // Check if user is banned in DB
  const user = db.query(
    "SELECT is_allowed FROM users WHERE telegram_id = ?"
  ).get(userId) as { is_allowed: number } | undefined

  if (user?.is_allowed === 0) {
    logger.warn({ userId }, "Blocked banned user")
    return // silently ignore
  }

  // Private chat: check ALLOWED_USERS list
  if (ctx.chat?.type === "private") {
    if (!env.ALLOWED_USERS.includes(userId)) {
      return await ctx.reply("❌ You are not authorized to use this bot.")
    }
    return await next()
  }

  // Group chat: check ALLOWED_GROUPS list
  if (chatId && env.ALLOWED_GROUPS.includes(chatId)) return await next()

  return await ctx.reply("❌ This chat is not authorized.")
})

## Admin Commands

All admin commands are guarded by `requireAdmin()` as the first line. The OWNER_ID from .env is the single source of truth — no database check needed.

### 👑 /panel — Admin command centre


👑 Admin Command Centre

╔══════════════════════════════════════╗
║  📊 ANALYTICS                       ║
║  /pulse     — Bot health & uptime   ║
║  /stats     — Full bot statistics   ║
║  /beat      — Live activity feed    ║
║  /top       — Top downloaders       ║
║  /genre     — Platform breakdown    ║
╠══════════════════════════════════════╣
║  👥 USER MANAGEMENT                 ║
║  /roster    — List all users        ║
║  /lookup    — Search/find a user    ║
║  /dossier   — Full user deep dive   ║
╠══════════════════════════════════════╣
║  ⚖️ MODERATION                      ║
║  /quarantine — Ban a user           ║
║  /pardon     — Unban a user         ║
║  /lockup     — List banned users    ║
╠══════════════════════════════════════╣
║  🧹 SYSTEM                          ║
║  /sweep     — Clean temp files      ║
║  /log       — View error logs       ║
╚══════════════════════════════════════╝

### 📊 /pulse — Bot health


💓 Bot Pulse

Status    ● Online
Uptime    12d 4h 31m
Memory    47.2 MB / 512 MB
Disk      3.1 GB / 20 GB
Temp      128 MB (47 files)
DB size   2.4 MB
Downloads active: 2
Queue depth: 0

### 📊 /stats — Full statistics


📊 Bot Statistics

👥 Users: 47
  └ Active: 42 | Banned: 5
📥 Downloads: 1,284
  └ ✅ 1,201 completed | ❌ 83 failed
  └ 📈 +47 today

🎥 Platform split
  └ YouTube ▰▰▰▰▰▰▰ 892 (69%)
  └ TikTok  ▰▰ 214 (17%)
  └ Twitter ▰ 98 (8%)
  └ Insta   ▰ 56 (4%)
  └ Other         24 (2%)

💾 Total bandwidth: 45.2 GB
🏆 Top user: @johndoe (283 downloads)
🕐 Peak hour: 19:00-20:00 UTC

### 📊 /beat — Live activity feed

 (4/9)
[03/06/2026 02:46] eko-herm: 📡 Live Feed (last 15 downloads)

18:30  ✅  @johndoe    YouTube   25 MB  15s
18:15  ✅  @janedoe    TikTok    12 MB  8s
17:45  ✅  @johndoe    YouTube   50 MB  22s
17:30  ❌  @bobsmith   Twitter    —     Private video
17:15  ✅  @alice      Insta      8 MB  5s
...
Use /beat 25 to show more

### 🏆 /top — Leaderboard


🏆 Top Downloaders

Rank  User          Downloads    Data
#1    @johndoe      283          2.1 GB
#2    @janedoe      156          1.8 GB
#3    @alice         89        890 MB
#4    @bobsmith      45        412 MB
#5    @charlie       32        198 MB

You: #1 with 283 downloads

### 🎬 /genre — Platform breakdown


🎬 Platform Breakdown

YouTube ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 892
TikTok  ▰▰▰▰▰                     214
Twitter ▰▰                        98
Insta   ▰                         56
Other   ▏                         24

### 👥 /roster — All users (paginated)


👥 User Roster (Page 1/5)

  #1  123456789  @johndoe    283 dl   2.1 GB  ✅
  #2  987654321  @janedoe    156 dl   1.8 GB  ✅
  #3  555555555  @bobsmith    12 dl    45 MB  🔒 Banned
  #4  111222333  @alice       89 dl  890 MB   ✅
  #5  777888999  @charlie     32 dl  198 MB   ✅

Use /roster 2 to see next page

### 🔍 /lookup — Search for a user


🔍 User Lookup

Usage: /lookup @username
       /lookup 123456789

Examples:
  /lookup @johndoe
  /lookup 987654321

### 📋 /dossier <id> — Full user deep dive


📋 User Dossier: @johndoe

╔══════════════════════════════════╗
║ Profile                          ║
║  Telegram ID: 123456789         ║
║  Username:    @johndoe           ║
║  First seen:  2026-01-15         ║
║  Last active: 2026-06-02 18:30  ║
║  Status:      ✅ Active          ║
║  Role:        User               ║
╠══════════════════════════════════╣
║ Activity                          ║
║  Downloads:  283 total           ║
║  Data:       2.1 GB              ║
║  Success:    98.2%               ║
║  Failures:   5                   ║
╠══════════════════════════════════╣
║ Platforms                         ║
║  YouTube:   210 (74%)             ║
║  TikTok:     45 (16%)             ║
║  Twitter:    28 (10%)             ║
╠══════════════════════════════════╣
║ Last 10 Downloads                 ║
║  18:30  YouTube  25 MB  ✅ 15s   ║
║  17:45  YouTube  50 MB  ✅ 22s   ║
║  16:20  TikTok   12 MB  ✅  8s   ║
║  15:10  Twitter   5 MB  ❌ Priv  ║
║  ...                               ║
╚══════════════════════════════════╝

### 🚫 /quarantine <id> [reason] — Ban a user


🚫 QUARANTINE ORDER

User:      @bobsmith (555555555)
Reason:    Repeated invalid URL submissions
Duration:  Indefinite
Issued:    2026-06-02 19:30 UTC

They won't even know we exist anymore.

Sets `users.is_allowed = 0`, `banned_at = now`, `ban_reason = reason`.
Also marks user as `is_allowed=0` in DB. Auth middleware silently drops all their messages.
Cannot ban OWNER_ID — guard prevents it.

### ✅ /pardon <id> — Unban a user


✅ PARDON GRANTED

User:      @bobsmith (555555555)
Restored:  2026-06-02 20:00 UTC

They're back. Let's see if they behave.

Sets `is_allowed = 1`, clears ban fields.

### 🔒 /lockup — List banned users


🔒 The Lockup (Banned Users)

555555555  @bobsmith    12 dl    2026-06-02  Spam
333444555  @spammer     1 dl     2026-05-20  Advertising
111222333  @abuser      0 dl     2026-04-10  Harassment

Total: 3 inmates

### 🧹 /sweep — Clean temp files


🧹 Sweep Complete

Cleaned:  47 temp files
Freed:    128 MB
Running:  0 active downloads skipped

Reads `TEMP_DIR`, deletes all `.mp4`, `.webm`, `.mp3` files not currently in use by active downloads.

### 📋 /log [lines] — View recent error logs


📋 Recent Errors (last 20 lines)

[19:45:12] ERROR: yt-dlp exit code 1 — Private video
[19:30:01] ERROR: File too large: 89 MB (limit: 50 MB)
[18:15:44] ERROR: Invalid URL: file:///etc/passwd
[17:00:00] ERROR: Download timed out after 120s

Reads from pino's log output (or a log file if configured).

 (5/9)
[03/06/2026 02:46] eko-herm: ## Implementation Pattern

Every admin handler follows this exact structure:

typescript
// handlers/admin.ts
import { requireAdmin } from '../middleware/adminOnly'
import { adminService } from '../services/admin'
import { writeQueue } from '../db/queue'
import { bot } from '../bot'

bot.command("pulse", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  await ctx.reply(adminService.buildPulse())
})

bot.command("stats", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  await ctx.reply(adminService.buildStats(), { parse_mode: "Markdown" })
})

bot.command("roster", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const page = parseInt(ctx.match) || 1
  await ctx.reply(adminService.listUsers(page), { parse_mode: "Markdown" })
})

bot.command("dossier", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const id = parseInt(ctx.match)
  if (!id) return await ctx.reply("Usage: /dossier <telegram_id>")
  await ctx.reply(adminService.getUserDossier(id), { parse_mode: "Markdown" })
})

bot.command("lookup", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const query = ctx.match.trim()
  if (!query) return await ctx.reply("Usage: /lookup @username or /lookup 123456789")
  await ctx.reply(adminService.lookupUser(query), { parse_mode: "Markdown" })
})

bot.command("quarantine", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const [idStr, ...reasonParts] = ctx.match.split(" ")
  const id = parseInt(idStr)
  if (!id) return await ctx.reply("Usage: /quarantine <telegram_id> [reason]")
  if (id === env.OWNER_ID) return await ctx.reply("⛔ Cannot quarantine the admin.")

  const reason = reasonParts.join(" ") || "No reason specified"
  await writeQueue.enqueue(() => adminService.banUser(id, reason))
  await ctx.reply(adminService.buildBanNotice(id, reason), { parse_mode: "Markdown" })
})

bot.command("pardon", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const id = parseInt(ctx.match)
  if (!id) return await ctx.reply("Usage: /pardon <telegram_id>")
  await writeQueue.enqueue(() => adminService.unbanUser(id))
  await ctx.reply(adminService.buildPardonNotice(id), { parse_mode: "Markdown" })
})

bot.command("lockup", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  await ctx.reply(adminService.listBanned(), { parse_mode: "Markdown" })
})

bot.command("sweep", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const result = adminService.sweepTempFiles()
  await ctx.reply(result, { parse_mode: "Markdown" })
})

bot.command("log", async (ctx) => {
  if (!await requireAdmin(ctx)) return
  const lines = parseInt(ctx.match) || 20
  await ctx.reply(adminService.getRecentLogs(lines), { parse_mode: "Markdown" })
})

## Database Tracking (services/tracker.ts)

Every download is logged. Users auto-register on first interaction.

 (6/9)
[03/06/2026 02:46] eko-herm: typescript
import { writeQueue } from '../db/queue'

export function trackStart(userId: number, chatId: number, url: string, platform: string): Promise<number> {
  return writeQueue.enqueue(() => {
    db.run("INSERT OR IGNORE INTO users (telegram_id) VALUES (?)", userId)
    const stmt = db.prepare(
      "INSERT INTO downloads (user_id, chat_id, url, platform, status) VALUES (?, ?, ?, ?, 'started')"
    )
    return stmt.run(userId, chatId, url, platform).lastInsertRowid as number
  })
}

export function trackComplete(id: number, fileSize: number, durationMs: number, format: string, userId: number): Promise<void> {
  return writeQueue.enqueue(() => {
    db.run(
      "UPDATE downloads SET status='completed', file_size=?, duration_ms=?, format=?, completed_at=datetime('now') WHERE id=?",
      fileSize, durationMs, format, id
    )
    db.run(
      "UPDATE users SET total_downloads=total_downloads+1, total_bytes=total_bytes+?, updated_at=datetime('now') WHERE telegram_id=?",
      fileSize, userId
    )
  })
}

export function trackError(id: number, error: string): Promise<void> {
  return writeQueue.enqueue(() => {
    db.run(
      "UPDATE downloads SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?",
      error, id
    )
  })
}

## Proxy System (services/proxy.ts)

Three-tier proxy system to avoid IP-based blocking by Google/YouTube and other platforms.

### Priority chain

1. **`PROXY_URL`** (env var) — manual proxy, always takes top priority if set
2. **Auto-pool** — fetches ~5000 free proxies from iplocate/free-proxy-list (updated every 30 min)
3. **Tor** — `--tor on` flag passed to yt-dlp (requires `tor` package in Docker)

### How it works

```
initProxyPool() called on startup
  → if PROXY_URL is set → skip pool (manual mode)
  → if PROXY_ENABLED=false → skip pool
  → fetch list from GitHub raw (all-proxies.txt)
  → test batches of 30 in parallel against Google (5s timeout), measure latency (Date.now())
  → sort working proxies by latency (fastest first)
  → keep up to 10 fastest proxies in memory
  → refresh pool every 10 minutes in background

getProxy() called per download
  → return PROXY_URL if set (manual)
  → return proxyPool[0] (fastest available)
  → return null if pool empty (caller falls back to Tor)

reportFailure(proxy) called on download error
  → remove failing proxy from pool (splice via indexOf)
  → next call picks the new fastest (index 0)
```

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | `""` | Manual proxy URL (http/https/socks5). Disables auto-pool. |
| `PROXY_ENABLED` | `true` | Enable free proxy auto-pool |
| `TOR_ENABLED` | `true` | Enable Tor fallback |

### Proxy integration in downloader.ts

- `buildYtDlpArgs()` calls `getProxy()` → appends `--proxy <url>` if available
- If `getProxy()` returns null and `TOR_ENABLED=true` → appends `--tor on`
- On RATE_LIMITED, PLATFORM_BLOCKED, TIMEOUT, or UNKNOWN errors → calls `reportFailure()` and retries with a different proxy
- `listFormats()` also uses proxy/Tor

## Security Standards

### Input validation
- Validate URLs before passing to yt-dlp — reject non-http schemes
- Strip whitespace, null bytes, shell metacharacters
- Never interpolate user input into command arguments

typescript
export function validateUrl(input: string): string | null {
  const cleaned = input.trim().replace(/[\0\n\r]/g, "")
  if (!/^https?:\/\//i.test(cleaned)) return null
  try { new URL(cleaned); return cleaned }
  catch { return null }
}

### Rate limiting
- Max 1 concurrent download per user
- 10s cooldown between downloads per user
- Tracked in-memory (Map<userId, timestamp>)

### Process safety
- `Bun.spawn` with array arguments only — no shell injection
- Never use `Bun.spawnSync(["sh", "-c", userInput])`
- yt-dlp args are hardcoded, user input is the URL only

### Admin safety
- `OWNER_ID` can never quarantine themselves — explicit guard
- Banned users are silently ignored by auth middleware

## No Persisted Media — Hard Rule

**The server stores ZERO video/audio files after delivery. This is non-negotiable.**

### Lifecycle of a file


1. yt-dlp writes file to TEMP_DIR (e.g., /tmp/bun-video-bot/abc123.mp4)
2. Bot reads file, sends it via bot.api.sendVideo(chatId, InputFile(path))
3. IMMEDIATELY after sendVideo resolves → fs.unlink(path) is called
4. File is gone. Only the DB record remains (url, size, duration — metadata only)

### Implementation pattern

typescript
// In the download handler — this must be in a try/finally block
const filePath = path.join(env.TEMP_DIR, ${videoId}.mp4)
let sent = false

try {
  await downloadVideo(url, filePath, onProgress)

  await ctx.reply("✅ Processing video...")
  await ctx.api.sendVideo(chatId, InputFile(filePath))

  sent = true
  await ctx.api.editMessageText(chatId, statusMsgId, "✅ Downloaded!")
} catch (err) {
  await ctx.api.editMessageText(chatId, statusMsgId, ❌ Error: ${err.message})
} finally {
  // ALWAYS delete — success, failure, crash recovery
  try { await fs.unlink(filePath) } catch {}
}

### What gets deleted
- The video/audio file itself
- Any yt-dlp part files (`*.part`, `*.ytdl`) — these are ephemeral and cleaned in the same TEMP_DIR
- Directories are left alone (the TEMP_DIR itself is ephemeral per container)

### What does NOT get deleted
- The SQLite DB — that's your audit trail. Metadata only, no media bytes.
- Log files

### Sweep /pulse alignment
- `/pulse` shows `Temp: 0 MB (0 files)` under normal operation because nothing persists
 (7/9)
[03/06/2026 02:46] eko-herm: - `/sweep` primarily exists for crash-recovery cleanup (orphaned files from a container restart)
- If `/pulse` ever shows >0 temp files, something is wrong — investigate immediately

## Progress Bar System

yt-dlp outputs progress to **stderr** with `--newline`. Each line:


[download]  45.3% of ~15.44MiB at 2.34MiB/s ETA 00:03

**States:** 📥 Starting → ▰▰▰▰▱▱▱▱ (45%) ... → 🧩 Merging → 📤 Uploading → ✅ Done! → ❌ Error

**Progress bar renderer (progress.ts):**

typescript
function renderProgressBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width)
  return "▰".repeat(filled) + "▱".repeat(width - filled)
}

function renderProgressText(pct: string, speed: string, eta: string): string {
  const num = parseFloat(pct) || 0
  const bar = renderProgressBar(num)
  return ⏬ Downloading...\n${bar} ${pct}%\n⚡ ${speed}  ⏱ ${eta}
}

**Throttle:** Edit status message max once per 2s per chat. Track `lastEditTime` per chatId.

## Bot Commands

### Public (no auth required)

| Command | Description |
|---------|-------------|
| `/start` | 👋 Welcome + how to use |
| `/help` | 📖 Supported platforms + examples |
| `/about` | ℹ️ Bot info |

### Authorized users only

| Command | Description |
|---------|-------------|
| `<video URL>` | ⏬ Download and send |

### Admin only (verified against .env OWNER_ID)

| Command | Description |
|---------|-------------|
| `/panel` | 👑 Admin command centre |
| `/pulse` | 💓 Bot health & uptime |
| `/stats` | 📊 Full bot statistics |
| `/beat` | 📡 Live activity feed |
| `/top` | 🏆 Top downloaders leaderboard |
| `/genre` | 🎬 Platform breakdown chart |
| `/roster` | 👥 User list (paginated) |
| `/lookup` | 🔍 Search for a user |
| `/dossier` | 📋 Full user deep dive |
| `/quarantine` | 🚫 Ban a user |
| `/pardon` | ✅ Unban a user |
| `/lockup` | 🔒 List banned users |
| `/sweep` | 🧹 Clean temp files |
| `/log` | 📋 View recent error logs |

## No Watermarks — Hard Requirement

**Videos delivered to users must NEVER contain watermarks.** This applies to both the bot's own output and the download source.

### How it's enforced

| Platform | Risk | Mitigation |
|----------|------|------------|
| **TikTok** | High — TikTok adds username watermark to API downloads | yt-dlp uses the **wm=0** or **no-watermark** endpoint internally. Always test with `--no-watermark` flag. If a TikTok URL produces a watermarked video, use `--extractor-args "tiktok:no_watermark=true"`. |
| **All platforms** | Bot adds watermark | The bot NEVER re-encodes, overlays, or stamps videos. It downloads and forwards the raw stream. Zero processing beyond what yt-dlp + FFmpeg merging requires. |
| **yt-dlp itself** | None — yt-dlp does not add watermarks | Keep yt-dlp updated to latest version for best platform support. |

### TikTok-specific safeguard

typescript
// yt-dlp args for TikTok: always enforce no-watermark
const tiktokArgs = [
  "--extractor-args", "tiktok:no_watermark=true",
  ...baseArgs
]

### What this means

- The bot is a **pure pipe**: URL → yt-dlp → raw file → Telegram
- No re-encoding, no transcoding, no overlays, no stamps
- If a platform serves a watermarked version as the only option (rare — currently only some TikTok regions), the download should fail rather than deliver a watermarked file
- Log a warning if yt-dlp returns a platform-known-to-watermark and the file isn't verified clean

### Verification

typescript
// Optional: check if the file is likely watermarked (future enhancement)
// Currently no reliable programmatic check — rely on yt-dlp extractor args

## yt-dlp Usage Guidelines

- Format: `best[ext=mp4]` for video, `bestaudio/best` for audio
- Always: `--no-playlist`, `--no-cache-dir`, `--newline`
- Always: `--max-filesize ${MAX_FILE_SIZE_MB}M`
- **TikTok: append `--extractor-args "tiktok:no_watermark=true"`**
- Output template: `-o "${TEMP_DIR}/%(id)s.%(ext)s"`
- `Bun.spawn` with array args only

 (8/9)
[03/06/2026 02:46] eko-herm: ## Format Parsing Fix (parseFormats)

Two critical bugs were fixed in `parseFormats()`:

1. **Header detection** — was looking for `---` separator in yt-dlp `-F` output. Modern yt-dlp may not output this (or uses Unicode box-drawing chars). Fixed to detect the `"Available formats"` line instead, which is version-agnostic.

2. **hasAudio detection** — was checking `fields[5] === "2"` (column is bitrate/TBR, never `"2"`). Changed to `!trimmed.includes("video only")` — combined formats have an audio codec in the ACODEC column, video-only DASH formats say `"video only"`.

3. **Dedup priority** — combined formats (e.g., format 22 at 720p) now correctly replace video-only DASH formats at the same resolution instead of being discarded.

4. **Logging** — warns when `listFormats` returns empty (visible in container logs for debugging).

## User-Facing Message Flow (Set D emojis)

The following emoji pipeline appears in Telegram:

```
🔍 Checking available resolutions...    ← formats being fetched
🎬 Select resolution for:                ← user picks quality
📥 Downloading (720p)...                 ← download starts
│  ⠋ 📥 Downloading 45.2%               ← animated progress bar
│  ▰▰▰▰▰▱▱▱▱▱                           ← (live updates)
│  ⚡ 2.5MiB/s  ⏱ 0:45
│
🧩 Merging streams...                    ← post-download merge
📤 Uploading to Telegram...              ← sending video
✅ Done!                                 ← complete

❌ Video is private                      ← minimal errors (no stderr leak)
❌ Download failed
```

Error messages are kept minimal — full stderr/exit code is logged server-side but user only sees a short reason (e.g. `"Video is private"`, `"Rate limited, try again later"`, `"Download failed"`).

## Logging

typescript
import pino from "pino"
export const logger = pino({
  level: env.LOG_LEVEL,
  transport: process.env.NODE_ENV === "development"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
})

## Dependencies

bash
bun add grammy zod pino
bun add -d @types/node pino-pretty

yt-dlp and FFmpeg are system deps — installed via Dockerfile.

## Deployment

bash
docker build -t bun-video-bot .
docker run -d \
  --name video-bot \
  -e BOT_TOKEN=<from BotFather> \
  -e OWNER_ID=<your id> \
  -e ALLOWED_USERS=123456789,987654321 \
  -e ALLOWED_GROUPS=-1001234567890 \
  -v ./data:/app/data \
  --restart unless-stopped \
  bun-video-bot

Mount `./data` as a volume so SQLite persists across restarts.

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| YouTube | ✅ | Clean, no watermarks |
| Twitter/X | ✅ | Clean, no watermarks |
| TikTok | ✅ | Enforced via `--extractor-args tiktok:no_watermark=true` |
| Instagram | ✅ | Clean, no watermarks |
| Snapchat | ⚠️ Spotlight only | No private snaps (E2E encrypted) |
| Anything else | ✅ | yt-dlp covers 1000+ — monitor for watermark issues per platform |

## Future: Payment Tier

When payments are needed, a separate Hono process handles Paystack webhooks. Shares the same `data/bot.db`.

## Key Principles

- **One process, one concern** — the bot polls Telegram, that's it
- **Serialize all writes** — every DB write through `writeQueue.enqueue()`
- **Fail fast** — invalid .env crashes at startup, not at runtime
- **Admin guard is explicit** — every admin handler starts with `requireAdmin()`
- **Never trust user input** — validate URLs, array args, sanitize
- **Cleanup is mandatory** — temp files cleaned on success, crash, and SIGTERM
- **Zero persisted media** — file deleted from disk immediately after sendVideo resolves. Only metadata in SQLite.
- **No watermarks** — pure pipe from source to user. No re-encoding, no overlays, no stamps.

