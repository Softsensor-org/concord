"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const adr = require("./adr-validator.js");
const { dispatch } = require("./coord-cli.js");
const { executeCommand } = require("./cli.js");

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
  const result = adr.govAdr(["supersede", "0001", "--by", "0002", "--json"], {
    cwd: dir,
    log: () => {},
    withGovernanceMutation: (mutation, fn) => {
      calls.push(mutation);
      return fn();
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ command: "adr-supersede", ticket: null }]);
  const oldAdr = adr.parseAdr(path.join(decisions, "0001-valid.md"), decisions);
  const newAdr = adr.parseAdr(path.join(decisions, "0002-replacement-decision.md"), decisions);
  assert.equal(oldAdr.status, "Superseded");
  assert.equal(oldAdr.superseded_by, "0002");
  assert.deepEqual(newAdr.supersedes, ["0001"]);
  const readme = fs.readFileSync(path.join(decisions, "README.md"), "utf8");
  assert.match(readme, /\| \[0001\]\(\.\/0001-valid\.md\) \| Valid \| Superseded \|/);
  assert.equal(adr.validate(decisions).summary.ok, true);
});

test("gov CLI routes read-only adr list", () => {
  const { dir } = validRepo();
  const result = executeCommand(["adr", "list", "--json"], { cwd: dir });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed[0].id, "0001");
  assert.equal(parsed[0].status, "Accepted");
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
