// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
// Behavior tests for coord/scripts/token-economics.js — the cost-ledger,
// precheck, context-pack, tier-policy, plan-waves, and dispatch-plan levers
// (TOKEN_ECONOMICS.md). Relocated verbatim from governance.test.js by COORD-096
// (residual facade split, slice 1): every assertion here drives a function
// DEFINED in token-economics.js, exercised through the governance facade's
// executeCommand/__testing surface (the real call path the module ships).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { executeCommand, __testing } = require("./governance.js");
const { withCanonicalTicketPrompt } = require("./governance-test-utils.js");

// ---------------------------------------------------------------------------
// COORD-026: cost-ledger (TOKEN_ECONOMICS.md lever #1).
// ---------------------------------------------------------------------------

const COST_PRICE_FIXTURE = {
  schema_version: 1,
  currency: "USD",
  unit: "per_1m_tokens",
  models: {
    small: { input: 0.25, output: 1.25 },
    standard: { input: 3.0, output: 15.0 },
    frontier: { input: 15.0, output: 75.0 },
  },
  default: { input: 99.0, output: 99.0 },
};

function withCostLedgerEnv(prefix, board, fn) {
  const coordRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtimeDir = path.join(coordRoot, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const boardPath = path.join(coordRoot, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const pricesPath = path.join(coordRoot, "model-prices.json");
  fs.writeFileSync(pricesPath, JSON.stringify(COST_PRICE_FIXTURE, null, 2), "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
    MODEL_PRICES_PATH: __testing.paths.MODEL_PRICES_PATH,
    LOCKS_DIR: __testing.paths.LOCKS_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  __testing.paths.MODEL_PRICES_PATH = pricesPath;
  __testing.paths.LOCKS_DIR = path.join(runtimeDir, "locks");
  try {
    return fn({ coordRoot, boardPath, pricesPath, eventLogPath: __testing.paths.GOVERNANCE_EVENT_LOG_PATH });
  } finally {
    for (const key of Object.keys(original)) {
      __testing.paths[key] = original[key];
    }
  }
}

const COST_BOARD = {
  metadata: { title: "Cost Ledger Test Board" },
  sections: [
    {
      rows: [
        { ID: "C-001", Repo: "X", Status: "doing", Owner: "concord1", Description: "ledger ticket" },
        { ID: "C-002", Repo: "X", Status: "doing", Owner: "concord1", Description: "second ticket" },
      ],
    },
  ],
};

test("COORD-026: readModelPrices loads the data-driven table; resolveModelPrice matches exact then default", () => {
  withCostLedgerEnv("cost-prices-", COST_BOARD, () => {
    const prices = __testing.readModelPrices();
    assert.equal(prices.models.standard.input, 3.0);
    assert.equal(__testing.resolveModelPrice("standard", prices).matched, "standard");
    assert.equal(__testing.resolveModelPrice("STANDARD", prices).matched, "standard", "case-insensitive");
    const unknown = __testing.resolveModelPrice("totally-unknown-model", prices);
    assert.equal(unknown.matched, "default", "unknown model falls back to default, never zero");
    assert.equal(unknown.rate.input, 99.0);
  });
});

test("COORD-026: estimateCostUsd computes USD = in/1M*inRate + out/1M*outRate", () => {
  withCostLedgerEnv("cost-est-", COST_BOARD, () => {
    const prices = __testing.readModelPrices();
    const est = __testing.estimateCostUsd("standard", 1_000_000, 500_000, prices);
    // 1M*$3/1M + 0.5M*$15/1M = 3 + 7.5
    assert.equal(est.usd, 10.5);
    assert.equal(est.priced_by, "standard");
  });
});

test("COORD-026: record-cost happy path appends a cost.observed event with attribution", () => {
  withCostLedgerEnv("cost-record-", COST_BOARD, ({ eventLogPath }) => {
    const result = executeCommand([
      "record-cost", "C-001",
      "--agent", "concord1",
      "--model", "standard",
      "--input-tokens", "200000",
      "--output-tokens", "100000",
      "--phase", "implement",
    ]);
    assert.equal(result.ok, true, result.error || result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.event_type, "cost.observed");
    assert.equal(payload.ticket, "C-001");
    assert.equal(payload.agent, "concord1");
    assert.equal(payload.usd_estimated, true);
    // 0.2M*$3 + 0.1M*$15 = 0.6 + 1.5
    assert.equal(payload.usd, 2.1);

    const journal = fs.readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const costEvent = journal.find((e) => e.details && e.details.event_type === "cost.observed");
    assert.ok(costEvent, "cost.observed event must be present in the journal");
    assert.equal(costEvent.command, "record-cost");
    assert.equal(costEvent.details.cost.input_tokens, 200000);
  });
});

test("COORD-026: record-cost honors explicit --usd and validates numeric fields", () => {
  withCostLedgerEnv("cost-usd-", COST_BOARD, () => {
    const explicit = executeCommand([
      "record-cost", "C-001", "--agent", "a", "--model", "small",
      "--input-tokens", "10", "--output-tokens", "20", "--usd", "0.5",
    ]);
    assert.equal(explicit.ok, true, explicit.error);
    const payload = JSON.parse(explicit.stdout);
    assert.equal(payload.usd, 0.5);
    assert.equal(payload.usd_estimated, false);

    const badTokens = executeCommand([
      "record-cost", "C-001", "--model", "small",
      "--input-tokens", "-5", "--output-tokens", "20",
    ]);
    assert.equal(badTokens.ok, false);
    assert.match(badTokens.error, /non-negative integer/);

    const badUsd = executeCommand([
      "record-cost", "C-001", "--model", "small",
      "--input-tokens", "5", "--output-tokens", "20", "--usd", "-1",
    ]);
    assert.equal(badUsd.ok, false);
    assert.match(badUsd.error, /--usd must be a non-negative number/);

    const noModel = executeCommand([
      "record-cost", "C-001", "--input-tokens", "5", "--output-tokens", "20",
    ]);
    assert.equal(noModel.ok, false);
    assert.match(noModel.error, /requires --model/);
  });
});

test("COORD-026: cost report aggregates by ticket/agent/model over a seeded ledger", () => {
  withCostLedgerEnv("cost-report-", COST_BOARD, () => {
    executeCommand(["record-cost", "C-001", "--agent", "alice", "--model", "standard", "--input-tokens", "1000000", "--output-tokens", "0"]);
    executeCommand(["record-cost", "C-001", "--agent", "bob", "--model", "small", "--input-tokens", "1000000", "--output-tokens", "0"]);
    executeCommand(["record-cost", "C-002", "--agent", "alice", "--model", "standard", "--input-tokens", "1000000", "--output-tokens", "0"]);

    const byTicket = JSON.parse(executeCommand(["cost", "--by", "ticket", "--json"]).stdout);
    assert.equal(byTicket.totals.observations, 3);
    assert.equal(byTicket.totals.usd, 3.0 + 0.25 + 3.0);
    const c001 = byTicket.breakdown.find((b) => b.key === "C-001");
    assert.equal(c001.observations, 2);
    assert.equal(c001.usd, 3.25);

    const byAgent = JSON.parse(executeCommand(["cost", "--by", "agent", "--json"]).stdout);
    const alice = byAgent.breakdown.find((b) => b.key === "alice");
    assert.equal(alice.observations, 2);
    assert.equal(alice.usd, 6.0);

    const byModel = JSON.parse(executeCommand(["cost", "--by", "model", "--json"]).stdout);
    const standard = byModel.breakdown.find((b) => b.key === "standard");
    assert.equal(standard.observations, 2);

    const filtered = JSON.parse(executeCommand(["cost", "--ticket", "C-002", "--json"]).stdout);
    assert.equal(filtered.totals.observations, 1);
  });
});

test("COORD-026: cost report is hash-stable for identical ledgers and zeros on an empty ledger", () => {
  // Empty ledger -> zeros, not an error.
  withCostLedgerEnv("cost-empty-", COST_BOARD, () => {
    const empty = executeCommand(["cost", "--json"]);
    assert.equal(empty.ok, true);
    const payload = JSON.parse(empty.stdout);
    assert.equal(payload.totals.observations, 0);
    assert.equal(payload.totals.usd, 0);
    assert.deepEqual(payload.breakdown, []);
  });

  // Two independent ledgers seeded with identical observations produce
  // byte-identical --json output (deterministic ordering, no timestamps).
  const seed = (env) => {
    executeCommand(["record-cost", "C-002", "--agent", "bob", "--model", "small", "--input-tokens", "10", "--output-tokens", "10"]);
    executeCommand(["record-cost", "C-001", "--agent", "alice", "--model", "standard", "--input-tokens", "10", "--output-tokens", "10"]);
    return executeCommand(["cost", "--by", "ticket", "--json"]).stdout;
  };
  const a = withCostLedgerEnv("cost-stableA-", COST_BOARD, seed);
  const b = withCostLedgerEnv("cost-stableB-", COST_BOARD, seed);
  assert.equal(a, b, "identical ledgers must produce byte-identical --json packs");
});

test("COORD-026: the donor coord/product/model-prices.json is a valid data-driven price table", () => {
  const table = JSON.parse(fs.readFileSync("coord/product/model-prices.json", "utf8"));
  assert.ok(table.models && typeof table.models === "object", "must declare a models map");
  assert.ok(table.default && Number.isFinite(table.default.input) && Number.isFinite(table.default.output),
    "must declare a numeric default/unknown-model fallback");
});

// ---------------------------------------------------------------------------
// COORD-027: gov precheck (TOKEN_ECONOMICS.md lever #2).
// ---------------------------------------------------------------------------

test("COORD-027: classifyPrecheckVerdict maps probe pass counts to verdicts", () => {
  assert.equal(__testing.classifyPrecheckVerdict([]), "unknown", "no probes -> unknown (never a false satisfied)");
  assert.equal(__testing.classifyPrecheckVerdict([{ passed: true }, { passed: true }]), "already-satisfied");
  assert.equal(__testing.classifyPrecheckVerdict([{ passed: true }, { passed: false }]), "partial");
  assert.equal(__testing.classifyPrecheckVerdict([{ passed: false }, { passed: false }]), "not-started");
});

test("COORD-027: runPrecheckProbe handles grep/file-exists/test and never throws", () => {
  // grep present against a real repo file.
  const grepHit = __testing.runPrecheckProbe({ type: "grep", pattern: "function precheck", path: "coord/scripts/governance.js", expect: "present" });
  assert.equal(grepHit.passed, true);
  const grepMiss = __testing.runPrecheckProbe({ type: "grep", pattern: "this-string-does-not-exist-anywhere-xyzzy", path: "coord/scripts/governance.js", expect: "present" });
  assert.equal(grepMiss.passed, false);
  // file-exists, both polarities.
  assert.equal(__testing.runPrecheckProbe({ type: "file-exists", path: "coord/scripts/governance.js", expect: "present" }).passed, true);
  assert.equal(__testing.runPrecheckProbe({ type: "file-exists", path: "coord/scripts/does-not-exist.js", expect: "absent" }).passed, true);
  // test probe: a trivially-passing shell command.
  assert.equal(__testing.runPrecheckProbe({ type: "test", command: "true" }).passed, true);
  assert.equal(__testing.runPrecheckProbe({ type: "test", command: "false" }).passed, false);
  assert.equal(__testing.runPrecheckProbe({ type: "test", command: "false", expect: "fail" }).passed, true);
  // malformed probes are reported, not thrown.
  const bad = __testing.runPrecheckProbe({ type: "grep" });
  assert.equal(bad.passed, false);
  assert.equal(bad.error, "schema");
  const unknownType = __testing.runPrecheckProbe({ type: "nonsense" });
  assert.equal(unknownType.passed, false);
});

function withTicketPrecheckSidecar(ticketId, board, probesJson, fn) {
  // COORD-290: precheck resolves probes from state.PROMPTS_DIR/tickets and the
  // board; provision a sandbox prompts dir + temp board so nothing touches the
  // live coord/prompts/tickets tree, then restore.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const sidecarPath = path.join(ticketsDir, `${ticketId}.precheck.json`);
  fs.writeFileSync(sidecarPath, probesJson, "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH,
    PROMPTS_DIR: __testing.paths.PROMPTS_DIR,
    RUNTIME_DIR: __testing.paths.RUNTIME_DIR,
    GOVERNANCE_EVENT_LOG_PATH: __testing.paths.GOVERNANCE_EVENT_LOG_PATH,
    GOVERNANCE_SNAPSHOT_PATH: __testing.paths.GOVERNANCE_SNAPSHOT_PATH,
    GOVERNANCE_SNAPSHOTS_DIR: __testing.paths.GOVERNANCE_SNAPSHOTS_DIR,
    GOVERNANCE_EVENT_LOCK_DIR: __testing.paths.GOVERNANCE_EVENT_LOCK_DIR,
  };
  const runtimeDir = path.join(tempBoard, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  __testing.paths.RUNTIME_DIR = runtimeDir;
  __testing.paths.GOVERNANCE_EVENT_LOG_PATH = path.join(runtimeDir, "governance-events.ndjson");
  __testing.paths.GOVERNANCE_SNAPSHOT_PATH = path.join(runtimeDir, "governance-latest-snapshot.json");
  __testing.paths.GOVERNANCE_SNAPSHOTS_DIR = path.join(runtimeDir, "governance-snapshots");
  __testing.paths.GOVERNANCE_EVENT_LOCK_DIR = path.join(runtimeDir, "governance.lock");
  const priorExitCode = process.exitCode;
  try {
    return fn();
  } finally {
    process.exitCode = priorExitCode;
    for (const key of Object.keys(original)) {
      __testing.paths[key] = original[key];
    }
  }
}

const PRECHECK_BOARD = {
  metadata: { title: "Precheck Test Board" },
  sections: [{ rows: [{ ID: "PRE-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "precheck probe target" }] }],
};

test("COORD-027: precheck verdict already-satisfied (exit 0) when all probes pass", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "grep", pattern: "function precheck", path: "coord/scripts/governance.js", expect: "present" },
      { type: "file-exists", path: "coord/scripts/governance.js", expect: "present" },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const result = executeCommand(["precheck", "PRE-001", "--json"]);
    assert.equal(result.ok, true, result.error);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "already-satisfied");
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.probes.length, 2);
  });
});

test("COORD-027: precheck verdict partial when some probes fail", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "grep", pattern: "function precheck", path: "coord/scripts/governance.js", expect: "present" },
      { type: "file-exists", path: "coord/scripts/this-does-not-exist.js", expect: "present" },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const payload = executeCommand(["precheck", "PRE-001", "--json"]).value;
    assert.equal(payload.verdict, "partial");
    assert.equal(payload.exit_code, 10);
  });
});

