<p align="center">
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/Bun-Dark.svg" width="64" alt="Bun" />
  <img src="https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/TypeScript.svg" width="64" alt="TypeScript" />
</p>

<h1 align="center">📹 Bunny Video Bot</h1>

<p align="center">
  <strong>Autonomous Telegram video downloader. Send a URL, get the file.</strong><br>
  YouTube • Twitter/X • TikTok • Instagram • Snapchat • 1000+ sites<br>
  <em>No watermarks. No stored files. Pure pipe.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-ff69b4?logo=bun&labelColor=1a1a2e" alt="Bun" />
  <img src="https://img.shields.io/badge/tests-74%2F74%20passing-success?labelColor=1a1a2e" alt="Tests" />
  <img src="https://img.shields.io/badge/docker-ready-blue?logo=docker&labelColor=1a1a2e" alt="Docker" />
  <img src="https://img.shields.io/badge/license-MIT-green?labelColor=1a1a2e" alt="License" />
</p>

---

## ✨ Features

- **🔗 Universal Support** — 1000+ platforms via yt-dlp (YouTube, Twitter/X, TikTok, Instagram, Snapchat, Vimeo, and more)
- **🚫 No Watermarks** — TikTok downloads are watermark-free by default; the bot never re-encodes or stamps media
- **💨 Instant Cleanup** — files are deleted from disk milliseconds after delivery; only metadata lives in SQLite
- **🛡️ Authorized Access** — configurable allowlists for users and groups; banned users are silently dropped
- **📊 Admin Dashboard** — 14 admin commands for stats, user management, moderation, and system maintenance
- **🔥 Retry Logic** — automatic retries with exponential backoff for transient failures (timeouts, rate limits)
- **🔌 Smart Proxy** — three-tier proxy system: manual `PROXY_URL` → auto-discovered free proxy pool → Tor fallback. Rotates on failure.
- **📈 Progress Tracking** — real-time download progress with animated status bar
- **🐳 Docker Ready** — multi-stage Dockerfile with healthcheck and docker-compose for one-command deployment
- **⚡ Bun Native** — built on Bun's zero-config runtime: SQLite, test runner, package manager — all built in

---

## 🚀 Quick Start

### Prerequisites

- **Bun** ≥ 1.3 (or Docker)
- **yt-dlp** ≥ 2024 (auto-installed in Docker)
- **FFmpeg** (auto-installed in Docker)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### 1. Clone & Configure

```bash
git clone https://github.com/your-org/bun-video-bot.git
cd bun-video-bot
cp .env.example .env
```

Edit `.env` with your credentials:

```env
BOT_TOKEN=61164694...r   # from @BotFather
OWNER_ID=531264503     # your Telegram user ID

# Optional — restrict who can use the bot
ALLOWED_USERS=531264503,987654321
ALLOWED_GROUPS=-1001234567890
```

### 2. Run

```bash
# Native (needs Bun + yt-dlp + ffmpeg installed)
bun install
bun run dev

# Docker (everything included)
docker compose up -d
```

### 3. Use

Open Telegram, find your bot, and send:

```
https://www.youtube.com/watch?v=dQw4w9WgXcQ
https://www.tiktok.com/@user/video/123456789
```

---

## 📋 Commands

### Public

| Command | Description |
|---|---|
| `/start` | Welcome message and instructions |
| `/help` | Supported platforms and usage examples |
| `/about` | Bot version and tech stack info |
| `<video URL>` | Download and receive the file |

### Admin Only

| Category | Command | Description |
|---|---|---|
| **Dashboard** | `/panel` | Command centre overview |
| | `/pulse` | Bot health, uptime, memory, disk |
| | `/stats` | Full statistics with visual breakdown |
| | `/beat` | Live feed of recent downloads |
| | `/top` | Top downloaders leaderboard |
| | `/genre` | Platform breakdown chart |
| **Users** | `/roster` | Paginated user list |
| | `/lookup @user` | Search by username or ID |
| | `/dossier <id>` | Full user profile and history |
| **Moderation** | `/quarantine <id>` | Ban a user |
| | `/pardon <id>` | Unban a user |
| | `/lockup` | List all banned users |
| **System** | `/sweep` | Clean orphaned temp files |
| | `/log` | View recent error logs |

---

## 🏗️ Architecture

```
User sends URL
  → Auth middleware (check ALLOWED_USERS/GROUPS + ban list)
  → Rate limiter (1 concurrent, 10s cooldown)
  → Proxy resolution: PROXY_URL → auto-pool → Tor → direct
  → yt-dlp download (--proxy or --tor, Bun.spawn, no shell injection)
  → Progress bar (live Telegram message edits, 2s throttle)
  → sendVideo (file uploaded to Telegram)
  → immediately unlink(filePath) — file gone
  → DB write via serial queue (WAL mode for concurrent reads)
```

