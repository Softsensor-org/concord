"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const createCommands = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle-maintenance-commands.js"));

function git(root, ...args) {
  const result = gitFixtureSpawn(root, args);
  assert.equal(result.status, 0, result.stderr);
}
function init(root) {
  fs.mkdirSync(root, { recursive: true });
  gitFixture(root, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
}
function observe(roots, options = {}) {
  const queries = [], bases = [], output = [];
  const board = { rows: [{ ID: "F-001", Repo: "F", Status: "todo" }], landing_index: {} };
  const before = JSON.stringify(board);
  const commands = createCommands({
    REPO_ROOTS: roots, readBoard: () => board, getRows: b => b.rows,
    isRepoBackedCode: () => true, getRepoRoot: code => roots[code],
    resolveRepoIntegrationBranch: code => { bases.push(code); return "main"; },
    ghPrListMergedByBase: root => { queries.push(root); return []; },
    isCommitAncestorOfRef: () => true, fail: message => { throw new Error(message); },
  });
  const log = console.log;
  try { console.log = value => output.push(value); commands.reconcileLandings(options); }
  finally { console.log = log; }
  assert.equal(JSON.stringify(board), before, "read-only consumer must preserve board");
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.read_only, true);
  assert.equal(report.mutation, "none");
  return { report, queries, bases };
}

test("COORD-762: real reconciliation skips nested/missing roots but queries independent and linked worktrees", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "concord-reconcile-boundary-")));
  try {
    const donor = path.join(root, "donor"), nested = path.join(donor, "backend");
    const independent = path.join(root, "product"), linked = path.join(root, "linked"), missing = path.join(root, "missing");
    init(donor); fs.mkdirSync(nested); init(independent);
    git(independent, "worktree", "add", "-b", "fixture-linked", linked);
    const result = observe({ X: donor, B: nested, F: independent, Z: linked, N: missing });
    assert.deepEqual(result.queries, [independent, linked]);
    assert.deepEqual(result.bases, ["F", "Z"], "do not inherit the enclosing repo base either");
    assert.deepEqual(result.report.reports.map(r => [r.repo, r.status]), [
      ["B", "not_independent_repository"], ["F", "observed"], ["Z", "observed"], ["N", "not_independent_repository"],
    ]);
    for (const row of result.report.reports.filter(r => r.status === "not_independent_repository")) {
      assert.equal(row.base_ref, null);
      assert.equal(row.entries, undefined, "unsupported roots carry no fabricated PR observations");
      assert.match(row.error, /independent Git/);
    }
    const scoped = observe({ B: nested, F: independent }, { repo: "B" });
    assert.deepEqual(scoped.queries, []);
    assert.deepEqual(scoped.bases, []);
    assert.equal(scoped.report.reports.length, 1);
    assert.equal(scoped.report.reports[0].status, "not_independent_repository");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
