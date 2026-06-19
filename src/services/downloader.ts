import { spawn } from "bun";
import { mkdir, unlink } from "node:fs/promises";
import { env } from "../config";
import { logger } from "../utils/logger";
import {
  checkFileSizeLimit,
  MAX_FILE_SIZE_BYTES,
  DOWNLOAD_TIMEOUT_SECONDS,
  MAX_DOWNLOAD_RETRIES,
  RETRY_DELAY_BASE_MS,
} from "../utils/limits";
import { detectPlatform } from "../utils/url";
import { getProxy, reportFailure, getTorArgs, isTorAvailable } from "./proxy";
import {
  DownloadError,
  DownloadErrorCode,
  type ProgressEvent,
  type DownloadResult,
  type FormatInfo,
} from "../types";

/** Regex to parse yt-dlp progress line */
const PROGRESS_REGEX =
  /\[download\]\s+(\d+\.?\d*)%.*?at\s+([\d.]+[KMG]?i?B\/s).*?ETA\s+(\d+:\d+)/i;

interface SpawnOptions {
  url: string;
  outputPath: string;
  platform: string;
}

/**
 * Build yt-dlp arguments for a given platform.
 */
function buildYtDlpArgs({ url, outputPath, platform }: SpawnOptions, formatCode?: string): string[] {
  const fmt = formatCode || "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best";
  const args = [
    url,
    "-f", fmt,
    "-o", outputPath,
    "--no-playlist",
    "--no-cache-dir",
    "--newline",
    "--max-filesize", `${env.MAX_FILE_SIZE_MB}M`,
    "--no-warnings",
    "--merge-output-format", "mp4",
  ];

  // Platform-specific args
  if (platform === "tiktok") {
    args.push("--extractor-args", "tiktok:no_watermark=true");
  }

  // Proxy args
  const proxy = getProxy();
  if (proxy) {
    args.push("--proxy", proxy);
  } else if (isTorAvailable()) {
    args.push(...getTorArgs());
  }

  return args;
}

/**
 * Parse a single progress line from yt-dlp stderr.
 */
function parseProgressLine(line: string): ProgressEvent | null {
  const match = line.match(PROGRESS_REGEX);
  if (!match) return null;

  return {
    percent: parseFloat(match[1]),
    speed: match[2],
    eta: match[3],
    downloaded: "",
    total: "",
  };
}

/**
 * Check if yt-dlp stderr output indicates a known error.
 */
function classifyYtDlpError(stderr: string): DownloadError {
  const combined = stderr.toLowerCase();

  if (combined.includes("private video") || combined.includes("private")) {
    return new DownloadError(DownloadErrorCode.PRIVATE_VIDEO, "Video is private");
  }
  if (combined.includes("copyright") || combined.includes("blocked") || combined.includes("removed")) {
    return new DownloadError(DownloadErrorCode.PLATFORM_BLOCKED, "Content blocked by platform");
  }
  if (combined.includes("geo") || combined.includes("not available in your country")) {
    return new DownloadError(DownloadErrorCode.GEO_RESTRICTED, "Not available in your region");
  }
  if (combined.includes("rate") || combined.includes("too many requests")) {
    return new DownloadError(DownloadErrorCode.RATE_LIMITED, "Rate limited, try again later");
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
  }
  if (combined.includes("watermark")) {
    return new DownloadError(DownloadErrorCode.WATERMARK_DETECTED, "Video contains watermark");
  }
  if (combined.includes("unsupported url") || combined.includes("no video") || combined.includes("no data")) {
    return new DownloadError(DownloadErrorCode.EXTRACTOR_ERROR, "Could not extract video info");
  }

  return new DownloadError(DownloadErrorCode.UNKNOWN, "Download failed");
}

/**
 * Sleep helper for retry backoff — uses Bun native timer.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download a video using yt-dlp.
 *
 * @param url - The video URL to download
 * @param outputDir - Directory to write the file to
 * @param onProgress - Optional callback for progress updates
 * @param retryCount - Current retry attempt (internal)
 * @returns DownloadResult with file path and metadata
 */
