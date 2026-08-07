import { downloadVideo } from "./src/services/downloader";
import { compressVideo, TELEGRAM_UPLOAD_LIMIT_BYTES } from "./src/services/compress";
import { cleanupFile } from "./src/cleanup";
import { mkdir, stat } from "node:fs/promises";

const out = "/tmp/dl-test-jxy";
await mkdir(out, { recursive: true });

const url = "https://youtu.be/jXyTIQOfTTk?si=o0TjS7QzhNVvRqX"; // as the handler would capture it
const started = Date.now();

console.log("▶ downloading:", url);
const result = await downloadVideo(url, out, (p) => {
  if (p.percent >= 100 || Math.floor(p.percent) % 25 === 0) console.log(`   ${p.percent}% speed=${p.speed} eta=${p.eta}`);
});

const sizeMb = (result.fileSize / 1024 / 1024).toFixed(1);
console.log("✅ downloaded:", result.filePath);
console.log("   size:", sizeMb, "MB | format:", result.format);

let sentPath = result.filePath;
if (result.fileSize > TELEGRAM_UPLOAD_LIMIT_BYTES) {
  console.log(`\n📦 ${sizeMb}MB > ${TELEGRAM_UPLOAD_LIMIT_BYTES / 1024 / 1024}MB Telegram cap — simulating 413 → compressing…`);
  const t0 = Date.now();
  sentPath = await compressVideo(result.filePath, `${result.filePath}.small.mp4`);
  const c = await Bun.file(sentPath).stat();
  console.log(`   compressed: ${(c.size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t0) / 1000).toFixed(0)}s) ▶ would send this`);
} else {
  console.log(`\n   ${sizeMb}MB fits under Telegram's cap — would send directly (no compression).`);
}

const downloadSec = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n⏱ total download time: ${downloadSec}s`);

// cleanup both (what doDownload's finally does)
await cleanupFile(result.filePath);
if (sentPath !== result.filePath) await cleanupFile(sentPath);
console.log("🧹 disk cleanup done — files deleted");