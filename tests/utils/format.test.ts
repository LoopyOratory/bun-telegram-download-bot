/**
 * Tests for file size and duration formatting.
 */

import { describe, expect, test } from "bun:test";
import { formatFileSize, formatDuration, renderProgressBar } from "../../src/utils/format";

describe("formatFileSize", () => {
  test("formats bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(500)).toBe("500 B");
  });

  test("formats kilobytes", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  test("formats megabytes", () => {
    expect(formatFileSize(1048576)).toBe("1.0 MB");
    expect(formatFileSize(5242880)).toBe("5.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatFileSize(1073741824)).toBe("1.0 GB");
  });

  test("handles null", () => {
    expect(formatFileSize(null)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
  });

  test("handles null", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("renderProgressBar", () => {
  test("renders 0%", () => {
    expect(renderProgressBar(0, 10)).toBe("▱".repeat(10));
  });

  test("renders 50%", () => {
    expect(renderProgressBar(50, 10)).toBe("▰".repeat(5) + "▱".repeat(5));
  });

  test("renders 100%", () => {
    expect(renderProgressBar(100, 10)).toBe("▰".repeat(10));
  });

  test("rounds to nearest block", () => {
    expect(renderProgressBar(45, 10)).toBe("▰".repeat(5) + "▱".repeat(5));
    expect(renderProgressBar(44, 10)).toBe("▰".repeat(4) + "▱".repeat(6));
  });

  test("defaults to width 10", () => {
    const result = renderProgressBar(30);
    expect(result.length).toBe(10);
  });
});
