import { spawn } from "bun";
import { env } from "../config";
import { logger } from "../utils/logger";

const PROXY_LIST_URL =
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt";

const TEST_URL = "https://www.google.com";
const TEST_TIMEOUT_MS = 5_000;
const POOL_REFRESH_MS = 10 * 60 * 1000;
const POOL_TARGET_SIZE = 10;
const POOL_MIN_SIZE = 3;
const BATCH_TEST_SIZE = 30;

let proxyPool: string[] = [];
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function fetchProxyList(): Promise<string[]> {
  const response = await fetch(PROXY_LIST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch proxy list: ${response.status}`);
  }
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

async function testProxy(proxy: string): Promise<{ proxy: string; latencyMs: number } | null> {
  try {
    const start = Date.now();
    const proc = spawn([
      "curl",
      "-s", "-o", "/dev/null",
      "-w", "%{http_code}",
      "--proxy", proxy,
      "--max-time", String(TEST_TIMEOUT_MS / 1000),
      TEST_URL,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const latencyMs = Date.now() - start;

    if (exitCode !== 0) return null;
    const code = parseInt(stdout.trim(), 10);
    if (code >= 200 && code < 400) {
      return { proxy, latencyMs };
    }
    return null;
  } catch {
    return null;
  }
}

async function buildPool(): Promise<void> {
  try {
    const allProxies = await fetchProxyList();
    const candidates = allProxies.sort(() => Math.random() - 0.5);

    const tested: { proxy: string; latencyMs: number }[] = [];

    for (let i = 0; i < candidates.length && tested.length < POOL_TARGET_SIZE; i += BATCH_TEST_SIZE) {
      const batch = candidates.slice(i, i + BATCH_TEST_SIZE);
      const results = await Promise.all(batch.map(testProxy));

      for (const r of results) {
        if (r) tested.push(r);
        if (tested.length >= POOL_TARGET_SIZE) break;
      }
    }

    if (tested.length > 0) {
      tested.sort((a, b) => a.latencyMs - b.latencyMs);
      proxyPool = tested.map((t) => t.proxy);
      logger.info(
        { poolSize: proxyPool.length, fastestMs: tested[0].latencyMs, slowestMs: tested[tested.length - 1].latencyMs },
        "Proxy pool built (sorted by speed)",
      );
    } else if (proxyPool.length === 0) {
      logger.warn("Proxy pool is empty — all proxies failed testing");
    } else {
      logger.warn({ poolSize: proxyPool.length }, "Proxy refresh found no working proxies — keeping existing pool");
    }
  } catch (err) {
    logger.error({ err }, "Failed to build proxy pool");
  }
}

export async function initProxyPool(): Promise<void> {
  if (!env.PROXY_ENABLED || env.PROXY_URL) {
    logger.info("Proxy pool disabled (manual PROXY_URL or PROXY_ENABLED=false)");
    return;
  }

  logger.info("Initializing proxy pool...");
  await buildPool();

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(buildPool, POOL_REFRESH_MS);
}

export function getProxy(): string | null {
  if (env.PROXY_URL) {
    return env.PROXY_URL;
  }

  if (!env.PROXY_ENABLED) {
    return null;
  }

  if (proxyPool.length === 0) {
    return null;
  }

  return proxyPool[0];
}

export function reportFailure(proxy: string): void {
  if (env.PROXY_URL) return;

  const idx = proxyPool.indexOf(proxy);
  if (idx !== -1) {
    proxyPool.splice(idx, 1);
    logger.warn({ proxy, remainingPool: proxyPool.length }, "Proxy removed from pool after failure");
  }
}

export function isTorAvailable(): boolean {
  return env.TOR_ENABLED;
}

export function getTorArgs(): string[] {
  return ["--tor", "on"];
}

export function shutdown(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
