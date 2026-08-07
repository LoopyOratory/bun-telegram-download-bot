/**
 * Regression tests for the proxy/Tor argument generation.
 *
 * Regression test for the historical bug where getTorArgs() returned the
 * invalid `--tor` flag, making every yt-dlp download fail with:
 *   "yt-dlp: error: no such option: --tor"
 */
import { describe, expect, test } from "bun:test";
import { getTorArgs, isTorAvailable } from "../src/services/proxy";

describe("getTorArgs", () => {
  test("returns a valid yt-dlp --proxy socks5 flag (never --tor)", () => {
    const args = getTorArgs();
    expect(args).toEqual(["--proxy", "socks5://127.0.0.1:9050"]);
    expect(args.join(" ")).not.toContain("--tor");
  });
});

describe("isTorAvailable", () => {
  test("is false before the pool has probed Tor (module cache is null)", () => {
    expect(isTorAvailable()).toBe(false);
  });
});