export async function downloadVideo(
  url: string,
  outputDir: string,
  onProgress?: (event: ProgressEvent) => void,
  retryCount = 0,
  formatCode?: string,
): Promise<DownloadResult> {
  const platform = detectPlatform(url);
  const videoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = "mp4";
  const outputPath = `${outputDir}/${videoId}.${ext}`;

  // Ensure temp directory exists (mkdir is Bun-compatible via node:fs/promises)
  await mkdir(outputDir, { recursive: true });

  const args = buildYtDlpArgs({ url, outputPath, platform }, formatCode);

  logger.info({ url: url.slice(0, 100), platform, outputPath, retryCount, formatCode }, "Starting download");

  return new Promise<DownloadResult>((resolve, reject) => {
    const proc = spawn(["yt-dlp", ...args], {
      stderr: "pipe",
      stdout: "pipe",
    });

    const stderrChunks: string[] = [];
    let lastProgress: ProgressEvent | null = null;

    // Read stderr for progress
    const stderrReader = proc.stderr.getReader();
    const readStderr = async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stderrChunks.push(text);

        for (const line of text.split("\n")) {
          const progress = parseProgressLine(line);
          if (progress) {
            lastProgress = progress;
            onProgress?.(progress);
          }
        }
      }
    };

    // Read stdout (usually empty for yt-dlp)
    const stdoutReader = proc.stdout.getReader();
    const readStdout = async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        // stdout from yt-dlp is minimal, just consume it
        decoder.decode(value, { stream: true });
      }
    };

    // Timeout
    const timeoutId = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new DownloadError(DownloadErrorCode.TIMEOUT, `Download timed out after ${DOWNLOAD_TIMEOUT_SECONDS}s`));
    }, DOWNLOAD_TIMEOUT_SECONDS * 1000);

    // Wait for process
    Promise.all([readStderr(), readStdout()]).then(async () => {
      clearTimeout(timeoutId);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = stderrChunks.join("");
        const error = classifyYtDlpError(stderr);

        logger.error(
          { url: url.slice(0, 100), exitCode, errorCode: error.code, stderr: stderr.slice(0, 500), retryCount },
          "Download failed",
        );

        // Retry logic for transient errors (with proxy rotation)
        if (
          retryCount < MAX_DOWNLOAD_RETRIES &&
          (error.code === DownloadErrorCode.TIMEOUT ||
           error.code === DownloadErrorCode.RATE_LIMITED ||
           error.code === DownloadErrorCode.PLATFORM_BLOCKED ||
           error.code === DownloadErrorCode.UNKNOWN)
        ) {
          // Report current proxy failure to cycle it
          const currentProxy = getProxy();
          if (currentProxy) {
            reportFailure(currentProxy);
          }

          const delay = RETRY_DELAY_BASE_MS * Math.pow(2, retryCount);
          logger.info({ retryCount, delay, proxyFailure: !!currentProxy }, "Retrying download");
          await sleep(delay);
          try {
            const result = await downloadVideo(url, outputDir, onProgress, retryCount + 1, formatCode);
            resolve(result);
            return;
          } catch (retryErr) {
            reject(retryErr);
            return;
          }
        }

        reject(error);
        return;
      }

      // Success — verify the file with Bun-native API.
      // yt-dlp may append extensions when merging (e.g., .mkv), so search for the actual file.
      let filePath = outputPath;
      let bunFile = Bun.file(filePath);
      let fileExists = await bunFile.exists();

      if (!fileExists) {
        // Search for any file starting with our output path prefix
        const { readdir } = await import("node:fs/promises");
        try {
          const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
          const prefix = outputPath.substring(outputPath.lastIndexOf("/") + 1);
          const files = await readdir(dir);
          const match = files.find(f => f.startsWith(prefix));
          if (match) {
            filePath = `${dir}/${match}`;
            bunFile = Bun.file(filePath);
            fileExists = true;
            logger.info({ expectedPath: outputPath, actualPath: filePath }, "Found merged output file");
          }
        } catch {}
      }

      if (!fileExists) {
        reject(new DownloadError(DownloadErrorCode.UNKNOWN, "File not found after download completed"));
        return;
      }

      const stat = await bunFile.stat();

      // Check file size limit
      try {
        checkFileSizeLimit(stat.size);
      } catch (err) {
        // Clean up oversized file
        await unlink(filePath).catch(() => {});
        reject(err);
        return;
      }

      // Extract format info
      const dot = filePath.lastIndexOf(".");
      const format = dot >= 0 ? filePath.slice(dot + 1) : "mp4";

      logger.info(
        { url: url.slice(0, 100), platform, fileSize: stat.size, format },
        "Download completed",
      );

      resolve({
        filePath,
        fileSize: stat.size,
        format,
        durationMs: 0,
        videoId,
      });
    }).catch(reject);
  });
}

/**
 * List available formats for a URL using yt-dlp -F.
 * Returns unique resolutions up to 1080p with their format codes.
 */
