const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pathsApi = require("../paths.js");
const { installCanonicalEngine } = require("./fixtures/coord-engine-schemas.js");

// COORD-916: every test gets its own synthetic workspace root from mkdtemp, so
// concurrent runs on one host (a gate's Node 22, Node 24 and dual-release lanes,
// or two gates) never install into or delete each other's coord roots. The
// expected paths below are computed from that root, not written as /tmp literals.
let rootDir;
let coordDir;
let coord125Dir;
test.beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord916-paths-"));
  coordDir = path.join(rootDir, "coord");
  coord125Dir = path.join(rootDir, "coord-coord125");
  installCanonicalEngine(coordDir, path.resolve(__dirname, ".."));
  installCanonicalEngine(coord125Dir, path.resolve(__dirname, ".."));
});
test.afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});
const inRoot = (...parts) => path.join(rootDir, ...parts);
const inCoord = (...parts) => path.join(coordDir, ...parts);
const { createCoordPaths, allBoardRepoCodes } = pathsApi;

// COORD-099 (governance.test residual split, slice 4): config/path behavior.
// Every subject here is DEFINED in coord/paths.js — the module that owns the
// project-config seam and path derivation:
//   - createCoordPaths (governance path + repo-registry derivation)
//   - allBoardRepoCodes
//   - normalizeProjectConfig / validateProjectConfig / loadProjectConfig /
//     resolveProjectConfigPath (the project.config.js config seam)
//   - COORD_PROJECT_CONFIG env override + repoIntegrationBranches map
// Relocated from governance.test.js so config/path unit behavior lives beside
// its owner. The COORD-010 config matrix re-runs THIS file (it is matched by
// the `coord/scripts/*.test.js` runner glob) under both the default registry
// and the synthetic non-default COORD_PROJECT_CONFIG fixture, so these tests
// keep exercising default vs override discovery on both matrix legs.

// COORD-010: the config matrix runs the suite a second time with
// `COORD_PROJECT_CONFIG` pointed at a synthetic non-default registry. A
// handful of tests deliberately pin the config-DISCOVERY default behavior of
// `paths.js` (an absent project.config.js -> null, the template default
// registry). Those tests must verify default discovery regardless of which
// leg of the matrix is running, so they temporarily clear the env override.
function withDefaultProjectConfigEnv(fn) {
  const original = process.env.COORD_PROJECT_CONFIG;
  delete process.env.COORD_PROJECT_CONFIG;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.COORD_PROJECT_CONFIG;
    } else {
      process.env.COORD_PROJECT_CONFIG = original;
    }
  }
}

test("createCoordPaths derives shared governance defaults from coord root", () => {
  // COORD-010: this test pins the template-default registry; run it with the
  // config-matrix env override cleared so it asserts default discovery on
  // both matrix legs.
  const paths = withDefaultProjectConfigEnv(() => createCoordPaths({
    coordDir,
    rootDir,
  }));

  assert.equal(paths.boardPath, inCoord("board", "tasks.json"));
  assert.equal(paths.decisionsDir, inCoord("docs", "decisions"));
  assert.equal(paths.planRecordsDir, inCoord(".runtime", "plans"));
  assert.equal(paths.legacyPlanRecordsDir, inCoord("board", "plans"));
  assert.equal(paths.renderedDir, inCoord("rendered"));
  assert.equal(paths.renderedTasksMdPath, inCoord("rendered", "TASKS.md"));
  assert.equal(paths.renderedPromptIndexMdPath, inCoord("rendered", "PROMPT_INDEX.md"));
  assert.equal(paths.planPath, inCoord("PLAN.md"));
  assert.equal(paths.agentsPath, inCoord(".runtime", "agents.json"));
  assert.equal(paths.legacyAgentsPath, inCoord("agents.json"));
  assert.equal(paths.agentSessionsPath, inCoord(".runtime", "agent_sessions.json"));
  assert.equal(paths.legacyAgentSessionsPath, inCoord("agent_sessions.json"));
  assert.equal(paths.locksDir, inCoord(".runtime", "locks"));
  assert.equal(paths.legacyLocksDir, inCoord("locks"));
  assert.equal(paths.runtimeDir, inCoord(".runtime"));
  assert.equal(paths.sessionThreadsDir, inCoord(".runtime", "session-threads"));
  assert.equal(paths.governanceEventLogPath, inCoord(".runtime", "governance-events.ndjson"));
  assert.equal(paths.governanceSnapshotPath, inCoord(".runtime", "governance-latest-snapshot.json"));
  assert.equal(paths.governanceSnapshotsDir, inCoord(".runtime", "governance-snapshots"));
  assert.equal(paths.repoRoots.B, inRoot("backend"));
  assert.equal(paths.repoRoots.F, inRoot("frontend"));
});

