import { writeQueue } from "../db/queue";
import {
  upsertUser,
  insertDownload,
  updateDownloadStatus,
  incrementUserStats,
  getUserByTelegramId,
  setUserAsOwner,
} from "../db";
import type { DownloadError } from "../types";
import { detectPlatform } from "../utils/url";
import { env } from "../config";

/**
 * Track a download from start to completion or error.
 * All DB writes go through the serial write queue (per AGENT.md design constraint).
 */
export const tracker = {
  /**
   * Record the start of a download.
   */
  async trackStart(
    telegramId: number,
    chatId: number,
    url: string,
    username?: string | null,
    firstName?: string | null,
    lastName?: string | null,
  ): Promise<number> {
    return writeQueue.enqueue(() => {
      // Upsert user first — we need the internal ID for the FK
      upsertUser(telegramId, username, firstName, lastName);
      const user = getUserByTelegramId(telegramId);
      if (!user) throw new Error("Failed to upsert user");

      // Check if owner id and set flag
      if (telegramId === env.OWNER_ID && user.is_owner === 0) {
        setUserAsOwner(telegramId);
      }

      const platform = detectPlatform(url);
      return insertDownload(user.id, chatId, url, platform);
    });
  },

  /**
   * Record a successful download.
   */
  async trackComplete(
    downloadId: number,
    fileSize: number,
    format: string,
    telegramId: number,
  ): Promise<void> {
    await writeQueue.enqueue(() => {
      updateDownloadStatus(downloadId, "completed", fileSize, null, format);
      incrementUserStats(telegramId, fileSize);
    });
  },

  /**
   * Record a failed download.
   */
  async trackError(
    downloadId: number,
    error: DownloadError,
    retryCount?: number,
  ): Promise<void> {
    await writeQueue.enqueue(() => {
      updateDownloadStatus(
        downloadId,
        "failed",
        null,
        null,
        null,
        error.code,
        error.message,
        retryCount,
      );
    });
  },
};
