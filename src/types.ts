/** Status of a download record */
export type DownloadStatus =
  | "started"
  | "downloading"
  | "completed"
  | "failed";

/** Platform categories for tracking */
export type Platform =
  | "youtube"
  | "twitter"
  | "tiktok"
  | "instagram"
  | "snapchat"
  | "other";

/** Database user row */
export interface UserRow {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_owner: number;
  is_allowed: number;
  banned_at: string | null;
  ban_reason: string | null;
  total_downloads: number;
  total_bytes: number;
  first_seen: string;
  updated_at: string;
}

/** Database download row */
export interface DownloadRow {
  id: number;
  user_id: number;
  chat_id: number;
  url: string;
  platform: string | null;
  status: DownloadStatus;
  file_size: number | null;
  duration_ms: number | null;
  format: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  started_at: string;
  completed_at: string | null;
}

/** Progress event emitted by the downloader */
export interface ProgressEvent {
  percent: number;
  speed: string;
  eta: string;
  downloaded: string;
  total: string;
}

/** Result of a completed download */
export interface DownloadResult {
  filePath: string;
  fileSize: number;
  format: string;
  durationMs: number;
  videoId: string;
}

/** Error classification for better diagnostics */
export enum DownloadErrorCode {
  PRIVATE_VIDEO = "PRIVATE_VIDEO",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  INVALID_URL = "INVALID_URL",
  PLATFORM_BLOCKED = "PLATFORM_BLOCKED",
  RATE_LIMITED = "RATE_LIMITED",
  TIMEOUT = "TIMEOUT",
  GEO_RESTRICTED = "GEO_RESTRICTED",
  WATERMARK_DETECTED = "WATERMARK_DETECTED",
  EXTRACTOR_ERROR = "EXTRACTOR_ERROR",
  UNKNOWN = "UNKNOWN",
}

/** Classified download error */
export class DownloadError extends Error {
  constructor(
    public code: DownloadErrorCode,
    message: string,
    public platform?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      platform: this.platform,
    };
  }
}

/** Available format/resolution for selection */
export interface FormatInfo {
  code: string;      // yt-dlp format code (e.g., "136", "137+140")
  resolution: string; // human-readable (e.g., "1080p", "720p", "480p")
  height: number;     // pixel height for sorting
  filesize: string;   // approximate size label (e.g., "~25 MB")
}
