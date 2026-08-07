/**
 * Tests for the FileCodeBox share client (sharebox.ts).
 * The upload HTTP contract is stubbed — the bot has no live box in CI.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { shareFile, CHUNK_SIZE } from "../src/services/sharebox";
import { DownloadError, DownloadErrorCode } from "../src/types";

const SRC = "/tmp/sharebox-test-src.mp4";
await Bun.write(SRC, "fake video bytes");

afterAll(() => {
  try { Bun.spawnSync(["rm", SRC]); } catch {}
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("shareFile (single-shot)", () => {
  test("posts the file and returns the share link + code", async () => {
    let requestUrl = "";
    let body: FormData | null = null;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      requestUrl = url;
      body = init?.body as FormData;
      return jsonResponse({ code: 200, detail: { code: "K1T2Z", name: "a.mp4" } });
    };

    const result = await shareFile(SRC, { baseUrl: "http://box:12345/" });

    expect(requestUrl).toBe("http://box:12345/share/file/");
    expect(body?.get("expire_value")).toBe("2");
    expect(body?.get("expire_style")).toBe("hour");
    expect(body?.get("file")).toBeInstanceOf(File);
    expect(result).toEqual({ code: "K1T2Z", link: "http://box:12345/share/K1T2Z" });
  });

  test("uses the public URL for the link when provided", async () => {
    (globalThis as any).fetch = async () => jsonResponse({ code: 200, detail: { code: "ABC" } });
    const result = await shareFile(SRC, { baseUrl: "http://internal:12345", publicUrl: "https://files.example.com" });
    expect(result.link).toBe("https://files.example.com/share/ABC");
  });

  test("throws when the upload responds with an error", async () => {
    (globalThis as any).fetch = async () => new Response("nope", { status: 500 });
    try {
      await shareFile(SRC, { baseUrl: "http://box:12345" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DownloadError);
      expect((err as DownloadError).code).toBe(DownloadErrorCode.UPLOAD_LIMIT_EXCEEDED);
    }
  });

  test("throws when the response carries no share code", async () => {
    (globalThis as any).fetch = async () => jsonResponse({ code: 200, detail: {} });
    await expect(shareFile(SRC, { baseUrl: "http://box:12345" })).rejects.toThrow("no share code");
  });
});

describe("shareFile (chunked)", () => {
  // Fresh Response per call — a Response body can only be consumed once.
  const initRes = () => jsonResponse({ code: 200, detail: { existed: false, upload_id: "u1", chunk_size: CHUNK_SIZE, total_chunks: 1, uploaded_chunks: [] } });
  const chunkRes = () => jsonResponse({ code: 200, detail: { chunk_hash: "h" } });
  const completeRes = () => jsonResponse({ code: 200, detail: { code: "CHNK", name: "a.mp4" } });

  test("forces chunked and assembles init → chunks → complete", async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/chunk/upload/init/")) return initRes();
      if (u.includes("/chunk/upload/chunk/")) return chunkRes();
      if (u.includes("/chunk/upload/complete/")) return completeRes();
      throw new Error(`unexpected url ${u}`);
    };

    const result = await shareFile(SRC, { baseUrl: "http://box:12345", forceChunked: true });

    expect(calls[0]).toContain("/chunk/upload/init/");
    expect(calls.some((u) => u.includes("/chunk/upload/chunk/u1/0"))).toBe(true);
    expect(calls.some((u) => u.includes("/chunk/upload/complete/u1"))).toBe(true);
    expect(result).toEqual({ code: "CHNK", link: "http://box:12345/share/CHNK" });
  });

  test("falls back to chunked when the proxy rejects the single-shot upload", async () => {
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/share/file/")) return new Response("too large for proxy", { status: 413 });
      if (u.endsWith("/chunk/upload/init/")) return initRes();
      if (u.includes("/chunk/upload/chunk/")) return chunkRes();
      if (u.includes("/chunk/upload/complete/")) return completeRes();
      throw new Error(`unexpected url ${u}`);
    };

    const result = await shareFile(SRC, { baseUrl: "http://box:12345" });
    expect(result.code).toBe("CHNK");
    expect(result.link).toBe("http://box:12345/share/CHNK");
  });
});