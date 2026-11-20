"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const adr = require("./adr-validator.js");
const { dispatch } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
const { executeCommand } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/cli.js"));
const { evidenceRef, applyInvariantRetraction } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function validRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-valid-"));
  const decisions = path.join(dir, "coord/docs/decisions");
  write(path.join(decisions, "README.md"), [
    "# Decision Records (ADRs)",
    "",
    "| ADR | Title | Status |",
    "| --- | --- | --- |",
    "| [0001](./0001-valid.md) | Valid | Accepted |",
    "",
  ].join("\n"));
  write(path.join(decisions, "0001-valid.md"), [
    "# ADR 0001: Valid",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** COORD-1",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "## Linked Scope",
    "REQ-001",
    "## Decision Criteria",
    "## Options Evaluated",
    "## Decision",
    "## Alternatives Rejected",
    "## Consequences",
    "",
  ].join("\n"));
  return { dir, decisions };
}

test("adr validator accepts well-formed registry", () => {
  const { decisions } = validRepo();
  const report = adr.validate(decisions);
  assert.equal(report.kind, "concord.adr_registry.validation");
  assert.equal(report.summary.ok, true);
  assert.equal(report.summary.adrs, 1);
  assert.equal(report.adrs[0].requirement_ids[0], "REQ-001");
});

test("COORD-807: the ADR cockpit counts only active plan evidence toward a required decision", () => {
  const { dir, decisions } = validRepo();
  const plansDir = path.join(dir, "coord/.runtime/plans");
  const boardPath = path.join(dir, "coord/board/tasks.json");
  const waiver = "decision waiver: human admin accepted the approval-path risk";
  const spike = "discovery spike still open with the platform owner";
  const retract = (plan, reason) => applyInvariantRetraction(plan, {
    entry: evidenceRef("critical_invariant", 1, plan.critical_invariants[0]),
    reason,
    actor: "codexa756",
    timestamp: "2026-10-05T19:30:00.000Z",
  }).record;
  const plans = {
    // A declared waiver, or an active invariant recording one, satisfies the requirement ...
    "APP-DECLARED-WAIVER": { decision_required: { required: true, adr_refs: [], waiver: "human-admin waiver" }, adr_refs: [],
      requirement_closure: ["Implemented: approval path"] },
    "APP-INVARIANT-WAIVER": { decision_required: { required: true, adr_refs: [] }, critical_invariants: [waiver, "unrelated invariant"] },
    // ... but not once that invariant is retracted.
    "APP-RETRACTED-WAIVER": retract({ decision_required: { required: true, adr_refs: [], reason: "changes the approval workflow" },
      critical_invariants: [waiver, "unrelated invariant"] }, "No waiver was ever granted."),
    // The same holds for an investigation note that defers the decision.
    "APP-SPIKE": { decision_required: { required: true }, critical_invariants: [spike] },
    "APP-STALE-SPIKE": retract({ decision_required: "required", security_surface: "tenant security boundary",
      critical_invariants: [spike] }, "The spike was closed without a decision."),
    // Retraction never invents a requirement: declared opt-outs still hold, and
    // an undeclared plan falls back to its active risk text only.
    "APP-NOT-REQUIRED": retract({ decision_required: { required: false }, security_surface: "tenant security boundary",
      critical_invariants: [spike] }, "Recorded against the wrong ticket."),
    "APP-REASON-ONLY": { decision_required: { reason: "noted for the record" }, critical_invariants: ["bounded change"] },
    "APP-DEFERRED": { decision_required: { status: "deferred" } },
    "APP-MARKED": { decision_required: { required: true } },
  };
  for (const [id, plan] of Object.entries(plans)) write(path.join(plansDir, `${id}.json`), JSON.stringify(plan));
  write(boardPath, JSON.stringify({ sections: [{ kind: "table", rows: Object.keys(plans).map((ID) => (
    { ID, Repo: "X", Type: "feature", Status: "todo", Description: "bounded maintenance change" }
  )) }] }));

  const model = adr.buildAdrCockpitModel({ rootDir: decisions, boardPath, plansDir });
  const missing = new Map(model.decision_required_missing_adrs.map((entry) => [entry.ticket, entry.reason]));
  assert.deepEqual([...missing], [
    ["APP-DEFERRED", "marked decision_required"],
    ["APP-MARKED", "marked decision_required"],
    ["APP-RETRACTED-WAIVER", "changes the approval workflow"],
    ["APP-STALE-SPIKE", 'touches high-impact decision surface "security boundary"'],
  ]);
  assert.equal(model.summary.missing_adr_tickets, 4);
});

