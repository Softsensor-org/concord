// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createRepoRegistry = require("./repo-registry.js");
const { DEFAULT_PATHS } = require("./governance-context.js");
// COORD-486: only the final lifecycle WIRING test (canonical board -> repo code
// through lifecycle's own readBoard) still uses the __testing facade; every
// module behavior test builds createRepoRegistry with a scoped context.
const { __testing, withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));

// COORD-071: these tests are config-AWARE so they pass under BOTH legs of the
// config matrix (default coord/project.config.js AND the synthetic non-default
// fixture). Expected values are derived from the live registry derived by
// coord/paths.js rather than hardcoded "backend"/"FE"/"COORD" literals.
const REPO_REGISTRY = DEFAULT_PATHS.repoRegistry || {};
const TICKET_PREFIX_TO_REPO_CODE = DEFAULT_PATHS.ticketPrefixToRepoCode || {};
const REPO_INTEGRATION_BRANCHES = DEFAULT_PATHS.repoIntegrationBranches || {};

// A product repo code that exists in the active registry (B in both legs).
const SAMPLE_CODE = Object.keys(REPO_REGISTRY).sort()[0];
const SAMPLE_DIR = REPO_REGISTRY[SAMPLE_CODE];
// A configured ticket prefix -> code pair, if any prefixes are configured.
const SAMPLE_PREFIX_ENTRY = Object.entries(TICKET_PREFIX_TO_REPO_CODE)[0] || null;

function build(boardRows = {}) {
  return createRepoRegistry({
    readBoard: () => ({ rows: boardRows }),
    getTicketRef: (board, ticketId) =>
      boardRows[ticketId] ? { row: boardRows[ticketId] } : null,
  });
}

test("repoPrefixForCode maps X to coord/ and codes to their config prefix", () => {
  const r = build();
  assert.equal(r.repoPrefixForCode("X"), "coord/");
  assert.equal(r.repoPrefixForCode(SAMPLE_CODE), `${SAMPLE_DIR}/`);
  assert.equal(r.repoPrefixForCode("Z"), null);
});

test("isRepoBackedCode / isProductRepo distinguish product repos from coord", () => {
  const r = build();
  assert.equal(r.isRepoBackedCode(SAMPLE_CODE), true);
  assert.equal(r.isRepoBackedCode("X"), false);
  assert.equal(r.isRepoBackedCode("Z"), false);
  assert.equal(r.isProductRepo({ Repo: SAMPLE_CODE }), true);
  assert.equal(r.isProductRepo("X"), false);
});

test("repoNameForCode resolves names; X is coord, unknown echoes input", () => {
  const r = build();
  assert.equal(r.repoNameForCode("X"), "coord");
  assert.equal(r.repoNameForCode(SAMPLE_CODE), SAMPLE_DIR);
  assert.equal(r.repoNameForCode("Z"), "Z");
});

test("inferRepoCodeFromTicketId maps configured prefixes; unconfigured -> X", () => {
  const r = build();
  if (SAMPLE_PREFIX_ENTRY) {
    const [prefix, code] = SAMPLE_PREFIX_ENTRY;
    assert.equal(r.inferRepoCodeFromTicketId(`${prefix}-12`), code);
  }
  // An unconfigured prefix falls back to the reserved coord/cross-repo code.
  assert.equal(r.inferRepoCodeFromTicketId("ZZZUNCONFIGURED-5"), "X");
});

test("resolveRepoCodeForTicket prefers row.Repo, then board, then heuristic", () => {
  const prefixEntry = SAMPLE_PREFIX_ENTRY || ["ZZZUNCONFIGURED", "X"];
  const [prefix, code] = prefixEntry;
  const r = build({ [`${prefix}-9`]: { Repo: code } });
  // explicit row wins
  assert.equal(r.resolveRepoCodeForTicket("X-1", { Repo: SAMPLE_CODE }), SAMPLE_CODE);
  // board lookup
  assert.equal(r.resolveRepoCodeForTicket(`${prefix}-9`), code);
  // heuristic fallback when board has nothing
  assert.equal(r.resolveRepoCodeForTicket(`${prefix}-404`), code);
});

