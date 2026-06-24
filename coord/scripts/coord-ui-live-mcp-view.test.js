"use strict";

// COORD-156: read-only invariant + reuse guard for the coord-ui /live-mcp view.
//
// The /live-mcp cockpit view (app/live-mcp/page.tsx) + its data layer
// (lib/live-mcp.ts) surface, per live-MCP ticket, the COORD-153 lifecycle status
// (adapter / environment / operation class / approval / redaction / receipt /
// cleanup / promotion + unresolved closeout blockers) sourced from the COORD-152
// receipts. The HARD constraint (SEC-001/SEC-002) is that this surface is
// STRICTLY READ-ONLY: no mutation, no toggle, no write/POST, no live-tool
// execution. Role-aware (ENT-012): viewer sees redacted summaries only.
//
// This suite reads the TS source as text (the same source-scanning approach
// coord-ui-config-view.test.js uses) and asserts:
//   (A) the data layer carries NO write/spawn/mutation/network primitive;
//   (B) the data layer REUSES the COORD-153 lifecycle gate + COORD-152 receipt
//       readers and the shared role-aware redaction (does not reimplement);
//   (C) the page carries NO form/POST/onClick/onChange/button mutation surface;
//   (D) the page is role-gated and the view is marked read-only.
// Read-only: no board/runtime side effects.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "live-mcp.ts");
const PAGE = path.join(UI, "app", "live-mcp", "page.tsx");

// Mutation/IO primitives that would indicate a write or runtime-mutation path.
// The data layer must only READ.
const FORBIDDEN_LIB = [
  /\bfs\.\w*[wW]rite\w*/, // writeFile, writeFileSync, write
  /\bfs\.append\w*/,
  /\bfs\.mkdir\w*/,
  /\bfs\.rm\w*/,
  /\bfs\.unlink\w*/,
  /\bfs\.rename\w*/,
  /\bchild_process\b/,
  /\bspawn\w*\(/,
  /\bexec\w*\(/,
  /\bexecFile\w*/,
  /\bfetch\(/,
  /\bhttp\b/,
];

test("live-mcp data layer exists and is read-only (no write/spawn/network primitive)", () => {
  assert.ok(fs.existsSync(LIB), "lib/live-mcp.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(!re.test(src), `live-mcp.ts must not contain a mutation/IO primitive matching ${re}`);
  }
  // It reads plan records / receipts (readFileSync / readdirSync) — read-only fs.
  assert.match(src, /fs\.readFileSync|fs\.readdirSync/, "data layer must read its sources");
  assert.match(src, /readOnly:\s*true/, "view must be marked read-only");
});

test("live-mcp data layer REUSES the COORD-153 gate + COORD-152 receipts + shared redaction", () => {
  const src = fs.readFileSync(LIB, "utf8");
  // COORD-153 lifecycle gate — status + blockers, not recomputed.
  assert.match(src, /buildLiveMcpLifecycle/, "must reuse buildLiveMcpLifecycle (COORD-153)");
  assert.match(src, /readLiveMcpDeclaration/, "must reuse explicit live_mcp detection (COORD-153)");
  assert.match(src, /live-mcp-lifecycle\.js/, "must load the COORD-153 lifecycle module");
  // COORD-152 receipt readers.
  assert.match(src, /latestReceipt|readReceipt/, "must reuse the COORD-152 receipt readers");
  assert.match(src, /runtime-evidence\.js/, "must load the COORD-152 receipt module");
  // ENT-012 role-aware redaction via the shared access helper, not reimplemented.
  assert.match(src, /shouldRedact/, "must reuse the shared role-aware redaction (ENT-012)");
});

test("live-mcp data layer surfaces the required status fields + export of unresolved blockers", () => {
  const src = fs.readFileSync(LIB, "utf8");
  for (const field of [
    "adapter",
    "environment",
    "operationClass",
    "approval",
    "redaction",
    "cleanup",
    "promotion",
    "receipt",
    "blockers",
  ]) {
    assert.match(src, new RegExp(field), `view must surface ${field}`);
  }
  // Evidence-export hook: collect unresolved blockers + receipts.
  assert.match(src, /collectLiveMcpExport/, "must export the unresolved-blocker collector");
  assert.match(src, /unresolvedBlockers/, "export collector must carry unresolved blockers");
});

test("live-mcp page is read-only (no form/POST/onClick/onChange/button) and role-gated", () => {
  assert.ok(fs.existsSync(PAGE), "app/live-mcp/page.tsx must exist");
  const src = fs.readFileSync(PAGE, "utf8");
  const FORBIDDEN_PAGE = [
    /<form\b/i,
    /<button\b/i,
    /<input\b/i,
    /onClick=/,
    /onChange=/,
    /onSubmit=/,
    /\bfetch\(/,
    /method:\s*['"`]POST['"`]/i,
    /'use client'/, // server component; no client mutation surface
  ];
  for (const re of FORBIDDEN_PAGE) {
    assert.ok(!re.test(src), `live-mcp page must not contain a mutation surface matching ${re}`);
  }
  assert.match(src, /loadLiveMcpView/, "page must source from the read-only data layer");
  assert.match(src, /requireRole/, "page must gate access (SEC-001)");
});
