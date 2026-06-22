"use strict";

// COORD-075 (QGATE-001): gate-lane vocabulary contract.
//
// The accepted gate-lane names must be ONE vocabulary across:
//   - coord validation (`gov gate --lane`, single-sourced in
//     governance-constants.GATE_LANES, consumed by gate-runtime.js),
//   - the template repo runners (`backend|frontend/scripts/gate.sh <lane>`),
//   - the governance MCP `gate.lane` enum,
//   - the BOOTSTRAP_CONTRACT lane table that derived repos implement,
//   - the coord-ui gates dashboard lane list.
//
// Historically coord accepted `default|full|extended` while the runners
// accepted `default|full|ci`, so `--lane ci` was rejected and `extended` was an
// accepted-but-unimplemented phantom. This test fails if any surface drifts from
// the single source of truth so the contract cannot silently regress again.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { GATE_LANES } = require("./governance-constants.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Canonical, executable lane vocabulary.
const CANONICAL = ["default", "full", "ci"];

// Parse the lanes accepted by a `scripts/gate.sh` from its `case "$LANE" in`
// validation arm: the line of the form `  default | full | ci) ;;`.
function laneCaseFromGateScript(scriptPath) {
  const src = fs.readFileSync(scriptPath, "utf8");
  // The first case arm that ends in `) ;;` and lists bare lane tokens.
  const match = src.match(/^\s*([a-z]+(?:\s*\|\s*[a-z]+)*)\)\s*;;/m);
  assert.ok(match, `could not parse lane case arm from ${scriptPath}`);
  return match[1].split("|").map((s) => s.trim()).filter(Boolean);
}

test("GATE_LANES is the canonical default|full|ci vocabulary", () => {
  assert.deepEqual([...GATE_LANES], CANONICAL);
  // `extended` (the former phantom) must NOT be an accepted lane.
  assert.ok(!GATE_LANES.includes("extended"));
});

test("template gate.sh runners accept exactly GATE_LANES", () => {
  for (const repo of ["backend", "frontend"]) {
    const scriptPath = path.join(REPO_ROOT, repo, "scripts", "gate.sh");
    const accepted = laneCaseFromGateScript(scriptPath);
    assert.deepEqual(
      [...accepted].sort(),
      [...GATE_LANES].sort(),
      `${repo}/scripts/gate.sh accepts ${accepted.join("|")} but GATE_LANES is ${[...GATE_LANES].join("|")}`
    );
  }
});

test("gate-runtime --lane validation rejects extended and accepts every GATE_LANES value", () => {
  const { __testing } = require("./governance-test-utils.js");
  // resolveGateInvocation is the lane-keyed resolver; but the lane *validation*
  // lives in runCleanCheckoutGate. We assert the constant the validator uses is
  // the canonical set (the validator builds its Set from gateLaneSet()).
  const { gateLaneSet } = require("./governance-constants.js");
  const validator = gateLaneSet();
  for (const lane of CANONICAL) assert.ok(validator.has(lane), `${lane} must be accepted`);
  assert.ok(!validator.has("extended"), "extended must be rejected by the validator");
  // Touch __testing so the harness keeps the gate-runtime surface loaded.
  assert.equal(typeof __testing.resolveGateInvocation, "function");
});

test("governance MCP gate.lane enum matches GATE_LANES", () => {
  const mcpSrc = fs.readFileSync(path.join(__dirname, "governance-mcp.js"), "utf8");
  // The enum is sourced from GATE_LANES; assert it is not a stale hardcoded list.
  assert.ok(
    /lane:\s*\{\s*type:\s*"string",\s*enum:\s*\[\.\.\.GATE_LANES\]\s*\}/.test(mcpSrc),
    "governance-mcp gate.lane enum must derive from GATE_LANES (no hardcoded lane list)"
  );
  assert.ok(!/enum:\s*\[[^\]]*"extended"[^\]]*\]/.test(mcpSrc), "MCP must not enumerate extended");
});

test("BOOTSTRAP_CONTRACT lane table lists exactly GATE_LANES", () => {
  const doc = fs.readFileSync(
    path.join(REPO_ROOT, "coord", "product", "BOOTSTRAP_CONTRACT.md"),
    "utf8"
  );
  // Collect lanes from the markdown table rows of the form `| `lane` | ... |`.
  const lanes = [...doc.matchAll(/^\|\s*`([a-z]+)`\s*\|/gm)].map((m) => m[1]);
  const laneSet = new Set(lanes);
  for (const lane of CANONICAL) {
    assert.ok(laneSet.has(lane), `BOOTSTRAP_CONTRACT must document the ${lane} lane`);
  }
  assert.ok(!laneSet.has("extended"), "BOOTSTRAP_CONTRACT must not document extended as a runner lane");
});

test("coord-ui gates dashboard lane list matches GATE_LANES", () => {
  const tsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "frontend", "apps", "coord-ui", "lib", "gates.ts"),
    "utf8"
  );
  const match = tsSrc.match(/const LANES\s*=\s*\[([^\]]*)\]\s*as const;/);
  assert.ok(match, "could not find LANES const in gates.ts");
  const lanes = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...lanes].sort(),
    [...GATE_LANES].sort(),
    `gates.ts LANES (${lanes.join("|")}) must match GATE_LANES`
  );
});