test("createCoordPaths derives a registry-driven repoIntegrationBranches map defaulting to dev", () => {
  // COORD-010: pins the template default; clear the matrix env override so
  // the "dev" default holds regardless of which matrix leg runs this.
  const paths = withDefaultProjectConfigEnv(() => createCoordPaths({
    coordDir,
    rootDir,
  }));

  // Every repoRoots code must have a matching integration branch entry, and
  // the template default integration branch is "dev" (NOT acme's "devx").
  assert.deepEqual(Object.keys(paths.repoIntegrationBranches).sort(), Object.keys(paths.repoRoots).sort());
  for (const code of Object.keys(paths.repoRoots)) {
    assert.equal(paths.repoIntegrationBranches[code], "dev");
  }
});

test("every repoRoots code has a matching repoIntegrationBranches entry (registry guard)", () => {
  const paths = createCoordPaths();
  const missing = Object.keys(paths.repoRoots).filter(
    (code) => typeof paths.repoIntegrationBranches[code] !== "string" || !paths.repoIntegrationBranches[code].trim()
  );
  assert.deepEqual(missing, [], `repoRoots codes missing an integration branch: ${missing.join(", ")}`);
});

// --- GCV-4 slice 1: engine/config seam fixtures ------------------------------
// These pin the project.config.js contract per
// coord/engine/docs/GCV4_ENGINE_CONFIG_SEAM.md. Each fixture proves a representative
// downstream shape derives correct paths WITHOUT hand-editing engine code.

test("GCV-4 slice 1 fixture: template default (B=backend, F=frontend) — proves the upstream baseline", () => {
  const paths = createCoordPaths({
    coordDir,
    rootDir,
    projectConfig: {
      repos: {
        B: { path: "backend", integrationBranch: "dev", origin: null, legacyAliases: [] },
        F: { path: "frontend", integrationBranch: "dev", origin: null, legacyAliases: [] },
      },
      requirements: { path: "product/REQUIREMENTS.md" },
    },
  });
  assert.deepEqual(paths.repoRoots, { B: inRoot("backend"), F: inRoot("frontend") });
  assert.deepEqual(paths.repoOrigins, { B: null, F: null });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "dev", F: "dev" });
  assert.deepEqual(paths.repoRegistry, { B: "backend", F: "frontend" });
  assert.deepEqual(paths.legacyRepoAliases, { B: [], F: [] });
  assert.equal(paths.requirementsPath, inCoord("product", "REQUIREMENTS.md"));
});

test("COORD-010: the config-matrix non-default fixture is a valid 7-repo non-dev registry", () => {
  // Guards the synthetic fixture the CI config matrix runs the suite under.
  // It must be structurally non-default — 7 repos on a non-`dev` integration
  // branch — so a config-sensitive assumption (hardcoded `dev`, 2-repo
  // layout) fails the matrix leg.
  const fixturePath = path.join(__dirname, "__fixtures__", "project.config.nondefault.js");
  assert.equal(fs.existsSync(fixturePath), true, "the non-default fixture config must exist");
  const normalized = pathsApi.normalizeProjectConfig(
    pathsApi.validateProjectConfig(require(fixturePath))
  );
  const codes = Object.keys(normalized.repos).sort();
  assert.equal(codes.length, 7, `fixture must declare 7 repos; got ${codes.join(",")}`);
  for (const code of codes) {
    assert.notEqual(normalized.repos[code].integrationBranch, "dev",
      `fixture repo ${code} must use a non-dev integration branch`);
  }
  // Sanity: not the coord-template default 2-repo B/F layout.
  assert.notDeepEqual(codes, ["B", "F"]);
  // With the matrix override cleared, the fixtures dir has no
  // project.config.js, so directory discovery returns null.
  withDefaultProjectConfigEnv(() => {
    assert.equal(pathsApi.loadProjectConfig(path.dirname(fixturePath)), null);
  });
});

