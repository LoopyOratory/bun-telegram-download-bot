import { spawn } from "bun";
import { stat, unlink } from "node:fs/promises";
import { logger } from "../utils/logger";
import { DownloadError, DownloadErrorCode } from "../types";

/** Telegram's Bot API caps uploads at 50MB; target 48MB to leave a safety margin. */
export const TELEGRAM_UPLOAD_LIMIT_BYTES = 48 * 1024 * 1024;

const AUDIO_BITRATE_BPS = 96_000;
/** Lowest video encode bitrate we'll use; below this the output is unusable. */
const MIN_VIDEO_BITRATE_BPS = 100_000;

/**
 * Video bitrate (bps) that fits a target size for a known duration,
 * after reserving the audio track's share.
 */
export function computeVideoBitrate(durationSec: number, targetBytes: number, audioBitrateBps = AUDIO_BITRATE_BPS): number {
  const videoBitsPerSec = (targetBytes * 8) / durationSec - audioBitrateBps;
  return Math.max(Math.round(videoBitsPerSec), MIN_VIDEO_BITRATE_BPS);
}

async function probeDuration(filePath: string): Promise<number | null> {
  const proc = spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  const duration = Number(out);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = spawn(["ffmpeg", "-y", ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = (await new Response(proc.stderr).text()).slice(-2000);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new DownloadError(
      DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED,
      `FFmpeg compression failed: ${stderr.split("\n").slice(-3).join(" ").trim()}`,
    );
  }
}

/**
 * Re-encode a video so it fits under the target size. Progressively lowers
 * the bitrate (from the duration-derived target), then the resolution, until
 * the output fits. Throws UPLOAD_LIMIT_EXCEEDED if nothing fits.
 */
export async function compressVideo(
  inputPath: string,
  outputPath: string,
  targetBytes = TELEGRAM_UPLOAD_LIMIT_BYTES,
): Promise<string> {
  const durationSec = await probeDuration(inputPath);

  // Fail fast when even the bitrate floor can't fit the target — a very long
  // video can never be compressed into 48MB, so skip the multi-minute ffmpeg
  // grind (a 3.6-hour video made the bot hang here).
  if (durationSec) {
    const minBytesPerSecond = (MIN_VIDEO_BITRATE_BPS + AUDIO_BITRATE_BPS) / 8;
    if (durationSec * minBytesPerSecond > targetBytes) {
      throw new DownloadError(
        DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED,
        `Video is too long (${Math.round(durationSec / 60)}min) to fit Telegram's 50MB limit even at full compression. Configure SHAREBOX_URL to share it as a link instead.`,
      );
    }
  }

  const attempts: Array<{ label: string; filter: string | null }> = [
    { label: "bitrate", filter: null },
    { label: "720p", filter: "scale=-2:720" },
    { label: "480p", filter: "scale=-2:480" },
  ];

  for (const attempt of attempts) {
    const bitrate = durationSec ? computeVideoBitrate(durationSec, targetBytes) : 800_000;
    const args = [
      "-i", inputPath,
      "-c:v", "libx264", "-preset", "veryfast",
      "-b:v", String(bitrate),
      "-maxrate", String(Math.round(bitrate * 1.3)),
      "-bufsize", String(bitrate * 2),
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
    ];
    if (attempt.filter) args.push("-vf", attempt.filter);
    args.push(outputPath);

    try {
      await runFfmpeg(args);
      const { size } = await stat(outputPath);
      logger.info({ attempt: attempt.label, sizeBytes: size, targetBytes }, "Compression attempt finished");
      if (size <= targetBytes) return outputPath;
    } catch (err) {
      await unlink(outputPath).catch(() => {});
      throw err;
    }
  }

  await unlink(outputPath).catch(() => {});
  throw new DownloadError(
    DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED,
    "File still exceeds Telegram's 50MB upload limit after compression",
  );
}