test("COORD-027: precheck verdict not-started when no probes pass", () => {
  const probes = JSON.stringify({
    probes: [{ type: "file-exists", path: "coord/scripts/this-does-not-exist.js", expect: "present" }],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const payload = executeCommand(["precheck", "PRE-001", "--json"]).value;
    assert.equal(payload.verdict, "not-started");
    assert.equal(payload.exit_code, 20);
  });
});

test("COORD-027: a failing/timing-out test probe is reported, not fatal", () => {
  const probes = JSON.stringify({
    probes: [
      { type: "test", command: "exit 7" },
      { type: "test", command: "sleep 5", timeout_ms: 50 },
    ],
  });
  withTicketPrecheckSidecar("PRE-001", PRECHECK_BOARD, probes, () => {
    const result = executeCommand(["precheck", "PRE-001", "--json"]);
    assert.equal(result.ok, true, "probe failures must never throw");
    const payload = result.value;
    assert.equal(payload.verdict, "not-started");
    const timed = payload.probes.find((p) => p.error === "timeout");
    assert.ok(timed, "the timed-out probe must be reported with an error, not thrown");
  });
});

test("COORD-027: no probes declared -> unknown (exit 30), never a false satisfied", () => {
  // Board ticket exists but there is no sidecar and no precheck block.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "precheck-none-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "B" },
    sections: [{ rows: [{ ID: "ARCH-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "no probes" }] }],
  }, null, 2), "utf8");
  const originalBoard = __testing.paths.BOARD_PATH;
  const priorExit = process.exitCode;
  __testing.paths.BOARD_PATH = boardPath;
  try {
    // ARCH-001 has a real prompt on disk but (almost certainly) no precheck block.
    const payload = executeCommand(["precheck", "ARCH-001", "--json"]).value;
    assert.equal(payload.verdict, "unknown");
    assert.equal(payload.exit_code, 30);
    assert.equal(payload.probes.length, 0);
  } finally {
    process.exitCode = priorExit;
    __testing.paths.BOARD_PATH = originalBoard;
  }
});

// ---------------------------------------------------------------------------
// COORD-028: gov context-pack (TOKEN_ECONOMICS.md lever #3).
// ---------------------------------------------------------------------------

test("COORD-028: parseTicketPromptSections mines files, acceptance criteria, and spec sections", () => {
  // Self-contained: provision a COORD-028 prompt declaring coord/scripts/governance.js,
  // 5 AC bullets, and a TOKEN_ECONOMICS.md / lever #3 spec reference, then mine it.
  const fixture = [
    "# COORD-028: context-pack",
    "",
    "- Priority: P2 · Spec of record: `coord/product/TOKEN_ECONOMICS.md` (lever #3)",
    "",
    "## Acceptance Criteria",
    "",
    "- AC one.",
    "- AC two.",
    "- AC three.",
    "- AC four.",
    "- AC five.",
    "",
    "## Likely Files",
    "- `coord/scripts/governance.js` (new verb)",
    "- governance test file",
    "",
  ].join("\n");
  withCanonicalTicketPrompt("COORD-028", fixture, () => {
    const parsed = __testing.parseTicketPromptSections("COORD-028");
    assert.ok(parsed.files.includes("coord/scripts/governance.js"), "declared file must be mined");
    assert.ok(parsed.acceptance_criteria.length >= 4, "AC bullets must be mined");
    assert.ok(parsed.spec_sections.includes("TOKEN_ECONOMICS.md"), "linked spec must be mined");
    assert.ok(parsed.spec_sections.some((s) => /lever #3/.test(s)), "lever marker must be mined");
  });
});

test("COORD-028: parseTicketPromptSections degrades to empty arrays for an unknown ticket", () => {
  const parsed = __testing.parseTicketPromptSections("NOPE-99999");
  assert.deepEqual(parsed.files, []);
  assert.deepEqual(parsed.acceptance_criteria, []);
});

test("COORD-028: ticketFilesIntersect matches proof paths against ticket files", () => {
  assert.equal(__testing.ticketFilesIntersect(["coord/scripts/governance.js"], "coord/scripts/governance.js"), true);
  assert.equal(__testing.ticketFilesIntersect(["coord/scripts/governance.js"], "coord/scripts/other.js"), false);
});

function withContextPackPlanRecords(prefix, fn) {
  // Provision a temp PLAN_RECORDS_DIR with seeded landed plan records.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const original = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_RECORDS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    __testing.paths.PLAN_RECORDS_DIR = original;
  }
}

function withTempTicketPrompt(ticketId, promptText, fn) {
  // COORD-290: write the prompt into a sandbox PROMPTS_DIR (production resolves
  // prompts via state.PROMPTS_DIR) instead of the live coord/prompts tree.
  const tempPrompts = fs.mkdtempSync(path.join(os.tmpdir(), "temp-prompt-"));
  const ticketsDir = path.join(tempPrompts, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), promptText, "utf8");
  const originalPromptsDir = __testing.paths.PROMPTS_DIR;
  __testing.paths.PROMPTS_DIR = tempPrompts;
  try {
    return fn();
  } finally {
    __testing.paths.PROMPTS_DIR = originalPromptsDir;
  }
}

function withContextPackBoard(board, fn) {
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "ctxpack-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const original = __testing.paths.BOARD_PATH;
  __testing.paths.BOARD_PATH = boardPath;
  try {
    return fn();
  } finally {
    __testing.paths.BOARD_PATH = original;
  }
}

const CTXPACK_PROMPT = [
  "# CTX-001: sample",
  "",
  "## Acceptance Criteria",
  "- first criterion",
  "- second criterion",
  "",
  "## Likely Files",
  "- `coord/scripts/governance.js` (the shared file)",
  "",
  "Spec of record: `TOKEN_ECONOMICS.md` (lever #3)",
].join("\n");

const CTXPACK_BOARD = {
  metadata: { title: "Context Pack Test Board" },
  sections: [{ rows: [
    { ID: "CTX-001", Repo: "X", Status: "todo", Owner: "unassigned", Description: "ctx ticket touching governance.js" },
    { ID: "CTX-NOFILE", Repo: "X", Status: "todo", Owner: "unassigned", Description: "ticket with no declared files" },
  ] }],
};

test("COORD-028: context-pack includes prior feature-proofs+invariants intersecting the ticket files", () => {
  withContextPackPlanRecords("ctxpack-plans-", (dir) => {
    // A landed record whose feature-proof touches coord/scripts/governance.js.
    fs.writeFileSync(path.join(dir, "PRIOR-001.json"), JSON.stringify({
      schema_version: 1,
      ticket_id: "PRIOR-001",
      feature_proof: ["symbol:coord/scripts/governance.js#someFn", "path:coord/other/file.js"],
      critical_invariants: ["the shared file invariant must hold"],
    }), "utf8");
    // A landed record that does NOT touch the ticket files.
    fs.writeFileSync(path.join(dir, "PRIOR-002.json"), JSON.stringify({
      schema_version: 1,
      ticket_id: "PRIOR-002",
      feature_proof: ["path:frontend/app.tsx"],
      critical_invariants: ["unrelated invariant"],
    }), "utf8");

    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const pack = executeCommand(["context-pack", "CTX-001", "--json"]).value;
        assert.deepEqual(pack.ticket_specific.files, ["coord/scripts/governance.js"]);
        assert.equal(pack.ticket_specific.acceptance_criteria.length, 2);
        const proofTickets = pack.ticket_specific.prior_feature_proofs.map((p) => p.ticket);
        assert.ok(proofTickets.includes("PRIOR-001"), "intersecting proof must be included");
        assert.ok(!proofTickets.includes("PRIOR-002"), "non-intersecting proof must be excluded");
        assert.ok(pack.ticket_specific.prior_invariants.some((i) => i.ticket === "PRIOR-001"));
        assert.ok(!pack.ticket_specific.prior_invariants.some((i) => i.ticket === "PRIOR-002"));
      });
    });
  });
});

