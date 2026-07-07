"use strict";

// COORD-163 / COORD-438: read-only invariant plus executable behavior checks
// for the coord-ui /bootstrap-risk view-model. The test protects the concrete
// readiness/completion split and receipt/advisory behavior without requiring a
// frontend test runner in this repo.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");
const LIB = path.join(UI, "lib", "bootstrap-risk.ts");
const PAGE = path.join(UI, "app", "bootstrap-risk", "page.tsx");
const core = require("./coord-ui-bootstrap-risk-view-model.js");

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

test("bootstrap-risk data layer remains read-only and delegates behavior to the view-model core", () => {
  assert.ok(fs.existsSync(LIB), "lib/bootstrap-risk.ts must exist");
  const src = fs.readFileSync(LIB, "utf8");
  for (const re of FORBIDDEN_LIB) {
    assert.ok(
      !re.test(src),
      `bootstrap-risk.ts must not contain a mutation/exec/IO primitive matching ${re}`
    );
  }
  assert.match(src, /coord-ui-bootstrap-risk-view-model\.js/, "data layer must load the executable view-model core");
  assert.match(src, /readOnly:\s*true/, "view must be marked read-only");
});

test("bootstrap-risk view-model classifies server readiness from declared design only", () => {
  assert.deepEqual(core.serverReadiness(null), {
    workClass: null,
    runsAtBoot: null,
    sharesAppProcess: null,
    posture: "undeclared",
  });
  assert.deepEqual(
    core.serverReadiness({
      startup_work_class: " server_bootstrap_job ",
      runs_at_boot: true,
      shares_app_process: true,
    }),
    {
      workClass: "server_bootstrap_job",
      runsAtBoot: true,
      sharesAppProcess: true,
      posture: "declared-risky",
    }
  );
  assert.equal(
    core.serverReadiness({ runs_at_boot: false, shares_app_process: true }).posture,
    "declared-safe"
  );
});

test("bootstrap-risk view-model keeps job completion as receipt evidence, separate from readiness", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-bootstrap-receipt-"));
  const receipt = path.join(dir, "COORD-X.json");
  fs.writeFileSync(receipt, JSON.stringify({ result: "success" }));
  const receipts = {
    latestReceipt: (kind, ticket, options) => {
      assert.equal(kind, "bootstrap");
      assert.equal(ticket, "COORD-X");
      assert.equal(options.coordDir, path.join(REPO_ROOT, "coord"));
      return receipt;
    },
    readReceipt: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
  };
  const queryEngine = {
    scanBackfillQueryText: (text) => {
      assert.match(text, /SELECT \*/);
      return { findings: [{ rule: "broad_select", severity: "warning", message: "query is broad" }] };
    },
  };
  const advisory = {
    triggered: true,
    matched_signals: ["backfill"],
    missing_evidence: ["checkpoint_strategy"],
    message: "Bootstrap risk detected",
  };
  const ticket = core.buildTicketView({
    id: "COORD-X",
    row: { Status: " review " },
    planState: {
      bootstrap_risk: {
        startup_work_class: "server_bootstrap_job",
        runs_at_boot: false,
        shares_app_process: true,
        resource_envelope: {
          memory_mb: 512,
          timeout_s: 60,
          expected_rows: 1000,
          batch_size: 100,
          db_pool_impact: "read-only pool",
        },
        idempotency_strategy: "claim lease before work",
        checkpoint_strategy: "checkpoint every batch",
        verification_signal: "receipt row count",
        rollback_or_disable: "feature flag",
        observability_requirements: ["logs", "metrics"],
        data_access_shape: "SELECT * FROM boards",
      },
    },
    source: "plan-field",
    advisory,
    queryEngine,
    receipts,
    redacted: false,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });

  assert.equal(ticket.status, "review");
  assert.equal(ticket.serverReadiness.posture, "declared-safe");
  assert.deepEqual(ticket.jobCompletion, {
    state: "present",
    result: "success",
    path: path.relative(REPO_ROOT, receipt).split(path.sep).join("/"),
  });
  assert.equal(ticket.resourceEnvelope.summary, "memory=512mb, timeout=60s, rows=1000, batch=100, db=read-only pool");
  assert.deepEqual(ticket.observability.items, ["logs", "metrics"]);
  assert.deepEqual(ticket.missingEvidence, ["checkpoint_strategy"]);
  assert.deepEqual(ticket.queryWarnings, [{ rule: "broad_select", severity: "warning", message: "query is broad" }]);
});

test("bootstrap-risk view-model redacts viewer detail without hiding risk posture", () => {
  const ticket = core.buildTicketView({
    id: "COORD-X",
    row: { Status: "todo" },
    planState: {
      bootstrap_risk: {
        runs_at_boot: true,
        shares_app_process: true,
        resource_envelope: { memory_mb: 2048 },
        idempotency_strategy: "tenant-specific key",
        observability_requirements: ["cloudwatch"],
      },
    },
    source: "plan-field",
    advisory: { triggered: false, matched_signals: [], missing_evidence: [], message: null },
    queryEngine: null,
    receipts: null,
    redacted: true,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });
  assert.equal(ticket.serverReadiness.posture, "declared-risky");
  assert.deepEqual(ticket.resourceEnvelope, { state: "present", summary: null });
  assert.deepEqual(ticket.idempotency, { state: "present", detail: null });
  assert.deepEqual(ticket.observability, { state: "present", items: null });
  assert.deepEqual(ticket.jobCompletion, { state: "unknown", result: null, path: null });
});

test("bootstrap-risk view-model surfaces advisory-only rows without inventing declared readiness", () => {
  const ticket = core.buildTicketView({
    id: "COORD-X",
    row: undefined,
    planState: {},
    source: "advisory-only",
    advisory: {
      triggered: true,
      matched_signals: ["runBackfillOnceOnBoot"],
      missing_evidence: ["bootstrap_risk"],
      message: "Potential boot-time work",
    },
    queryEngine: null,
    receipts: null,
    redacted: false,
    coordDir: path.join(REPO_ROOT, "coord"),
    projectRoot: REPO_ROOT,
  });
  assert.equal(ticket.status, "unknown");
  assert.equal(ticket.source, "advisory-only");
  assert.equal(ticket.serverReadiness.posture, "undeclared");
  assert.equal(ticket.jobCompletion.state, "unknown");
  assert.deepEqual(ticket.matchedSignals, ["runBackfillOnceOnBoot"]);
  assert.deepEqual(ticket.missingEvidence, ["bootstrap_risk"]);
});

test("bootstrap-risk page remains read-only, role-gated, and labels readiness vs completion", () => {
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
    /'use client'/,
  ];
  for (const re of FORBIDDEN_PAGE) {
    assert.ok(!re.test(src), `bootstrap-risk page must not contain a mutation/exec surface matching ${re}`);
  }
  assert.match(src, /loadBootstrapRiskView/, "page must source from the read-only data layer");
  assert.match(src, /requireRole/, "page must gate access (SEC-001)");
  assert.match(src, /Server readiness/i, "page must label server readiness");
  assert.match(src, /Job completion/i, "page must label job completion");
});
