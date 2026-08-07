import { initProxyPool, getProxy } from "./src/services/proxy";
import { downloadVideo } from "./src/services/downloader";
import { compressVideo, TELEGRAM_UPLOAD_LIMIT_BYTES } from "./src/services/compress";
import { cleanupFile } from "./src/cleanup";
import { mkdir } from "node:fs/promises";

const out = "/tmp/dl-test-jxy2";
await mkdir(out, { recursive: true });
const url = "https://youtu.be/jXyTIQOfTTk?si=o0TjS7QzhNVvRqX";

console.log("▶ initProxyPool() — production startup step…");
await initProxyPool();
console.log("   pool size:", (getProxy() ? "≥1" : "0"), "| fastest:", getProxy());

const started = Date.now();
console.log("▶ downloading (via proxy pool):", url);
const result = await downloadVideo(url, out, (p) => {
  if (p.percent >= 100 || Math.floor(p.percent) % 25 === 0) console.log(`   ${p.percent}% speed=${p.speed} eta=${p.eta}`);
});

const sizeMb = (result.fileSize / 1024 / 1024).toFixed(1);
console.log("✅ downloaded:", result.filePath, "| size:", sizeMb, "MB | format:", result.format);

let sentPath = result.filePath;
if (result.fileSize > TELEGRAM_UPLOAD_LIMIT_BYTES) {
  console.log(`📦 ${sizeMb}MB > Telegram 50MB cap — simulating 413 → compressing…`);
  const t0 = Date.now();
  sentPath = await compressVideo(result.filePath, `${result.filePath}.small.mp4`);
  const c = await Bun.file(sentPath).stat();
  console.log(`   compressed: ${(c.size / 1024 / 1024).toFixed(1)}MB (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
} else {
  console.log(`   ${sizeMb}MB fits Telegram's cap — would send directly.`);
}

console.log(`⏱ download took ${((Date.now() - started) / 1000).toFixed(0)}s`);
await cleanupFile(result.filePath);
if (sentPath !== result.filePath) await cleanupFile(sentPath);
console.log("🧹 cleaned up");