test("GCV-4 slice 1 fixture: acme-ops shape (B=msrv, F=frontend) — derives the same values as the previous inline registry", () => {
  const paths = createCoordPaths({
    coordDir,
    rootDir,
    projectConfig: {
      repos: {
        B: { path: "msrv", integrationBranch: "dev" },
        F: { path: "frontend", integrationBranch: "dev" },
      },
    },
  });
  // Matches what acme-ops/coord's hand-merged inline REPO_REGISTRY = { B:"msrv",
  // F:"frontend" } produced before — but here it's CONFIG, not engine code.
  assert.deepEqual(paths.repoRoots, { B: inRoot("msrv"), F: inRoot("frontend") });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "dev", F: "dev" });
  assert.deepEqual(paths.repoRegistry, { B: "msrv", F: "frontend" });
});

test("GCV-4 slice 1 fixture: acme shape (B=acme-api, C=acme-cam, devx) — three repos + non-dev branch derive cleanly", () => {
  const paths = createCoordPaths({
    coordDir,
    rootDir,
    projectConfig: {
      repos: {
        B: {
          path: "acme-api",
          integrationBranch: "devx",
          origin: "git@github.com:acme-org/acme-api.git",
        },
        C: {
          path: "acme-cam",
          integrationBranch: "devx",
          origin: "git@github.com:acme-org/acme-cam.git",
        },
      },
    },
  });
  assert.deepEqual(paths.repoRoots, {
    B: inRoot("acme-api"),
    C: inRoot("acme-cam"),
  });
  assert.deepEqual(paths.repoOrigins, {
    B: "git@github.com:acme-org/acme-api.git",
    C: "git@github.com:acme-org/acme-cam.git",
  });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "devx", C: "devx" });
  assert.deepEqual(paths.repoRegistry, { B: "acme-api", C: "acme-cam" });
  // origin survives normalization (audit metadata, not authority).
  assert.equal(paths.projectConfig.repos.B.origin, "git@github.com:acme-org/acme-api.git");
  // allBoardRepoCodes picks up code C and keeps X reserved.
  assert.deepEqual(pathsApi.allBoardRepoCodes(paths), ["B", "C", "X"]);
});

test("GCV-4 slice 1: normalizeProjectConfig applies defaults (integrationBranch=dev, legacyAliases=[], requirements.path)", () => {
  const out = pathsApi.normalizeProjectConfig({
    repos: { B: { path: "backend" } },
  });
  assert.equal(out.repos.B.integrationBranch, "dev");
  assert.deepEqual(out.repos.B.legacyAliases, []);
  assert.equal(out.repos.B.origin, null);
  assert.equal(out.requirements.path, "product/REQUIREMENTS.md");
});

test("COORD-125: startBaseRef / defaultStartBaseRef normalize to null when unset and are exposed on paths", () => {
  // Unset -> null defaults (today's behavior preserved).
  const unset = pathsApi.normalizeProjectConfig({ repos: { B: { path: "backend" } } });
  assert.equal(unset.repos.B.startBaseRef, null);
  assert.equal(unset.defaultStartBaseRef, null);

  // Set -> trimmed values, exposed through createCoordPaths as the derived maps.
  const paths = createCoordPaths({
    coordDir: coord125Dir,
    rootDir,
    projectConfig: {
      defaultStartBaseRef: "  develop  ",
      repos: {
        B: { path: "backend", integrationBranch: "main", startBaseRef: " release-b " },
        F: { path: "frontend", integrationBranch: "main" },
      },
    },
  });
  assert.equal(paths.defaultStartBaseRef, "develop");
  assert.deepEqual(paths.repoStartBaseRefs, { B: "release-b", F: null });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "main", F: "main" });
});

test("COORD-125: validateProjectConfig rejects non-string startBaseRef / defaultStartBaseRef", () => {
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "backend", startBaseRef: 7 } } }),
    /startBaseRef must be a string/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "backend" } }, defaultStartBaseRef: 7 }),
    /`defaultStartBaseRef` must be a string/
  );
});

test("GCV-4 slice 1: validateProjectConfig rejects X in repos (reserved code)", () => {
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { X: { path: "anything" } } }),
    /"X" is reserved/
  );
});

