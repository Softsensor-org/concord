"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolvePromptPath } = require("./prompt-paths.js");
const { fixedLayoutEnv } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/session-lifecycle-test-utils.js"));
const { runFixtureReconcile } = require("./__fixtures__/approval-fixture.js");
const { withApprovedPacket } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/fixtures/approved-reconcile.js"));

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test("COORD-758: canonical namespace is deterministic, explicit paths stay caller-selected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-path-unit-"));
  try {
    const cwd = path.join(root, "coord", "nested"); fs.mkdirSync(cwd, { recursive: true });
    const options = { workspaceRoot: root, cwd, ticketId: "TEST-001" };
    const ref = "coord/prompts/tickets/TEST-001.md";
    assert.equal(resolvePromptPath(ref, options).absPath, path.join(root, ref));
    assert.equal(resolvePromptPath(undefined, options).relPath, ref);
    assert.equal(resolvePromptPath(ref.replaceAll("/", "\\"), options).relPath, ref);
    for (const relative of ["./coord/prompts/selected.md", "../selected.md", "other.md", "coord/prompts-other/file.md"]) {
      assert.equal(resolvePromptPath(relative, options).absPath, path.resolve(cwd, relative));
    }
    assert.throws(() => resolvePromptPath("coord/prompts/../../outside.md", options), /escapes/);
    assert.throws(() => resolvePromptPath("   ", options), /blank/);
    const decoy = path.join(cwd, ref); write(decoy, "decoy");
    assert.throws(() => resolvePromptPath(ref, options), /Ambiguous/, "missing canonical target never selects decoy");
    write(path.join(root, ref), "canonical");
    assert.throws(() => resolvePromptPath(ref, { ...options, force: true }), /Ambiguous/);
    assert.equal(resolvePromptPath(`./${ref}`, options).absPath, decoy);
    assert.equal(resolvePromptPath(path.join(root, ref), options).relPath, ref);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function cliFixture(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `prompt-cli-${layout}-`));
  const coord = path.join(root, "coord"); fs.mkdirSync(coord);
  require(resolveEngineModule(COORD_ROOT_DIR, "scripts/fixtures/coord-engine-schemas.js")).installCanonicalEngine(coord, path.resolve(__dirname, "..", ".."));
  const source = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "engine", "board", "paths.js", "GOVERNANCE.md", "AGENTS.md", "product", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  write(path.join(coord, "project.config.js"), 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  fs.mkdirSync(path.join(root, "backend"));
  const columns = ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"];
  write(path.join(coord, "board/tasks.json"), JSON.stringify({ version: 1,
    metadata: { title: "Prompt cwd fixture", last_updated: new Date().toISOString(), canonical_references: [], preamble: [] },
    sections: [{ kind: "table", level: 2, heading: "Tickets", separator_before: false, columns, rows: [] }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} }));
  write(path.join(coord, "QUESTIONS.md"), "# Questions\n");
  write(path.join(coord, "PLAN.md"), "");
  write(path.join(coord, ".gitignore"), ".runtime/\n.worktrees/\n");
  const gitRoot = layout === "donor" ? root : coord;
  const git = (...args) => {
    const r = spawnSync("git", ["-C", gitRoot, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  git("add", "."); git("commit", "-m", "Seed isolated prompt fixture");
  const env = fixedLayoutEnv(`prompt-${path.basename(root)}`);
  const cli = (cwd, ...args) => spawnSync("bash", [path.join(coord, "scripts/gov"), ...args],
    { cwd, env, encoding: "utf8", timeout: 30000 });
  const ok = (cwd, ...args) => {
    const r = args[0] === "reconcile" && args.includes("--human-admin-override")
      ? runFixtureReconcile(() => cli(cwd, ...args), (approval) =>
        approval.runCli(coord, args, { cwd, env, encoding: "utf8", timeout: 30000 }))
      : cli(cwd, ...args);
    assert.equal(r.status, 0, `${layout} ${cwd}: ${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`);
    return r;
  };
  ok(root, ...withApprovedPacket(["reconcile", "--reason", "initialize disposable CLI fixture", "--human-admin-override", "fixture administrator approves isolated synthetic baseline"], (args) => ok(root, ...args)));
  ok(root, "agentid", "--assign");
  const board = () => JSON.parse(fs.readFileSync(path.join(coord, "board/tasks.json"), "utf8"));
  return { root, coord, cli, ok, board, git };
}

for (const layout of ["donor", "independent"]) {
  test(`COORD-758: public CLI cwd and no-write path contracts in ${layout} layout`, { timeout: 90000 }, () => {
    const f = cliFixture(layout);
    try {
      const nested = path.join(f.coord, "nested", "deeper"); fs.mkdirSync(nested, { recursive: true });
      const file = (cwd, id, ...extra) => f.ok(cwd, "file-ticket", id, "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Path fixture", ...extra);
      const adrDir = path.join(f.coord, "docs", "decisions");
      const adrPaths = JSON.parse(f.ok(f.root, "adr", "list", "--json").stdout).map(row => row.path);
      for (const [i, cwd] of [f.root, f.coord, nested].entries()) {
        const id = `PATH-00${i + 1}`, ref = `coord/prompts/tickets/${id}.md`;
        file(cwd, id, "--with-prompt");
        assert.equal(f.board().prompt_index[id], ref);
        assert.ok(fs.statSync(path.join(f.root, ref)).isFile());
        const before = fs.readFileSync(path.join(f.coord, "board/tasks.json"));
        f.ok(cwd, "register-prompt", id, "--path", ref);
        assert.deepEqual(fs.readFileSync(path.join(f.coord, "board/tasks.json")), before, "idempotent mapping");
        assert.deepEqual(JSON.parse(f.ok(cwd, "adr", "list", "--json").stdout).map(row => row.path), adrPaths);
        assert.deepEqual(JSON.parse(f.ok(cwd, "adr", "list", "--dir", path.relative(cwd, adrDir), "--json").stdout).map(row => row.path), adrPaths);
      }
      const id = "PATH-003", ref = `coord/prompts/tickets/${id}.md`;
      const snapshot = () => ({ board: fs.readFileSync(path.join(f.coord, "board/tasks.json")),
        canonical: fs.readFileSync(path.join(f.root, ref)), head: f.git("rev-parse", "HEAD"),
        index: f.git("ls-files", "--stage") });
      let before = snapshot();
      const missing = f.cli(nested, "register-prompt", id, "--path", "coord/prompts/missing.md");
      assert.notEqual(missing.status, 0); assert.match(missing.stderr, /prompt file not found/);
      assert.deepEqual(snapshot(), before);
      const decoy = path.join(nested, ref); write(decoy, "decoy must survive\n");
      before = snapshot();
      for (const flags of [[], ["--force"], ["--create", "--force", "--replace"]]) {
        const refused = f.cli(nested, "register-prompt", id, "--path", ref, ...flags);
        assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Ambiguous prompt reference/);
        assert.deepEqual(snapshot(), before); assert.equal(fs.readFileSync(decoy, "utf8"), "decoy must survive\n");
      }
      for (const create of [[], ["--with-prompt"]]) {
        const rejectedFile = f.cli(nested, "file-ticket", "PATH-099", "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Refusal", "--prompt", ref, ...create, "--force");
        assert.notEqual(rejectedFile.status, 0); assert.match(rejectedFile.stderr, /Ambiguous/);
        assert.deepEqual(snapshot(), before);
      }
      const missingReference = f.cli(nested, "file-ticket", "PATH-098", "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Missing reference", "--prompt", "../caller-missing.md");
      assert.notEqual(missingReference.status, 0); assert.match(missingReference.stderr, /points to missing file/);
      assert.deepEqual(snapshot(), before);
      assert.equal(fs.existsSync(path.resolve(nested, "../caller-missing.md")), false);
      write(path.resolve(nested, "../caller.md"), "caller selected prompt\n");
      for (const [suffix, selected] of [["004", `./${ref}`], ["005", "../caller.md"], ["006", path.join(f.root, ref)]]) {
        const ticket = `PATH-${suffix}`;
        file(nested, ticket, "--prompt", selected);
        const abs = path.resolve(nested, selected);
        assert.equal(f.board().prompt_index[ticket], path.relative(f.root, abs).replace(/\\/g, "/"));
        if (suffix === "005") assert.equal(fs.readFileSync(abs, "utf8"), "caller selected prompt\n", "reference-only filing preserves target");
      }
      f.ok(nested, "register-prompt", id, "--path", `./${ref}`, "--force");
      assert.equal(f.board().prompt_index[id], path.relative(f.root, decoy).replace(/\\/g, "/"));
      f.ok(nested, "register-prompt", id, "--path", path.join(f.root, ref), "--force");
      assert.equal(f.board().prompt_index[id], ref);
      file(nested, "PATH-007", "--prompt", "coord/prompts/tickets/PATH-001.md");
      assert.equal(f.board().prompt_index["PATH-007"], "coord/prompts/tickets/PATH-001.md");
      assert.equal(fs.existsSync(path.join(nested, "coord/prompts/tickets/PATH-001.md")), false);
      if (layout === "independent") assert.equal(fs.existsSync(path.join(f.root, ".git")), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const layout of ["donor", "independent"]) {
  test(`COORD-651: public follow-up CLI owns child prompts in ${layout} layout`, { timeout: 90000 }, () => {
    const f = cliFixture(layout);
    try {
      const parent = "FOLLOWUP-001", parentRef = `coord/prompts/tickets/${parent}.md`;
      f.ok(f.root, "file-ticket", parent, "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Parent-specific scope", "--with-prompt");
      const parentBytes = fs.readFileSync(path.join(f.root, parentRef));
      const nested = path.join(f.coord, "nested"); fs.mkdirSync(nested);
      const open = (cwd, id, ...extra) => f.ok(cwd, "open-followup", id, "--depends-on", parent,
        "--repo", "X", "--type", "bug", "--pri", "P1", "--description", "Separate child repair", ...extra);
      for (const [i, cwd] of [f.root, f.coord, nested].entries()) {
        const id = `FOLLOWUP-00${i + 2}`, ref = `coord/prompts/tickets/${id}.md`;
        open(cwd, id);
        assert.equal(f.board().prompt_index[id], ref);
        const text = fs.readFileSync(path.join(f.root, ref), "utf8");
        assert.ok(text.includes(`# ${id}:`)); assert.match(text, /Separate child repair/);
        assert.doesNotMatch(text, /Parent-specific scope/);
      }
      open(nested, "FOLLOWUP-005", "--prompt", parentRef);
      assert.equal(f.board().prompt_index["FOLLOWUP-005"], parentRef);
      assert.deepEqual(fs.readFileSync(path.join(f.root, parentRef)), parentBytes);
      const events = fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8")
        .trim().split("\n").map(JSON.parse).filter(e => e.command === "open-followup");
      assert.equal(events.length, 4);
      assert.deepEqual(events.map(e => e.details.prompt.mode), ["child", "child", "child", "explicit-reference"]);
      assert.deepEqual(events.at(-1).details.prompt.shared_with, [parent]);
      if (layout === "independent") assert.equal(fs.existsSync(path.join(f.root, ".git")), false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}
