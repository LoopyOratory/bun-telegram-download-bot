/**
 * Tests for URL validation and platform detection.
 */

import { describe, expect, test } from "bun:test";
import { validateUrl, validateUrlOrThrow, detectPlatform } from "../../src/utils/url";
import { DownloadError, DownloadErrorCode } from "../../src/types";

describe("validateUrl", () => {
  test("accepts valid https URLs", () => {
    expect(validateUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  test("accepts valid http URLs", () => {
    expect(validateUrl("http://example.com/video")).toBe("http://example.com/video");
  });

  test("strips whitespace and null bytes", () => {
    expect(validateUrl("  https://example.com/video\n")).toBe(
      "https://example.com/video",
    );
  });

  test("rejects non-http schemes", () => {
    expect(validateUrl("ftp://example.com/video")).toBeNull();
    expect(validateUrl("file:///etc/passwd")).toBeNull();
    expect(validateUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects empty strings", () => {
    expect(validateUrl("")).toBeNull();
    expect(validateUrl("   ")).toBeNull();
  });

  test("rejects malformed URLs", () => {
    expect(validateUrl("not-a-url")).toBeNull();
    expect(validateUrl("http://")).toBeNull();
  });
});

describe("validateUrlOrThrow", () => {
  test("returns valid URL on success", () => {
    expect(validateUrlOrThrow("https://example.com")).toBe("https://example.com");
  });

  test("throws classified error on invalid scheme", () => {
    try {
      validateUrlOrThrow("file:///etc/passwd");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe(DownloadErrorCode.INVALID_URL);
    }
  });

  test("throws classified error on malformed URL", () => {
    try {
      validateUrlOrThrow("not-a-url");
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe(DownloadErrorCode.INVALID_URL);
    }
  });
});

describe("detectPlatform", () => {
  test("detects YouTube", () => {
    expect(detectPlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(detectPlatform("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(detectPlatform("https://m.youtube.com/watch?v=123")).toBe("youtube");
  });

  test("detects Twitter/X", () => {
    expect(detectPlatform("https://twitter.com/user/status/123456")).toBe("twitter");
    expect(detectPlatform("https://x.com/user/status/123456")).toBe("twitter");
  });

  test("detects TikTok", () => {
    expect(detectPlatform("https://www.tiktok.com/@user/video/123456")).toBe("tiktok");
    expect(detectPlatform("https://vm.tiktok.com/abc123")).toBe("tiktok");
  });

  test("detects Instagram", () => {
    expect(detectPlatform("https://www.instagram.com/p/abc123/")).toBe("instagram");
    expect(detectPlatform("https://instagr.am/p/abc123/")).toBe("instagram");
  });

  test("detects Snapchat", () => {
    expect(detectPlatform("https://www.snapchat.com/spotlight/abc123")).toBe("snapchat");
  });

  test("falls back to 'other' for unknown platforms", () => {
    expect(detectPlatform("https://vimeo.com/123456")).toBe("other");
    expect(detectPlatform("https://dailymotion.com/video/abc")).toBe("other");
    expect(detectPlatform("https://example.com/video.mp4")).toBe("other");
  });
});
