import { spawn } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "../config";
import { logger } from "../utils/logger";
import {
  ensureDiskFree,
  DOWNLOAD_TIMEOUT_SECONDS,
  MAX_DOWNLOAD_RETRIES,
  RETRY_DELAY_BASE_MS,
} from "../utils/limits";
import { detectPlatform } from "../utils/url";
import { getDownloadRoutes, reportRouteFailure, type DownloadRoute } from "./proxy";
import { DownloadError, DownloadErrorCode, type ProgressEvent, type DownloadResult, type FormatInfo } from "../types";

const PROGRESS_REGEX = /\[download\]\s+(\d+\.?\d*)%.*?at\s+([\d.]+[KMG]?i?B\/s).*?ETA\s+(\d+:\d+)/i;
const LIST_TIMEOUT_MS = 25_000;
const OUTPUT_MARKER = "final-file:";

function youtubeFormat(height?: number): string {
  const filter = height === undefined ? "" : `[height=${height}]`;
  return [
    `bv${filter}[vcodec^=avc1]+ba[acodec^=mp4a]`,
    `b${filter}[vcodec^=avc1][acodec^=mp4a]`,
    `bv${filter}+ba`,
    `b${filter}`,
  ].join("/");
}

function commonArgs(platform: string, proxy: string): string[] {
  const args = [
    "--no-playlist", "--no-cache-dir",
    "--proxy", proxy, "--socket-timeout", "8",
  ];
  if (platform === "tiktok") args.push("--extractor-args", "tiktok:no_watermark=true");
  return args;
}

interface SpawnOptions {
  url: string;
  outputPath: string;
  platform: string;
}

export function buildYtDlpArgs(
  { url, outputPath, platform }: SpawnOptions,
  formatCode?: string,
  route = getDownloadRoutes(platform)[0],
  useAria2 = env.ARIA2_ENABLED && route.kind === "direct",
): string[] {
  const youtube = platform === "youtube";
  const format = formatCode || (youtube
    ? youtubeFormat()
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best");
  const args = [
    ...commonArgs(platform, route.proxy),
    "-f", format, "-o", outputPath,
    "--newline", "--progress", "--no-simulate",
    "--print", `after_move:${OUTPUT_MARKER}%(filepath)j`,
    "--retries", "2", "--fragment-retries", "3",
  ];
  if (youtube) args.push("--abort-on-unavailable-fragments", "--merge-output-format", "mp4/mkv");
  else args.push("--remux-video", "mp4");

  if (useAria2) {
    args.push(
      "--downloader", "aria2c",
      "--downloader-args", "aria2c:-x16 -s16 -k1M --connect-timeout=8 --timeout=8 --max-tries=3",
    );
    if (youtube) args.push("--downloader", "dash,m3u8:native");
  }
  return [...args, "--", url];
}

function emitProgress(line: string, onProgress: (event: ProgressEvent) => void): void {
  const match = line.match(PROGRESS_REGEX);
  if (match) onProgress({
    percent: Number(match[1]), speed: match[2], eta: match[3], downloaded: "", total: "",
  });
}

function runCommand(args: string[], timeoutMs: number, onProgress?: (event: ProgressEvent) => void) {
  if (timeoutMs <= 0) return Promise.reject(new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out"));

  return new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const proc = spawn(args[0], args.slice(1), { detached: processGroup, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const capture = (stream: NonNullable<typeof proc.stdout>, append: (chunk: string) => void) => {
      let lineBuffer = "";
      stream.setEncoding("utf8").on("data", (chunk: string) => {
        append(chunk);
        if (!onProgress) return;
        const lines = (lineBuffer + chunk).split(/[\r\n]+/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) emitProgress(line, onProgress);
      });
    };
    capture(proc.stdout!, (chunk) => { stdout += chunk; });
    capture(proc.stderr!, (chunk) => { stderr = (stderr + chunk).slice(-8_000); });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (processGroup && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") logger.warn({ err }, "Could not stop media process");
      }
    }, timeoutMs);
    proc.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

export function classifyYtDlpError(stderr: string): DownloadError {
  if (/private video|video is private/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.PRIVATE_VIDEO, "Video is private");
  }
  if (/copyright|removed by|content blocked/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.PLATFORM_BLOCKED, "Content blocked by platform");
  }
  if (/geo.restricted|not available in your country/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.GEO_RESTRICTED, "Not available in your region");
  }
  if (/rate.limit|too many requests|HTTP Error 429/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.RATE_LIMITED, "Rate limited, try again later");
  }
  if (/timed out|timeout/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
  }
  if (/watermark/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.WATERMARK_DETECTED, "Video contains watermark");
  }
  if (/confirm you.re not a bot|sign in to confirm/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.EXTRACTOR_ERROR, "YouTube blocked this connection with a sign-in check");
  }
  if (/unsupported url|no video|no data|requested format is not available/i.test(stderr)) {
    return new DownloadError(DownloadErrorCode.EXTRACTOR_ERROR, "Could not extract the requested video format");
  }

  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => line.startsWith("ERROR:")) || lines[0];
  const safeError = error?.replace(/((?:https?|socks5h?):\/\/)[^\s/]+@/gi, "$1[redacted]@");
  return new DownloadError(DownloadErrorCode.UNKNOWN, safeError?.slice(0, 200) || "Download failed");
}

