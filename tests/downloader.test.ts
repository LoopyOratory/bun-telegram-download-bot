/**
 * Tests for the download error classification logic.
 *
 * Tests the classifyYtDlpError function via the DownloadError class
 * by simulating yt-dlp stderr output patterns.
 */

import { describe, expect, test } from "bun:test";
import { DownloadError, DownloadErrorCode } from "../src/types";

// Replicate the classification logic from downloader.ts for testing
function classifyYtDlpError(stderr: string): DownloadError {
  const combined = stderr.toLowerCase();

  if (combined.includes("private video") || combined.includes("private")) {
    return new DownloadError(DownloadErrorCode.PRIVATE_VIDEO, "This video is private or unavailable");
  }
  if (combined.includes("copyright") || combined.includes("blocked") || combined.includes("removed")) {
    return new DownloadError(DownloadErrorCode.PLATFORM_BLOCKED, "Content blocked or removed by platform");
  }
  if (combined.includes("geo") || combined.includes("not available in your country")) {
    return new DownloadError(DownloadErrorCode.GEO_RESTRICTED, "Video is geo-restricted");
  }
  if (combined.includes("rate") || combined.includes("too many requests")) {
    return new DownloadError(DownloadErrorCode.RATE_LIMITED, "Rate limited by platform");
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return new DownloadError(DownloadErrorCode.TIMEOUT, "Download timed out");
  }
  if (combined.includes("watermark")) {
    return new DownloadError(DownloadErrorCode.WATERMARK_DETECTED, "Video contains watermark — download rejected");
  }
  if (combined.includes("unsupported url") || combined.includes("no video") || combined.includes("no data")) {
    return new DownloadError(DownloadErrorCode.EXTRACTOR_ERROR, "yt-dlp could not extract video: " + stderr.split("\n")[0].trim());
  }

  return new DownloadError(DownloadErrorCode.UNKNOWN, stderr.split("\n").slice(0, 3).join("; ").trim());
}

describe("classifyYtDlpError", () => {
  test("classifies private video error", () => {
    const err = classifyYtDlpError("ERROR: This video is private. Sign in to view it.");
    expect(err.code).toBe(DownloadErrorCode.PRIVATE_VIDEO);
  });

  test("classifies geo-restricted error", () => {
    const err = classifyYtDlpError("ERROR: This video is not available in your country");
    expect(err.code).toBe(DownloadErrorCode.GEO_RESTRICTED);
  });

  test("classifies rate limit error", () => {
    const err = classifyYtDlpError("WARNING: Too many requests. Retrying after 60s");
    expect(err.code).toBe(DownloadErrorCode.RATE_LIMITED);
  });

  test("classifies timeout error", () => {
    const err = classifyYtDlpError("ERROR: Connection timed out after 30000ms");
    expect(err.code).toBe(DownloadErrorCode.TIMEOUT);
  });

  test("classifies extractor error", () => {
    const err = classifyYtDlpError("ERROR: Unsupported URL: https://example.com/video");
    expect(err.code).toBe(DownloadErrorCode.EXTRACTOR_ERROR);
  });

  test("classifies blocked content", () => {
    const err = classifyYtDlpError("ERROR: This content has been removed by the uploader");
    expect(err.code).toBe(DownloadErrorCode.PLATFORM_BLOCKED);
  });

  test("classifies unknown errors with stderr excerpt", () => {
    const err = classifyYtDlpError("Something unexpected happened\nLine 2\nLine 3");
    expect(err.code).toBe(DownloadErrorCode.UNKNOWN);
    expect(err.message).toContain("Something unexpected happened");
  });
});
