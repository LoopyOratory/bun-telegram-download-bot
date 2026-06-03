/**
 * Test setup — runs before all test files.
 * Sets environment variables required by the config module.
 */

// Set required env vars before any test file imports config
if (!process.env.BOT_TOKEN) {
  process.env.BOT_TOKEN = "test:1234567890:placeholder-token";
}
if (!process.env.OWNER_ID) {
  process.env.OWNER_ID = "123456789";
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}
if (!process.env.ALLOWED_USERS) {
  process.env.ALLOWED_USERS = "123456789";
}
