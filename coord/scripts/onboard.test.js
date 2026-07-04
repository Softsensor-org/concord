"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildOnboardPlan,
  parseArgs,
  renderOnboardPlan,
  writeOnboardArtifacts,
} = require("./onboard.js");

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-onboard-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  return root;
}

test("onboard dry-run builds a deterministic adoption plan", () => {
  const root = tmpRoot();
  const plan = buildOnboardPlan(root);
  assert.equal(plan.kind, "concord.onboard_plan");
  assert.equal(plan.preset.id, "web-app");
  assert.match(plan.project_config_preview, /coordTicketPrefix/);
  assert.match(renderOnboardPlan(plan), /Concord Onboarding Plan/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboard write uses no-clobber setup artifacts", () => {
  const root = tmpRoot();
  const plan = buildOnboardPlan(root);
  const written = writeOnboardArtifacts(plan);
  assert.deepEqual(written.sort(), ["coord/project.config.js", "coord/setup.decisions.json"].sort());
  assert.throws(() => writeOnboardArtifacts(plan), /refusing to overwrite/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboard args default to dry-run and accept explicit write/json", () => {
  assert.deepEqual(parseArgs(["/tmp/repo", "--json"]), { dryRun: true, write: false, force: false, repo: "/tmp/repo", json: true });
  assert.equal(parseArgs(["/tmp/repo", "--write"]).dryRun, false);
});
