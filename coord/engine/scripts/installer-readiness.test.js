"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createInstallerGovernance } = require("./installer-governance.js");

function workspace(t, { config = { repos: {} }, lifecycle = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installer-readiness-errors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "engine/scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "board"), { recursive: true });
  fs.mkdirSync(path.join(coord, "prompts/tickets"), { recursive: true });
  fs.writeFileSync(path.join(coord, "project.config.js"), `module.exports = ${JSON.stringify(config)};\n`);
  fs.writeFileSync(path.join(coord, "engine/scripts/static-config-declaration.js"),
    "exports.readDeclaredConfig = (file) => ({ status: 'declared', declared: require(file) });\n");
  fs.writeFileSync(path.join(coord, "paths.js"), "exports.validateProjectConfig = (value) => value;\n");
  fs.writeFileSync(path.join(coord, "board/board.js"), "exports.validateBoardState = () => true;\n");
  fs.writeFileSync(path.join(coord, "board/tasks.json"), JSON.stringify({ sections: [] }));
  const defaults = {
    events: [{ command: "journal-baseline", snapshot_digest: "d" }],
    chain: { ok: true, chainedCount: 1, preChainCount: 0 },
    provenance: { snapshotPruned: false, snapshotMatchesCurrent: true, drift: [] },
    baseline: false,
    readError: null,
  };
  const state = { ...defaults, ...lifecycle };
  const lifecycleSource = `
    const fs = require("node:fs");
    const path = require("node:path");
    const state = ${JSON.stringify(state)};
    const root = ${JSON.stringify(coord)};
    module.exports.installerGovernance = {
      buildSnapshot: () => ({ digest: "d", files: [] }),
      snapshotArtifactPath: () => path.join(root, ".runtime/governance-snapshots/d.json"),
      readEventLog: () => {
        if (state.readError) {
          const error = new Error("governance event journal is unavailable");
          error.code = state.readError;
          throw error;
        }
        return state.events;
      },
      verifyChain: () => state.chain,
      detectProvenanceDrift: () => state.provenance,
      ensureBaseline: () => {
        if (state.baseline === "persist") {
          const artifact = path.join(root, ".runtime/governance-snapshots/d.json");
          fs.mkdirSync(path.dirname(artifact), { recursive: true });
          fs.writeFileSync(artifact, "{}\\n");
          state.events = [{ command: "journal-baseline", snapshot_digest: "d" }];
          return true;
        }
        return state.baseline === "no-artifact";
      },
    };
  `;
  fs.writeFileSync(path.join(coord, "engine/scripts/lifecycle.js"), lifecycleSource);
  return { root, coord, api: () => createInstallerGovernance(root) };
}

function readinessDependencies(root, repoState = "established") {
  return {
    inside: (parent, candidate) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`),
    coordRepoRoot: (workspaceRoot) => path.join(workspaceRoot, "coord"),
    captureRootGitState: (repoRoot) => ({ root: repoRoot, state: repoState }),
  };
}

test("target config override must resolve to the installed config and reports missing target context", (t) => {
  const target = workspace(t);
  const foreign = path.join(target.root, "foreign-project.config.js");
  fs.writeFileSync(foreign, "module.exports = { repos: {} };\n");
  const previous = process.env.COORD_PROJECT_CONFIG;
  try {
    process.env.COORD_PROJECT_CONFIG = foreign;
    assert.throws(target.api, /COORD_PROJECT_CONFIG resolves outside this installed workspace/);
  } finally {
    if (previous === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = previous;
  }

  const missing = workspace(t);
  fs.rmSync(path.join(missing.coord, "project.config.js"));
  const prior = process.env.COORD_PROJECT_CONFIG;
  try {
    process.env.COORD_PROJECT_CONFIG = path.join(missing.root, "missing-config.js");
    assert.throws(missing.api, /cannot validate COORD_PROJECT_CONFIG against the installed target/);
  } finally {
    if (prior === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = prior;
  }
});

test("target lifecycle missing installer services refuses readiness construction", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "engine/scripts/lifecycle.js"), "module.exports.installerGovernance = {};\n");
  assert.throws(target.api, /target lifecycle does not expose installer governance services/);
});

test("the declarative project-config reader refuses executable config without evaluating it", (t) => {
  const target = workspace(t);
  const sentinel = path.join(target.root, "config-was-executed");
  fs.writeFileSync(path.join(target.coord, "project.config.js"),
    `module.exports = (() => { require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "bad"); return { repos: {} }; })();\n`);
  fs.copyFileSync(
    path.join(__dirname, "static-config-declaration.js"),
    path.join(target.coord, "engine/scripts/static-config-declaration.js"),
  );
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.repo_mapping.status, "blocked");
  assert.match(result.checks.repo_mapping.reason, /could not read project config/);
  assert.equal(fs.existsSync(sentinel), false, "readiness must not execute adopter config");
  assert.equal(result.status, "incomplete");
});

test("invalid journal provenance remains a readiness blocker with actionable state", (t) => {
  const target = workspace(t, {
    lifecycle: {
      chain: { ok: false, chainedCount: 0, preChainCount: 1 },
      provenance: { uninitialized: true, snapshotPruned: true, snapshotMatchesCurrent: false, drift: ["coord/board/tasks.json"] },
    },
  });
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.journal.status, "blocked");
  assert.equal(result.checks.journal.chain, "invalid");
  assert.deepEqual(result.checks.journal.drift_paths, ["coord/board/tasks.json"]);
  assert.equal(result.checks.journal.snapshot_matches, false);
  assert.equal(result.checks.repo_mapping.status, "pending_operator_decision");
  assert.match(result.checks.repo_mapping.next_action, /coord-cli\.js init --wizard --dry-run.*--confirm.*onboard \. --dry-run/);
  assert.equal(result.status, "incomplete");
});

test("missing target event log is surfaced as a blocked journal readiness result", (t) => {
  const target = workspace(t, { lifecycle: { readError: "ENOENT" } });
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.deepEqual(result.checks.journal, { status: "blocked", reason: "missing" });
  assert.equal(result.status, "incomplete");
});

test("journal inspection tolerates the optional drift list being absent", (t) => {
  const target = workspace(t, {
    lifecycle: { provenance: { snapshotPruned: false, snapshotMatchesCurrent: true } },
  });
  const journal = target.api().inspectJournal();
  assert.equal(journal.status, "ready");
  assert.equal(journal.chain, "verified");
  assert.equal(journal.event_count, 1);
});

test("blocked journal readiness keeps a stable empty drift list when older lifecycle omits it", (t) => {
  const target = workspace(t, {
    lifecycle: {
      events: [{ command: "ordinary-governance-event" }],
      chain: { ok: false, chainedCount: 0, preChainCount: 1 },
      provenance: { snapshotPruned: false, snapshotMatchesCurrent: true },
    },
  });
  const journal = target.api().inspectJournal();
  assert.equal(journal.status, "blocked");
  assert.deepEqual(journal.drift_paths, []);
});

test("genesis authority refuses a pre-existing journal and a lifecycle baseline refusal", (t) => {
  const existing = workspace(t);
  const anchorWithExisting = existing.api().createGenesisAnchor(() => assert.fail("authorization must not run for an existing journal"));
  assert.throws(anchorWithExisting, /refuses an existing journal/);
  assert.throws(() => existing.api().createGenesisAnchor("not a callback"), /transaction-owned authorization callback/);

  const refused = workspace(t, { lifecycle: { events: [], baseline: false } });
  let authorizationCalls = 0;
  const anchor = refused.api().createGenesisAnchor(() => { authorizationCalls += 1; });
  assert.throws(anchor, /target lifecycle refused to establish a fresh install journal baseline/);
  assert.equal(authorizationCalls, 1, "the one-use transaction callback runs before lifecycle persistence");
  assert.throws(anchor, /already consumed/);
});

test("genesis authority refuses an unverifiable or unpersisted baseline", (t) => {
  const invalidChain = workspace(t, { lifecycle: { events: [], chain: { ok: false, chainedCount: 0, preChainCount: 0 }, baseline: "persist" } });
  const invalidAnchor = invalidChain.api().createGenesisAnchor(() => {});
  assert.throws(invalidAnchor, /did not establish a verifiable chained journal genesis/);

  const missingArtifact = workspace(t, { lifecycle: { events: [], baseline: "no-artifact" } });
  const unpersistedAnchor = missingArtifact.api().createGenesisAnchor(() => {});
  assert.throws(unpersistedAnchor, /did not persist the authorized journal genesis and snapshot/);
});

test("readiness reports missing project config and non-independent mapped repositories", (t) => {
  const missing = workspace(t);
  fs.rmSync(path.join(missing.coord, "project.config.js"));
  const missingResult = missing.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(missing.root),
  );
  assert.equal(missingResult.checks.repo_mapping.status, "blocked");
  assert.match(missingResult.checks.repo_mapping.reason, /could not read project config/);
  assert.equal(missingResult.status, "incomplete");

  const mapped = workspace(t, { config: { repos: { F: { path: "frontend" } } } });
  fs.mkdirSync(path.join(mapped.root, "frontend"));
  const mappedResult = mapped.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    {
      ...readinessDependencies(mapped.root),
      captureRootGitState: (repoRoot) => ({ root: path.join(repoRoot, "parent-repo"), state: "established" }),
    },
  );
  assert.equal(mappedResult.checks.repo_mapping.status, "blocked");
  assert.match(mappedResult.checks.repo_mapping.invalid[0], /not an independent Git repository/);
  assert.equal(mappedResult.status, "incomplete");

  const valid = workspace(t, { config: { repos: { F: { path: "frontend" } } } });
  fs.mkdirSync(path.join(valid.root, "frontend"));
  const validResult = valid.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(valid.root),
  );
  assert.equal(validResult.checks.repo_mapping.status, "ready");
  assert.deepEqual(validResult.checks.repo_mapping.repo_codes, ["F"]);
  assert.equal(validResult.status, "ready");
});

test("readiness blocks a validated mapping that escapes or names a missing sibling", (t) => {
  const escape = workspace(t, { config: { repos: { F: { path: "../outside" } } } });
  fs.copyFileSync(path.resolve(__dirname, "../../paths.js"), path.join(escape.coord, "paths.js"));
  fs.copyFileSync(path.join(__dirname, "static-config-declaration.js"),
    path.join(escape.coord, "engine/scripts/static-config-declaration.js"));
  const escapeResult = escape.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {}, readinessDependencies(escape.root),
  );
  assert.equal(escapeResult.checks.repo_mapping.status, "blocked");
  assert.match(escapeResult.checks.repo_mapping.invalid[0], /path escapes workspace/);

  const absent = workspace(t, { config: { repos: { F: { path: "frontend" } } } });
  fs.copyFileSync(path.resolve(__dirname, "../../paths.js"), path.join(absent.coord, "paths.js"));
  fs.copyFileSync(path.join(__dirname, "static-config-declaration.js"),
    path.join(absent.coord, "engine/scripts/static-config-declaration.js"));
  const absentResult = absent.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {}, readinessDependencies(absent.root),
  );
  assert.equal(absentResult.checks.repo_mapping.status, "blocked");
  assert.match(absentResult.checks.repo_mapping.invalid[0], /mapped sibling path is missing/);
});

test("readiness fails closed if the target workspace disappears during config inspection", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "engine/scripts/static-config-declaration.js"), `
    const fs = require("node:fs");
    exports.readDeclaredConfig = () => {
      fs.rmSync(${JSON.stringify(target.root)}, { recursive: true, force: true });
      return { status: "declared", declared: { repos: {} } };
    };
  `);
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.repo_mapping.status, "blocked");
  assert.equal(result.checks.repo_mapping.reason, "coord/project.config.js is missing");
  assert.equal(result.status, "incomplete");
});

test("unborn control-plane Git reports required setup while journal and map remain valid", (t) => {
  const target = workspace(t);
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace", git_actions: { baseline_commit: { requested: false } } },
    { requested: true },
    readinessDependencies(target.root, "unborn"),
  );
  assert.equal(result.checks.governance_git.status, "incomplete");
  assert.equal(result.checks.governance_git.state, "unborn");
  assert.match(result.checks.governance_git.next_action, /--git-scope coord/);
  assert.equal(result.status, "incomplete");
});

test("fresh-install readiness reports missing shipped starter rows and prompts", (t) => {
  const target = workspace(t);
  const source = path.resolve(__dirname, "coord-init-starter-board.js");
  fs.copyFileSync(source, path.join(target.coord, "engine/scripts/coord-init-starter-board.js"));
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: true }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.starter_consistency.status, "blocked");
  assert.equal(result.checks.starter_consistency.missing_setup_rows.length, 9);
  assert.equal(result.checks.starter_consistency.missing_or_stub_prompts.length, 9);
  assert.equal(result.status, "incomplete");
});

test("starter consistency blocks corrupt board data instead of returning readiness", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "board/tasks.json"), "{not-json\n");
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.starter_consistency.status, "blocked");
  assert.match(result.checks.starter_consistency.reason, /JSON|position/i);
  assert.equal(result.status, "incomplete");
});

test("retained starter rows with a wrong repo or stub prompt block readiness", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "board/tasks.json"), JSON.stringify({
    sections: [{ rows: [{ ID: "SETUP-001", Repo: "B" }] }],
  }));
  fs.writeFileSync(path.join(target.coord, "prompts/tickets/SETUP-001.md"), "  \n");
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.starter_consistency.status, "blocked");
  assert.deepEqual(result.checks.starter_consistency.malformed_setup_rows, ["SETUP-001"]);
  assert.deepEqual(result.checks.starter_consistency.missing_or_stub_prompts, ["SETUP-001"]);
  assert.deepEqual(result.checks.starter_consistency.unmapped_setup_repos, ["SETUP-001"]);
  assert.equal(result.status, "incomplete");
});

test("excluded sample rows are reported when workspace install omits the sample class", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "board/tasks.json"), JSON.stringify({
    sections: [{ rows: [{ ID: "SAMPLE-001", Repo: "X" }, { ID: "OTHER-001", Repo: "X" }] }],
  }));
  const result = target.api().inspectReadiness(
    {
      install_genesis: { eligible: false },
      install_mode: "workspace",
      payload_surfaces: { classes_excluded: ["product-sample"] },
    },
    {}, readinessDependencies(target.root),
  );
  assert.deepEqual(result.checks.starter_consistency.excluded_sample_rows, ["SAMPLE-001"]);
  assert.equal(result.checks.starter_consistency.status, "blocked");
  assert.equal(result.status, "incomplete");
});

test("markdown board sections may omit table rows without breaking starter inspection", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "board/tasks.json"), JSON.stringify({
    sections: [{ kind: "markdown", content: "Notes" }, { kind: "table", rows: [] }],
  }));
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {}, readinessDependencies(target.root),
  );
  assert.equal(result.checks.starter_consistency.status, "ready");
  assert.equal(result.checks.starter_consistency.setup_rows_checked, 0);
  assert.equal(result.status, "ready_with_operator_decision");
});

test("fresh starter readiness compares shipped prompts to the exact assigned contents", (t) => {
  const target = workspace(t);
  const starterBuilderPath = path.resolve(__dirname, "coord-init-starter-board.js");
  fs.copyFileSync(starterBuilderPath, path.join(target.coord, "engine/scripts/coord-init-starter-board.js"));
  const prompts = require(starterBuilderPath).buildStarterPrompts();
  const rows = Object.keys(prompts).map((ID) => ({ ID, Repo: "X" }));
  fs.writeFileSync(path.join(target.coord, "board/tasks.json"), JSON.stringify({ sections: [{ rows }] }));
  for (const [id, prompt] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(target.coord, "prompts/tickets", `${id}.md`), prompt);
  }
  const plan = { install_genesis: { eligible: true }, install_mode: "workspace" };
  const api = target.api();
  assert.equal(api.inspectReadiness(plan, {}, readinessDependencies(target.root)).checks.starter_consistency.status, "ready");

  fs.writeFileSync(path.join(target.coord, "prompts/tickets/SETUP-001.md"), `${prompts["SETUP-001"]}\nextra stale bytes\n`);
  const stale = api.inspectReadiness(plan, {}, readinessDependencies(target.root));
  assert.equal(stale.checks.starter_consistency.status, "blocked");
  assert.deepEqual(stale.checks.starter_consistency.missing_or_stub_prompts, ["SETUP-001"]);
  assert.equal(stale.status, "incomplete");
});

test("COORD-866: a refused config declaration without a message blocks readiness with the refusal status", (t) => {
  const target = workspace(t);
  fs.writeFileSync(path.join(target.coord, "engine/scripts/static-config-declaration.js"),
    "exports.readDeclaredConfig = () => ({ status: 'refused' });\n");
  const result = target.api().inspectReadiness(
    { install_genesis: { eligible: false }, install_mode: "workspace" },
    {},
    readinessDependencies(target.root),
  );
  assert.equal(result.checks.repo_mapping.status, "blocked");
  assert.match(result.checks.repo_mapping.reason, /could not read project config: config declaration refused \(refused\)/);
});
