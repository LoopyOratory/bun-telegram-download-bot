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
import {
  DownloadError,
  DownloadErrorCode,
  type ProgressEvent,
  type DownloadResult,
} from "../types";

/** Regex to parse yt-dlp progress line */
const PROGRESS_REGEX =
  /\[download\]\s+(\d+\.?\d*)%.*?at\s+([\d.]+[KMG]?i?B\/s]).*?ETA\s+(\d+:\d+)/i;

interface SpawnOptions {
  url: string;
  outputPath: string;
  platform: string;
}

/**
 * Build yt-dlp arguments for a given platform.
 */
function buildYtDlpArgs({ url, outputPath, platform }: SpawnOptions): string[] {
  const args = [
    url,
    "-f", "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
    "-o", outputPath,
    "--no-playlist",
    "--no-cache-dir",
    "--newline",
    "--max-filesize", `${env.MAX_FILE_SIZE_MB}M`,
    "--no-warnings",
  ];

  // Platform-specific args
  if (platform === "tiktok") {
    args.push("--extractor-args", "tiktok:no_watermark=true");
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
    return new DownloadError(DownloadErrorCode.PRIVATE_VIDEO, "This video is private or unavailable");
  }
  if (combined.includes("copyright") || combined.includes("blocked") || combined.includes("removed")) {
    return new DownloadError(DownloadErrorCode.PLATFORM_BLOCKED, "Content blocked or removed by platform");
  }
  if (combined.includes("geo") || combined.includes("not available in your country")) {
    return new DownloadError(DownloadErrorCode.GEO_RESTRICTED, "Video is geo-restricted");
  }
  if (combined.includes("rate") || combined.includes("too many requests")) {
    return new DownloadError(DownloadErrorCode.RATE_LIMITED, "Rate limited by platform");
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
  }
  if (combined.includes("watermark")) {
    return new DownloadError(DownloadErrorCode.WATERMARK_DETECTED, "Video contains watermark — download rejected");
  }
  if (combined.includes("unsupported url") || combined.includes("no video") || combined.includes("no data")) {
    return new DownloadError(DownloadErrorCode.EXTRACTOR_ERROR, "yt-dlp could not extract video: " + stderr.split("\n")[0].trim());
  }

  return new DownloadError(DownloadErrorCode.UNKNOWN, stderr.split("\n").slice(0, 3).join("; ").trim());
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
): Promise<DownloadResult> {
  const platform = detectPlatform(url);
  const videoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = "mp4";
  const outputPath = `${outputDir}/${videoId}.${ext}`;

  // Ensure temp directory exists (mkdir is Bun-compatible via node:fs/promises)
  await mkdir(outputDir, { recursive: true });

  const args = buildYtDlpArgs({ url, outputPath, platform });

  logger.info({ url: url.slice(0, 100), platform, outputPath, retryCount }, "Starting download");

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

        // Retry logic for transient errors
        if (
          retryCount < MAX_DOWNLOAD_RETRIES &&
          (error.code === DownloadErrorCode.TIMEOUT ||
           error.code === DownloadErrorCode.RATE_LIMITED ||
           error.code === DownloadErrorCode.UNKNOWN)
        ) {
          const delay = RETRY_DELAY_BASE_MS * Math.pow(2, retryCount);
          logger.info({ retryCount, delay }, "Retrying download");
          await sleep(delay);
          try {
            const result = await downloadVideo(url, outputDir, onProgress, retryCount + 1);
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

      // Success — verify the file with Bun-native API
      const filePath = outputPath;
      const bunFile = Bun.file(filePath);
      const fileExists = await bunFile.exists();
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
