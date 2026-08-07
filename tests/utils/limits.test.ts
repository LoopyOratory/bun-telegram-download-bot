/**
 * Tests for download limits — storage, not file size.
 */
import { describe, expect, test } from "bun:test";
import { ensureDiskFree, MIN_FREE_DISK_BYTES } from "../../src/utils/limits";

describe("ensureDiskFree", () => {
  test("resolves when the target volume has free space", async () => {
    await expect(ensureDiskFree(process.cwd())).resolves.toBeUndefined();
  });

  test("keeps a positive free-space floor", () => {
    expect(MIN_FREE_DISK_BYTES).toBeGreaterThan(0);
  });
});