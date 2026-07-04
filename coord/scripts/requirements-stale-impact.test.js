"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const stale = require("./requirements-stale-impact.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

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

test("requirements-stale-impact command writes explicit derived output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-stale-impact-"));
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

test("product CLI routes requirements-stale-impact", () => {
  const registryMeta = buildRegistry({ log: () => {} });
  assert.equal(typeof registryMeta["requirements-stale-impact"].run, "function");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-stale-cli-"));
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
