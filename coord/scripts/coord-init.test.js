"use strict";

// COORD-477: behavior tests for the PRODUCT-facing `coord init` bootstrap and
// the consent-based unborn-root Git bootstrap contract it participates in.
//
// `coord init` itself is git-free by construction — it scaffolds the
// project-owned config/board/spec seams and never touches Git. The Git side of
// bootstrap (root init / managed ignore block / exact-allowlist staging /
// separately-consented baseline commit) lives in the shared install engine
// (create-concord/lib/install-plan.js) and is integration-proven here: from an
// UNBORN workspace root, through the consented baseline commit, to the first
// governed worktree cut from the product repo's configured
// origin/<integrationBranch> — without fabricating any product-repo history.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const createCoordInit = require("./coord-init.js");

// COORD-670: this file no longer reaches for create-concord/lib/install-plan.js.
// That package is stripped from every published cut, so the engine-backed
// integration test that used to live here shipped into artifacts that could not
// run it and silently skipped itself. It now lives on a donor-only root, where it
// runs unconditionally: create-concord/coord-init-git-bootstrap.test.js.
//
// What remains below is the PRODUCT-facing `coord init` contract, which is
// git-free by construction and needs no install engine — so it genuinely holds in
// every cut.

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------
// coord init: git-free, no-clobber, idempotent
// ---------------------------------------------------------------------------

test("COORD-477: coord init never invokes Git or any subprocess (source-level guarantee)", () => {
  const source = fs.readFileSync(path.join(__dirname, "coord-init.js"), "utf8");
  for (const banned of ["child_process", "execFileSync", "execSync", "spawnSync", "spawn("]) {
    assert.equal(source.includes(banned), false, `coord-init.js must not reference ${banned}`);
  }
});

test("COORD-477: coord init --dry-run writes nothing and a real run creates no Git state", () => {
  const root = tmpDir("coord-init-477-");
  try {
    const logs = [];
    const init = createCoordInit({ log: (line) => logs.push(line), cwd: () => root });
    const dry = init.run(["--dry-run"]);
    assert.equal(dry.ok, true);
    assert.deepEqual(fs.readdirSync(root), [], "dry run writes nothing");

    const real = init.run([]);
    assert.equal(real.ok, true);
    assert.equal(fs.existsSync(path.join(root, "coord", "project.config.js")), true);
    assert.equal(fs.existsSync(path.join(root, "coord", "board", "tasks.json")), true);
    // The product-facing bootstrap performs no Git mutation of any kind.
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    assert.equal(fs.existsSync(path.join(root, "coord", ".git")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-477: coord init is idempotent and no-clobber on a populated target", () => {
  const root = tmpDir("coord-init-477-idem-");
  try {
    const init = createCoordInit({ log: () => {}, cwd: () => root });
    init.run([]);
    const configPath = path.join(root, "coord", "project.config.js");
    fs.writeFileSync(configPath, "// adopter-owned\nmodule.exports = { coordTicketPrefix: \"APP\", repos: {} };\n");
    const rerun = init.run([]);
    assert.equal(rerun.ok, true);
    assert.equal(rerun.actions.every((a) => a.action === "skip"), true, "second run skips everything");
    assert.match(fs.readFileSync(configPath, "utf8"), /adopter-owned/, "existing files are never overwritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