export async function listFormats(url: string, attempt = 0): Promise<FormatInfo[]> {
  const platform = detectPlatform(url);
  const MAX_ATTEMPTS = 3;

  return new Promise((resolve) => {
    const formatArgs = ["-F", url, "--no-playlist", "--no-cache-dir", "--no-warnings"];
    const proxy = getProxy();
    if (proxy) {
      formatArgs.push("--proxy", proxy);
    } else if (isTorAvailable()) {
      formatArgs.push(...getTorArgs());
    }

    const proc = spawn(["yt-dlp", ...formatArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const chunks: string[] = [];
    const stdoutReader = proc.stdout.getReader();

    const readStdout = async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    };

    readStdout().then(async () => {
      const exitCode = await proc.exited;
      const output = chunks.join("");

      if (exitCode !== 0 || !output.includes("Available formats")) {
        if (exitCode !== 0) {
          logger.warn({ url: url.slice(0, 100), exitCode, attempt }, "listFormats: yt-dlp exited with non-zero code");
        } else {
          logger.warn({ url: url.slice(0, 100), attempt }, "listFormats: output missing 'Available formats' marker");
        }

        if (attempt < MAX_ATTEMPTS - 1) {
          const currentProxy = getProxy();
          if (currentProxy) {
            reportFailure(currentProxy);
          }

          const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt);
          logger.info({ attempt, delay, proxyFailure: !!currentProxy }, "Retrying listFormats");
          await sleep(delay);
          const formats = await listFormats(url, attempt + 1);
          resolve(formats);
          return;
        }

        resolve([]);
        return;
      }

      const formats = parseFormats(output, platform);
      resolve(formats);
    }).catch(() => resolve([]));
  });
}

/**
 * Parse yt-dlp -F output into a deduplicated list of resolutions ≤ 1080p.
 */
function parseFormats(output: string, platform: string): FormatInfo[] {
  const lines = output.split("\n");
  const seen = new Map<number, FormatInfo>();

  // Start parsing after the header line
  let pastHeader = false;
  for (const line of lines) {
    if (!pastHeader) {
      if (line.includes("Available formats")) pastHeader = true;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse the format line — extract ID, EXT, and RESOLUTION
    const fields = trimmed.split(/\s+/);
    if (fields.length < 3) continue;

    const code = fields[0];
    const ext = fields[1];

    // Skip non-video formats
    if (code === "ID" || code.startsWith("sb")) continue;
    if (ext === "mhtml" || ext === "m4a") continue;
    if (trimmed.includes("audio only")) continue;
    if (trimmed.includes("images")) continue;
    if (trimmed.includes("watermarked")) continue; // TikTok watermarked version

    // Extract resolution
    let height = 0;
    let label = "";

    // Try to parse resolution from format line like "1920x1080" or "576x1024"
    const resMatch = trimmed.match(/(\d+)x(\d+)/);
    if (resMatch) {
      const w = parseInt(resMatch[1]);
      const h = parseInt(resMatch[2]);
      height = h;
    }

    // Also check for trailing resolution like "1080p" or "720p"
    const pMatch = trimmed.match(/(\d+)p\b/);
    if (pMatch) {
      const p = parseInt(pMatch[1]);
      if (!height) height = p;
      label = `${p}p`;
    }

    // Skip if no resolution found or height > 1080
    if (!height || height > 1080) continue;

    // Build label
    if (!label) {
      if (height === 1080) label = "1080p";
      else if (height >= 720) label = "720p";
      else if (height >= 480) label = "480p";
      else if (height >= 360) label = "360p";
      else label = `${height}p`;
    }

    // Prefer mp4 over webm, prefer combined (audio+video) for YouTube
    const existing = seen.get(height);
    const isYoutube = platform === "youtube";
    const hasAudio = isYoutube && ext === "mp4" && !trimmed.includes("video only");
    const isMp4 = ext === "mp4";

    if (!existing || (isMp4 && existing.code.includes("webm")) || (hasAudio && existing.code.includes("+"))) {
      // Only append +bestaudio for YouTube video-only formats. TikTok/Instagram/etc already include audio.
      const formatCode = hasAudio ? code : (isYoutube ? `${code}+bestaudio` : code);
      seen.set(height, {
        code: formatCode,
        resolution: label,
        height,
        filesize: "",
      });
    }
  }

  // Sort by height descending, take unique resolutions
  const formats = Array.from(seen.values())
    .sort((a, b) => b.height - a.height)
    .filter((f, i, arr) => arr.findIndex(x => x.height === f.height) === i);

  // Limit to max 6 options
  return formats.slice(0, 6);
}
