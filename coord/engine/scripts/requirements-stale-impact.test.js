"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const stale = require("./requirements-stale-impact.js");
const { buildRegistry, dispatch } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
const { evidenceRef, stableSupersessionId } = require("./plan-evidence-supersession.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function registry(hash) {
  return {
    requirements: [
      {
        id: "URS-001",
        title: "Changed requirement",
        source: { anchor: "urs-001-changed", block_hash: hash },
        coverage: { ticket_ids: ["IMP-001"] },
      },
      {
        id: "URS-002",
        title: "Stable requirement",
        source: { anchor: "urs-002-stable", block_hash: "sha256:stable" },
        coverage: { ticket_ids: ["IMP-002"] },
      },
    ],
  };
}

function board() {
  return {
    sections: [
      {
        kind: "table",
        rows: [
          { ID: "IMP-001", Type: "feature", Pri: "P1", Status: "done", Description: "Implement URS-001", "Requirement IDs": "URS-001" },
          { ID: "IMP-002", Type: "feature", Pri: "P2", Status: "done", Description: "Implement URS-002", "Requirement IDs": "URS-002" },
        ],
      },
    ],
  };
}

function plans() {
  return [
    {
      ticket_id: "IMP-001",
      repo_gates: ["node --test changed.test.js"],
      self_review_cycles: [{ verdict: "pass" }],
      feature_proof: ["path:src/changed.js"],
      requirement_closure: ["Closeout verdict: complete"],
    },
  ];
}

function screenIndex() {
  return {
    apps: [
      {
        app: "web",
        screens: [
          {
            id: "changed-screen",
            route: "/changed",
            requirement_refs: [{ anchor: "urs-001-changed", confidence: "explicit" }],
          },
        ],
      },
    ],
  };
}

test("changedRequirements compares source block hashes", () => {
  const changes = stale.changedRequirements(registry("sha256:old"), registry("sha256:new"));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].requirement_id, "URS-001");
  assert.equal(changes[0].change, "changed");
});

test("buildStaleImpactReport reports impacted tickets, screens, and evidence", () => {
  const report = stale.buildStaleImpactReport({
    baselineRegistry: registry("sha256:old"),
    currentRegistry: registry("sha256:new"),
    board: board(),
    planRecords: plans(),
    screenIndex: screenIndex(),
  });
  assert.equal(report.kind, "concord.requirements.stale_impact_report");
  assert.deepEqual(report.impacted_tickets, ["IMP-001"]);
  assert.equal(report.impacted_screens[0].screen_id, "changed-screen");
  const impact = report.changed_requirements[0];
  assert.equal(impact.impacted_evidence[0].repo_gates[0], "node --test changed.test.js");
  assert.equal(impact.required_action, "revalidate-linked-work-or-record-waiver");
});

test("stale-impact joins do not treat historical description IDs as ticket links", () => {
  const report = stale.buildStaleImpactReport({
    baselineRegistry: { requirements: [{ id: "REQ-OLD", title: "Old", source: { block_hash: "sha256:before" } }, { id: "REQ-CURRENT", source: { block_hash: "sha256:current" } }] },
    currentRegistry: { requirements: [{ id: "REQ-OLD", title: "Old", source: { block_hash: "sha256:after" } }, { id: "REQ-CURRENT", source: { block_hash: "sha256:current" } }] },
    board: { sections: [{ kind: "table", rows: [{
      ID: "T-529", Type: "feature", Pri: "P1", Status: "todo",
      Description: "REQ-OLD appears only as historical context", "Requirement IDs": "REQ-CURRENT",
    }] }] },
    planRecords: [],
    screenIndex: {},
  });
  const oldImpact = report.changed_requirements.find((item) => item.requirement_id === "REQ-OLD");
  assert.deepEqual(oldImpact.impacted_tickets, []);
});

