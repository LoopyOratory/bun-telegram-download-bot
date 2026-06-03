import { env } from "../config";
import { DownloadError, DownloadErrorCode } from "../types";

/** Max file size in bytes */
export const MAX_FILE_SIZE_BYTES = env.MAX_FILE_SIZE_MB * 1024 * 1024;

/** Max download timeout in seconds */
export const DOWNLOAD_TIMEOUT_SECONDS = 300; // 5 min

/** Max concurrent downloads per user */
export const MAX_CONCURRENT_PER_USER = 1;

/** Cooldown between downloads per user (ms) */
export const DOWNLOAD_COOLDOWN_MS = 10_000;

/** Progress update throttle (ms) */
export const PROGRESS_UPDATE_THROTTLE_MS = 2_000;

/** Max retries for transient download failures */
export const MAX_DOWNLOAD_RETRIES = 2;

/** Retry delay base (ms) — exponential backoff */
export const RETRY_DELAY_BASE_MS = 2_000;

/**
 * Check if file size exceeds the configured limit.
 * Throws a classified error if so.
 */
export function checkFileSizeLimit(bytes: number): void {
  if (bytes > MAX_FILE_SIZE_BYTES) {
    throw new DownloadError(
      DownloadErrorCode.FILE_TOO_LARGE,
      `File too large: ${(bytes / 1024 / 1024).toFixed(1)} MB (limit: ${env.MAX_FILE_SIZE_MB} MB)`,
    );
  }
}