test("COORD-028: the stable/ticket split is present and the STABLE block is identical across tickets", () => {
  withContextPackPlanRecords("ctxpack-split-", () => {
    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const a = executeCommand(["context-pack", "CTX-001", "--json"]).value;
        const b = executeCommand(["context-pack", "CTX-NOFILE", "--json"]).value;
        assert.ok(a.stable && a.ticket_specific, "pack must split STABLE and TICKET-SPECIFIC");
        assert.deepEqual(a.stable, b.stable, "the STABLE block must be identical across tickets (cacheable prefix)");
        assert.notEqual(a.ticket_specific.ticket, b.ticket_specific.ticket);
      });
    });
  });
});

test("COORD-028: a no-prior-proof / no-files ticket still emits a valid pack (graceful degradation)", () => {
  withContextPackPlanRecords("ctxpack-empty-", () => {
    withContextPackBoard(CTXPACK_BOARD, () => {
      // CTX-NOFILE has no prompt on disk -> no files, no AC, no prior proofs.
      const result = executeCommand(["context-pack", "CTX-NOFILE", "--json"]);
      assert.equal(result.ok, true, result.error);
      const pack = result.value;
      assert.deepEqual(pack.ticket_specific.files, []);
      assert.deepEqual(pack.ticket_specific.prior_feature_proofs, []);
      assert.deepEqual(pack.ticket_specific.prior_invariants, []);
      assert.ok(pack.stable.shared_references.length > 0, "stable references still present");
    });
  });
});

