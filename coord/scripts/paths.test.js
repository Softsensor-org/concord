const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pathsApi = require("../paths.js");
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
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
  }));

  assert.equal(paths.boardPath, "/tmp/coord/board/tasks.json");
  assert.equal(paths.planRecordsDir, "/tmp/coord/.runtime/plans");
  assert.equal(paths.legacyPlanRecordsDir, "/tmp/coord/board/plans");
  assert.equal(paths.renderedDir, "/tmp/coord/rendered");
  assert.equal(paths.renderedTasksMdPath, "/tmp/coord/rendered/TASKS.md");
  assert.equal(paths.renderedPromptIndexMdPath, "/tmp/coord/rendered/PROMPT_INDEX.md");
  assert.equal(paths.planPath, "/tmp/coord/PLAN.md");
  assert.equal(paths.agentsPath, "/tmp/coord/.runtime/agents.json");
  assert.equal(paths.legacyAgentsPath, "/tmp/coord/agents.json");
  assert.equal(paths.agentSessionsPath, "/tmp/coord/.runtime/agent_sessions.json");
  assert.equal(paths.legacyAgentSessionsPath, "/tmp/coord/agent_sessions.json");
  assert.equal(paths.locksDir, "/tmp/coord/.runtime/locks");
  assert.equal(paths.legacyLocksDir, "/tmp/coord/locks");
  assert.equal(paths.runtimeDir, "/tmp/coord/.runtime");
  assert.equal(paths.sessionThreadsDir, "/tmp/coord/.runtime/session-threads");
  assert.equal(paths.governanceEventLogPath, "/tmp/coord/.runtime/governance-events.ndjson");
  assert.equal(paths.governanceSnapshotPath, "/tmp/coord/.runtime/governance-latest-snapshot.json");
  assert.equal(paths.governanceSnapshotsDir, "/tmp/coord/.runtime/governance-snapshots");
  assert.equal(paths.repoRoots.B, "/tmp/backend");
  assert.equal(paths.repoRoots.F, "/tmp/frontend");
});

test("createCoordPaths derives a registry-driven repoIntegrationBranches map defaulting to dev", () => {
  // COORD-010: pins the template default; clear the matrix env override so
  // the "dev" default holds regardless of which matrix leg runs this.
  const paths = withDefaultProjectConfigEnv(() => createCoordPaths({
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
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
// coord/docs/GCV4_ENGINE_CONFIG_SEAM.md. Each fixture proves a representative
// downstream shape derives correct paths WITHOUT hand-editing engine code.

test("GCV-4 slice 1 fixture: template default (B=backend, F=frontend) — proves the upstream baseline", () => {
  const paths = createCoordPaths({
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
    projectConfig: {
      repos: {
        B: { path: "backend", integrationBranch: "dev", origin: null, legacyAliases: [] },
        F: { path: "frontend", integrationBranch: "dev", origin: null, legacyAliases: [] },
      },
      requirements: { path: "product/REQUIREMENTS.md" },
    },
  });
  assert.deepEqual(paths.repoRoots, { B: "/tmp/backend", F: "/tmp/frontend" });
  assert.deepEqual(paths.repoOrigins, { B: null, F: null });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "dev", F: "dev" });
  assert.deepEqual(paths.repoRegistry, { B: "backend", F: "frontend" });
  assert.deepEqual(paths.legacyRepoAliases, { B: [], F: [] });
  assert.equal(paths.requirementsPath, "/tmp/coord/product/REQUIREMENTS.md");
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
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
    projectConfig: {
      repos: {
        B: { path: "msrv", integrationBranch: "dev" },
        F: { path: "frontend", integrationBranch: "dev" },
      },
    },
  });
  // Matches what acme-ops/coord's hand-merged inline REPO_REGISTRY = { B:"msrv",
  // F:"frontend" } produced before — but here it's CONFIG, not engine code.
  assert.deepEqual(paths.repoRoots, { B: "/tmp/msrv", F: "/tmp/frontend" });
  assert.deepEqual(paths.repoIntegrationBranches, { B: "dev", F: "dev" });
  assert.deepEqual(paths.repoRegistry, { B: "msrv", F: "frontend" });
});

test("GCV-4 slice 1 fixture: acme shape (B=acme-api, C=acme-cam, devx) — three repos + non-dev branch derive cleanly", () => {
  const paths = createCoordPaths({
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
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
    B: "/tmp/acme-api",
    C: "/tmp/acme-cam",
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-gcv4-loadconfig-"));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-coord010-configenv-"));
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
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
    projectConfig: { repos: { B: { path: "/abs/elsewhere/backend" } } },
  });
  assert.equal(paths.repoRoots.B, "/abs/elsewhere/backend");
});

test("GCV-4 slice 1: absolute requirements path is honored (not joined under coordDir)", () => {
  const paths = createCoordPaths({
    coordDir: "/tmp/coord",
    rootDir: "/tmp",
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