test("resolveRepoIntegrationBranch returns configured branch", () => {
  const r = build();
  assert.equal(
    r.resolveRepoIntegrationBranch(SAMPLE_CODE),
    REPO_INTEGRATION_BRANCHES[SAMPLE_CODE]
  );
  // Unknown codes fall back to the engine default integration branch.
  assert.equal(
    r.resolveRepoIntegrationBranch("Z"),
    require("../../paths.js").DEFAULT_INTEGRATION_BRANCH
  );
});

test("repoCodeForLockRepoName round-trips names/aliases back to codes", () => {
  const r = build();
  assert.equal(r.repoCodeForLockRepoName("coord"), "X");
  assert.equal(r.repoCodeForLockRepoName(SAMPLE_DIR), SAMPLE_CODE);
  assert.equal(r.repoCodeForLockRepoName("nope-not-a-repo"), null);
});

test("repoCliAliasesForCode and configuredRepoArgDescription enumerate accepted args", () => {
  const r = build();
  const aliases = r.repoCliAliasesForCode(SAMPLE_CODE);
  assert.ok(aliases.includes(SAMPLE_CODE) && aliases.includes(SAMPLE_DIR));
  assert.equal(r.repoCliAliasesForCode("X").length, 0);
  const desc = r.configuredRepoArgDescription();
  assert.ok(desc.includes(SAMPLE_DIR));
});

test("repoCodeForCliRepoArg accepts codes and names", () => {
  const r = build();
  assert.equal(r.repoCodeForCliRepoArg(SAMPLE_CODE), SAMPLE_CODE);
  assert.equal(r.repoCodeForCliRepoArg(SAMPLE_DIR), SAMPLE_CODE);
  assert.equal(r.repoCodeForCliRepoArg(""), null);
});

// ---------------------------------------------------------------------------
// COORD-090: relocated from governance.test.js (repo-registry module behavior:
// prefix/alias resolution, repo-name/CLI-arg derivation, integration branch).
// COORD-486: these used to swap process-global maps through lifecycle's testing
// path registry and restore them in `finally`. They now build the
// owning factory with a SCOPED context, so no fixture can leak into another test.
// ---------------------------------------------------------------------------

function cloneMap(map) {
  return Object.fromEntries(
    Object.entries(map || {}).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
  );
}

function scopedContext(overrides = {}) {
  return {
    repoRoots: cloneMap(DEFAULT_PATHS.repoRoots),
    repoIntegrationBranches: cloneMap(DEFAULT_PATHS.repoIntegrationBranches),
    repoRegistry: cloneMap(DEFAULT_PATHS.repoRegistry),
    legacyRepoAliases: cloneMap(DEFAULT_PATHS.legacyRepoAliases),
    ticketPrefixToRepoCode: cloneMap(DEFAULT_PATHS.ticketPrefixToRepoCode),
    ...overrides,
  };
}

function buildScoped(overrides = {}, boardRows = {}) {
  return createRepoRegistry({
    readBoard: () => ({ rows: boardRows }),
    getTicketRef: (board, ticketId) => (boardRows[ticketId] ? { row: boardRows[ticketId] } : null),
    context: scopedContext(overrides),
  });
}

function snapshotProcessRepoMaps() {
  return JSON.stringify({
    repoRoots: DEFAULT_PATHS.repoRoots,
    repoIntegrationBranches: DEFAULT_PATHS.repoIntegrationBranches,
    repoRegistry: DEFAULT_PATHS.repoRegistry,
    legacyRepoAliases: DEFAULT_PATHS.legacyRepoAliases,
    ticketPrefixToRepoCode: DEFAULT_PATHS.ticketPrefixToRepoCode,
  });
}

