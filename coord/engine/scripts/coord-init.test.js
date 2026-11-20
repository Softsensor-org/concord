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
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const { dispatch } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
const { createInstallerGovernance } = require("./installer-governance.js");

test("COORD-678: fresh own-engine init materializes views before genesis and preserves existing view bytes", () => {
  for (const existing of [false, true]) {
    const root = tmpDir("coord678-init-");
    const target = path.join(root, "coord");
    const source = COORD_ROOT_DIR;
    try {
      fs.mkdirSync(target);
      for (const name of ["scripts", "engine", "board", "paths.js", "schemas", "agents.json"]) {
        if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
      }
      fs.rmSync(path.join(target, "board/tasks.json"), { force: true });
      fs.rmSync(path.join(target, "board/plans"), { force: true, recursive: true });
      const retained = path.join(target, "PLAN.md");
      if (existing) fs.writeFileSync(retained, "Adopter-owned projection bytes\n");
      const env = { ...process.env };
      delete env.COORD_PROJECT_CONFIG;
      execFileSync(process.execPath, ["-e", "require(process.argv[1])().run([])", path.join(target, "engine/scripts/coord-init.js")], { cwd: root, env, encoding: "utf8" });
      if (existing) {
        assert.equal(fs.readFileSync(retained, "utf8"), "Adopter-owned projection bytes\n");
        assert.equal(fs.existsSync(path.join(target, "rendered/TASKS.md")), false, "init must not partially overwrite existing projection state");
      } else {
        for (const file of ["rendered/TASKS.md", "rendered/PROMPT_INDEX.md", "TASKS.md", "PROMPT_INDEX.md"]) {
          const text = fs.readFileSync(path.join(target, file), "utf8");
          assert.match(text, /SETUP-001/);
          assert.match(text, /SETUP-009/);
        }
        assert.equal(fs.readFileSync(retained, "utf8"), "");
        const events = fs.readFileSync(path.join(target, ".runtime/governance-events.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(events[0].command, "journal-baseline");
        const before = fs.readFileSync(path.join(target, "rendered/TASKS.md"));
        execFileSync(process.execPath, ["-e", "require(process.argv[1])().run([])", path.join(target, "engine/scripts/coord-init.js")], { cwd: root, env, encoding: "utf8" });
        assert.deepEqual(fs.readFileSync(path.join(target, "rendered/TASKS.md")), before);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("COORD-678: own-engine journal genesis executes in-process after rendering projections", () => {
  const nodeFs = require("node:fs");
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const paths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const projected = [paths.renderedTasksMdPath, paths.renderedPromptIndexMdPath,
    paths.tasksMdPath, paths.promptIndexMdPath, paths.planPath].map((file) => path.resolve(file));
  const originalExists = nodeFs.existsSync;
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  const events = [];
  const logs = [];
  nodeFs.existsSync = (file) => projected.includes(path.resolve(String(file))) ? false : originalExists.call(nodeFs, file);
  boardModule.renderBoardArtifacts = () => { events.push("render"); };
  try {
    const init = createCoordInit({
      cwd: () => workspaceRoot,
      fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
      log: (line) => logs.push(String(line)),
      anchorJournalBaseline: () => { events.push("anchor"); },
    });
    const result = init.run([]);
    assert.equal(result.ok, true);
    assert.deepEqual(events, ["render", "anchor"], "projection rendering must precede journal genesis");
    assert.ok(logs.some((line) => /journal genesis for the starter board/.test(line)));
  } finally {
    nodeFs.existsSync = originalExists;
    boardModule.renderBoardArtifacts = originalRender;
  }
});

test("COORD-818: own-engine init uses the default journal-baseline anchor when no override is supplied", () => {
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const paths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const projected = [paths.renderedTasksMdPath, paths.renderedPromptIndexMdPath,
    paths.tasksMdPath, paths.promptIndexMdPath, paths.planPath].map((file) => path.resolve(file));
  const originalExists = fs.existsSync;
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  const lifecycle = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
  const originalAnchor = lifecycle.ensureGovernanceJournalBaseline;
  const events = [];
  fs.existsSync = (file) => projected.includes(path.resolve(String(file))) ? false : originalExists.call(fs, file);
  boardModule.renderBoardArtifacts = () => { events.push("render"); };
  lifecycle.ensureGovernanceJournalBaseline = (reason) => { events.push(`anchor:${reason}`); };
  try {
    const init = createCoordInit({
      cwd: () => workspaceRoot,
      fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
      log: () => {},
    });
    const result = init.run([]);
    assert.equal(result.ok, true);
    assert.deepEqual(events, ["render", "anchor:coord-init-starter-board"]);
  } finally {
    fs.existsSync = originalExists;
    boardModule.renderBoardArtifacts = originalRender;
    lifecycle.ensureGovernanceJournalBaseline = originalAnchor;
  }
});

test("COORD-678: own-engine init preserves existing projections and reports genesis failure for doctor", () => {
  const nodeFs = require("node:fs");
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const paths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const retained = path.resolve(paths.renderedTasksMdPath);
  const originalExists = nodeFs.existsSync;
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  const logs = [];
  let rendered = false;
  nodeFs.existsSync = (file) => path.resolve(String(file)) === retained ? true : originalExists.call(nodeFs, file);
  boardModule.renderBoardArtifacts = () => { rendered = true; };
  try {
    const init = createCoordInit({
      cwd: () => workspaceRoot,
      fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
      log: (line) => logs.push(String(line)),
      anchorJournalBaseline: () => { throw new Error("fixture baseline refusal"); },
    });
    assert.equal(init.run([]).ok, true);
    assert.equal(rendered, false, "one existing projection prevents partial replacement");
    assert.ok(logs.some((line) => /could not anchor the journal genesis: fixture baseline refusal/.test(line)));
    assert.ok(logs.some((line) => /run `coord\/scripts\/gov doctor`/.test(line)));
  } finally {
    nodeFs.existsSync = originalExists;
    boardModule.renderBoardArtifacts = originalRender;
  }
});

// COORD-835 (review finding 1): `coord init` recreating a lost board must not
// anchor a journal genesis over coordination state that predates it. Hermetic
// copy of this engine, as in the COORD-678 test above.
function copyEngine(root) {
  const target = path.join(root, "coord");
  const source = COORD_ROOT_DIR;
  fs.mkdirSync(target);
  for (const name of ["scripts", "engine", "board", "paths.js", "schemas", "agents.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
  }
  fs.rmSync(path.join(target, "board/tasks.json"), { force: true });
  fs.rmSync(path.join(target, "board/plans"), { force: true, recursive: true });
  return target;
}

function runCopiedInit(root, target) {
  const env = { ...process.env };
  delete env.COORD_PROJECT_CONFIG;
  try {
    const stdout = execFileSync(process.execPath, ["-e", "process.exitCode = require(process.argv[1])().run([]).code",
      path.join(target, "engine/scripts/coord-init.js")], { cwd: root, env, encoding: "utf8" });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

test("COORD-835: init over lost journal + board refuses to baseline existing plan records or decision records", () => {
  const seeds = {
    "plan record": (target) => {
      fs.mkdirSync(path.join(target, ".runtime/plans"), { recursive: true });
      fs.writeFileSync(path.join(target, ".runtime/plans/COORD-1.json"), "{\"ticket\":\"COORD-1\",\"tampered\":true}\n");
    },
    "decision record on an empty board": (target) => {
      fs.mkdirSync(path.join(target, "docs/decisions"), { recursive: true });
      fs.writeFileSync(path.join(target, "docs/decisions/0001-existing.md"), "# ADR 0001: Existing\n\nTAMPERED\n");
    },
  };
  for (const [label, seed] of Object.entries(seeds)) {
    const root = tmpDir("coord835-init-");
    try {
      const target = copyEngine(root);
      seed(target);
      const result = runCopiedInit(root, target);
      assert.equal(result.code, 1, `${label}: init must exit non-zero\n${result.stdout}`);
      assert.match(result.stdout, /refuse {2}journal genesis NOT anchored/, label);
      assert.match(result.stdout, /gov reconcile --reason "<why>" --dry-run/, `${label}: names the dry run`);
      assert.match(result.stdout, /--human-admin-override "<approval for these exact changes>" --expect-paths-file/, `${label}: names the packet-bound reconcile`);
      assert.doesNotMatch(result.stdout, /Next: edit coord\/project.config.js/, label);
      assert.equal(fs.existsSync(path.join(target, ".runtime/governance-events.ndjson")), false, `${label}: no genesis written`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// COORD-835 (review question at 38b6bf64): the refusal must land BEFORE init
// writes the starter board, or a later packet-bound reconcile adopts that empty
// board instead of whatever state survived.
function snapshotTree(dir) {
  const entries = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(dir, abs);
      if (entry.isDirectory()) { entries[`${rel}/`] = "dir"; walk(abs); }
      else entries[rel] = fs.readFileSync(abs).toString("base64");
    }
  };
  walk(dir);
  return entries;
}

test("COORD-835: init over a lost board with surviving plans and ADRs refuses before writing any file", () => {
  const root = tmpDir("coord835-init-nowrite-");
  try {
    const target = copyEngine(root);
    fs.mkdirSync(path.join(target, ".runtime/plans"), { recursive: true });
    fs.writeFileSync(path.join(target, ".runtime/plans/COORD-1.json"), "{\"ticket\":\"COORD-1\"}\n");
    fs.mkdirSync(path.join(target, "docs/decisions"), { recursive: true });
    fs.writeFileSync(path.join(target, "docs/decisions/0001-existing.md"), "# ADR 0001: Existing\n");
    const before = snapshotTree(root);
    const result = runCopiedInit(root, target);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(fs.existsSync(path.join(target, "board/tasks.json")), false, "no starter board");
    assert.deepEqual(snapshotTree(root), before, "the tree is byte-identical after the refusal");
    assert.match(result.stdout, /refuse {2}journal genesis NOT anchored/);
    assert.match(result.stdout, /gov reconcile --reason "<why>" --dry-run/);
    assert.match(result.stdout, /--human-admin-override "<approval for these exact changes>" --expect-paths-file/);
    assert.doesNotMatch(result.stdout, /Created \d+ file/);
    assert.doesNotMatch(result.stdout, /Next: edit coord\/project.config.js/);
    assert.match(result.stdout, /no files written/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-835: init recreating a board under an intact journal stays a no-op anchor, and a fresh copy still initializes", () => {
  const root = tmpDir("coord835-init-intact-");
  try {
    const target = copyEngine(root);
    assert.equal(runCopiedInit(root, target).code, 0, "a genuinely fresh copy initializes");
    const log = path.join(target, ".runtime/governance-events.ndjson");
    const before = fs.readFileSync(log, "utf8");
    assert.equal(before.trim().split("\n").length, 1);
    fs.rmSync(path.join(target, "board/tasks.json"));
    const rerun = runCopiedInit(root, target);
    assert.equal(rerun.code, 0, rerun.stdout);
    assert.equal(fs.readFileSync(log, "utf8"), before, "the existing baseline is kept, no second genesis");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-835: init exempts only the decision records an install ownership manifest recorded byte for byte", () => {
  const sha256 = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const shipped = "# ADR 0001: Shipped\n";
  const scenarios = [
    { label: "shipped ADR and README, unchanged", files: { "0001-shipped.md": shipped, "README.md": "# Shipped index\n" }, owned: ["0001-shipped.md", "README.md"], code: 0 },
    { label: "shipped ADR tampered after install", files: { "0001-shipped.md": `${shipped}TAMPERED\n` }, owned: ["0001-shipped.md"], code: 1 },
    { label: "ADR the install never shipped", files: { "0001-shipped.md": shipped, "0002-added.md": "# ADR 0002\n" }, owned: ["0001-shipped.md"], code: 1 },
  ];
  for (const scenario of scenarios) {
    const root = tmpDir("coord835-init-owned-");
    try {
      const target = copyEngine(root);
      const decisions = path.join(target, "docs/decisions");
      fs.mkdirSync(decisions, { recursive: true });
      const recorded = {};
      for (const [name, body] of Object.entries(scenario.files)) {
        fs.writeFileSync(path.join(decisions, name), body);
        if (scenario.owned.includes(name)) recorded[`coord/docs/decisions/${name}`] = { digest: sha256(name === "0001-shipped.md" ? shipped : body) };
      }
      fs.writeFileSync(path.join(target, ".concord-install-ownership.json"), JSON.stringify({ schema: "concord.install/v2", files: recorded }));
      const result = runCopiedInit(root, target);
      assert.equal(result.code, scenario.code, `${scenario.label}\n${result.stdout}`);
      assert.equal(fs.existsSync(path.join(target, ".runtime/governance-events.ndjson")), scenario.code === 0, scenario.label);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// In-process: the real module against a temp tree standing in for this engine's
// coord root (path-remapped fs), so the pre-write state read is covered here.
function remappedFs(engineRoot, standIn) {
  const map = (file) => {
    const resolved = path.resolve(String(file));
    return resolved === engineRoot || resolved.startsWith(`${engineRoot}${path.sep}`)
      ? path.join(standIn, path.relative(engineRoot, resolved)) : resolved;
  };
  return {
    existsSync: (file) => fs.existsSync(map(file)),
    readdirSync: (file, options) => fs.readdirSync(map(file), options),
    readFileSync: (file, encoding) => fs.readFileSync(map(file), encoding),
    mkdirSync: () => {},
    writeFileSync: () => {},
  };
}

test("COORD-835: init's pre-write state read covers manifest shapes, matches and mismatches in-process", () => {
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  boardModule.renderBoardArtifacts = () => {};
  const sha256 = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const standIn = tmpDir("coord835-standin-");
  const decisions = path.join(standIn, "docs/decisions");
  fs.mkdirSync(decisions, { recursive: true });
  fs.writeFileSync(path.join(decisions, "0001-shipped.md"), "# ADR 0001\n");
  // An intact baseline (behind a torn tail) lets state that existed reach the anchor.
  fs.mkdirSync(path.join(standIn, ".runtime"), { recursive: true });
  fs.writeFileSync(path.join(standIn, ".runtime/governance-events.ndjson"), "{\"snapshot_digest\":\"d\"}\n{ torn");
  const manifest = path.join(standIn, ".concord-install-ownership.json");
  const stateSeen = (manifestBody) => {
    if (manifestBody === null) fs.rmSync(manifest, { force: true });
    else fs.writeFileSync(manifest, manifestBody);
    const seen = [];
    createCoordInit({
      cwd: () => workspaceRoot, fs: remappedFs(engineRoot, standIn), log: () => {},
      anchorJournalBaseline: (options) => { seen.push(options.stateExisted); },
    }).run([]);
    return seen[0];
  };
  try {
    const digest = sha256("# ADR 0001\n");
    assert.equal(stateSeen(null), true, "no manifest: every ADR is state");
    assert.equal(stateSeen("{ torn"), true, "an unreadable manifest exempts nothing");
    assert.equal(stateSeen(JSON.stringify({ files: null })), true, "a manifest without files exempts nothing");
    assert.equal(stateSeen(JSON.stringify({ files: { "coord/docs/decisions/0001-shipped.md": { digest: "0".repeat(64) } } })), true,
      "a recorded digest that does not match is state");
    assert.equal(stateSeen(JSON.stringify({ files: { "coord/docs/decisions/0001-shipped.md": { digest } } })), false,
      "the exact shipped bytes are template content");
  } finally {
    boardModule.renderBoardArtifacts = originalRender;
    fs.rmSync(standIn, { recursive: true, force: true });
  }
});

test("COORD-835: own-engine init refuses when the anchor rejects pre-existing state, and reports non-Error anchor failures", () => {
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  boardModule.renderBoardArtifacts = () => {};
  const coordPaths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const planDir = coordPaths.planRecordsDir;
  const journal = path.resolve(coordPaths.governanceEventLogPath);
  // Injected fs: the board and every view are absent, one plan record exists,
  // and the journal still carries a baseline (so the anchor is the backstop).
  const fakeFs = {
    existsSync: (file) => [path.resolve(planDir), journal].includes(path.resolve(String(file))),
    readdirSync: () => [{ name: "COORD-1.json", isDirectory: () => false, isFile: () => true }],
    readFileSync: () => "{\"snapshot\":{}}\n",
    mkdirSync: () => {},
    writeFileSync: () => {},
  };
  try {
    const seen = [];
    const logs = [];
    const refused = createCoordInit({
      cwd: () => workspaceRoot, fs: fakeFs, log: (line) => logs.push(String(line)),
      anchorJournalBaseline: (options) => { seen.push(options); throw new Error("journal refused"); },
    }).run([]);
    assert.deepEqual(seen, [{ stateExisted: true }], "init tells the journal that state predated its writes");
    assert.deepEqual({ ok: refused.ok, code: refused.code }, { ok: false, code: 1 });
    assert.ok(logs.some((line) => /refuse {2}journal genesis NOT anchored/.test(line)));
    assert.ok(logs.some((line) => /journal refused/.test(line)));
    assert.ok(!logs.some((line) => /Next: edit/.test(line)));

    const warned = [];
    const fresh = createCoordInit({
      cwd: () => workspaceRoot, fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
      log: (line) => warned.push(String(line)),
      anchorJournalBaseline: (options) => { seen.push(options); throw "string failure"; },
    }).run([]);
    assert.equal(fresh.ok, true, "a fresh-workspace anchor failure still only warns");
    assert.deepEqual(seen[1], { stateExisted: false });
    assert.ok(warned.some((line) => /could not anchor the journal genesis: string failure/.test(line)));
  } finally {
    boardModule.renderBoardArtifacts = originalRender;
  }
});

test("COORD-835: own-engine init over existing state without a journal baseline refuses before any write or anchor", () => {
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const coordPaths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const planDir = path.resolve(coordPaths.planRecordsDir);
  const journal = path.resolve(coordPaths.governanceEventLogPath);
  const journals = {
    "absent journal": null,
    "journal without a snapshot event": "{\"command\":\"claim\"}\n",
    "journal with only torn lines": "{ torn\n{ also torn",
  };
  for (const [label, body] of Object.entries(journals)) {
    const writes = [];
    const anchored = [];
    const logs = [];
    const result = createCoordInit({
      cwd: () => workspaceRoot,
      fs: {
        existsSync: (file) => path.resolve(String(file)) === planDir || (body !== null && path.resolve(String(file)) === journal),
        readdirSync: () => [{ name: "COORD-1.json", isDirectory: () => false, isFile: () => true }],
        readFileSync: () => body,
        mkdirSync: (dir) => writes.push(`mkdir ${dir}`),
        writeFileSync: (file) => writes.push(`write ${file}`),
      },
      log: (line) => logs.push(String(line)),
      anchorJournalBaseline: (options) => { anchored.push(options); },
    }).run([]);
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 1 }, label);
    assert.deepEqual(writes, [], `${label}: nothing written, not even the starter board`);
    assert.deepEqual(anchored, [], `${label}: no anchor attempted`);
    assert.ok(logs.some((line) => /refuse {2}journal genesis NOT anchored/.test(line)), label);
    assert.ok(logs.some((line) => /--expect-paths-file/.test(line)), `${label}: names the packet-bound reconcile`);
    assert.ok(logs.some((line) => /Refused: no files written/.test(line)), label);
    assert.ok(!logs.some((line) => /Next: edit|Created \d+ file/.test(line)), label);
  }
});

test("COORD-835: the pre-write baseline check reads the journal by the journal reader's own rule, and refuses in a dry run before listing files", () => {
  const engineRoot = COORD_ROOT_DIR;
  const workspaceRoot = path.resolve(engineRoot, "..");
  const coordPaths = require("../../paths.js").createCoordPaths({ coordDir: engineRoot, forceProjectConfig: true });
  const planDir = path.resolve(coordPaths.planRecordsDir);
  const journal = path.resolve(coordPaths.governanceEventLogPath);
  const boardModule = require("../../board/board.js");
  const originalRender = boardModule.renderBoardArtifacts;
  boardModule.renderBoardArtifacts = () => {};
  const runInit = (body, args) => {
    const writes = [];
    const anchored = [];
    const logs = [];
    const result = createCoordInit({
      cwd: () => workspaceRoot,
      fs: {
        existsSync: (file) => [planDir, journal].includes(path.resolve(String(file))),
        readdirSync: () => [{ name: "COORD-1.json", isDirectory: () => false, isFile: () => true }],
        readFileSync: () => body,
        mkdirSync: (dir) => writes.push(`mkdir ${dir}`),
        writeFileSync: (file) => writes.push(`write ${file}`),
      },
      log: (line) => logs.push(String(line)),
      anchorJournalBaseline: (options) => { anchored.push(options); },
    }).run(args);
    return { result, writes, anchored, logs };
  };
  try {
    // journal.js readGovernanceEventLog tolerates exactly one torn LAST line and
    // fails on any earlier one; an unreadable journal is no baseline.
    const unreadable = {
      "a snapshot then two torn lines": "{\"snapshot_digest\":\"d\"}\n{ torn\n{ torn2",
      "a torn line before a snapshot event": "{ torn\n{\"snapshot_digest\":\"d\"}\n",
    };
    for (const [label, body] of Object.entries(unreadable)) {
      for (const args of [[], ["--dry-run"]]) {
        const tag = `${label} ${args.join(" ") || "(real run)"}`;
        const { result, writes, anchored, logs } = runInit(body, args);
        assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 1 }, tag);
        assert.deepEqual(writes, [], `${tag}: no file written`);
        assert.deepEqual(anchored, [], `${tag}: no anchor attempted`);
        assert.ok(logs.some((line) => /refuse {2}journal genesis NOT anchored/.test(line)), tag);
        assert.ok(logs.some((line) => /--expect-paths-file/.test(line)), `${tag}: names the packet-bound reconcile`);
        assert.ok(logs.some((line) => /Refused: no files written/.test(line)), tag);
        assert.ok(!logs.some((line) => /^ {2}create {2}/.test(line)), `${tag}: a refused run lists no planned files`);
        assert.ok(!logs.some((line) => /Would create|Created \d+ file|Next: edit/.test(line)), tag);
      }
    }
    const dry = runInit(null, ["--dry-run"]);
    assert.ok(dry.logs.some((line) => /Refused: no files written \(\d+ planned, dry run\)/.test(line)), "dry-run refusal says so");

    // An intact baseline behind ONE torn final line still covers the state.
    for (const args of [[], ["--dry-run"]]) {
      const { result, writes, logs } = runInit("{\"snapshot_digest\":\"d\"}\n{ torn", args);
      assert.deepEqual({ ok: result.ok, code: result.code }, { ok: true, code: 0 }, args.join(" "));
      assert.ok(logs.some((line) => /^ {2}create {2}coord\/board\/tasks\.json/.test(line)), "planned files listed");
      assert.ok(!logs.some((line) => /refuse/.test(line)));
      if (args.length) assert.deepEqual(writes, [], "dry run writes nothing");
      else assert.ok(writes.some((entry) => /tasks\.json$/.test(entry)), "real run writes the starter board");
    }
  } finally {
    boardModule.renderBoardArtifacts = originalRender;
  }
});

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

test("COORD-808: product CLI accepts --dir=<path> with spaces during a write-free dry run", () => {
  const root = tmpDir("coord-init-808-dir-equals-");
  const targetName = "workspace with spaces";
  const targetRoot = path.join(root, targetName);
  const output = [];
  try {
    const result = dispatch(
      ["init", `--dir=${targetName}`, "--dry-run"],
      { cwd: () => root, log: (line) => output.push(String(line)) }
    );
    assert.deepEqual(result, { code: 0 });
    assert.ok(output.includes(`coord init — target: ${targetRoot}`));
    assert.ok(output.includes("(dry run — no files will be written)"));
    assert.equal(fs.existsSync(targetRoot), false, "dry-run target is not created");
    assert.deepEqual(fs.readdirSync(root), [], "dry run writes no workspace files");
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

test("COORD-732: ordinary coord init flags cannot grant installer journal-genesis authority", () => {
  const root = tmpDir("coord-init-732-authority-");
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(String(line));
  try {
    const init = createCoordInit({ cwd: () => root });
    const help = init.run(["--help"]);
    assert.equal(help.ok, true);
    assert.ok(output.some((line) => /Usage: coord init/.test(line)), "default logger surfaces normal help");

    const attemptedGrant = init.run(["--installer-genesis"]);
    assert.equal(attemptedGrant.ok, false, "an undeclared CLI flag cannot grant the internal capability");
    assert.ok(output.some((line) => /unexpected argument.*--installer-genesis/.test(line)));
    assert.throws(
      () => init.anchorInstalledWorkspaceJournalGenesis(),
      /installer journal-genesis authority was not supplied/
    );
    assert.deepEqual(fs.readdirSync(root), [], "help and an attempted CLI grant write no workspace state");
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-732: init requires a callable transaction delegate that returns strict true", () => {
  for (const invalid of [null, true, {}]) {
    const init = createCoordInit({ anchorInstalledWorkspaceJournalGenesis: invalid });
    assert.throws(
      () => init.anchorInstalledWorkspaceJournalGenesis(),
      /installer journal-genesis authority was not supplied/
    );
  }

  for (const result of [false, undefined, null, 1, "true"]) {
    let calls = 0;
    const init = createCoordInit({ anchorInstalledWorkspaceJournalGenesis: () => { calls += 1; return result; } });
    assert.throws(
      () => init.anchorInstalledWorkspaceJournalGenesis(),
      /could not establish the fresh workspace journal genesis/
    );
    assert.equal(calls, 1, "a transaction delegate is invoked exactly once");
  }

  const failure = new Error("transaction anchor refused");
  const throwing = createCoordInit({ anchorInstalledWorkspaceJournalGenesis: () => { throw failure; } });
  assert.throws(() => throwing.anchorInstalledWorkspaceJournalGenesis(), (error) => error === failure,
    "an anchor exception propagates instead of being reported as success");
});

test("COORD-732: init accepts the real installer transaction capability", (t) => {
  const workspace = tmpDir("coord-init-732-real-capability-");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const coord = path.join(workspace, "coord");
  const scripts = path.join(coord, "scripts");
  fs.mkdirSync(scripts, { recursive: true });

  const digest = "b".repeat(40);
  const artifactPath = path.join(coord, ".runtime", "governance-snapshots", `${digest}.json`);
  const latestPath = path.join(coord, ".runtime", "governance-latest-snapshot.json");
  const eventPath = path.join(coord, ".runtime", "governance-events.ndjson");
  fs.writeFileSync(path.join(scripts, "lifecycle.js"), `
    const fs = require("node:fs");
    const path = require("node:path");
    const artifactPath = ${JSON.stringify(artifactPath)};
    const latestPath = ${JSON.stringify(latestPath)};
    const eventPath = ${JSON.stringify(eventPath)};
    let events = [];
    module.exports.installerGovernance = {
      buildSnapshot: () => ({ digest: ${JSON.stringify(digest)}, files: [] }),
      snapshotArtifactPath: () => artifactPath,
      readEventLog: () => events,
      verifyChain: (value) => ({
        ok: value.length > 0,
        chainedCount: value.filter((event) => event.command === "journal-baseline").length,
        preChainCount: value.filter((event) => event.command !== "journal-baseline").length,
      }),
      detectProvenanceDrift: () => ({ uninitialized: events.length === 0, snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] }),
      ensureBaseline: () => {
        const event = { command: "journal-baseline", snapshot_digest: ${JSON.stringify(digest)} };
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, "{}\\n");
        fs.writeFileSync(latestPath, JSON.stringify({ digest: ${JSON.stringify(digest)} }) + "\\n");
        fs.writeFileSync(eventPath, JSON.stringify(event) + "\\n");
        events = [event];
        return true;
      },
    };
  `);

  const previousConfigOverride = process.env.COORD_PROJECT_CONFIG;
  delete process.env.COORD_PROJECT_CONFIG;
  try {
    const governance = createInstallerGovernance(workspace);
    const authorizedSidecars = [];
    const capability = governance.createGenesisAnchor((artifact, sidecars) => {
      authorizedSidecars.push({ artifact, sidecars });
    });
    const init = createCoordInit({ anchorInstalledWorkspaceJournalGenesis: capability });
    assert.equal(init.anchorInstalledWorkspaceJournalGenesis(), true);
    assert.equal(authorizedSidecars.length, 1);
    assert.equal(authorizedSidecars[0].artifact, artifactPath);
    assert.deepEqual(authorizedSidecars[0].sidecars.slice().sort(), [
      "coord/.runtime/governance-events.ndjson",
      "coord/.runtime/governance-latest-snapshot.json",
      `coord/.runtime/governance-snapshots/${digest}.json`,
    ].sort());
    assert.equal(governance.inspectJournal().status, "ready");
  } finally {
    if (previousConfigOverride === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previousConfigOverride;
  }
});