```
src/
├── bot.ts              # Grammy bot instance + middleware pipeline
├── config.ts           # Zod-validated .env — fail fast
├── types.ts            # Shared types + classified error codes
├── progress.ts         # Real-time progress bar renderer
├── cleanup.ts          # File lifecycle + crash recovery
├── index.ts            # Entry point — wires everything together
├── db/
│   ├── schema.ts       # SQL schema (WAL mode, 7 indexes)
│   ├── queue.ts        # Serial write queue (SQLite single-writer)
│   └── index.ts        # All query functions
├── middleware/
│   ├── auth.ts         # User/group allowlist + ban enforcement
│   ├── ratelimit.ts    # Per-user concurrency + cooldown
│   ├── adminOnly.ts    # OWNER_ID guard for admin commands
│   └── logger.ts       # Request logging with latency
├── services/
│   ├── downloader.ts   # yt-dlp wrapper with progress + retry
│   ├── proxy.ts        # Proxy pool (free list + Tor fallback)
│   ├── tracker.ts      # Download audit logging
│   └── admin.ts        # Formatted admin responses
├── handlers/
│   ├── general.ts      # /start /help /about
│   ├── download.ts     # URL → download → send → cleanup
│   └── admin.ts        # 14 admin commands
└── utils/
    ├── url.ts          # Validation + platform detection
    ├── format.ts       # File size, duration, progress bar
    ├── limits.ts       # Constants + file size enforcement
    └── logger.ts       # Pino structured logger
```

---

## 🔧 Configuration

| Variable | Default | Description |
|---|---|---|
| `BOT_TOKEN` | *required* | Telegram bot token from @BotFather |
| `OWNER_ID` | *required* | Telegram user ID of the admin |
| `ALLOWED_USERS` | `""` | Comma-separated user IDs |
| `ALLOWED_GROUPS` | `""` | Comma-separated group IDs (negative) |
| `MAX_FILE_SIZE_MB` | `50` | Maximum download size in megabytes |
| `LOG_LEVEL` | `info` | Pino log level (trace → fatal) |
| `PROXY_URL` | `""` | Manual proxy (takes priority). Supports http://, https://, socks5:// |
| `PROXY_ENABLED` | `true` | Enable auto-discovered free proxy pool from iplocate/free-proxy-list |
| `TOR_ENABLED` | `true` | Enable Tor fallback when no proxies available (requires tor package) |
| `TEMP_DIR` | `/tmp/bun-video-bot` | Temporary download directory |
| `DATABASE_PATH` | `./data/bot.db` | SQLite database location |
| `NODE_ENV` | `development` | Environment (development/production/test) |

---

## 🐳 Docker

```bash
# Build
docker build -t bun-video-bot .

# Run with docker compose
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

The Docker image includes:
- **Bun 1.3** runtime (slim base, ~130MB)
- **yt-dlp** (latest via pip, with `--break-system-packages`)
- **FFmpeg 7.1** (for DASH stream merging)
- **Tor** (for anonymous fallback when proxies fail)
- **Healthcheck** every 30s
- **Auto-restart** on crash (`unless-stopped`)
- **Log rotation** (10MB max, 3 files)

---

## 🧪 Development

```bash
# Install deps
bun install

# Run with hot reload
bun run dev

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Run with coverage
bun test --coverage

# Typecheck
bun run typecheck

# Build standalone binary
bun run build
```

### Test Coverage

| Area | Tests | Description |
|---|---|---|
| **Config** | 7 | Zod schema validation, defaults, coercion |
| **Database** | 11 | Schema creation, CRUD, write queue |
| **Errors** | 19 | DownloadError class + yt-dlp stderr classification |
| **URL Utils** | 16 | Validation, sanitization, platform detection |
| **Format Utils** | 13 | File size, duration, progress bar rendering |
| **Admin Output** | 6 | Formatted message structure |
| **Limits** | 3 | File size enforcement |
| **Total** | **74** | All passing |

---

## 🔒 Security

- **No shell injection** — `Bun.spawn()` with array arguments only; user input is never interpolated into commands
- **URL validation** — rejects non-HTTP schemes (`file://`, `javascript:`, etc.), null bytes, and shell metacharacters
- **Auth middleware** — every message checked against `ALLOWED_USERS`/`ALLOWED_GROUPS` before processing
- **Ban system** — banned users are silently ignored at the middleware level
- **Admin guard** — explicit `requireAdmin()` check on every admin command; owner cannot ban themselves
- **No persisted media** — files deleted in a `finally` block; crash orphans cleaned on startup via `/sweep`

---

## 📄 License

MIT

---

<p align="center">
  <sub>Built with ❤️ using <a href="https://bun.sh">Bun</a> · <a href="https://grammy.dev">grammY</a> · <a href="https://github.com/yt-dlp/yt-dlp">yt-dlp</a></sub>
</p>
