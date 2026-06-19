"use strict";
// Frontend shell smoke tests (FE-001). Zero-dependency `node --test`.

const { test } = require("node:test");
const assert = require("node:assert");

const { loadEnv } = require("../src/config/env.js");
const { createShell } = require("../src/app/shell.js");

const BASE = { APP_ENV: "development", API_BASE_URL: "http://localhost:8080" };
const authed = { store: { read: () => ({ id: "u1", roles: ["admin"] }) } };
const anon = { store: { read: () => null } };

test("loadEnv validates required vars and applies defaults", () => {
  const cfg = loadEnv(BASE);
  assert.strictEqual(cfg.API_BASE_URL, "http://localhost:8080");
  assert.strictEqual(cfg.AUTH_MODE, "redirect");
  assert.strictEqual(cfg.LOGIN_ROUTE, "/login");
});

test("loadEnv throws on missing API_BASE_URL", () => {
  assert.throws(() => loadEnv({ APP_ENV: "development" }), /API_BASE_URL/);
});

test("loadEnv refuses secret-looking keys", () => {
  assert.throws(() => loadEnv({ ...BASE, API_TOKEN_SECRET: "x" }), /secret-looking/);
});

test("public route allows anonymous", () => {
  const shell = createShell(BASE, anon);
  assert.strictEqual(shell.navigate("/").status, 200);
});

test("protected route redirects anonymous to login", () => {
  const shell = createShell(BASE, anon);
  const r = shell.navigate("/dashboard");
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.redirectTo, "/login");
  assert.strictEqual(r.reason, "unauthenticated");
});

test("role-gated route forbids without role, allows with role", () => {
  assert.strictEqual(createShell(BASE, anon).navigate("/admin").status, 302);
  const adminShell = createShell(BASE, authed);
  assert.strictEqual(adminShell.navigate("/admin").status, 200);
  assert.strictEqual(adminShell.navigate("/dashboard").status, 200);
});

test("unknown route is 404", () => {
  assert.strictEqual(createShell(BASE, anon).navigate("/nope").status, 404);
});
