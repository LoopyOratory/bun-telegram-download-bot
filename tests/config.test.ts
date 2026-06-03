/**
 * Tests for the config/Zod validation.
 */

import { describe, expect, test } from "bun:test";
import { envSchema } from "../src/config";

describe("envSchema", () => {
  test("parses valid config", () => {
    const env = envSchema.parse({
      BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      OWNER_ID: "123456789",
      ALLOWED_USERS: "123456789,987654321",
      ALLOWED_GROUPS: "-1001234567890,-1009876543210",
      TEMP_DIR: "/tmp/bun-video-bot",
      MAX_FILE_SIZE_MB: "50",
      LOG_LEVEL: "info",
      DATABASE_PATH: "./data/bot.db",
    });

    expect(env.BOT_TOKEN).toBe("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    expect(env.OWNER_ID).toBe(123456789);
    expect(env.ALLOWED_USERS).toEqual([123456789, 987654321]);
    expect(env.ALLOWED_GROUPS).toEqual([-1001234567890, -1009876543210]);
    expect(env.MAX_FILE_SIZE_MB).toBe(50);
    expect(env.LOG_LEVEL).toBe("info");
  });

  test("applies defaults for optional fields", () => {
    const env = envSchema.parse({
      BOT_TOKEN: "123456:abc",
      OWNER_ID: "42",
    });

    expect(env.ALLOWED_USERS).toEqual([]);
    expect(env.ALLOWED_GROUPS).toEqual([]);
    expect(env.TEMP_DIR).toBe("/tmp/bun-video-bot");
    expect(env.MAX_FILE_SIZE_MB).toBe(50);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_PATH).toBe("./data/bot.db");
  });

  test("rejects missing BOT_TOKEN", () => {
    expect(() => envSchema.parse({ OWNER_ID: "42" })).toThrow();
  });

  test("rejects invalid LOG_LEVEL", () => {
    expect(() =>
      envSchema.parse({
        BOT_TOKEN: "123:abc",
        OWNER_ID: "42",
        LOG_LEVEL: "invalid",
      }),
    ).toThrow();
  });

  test("coerces numeric strings to numbers", () => {
    const env = envSchema.parse({
      BOT_TOKEN: "123:abc",
      OWNER_ID: "42",
      MAX_FILE_SIZE_MB: "100",
    });

    expect(env.OWNER_ID).toBe(42);
    expect(env.MAX_FILE_SIZE_MB).toBe(100);
  });

  test("handles empty ALLOWED_USERS", () => {
    const env = envSchema.parse({
      BOT_TOKEN: "123:abc",
      OWNER_ID: "42",
      ALLOWED_USERS: "",
    });

    expect(env.ALLOWED_USERS).toEqual([]);
  });

  test("filters invalid numbers from ALLOWED_USERS", () => {
    const env = envSchema.parse({
      BOT_TOKEN: "123:abc",
      OWNER_ID: "42",
      ALLOWED_USERS: "123,abc,456,,",
    });

    expect(env.ALLOWED_USERS).toEqual([123, 456]);
  });
});
