import { readdir, unlink } from "node:fs/promises";
import { env } from "./config";
import { logger } from "./utils/logger";

/**
 * Cleanup a single file after sendVideo completes.
 * Never throws.
 */
export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
    logger.debug({ filePath }, "Temp file deleted");
  } catch (err) {
    logger.warn({ filePath, err: (err as Error).message }, "Failed to delete temp file");
  }
}

/**
 * Cleanup all orphaned temp files on startup / crash recovery.
 * Scans TEMP_DIR for media files and deletes everything.
 */
export async function cleanupOrphans(): Promise<void> {
  const tempDir = env.TEMP_DIR;
  try {
    const files = await readdir(tempDir);
    const mediaExts = [".mp4", ".webm", ".mp3", ".part", ".ytdl"];
    let cleaned = 0;

    for (const file of files) {
      if (mediaExts.some((ext) => file.endsWith(ext))) {
        try {
          await unlink(`${tempDir}/${file}`);
          cleaned++;
        } catch { /* skip files in use */ }
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, "Cleaned up orphaned temp files on startup");
    }
  } catch (err) {
    // ENOENT = no temp dir yet, that's fine
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") {
      logger.warn({ err: (err as Error).message }, "Failed to clean up orphaned files");
    }
  }
}

/**
 * Register SIGTERM/SIGINT handlers for graceful shutdown.
 */
export function registerShutdownHandlers(): void {
  const cleanup = async () => {
    logger.info("Shutting down...");
    await cleanupOrphans();
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
