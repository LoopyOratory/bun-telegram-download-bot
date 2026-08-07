import { statfs } from "node:fs/promises";
import { env } from "../config";
import { DownloadError, DownloadErrorCode } from "../types";

/** Free-space floor required before starting a download (bytes). */
export const MIN_FREE_DISK_BYTES = 200 * 1024 * 1024;

/** Total download timeout in seconds (env-configurable) */
export const DOWNLOAD_TIMEOUT_SECONDS = env.DOWNLOAD_TIMEOUT_SECONDS;

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
 * Refuse to download only when the target volume is running out of space.
 * The constraint is storage availability, not an arbitrary byte cap — the
 * same model Seal uses: download any size, fail when the disk is full.
 */
export async function ensureDiskFree(dir: string): Promise<void> {
  const { bavail, bsize } = await statfs(dir);
  const freeBytes = bavail * bsize;
  if (freeBytes < MIN_FREE_DISK_BYTES) {
    throw new DownloadError(
      DownloadErrorCode.NO_DISK_SPACE,
      `Not enough free disk space (${(freeBytes / 1024 / 1024).toFixed(0)} MB free). Free some space in ${dir} and try again.`,
    );
  }
}