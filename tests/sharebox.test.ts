/**
 * Tests for the FileCodeBox share client (sharebox.ts).
 * The upload HTTP contract is stubbed — the bot has no live box in CI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { shareFile } from "../src/services/sharebox";
import { DownloadError, DownloadErrorCode } from "../src/types";

const SRC = "/tmp/sharebox-test-src.mp4";
await Bun.write(SRC, "fake video bytes");

afterAll(() => {
  try { Bun.spawnSync(["rm", SRC]); } catch {}
});

describe("shareFile", () => {
  test("posts the file and returns the share link + code", async () => {
    let requestUrl = "";
    let body: FormData | null = null;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      requestUrl = url;
      body = init?.body as FormData;
      return new Response(JSON.stringify({ code: 200, detail: { code: "K1T2Z", name: "a.mp4" } }), { status: 200 });
    };

    const result = await shareFile(SRC, "http://box:12345/");

    expect(requestUrl).toBe("http://box:12345/share/file/");
    expect(body?.get("expire_value")).toBe("1");
    expect(body?.get("expire_style")).toBe("day");
    expect(body?.get("file")).toBeInstanceOf(File);
    expect(result).toEqual({ code: "K1T2Z", link: "http://box:12345/share/K1T2Z" });
  });

  test("throws when the upload responds with an error", async () => {
    (globalThis as any).fetch = async () => new Response("nope", { status: 500 });
    try {
      await shareFile(SRC, "http://box:12345");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe(DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED);
    }
  });

  test("throws when the response carries no share code", async () => {
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ code: 200, detail: {} }), { status: 200 });
    await expect(shareFile(SRC, "http://box:12345")).rejects.toThrow("no share code");
  });
});