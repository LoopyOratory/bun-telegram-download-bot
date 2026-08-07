/**
 * Tests for the Telegram upload-size compression planner.
 * The bitrate math is pure; the ffmpeg execution is verified by hand.
 */
import { describe, expect, test } from "bun:test";
import { computeVideoBitrate, TELEGRAM_UPLOAD_LIMIT_BYTES } from "../src/services/compress";

describe("computeVideoBitrate", () => {
  test("attributes video bitrate so a known duration fits the target", () => {
    const duration = 60;
    const audio = 96_000;
    const expected = Math.round((TELEGRAM_UPLOAD_LIMIT_BYTES * 8) / duration - audio);
    expect(computeVideoBitrate(duration, TELEGRAM_UPLOAD_LIMIT_BYTES, audio)).toBe(expected);
  });

  test("never clamps below the floor bitrate", () => {
    expect(computeVideoBitrate(60, 1024 * 1024)).toBeGreaterThan(0);
  });
});