"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixedLayoutEnv } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/session-lifecycle-test-utils.js"));
const { withApprovedPacket } = require("./fixtures/approved-reconcile.js");

const { runFixtureReconcile } = require("../engine/scripts/__fixtures__/approval-fixture.js");

function fixture(t, layout) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "concord-sync-board-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord"); fs.mkdirSync(coord);
  require("./fixtures/coord-engine-schemas.js").installCanonicalEngine(coord, path.resolve(__dirname, ".."));
  const source = path.resolve(__dirname, "..");
  for (const name of ["scripts", "engine", "board", "paths.js", "GOVERNANCE.md", "AGENTS.md", "product", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  const write = (name, text) => { const file = path.join(coord, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write("project.config.js", 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  fs.mkdirSync(path.join(root, "backend"));
  write("board/tasks.json", JSON.stringify({ version: 1,
    metadata: { title: "Sync fixture", last_updated: new Date().toISOString(), canonical_references: [], preamble: [] },
    sections: [{ kind: "table", level: 2, heading: "Tickets", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [] }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} }));
  write("QUESTIONS.md", "# Questions\n"); write("PLAN.md", "");
  write(".gitignore", ".runtime/*\n!.runtime/governance-events.ndjson\n!.runtime/plans/\n.worktrees/\n");
  const gitRoot = layout === "donor" ? root : coord;
  const gitAt = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const git = (...args) => gitAt(gitRoot, ...args);
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  // COORD-850: the ~1000-object seed commit makes Git >= 2.5x start a detached
  // geometric repack whose loose-object pruning raced the `clone --no-hardlinks`
  // copy below ("failed to copy file ... No such file or directory") and the
  // fixture cleanup. Keep maintenance enabled but inside each command's lifetime.
  git("config", "maintenance.autoDetach", "false"); git("config", "gc.autoDetach", "false");
  git("add", "."); git("commit", "-m", "Seed isolated sync fixture");
  const env = fixedLayoutEnv(`sync-${path.basename(root)}`);
  const cli = (...args) => spawnSync("bash", [path.join(coord, "scripts/gov"), ...args],
    { cwd: root, env, encoding: "utf8", timeout: 30000 });
  const ok = (...args) => {
    const r = cli(...args); assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`); return r;
  };
  const reconcile = withApprovedPacket(["reconcile", "--reason", "initialize disposable sync fixture",
    "--human-admin-override", "fixture administrator approves isolated baseline"], (args) => ok(...args));
  const signed = runFixtureReconcile(() => cli(...reconcile), (approval) =>
    approval.runCli(coord, reconcile, { cwd: root, env, encoding: "utf8", timeout: 30000 }));
  assert.equal(signed.status, 0, signed.stderr);
  ok("agentid", "--assign"); ok("sync", "--commit", "Commit fixture baseline");
  return { root, coord, gitRoot, git, gitAt, cli, ok, prefix: layout === "donor" ? "coord/" : "" };
}

for (const layout of ["donor", "independent"]) {
  test(`COORD-533: actual standalone sync publishes board and view together in ${layout} layout`, { timeout: 90000 }, t => {
    const f = fixture(t, layout), ticket = "TEST-533";
    f.ok("file-ticket", ticket, "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Authoritative source publication proof");
    fs.writeFileSync(path.join(f.gitRoot, "unrelated.txt"), "preserve staged work\n");
    f.git("add", "unrelated.txt");
    const sync = f.ok("sync", "--commit", "Publish governed ticket source and view");
    const summary = JSON.parse(sync.stdout);
    const clone = path.join(f.root, "fresh-clone");
    f.gitAt(f.root, "clone", "--quiet", "--no-hardlinks", f.gitRoot, clone);
    const boardRel = `${f.prefix}board/tasks.json`, viewRel = `${f.prefix}rendered/TASKS.md`;
    const published = JSON.parse(fs.readFileSync(path.join(clone, boardRel), "utf8"));
    assert(published.sections.flatMap(s => s.rows || []).some(r => r.ID === ticket),
      "fresh clone must contain the authoritative row, not just its rendered view");
    assert.match(fs.readFileSync(path.join(clone, viewRel), "utf8"), /TEST-533/);
    assert(summary.canonical_paths.includes("board/tasks.json"), "actual canonical scope includes board source");
    const committed = f.git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    for (const name of [boardRel, viewRel, `${f.prefix}.runtime/governance-events.ndjson`]) assert(committed.includes(name), name);
    assert.equal(f.git("status", "--porcelain", "--", boardRel), "");
    assert.equal(fs.existsSync(path.join(clone, "unrelated.txt")), false);
    assert.equal(f.git("diff", "--cached", "--name-only"), "unrelated.txt", "unrelated index state survives");
    // Expanding commit scope must not turn sync into a manual-board-edit bypass.
    const current = JSON.parse(fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8"));
    current.sections.flatMap(s => s.rows || []).find(r => r.ID === ticket).Description = "Unapproved manual edit";
    fs.writeFileSync(path.join(f.coord, "board/tasks.json"), JSON.stringify(current));
    const head = f.git("rev-parse", "HEAD");
    const refused = f.cli("sync", "--commit", "Must refuse manual board drift");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /out-of-band|unapproved governance drift/);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(f.git("diff", "--cached", "--name-only"), "unrelated.txt");
  });
}