test("stale-impact projection omits superseded commands and tolerates legacy optional fields", () => {
  const old = "npm run verify:runtime receipt observed /orders";
  const successor = "TODO: corrected runtime receipt not captured";
  const sourceRef = require("./plan-evidence-supersession.js").evidenceRef("verification_command", 1, old);
  const successorRef = require("./plan-evidence-supersession.js").evidenceRef("verification_command", 2, successor);
  const { stableSupersessionId } = require("./plan-evidence-supersession.js");
  const legacyPlan = {
    ticket_id: "IMP-001", repo_gates: ["node --test"], verification_commands: [old, successor],
    evidence_supersessions: [{ id: stableSupersessionId(sourceRef, successorRef), kind: "verification_command",
      source_ref: sourceRef, successor_ref: successorRef, reason: "Stale observation.", actor: "fixture",
      timestamp: "2026-10-05T00:00:00.000Z" }],
  };
  const report = stale.buildStaleImpactReport({ baselineRegistry: registry("sha256:old"), currentRegistry: registry("sha256:new"),
    board: board(), planRecords: [legacyPlan], screenIndex: screenIndex() });
  const evidence = report.changed_requirements[0].impacted_evidence[0];
  assert.deepEqual(evidence.verification_commands, [successor]);
  assert.deepEqual(evidence.feature_proof, []);
  assert.equal(evidence.review_cycles, 0);
  assert.deepEqual(evidence.requirement_closure, []);
});

test("requirements-stale-impact CLI help exposes its required baseline/current inputs", () => {
  const stdout = execFileSync(process.execPath, [path.join(__dirname, "requirements-stale-impact.js"), "--help"], { encoding: "utf8" });
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--baseline/);
  assert.match(stdout, /--current/);
});

test("requirements-stale-impact public CLI preserves refusal exit status", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "requirements-stale-impact.js"), "--unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Unexpected argument: --unknown/);
});

test("stale impact evidence contains only the active gate after a correction", () => {
  const old = "node --test changed.test.js [result=pass] stale head";
  const successor = "TODO: corrected gate not executed";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const report = stale.buildStaleImpactReport({
    baselineRegistry: registry("sha256:old"), currentRegistry: registry("sha256:new"), board: board(),
    planRecords: [{ ...plans()[0], repo_gates: [old, successor], evidence_supersessions: [{
      id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
      successor_ref: successorRef, reason: "old head", actor: "fixture-agent", timestamp: "2026-10-05T00:00:00.000Z",
    }] }], screenIndex: screenIndex(),
  });
  assert.deepEqual(report.changed_requirements[0].impacted_evidence[0].repo_gates, [successor]);
});

test("requirements-stale-impact command writes explicit derived output", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-stale-impact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/baseline.json"), JSON.stringify(registry("sha256:old")));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(registry("sha256:new")));
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(board()));
  fs.writeFileSync(path.join(dir, "coord/.runtime/plans/IMP-001.json"), JSON.stringify(plans()[0]));
  const output = "coord/.runtime/requirements/stale-impact.json";

  const result = stale.run(["--dir", dir, "--baseline", "coord/.runtime/requirements/baseline.json", "--json", "--output", output], {
    cwd: dir,
    log: () => {},
  });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.summary.changed_requirements, 1);
});

test("product CLI routes requirements-stale-impact", (t) => {
  const registryMeta = buildRegistry({ log: () => {} });
  assert.equal(typeof registryMeta["requirements-stale-impact"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-stale-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "coord/board"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/baseline.json"), JSON.stringify(registry("sha256:old")));
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/registry.json"), JSON.stringify(registry("sha256:new")));
  fs.writeFileSync(path.join(dir, "coord/board/tasks.json"), JSON.stringify(board()));

  const cap = capture();
  const result = dispatch(["requirements-stale-impact", "--dir", dir, "--baseline", "coord/.runtime/requirements/baseline.json", "--json"], {
    cwd: dir,
    log: cap.log,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.stale_impact_report");
});
