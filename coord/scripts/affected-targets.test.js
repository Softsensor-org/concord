"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const affected = require("./affected-targets.js");
const { dispatch } = require("./coord-cli.js");

const MAP = {
  full_gate: { commands: ["node --test"] },
  targets: [
    {
      id: "unit:token-economics",
      command: "node --test coord/scripts/token-economics.test.js",
      files: ["coord/scripts/token-economics.js", "coord/scripts/token-economics.test.js"],
    },
    {
      id: "contract:dispatch",
      command: "node --test coord/scripts/dispatch.test.js",
      files: ["coord/scripts/dispatch.mjs", "coord/scripts/dispatch.test.js"],
      depends_on: ["unit:token-economics"],
    },
    {
      id: "docs:gates",
      command: "node --test coord/scripts/command-registry.test.js",
      files: ["coord/product/TESTING_AND_GATES.md"],
    },
  ],
};

test("affected-target selector returns direct and transitive targets", () => {
  const result = affected.selectAffectedTargets({
    files: ["coord/scripts/token-economics.js"],
    map: MAP,
  });
  assert.equal(result.mode, "slice");
  assert.deepEqual(result.selected.map((target) => target.id), ["unit:token-economics", "contract:dispatch"]);
  assert.deepEqual(result.skipped.map((target) => target.id), ["docs:gates"]);
  assert.equal(result.unknown_files.length, 0);
  assert.match(result.selected[1].reason, /transitive/);
});

test("affected-target selector falls back to full for unknown changed files", () => {
  const result = affected.selectAffectedTargets({
    files: ["unknown/system/file.js"],
    map: MAP,
  });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /unknown changed file/);
  assert.deepEqual(result.selected.map((target) => target.command), ["node --test"]);
  assert.deepEqual(result.unknown_files, ["unknown/system/file.js"]);
});

test("affected-target selector falls back to full for missing maps", () => {
  const result = affected.selectAffectedTargets({
    files: ["coord/scripts/token-economics.js"],
    map: null,
  });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /missing or empty dependency map/);
  assert.deepEqual(result.selected.map((target) => target.command), [affected.DEFAULT_FULL_COMMAND]);
});

test("affected-target selector honors explicit full override", () => {
  const result = affected.selectAffectedTargets({
    files: ["coord/scripts/token-economics.js"],
    map: MAP,
    full: true,
  });
  assert.equal(result.mode, "full");
  assert.equal(result.reason, "explicit full override");
  assert.equal(result.selected[0].command, "node --test");
});

test("affected-target command reads a map and emits JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "affected-targets-"));
  const mapPath = path.join(dir, "map.json");
  fs.writeFileSync(mapPath, JSON.stringify(MAP, null, 2), "utf8");
  const lines = [];
  const result = affected.run(
    ["--files", "coord/scripts/token-economics.js", "--map", mapPath, "--json"],
    { cwd: dir, log: (line) => lines.push(String(line)) }
  );
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join(""));
  assert.equal(parsed.mode, "slice");
  assert.deepEqual(parsed.selected.map((target) => target.id), ["unit:token-economics", "contract:dispatch"]);
});

test("affected-target map validation rejects duplicate ids and unknown deps", () => {
  const result = affected.validateAffectedTargetMap({
    full_gate: { commands: ["node --test"] },
    targets: [
      { id: "unit", command: "node --test a.test.js", files: ["a.js"] },
      { id: "unit", command: "node --test b.test.js", files: ["b.js"], depends_on: ["missing"] },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "target_duplicate"));
  assert.ok(result.issues.some((issue) => issue.code === "target_dep"));
});

test("affected-target map validation detects dependency cycles", () => {
  const result = affected.validateAffectedTargetMap({
    full_gate: { commands: ["node --test"] },
    targets: [
      { id: "a", command: "node --test a.test.js", files: ["a.js"], depends_on: ["b"] },
      { id: "b", command: "node --test b.test.js", files: ["b.js"], depends_on: ["a"] },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "target_dep_cycle"));
});

test("affected-target map validation warns on stale maps", () => {
  const result = affected.validateAffectedTargetMap(MAP, {
    requireUpdatedAt: true,
    now: "2026-06-28T00:00:00.000Z",
    staleAfterDays: 1,
  });
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((issue) => issue.code === "map_freshness"));
});

test("product CLI routes affected-targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "affected-targets-cli-"));
  const mapPath = path.join(dir, "map.json");
  fs.writeFileSync(mapPath, JSON.stringify(MAP, null, 2), "utf8");
  const lines = [];
  const result = dispatch(
    ["affected-targets", "--files", "coord/product/TESTING_AND_GATES.md", "--map", mapPath, "--json"],
    { cwd: dir, log: (line) => lines.push(String(line)) }
  );
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join(""));
  assert.equal(parsed.mode, "slice");
  assert.deepEqual(parsed.selected.map((target) => target.id), ["docs:gates"]);
});
