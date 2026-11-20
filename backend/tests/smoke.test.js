"use strict";
// Backend smoke tests (BE-001). Zero-dependency: uses the Node built-in test
// runner (`node --test`). Gives the gate runner something real to execute.

const { test } = require("node:test");
const assert = require("node:assert");

const { loadEnv } = require("../src/config/env.js");
const { createAuth } = require("../src/auth/index.js");
const { createApp } = require("../src/app.js");

const DEV_ENV = { APP_ENV: "development", PORT: "8080", AUTH_PROVIDER: "noop" };

test("loadEnv validates required vars and applies defaults", () => {
  const cfg = loadEnv(DEV_ENV);
  assert.strictEqual(cfg.APP_ENV, "development");
  assert.strictEqual(cfg.PORT, 8080);
  assert.strictEqual(cfg.LOG_LEVEL, "info");
});

test("loadEnv throws on missing required var", () => {
  assert.throws(() => loadEnv({ PORT: "8080" }), /APP_ENV/);
});

test("loadEnv rejects non-integer PORT", () => {
  assert.throws(() => loadEnv({ APP_ENV: "development", PORT: "x" }), /PORT/);
});

test("noop auth is allowed in development and returns null", () => {
  const auth = createAuth(DEV_ENV);
  assert.strictEqual(auth.name, "noop");
  assert.strictEqual(auth.authenticate({ headers: {} }), null);
});

test("noop auth fails closed outside development", () => {
  assert.throws(
    () => createAuth({ APP_ENV: "production", PORT: "8080", AUTH_PROVIDER: "noop" }),
    /only allowed when APP_ENV=development/,
  );
});

test("app composes and serves health + 401 on whoami", () => {
  const app = createApp(DEV_ENV);
  const health = app.handle("GET", "/health");
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.status, "ok");
  const who = app.handle("GET", "/whoami");
  assert.strictEqual(who.status, 401);
  const missing = app.handle("GET", "/nope");
  assert.strictEqual(missing.status, 404);
});
