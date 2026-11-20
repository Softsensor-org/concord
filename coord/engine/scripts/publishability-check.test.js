"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const {
  buildPublishabilityReport,
  classifyPublishability,
  publishabilityCheckCommand,
  renderPublishability,
  splitFileArgs,
} = require("./publishability-check.js");

test("publishability plan reader ignores empty path entries while retaining declared hygiene surfaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-publishability-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const planDir = path.join(root, "coord", ".runtime", "plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "TEST-809.json"), JSON.stringify({
    intended_files: [null, "", "   ", "coord/scripts/gov"],
    gate_plan: { declared_files: [false, "README.md"], changed_files: [null] },
  }));
  const report = buildPublishabilityReport({ ticketId: "TEST-809", root });
  assert.deepEqual(report.files, ["coord/scripts/gov", "README.md"]);
  assert.equal(report.needs_publishability, true);
  assert.ok(report.commands.includes("release/verify-dual-release.sh"));
});

test("publishability check requires release hygiene for canonical docs and release surfaces", () => {
  const report = buildPublishabilityReport({
    ticketId: "COORD-445",
    files: ["coord/product/TESTING_AND_GATES.md", "release/build-public-release.sh"],
  });
  assert.equal(report.needs_publishability, true);
  assert.ok(report.commands.includes("release/verify-dual-release.sh"));
  assert.match(renderPublishability(report), /Publishability Check/);
});

test("publishability check does not tax unrelated implementation files", () => {
  const result = classifyPublishability(["backend/src/app.js"]);
  assert.equal(result.needs_publishability, false);
  assert.equal(result.commands[0], "No publishability gate required from declared files.");
});

test("publishability check splits comma-separated file args", () => {
  assert.deepEqual(splitFileArgs(["README.md, coord/scripts/gov", "release/build-public-release.sh"]), [
    "README.md",
    "coord/scripts/gov",
    "release/build-public-release.sh",
  ]);
});

test("advertised production LOC command executes the real committed-tree checker", () => {
  const report = classifyPublishability(["coord/scripts/gov"]);
  const command = report.commands.find(command => command.includes("prodloc"));
  assert.equal(command, "node coord/engine/scripts/prodloc-closeout.js");
  const result = spawnSync(process.execPath, [resolveEngineModule(COORD_ROOT_DIR, "scripts/prodloc-closeout.js")], { encoding: "utf8" });
  assert.ok([0, 1].includes(result.status), result.stderr);
  if (result.status === 0) {
    const proof = JSON.parse(result.stdout); assert.equal(proof.result, "pass"); assert.ok(proof.checked > 0);
  } else {
    // A breached committed HEAD is a valid refusal, unlike the former
    // nonexistent --prodloc CLI option. This test does not certify HEAD green.
    assert.match(result.stderr, /prodloc closeout refused:.*measured \d+ LOC, declared budget \d+/s);
  }
});

test("COORD-877: every shipped coord/engine surface and the legacy coord/scripts path require publishability checks", () => {
  for (const file of [
    "coord/engine/scripts/example.js",
    "coord/engine/board/tasks.schema.json",
    "coord/engine/gates/affected-targets.schema.json",
    "coord/engine/vendor/babel-parser/lib/index.js",
    "coord/engine/shim-registry.json",
    "coord/scripts/example.js",
  ]) {
    const result = classifyPublishability([file]);
    assert.equal(result.needs_publishability, true, file);
    assert.ok(result.reasons.includes("engine script surface"), file);
    assert.ok(result.commands.includes("coord/scripts/check-template-sync.sh"), file);
    assert.ok(result.commands.includes("node coord/engine/scripts/prodloc-closeout.js"), file);
  }
});

test("COORD-877: unrelated project files outside coord/engine stay exempt", () => {
  for (const file of ["backend/src/engine/index.js", "frontend/coord/engine/x.js", "coord-engine/scripts/x.js", "coordx/engine/a.js"]) {
    const result = classifyPublishability([file]);
    assert.equal(result.needs_publishability, false, file);
    assert.deepEqual(result.reasons, [], file);
  }
});

test("COORD-877: the report refuses a missing ticket id and renders an exempt report", () => {
  assert.throws(() => buildPublishabilityReport({ files: ["README.md"] }), /requires a ticket id/);
  const report = buildPublishabilityReport({ ticketId: "TEST-877", files: ["backend/src/app.js"] });
  const text = renderPublishability(report);
  assert.match(text, /Required: no/);
  assert.match(text, /## Reasons\n- none\n/);
  assert.match(text, /- `No publishability gate required from declared files\.`/);
});

test("COORD-877: the command prints JSON or markdown for the same report", (t) => {
  const chunks = [];
  t.mock.method(console, "log", (value) => chunks.push(`json:${value}`));
  t.mock.method(process.stdout, "write", (value) => { chunks.push(`text:${value}`); return true; });
  const asJson = publishabilityCheckCommand("TEST-877", { json: true, files: "coord/engine/scripts/example.js" });
  const asText = publishabilityCheckCommand("TEST-877", { files: ["coord/engine/scripts/example.js"] });
  t.mock.restoreAll();
  assert.deepEqual(asJson, asText);
  assert.equal(asJson.needs_publishability, true);
  assert.deepEqual(JSON.parse(chunks[0].slice("json:".length)), asJson);
  assert.match(chunks[1], /^text:# Publishability Check\n/);
  assert.match(chunks[1], /Required: yes/);
});
