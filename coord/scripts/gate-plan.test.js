"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const gatePlan = require("./gate-plan.js");

function writeMap(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-plan-"));
  const mapPath = path.join(dir, "affected-targets.json");
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
  return mapPath;
}

const MAP = {
  schema_version: 1,
  updated_at: "2026-06-28",
  full_gate: { commands: ["node --test"] },
  targets: [
    {
      id: "unit:planner",
      command: "node --test coord/scripts/gate-plan.test.js",
      files: ["coord/scripts/gate-plan.js", "coord/scripts/gate-plan.test.js"],
    },
    {
      id: "unit:policy",
      command: "node --test coord/scripts/track-evidence-policy.test.js",
      files: ["coord/scripts/track-evidence-policy.js"],
      depends_on: ["unit:planner"],
    },
  ],
};

test("gate plan selects direct and transitive affected targets deterministically", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-379",
    row: { ID: "COORD-379", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" },
    planState: { intended_files: ["coord/scripts/gate-plan.js"], repo_gates: ["node --test"] },
    mapPath: writeMap(MAP),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.track.name, "development");
  assert.equal(receipt.affected_targets.mode, "slice");
  assert.deepEqual(
    receipt.affected_targets.selected.map((target) => target.id),
    ["unit:planner", "unit:policy"]
  );
  assert.equal(receipt.selected_gates[0].id, "track:test");
});

test("gate plan falls back to full for unknown files", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-386",
    row: { ID: "COORD-386", Repo: "X", Type: "feature", Pri: "P2", Description: "affected target maps" },
    planState: { intended_files: ["unknown/file.js"] },
    mapPath: writeMap(MAP),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.match(receipt.fallback_reason, /unknown changed file/);
});

test("gate plan falls back to full for stale maps", () => {
  const staleMap = { ...MAP, updated_at: "2025-01-01" };
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-386",
    row: { ID: "COORD-386", Repo: "X", Type: "feature", Pri: "P2", Description: "affected target maps" },
    planState: { intended_files: ["coord/scripts/gate-plan.js"] },
    mapPath: writeMap(staleMap),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.match(receipt.affected_targets.map.reason, /older than/);
});

test("gate plan resolves configured tracks from prefixes", () => {
  const registryDeps = {
    projectConfig: {
      tracks: {
        marketing: { prefixes: ["WEB"], gateProc: "content", defaultLane: "default" },
      },
    },
  };
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "WEB-101",
    row: { ID: "WEB-101", Repo: "X", Type: "feature", Pri: "P1", Description: "public page" },
    planState: { intended_files: ["coord/product/site.html"] },
    registryDeps,
    mapPath: writeMap(MAP),
    full: true,
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.track.name, "marketing");
  assert.equal(receipt.track.gate_proc, "content");
});

test("gate plan readiness blocks high-risk missing receipts but not light lane", () => {
  const blocker = gatePlan.collectGatePlanReadinessIssues(
    "OPS-101",
    { ID: "OPS-101", Type: "feature", Pri: "P1", Description: "production deploy" },
    {},
    { now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(blocker.length, 1);
  assert.equal(blocker[0].code, "gate_plan_receipt");

  const light = gatePlan.collectGatePlanReadinessIssues(
    "DOC-101",
    { ID: "DOC-101", Type: "docs", Pri: "P2", Description: "docs" },
    {},
    { lightLane: true, now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(light.length, 0);
});

test("gate plan readiness keeps low-risk receipt evidence issues warning-first", () => {
  const issues = gatePlan.collectGatePlanReadinessIssues(
    "COORD-379",
    { ID: "COORD-379", Type: "feature", Pri: "P1", Description: "gate planner" },
    {
      gate_plan: {
        planner_version: "gate-plan-v1",
        generated_at: "2026-06-28T12:00:00.000Z",
        risk_class: "R2",
        enforcement: "warning-first",
        affected_targets: { mode: "slice", selected: [] },
        evidence_issues: [{ code: "track_evidence_repo_gate", severity: "blocker", message: "missing" }],
      },
    },
    { now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(issues.length, 0);
});

test("standalone run is read-only without --write", () => {
  const lines = [];
  const result = gatePlan.run(["COORD-379", "--files", "coord/scripts/gate-plan.js", "--map", writeMap(MAP)], {
    row: { ID: "COORD-379", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" },
    planState: { repo_gates: ["node --test"] },
    now: "2026-06-28T12:00:00.000Z",
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(lines.join("")).ticket_id, "COORD-379");
});