test("GCV-4 slice 1: validateProjectConfig rejects malformed codes and entries", () => {
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { be: { path: "backend" } } }),
    /must be a single uppercase letter/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "" } } }),
    /must be a non-empty string/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "backend", integrationBranch: 7 } } }),
    /integrationBranch must be a string/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "backend", origin: 7 } } }),
    /origin must be a string or null/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({ repos: { B: { path: "backend", legacyAliases: "nope" } } }),
    /legacyAliases must be an array/
  );
  assert.throws(
    () => pathsApi.validateProjectConfig({}),
    /`repos` must be an object/
  );
});

test("GCV-4 slice 1: loadProjectConfig reads coord/project.config.js when present, returns null when absent", () => {
  // COORD-010: this test pins the default discovery path (coordDir-relative
  // project.config.js); clear the matrix env override so the discovery
  // behavior is exercised, not the COORD_PROJECT_CONFIG override.
  withDefaultProjectConfigEnv(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-gcv4-loadconfig-"));
    assert.equal(pathsApi.loadProjectConfig(tmp), null, "absent file -> null");
    fs.writeFileSync(
      path.join(tmp, "project.config.js"),
      `module.exports = { repos: { B: { path: "api", integrationBranch: "trunk" } } };\n`,
      "utf8"
    );
    const loaded = pathsApi.loadProjectConfig(tmp);
    assert.equal(loaded.repos.B.path, "api");
    assert.equal(loaded.repos.B.integrationBranch, "trunk");
  });
});

test("COORD-010: loadProjectConfig honors COORD_PROJECT_CONFIG as the config-matrix seam", () => {
  const original = process.env.COORD_PROJECT_CONFIG;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord010-configenv-"));
  // A coordDir-local project.config.js the override must take precedence over.
  fs.writeFileSync(
    path.join(tmp, "project.config.js"),
    `module.exports = { repos: { B: { path: "local-default" } } };\n`,
    "utf8"
  );
  const fixturePath = path.join(tmp, "fixture.config.js");
  fs.writeFileSync(
    fixturePath,
    `module.exports = { repos: { Z: { path: "override-repo", integrationBranch: "devx" } } };\n`,
    "utf8"
  );
  try {
    // Unset -> coordDir-local config wins.
    delete process.env.COORD_PROJECT_CONFIG;
    assert.equal(pathsApi.loadProjectConfig(tmp).repos.B.path, "local-default");
    // Set -> the override file is loaded instead, regardless of coordDir.
    process.env.COORD_PROJECT_CONFIG = fixturePath;
    const overridden = pathsApi.loadProjectConfig(tmp);
    assert.equal(overridden.repos.Z.path, "override-repo");
    assert.equal(overridden.repos.B, undefined, "override fully replaces the coordDir-local config");
    // resolveProjectConfigPath reports the override path.
    assert.equal(pathsApi.resolveProjectConfigPath(tmp), path.resolve(fixturePath));
  } finally {
    if (original === undefined) {
      delete process.env.COORD_PROJECT_CONFIG;
    } else {
      process.env.COORD_PROJECT_CONFIG = original;
    }
  }
});

test("GCV-4 slice 1: absolute repo path is honored (not joined under rootDir)", () => {
  const paths = createCoordPaths({
    coordDir,
    rootDir,
    projectConfig: { repos: { B: { path: "/abs/elsewhere/backend" } } },
  });
  assert.equal(paths.repoRoots.B, "/abs/elsewhere/backend");
});

test("GCV-4 slice 1: absolute requirements path is honored (not joined under coordDir)", () => {
  const paths = createCoordPaths({
    coordDir,
    rootDir,
    projectConfig: {
      repos: { B: { path: "backend" } },
      requirements: { path: "/abs/specs/REQUIREMENTS.md" },
    },
  });
  assert.equal(paths.requirementsPath, "/abs/specs/REQUIREMENTS.md");
});

test("allBoardRepoCodes returns every configured repo plus the reserved X code, sorted", () => {
  const configured = Object.keys(pathsApi.createCoordPaths().repoRoots);
  assert.deepEqual(allBoardRepoCodes(), [...new Set([...configured, "X"])].sort());
});

test("allBoardRepoCodes reflects a caller-supplied paths object with a new repo letter (e.g. mobile)", () => {
  const result = allBoardRepoCodes({
    repoRoots: { B: "/tmp/backend", F: "/tmp/frontend", M: "/tmp/mobile" },
  });
  assert.deepEqual(result, ["B", "F", "M", "X"]);
});