test("COORD-028: context-pack --json is hash-stable for identical inputs", () => {
  withContextPackPlanRecords("ctxpack-stable-", (dir) => {
    fs.writeFileSync(path.join(dir, "PRIOR-001.json"), JSON.stringify({
      schema_version: 1, ticket_id: "PRIOR-001",
      feature_proof: ["symbol:coord/scripts/governance.js#fn"], critical_invariants: ["inv"],
    }), "utf8");
    withContextPackBoard(CTXPACK_BOARD, () => {
      withTempTicketPrompt("CTX-001", CTXPACK_PROMPT, () => {
        const a = executeCommand(["context-pack", "CTX-001", "--json"]).stdout;
        const b = executeCommand(["context-pack", "CTX-001", "--json"]).stdout;
        assert.equal(a, b, "identical inputs must produce byte-identical packs");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// COORD-029: tier policy (TOKEN_ECONOMICS.md lever #4).
// ---------------------------------------------------------------------------

test("COORD-029: resolveTicketTier honors explicit Tier, derives from Pri, else defaults to standard", () => {
  const policy = __testing.readTierPolicy();
  assert.equal(__testing.resolveTicketTier({ Tier: "critical", Pri: "P3" }, policy).tier, "critical", "explicit Tier wins");
  assert.equal(__testing.resolveTicketTier({ Tier: "critical", Pri: "P3" }, policy).source, "explicit");
  assert.equal(__testing.resolveTicketTier({ Pri: "P3", Repo: "X" }, policy).tier, "mechanical", "P3 derives to mechanical");
  assert.equal(__testing.resolveTicketTier({ Pri: "P0" }, policy).tier, "critical", "P0 derives to critical");
  assert.equal(__testing.resolveTicketTier({ Pri: "P2" }, policy).tier, "standard");
  assert.equal(__testing.resolveTicketTier({}, policy).tier, "standard", "absent everything -> standard (safe default)");
});

test("COORD-029: standard and critical tiers keep TODAY's flat minimums byte-identical", () => {
  const productRow = { Repo: "B" };
  // Flat product minimum is 4 review cycles, 1 feature-proof, 2 invariants.
  assert.equal(__testing.effectiveTierMinimum("standard", "min_review_cycles", 4, productRow), 4, "standard never relaxes review cycles");
  assert.equal(__testing.effectiveTierMinimum("critical", "min_review_cycles", 4, productRow), 4, "critical never weakened");
  assert.equal(__testing.effectiveTierMinimum("standard", "min_feature_proofs", 1, productRow), 1);
  assert.equal(__testing.effectiveTierMinimum("critical", "min_critical_invariants", 2, productRow), 2);
});

test("COORD-029: mechanical tier relaxes BELOW the flat minimum (but never raises or goes negative)", () => {
  const productRow = { Repo: "B" };
  // mechanical policy: min_review_cycles=2, min_feature_proofs=0, min_critical_invariants=1.
  assert.equal(__testing.effectiveTierMinimum("mechanical", "min_review_cycles", 4, productRow), 2, "mechanical relaxes 4 -> 2");
  assert.equal(__testing.effectiveTierMinimum("mechanical", "min_feature_proofs", 1, productRow), 0);
  assert.equal(__testing.effectiveTierMinimum("mechanical", "min_critical_invariants", 2, productRow), 1);
  // Relax-only: if the flat value were already below the policy value, the flat wins (never raised).
  assert.equal(__testing.effectiveTierMinimum("mechanical", "min_review_cycles", 1, productRow), 1, "never raises above flat");
});

test("COORD-029: a policy that tries to weaken critical is ignored (critical pinned to flat)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-policy-"));
  const policyPath = path.join(dir, "tier-policy.json");
  // Adversarial: declare critical with a tiny minimum.
  fs.writeFileSync(policyPath, JSON.stringify({
    default_tier: "standard",
    derivation: { by_pri: { P0: "critical" } },
    tiers: {
      standard: { model_class: "standard", min_review_cycles: "today" },
      critical: { model_class: "frontier", min_review_cycles: 1, min_feature_proofs: 0, min_critical_invariants: 0 },
    },
  }), "utf8");
  const original = __testing.paths.TIER_POLICY_PATH_OVERRIDE;
  __testing.paths.TIER_POLICY_PATH_OVERRIDE = policyPath;
  try {
    const productRow = { Repo: "B" };
    // Even with an adversarial policy, critical stays at the flat value.
    assert.equal(__testing.effectiveTierMinimum("critical", "min_review_cycles", 4, productRow), 4);
    assert.equal(__testing.effectiveTierMinimum("critical", "min_critical_invariants", 2, productRow), 2);
  } finally {
    __testing.paths.TIER_POLICY_PATH_OVERRIDE = original;
  }
});

test("COORD-029: gov tier reports resolved tier, suggested model, and required evidence depth", () => {
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "tier-board-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    metadata: { title: "Tier Test Board" },
    sections: [{ rows: [
      { ID: "MECH-001", Repo: "X", Pri: "P3", Status: "todo", Owner: "unassigned", Description: "mechanical" },
      { ID: "CRIT-001", Repo: "B", Pri: "P0", Status: "todo", Owner: "unassigned", Description: "critical" },
    ] }],
  }, null, 2), "utf8");
  const originalBoard = __testing.paths.BOARD_PATH;
  __testing.paths.BOARD_PATH = boardPath;
  try {
    const mech = executeCommand(["tier", "MECH-001"]).value;
    assert.equal(mech.tier, "mechanical");
    assert.equal(mech.suggested_model_class, "small");
    assert.equal(mech.required_evidence_depth.review_cycles, 2, "mechanical repo-X relaxes 3 -> 2");

    const crit = executeCommand(["tier", "CRIT-001"]).value;
    assert.equal(crit.tier, "critical");
    assert.equal(crit.suggested_model_class, "frontier");
    assert.equal(crit.required_evidence_depth.review_cycles, 4, "critical keeps the full product minimum");
    assert.equal(crit.required_evidence_depth.critical_invariants, 2);
  } finally {
    __testing.paths.BOARD_PATH = originalBoard;
  }
});

test("COORD-029: doctor enforces the relaxed minimum for a mechanical product ticket and full rigor for critical", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-doctor-"));
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  const boardPath = path.join(tempDir, "tasks.json");
  const planPath = path.join(tempDir, "PLAN.md");
  fs.writeFileSync(planPath, "", "utf8");
  fs.writeFileSync(boardPath, JSON.stringify({ version: 1, sections: [], review_findings: {}, pr_index: {}, landing_index: {} }, null, 2), "utf8");

  // A plan record with EXACTLY 2 structured passing review cycles, 1 invariant,
  // 0 feature-proofs, full requirement closure + a real repo gate.
  const lensCycles = [
    "lens=contract/state invariants; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
    "lens=auth/security/failure modes; diff=d; risks=a, b; findings=none; verification=npm test; verdict=pass",
  ];
  const seedRecord = (ticketId) => fs.writeFileSync(path.join(recordsDir, `${ticketId}.json`), JSON.stringify({
    schema_version: 1, ticket_id: ticketId, markdown_heading: `## ${ticketId}`,
    startup_checklist: ["completed"], traceability_gate: ["verified"], review_round: 1,
    baseline_reproduction: ["Command: npm test", "Outcome: reproduced"], prior_findings: [],
    intended_files: ["services/x.js"], change_summary: ["mechanical change"],
    verification_commands: ["npm test"],
    critical_invariants: ["the one mechanical invariant"],
    requirement_closure: ["Ticket ask: x", "Implemented: x", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["npm test"],
    self_review_cycles: lensCycles.map((raw, i) => ({ cycle: i + 1, total: lensCycles.length, raw, lens: raw.match(/lens=([^;]+)/)[1], diff: "d", risks: ["a", "b"], findings: "none", verification: "npm test", verdict: "pass" })),
    rollback_strategy: ["revert"], security_surface: "no", synced_from_markdown_at: "2026-06-10T00:00:00.000Z",
  }, null, 2), "utf8");

  const original = {
    BOARD_PATH: __testing.paths.BOARD_PATH, PLAN_PATH: __testing.paths.PLAN_PATH, PLAN_RECORDS_DIR: __testing.paths.PLAN_RECORDS_DIR,
  };
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    // Mechanical product ticket (Pri P3): relaxed minimums (2 cycles, 0 proofs,
    // 1 invariant) -> the relaxed evidence passes the cycle-count gate.
    seedRecord("MECH-001");
    const mechIssues = __testing.collectReviewPlanReadinessIssues("MECH-001", { ID: "MECH-001", Repo: "B", Type: "feature", Pri: "P3" });
    assert.ok(!mechIssues.some((i) => i.code === "self_review_cycle_count"), "mechanical: 2 cycles must satisfy the relaxed minimum");
    assert.ok(!mechIssues.some((i) => i.code === "critical_invariants"), "mechanical: 1 invariant must satisfy the relaxed minimum");
    assert.ok(!mechIssues.some((i) => i.code === "feature_proof"), "mechanical: 0 feature-proofs allowed");

    // Critical product ticket (Pri P0): full rigor — the same 2-cycle/1-invariant
    // record must FAIL (needs 4 cycles + 2 invariants), proving critical is never weakened.
    seedRecord("CRIT-002");
    const critIssues = __testing.collectReviewPlanReadinessIssues("CRIT-002", { ID: "CRIT-002", Repo: "B", Type: "feature", Pri: "P0" });
    const critCodes = critIssues.map((i) => i.code);
    assert.ok(critCodes.includes("self_review_cycle_count"), "critical: 2 cycles must FAIL the 4-cycle minimum");
    assert.ok(critCodes.includes("critical_invariants"), "critical: 1 invariant must FAIL the 2-invariant minimum");
  } finally {
    __testing.paths.BOARD_PATH = original.BOARD_PATH;
    __testing.paths.PLAN_PATH = original.PLAN_PATH;
    __testing.paths.PLAN_RECORDS_DIR = original.PLAN_RECORDS_DIR;
  }
});

test("COORD-029: the donor coord/product/tier-policy.json is a valid relax-only policy", () => {
  const policy = JSON.parse(fs.readFileSync("coord/product/tier-policy.json", "utf8"));
  assert.ok(policy.tiers.standard && policy.tiers.critical, "must define standard and critical tiers");
  // standard and critical must use the "today" sentinel (never a weakened number).
  assert.equal(policy.tiers.standard.min_review_cycles, "today");
  assert.equal(policy.tiers.critical.min_review_cycles, "today");
  // any non-standard/critical tier minimum must be a number (a relaxation).
  for (const [name, cfg] of Object.entries(policy.tiers)) {
    if (name === "standard" || name === "critical") continue;
    if (cfg.min_review_cycles !== undefined && cfg.min_review_cycles !== "today") {
      assert.ok(Number.isFinite(cfg.min_review_cycles), `${name}.min_review_cycles must be numeric`);
    }
  }
});

// ---------------------------------------------------------------------------
// COORD-030: gov plan-waves (TOKEN_ECONOMICS.md lever #5).
// ---------------------------------------------------------------------------

test("COORD-030: parseTicketDependsOn parses the Depends On column into ticket ids", () => {
  assert.deepEqual(__testing.parseTicketDependsOn({ "Depends On": "FOO-001, BAR-002" }), ["FOO-001", "BAR-002"]);
  assert.deepEqual(__testing.parseTicketDependsOn({ "Depends On": "" }), []);
  assert.deepEqual(__testing.parseTicketDependsOn({}), []);
});

function promptWithFiles(ticketId, files) {
  const lines = [`# ${ticketId}: sample`, "", "## Likely Files"];
  for (const f of files) {
    lines.push(`- \`${f}\` (a file)`);
  }
  return lines.join("\n");
}

function withPlanWavesScenario(board, promptsByTicket, fn) {
  // COORD-290: seed prompts into a sandbox PROMPTS_DIR instead of the live tree.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "planwaves-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  for (const [ticketId, files] of Object.entries(promptsByTicket)) {
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), promptWithFiles(ticketId, files), "utf8");
  }
  const originalBoard = __testing.paths.BOARD_PATH;
  const originalPromptsDir = __testing.paths.PROMPTS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  try {
    return fn();
  } finally {
    __testing.paths.BOARD_PATH = originalBoard;
    __testing.paths.PROMPTS_DIR = originalPromptsDir;
  }
}

