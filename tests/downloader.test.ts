import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/config";
import { DownloadErrorCode } from "../src/types";
import { buildYtDlpArgs, classifyYtDlpError, downloadVideo, listFormats } from "../src/services/downloader";

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

describe("buildYtDlpArgs format selection", () => {
  test("YouTube only selects formats with audio and stops on missing fragments", () => {
    const args = buildYtDlpArgs({ url: "https://youtu.be/example", outputPath: "/tmp/out.%(ext)s", platform: "youtube" });
    expect(args[args.indexOf("-f") + 1]).toBe(
      "bv[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv+ba/b",
    );
    expect(args).toContain("--abort-on-unavailable-fragments");
    expect(args).toContain("--no-simulate");
  });
});

async function withMediaCommands(run: (outputDir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "hermes-test-"));
  const outputDir = join(dir, "downloads");
  const path = process.env.PATH;
  const proxy = env.PROXY_URL;

  try {
    await mkdir(outputDir);
    await writeFile(join(dir, "yt-dlp"), `#!${process.execPath}
const args = process.argv.slice(2);
const proxy = args[args.indexOf("--proxy") + 1];
const output = args.includes("-o") && args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4");
if (proxy) {
  if (output) await Bun.write(output + ".part", "partial");
  console.error("ERROR: proxy connection refused");
  process.exit(1);
}
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({ formats: [
    { format_id: "v17", height: 720, vcodec: "avc1", acodec: "none" },
    { format_id: "audio17", vcodec: "none", acodec: "opus" },
  ] }));
} else {
  if (args.at(-1).includes("hanging")) {
    await Bun.write(output + ".part", "partial");
    await Bun.sleep(60_000);
    process.exit(1);
  }
  await Bun.write(output, args.at(-1).includes("silent") ? "silent" : "av");
  console.log("[download] 20.5% of 10MiB at 1MiB/s ETA 00:07");
  console.log("final-file:" + JSON.stringify(output));
}
`, { mode: 0o755 });
    await writeFile(join(dir, "ffprobe"), `#!${process.execPath}
const streams = [{codec_type: "video", codec_name: "h264"}];
if (await Bun.file(process.argv.at(-1)).text() === "av") streams.push({codec_type: "audio", codec_name: "aac"});
console.log(JSON.stringify({streams, format: {duration: "9000"}}));
`, { mode: 0o755 });

    process.env.PATH = `${dir}:${path}`;
    env.PROXY_URL = "http://user:secret@127.0.0.1:1";
    await run(outputDir);
  } finally {
    process.env.PATH = path;
    env.PROXY_URL = proxy;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("YouTube download pipeline", () => {
  test("falls back from the configured proxy and keeps only the verified final file", async () => {
    await withMediaCommands(async (outputDir) => {
      const url = "https://youtu.be/example";
      const [format] = await listFormats(url);
      expect(format.resolution).toBe("720p");
      expect(format.code).toContain("bv[height=720]+ba/b[height=720]");

      const progress: number[] = [];
      const result = await downloadVideo(url, outputDir, (event) => progress.push(event.percent), 0, format.code);
      expect(progress).toEqual([20.5]);
      expect(result.durationMs).toBe(9_000_000);
      expect(await readdir(outputDir)).toEqual([`${result.videoId}.mp4`]);
    });
  });

  test("rejects successful yt-dlp output with no audio and cleans up both attempts", async () => {
    await withMediaCommands(async (outputDir) => {
      await expect(downloadVideo("https://youtu.be/silent", outputDir)).rejects.toMatchObject({
        code: DownloadErrorCode.INVALID_MEDIA,
      });
      expect(await readdir(outputDir)).toEqual([]);
    });
  });
  test("enforces the total timeout and cleans up the interrupted attempt", async () => {
    await withMediaCommands(async (outputDir) => {
      const source = new URL("../src/services/downloader.ts", import.meta.url).pathname;
      const script = `
        const { downloadVideo } = await import(${JSON.stringify(source)});
        try {
          await downloadVideo("https://youtu.be/hanging", ${JSON.stringify(outputDir)});
          process.exitCode = 1;
        } catch (error) {
          if (error.code !== "TIMEOUT") throw error;
        }
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, DOWNLOAD_TIMEOUT_SECONDS: "1", PROXY_URL: "" },
        stdout: "ignore",
        timeout: 4_000,
        killSignal: "SIGKILL",
      });

      expect(await child.exited).toBe(0);
      expect(await readdir(outputDir)).toEqual([]);
    });
  });

});
