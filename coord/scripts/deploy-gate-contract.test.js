"use strict";

// COORD-079 (QGATE-005): deploy-vs-PR gate-drift contract.
//
// Deploy pipelines tend to hand-maintain a partial list of test/build commands
// and end up WEAKER than the PR gate, so coord stops being the single source of
// truth for what "passing" means. This contract test is the durable anti-drift
// artifact: it asserts the template deploy workflow invokes the CANONICAL gate
// entrypoint (`bash <repo>/scripts/gate.sh <lane>` or `gov gate ... --lane
// <lane>`) on a deploy-strength lane (`full`/`ci`, never the cheap `default`),
// and proves a hand-rolled partial-command workflow FAILS the same check.
//
// The "canonical gate invocation" expectation is single-sourced in
// coord/scripts/governance-constants.js (CANONICAL_GATE_ENTRYPOINTS +
// DEPLOY_GATE_LANES); the deploy workflow template, this check, and the docs
// all read from there so they cannot silently drift.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  CANONICAL_GATE_ENTRYPOINTS,
  DEPLOY_GATE_LANES,
  GATE_LANES,
} = require("./governance-constants.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEPLOY_TEMPLATE = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "deploy.yml.template"
);

// The checker — exported-shape pure function so a generated repo can reuse it
// against its own .github/workflows/deploy.yml. Returns the gate invocations
// found and a structured verdict.
//
// A workflow CONSUMES the gate contract iff it contains at least one line that
// matches a CANONICAL_GATE_ENTRYPOINT whose lane is a DEPLOY_GATE_LANE. A
// workflow that only hand-lists commands (npm test, npm run build, ...) and
// never calls a canonical entrypoint DRIFTS.
function checkDeployGateContract(workflowText) {
  const lines = workflowText.split("\n");
  const invocations = [];
  for (const line of lines) {
    for (const re of CANONICAL_GATE_ENTRYPOINTS) {
      const m = line.match(re);
      if (m) {
        invocations.push({ line: line.trim(), lane: m[1] });
      }
    }
  }
  const deployLaneSet = new Set(DEPLOY_GATE_LANES);
  const deployStrengthInvocations = invocations.filter((i) =>
    deployLaneSet.has(i.lane)
  );
  const weakLaneInvocations = invocations.filter(
    (i) => !deployLaneSet.has(i.lane)
  );
  return {
    invocations,
    deployStrengthInvocations,
    // a canonical entrypoint that runs the cheap `default` lane is still drift:
    // the deploy gate would be weaker than the PR gate.
    weakLaneInvocations,
    consumesContract: deployStrengthInvocations.length > 0,
  };
}

module.exports = { checkDeployGateContract };

test("template deploy workflow exists and consumes the canonical gate contract", (t) => {
  // The public release cut ships ONLY public-ci.yml as its workflow (COORD-121):
  // deploy.yml.template is donor-only infrastructure and is dropped from the cut.
  // When it is absent (i.e. running inside a published cut), this contract has
  // nothing to assert — the donor suite still enforces it. Skip rather than fail.
  if (!fs.existsSync(DEPLOY_TEMPLATE)) {
    t.skip(
      `no deploy.yml.template at ${DEPLOY_TEMPLATE} (expected in a public cut) — donor enforces the contract`
    );
    return;
  }
  const text = fs.readFileSync(DEPLOY_TEMPLATE, "utf8");
  const result = checkDeployGateContract(text);
  assert.ok(
    result.consumesContract,
    "deploy template must invoke the canonical gate entrypoint " +
      "(bash <repo>/scripts/gate.sh <lane> or gov gate --lane <lane>) on a " +
      "full/ci lane, not a hand-rolled command list"
  );
  // Every gate invocation in the deploy template must be a deploy-strength lane
  // (full/ci) — never the cheap `default` lane (would be weaker than PR gate).
  assert.equal(
    result.weakLaneInvocations.length,
    0,
    `deploy template invokes the gate on a weak lane: ${result.weakLaneInvocations
      .map((i) => i.lane)
      .join(", ")} — deploy lanes are ${DEPLOY_GATE_LANES.join("|")}`
  );
});

test("a hand-rolled partial-command deploy workflow FAILS the drift check", () => {
  // This is the anti-pattern the contract removes: a deploy pipeline that
  // re-lists a partial set of commands instead of calling the gate runner. It
  // is strictly WEAKER than the PR gate (no audit/coverage/arch signals) and it
  // rots independently. The checker must reject it.
  const handRolled = [
    "name: deploy",
    "on: { push: { tags: ['v*'] } }",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - run: npm test", // partial — only a subset of the gate
    "      - run: npm run build",
    "      - run: ./deploy-to-prod.sh",
  ].join("\n");
  const result = checkDeployGateContract(handRolled);
  assert.equal(
    result.consumesContract,
    false,
    "a hand-rolled partial-command workflow must NOT pass the gate-contract check"
  );
  assert.equal(result.invocations.length, 0);
});

test("a deploy workflow gating on the cheap `default` lane is rejected (weaker than PR gate)", () => {
  // Using the canonical entrypoint but on `default` is still drift: `default`
  // omits the audit/coverage/arch signals, so the deploy gate would be weaker
  // than the pre-landing PR gate.
  const weak = [
    "jobs:",
    "  gate:",
    "    steps:",
    "      - run: bash backend/scripts/gate.sh default",
  ].join("\n");
  const result = checkDeployGateContract(weak);
  assert.equal(result.consumesContract, false);
  assert.equal(result.weakLaneInvocations.length, 1);
  assert.equal(result.weakLaneInvocations[0].lane, "default");
});

test("the governed `gov gate --lane ci` form also satisfies the contract", () => {
  const governed = [
    "jobs:",
    "  gate:",
    "    steps:",
    "      - run: coord/scripts/gov gate backend --lane ci",
  ].join("\n");
  const result = checkDeployGateContract(governed);
  assert.ok(result.consumesContract);
  assert.equal(result.deployStrengthInvocations[0].lane, "ci");
});

test("DEPLOY_GATE_LANES is a strict subset of GATE_LANES and excludes default", () => {
  for (const lane of DEPLOY_GATE_LANES) {
    assert.ok(
      GATE_LANES.includes(lane),
      `deploy lane ${lane} must be a valid gate lane`
    );
  }
  assert.ok(
    !DEPLOY_GATE_LANES.includes("default"),
    "the cheap `default` lane must not be an accepted deploy lane"
  );
});