test("repoPrefixesForCode returns canonical and legacy aliases for renamed repos", () => {
  const base = scopedContext();
  const r = buildScoped({
    repoRegistry: { ...base.repoRegistry, B: "msrv" },
    legacyRepoAliases: { ...base.legacyRepoAliases, B: ["backend", " ", null, "./legacy-b/"] },
  });
  assert.equal(r.repoPrefixForCode("B"), "msrv/");
  assert.deepEqual(r.repoPrefixesForCode("B"), ["msrv/", "backend/", "legacy-b/"],
    "blank/null aliases are skipped and ./ + trailing slashes normalize");
  assert.deepEqual(r.repoPrefixesForCode("X"), ["coord/"]);
  assert.equal(r.repoPrefixForCode("Z"), null);
  assert.deepEqual(r.repoPrefixesForCode("Z"), []);
});

test("COORD-486: a registry entry that normalizes to empty has no repo prefix", () => {
  const r = buildScoped({ repoRegistry: { B: "./" }, legacyRepoAliases: {} });
  assert.equal(r.repoPrefixForCode("B"), null);
  assert.deepEqual(r.repoPrefixesForCode("B"), []);
});

test("repo labels and repo CLI args derive from project config before repoRoot basename", () => {
  const base = scopedContext();
  const r = buildScoped({
    repoRoots: { ...base.repoRoots, B: "/tmp/project/packages/server" },
    repoRegistry: { ...base.repoRegistry, B: "packages/server" },
    legacyRepoAliases: { ...base.legacyRepoAliases, B: ["backend"] },
  });
  assert.equal(r.repoNameForCode("B"), "packages/server");
  assert.equal(r.repoCodeForLockRepoName("packages/server"), "B");
  assert.equal(r.repoCodeForLockRepoName("/tmp/project/packages/server"), "B", "the absolute root matches");
  assert.equal(r.repoCodeForLockRepoName("backend"), "B");
  assert.equal(r.repoCodeForLockRepoName("server"), "B");
  assert.equal(r.repoCodeForCliRepoArg("B"), "B");
  assert.equal(r.repoCodeForCliRepoArg("packages/server"), "B");
  assert.equal(r.repoCodeForCliRepoArg("server"), "B");
});

test("COORD-486: an unregistered repo falls back to its on-disk root basename; a missing root fails closed", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord486-repo-root-"));
  try {
    const root = path.join(dir, "svc-api");
    fs.mkdirSync(root);
    const r = buildScoped({
      repoRoots: { X: dir, B: root, F: path.join(dir, "absent") },
      repoRegistry: {},
      legacyRepoAliases: {},
    });
    assert.equal(r.repoNameForCode("B"), "svc-api");
    assert.equal(r.getRepoRoot("B"), root);
    assert.deepEqual(r.repoCliAliasesForCode("B"), ["B", root, "svc-api"].sort(),
      "no configured name and no legacy aliases: code + root + basename only");
    assert.throws(() => r.repoNameForCode("F"), /does not exist at .*absent/);
    assert.throws(() => r.getRepoRoot("Q"), /Unsupported repo code "Q"/);
    assert.equal(r.repoDisplayNameForCode("B"), "svc-api");
    assert.equal(r.repoCodeForLockRepoName(path.basename(dir)), null,
      "the reserved X root is skipped when matching lock repo names");
    const aliased = buildScoped({ repoRoots: { B: root }, repoRegistry: {}, legacyRepoAliases: { B: ["old-api"] } });
    assert.deepEqual(aliased.repoCliAliasesForCode("B"), ["B", "old-api", root, "svc-api"].sort());
    assert.equal(r.configuredRepoArgDescription(), ["B", "F", "absent", root, path.join(dir, "absent"), "svc-api"].sort().join(", "),
      "the reserved X root is never offered as a repo argument");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-486: a blank or missing repo code is never repo-backed", () => {
  const r = buildScoped();
  assert.equal(r.isRepoBackedCode(""), false);
  assert.equal(r.isRepoBackedCode(undefined), false);
  assert.equal(r.repoNameForCode(undefined), "unknown");
  assert.equal(r.repoCodeForLockRepoName(""), "X");
});

