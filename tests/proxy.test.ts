import { expect, test } from "bun:test";
import { env } from "../src/config";
import { getDownloadRoutes } from "../src/services/proxy";

test("manual proxy is tried once, then direct, and other platforms stay direct", () => {
  const original = env.PROXY_URL;
  try {
    env.PROXY_URL = "http://localhost:8888";
    expect(getDownloadRoutes("youtube")).toEqual([
      { kind: "manual", proxy: env.PROXY_URL },
      { kind: "direct", proxy: "" },
    ]);
    expect(getDownloadRoutes("tiktok")).toEqual([{ kind: "direct", proxy: "" }]);
  } finally {
    env.PROXY_URL = original;
  }
});
