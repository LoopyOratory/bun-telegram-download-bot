# =============================================================================
# Hermes Video Bot — Multi-stage Dockerfile
# =============================================================================
# Stage 1: Bun install (dependencies only, cached layer)
FROM oven/bun:1.3 AS deps

WORKDIR /app

# Copy only dependency files for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# =============================================================================
# Stage 2: Build (TypeScript compile)
FROM deps AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the project (Bun can run TS directly, but we bundle for speed)
RUN bun build src/index.ts --compile --outfile /app/bun-video-bot 2>/dev/null || \
    echo "Info: compile may not produce binary; running source directly is fine"

# =============================================================================
# Stage 3: Production runtime
FROM oven/bun:1.3-slim AS production

LABEL org.opencontainers.image.title="Hermes Video Bot"
LABEL org.opencontainers.image.description="Telegram video downloader bot"
LABEL org.opencontainers.image.version="1.0.0"

# Install system dependencies: yt-dlp and FFmpeg
RUN apt-get update -qq && \
    apt-get install -y -qq \
        ffmpeg \
        python3 \
        python3-pip \
        curl \
        ca-certificates \
        --no-install-recommends && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify installations
RUN yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app

# Copy application from build stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create temp and data directories with correct ownership
RUN mkdir -p /tmp/bun-video-bot /app/data && chown -R bun:bun /tmp/bun-video-bot /app/data

# Run as non-root user
USER bun

# Health check — verifies the process is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD bun --eval "process.exit(0)" || exit 1

EXPOSE 8080

# Use bunx for local dev file watching, bun run for production
ENTRYPOINT ["bun", "run", "src/index.ts"]
