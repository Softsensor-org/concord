"use strict";

// COORD-156 / COORD-438: read-only invariant plus executable behavior checks
// for the coord-ui /live-mcp view-model. The test exercises the same pure CJS
// model used by the TS server data layer, so redaction/receipt/blocker behavior
// is protected without requiring a frontend test runner in this repo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "live-mcp.ts");
const PAGE = path.join(UI, "app", "live-mcp", "page.tsx");
const core = require("./coord-ui-live-mcp-view-model.js");

const FORBIDDEN_LIB = [
  /\bfs\.\w*[wW]rite\w*/,
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

test("live-mcp data layer remains read-only and delegates behavior to the view-model core", () => {
  assert.ok(fs.existsSync(LIB), "lib/live-mcp.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(!re.test(src), `live-mcp.ts must not contain a mutation/IO primitive matching ${re}`);
  }
  assert.match(src, /coord-ui-live-mcp-view-model\.js/, "data layer must load the executable view-model core");
  assert.match(src, /readOnly:\s*true/, "view must be marked read-only");
});

test("live-mcp view-model builds privileged ticket behavior from lifecycle + receipt evidence", () => {
  const lifecycle = {
    buildLiveMcpLifecycle: () => ({
      declared: true,
      issues: [{ code: "cleanup_missing", message: "Cleanup receipt missing" }],
    }),
  };
  const receipts = {
    latestReceipt: () => null,
    readReceipt: () => {
      throw new Error("not used for inline receipt");
    },
  };
  const ticket = core.buildTicketView({
    id: "COORD-X",
    status: " review ",
    planState: { live_mcp: true },
    declaration: {
      adapter: " postgres ",
      operation: " select sensitive_table ",
      environment: "prod",
      operation_class: "read_prod",
      scope: "tenant=demo",
      approval: "approved by ops",
      redaction: "customer ids masked",
      cleanup: "not required",
      promotion: "normal fix lane",
      receipt: { result: "observed" },
      development_ticket: "COORD-123",
      deployed_verification: "receipts/live-mcp/COORD-X.json",
    },
    lifecycle,
    receipts,
    redacted: false,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });

  assert.equal(ticket.status, "review");
  assert.equal(ticket.adapter, "postgres");
  assert.equal(ticket.operation, "select sensitive_table");
  assert.equal(ticket.operationClass, "read_prod");
  assert.deepEqual(ticket.scope, { state: "present", detail: "tenant=demo" });
  assert.deepEqual(ticket.receipt, { state: "present", result: "observed", path: null });
  assert.deepEqual(ticket.blockers, [{ code: "cleanup_missing", message: "Cleanup receipt missing" }]);
  assert.equal(ticket.linkedDevelopmentTicket, "COORD-123");
  assert.equal(ticket.deployedVerificationReceipt, "receipts/live-mcp/COORD-X.json");
});

test("live-mcp view-model redacts viewer detail but keeps safe coarse status", () => {
  const lifecycle = { buildLiveMcpLifecycle: () => ({ declared: true, issues: [] }) };
  const ticket = core.buildTicketView({
    id: "COORD-X",
    status: "doing",
    planState: {},
    declaration: {
      adapter: "postgres",
      operation: "select secret",
      environment: "prod",
      operation_class: "read_prod",
      scope: "tenant=secret",
      approval: "ticket COORD-1",
      receipt: { result: "pass" },
      deploy_receipt: "coord/.runtime/receipts/deploy.json",
    },
    lifecycle,
    receipts: null,
    redacted: true,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });

  assert.equal(ticket.adapter, "postgres");
  assert.equal(ticket.operation, null);
  assert.equal(ticket.environment, "prod");
  assert.deepEqual(ticket.scope, { state: "present", detail: null });
  assert.deepEqual(ticket.approval, { state: "present", detail: null });
  assert.deepEqual(ticket.receipt, { state: "unknown", result: null, path: null });
  assert.equal(ticket.deployedVerificationReceipt, null);
});

test("live-mcp receipt behavior distinguishes absent, unreadable, and recorded receipts", () => {
  const engine = {
    latestReceipt: () => "/tmp/live-mcp-receipt.json",
    readReceipt: () => ({ result: "pass" }),
  };
  assert.deepEqual(
    core.receiptStatus({
      id: "COORD-X",
      declaration: {},
      engine,
      redacted: false,
      coordDir: "/repo/coord",
      projectRoot: "/repo",
      fsImpl: { existsSync: () => true },
      pathImpl: path,
    }),
    { state: "present", result: "pass", path: path.relative("/repo", "/tmp/live-mcp-receipt.json") }
  );
  assert.deepEqual(
    core.receiptStatus({
      id: "COORD-X",
      declaration: {},
      engine: { latestReceipt: () => null, readReceipt: () => ({}) },
      redacted: false,
      coordDir: "/repo/coord",
      projectRoot: "/repo",
      fsImpl: { existsSync: () => false },
      pathImpl: path,
    }),
    { state: "absent", result: null, path: null }
  );
  assert.deepEqual(
    core.receiptStatus({
      id: "COORD-X",
      declaration: {},
      engine: { latestReceipt: () => "/tmp/bad.json", readReceipt: () => { throw new Error("bad"); } },
      redacted: false,
      coordDir: "/repo/coord",
      projectRoot: "/repo",
      fsImpl: { existsSync: () => true },
      pathImpl: path,
    }),
    { state: "unknown", result: null, path: null }
  );
});

test("live-mcp export collector emits unresolved blockers and receipt paths", () => {
  const lifecycle = {
    buildLiveMcpLifecycle: () => ({ issues: [{ code: "promotion_missing", message: "Promote first" }] }),
  };
  const row = core.collectLiveMcpExportTicket({
    id: "COORD-X",
    planState: {},
    declaration: { adapter: "ops-mcp", operation_class: "read_safe", environment: "staging" },
    lifecycle,
    receipts: null,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });
  assert.deepEqual(row, {
    id: "COORD-X",
    adapter: "ops-mcp",
    operationClass: "read_safe",
    environment: "staging",
    receiptPath: null,
    unresolvedBlockers: [{ code: "promotion_missing", message: "Promote first" }],
  });
});

test("live-mcp page remains read-only and role-gated", () => {
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
    /'use client'/,
  ];
  for (const re of FORBIDDEN_PAGE) {
    assert.ok(!re.test(src), `live-mcp page must not contain a mutation surface matching ${re}`);
  }
  assert.match(src, /loadLiveMcpView/, "page must source from the read-only data layer");
  assert.match(src, /requireRole/, "page must gate access (SEC-001)");
});
