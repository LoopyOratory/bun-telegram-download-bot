import { logger } from "../utils/logger";
import { DownloadError, DownloadErrorCode } from "../types";

export interface ShareResult {
  code: string;
  link: string;
}

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Upload a file to a FileCodeBox instance (vastsa/FileCodeBox) and return the
 * passcode + share page link. Runs anonymously when `openUpload` is enabled
 * (the default); pass a token to force Bearer auth for locked-down installs.
 *
 * Upload contract (from FileCodeBox apps/base/views.py):
 *   POST {base}/share/file/  (multipart `file`, `expire_value`, `expire_style`)
 *   -> { "code": 200, "detail": { "code": "<share-code>", "name": "<name>" } }
 * Recipient opens {base}/share/<code> and enters the passcode to download.
 */
export async function shareFile(
  filePath: string,
  baseUrl: string,
  token?: string,
  fileName?: string,
  expireDays = 1,
  publicUrl?: string,
): Promise<ShareResult> {
  const file = Bun.file(filePath);
  const form = new FormData();
  form.append("file", new File([await file.arrayBuffer()], fileName ?? file.name ?? "download"));
  form.append("expire_value", String(expireDays));
  form.append("expire_style", "day");

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await fetch(`${trimBaseUrl(baseUrl)}/share/file/`, {
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

  const link = `${trimBaseUrl(publicUrl ?? baseUrl)}/share/${code}`;
  logger.info({ code, size: file.size }, "File shared via file box");
  return { code, link };
}