function findWaveOf(payload, ticket) {
  const w = payload.waves.find((wv) => wv.tickets.some((t) => t.ticket === ticket));
  return w ? w.wave : null;
}

test("COORD-030: two file-disjoint product tickets land in the same wave; file-sharing tickets split", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "WAVE-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "WAVE-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "b", "Depends On": "" },
      { ID: "WAVE-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "WAVE-001": ["src/a.js"],
    "WAVE-002": ["src/b.js"],       // disjoint from WAVE-001
    "WAVE-003": ["src/a.js"],       // shares src/a.js with WAVE-001
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "WAVE-001"), 1);
    assert.equal(findWaveOf(payload, "WAVE-002"), 1, "file-disjoint ticket joins wave 1");
    assert.equal(findWaveOf(payload, "WAVE-003"), 2, "file-sharing ticket is pushed to a later wave");
  });
});

test("COORD-030: a dependsOn forces ordering across waves", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DEP-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "lead", "Depends On": "" },
      { ID: "DEP-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "follower", "Depends On": "DEP-001" },
    ] }],
  };
  const prompts = { "DEP-001": ["src/lead.js"], "DEP-002": ["src/follower.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const w1 = findWaveOf(payload, "DEP-001");
    const w2 = findWaveOf(payload, "DEP-002");
    assert.ok(w2 > w1, "the dependent must be in a later wave than its dependency");
    const follower = payload.waves[w2 - 1].tickets.find((t) => t.ticket === "DEP-002");
    assert.equal(follower.satisfied_deps["DEP-001"], `wave ${w1}`, "the prior wave that satisfied the dep is named");
  });
});

