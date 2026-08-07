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
  /** Force the chunked path even for small files (test/diagnostic). */
  forceChunked?: boolean;
  /** Called after each chunk upload so the UI can show live progress. */
  onChunk?: (uploadedChunks: number, totalChunks: number) => void;
}

/** Chunk size for the chunked upload path. Small enough to live under any
 * reverse-proxy body cap (e.g. Cloudflare's 100MB) while staying efficient. */
export const CHUNK_SIZE = 20 * 1024 * 1024;
/** Files at/below this use the fast single-shot upload. */
export const SINGLE_SHOT_LIMIT_BYTES = 90 * 1024 * 1024;

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Bun.file(path).name returns the path it was constructed with, not just the
 * basename — so a caller relying on that as the upload's display filename
 * ends up sending the full local temp path (e.g. "/tmp/bot/xyz.mp4") as the
 * file's "name" in the multipart body. FileCodeBox rejects/mishandles a
 * filename containing slashes, so the share upload fails. Always strip to
 * the basename before using a path as a filename.
 */
function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** The minimal shape of Bun.file() that the uploaders rely on. */
interface ShareFile {
  name?: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ApiResponse {
  code?: number;
  detail?: {
    code?: string;
    upload_id?: string;
    chunk_size?: number;
    total_chunks?: number;
    [k: string]: unknown;
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fail(msg: string): DownloadError {
  return new DownloadError(DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED, msg);
}

/** Single-shot upload via FileCodeBox's /share/file/ endpoint. */
async function directUpload(
  baseUrl: string,
  file: ShareFile,
  fileName: string,
  token: string | undefined,
  expireValue: number,
  expireStyle: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new File([await file.arrayBuffer()], fileName));
  form.append("expire_value", String(expireValue));
  form.append("expire_style", expireStyle);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await fetch(`${baseUrl}/share/file/`, { method: "POST", body: form, headers });
  if (!res.ok) throw fail(`Share service upload failed (HTTP ${res.status})`);

  const body = (await res.json()) as ApiResponse;
  if (!body.detail?.code) throw fail("Share service returned no share code");
  return body.detail.code;
}

/** Chunked upload via FileShare's /chunk/upload/* endpoints. Each chunk
 *  request stays small, so large files pass through size-capped proxies. */
async function chunkedUpload(
  baseUrl: string,
  file: ShareFile,
  fileName: string,
  token: string | undefined,
  expireValue: number,
  expireStyle: string,
  onChunk?: (uploadedChunks: number, totalChunks: number) => void,
): Promise<string> {
  const size = file.size;
  const buffer = await file.arrayBuffer();
  const hash = await sha256Hex(buffer);
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const initRes = await fetch(`${baseUrl}/chunk/upload/init/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ file_name: fileName, chunk_size: CHUNK_SIZE, file_size: size, file_hash: hash }),
  });
  if (!initRes.ok) throw fail(`Share chunk init failed (HTTP ${initRes.status})`);
  const initBody = (await initRes.json()) as ApiResponse;
  const uploadId = initBody.detail?.upload_id;
  if (!uploadId) throw fail("Share service returned no upload id");

  // FileCodeBox dedups init requests by file_hash+file_size+file_name and
  // resumes any existing partial session (e.g. left over from a prior
  // crashed/interrupted upload) — returning THAT session's chunk_size and
  // total_chunks, which can differ from what we just requested. The server
  // reassembles the file using those authoritative boundaries, not ours, so
  // slicing with our own CHUNK_SIZE on a resumed session desyncs the chunk
  // indices from what merge_chunks() expects and silently corrupts the
  // reassembled file while the DB still records the correct file_size.
  const chunkSize = initBody.detail?.chunk_size ?? CHUNK_SIZE;
  const totalChunks = initBody.detail?.total_chunks ?? Math.ceil(size / chunkSize);

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const chunkForm = new FormData();
      chunkForm.append("chunk", new File([buffer.slice(start, end)], `chunk-${i}`));
      const chunkRes = await fetch(`${baseUrl}/chunk/upload/chunk/${uploadId}/${i}`, {
        method: "POST",
        body: chunkForm,
        headers: authHeaders,
      });
      if (!chunkRes.ok) throw fail(`Chunk ${i}/${totalChunks} upload failed (HTTP ${chunkRes.status})`);
      onChunk?.(i + 1, totalChunks);
    }

    const completeRes = await fetch(`${baseUrl}/chunk/upload/complete/${uploadId}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ expire_value: expireValue, expire_style: expireStyle }),
    });
    if (!completeRes.ok) throw fail(`Chunk complete failed (HTTP ${completeRes.status})`);
    const completeBody = (await completeRes.json()) as ApiResponse;
    if (!completeBody.detail?.code) throw fail("Share service returned no share code after chunking");

    logger.info({ uploadId, totalChunks, size }, "Chunked file shared via file box");
    return completeBody.detail.code;
  } catch (err) {
    await fetch(`${baseUrl}/chunk/upload/${uploadId}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
    throw err;
  }
}

/**
 * Upload a file to a FileCodeBox instance (vastsa/FileCodeBox) and return the
 * passcode + share page link. Runs anonymously when `openUpload` is enabled
 * (default); pass `token` for Bearer auth on locked-down installs.
 *
 * Large files use the chunked API to stay under reverse-proxy body caps
 * (Cloudflare limits uploads to 100MB); if a single-shot upload is rejected
 * by a cap (413/502) we fall back to chunked automatically.
 */
export async function shareFile(filePath: string, options: ShareFileOptions): Promise<ShareResult> {
  const baseUrl = trimBaseUrl(options.baseUrl);
  const expireValue = options.expireValue ?? 2;
  const expireStyle = options.expireStyle ?? "hour";
  const file = Bun.file(filePath);
  const fileName = options.fileName ?? basename(filePath) ?? "download";
  const useChunked = options.forceChunked ?? file.size > SINGLE_SHOT_LIMIT_BYTES;

  let code: string;
  try {
    code = useChunked
      ? await chunkedUpload(baseUrl, file, fileName, options.token, expireValue, expireStyle, options.onChunk)
      : await directUpload(baseUrl, file, fileName, options.token, expireValue, expireStyle);
  } catch (err) {
    if (!useChunked && isCapturable(err as DownloadError)) {
      code = await chunkedUpload(baseUrl, file, fileName, options.token, expireValue, expireStyle, options.onChunk);
    } else {
      throw err;
    }
  }

  const link = `${trimBaseUrl(options.publicUrl ?? baseUrl)}/share/${code}`;
  logger.info({ code, size: file.size, expireValue, expireStyle, chunked: useChunked }, "File shared via file box");
  return { code, link };
}

/** Treat 413/502 (proxy/body-cap rejections) as "retry via chunked". */
function isCapturable(err: DownloadError): boolean {
  return /HTTP (413|502|503)/.test(err.message);
}