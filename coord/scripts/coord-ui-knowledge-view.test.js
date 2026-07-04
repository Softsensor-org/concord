"use strict";

// COORD-409: /knowledge is a read-only memory/knowledge-compiler cockpit.
//
// The view may load canonical engine modules and read existing artifacts, but it
// must not rebuild memory, run recall/eval, spawn gov, or write derived indexes
// from a web request. Expensive/derived evidence is rendered as a command.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "knowledge.ts");
const PAGE = path.join(UI, "app", "knowledge", "page.tsx");

test("coord-ui /knowledge exists and uses canonical memory engines", () => {
  assert.ok(fs.existsSync(LIB), "lib/knowledge.ts must exist");
  assert.ok(fs.existsSync(PAGE), "app/knowledge/page.tsx must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const engine of [
    "knowledge-claim-compiler.js",
    "memory-graph.js",
    "memory-classification.js",
    "memory-vector.js",
  ]) {
    assert.match(src, new RegExp(engine.replace(".", "\\.")), `knowledge view must reference ${engine}`);
  }
  assert.match(src, /requireExternal/, "knowledge view must load canonical coord/scripts engines");
});

test("coord-ui /knowledge data layer is read-only and avoids expensive request-time eval", () => {
  const src = fs.readFileSync(LIB, "utf8");
  const forbidden = [
    /\bfs\.\w*[wW]rite\w*/,
    /\bfs\.append\w*/,
    /\bfs\.mkdir\w*/,
    /\bfs\.rm\w*/,
    /\bfs\.unlink\w*/,
    /\bchild_process\b/,
    /\bspawn\w*\(/,
    /\bexec\w*\(/,
    /\.rebuild\(/,
    /\.recall\(/,
    /\.evaluate\(/,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(src), `knowledge.ts must not contain request-time mutation/eval surface matching ${re}`);
  }
  assert.match(src, /node coord\/scripts\/memory-eval\.js --json/, "eval evidence must be shown as a command");
});

test("coord-ui /knowledge page is a server read-only surface", () => {
  const src = fs.readFileSync(PAGE, "utf8");
  for (const re of [/'use client'/, /<form\b/i, /<button\b/i, /<input\b/i, /onClick=/, /onSubmit=/, /\bfetch\(/]) {
    assert.ok(!re.test(src), `knowledge page must not contain an interactive mutation surface matching ${re}`);
  }
  assert.match(src, /loadKnowledge/, "page must source from the read-only data layer");
});