test("COORD-022: resolveRepoIntegrationBranch honors configured branch and defaults to dev", () => {
  const r = buildScoped({ repoIntegrationBranches: { B: "main", F: "dev" } });
  assert.equal(r.resolveRepoIntegrationBranch("B"), "main");
  assert.equal(r.resolveRepoIntegrationBranch("F"), "dev");
  // Unconfigured repo falls back to the historical "dev" default.
  assert.equal(r.resolveRepoIntegrationBranch("Z"), "dev");
});

test("COORD-486: two scoped registries are isolated from each other and from process path state", () => {
  const before = snapshotProcessRepoMaps();
  const one = buildScoped({
    repoRoots: { B: "/fixture-one/api" },
    repoRegistry: { B: "api" },
    legacyRepoAliases: { B: ["old-api"] },
    repoIntegrationBranches: { B: "main" },
    ticketPrefixToRepoCode: { ONE: "B" },
  });
  const two = buildScoped({
    repoRoots: { F: "/fixture-two/web" },
    repoRegistry: { F: "web" },
    legacyRepoAliases: {},
    repoIntegrationBranches: { F: "trunk" },
    ticketPrefixToRepoCode: { TWO: "F" },
  });
  assert.equal(one.repoPrefixForCode("B"), "api/");
  assert.equal(two.repoPrefixForCode("B"), null, "context two never sees context one's B");
  assert.equal(two.repoPrefixForCode("F"), "web/");
  assert.equal(one.repoPrefixForCode("F"), null, "context one never sees context two's F");
  assert.equal(one.resolveRepoIntegrationBranch("B"), "main");
  assert.equal(two.resolveRepoIntegrationBranch("F"), "trunk");
  assert.equal(one.inferRepoCodeFromTicketId("ONE-1"), "B");
  assert.equal(one.inferRepoCodeFromTicketId("TWO-1"), "X");
  assert.equal(one.inferRepoCodeFromTicketId(undefined), "X", "a missing id infers the coord code");
  assert.equal(two.inferRepoCodeFromTicketId("TWO-1"), "F");
  assert.equal(one.repoCodeForLockRepoName("old-api"), "B");
  assert.equal(two.repoCodeForLockRepoName("old-api"), null);
  assert.equal(snapshotProcessRepoMaps(), before, "scoped registries never touch DEFAULT_PATHS");
  assert.equal(build().repoPrefixForCode(SAMPLE_CODE), `${SAMPLE_DIR}/`,
    "a default-context registry still resolves the live configured registry");
});

test("COORD-486: resolveRepoCodeForTicket falls back to the id heuristic when the board read throws", () => {
  const r = createRepoRegistry({
    readBoard: () => { throw new Error("board unavailable"); },
    getTicketRef: () => assert.fail("never reached"),
    context: scopedContext({ ticketPrefixToRepoCode: { ONE: "B" } }),
  });
  assert.equal(r.resolveRepoCodeForTicket("ONE-7"), "B");
  assert.equal(r.resolveRepoCodeForTicket("ZZZ-7"), "X");
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


test("resolveRepoCodeForTicket prefers canonical board repo metadata over ticket-id prefixes", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const [prefix, inferred] = SAMPLE_PREFIX_ENTRY || ["UNCONFIGURED", "X"];
  const assigned = Object.keys(REPO_REGISTRY).find(code => code !== inferred) || "X";
  const id = `${prefix}-999993`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord693-board-repo-"));
  const boardPath = path.join(dir, "tasks.json");
  withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
    try {
    fs.writeFileSync(boardPath,
      JSON.stringify({ sections: [{ rows: [{ ID: id, Repo: assigned }] }] }));
    assert.notEqual(assigned, inferred);
    assert.equal(build().inferRepoCodeFromTicketId(id), inferred);
    assert.equal(__testing.resolveRepoCodeForTicket(id), assigned);
    fs.unlinkSync(boardPath);
    assert.equal(__testing.resolveRepoCodeForTicket(id), inferred);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  });
});