test("COORD-807 prototype: retracted ADR-risk prose cannot make a ticket require an ADR", () => {
  const { dir, decisions } = validRepo();
  const plansDir = path.join(dir, "coord/.runtime/plans");
  const boardPath = path.join(dir, "coord/board/tasks.json");
  const risk = "security boundary requires a new ADR";
  const plan = applyInvariantRetraction({ critical_invariants: [risk] }, {
    entry: evidenceRef("critical_invariant", 1, risk),
    reason: "This risk statement was entered in error.",
    actor: "codexa756",
    timestamp: "2026-10-05T19:30:00.000Z",
  }).record;
  write(path.join(plansDir, "APP-807.json"), JSON.stringify(plan));
  write(boardPath, JSON.stringify({ sections: [{ kind: "table", rows: [
    { ID: "APP-807", Repo: "X", Type: "bug", Status: "todo", Description: "bounded maintenance fix" },
  ] }] }));

  const model = adr.buildAdrCockpitModel({ rootDir: decisions, boardPath, plansDir });
  assert.equal(model.summary.missing_adr_tickets, 0);
  assert.deepEqual(model.decision_required_missing_adrs, []);
});

test("adr validator fails deterministically on bad fixtures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-bad-"));
  const decisions = path.join(dir, "coord/docs/decisions");
  write(path.join(decisions, "README.md"), [
    "# Decision Records (ADRs)",
    "",
    "| ADR | Title | Status |",
    "| --- | --- | --- |",
    "| [0001](./0001-bad.md) | Bad | Accepted |",
    "| [0002](./0002-missing.md) | Missing | Proposed |",
    "",
  ].join("\n"));
  write(path.join(decisions, "0001-bad.md"), [
    "# ADR 0002: Bad",
    "",
    "- **Status:** Maybe",
    "",
    "## Context",
    "",
  ].join("\n"));
  const report = adr.validate(decisions);
  assert.equal(report.summary.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "adr-heading-id-mismatch"));
  assert.ok(report.findings.some((finding) => finding.code === "adr-invalid-status"));
  assert.ok(report.findings.some((finding) => finding.code === "adr-index-broken-link"));
});

