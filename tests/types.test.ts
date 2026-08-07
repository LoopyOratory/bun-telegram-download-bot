/**
 * Tests for DownloadError and error code classification.
 */

import { describe, expect, test } from "bun:test";
import { DownloadError, DownloadErrorCode } from "../src/types";

describe("DownloadError", () => {
  test("creates error with code and message", () => {
    const err = new DownloadError(
      DownloadErrorCode.PRIVATE_VIDEO,
      "This video is private",
      "youtube",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PRIVATE_VIDEO");
    expect(err.message).toBe("This video is private");
    expect(err.platform).toBe("youtube");
    expect(err.name).toBe("DownloadError");
  });

  test("converts to JSON", () => {
    const err = new DownloadError(
      DownloadErrorCode.NO_DISK_SPACE,
      "Not enough disk space",
    );
    const json = err.toJSON();
    expect(json).toEqual({
      code: DownloadErrorCode.NO_DISK_SPACE,
      message: "Not enough disk space",
      platform: undefined,
    });
  });

  test.each([
    "PRIVATE_VIDEO",
    "NO_DISK_SPACE",
    "UPLOAD_LIMIT_EXCEEDED",
    "INVALID_URL",
    "PLATFORM_BLOCKED",
    "RATE_LIMITED",
    "TIMEOUT",
    "GEO_RESTRICTED",
    "WATERMARK_DETECTED",
    "EXTRACTOR_ERROR",
    "UNKNOWN",
  ])("has error code %s", (code) => {
    expect(Object.values(DownloadErrorCode)).toContain(code);
  });
});
