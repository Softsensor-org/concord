"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { canonicalSyncablePaths } = require("./state-io.js");

const ROOT = path.resolve(__dirname, "../../..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

test("COORD-485: documented durable evidence agrees with Git ignores and canonical sync", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-policy-485-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "coord"));
  for (const file of [".gitignore", "coord/.gitignore"]) {
    fs.writeFileSync(path.join(root, file), read(file));
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
  const initialized = git("init", "--quiet");
  assert.equal(initialized.status, 0, initialized.stderr);

  const durable = [".runtime/governance-events.ndjson", ".runtime/plans/COORD-1.json"];
  const local = [
    ".runtime/governance-latest-snapshot.json",
    ".runtime/governance-snapshots/snapshot.json",
    ".runtime/locks/COORD-1.lock",
    ".runtime/agent_sessions.json",
  ];
  for (const file of [...durable, ...local]) {
    const target = path.join(root, "coord", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}\n");
    const result = git("check-ignore", "--no-index", "--quiet", `coord/${file}`);
    assert.equal(result.status, durable.includes(file) ? 1 : 0, `${file}: ${result.stderr}`);
  }

  const sync = canonicalSyncablePaths();
  assert.ok(sync.includes(".runtime/governance-events.ndjson"));
  assert.ok(sync.includes(".runtime/plans"));
  for (const file of local) {
    assert.equal(sync.some((entry) => file === entry || file.startsWith(`${entry}/`)), false,
      `${file} must not enter a normal durable sync`);
  }

  const directory = read("coord/DIRECTORY.md");
  const tracked = directory.split("**Tracked (durable evidence")[1].split("**Local recovery")[0];
  assert.match(tracked, /governance-events\.ndjson/);
  assert.match(tracked, /\.runtime\/plans\/\*\.json/);
  assert.doesNotMatch(tracked, /governance-(?:latest-snapshot|snapshots)/);
  assert.match(directory, /local recovery snapshots/i);
  assert.match(read("coord/GOVERNANCE.md"), /Journal and plan records are tracked durable evidence/);
});

test("COORD-485: orientation cannot authorize hand-authored backlog rows", () => {
  const directory = read("coord/DIRECTORY.md");
  assert.match(directory, /Create backlog rows with `gov file-ticket`/);
  assert.match(directory, /never hand-edit the board/);
  assert.doesNotMatch(directory, /new backlog rows may be hand-authored/);
});

test("COORD-485: configured integration branches agree with the approved promotion policy", () => {
  const config = require(path.join(ROOT, "coord/project.config.js"));
  const governance = read("coord/GOVERNANCE.md");
  const policy = governance.split("## 7.1) Branch Promotion Model")[1].split("## 7.2)")[0];
  assert.match(policy, /ticket branches land on `dev`/);
  // COORD-1026 / ADR 0028 (accepted): the replacement 7.1 names the promoted branches in order and the promotion verb.
  assert.match(policy, /promoted branches, in order: `staging`, then `main`/);
  assert.match(policy, /only through the governed promotion verb/);
  for (const [code, repo] of Object.entries(config.repos)) {
    assert.equal(repo.integrationBranch, "dev", `${code} must use the integration branch approved by the shipped policy`);
  }
  for (const name of ["README.md", "USER_MANUAL.md"]) {
    assert.doesNotMatch(read(name), /integrationBranch:\s*["']main["']/,
      `${name} must not teach a configuration that contradicts the shipped policy`);
  }
});
