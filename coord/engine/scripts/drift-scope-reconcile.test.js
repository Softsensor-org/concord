"use strict";

// COORD-862 (COORD-516a): per-scope reconcile. Runs in an isolated governance
// workspace so packet paths are coord-relative and the checkout is canonical.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const sourceCoord = path.resolve(__dirname, "../..");
const { resolveEngineModule } = require("../../paths.js");
const { createIsolatedGovernanceWorkspace } = require(resolveEngineModule(sourceCoord, "engine/scripts/fixtures/isolated-governance-workspace.js"));
const workspace = createIsolatedGovernanceWorkspace({ sourceCoord, prefix: "coord862-reconcile-" });
process.on("exit", workspace.cleanup);
const COORD_DIR = workspace.coord;
const { state } = require(resolveEngineModule(COORD_DIR, "scripts/governance-context.js"));
const { executeCommand } = require(resolveEngineModule(COORD_DIR, "scripts/cli.js"));
const { __testing, withGovernedSurfaceSandbox } = require(resolveEngineModule(COORD_DIR, "scripts/governance-test-utils.js"));

function seedBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-10-24T00:00:00.000Z", command: "journal-baseline", ticket: null, before_status: null,
    after_status: null, identity: null, details: { reason: "coord862-test" }, changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

function runReconcile(args, cwd = undefined) {
  const result = executeCommand(["reconcile", ...args], cwd ? { cwd } : {});
  if (!result.ok) throw new Error(result.error);
  return JSON.parse(result.stdout);
}

test("COORD-862: reconcile --scope adopts one scope and keeps the rest detectable", () => {
  withGovernedSurfaceSandbox(({ promptsDir, tempDir }) => {
    const promptPath = path.join(promptsDir, "tickets", "T-1.md");
    const renderedPath = path.join(state.RENDERED_DIR, "TASKS.md");
    fs.writeFileSync(promptPath, "# T-1\n", "utf8");
    fs.writeFileSync(renderedPath, "rendered v1\n", "utf8");
    seedBaseline();
    fs.writeFileSync(promptPath, "# T-1 hand edit\n", "utf8");
    fs.writeFileSync(renderedPath, "rendered v2\n", "utf8");
    const rel = (file) => path.relative(COORD_DIR, file).split(path.sep).join("/");

    const reconcile = (args) => runReconcile(args, tempDir);
    const dry = reconcile(["--reason", "inspect", "--scope", "derived", "--dry-run"]);
    assert.equal(dry.scope, "derived");
    assert.deepEqual(dry.drift, [rel(renderedPath)]);
    assert.deepEqual(dry.drift_by_scope.governed, [rel(promptPath)]);
    assert.deepEqual(dry.drift_by_scope.derived, [rel(renderedPath)]);
    assert.equal(dry.scope_summary, "engine intact, 2 project paths unjournaled (governed 1, derived 1)");
    assert.match(dry.scope_remedies, /governed: .*; derived: .*gov sync/);
    assert.equal(dry.expect_paths_packet.length, 1);

    const packetPath = path.join(tempDir, "derived.packet");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(renderedPath)).digest("hex");
    fs.writeFileSync(packetPath, `${digest} ${rel(renderedPath)}\n`, "utf8");
    const applyArgs = ["--reason", "regenerated view reviewed", "--scope", "derived",
      "--human-admin-override", "Fixture administrator approves the rendered view bytes", "--expect-paths-file", packetPath];
    const refused = executeCommand(["reconcile", ...applyArgs], { cwd: tempDir });
    assert.equal(refused.ok, false, "override text alone must not authorize scoped adoption");
    assert.match(refused.error, /requires a signed human-admin approval/);
    const subject = /Subject digest: ([0-9a-f]{64})/.exec(refused.error);
    assert.ok(subject, refused.error);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift.slice().sort(),
      [rel(promptPath), rel(renderedPath)].sort(), "the unsigned attempt leaves both scopes unadopted");
    const approval = createApprovalFixture({ allowedVerbs: ["reconcile"] });
    let done;
    try {
      approval.login({ verb: "reconcile", ticket: "control-plane", subject_sha256: subject[1] });
      done = withApprovalTestClient(COORD_DIR, approval.client(), () => reconcile(applyArgs));
    } finally { approval.cleanup(); }
    assert.equal(done.status, "reconciled");
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, [rel(promptPath)], "the governed prompt drift is retained");
    const event = __testing.readGovernanceEventLog().findLast((entry) => entry.command === "manual-reconcile");
    assert.equal(event.details.reconcile_scope, "derived");
    assert.deepEqual(event.details.retained_preexisting_drift, [rel(promptPath)]);

    const noop = reconcile(["--reason", "nothing derived left", "--scope", "derived"]);
    assert.equal(noop.status, "noop");
    assert.equal(noop.scope, "derived");
    assert.throws(() => reconcile(["--reason", "x", "--scope", "engine"]), /--scope must be one of governed, derived, runtime; engine drift is repaired by restoring the file or re-pinning/);
  }, { coordRelativePaths: true });
});

test("COORD-862: reconcile --scope cannot establish a missing baseline", () => {
  withGovernedSurfaceSandbox(() => {
    assert.throws(() => runReconcile(["--reason", "x", "--scope", "governed", "--dry-run"]), /--scope cannot establish a missing or pruned baseline/);
  });
});