test("COORD-351: safe repo-X tickets can share waves when declared files are disjoint", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "XSAFE-001", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord script", "Depends On": "" },
      { ID: "XSAFE-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord doc", "Depends On": "" },
      { ID: "XSAFE-003", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord overlap", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "XSAFE-001": ["coord/scripts/governance.js"],
    "XSAFE-002": ["coord/docs/MULTI_AGENT_TOPOLOGIES.md"],
    "XSAFE-003": ["coord/scripts/governance.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "XSAFE-001"), 1);
    assert.equal(findWaveOf(payload, "XSAFE-002"), 1, "safe disjoint repo-X ticket joins wave 1");
    assert.equal(findWaveOf(payload, "XSAFE-003"), 2, "overlapping safe repo-X ticket moves later");
    const safe = payload.waves[0].tickets.find((t) => t.ticket === "XSAFE-001");
    assert.equal(safe.parallelizable, true);
    assert.match(safe.note, /safe declared coord code\/doc surfaces/);
  });
});

test("COORD-355: board Declared Files unlock safe repo-X plan-waves without prompt prose", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      {
        ID: "XBOARD-001",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord script",
        "Depends On": "",
        "Declared Files": "coord/scripts/token-economics.js",
      },
      {
        ID: "XBOARD-002",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord doc",
        "Depends On": "",
        "Declared Files": "- `coord/docs/MULTI_AGENT_TOPOLOGIES.md`",
      },
      {
        ID: "XBOARD-003",
        Repo: "X",
        Pri: "P2",
        Status: "todo",
        Owner: "u",
        Description: "coord overlap",
        "Depends On": "",
        declared_files: ["coord/scripts/token-economics.js"],
      },
    ] }],
  };
  withPlanWavesScenario(board, {}, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    assert.equal(findWaveOf(payload, "XBOARD-001"), 1);
    assert.equal(findWaveOf(payload, "XBOARD-002"), 1, "board-declared disjoint repo-X ticket joins wave 1");
    assert.equal(findWaveOf(payload, "XBOARD-003"), 2, "board-declared overlapping repo-X ticket moves later");
    const safe = payload.waves[0].tickets.find((t) => t.ticket === "XBOARD-001");
    assert.deepEqual(safe.files, ["coord/scripts/token-economics.js"]);
    assert.equal(safe.parallelizable, true);
  });
});

test("COORD-351: repo-X global-state and missing-file tickets still serialize", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "XSTATE-001", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "board", "Depends On": "" },
      { ID: "XSTATE-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "no files", "Depends On": "" },
      { ID: "XSTATE-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "product", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "XSTATE-001": ["coord/board/tasks.json"],
    "XSTATE-003": ["src/product.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const stateWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "XSTATE-001"));
    const noFilesWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "XSTATE-002"));
    const state = stateWave.tickets.find((t) => t.ticket === "XSTATE-001");
    const noFiles = noFilesWave.tickets.find((t) => t.ticket === "XSTATE-002");
    assert.equal(stateWave.tickets.length, 1, "global-state repo-X ticket remains alone");
    assert.equal(noFilesWave.tickets.length, 1, "missing-file repo-X ticket remains alone");
    assert.equal(state.parallelizable, false);
    assert.equal(noFiles.parallelizable, false);
    assert.match(state.note, /global coordination state/);
    assert.match(noFiles.note, /no declared files/);
  });
});

test("COORD-030: a no-files ticket is flagged and scheduled alone, never silently parallelized", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "NOFILE-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "no declared files", "Depends On": "" },
      { ID: "HASFILE-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "has files", "Depends On": "" },
    ] }],
  };
  // NOFILE-001 has no prompt -> no declared files.
  const prompts = { "HASFILE-002": ["src/h.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["plan-waves", "--json"]).value;
    const nfWave = payload.waves.find((w) => w.tickets.some((t) => t.ticket === "NOFILE-001"));
    const nfEntry = nfWave.tickets.find((t) => t.ticket === "NOFILE-001");
    assert.equal(nfEntry.parallelizable, false);
    assert.match(nfEntry.note, /potentially-conflicting/);
    assert.equal(nfWave.tickets.length, 1, "a no-files ticket must not share a wave");
  });
});

