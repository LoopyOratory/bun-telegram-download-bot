import { logger } from "../utils/logger";
import { DownloadError, DownloadErrorCode } from "../types";

export interface ShareResult {
  code: string;
  link: string;
}

export interface ShareFileOptions {
  /** Base URL the bot uses to reach the box for the upload request. */
  baseUrl: string;
  /** Bearer token for boxes with guest upload disabled. */
  token?: string;
  fileName?: string;
  expireValue?: number;
  expireStyle?: "minute" | "hour" | "day" | "forever" | "count";
  /** Public base URL baked into the share link; defaults to baseUrl. */
  publicUrl?: string;
}

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Upload a file to a FileCodeBox instance (vastsa/FileCodeBox) and return the
 * passcode + share page link. Runs anonymously when `openUpload` is enabled
 * (default); pass `token` for Bearer auth on locked-down installs.
 *
 * Upload contract (verified against FileCodeBox apps/base/views.py):
 *   POST {base}/share/file/  (multipart `file`, `expire_value`, `expire_style`)
 *   -> { "code": 200, "detail": { "code": "<share-code>", "name": "<name>" } }
 * Recipient opens {base}/share/<code> and enters the passcode to download.
 */
export async function shareFile(filePath: string, options: ShareFileOptions): Promise<ShareResult> {
  const baseUrl = trimBaseUrl(options.baseUrl);
  const expireValue = options.expireValue ?? 2;
  const expireStyle = options.expireStyle ?? "hour";

  const file = Bun.file(filePath);
  const form = new FormData();
  form.append("file", new File([await file.arrayBuffer()], options.fileName ?? file.name ?? "download"));
  form.append("expire_value", String(expireValue));
  form.append("expire_style", expireStyle);

  const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};

  const res = await fetch(`${baseUrl}/share/file/`, {
    method: "POST",
    body: form,
    headers,
  });

  if (!res.ok) {
    throw new DownloadError(
      DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED,
      `Share service upload failed (HTTP ${res.status})`,
    );
  }

  const body = (await res.json()) as { code?: number; detail?: { code?: string; name?: string } };
  const code = body.detail?.code;
  if (!code) {
    throw new DownloadError(DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED, "Share service returned no share code");
  }

  const link = `${trimBaseUrl(options.publicUrl ?? baseUrl)}/share/${code}`;
  logger.info({ code, size: file.size, expireValue, expireStyle }, "File shared via file box");
  return { code, link };
}