function routeFailure(stderr: string): boolean {
  return /proxy (?:error|connection|authentication)|tunnel connection failed|unable to connect|connection (?:refused|reset|aborted)|network is unreachable|name resolution|remote end closed|timed out|HTTP Error (?:403|407|429|5\d\d)|confirm you.re not a bot|sign in to confirm|too many requests/i.test(stderr);
}

function canRetry(error: DownloadError, youtube: boolean): boolean {
  if (!youtube) {
    return [DownloadErrorCode.TIMEOUT, DownloadErrorCode.RATE_LIMITED, DownloadErrorCode.UNKNOWN].includes(error.code);
  }
  return ![
    DownloadErrorCode.PRIVATE_VIDEO, DownloadErrorCode.PLATFORM_BLOCKED,
    DownloadErrorCode.INVALID_URL, DownloadErrorCode.WATERMARK_DETECTED,
  ].includes(error.code);
}

type MediaInfo = {
  streams?: Array<{ codec_type: string; codec_name: string }>;
  format?: { duration?: string };
};

async function probeMedia(path: string, deadline: number): Promise<MediaInfo> {
  const result = await runCommand([
    "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration",
    "-of", "json", path,
  ], Math.min(15_000, deadline - Date.now()));
  if (result.timedOut) throw new DownloadError(DownloadErrorCode.TIMEOUT, "Verifying the video timed out");
  if (result.exitCode !== 0) {
    throw new DownloadError(DownloadErrorCode.INVALID_MEDIA, "Could not verify the downloaded video");
  }
  return JSON.parse(result.stdout) as MediaInfo;
}

function requireAudioAndVideo(info: MediaInfo) {
  const video = info.streams?.find((stream) => stream.codec_type === "video");
  const audio = info.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) {
    throw new DownloadError(DownloadErrorCode.INVALID_MEDIA, "YouTube did not provide a complete video with audio");
  }
  return { video, audio };
}

async function prepareYoutubeVideo(path: string, outputStem: string, deadline: number) {
  const info = await probeMedia(path, deadline);
  const { video, audio } = requireAudioAndVideo(info);
  if (path.endsWith(".mp4") && video.codec_name === "h264" && audio.codec_name === "aac") {
    return { filePath: path, durationMs: Math.round((Number(info.format?.duration) || 0) * 1_000) };
  }

  const filePath = `${outputStem}.playable.mp4`;
  const args = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-y", "-i", path, "-map", "0:V:0", "-map", "0:a:0"];
  if (video.codec_name === "h264") args.push("-c:v", "copy");
  else args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (audio.codec_name === "aac") args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-b:a", "128k");
  const result = await runCommand([...args, "-movflags", "+faststart", filePath], deadline - Date.now());
  if (result.timedOut) throw new DownloadError(DownloadErrorCode.TIMEOUT, "Preparing the video timed out");
  if (result.exitCode !== 0) {
    throw new DownloadError(DownloadErrorCode.INVALID_MEDIA, "Could not prepare an MP4 with playable sound");
  }

  const prepared = await probeMedia(filePath, deadline);
  requireAudioAndVideo(prepared);
  return { filePath, durationMs: Math.round((Number(prepared.format?.duration) || 0) * 1_000) };
}

async function cleanupAttempt(directory: string, videoId: string, keep?: string): Promise<void> {
  try {
    const names = await readdir(directory);
    await Promise.all(names.filter((name) => name.startsWith(`${videoId}.`) && name !== keep)
      .map((name) => unlink(join(directory, name))));
  } catch (err) {
    logger.warn({ err, videoId }, "Could not clean up download files");
  }
}