test("COORD-030: an unsatisfiable dependency is excluded, never silently dropped; output is deterministic", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "ORPH-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "orphan", "Depends On": "GHOST-999" },
      { ID: "OK-002", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "ok", "Depends On": "" },
    ] }],
  };
  const prompts = { "ORPH-001": ["src/o.js"], "OK-002": ["src/k.js"] };
  withPlanWavesScenario(board, prompts, () => {
    const a = executeCommand(["plan-waves", "--json"]).stdout;
    const b = executeCommand(["plan-waves", "--json"]).stdout;
    assert.equal(a, b, "plan-waves must be deterministic for identical inputs");
    const payload = JSON.parse(a);
    const orphan = payload.excluded.find((e) => e.ticket === "ORPH-001");
    assert.ok(orphan, "the ticket with an unsatisfiable dep must be reported as excluded");
    assert.match(orphan.reason, /unsatisfiable dep/);
    assert.equal(findWaveOf(payload, "OK-002"), 1, "the schedulable ticket is still scheduled");
  });
});

test("COORD-357: sequencer-plan groups overlapping active tickets and omits disjoint tickets", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SEQ-001", Repo: "B", Pri: "P1", Status: "review", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "SEQ-002", Repo: "B", Pri: "P2", Status: "doing", Owner: "u", Description: "b", "Depends On": "" },
      { ID: "SEQ-003", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "SEQ-001": ["src/shared.js"],
    "SEQ-002": ["src/shared.js"],
    "SEQ-003": ["src/other.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 1);
    assert.equal(payload.groups[0].gate_mode, "slice");
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["SEQ-001", "SEQ-002"]);
    assert.ok(!JSON.stringify(payload).includes("SEQ-003"), "disjoint active ticket stays outside sequencer");
  });
});

test("COORD-357: sequencer-plan full-fallbacks missing and repo-X global-state surfaces", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SEQ-MISS", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "missing", "Depends On": "" },
      { ID: "SEQ-XSTATE", Repo: "X", Pri: "P2", Status: "review", Owner: "u", Description: "board", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "SEQ-XSTATE": ["coord/board/tasks.json"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 2);
    const missing = payload.groups.find((group) => group.tickets.some((ticket) => ticket.ticket === "SEQ-MISS"));
    const globalState = payload.groups.find((group) => group.tickets.some((ticket) => ticket.ticket === "SEQ-XSTATE"));
    assert.equal(missing.gate_mode, "full");
    assert.equal(globalState.gate_mode, "full");
    assert.match(missing.tickets[0].reasons[0].code, /missing_declared_files/);
    assert.match(globalState.tickets[0].reasons[0].code, /repo_x_sequential_surface/);
  });
});

test("COORD-357: sequencer-plan uses active dependency edges for deterministic order", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "SDEP-001", Repo: "B", Pri: "P2", Status: "review", Owner: "u", Description: "dep", "Depends On": "" },
      { ID: "SDEP-002", Repo: "B", Pri: "P1", Status: "review", Owner: "u", Description: "child", "Depends On": "SDEP-001" },
    ] }],
  };
  const prompts = {
    "SDEP-001": ["src/a.js"],
    "SDEP-002": ["src/b.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["sequencer-plan", "--json"]).value;
    assert.equal(payload.group_count, 1);
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["SDEP-001", "SDEP-002"]);
    assert.equal(payload.groups[0].gate_mode, "slice");
    assert.ok(payload.groups[0].tickets[1].reasons.some((reason) => reason.code === "dependency_edge"));
  });
});

test("COORD-388: merge-queue materializes sequencer groups with deterministic order and depth", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQ-001", Repo: "B", Pri: "P1", Status: "review", Owner: "alice", Description: "a", "Depends On": "" },
      { ID: "MQ-002", Repo: "B", Pri: "P2", Status: "review", Owner: "bob", Description: "b", "Depends On": "" },
      { ID: "MQ-003", Repo: "B", Pri: "P2", Status: "review", Owner: "cara", Description: "c", "Depends On": "" },
    ] }],
  };
  const prompts = {
    "MQ-001": ["src/shared.js"],
    "MQ-002": ["src/shared.js"],
    "MQ-003": ["src/other.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(payload.mode, "contention_queue");
    assert.equal(payload.depth, 2);
    assert.equal(payload.group_count, 1);
    assert.equal(payload.groups[0].state, "queued");
    assert.deepEqual(payload.groups[0].tickets.map((ticket) => ticket.ticket), ["MQ-001", "MQ-002"]);
    assert.ok(!JSON.stringify(payload).includes("MQ-003"), "disjoint ticket stays on the normal land path");
  });
});

test("COORD-388: merge-queue records inspectable runtime state only with --record", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQREC-001", Repo: "X", Pri: "P2", Status: "review", Owner: "alice", Description: "state", "Depends On": "" },
    ] }],
  };
  const prompts = { "MQREC-001": ["coord/board/tasks.json"] };
  const statePath = path.join(__testing.paths.RUNTIME_DIR, "merge-queue.json");
  try { fs.rmSync(statePath, { force: true }); } catch { /* best effort */ }
  withPlanWavesScenario(board, prompts, () => {
    const dry = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(dry.depth, 1);
    assert.equal(fs.existsSync(statePath), false, "read-only inspect must not write queue state");
    const recorded = executeCommand(["merge-queue", "--record", "--json"]).value;
    assert.equal(recorded.depth, 1);
    assert.equal(fs.existsSync(statePath), true, "--record writes queue state");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.groups[0].tickets[0].ticket, "MQREC-001");
  });
});

test("COORD-388: merge-queue blocks ambiguous dependency cycles instead of picking an order", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "MQCYC-001", Repo: "B", Pri: "P1", Status: "review", Owner: "alice", Description: "a", "Depends On": "MQCYC-002" },
      { ID: "MQCYC-002", Repo: "B", Pri: "P1", Status: "review", Owner: "bob", Description: "b", "Depends On": "MQCYC-001" },
    ] }],
  };
  const prompts = {
    "MQCYC-001": ["src/a.js"],
    "MQCYC-002": ["src/b.js"],
  };
  withPlanWavesScenario(board, prompts, () => {
    const payload = executeCommand(["merge-queue", "--json"]).value;
    assert.equal(payload.blocked_group_count, 1);
    assert.equal(payload.groups[0].state, "blocked");
    assert.equal(payload.groups[0].ambiguous_ordering, true);
    assert.equal(payload.groups[0].ambiguities[0].code, "ambiguous_dependency_cycle");
  });
});

// ---------------------------------------------------------------------------
// COORD-031: gov dispatch-plan (TOKEN_ECONOMICS.md — wires levers #2/#3/#4/#5).
// ---------------------------------------------------------------------------

