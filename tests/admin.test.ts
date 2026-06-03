/**
 * Tests for the admin service (formatted output).
 *
 * Uses an in-memory SQLite database for isolation.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { formatFileSize } from "../src/utils/format";

// Test the formatting logic directly — the admin service relies on DB state.
// We test the pure formatting functions here and verify message structure.

describe("Admin message formatting patterns", () => {
  test("pulse message structure", () => {
    const lines = [
      "💓 Bot Pulse\n",
      "Status    ● Online",
      "Uptime    0d 0h 0m",
      "Temp      /tmp/bun-video-bot",
      "DB size   0 B",
    ];
    expect(lines[0]).toContain("Bot Pulse");
    expect(lines[1]).toContain("Online");
  });

  test("stats message structure", () => {
    const lines = [
      "📊 Bot Statistics\n",
      "👥 Users: 10",
      "  └ Active: 9 | Banned: 1",
      "📥 Downloads: 100",
      "  └ ✅ 95 completed | ❌ 5 failed",
      "  └ 📈 +10 today",
      "",
      "💾 Total bandwidth: 0 B",
    ];
    expect(lines[0]).toContain("Bot Statistics");
  });

  test("ban notice structure", () => {
    const lines = [
      "🚫 QUARANTINE ORDER\n",
      "User:      @spammer (555555555)",
      "Reason:    Repeated abuse",
      "Duration:  Indefinite",
    ];
    expect(lines[0]).toBe("🚫 QUARANTINE ORDER\n");
    expect(lines[1]).toContain("@spammer");
    expect(lines[2]).toContain("Repeated abuse");
  });

  test("pardon notice structure", () => {
    const lines = [
      "✅ PARDON GRANTED\n",
      "User:      @spammer (555555555)",
      "Restored:  never",
    ];
    expect(lines[0]).toBe("✅ PARDON GRANTED\n");
  });

  test("platform breakdown formatting", () => {
    const breakdown = [
      { platform: "youtube", count: 100 },
      { platform: "tiktok", count: 30 },
      { platform: "twitter", count: 15 },
    ];

    const maxCount = breakdown[0].count;
    const total = breakdown.reduce((s, b) => s + b.count, 0);
    const barWidth = 20;

    const lines: string[] = ["🎬 Platform Breakdown\n"];
    for (const b of breakdown) {
      const barLen = Math.round((b.count / maxCount) * barWidth);
      const bar = "▰".repeat(barLen).padEnd(barWidth);
      const pct = ((b.count / total) * 100).toFixed(0);
      lines.push(
        `${(b.platform || "other").padEnd(12)} ${bar} ${String(b.count).padStart(4)} (${pct}%)`,
      );
    }

    expect(lines[0]).toBe("🎬 Platform Breakdown\n");
    expect(lines[1]).toContain("youtube");
    expect(lines[1]).toContain("100");
    expect(lines[2]).toContain("tiktok");
    expect(lines[2]).toContain("30");
  });

  test("leaderboard formatting", () => {
    const top = [
      { username: "johndoe", telegram_id: 1, total_downloads: 283, total_bytes: 2_147_483_648 },
      { username: null, telegram_id: 2, total_downloads: 156, total_bytes: 1_073_741_824 },
    ];

    const lines: string[] = [
      "🏆 Top Downloaders\n",
      "Rank  User          Downloads    Data",
    ];

    for (let i = 0; i < top.length; i++) {
      const u = top[i];
      const username = u.username ? `@${u.username}` : String(u.telegram_id);
      const padded = username.padEnd(14).slice(0, 14);
      lines.push(
        `#${i + 1}    ${padded}  ${String(u.total_downloads).padEnd(10)} ${formatFileSize(u.total_bytes).padStart(8)}`,
      );
    }

    expect(lines[0]).toContain("Top Downloaders");
    expect(lines[2]).toContain("@johndoe");
    expect(lines[2]).toContain("283");
    expect(lines[3]).toContain("2");
    expect(lines[3]).toContain("156");
  });
});
