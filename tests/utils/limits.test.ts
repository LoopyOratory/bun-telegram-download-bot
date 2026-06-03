/**
 * Tests for file size limits.
 */

import { describe, expect, test } from "bun:test";
import { checkFileSizeLimit, MAX_FILE_SIZE_BYTES } from "../../src/utils/limits";
import { DownloadError, DownloadErrorCode } from "../../src/types";

describe("checkFileSizeLimit", () => {
  test("passes on files under the limit", () => {
    expect(() => checkFileSizeLimit(1024)).not.toThrow();
    expect(() => checkFileSizeLimit(MAX_FILE_SIZE_BYTES - 1)).not.toThrow();
  });

  test("passes on files exactly at the limit", () => {
    expect(() => checkFileSizeLimit(MAX_FILE_SIZE_BYTES)).not.toThrow();
  });

  test("throws classified error on files over the limit", () => {
    try {
      checkFileSizeLimit(MAX_FILE_SIZE_BYTES + 1);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe(DownloadErrorCode.FILE_TOO_LARGE);
      expect((err as DownloadError).message).toContain("File too large");
    }
  });
});
