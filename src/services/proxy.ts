import { spawn } from "bun";
import { createConnection } from "node:net";
import { env } from "../config";
import { logger } from "../utils/logger";

const PROXY_LIST_URL = "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt";
const TEST_URL = "https://www.youtube.com/robots.txt";
const POOL_REFRESH_MS = 10 * 60 * 1000;
const POOL_TARGET_SIZE = 10;
const POOL_TRY_LIMIT = 2;
const BATCH_TEST_SIZE = 20;
const MAX_CANDIDATES = 120;

export interface DownloadRoute {
  kind: "direct" | "manual" | "pool" | "tor";
  proxy: string;
}

const direct: DownloadRoute = { kind: "direct", proxy: "" };
let proxyPool: string[] = [];
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let torAvailable = false;

async function fetchProxyList(): Promise<string[]> {
  const response = await fetch(PROXY_LIST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Proxy list returned HTTP ${response.status}`);

  const lines = (await response.text()).split("\n").map((line) => line.trim());
  // Use remote DNS for SOCKS proxies, as yt-dlp does during the actual download.
  const candidates = lines
    .filter((line) => /^(?:https?|socks5h?):\/\/[^\s]+$/i.test(line))
    .map((line) => line.replace(/^socks5:\/\//i, "socks5h://"));
  return Array.from(new Set(candidates));
}

async function testProxy(proxy: string): Promise<number> {
  try {
    const start = Date.now();
    const proc = spawn([
      "curl", "--disable", "--silent", "--fail", "--output", "/dev/null",
      "--proxy", proxy, "--noproxy", "", "--max-time", "5", TEST_URL,
    ], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0 ? Date.now() - start : Infinity;
  } catch {
    return Infinity;
  }
}

async function buildPool(): Promise<void> {
  try {
    const candidates = (await fetchProxyList())
      .map((proxy) => ({ proxy, order: Math.random() }))
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_CANDIDATES);
    const tested: Array<{ proxy: string; latency: number }> = [];

    for (let i = 0; i < candidates.length && tested.length < POOL_TARGET_SIZE; i += BATCH_TEST_SIZE) {
      const batch = candidates.slice(i, i + BATCH_TEST_SIZE);
      const results = await Promise.all(batch.map(async ({ proxy }) => ({ proxy, latency: await testProxy(proxy) })));
      tested.push(...results.filter(({ latency }) => Number.isFinite(latency)));
    }

    proxyPool = tested.sort((a, b) => a.latency - b.latency)
      .slice(0, POOL_TARGET_SIZE)
      .map(({ proxy }) => proxy);
    logger.info({ poolSize: proxyPool.length }, "Refreshed YouTube proxy pool");
  } catch (err) {
    proxyPool = [];
    logger.warn({ err }, "Could not refresh YouTube proxy pool");
  }
}

function probeTor(): Promise<boolean> {
  const endpoint = new URL(env.TOR_PROXY_URL);
  return new Promise((resolve) => {
    const socket = createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port || 1080) });
    const finish = (available: boolean) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function refreshRoutes(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    await Promise.all([
      env.PROXY_ENABLED && buildPool(),
      env.TOR_ENABLED && probeTor().then((available) => { torAvailable = available; }),
    ]);
  } finally {
    refreshing = false;
  }
}

export async function initProxyPool(): Promise<void> {
  if ((!env.PROXY_ENABLED && !env.TOR_ENABLED) || refreshTimer) return;
  refreshTimer = setInterval(() => void refreshRoutes(), POOL_REFRESH_MS);
  refreshTimer.unref();
  await refreshRoutes();
}

export function getDownloadRoutes(platform: string): DownloadRoute[] {
  if (platform !== "youtube") return [direct];

  const routes: DownloadRoute[] = [];
  if (env.PROXY_URL) routes.push({ kind: "manual", proxy: env.PROXY_URL });
  routes.push(direct);
  if (env.PROXY_ENABLED) {
    const pool = proxyPool.filter((proxy) => proxy !== env.PROXY_URL && proxy !== env.TOR_PROXY_URL);
    routes.push(...pool.slice(0, POOL_TRY_LIMIT).map((proxy): DownloadRoute => ({ kind: "pool", proxy })));
  }
  if (env.TOR_ENABLED && torAvailable && env.TOR_PROXY_URL !== env.PROXY_URL) {
    routes.push({ kind: "tor", proxy: env.TOR_PROXY_URL });
  }
  return routes;
}

export function reportRouteFailure(route: DownloadRoute): void {
  if (route.kind === "pool") {
    proxyPool = proxyPool.filter((proxy) => proxy !== route.proxy);
  }
}

export function shutdown(): void {
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}