test("adr-validate writes explicit derived output", () => {
  const { dir } = validRepo();
  const result = adr.run(["--dir", "coord/docs/decisions", "--json", "--output", "coord/.runtime/adr-validation.json"], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/adr-validation.json"), "utf8"));
  assert.equal(parsed.kind, "concord.adr_registry.validation");
});

test("product CLI routes adr-validate", () => {
  const { dir } = validRepo();
  const lines = [];
  const result = dispatch(["adr-validate", "--dir", "coord/docs/decisions", "--json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.summary.ok, true);
});

test("gov adr new creates next-numbered draft through governed mutation", () => {
  const { dir, decisions } = validRepo();
  const calls = [];
  const lines = [];
  const result = adr.govAdr(["new", "--title", "Use Governed ADR Commands", "--ticket", "COORD-321", "--json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
    withGovernanceMutation: (mutation, fn) => {
      calls.push(mutation);
      return fn();
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ command: "adr-new", ticket: "COORD-321" }]);
  assert.equal(fs.existsSync(path.join(decisions, "0002-use-governed-adr-commands.md")), true);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.status, "created");
  assert.equal(parsed.adr.id, "0002");
  assert.equal(adr.validate(decisions).summary.ok, true);
});

test("gov adr link records ticket association in ADR metadata", () => {
  const { dir, decisions } = validRepo();
  const calls = [];
  const result = adr.govAdr(["link", "COORD-321", "0001", "--json"], {
    cwd: dir,
    log: () => {},
    withGovernanceMutation: (mutation, fn) => {
      calls.push(mutation);
      return fn();
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ command: "adr-link", ticket: "COORD-321" }]);
  const parsedAdr = adr.parseAdr(path.join(decisions, "0001-valid.md"), decisions);
  assert.deepEqual(parsedAdr.tickets, ["COORD-1", "COORD-321"]);
  assert.equal(adr.validate(decisions).summary.ok, true);
});

test("gov adr supersede updates status, supersedes metadata, and README index", () => {
  const { dir, decisions } = validRepo();
  adr.govAdr(["new", "--title", "Replacement Decision", "--ticket", "COORD-321"], {
    cwd: dir,
    log: () => {},
    withGovernanceMutation: (_mutation, fn) => fn(),
  });
  const calls = [];
  const identity = { agent: { id: "a836", handle: "codexa836" }, session: { session_id: "adr-review-836" } };
  const identityOptions = [];
  const result = adr.govAdr(["supersede", "0001", "--by", "0002", "--json"], {
    cwd: dir,
    log: () => {},
    ensureCurrentAgentIdentity: (options) => { identityOptions.push(options); return identity; },
    withGovernanceMutation: (mutation, fn) => {
      calls.push(mutation);
      return fn();
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(identityOptions, [{ allowAutoClaim: false, touchSession: false }],
    "superseding a decision uses the already-bound identity without claiming or refreshing a session");
  assert.deepEqual(calls, [{ command: "adr-supersede", ticket: null, identity }]);
  const oldAdr = adr.parseAdr(path.join(decisions, "0001-valid.md"), decisions);
  const newAdr = adr.parseAdr(path.join(decisions, "0002-replacement-decision.md"), decisions);
  assert.equal(oldAdr.status, "Superseded");
  assert.equal(oldAdr.superseded_by, "0002");
  assert.deepEqual(newAdr.supersedes, ["0001"]);
  const readme = fs.readFileSync(path.join(decisions, "README.md"), "utf8");
  assert.match(readme, /\| \[0001\]\(\.\/0001-valid\.md\) \| Valid \| Superseded \|/);
  assert.equal(adr.validate(decisions).summary.ok, true);
});

test("gov adr argument failures reject missing values, malformed mutations, and unknown subcommands", () => {
  const { dir } = validRepo();
  const lines = [];
  const deps = {
    cwd: dir,
    log: (line) => lines.push(String(line)),
    withGovernanceMutation: (_mutation, fn) => fn(),
  };

  assert.equal(adr.govAdr(["new", "--title"], deps).code, 1);
  assert.match(lines.join("\n"), /--title requires a value/);
  lines.length = 0;
  assert.equal(adr.govAdr(["check", "--unknown"], deps).code, 1);
  assert.match(lines.join("\n"), /Unexpected argument: --unknown/);

  assert.throws(() => adr.govAdr(["new"], deps), /requires --title/);
  assert.throws(() => adr.govAdr(["new", "--title", "Bad Status", "--status", "Imaginary"], deps), /Invalid ADR status/);
  assert.throws(() => adr.govAdr(["link", "COORD-722"], deps), /requires <ticket-id> <adr-id>/);
  assert.throws(() => adr.govAdr(["supersede", "0001"], deps), /requires <old-adr-id>/);
  assert.throws(() => adr.govAdr(["rename"], deps), /Unknown adr subcommand/);

  const decoy = validRepo();
  try {
    assert.throws(() => adr.govAdr(["new", "--title", "Out of Scope", "--dir", decoy.decisions], deps), /may mutate only the governed decisions directory/);
  } finally {
    fs.rmSync(decoy.dir, { recursive: true, force: true });
  }
});

test("gov adr new can create the absent governed registry and records an omitted ticket as null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adr-new-registry-parent-"));
  const decisions = path.join(root, "coord/docs/decisions");
  const mutations = [];
  const result = adr.govAdr(["new", "--title", "First Decision"], {
    cwd: root,
    decisionsDir: decisions,
    log: () => {},
    withGovernanceMutation: (mutation, fn) => { mutations.push(mutation); return fn(); },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(mutations, [{ command: "adr-new", ticket: null }]);
  assert.equal(fs.existsSync(path.join(decisions, "0001-first-decision.md")), true);
  assert.equal(adr.validate(decisions).summary.ok, true);
});

test("gov adr new refuses a concurrent next-numbered filename collision", () => {
  const { dir, decisions } = validRepo();
  const collision = path.join(decisions, "0002-race-safe-title.md");
  const existsSync = fs.existsSync;
  fs.existsSync = function (target) {
    if (path.resolve(String(target)) === collision) return true;
    return existsSync.apply(this, arguments);
  };
  try {
    assert.throws(() => adr.govAdr(["new", "--title", "Race Safe Title"], {
      cwd: dir,
      log: () => {},
      withGovernanceMutation: (_mutation, fn) => fn(),
    }), /ADR file already exists: 0002-race-safe-title\.md/);
  } finally {
    fs.existsSync = existsSync;
  }
  assert.equal(existsSync(collision), false, "collision guard must not overwrite an existing path");
});

test("gov adr supersede accepts its positional replacement id", () => {
  const { dir, decisions } = validRepo();
  adr.govAdr(["new", "--title", "Positional Replacement"], {
    cwd: dir,
    log: () => {},
    withGovernanceMutation: (_mutation, fn) => fn(),
  });
  const result = adr.govAdr(["supersede", "0001", "0002"], {
    cwd: dir,
    log: () => {},
    withGovernanceMutation: (_mutation, fn) => fn(),
  });
  assert.equal(result.code, 0);
  assert.equal(adr.parseAdr(path.join(decisions, "0001-valid.md"), decisions).superseded_by, "0002");
});

test("adr-validator executable reaches its command-line entrypoint", () => {
  const { spawnSync } = require("node:child_process");
  const executable = path.join(__dirname, "adr-validator.js");
  const result = spawnSync(process.execPath, [executable, "--help"], {
    cwd: path.resolve(__dirname, "../../.."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Usage: adr-validate/);

  const badArgs = spawnSync(process.execPath, [executable, "--not-a-real-flag"], {
    cwd: path.resolve(__dirname, "../../.."),
    encoding: "utf8",
  });
  assert.equal(badArgs.status, 1, `${badArgs.stdout}\n${badArgs.stderr}`);
  assert.match(badArgs.stdout, /Unexpected argument/);

  const valid = validRepo();
  const validReport = spawnSync(process.execPath, [executable, "--dir", "coord/docs/decisions", "--json"], {
    cwd: valid.dir,
    encoding: "utf8",
  });
  assert.equal(validReport.status, 0, `${validReport.stdout}\n${validReport.stderr}`);
  assert.equal(JSON.parse(validReport.stdout).summary.ok, true);

  const invalid = fs.mkdtempSync(path.join(os.tmpdir(), "adr-invalid-cli-"));
  const invalidDecisions = path.join(invalid, "coord/docs/decisions");
  write(path.join(invalidDecisions, "README.md"), [
    "# Decision Records (ADRs)",
    "",
    "| ADR | Title | Status |",
    "| --- | --- | --- |",
    "| [0001](./0001-invalid.md) | Invalid | Accepted |",
    "",
  ].join("\n"));
  write(path.join(invalidDecisions, "0001-invalid.md"), [
    "# ADR 0002: Invalid",
    "",
    "- **Status:** Maybe",
    "",
    "## Context",
    "",
  ].join("\n"));
  const invalidReport = spawnSync(process.execPath, [executable, "--dir", "coord/docs/decisions", "--json"], {
    cwd: invalid,
    encoding: "utf8",
  });
  assert.equal(invalidReport.status, 1, `${invalidReport.stdout}\n${invalidReport.stderr}`);
  assert.equal(JSON.parse(invalidReport.stdout).summary.ok, false);
});

test("gov CLI routes read-only adr list", () => {
  const { dir } = validRepo();
  const result = executeCommand(["adr", "list", "--dir", "coord/docs/decisions", "--json"], { cwd: dir });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed[0].id, "0001");
  assert.equal(parsed[0].status, "Accepted");
});

test("COORD-699: public ADR defaults ignore caller cwd and a decoy registry", () => {
  const governedDir = path.resolve(__dirname, "../../docs/decisions");
  const expected = adr.validate(governedDir);
  assert.ok(expected.adrs.length, "the governed registry must contain an ADR for this routing proof");
  const decoy = validRepo();
  const nested = path.join(decoy.dir, "other", "nested");
  fs.mkdirSync(nested, { recursive: true });
  try {
    for (const cwd of [path.resolve(__dirname, "../../.."), path.resolve(__dirname, "..", ".."), decoy.dir, nested]) {
      const list = executeCommand(["adr", "list", "--json"], { cwd });
      assert.equal(list.ok, true, list.error);
      assert.deepEqual(JSON.parse(list.stdout).map((row) => row.path), expected.adrs.map((row) => row.path), cwd);
      const show = executeCommand(["adr", "show", expected.adrs[0].id, "--json"], { cwd });
      assert.equal(show.ok, true, show.error);
      assert.equal(JSON.parse(show.stdout).path, expected.adrs[0].path);
      const check = executeCommand(["adr", "check", "--json"], { cwd });
      assert.equal(check.ok, true, check.error);
      assert.deepEqual(JSON.parse(check.stdout).adrs.map((row) => row.path), expected.adrs.map((row) => row.path));
    }
  } finally {
    fs.rmSync(decoy.dir, { recursive: true, force: true });
  }
});

test("COORD-699: explicit relative and absolute ADR directories remain caller-selected", () => {
  const fixture = validRepo();
  try {
    for (const dir of ["coord/docs/decisions", fixture.decisions]) {
      const result = executeCommand(["adr", "list", "--dir", dir, "--json"], { cwd: fixture.dir });
      assert.equal(result.ok, true, result.error);
      const rows = JSON.parse(result.stdout);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].path, "0001-valid.md");
      assert.equal(rows[0].title, "Valid");
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("COORD-699: ADR help explains the default and overrides; mutation guard remains mandatory", () => {
  const lines = [];
  adr.govAdr(["help"], { log: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /governed decisions directory/);
  assert.match(lines.join("\n"), /read-only commands; mutations are restricted/);
  for (const args of [["new", "--title", "No Guard"], ["link", "COORD-699", "0001"], ["supersede", "0001", "--by", "0002"]]) {
    assert.throws(() => adr.govAdr(args, { coordDir: "/not-a-registry", log: () => {} }), /governed mutation|withGovernanceMutation/i);
  }
});

test("COORD-699: new, link and supersede share the supplied governed root", () => {
  const governed = validRepo();
  const decoy = validRepo();
  const before = fs.readFileSync(path.join(decoy.decisions, "0001-valid.md"), "utf8");
  const calls = [];
  const deps = {
    cwd: decoy.dir,
    coordDir: path.join(governed.dir, "coord"),
    log: () => {},
    withGovernanceMutation: (mutation, fn) => { calls.push(mutation.command); return fn(); },
  };
  try {
    adr.govAdr(["new", "--title", "Governed Root", "--ticket", "COORD-699"], deps);
    adr.govAdr(["link", "COORD-699", "0001"], deps);
    adr.govAdr(["supersede", "0001", "--by", "0002"], deps);
    assert.deepEqual(calls, ["adr-new", "adr-link", "adr-supersede"]);
    const report = adr.validate(governed.decisions);
    assert.equal(report.summary.ok, true);
    assert.equal(report.adrs.length, 2);
    assert.equal(report.adrs[0].status, "Superseded");
    assert.ok(report.adrs[0].tickets.includes("COORD-699"));
    assert.equal(fs.readFileSync(path.join(decoy.decisions, "0001-valid.md"), "utf8"), before);
    assert.equal(adr.validate(decoy.decisions).adrs.length, 1);
  } finally {
    fs.rmSync(governed.dir, { recursive: true, force: true });
    fs.rmSync(decoy.dir, { recursive: true, force: true });
  }
});

test("adr cockpit readout surfaces coverage, supersession, revisit triggers, and missing ADR gaps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-cockpit-"));
  const decisions = path.join(dir, "coord/docs/decisions");
  write(path.join(decisions, "README.md"), [
    "# Decision Records (ADRs)",
    "",
    "| ADR | Title | Status |",
    "| --- | --- | --- |",
    "| [0001](./0001-api-contract.md) | API Contract | Accepted |",
    "| [0002](./0002-scheduler-deferral.md) | Scheduler Deferral | Deferred |",
    "| [0003](./0003-old-routing.md) | Old Routing | Superseded |",
    "| [0004](./0004-new-routing.md) | New Routing | Accepted |",
    "",
  ].join("\n"));
  write(path.join(decisions, "0001-api-contract.md"), [
    "# ADR 0001: API Contract",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** DEMO-1",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "## Linked Scope",
    "- Requirement: REQ-101.",
    "- Affected repos: backend, frontend.",
    "- Affected modules: backend/src/api/orders.ts, frontend/src/orders.tsx.",
    "## Decision Criteria",
    "## Options Evaluated",
    "## Decision",
    "Use the versioned public API contract.",
    "## Alternatives Rejected",
    "## Consequences",
    "",
  ].join("\n"));
  write(path.join(decisions, "0002-scheduler-deferral.md"), [
    "# ADR 0002: Scheduler Deferral",
    "",
    "- **Status:** Deferred",
    "- **Ticket:** DEMO-2",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "## Linked Scope",
    "- Affected surfaces: coord gate lanes.",
    "## Decision Criteria",
    "## Options Evaluated",
    "## Decision",
    "Defer the scheduler.",
    "## Alternatives Rejected",
    "## Consequences",
    "## Revisit Trigger",
    "Revisit when duplicate heavy-gate cost is measured.",
    "",
  ].join("\n"));
  write(path.join(decisions, "0003-old-routing.md"), [
    "# ADR 0003: Old Routing",
    "",
    "- **Status:** Superseded (by 0004)",
    "- **Ticket:** DEMO-3",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "## Linked Scope",
    "## Decision Criteria",
    "## Options Evaluated",
    "## Decision",
    "Use old routing.",
    "## Alternatives Rejected",
    "## Consequences",
    "",
  ].join("\n"));
  write(path.join(decisions, "0004-new-routing.md"), [
    "# ADR 0004: New Routing",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** DEMO-4",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "## Linked Scope",
    "- Supersedes ADR 0003.",
    "- Affected repos: backend.",
    "## Decision Criteria",
    "## Options Evaluated",
    "## Decision",
    "Use new routing.",
    "## Alternatives Rejected",
    "## Consequences",
    "",
  ].join("\n"));
  write(path.join(dir, "coord/board/tasks.json"), JSON.stringify({
    version: 1,
    sections: [{
      kind: "table",
      rows: [
        { ID: "DEMO-1", Repo: "B", Type: "feature", Status: "done", Description: "Implement public API contract." },
        { ID: "DEMO-MISSING", Repo: "X", Type: "feature", Status: "todo", Description: "Change security boundary for tenant trust." },
      ],
    }],
  }, null, 2));

  const model = adr.buildAdrCockpitModel({
    rootDir: decisions,
    boardPath: path.join(dir, "coord/board/tasks.json"),
    plansDir: path.join(dir, "coord/.runtime/plans"),
    demo: false,
  });
  assert.equal(model.kind, "concord.adr_cockpit.readout");
  assert.equal(model.mode, "read-only");
  assert.equal(model.summary.accepted, 2);
  assert.equal(model.summary.deferred, 1);
  assert.equal(model.summary.superseded, 1);
  assert.deepEqual(model.adrs.find((item) => item.id === "ADR-0001").linked_requirements, ["REQ-101"]);
  assert.ok(model.adrs.find((item) => item.id === "ADR-0001").affected_repos.includes("backend"));
  assert.deepEqual(model.supersession_chains[0].ids, ["ADR-0004", "ADR-0003"]);
  assert.equal(model.revisit_triggers[0].id, "ADR-0002");
  assert.equal(model.decision_required_missing_adrs[0].ticket, "DEMO-MISSING");
  assert.match(model.decision_required_missing_adrs[0].commands[0], /gov adr new/);
});

test("adr-validate --cockpit --demo emits read-only demo fixture cases", () => {
  const { dir } = validRepo();
  const lines = [];
  const result = adr.run(["--dir", "coord/docs/decisions", "--cockpit", "--demo", "--json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.kind, "concord.adr_cockpit.readout");
  assert.equal(parsed.demo.accepted.status, "Accepted");
  assert.equal(parsed.demo.deferred.status, "Deferred");
  assert.equal(parsed.demo.superseded.history_status, "Superseded");
  assert.equal(parsed.demo.missing_adr.ticket, "DEMO-105");
  assert.match(parsed.demo.missing_adr.rendered_commands[0], /coord\/scripts\/gov adr new/);
});

// COORD-807: the CLI tail is an injectable main(argv, io); the process exit code
// is whatever run() returned.
function runAdrMain(argv, cwd) {
  const lines = [];
  const exits = [];
  adr.main(argv, { cwd, log: (line) => lines.push(line), exit: (code) => exits.push(code) });
  return { lines, exits };
}

test("COORD-807: adr-validate main exits 1 with the parse error and 0 with usage", () => {
  const bad = runAdrMain(["--bogus"]);
  assert.deepEqual(bad.lines, ["adr-validate: Unexpected argument: --bogus"]);
  assert.deepEqual(bad.exits, [1]);

  const help = runAdrMain(["--help"]);
  assert.deepEqual(help.lines, [
    "Usage: adr-validate [--dir coord/docs/decisions] [--json] [--output <path>] [--cockpit] [--demo]",
  ]);
  assert.deepEqual(help.exits, [0]);
});

test("COORD-807: adr-validate main exits with the validation verdict of the registry under cwd", () => {
  const { dir } = validRepo();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-main-empty-"));
  try {
    const ok = runAdrMain(["--dir", "coord/docs/decisions", "--json"], dir);
    assert.deepEqual(ok.exits, [0]);
    assert.equal(ok.lines.length, 1);
    const okReport = JSON.parse(ok.lines[0]);
    assert.equal(okReport.kind, "concord.adr_registry.validation");
    assert.equal(okReport.summary.ok, true);

    const failing = runAdrMain(["--dir", "coord/docs/decisions", "--json"], emptyDir);
    assert.deepEqual(failing.exits, [1]);
    assert.equal(JSON.parse(failing.lines[0]).summary.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("COORD-807: the adr-validator script run as a process prints to stdout and sets the exit status", () => {
  const { spawnSync } = require("node:child_process");
  const script = path.join(__dirname, "adr-validator.js");
  const { dir } = validRepo();
  try {
    const spawn = (args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });

    const help = spawn(["--help"]);
    assert.equal(help.status, 0);
    assert.equal(help.stdout, "Usage: adr-validate [--dir coord/docs/decisions] [--json] [--output <path>] [--cockpit] [--demo]\n");
    assert.equal(help.stderr, "");

    const bad = spawn(["--dir"]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "adr-validate: --dir requires a value\n");
    assert.equal(bad.stderr, "");

    const ok = spawn(["--dir", "coord/docs/decisions", "--json"]);
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).summary.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-868: blank and non-ADR refs on a required decision are dropped or reported as missing, never accepted", () => {
  const { dir, decisions } = validRepo();
  const plansDir = path.join(dir, "coord/.runtime/plans");
  const boardPath = path.join(dir, "coord/board/tasks.json");
  // A null entry is dropped before matching; "decision pending" names no ADR
  // number, so it normalizes to nothing and stays a missing ref; ADR-9999 is
  // well-formed but not accepted. None of them satisfies the requirement.
  write(path.join(plansDir, "APP-868.json"), JSON.stringify({
    decision_required: { required: true, adr_refs: [null, "decision pending"] },
    adr_refs: [null, "ADR-9999"],
  }));
  write(boardPath, JSON.stringify({ sections: [{ kind: "table", rows: [
    { ID: "APP-868", Repo: "X", Type: "feature", Status: "doing", Description: "bounded maintenance change" },
  ] }] }));

  const model = adr.buildAdrCockpitModel({ rootDir: decisions, boardPath, plansDir });
  assert.equal(model.summary.missing_adr_tickets, 1);
  const [entry] = model.decision_required_missing_adrs;
  assert.equal(entry.ticket, "APP-868");
  assert.deepEqual(entry.adr_refs, ["ADR-9999", "decision pending", "9999"]);
  assert.deepEqual(entry.missing_adr_refs, ["ADR-9999", "decision pending", "9999"]);
  // The defensive blank-input arm is only reachable directly.
  for (const blank of [null, undefined, ""]) assert.equal(adr.__testing.normalizeAdrRef(blank), null);
  assert.equal(adr.__testing.normalizeAdrRef("adr 0007"), "0007");
});