test("allBoardRepoCodes keeps X once even if the supplied repoRoots already includes it", () => {
  const result = allBoardRepoCodes({ repoRoots: { X: "/tmp/coord", B: "/tmp/backend" } });
  assert.deepEqual(result, ["B", "X"]);
});

// COORD-895: the coord workspace (board) branch is one project-config seam.
test("COORD-895: boardBranch is configurable, defaults to main, and stays null-when-unset for derivation", () => {
  // COORD-916: an engine-installed coord root of this test's own, never a
  // shared /tmp/coord that concurrent runs on the host install and delete.
  const coordRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord895-board-branch-"));
  installCanonicalEngine(coordRoot, path.resolve(__dirname, ".."));
  try {
    const unset = createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {} } });
    assert.equal(unset.boardBranch, pathsApi.DEFAULT_BOARD_BRANCH);
    assert.equal(pathsApi.DEFAULT_BOARD_BRANCH, "main");
    assert.equal(unset.controlPlaneIntegrationBranch, null, "unset stays null so origin/HEAD derivation still applies");
    const set = createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {}, boardBranch: " release/board " } });
    assert.equal(set.boardBranch, "release/board");
    assert.equal(set.controlPlaneIntegrationBranch, "release/board");
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {}, boardBranch: null } }).boardBranch, "main");
  } finally {
    fs.rmSync(coordRoot, { recursive: true, force: true });
  }
});

test("COORD-895: a malformed boardBranch fails at config load", () => {
  for (const bad of [42, "", "-x", "a..b", "a b", "origin/main", "refs/heads/main", "trailing/", "x//y", "a@{1}"]) {
    assert.throws(
      () => pathsApi.validateProjectConfig({ repos: {}, boardBranch: bad }),
      /`boardBranch` must be a plain branch name/,
      `rejects ${JSON.stringify(bad)}`
    );
  }
});

// COORD-895 acceptance (2): no engine site hard-codes the board branch. Every
// remaining `main` literal in engine code is inventoried here with the reason it
// is NOT the board branch; a new literal (or a stale entry) fails this test.
// Route a new board-branch use through `paths.boardBranch` /
// `configuredBoardBranch(layout)` / `resolveControlPlaneIntegrationBranch`.
const MAIN_LITERAL_ALLOWLIST = Object.freeze({
  "coord/paths.js": [1, "DEFAULT_BOARD_BRANCH: the single engine default for the board branch"],
  "coord/engine/scripts/__fixtures__/integration-authority-context.js": [1, "fixture pins an independent integration-authority context"],
  "coord/engine/scripts/hooks/hook-lib.js": [1, "COORD_WORKSPACE_BRANCH: fail-closed fallback when no config loads (acceptance 1)"],
  "coord/engine/scripts/arch-checks.js": [3, "arch ratchet baseline candidates for the donor repository, not the board"],
  "coord/engine/scripts/auto-mode-containment.js": [1, "generic protected-branch default list for auto-mode policy"],
  "coord/engine/scripts/business-context-pack-test-fixtures.js": [2, "product-repo integrationBranch in a test fixture"],
  "coord/engine/scripts/control-plane-push.js": [2, "error text quoting a measured force-push refspec"],
  "coord/engine/scripts/coord-init-wizard.js": [1, "product-repo integrationBranch default for a new install"],
  "coord/engine/scripts/coord-init.js": [2, "product-repo integrationBranch in the scaffolded starter config"],
  "coord/engine/scripts/onboard.js": [5, "product-repo integrationBranch detection during onboarding (incl. origin/main ref detection, COORD-898)"],
  "coord/engine/scripts/onboarding-existing-config.js": [1, "product-repo integrationBranch default when importing a config"],
  "coord/engine/scripts/session-lifecycle-worker.js": [9, "conformance worker fixture seeds main and adds dev as its integration branch"],
  "coord/engine/scripts/upgrade-release-source.js": [1, "the upstream Concord release repository's branch, not the adopter board"],
  "coord/scripts/preflight.sh": [1, "refuses work directly on a dev/main checkout of the current repository"],
});
const MAIN_LITERAL_RE = /(["'`])(?:origin\/|refs\/heads\/|HEAD:)?main\1|\borigin\/main\b|refs\/heads\/main\b/g;

function engineMainLiteralCounts(coordRoot) {
  const workspace = path.dirname(coordRoot);
  const files = [path.join(coordRoot, "paths.js"), path.join(coordRoot, "board", "board.js")];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(?:c?js|mjs|sh)$/.test(entry.name) && !entry.name.endsWith(".test.js")) {
        files.push(full);
      }
    }
  };
  walk(path.join(coordRoot, "engine", "scripts"));
  walk(path.join(coordRoot, "scripts"));
  const counts = {};
  for (const file of files) {
    let count = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (/^(?:\/\/|\*|\/\*|#)/.test(trimmed)) continue; // prose, not a literal in code
      count += (line.match(MAIN_LITERAL_RE) || []).length;
    }
    if (count) counts[path.relative(workspace, file).split(path.sep).join("/")] = count;
  }
  return counts;
}