export async function downloadVideo(
  url: string,
  outputDir: string,
  onProgress?: (event: ProgressEvent) => void,
  retryCount = 0,
  formatCode?: string,
): Promise<DownloadResult> {
  const platform = detectPlatform(url);
  const youtube = platform === "youtube";
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  await ensureDiskFree(directory);

  const routes = getDownloadRoutes(platform);
  if (!youtube) routes.push(...Array<DownloadRoute>(Math.max(0, MAX_DOWNLOAD_RETRIES - retryCount)).fill(routes[0]));
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_SECONDS * 1_000;
  let lastError: DownloadError | undefined;

  for (const [attempt, route] of routes.entries()) {
    if (Date.now() >= deadline) break;
    const videoId = crypto.randomUUID();
    const stem = join(directory, videoId);
    const outputPath = `${stem.replaceAll("%", "%%")}.%(ext)s`;
    const useAria2 = env.ARIA2_ENABLED && route.kind === "direct" && !routes.slice(0, attempt).includes(route);
    const args = buildYtDlpArgs({ url, outputPath, platform }, formatCode, route, useAria2);
    let keep: string | undefined;

    try {
      logger.info({ platform, route: route.kind, attempt }, "Starting download");
      const result = await runCommand(["yt-dlp", ...args], deadline - Date.now(), onProgress);
      if (result.timedOut) throw new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
      if (result.exitCode !== 0) {
        if (routeFailure(result.stderr)) reportRouteFailure(route);
        throw classifyYtDlpError(result.stderr);
      }

      const output = result.stdout.split("\n").find((line) => line.startsWith(OUTPUT_MARKER));
      const path: unknown = output && JSON.parse(output.slice(OUTPUT_MARKER.length));
      if (typeof path !== "string" || dirname(path) !== directory || !basename(path).startsWith(`${videoId}.`)) {
        throw new DownloadError(DownloadErrorCode.INVALID_MEDIA, "Could not locate the finished video");
      }

      const { filePath, durationMs } = youtube
        ? await prepareYoutubeVideo(path, stem, deadline)
        : { filePath: path, durationMs: 0 };
      const { size: fileSize } = await stat(filePath);
      if (!fileSize) throw new DownloadError(DownloadErrorCode.INVALID_MEDIA, "The finished video file is empty");
      keep = basename(filePath);
      const format = filePath.split(".").at(-1) || "mp4";
      logger.info({ platform, route: route.kind, fileSize, format }, "Download completed");
      return { filePath, fileSize, format, durationMs, videoId };
    } catch (err) {
      if (!(err instanceof DownloadError)) throw err;
      lastError = err;
      logger.warn({ platform, route: route.kind, attempt, errorCode: err.code, error: err.message }, "Download attempt failed");
      if (!canRetry(err, youtube) || attempt === routes.length - 1) break;
    } finally {
      await cleanupAttempt(directory, videoId, keep);
    }

    if (!youtube) {
      const delay = Math.min(RETRY_DELAY_BASE_MS * 2 ** attempt, deadline - Date.now());
      if (delay > 0) await Bun.sleep(delay);
    }
  }

  throw lastError ?? new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
}

interface ListedFormat {
  format_id?: string;
  height?: number;
  vcodec?: string;
  ext?: string;
  format_note?: string;
}

function parseFormats(stdout: string, platform: string): FormatInfo[] {
  const data = JSON.parse(stdout) as { formats?: ListedFormat[] };
  const formats = new Map<number, FormatInfo>();
  for (const format of data.formats ?? []) {
    const height = format.height;
    const code = format.format_id;
    if (!height || !Number.isInteger(height) || height < 1 || height > 1080 || !code ||
        !format.vcodec || format.vcodec === "none" || /watermarked/i.test(format.format_note ?? "")) continue;

    if (platform !== "youtube" && format.ext === "webm") continue;

    formats.set(height, {
      code: platform === "youtube" ? youtubeFormat(height) : code,
      resolution: `${height}p`,
      height,
      filesize: "",
    });
  }
  return [...formats.values()].sort((a, b) => b.height - a.height).slice(0, 6);
}

export async function listFormats(url: string): Promise<FormatInfo[]> {
  const platform = detectPlatform(url);
  for (const route of getDownloadRoutes(platform)) {
    try {
      const result = await runCommand([
        "yt-dlp", ...commonArgs(platform, route.proxy),
        "--dump-single-json", "--skip-download", "--retries", "1", "--extractor-retries", "1", "--", url,
      ], LIST_TIMEOUT_MS);

      if (result.exitCode === 0) {
        const formats = parseFormats(result.stdout, platform);
        if (formats.length) return formats;
      } else {
        const error = classifyYtDlpError(result.stderr);
        if (result.timedOut || routeFailure(result.stderr)) reportRouteFailure(route);
        logger.warn({ platform, route: route.kind, errorCode: error.code }, "Format lookup failed");
        if (!canRetry(error, platform === "youtube")) return [];
      }
    } catch (err) {
      logger.warn({ platform, route: route.kind, err }, "Could not list formats");
      return [];
    }
  }

  return [];
}