function withDispatchPlanScenario(board, prompts, probesByTicket, fn) {
  // prompts: { ID: [files] }; probesByTicket: { ID: [probe,...] }.
  // COORD-290: seed prompts + precheck sidecars into a sandbox PROMPTS_DIR.
  const tempBoard = fs.mkdtempSync(path.join(os.tmpdir(), "dispatchplan-"));
  const boardPath = path.join(tempBoard, "tasks.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf8");
  const promptsDir = path.join(tempBoard, "prompts");
  const ticketsDir = path.join(promptsDir, "tickets");
  fs.mkdirSync(ticketsDir, { recursive: true });
  for (const [ticketId, files] of Object.entries(prompts || {})) {
    const lines = [`# ${ticketId}: sample`, "", "## Likely Files"];
    for (const f of files) {
      lines.push(`- \`${f}\` (a file)`);
    }
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.md`), lines.join("\n"), "utf8");
  }
  for (const [ticketId, probes] of Object.entries(probesByTicket || {})) {
    fs.writeFileSync(path.join(ticketsDir, `${ticketId}.precheck.json`), JSON.stringify({ probes }, null, 2), "utf8");
  }
  const originalBoard = __testing.paths.BOARD_PATH;
  const originalPromptsDir = __testing.paths.PROMPTS_DIR;
  __testing.paths.BOARD_PATH = boardPath;
  __testing.paths.PROMPTS_DIR = promptsDir;
  try {
    return fn();
  } finally {
    __testing.paths.BOARD_PATH = originalBoard;
    __testing.paths.PROMPTS_DIR = originalPromptsDir;
  }
}

function dispatchFindTicket(payload, ticket) {
  for (const w of payload.waves) {
    const t = w.tickets.find((x) => x.ticket === ticket);
    if (t) {
      return { wave: w.wave, entry: t };
    }
  }
  return null;
}

test("COORD-031: dispatch-plan composes waves + per-ticket precheck->action + tier + context-pack; satisfied=skip, unsatisfied=spawn", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DP-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "satisfied", "Depends On": "" },
      { ID: "DP-002", Repo: "B", Pri: "P0", Status: "todo", Owner: "u", Description: "unsatisfied critical", "Depends On": "" },
    ] }],
  };
  const prompts = { "DP-001": ["src/dp1.js"], "DP-002": ["src/dp2.js"] };
  // DP-001 has a probe that PASSES (this very test file exists) -> already-satisfied -> skip.
  // DP-002 has a probe that FAILS (missing file) -> not-started -> spawn.
  const probes = {
    "DP-001": [{ type: "file-exists", path: "coord/scripts/governance.test.js", expect: "present" }],
    "DP-002": [{ type: "file-exists", path: "coord/scripts/does-not-exist-zzz.js", expect: "present" }],
  };
  withDispatchPlanScenario(board, prompts, probes, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const dp1 = dispatchFindTicket(payload, "DP-001");
    const dp2 = dispatchFindTicket(payload, "DP-002");
    assert.ok(dp1 && dp2, "both tickets scheduled");

    // SKIP entry: action + reason + governed finalize-already-satisfied command.
    assert.equal(dp1.entry.action, "skip");
    assert.equal(dp1.entry.precheck.verdict, "already-satisfied");
    assert.match(dp1.entry.finalize_command, /gov finalize DP-001 --no-pr --already-landed/);

    // SPAWN entry: action + tier-routed model class + context-pack present.
    assert.equal(dp2.entry.action, "spawn");
    assert.equal(dp2.entry.precheck.verdict, "not-started");
    assert.equal(dp2.entry.tier, "critical", "P0 derives the critical tier");
    assert.equal(dp2.entry.suggested_model_class, "frontier");
    assert.ok(dp2.entry.context_pack && dp2.entry.context_pack.stable && dp2.entry.context_pack.ticket_specific,
      "spawn entry carries the context-pack with the stable/ticket-specific split");
    assert.ok(Array.isArray(dp2.entry.context_pack.stable.shared_references) && dp2.entry.context_pack.stable.shared_references.length > 0);

    // Manifest carries the stable cache-prefix marker.
    assert.equal(payload.cache_prefix.id, "coord-dispatch-stable-v1");
    assert.ok(payload.cache_prefix.shared_references.length > 0);
  });
});

test("COORD-031: unknown verdict (no probes / unparseable) NEVER yields a false skip — always spawn", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPU-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "no probes", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPU-001": ["src/u.js"] }, {}, () => {
    const payload = executeCommand(["dispatch-plan", "--json"]).value;
    const e = dispatchFindTicket(payload, "DPU-001").entry;
    assert.equal(e.precheck.verdict, "unknown");
    assert.equal(e.action, "spawn", "unknown verdict must spawn, never skip");
    assert.match(e.reason, /never a false skip/);
    assert.ok(!("finalize_command" in e), "a spawn entry must NOT carry a finalize-already-satisfied command");
  });
});

test("COORD-031: dispatch-plan is deterministic + hash-stable across two runs (no timestamps/random)", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPH-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "a", "Depends On": "" },
      { ID: "DPH-002", Repo: "X", Pri: "P2", Status: "todo", Owner: "u", Description: "coord", "Depends On": "" },
      { ID: "DPH-003", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "dep", "Depends On": "DPH-001" },
    ] }],
  };
  const prompts = { "DPH-001": ["src/a.js"], "DPH-002": ["coord/scripts/governance.js"], "DPH-003": ["src/c.js"] };
  withDispatchPlanScenario(board, prompts, {}, () => {
    const a = executeCommand(["dispatch-plan", "--json"]).stdout;
    const b = executeCommand(["dispatch-plan", "--json"]).stdout;
    assert.equal(a, b, "identical board state must produce a byte-identical manifest");
    const payload = JSON.parse(a);
    // Safe declared repo-X code/doc surfaces may parallelize (inherited from plan-waves).
    const x = dispatchFindTicket(payload, "DPH-002");
    assert.equal(x.entry.parallelizable, true);
    assert.match(x.entry.wave_note, /safe declared coord code\/doc surfaces/);
    // dependency ordering preserved: DPH-003 after DPH-001.
    const lead = dispatchFindTicket(payload, "DPH-001");
    const follower = dispatchFindTicket(payload, "DPH-003");
    assert.ok(follower.wave > lead.wave, "the dependent is scheduled in a later wave");
  });
});

test("COORD-031: --md emits a context-pack pointer (not the inlined pack) and the cache prefix", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPM-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "md", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPM-001": ["src/m.js"] }, {}, () => {
    const out = executeCommand(["dispatch-plan", "--md"]).stdout;
    assert.match(out, /Cache prefix: `coord-dispatch-stable-v1`/);
    assert.match(out, /context-pack DPM-001 --md/, "--md references the context-pack by pointer");
    assert.equal(executeCommand(["dispatch-plan", "--md"]).stdout, out, "--md is deterministic");
  });
});

test("COORD-031: dispatch-plan is read-only — no board/lifecycle mutation", () => {
  const board = {
    metadata: { title: "B" },
    sections: [{ rows: [
      { ID: "DPR-001", Repo: "B", Pri: "P2", Status: "todo", Owner: "u", Description: "ro", "Depends On": "" },
    ] }],
  };
  withDispatchPlanScenario(board, { "DPR-001": ["src/r.js"] }, {}, () => {
    const boardPath = __testing.paths.BOARD_PATH;
    const before = fs.readFileSync(boardPath, "utf8");
    executeCommand(["dispatch-plan", "--json"]);
    const after = fs.readFileSync(boardPath, "utf8");
    assert.equal(before, after, "dispatch-plan must not mutate the board");
  });
});