test("COORD-895: no engine site hard-codes the board branch (every main literal is inventoried)", () => {
  const counts = engineMainLiteralCounts(path.resolve(__dirname, ".."));
  const expected = Object.fromEntries(Object.entries(MAIN_LITERAL_ALLOWLIST).map(([file, [count]]) => [file, count]));
  assert.deepEqual(
    counts,
    expected,
    "a new \"main\" literal in engine code: read the board branch from paths.boardBranch instead, " +
      "or inventory a non-board use in MAIN_LITERAL_ALLOWLIST with its reason"
  );
});

test("COORD-895: the literal scan sees code, ignores prose, and counts every board-branch spelling", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord895-scan-"));
  try {
    const coordRoot = path.join(tmp, "coord");
    fs.mkdirSync(path.join(coordRoot, "engine", "scripts", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(coordRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(coordRoot, "board"), { recursive: true });
    fs.writeFileSync(path.join(coordRoot, "paths.js"), "const a = 'main';\n");
    fs.writeFileSync(path.join(coordRoot, "board", "board.js"), "// base_ref: \"main\"\nconst b = 1;\n");
    fs.writeFileSync(path.join(coordRoot, "engine", "scripts", "x.js"), "git(['push', 'origin', \"HEAD:main\"]);\nrun(`origin/main`, \"refs/heads/main\");\n");
    fs.writeFileSync(path.join(coordRoot, "engine", "scripts", "x.test.js"), "const t = \"main\";\n");
    fs.writeFileSync(path.join(coordRoot, "engine", "scripts", "node_modules", "dep.js"), "const d = \"main\";\n");
    fs.writeFileSync(path.join(coordRoot, "scripts", "y.sh"), "# main\n[[ $b == \"main\" ]]\n");
    assert.deepEqual(engineMainLiteralCounts(coordRoot), {
      "coord/paths.js": 1,
      "coord/engine/scripts/x.js": 3,
      "coord/scripts/y.sh": 1,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-894: boardLanding selects how finalize/land publishes the board commit.
test("COORD-894: boardLanding defaults to push, accepts pr, and rejects anything else", () => {
  // COORD-916: an engine-installed coord root of this test's own, never a
  // shared /tmp/coord that concurrent runs on the host install and delete.
  const coordRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord894-board-landing-"));
  installCanonicalEngine(coordRoot, path.resolve(__dirname, ".."));
  try {
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {} } }).boardLanding, "push");
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {}, boardLanding: null } }).boardLanding, "push");
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {}, boardLanding: "pr" } }).boardLanding, "pr");
    assert.deepEqual(pathsApi.BOARD_LANDING_MODES, ["push", "pr"]);
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {} } }).boardLandingWaitSeconds, pathsApi.DEFAULT_BOARD_LANDING_WAIT_SECONDS);
    assert.equal(pathsApi.DEFAULT_BOARD_LANDING_WAIT_SECONDS, 300);
    assert.equal(createCoordPaths({ coordDir: coordRoot, projectConfig: { repos: {}, boardLandingWaitSeconds: 0 } }).boardLandingWaitSeconds, 0);
    for (const bad of [-1, 1.5, 3601, "60"]) {
      assert.throws(() => pathsApi.validateProjectConfig({ repos: {}, boardLandingWaitSeconds: bad }), /`boardLandingWaitSeconds` must be an integer from 0 to 3600/);
    }
    for (const bad of ["PR", "merge", "", 1]) {
      assert.throws(() => pathsApi.validateProjectConfig({ repos: {}, boardLanding: bad }), /`boardLanding` must be "push" or "pr"/);
    }
  } finally {
    fs.rmSync(coordRoot, { recursive: true, force: true });
  }
});
