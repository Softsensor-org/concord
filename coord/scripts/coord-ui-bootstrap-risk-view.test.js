"use strict";

// COORD-163: read-only invariant + reuse guard for the coord-ui /bootstrap-risk view.
//
// The /bootstrap-risk surface (app/bootstrap-risk/page.tsx) + its data layer
// (lib/bootstrap-risk.ts) surface, per ticket carrying server-bootstrap /
// backfill / generated-data risk, the COORD-159 bootstrap_risk plan field
// (work class / runs-at-boot / shares-app-process / resource envelope /
// idempotency / checkpoint / verification signal / rollback-disable /
// observability / data-access shape), the COORD-161 receipt (job completion),
// and the COORD-160/162 unresolved advisory warnings. The HARD constraint
// (SEC-001/SEC-002 + the ticket text) is that this surface is STRICTLY
// READ-ONLY: no mutation, no toggle, no write/POST, NO job execution, NO
// shelling out, NO live cloud/API call. Role-aware (ENT-012): viewer sees
// redacted summaries only. SERVER READINESS and JOB COMPLETION are modelled as
// separate states.
//
// This suite reads the TS source as text (the same source-scanning approach
// coord-ui-live-mcp-view.test.js uses) and asserts:
//   (A) the data layer carries NO write/spawn/exec/network primitive;
//   (B) the data layer REUSES the COORD-160 advisory + COORD-162 query scan +
//       COORD-161 receipt readers and the shared role-aware redaction;
//   (C) the data layer surfaces every required field AND models server-readiness
//       SEPARATELY from job-completion;
//   (D) the page carries NO form/POST/onClick/onChange/button mutation surface,
//       is role-gated, read-only, and labels readiness vs completion separately.
// Read-only: no board/runtime side effects.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "bootstrap-risk.ts");
const PAGE = path.join(UI, "app", "bootstrap-risk", "page.tsx");

// Mutation/IO/exec/network primitives that would indicate a write, job
// execution, shell-out, or live call. The data layer must only READ.
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

test("bootstrap-risk data layer exists and is read-only (no write/spawn/exec/network primitive)", () => {
  assert.ok(fs.existsSync(LIB), "lib/bootstrap-risk.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(
      !re.test(src),
      `bootstrap-risk.ts must not contain a mutation/exec/IO primitive matching ${re}`
    );
  }
  // It reads plan records / receipts (readFileSync / readdirSync) — read-only fs.
  assert.match(src, /fs\.readFileSync|fs\.readdirSync/, "data layer must read its sources");
  assert.match(src, /readOnly:\s*true/, "view must be marked read-only");
});

test("bootstrap-risk data layer REUSES the COORD-159/160/161/162 substrate + shared redaction", () => {
  const src = fs.readFileSync(LIB, "utf8");
  // COORD-160 advisory — unresolved warnings + missing evidence, not recomputed.
  assert.match(src, /buildBootstrapAdvisory/, "must reuse buildBootstrapAdvisory (COORD-160)");
  assert.match(src, /bootstrap-advisory\.js/, "must load the COORD-160 advisory module");
  // COORD-162 broad-query scan.
  assert.match(src, /scanBackfillQueryText/, "must reuse scanBackfillQueryText (COORD-162)");
  assert.match(src, /backfill-query-advisory\.js/, "must load the COORD-162 advisory module");
  // COORD-161 bootstrap receipt readers.
  assert.match(src, /latestReceipt|readReceipt/, "must reuse the COORD-161 receipt readers");
  assert.match(src, /runtime-evidence\.js/, "must load the COORD-161 receipt module");
  assert.match(src, /'bootstrap'/, "must read the bootstrap receipt kind (COORD-161)");
  // COORD-159 plan field — read straight off the plan record, not recomputed.
  assert.match(src, /bootstrap_risk/, "must read the COORD-159 bootstrap_risk plan field");
  // ENT-012 role-aware redaction via the shared access helper, not reimplemented.
  assert.match(src, /shouldRedact/, "must reuse the shared role-aware redaction (ENT-012)");
});

test("bootstrap-risk data layer surfaces every required field", () => {
  const src = fs.readFileSync(LIB, "utf8");
  for (const field of [
    "serverReadiness",
    "runsAtBoot",
    "sharesAppProcess",
    "resourceEnvelope",
    "idempotency",
    "checkpoint",
    "verificationSignal",
    "rollbackOrDisable",
    "observability",
    "dataAccessShape",
    "jobCompletion",
    "matchedSignals",
    "missingEvidence",
    "queryWarnings",
  ]) {
    assert.match(src, new RegExp(field), `view must surface ${field}`);
  }
});

test("bootstrap-risk data layer models SERVER READINESS separately from JOB COMPLETION", () => {
  const src = fs.readFileSync(LIB, "utf8");
  // Two distinct exported interfaces — readiness (design) and completion (receipt).
  assert.match(src, /interface\s+ServerReadiness\b/, "must define a ServerReadiness type");
  assert.match(src, /interface\s+JobCompletion\b/, "must define a JobCompletion type");
  // The two are distinct fields on the ticket view, not collapsed into one.
  assert.match(src, /serverReadiness:\s*ServerReadiness/, "ticket view must carry serverReadiness");
  assert.match(src, /jobCompletion:\s*JobCompletion/, "ticket view must carry jobCompletion");
  // The completion evidence is the receipt; readiness must NOT be sourced from it.
  assert.match(
    src,
    /readiness[^]*NOT[^]*proof|NOT[^]*finished[\s\S]{0,400}job/i,
    "the source must document that readiness is not proof the job ran"
  );
});

test("bootstrap-risk page is read-only (no form/POST/onClick/onChange/button/exec) and role-gated", () => {
  assert.ok(fs.existsSync(PAGE), "app/bootstrap-risk/page.tsx must exist");
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
    /\bspawn\w*\(/,
    /\bexec\w*\(/,
    /\bchild_process\b/,
    /'use client'/, // server component; no client mutation surface
  ];
  for (const re of FORBIDDEN_PAGE) {
    assert.ok(!re.test(src), `bootstrap-risk page must not contain a mutation/exec surface matching ${re}`);
  }
  assert.match(src, /loadBootstrapRiskView/, "page must source from the read-only data layer");
  assert.match(src, /requireRole/, "page must gate access (SEC-001)");
  // The page must label the two states separately so they are not conflated.
  assert.match(src, /Server readiness/i, "page must label server readiness");
  assert.match(src, /Job completion/i, "page must label job completion");
});
