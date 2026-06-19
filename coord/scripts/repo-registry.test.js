"use strict";

const test = require("node:test");
const assert = require("node:assert");
const createRepoRegistry = require("./repo-registry.js");
const { DEFAULT_PATHS } = require("./governance-context.js");
// COORD-090: relocated facade-driven repo-registry behavior tests exercise the
// resolved __testing surface (paths + repo helpers).
const { __testing } = require("./governance-test-utils.js");

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
    require("../paths.js").DEFAULT_INTEGRATION_BRANCH
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
// prefix/alias resolution, repo-name/CLI-arg derivation, integration branch)
// ---------------------------------------------------------------------------

test("repoPrefixesForCode returns canonical and legacy aliases for renamed repos", () => {
  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    __testing.paths.repoRegistry = { ...originalRegistry, B: "msrv" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: ["backend"] };

    assert.equal(__testing.repoPrefixForCode("B"), "msrv/");
    assert.deepEqual(__testing.repoPrefixesForCode("B"), ["msrv/", "backend/"]);
    assert.deepEqual(__testing.repoPrefixesForCode("X"), ["coord/"]);
    assert.equal(__testing.repoPrefixForCode("Z"), null);
    assert.deepEqual(__testing.repoPrefixesForCode("Z"), []);
  } finally {
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
});

test("repo labels and repo CLI args derive from project config before repoRoot basename", () => {
  const originalRoots = { ...__testing.paths.REPO_ROOTS };
  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    __testing.paths.REPO_ROOTS = { ...originalRoots, B: "/tmp/project/packages/server" };
    __testing.paths.repoRegistry = { ...originalRegistry, B: "packages/server" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: ["backend"] };

    assert.equal(__testing.repoNameForCode("B"), "packages/server");
    assert.equal(__testing.repoCodeForLockRepoName("packages/server"), "B");
    assert.equal(__testing.repoCodeForLockRepoName("backend"), "B");
    assert.equal(__testing.repoCodeForLockRepoName("server"), "B");
    assert.equal(__testing.repoCodeForCliRepoArg("B"), "B");
    assert.equal(__testing.repoCodeForCliRepoArg("packages/server"), "B");
    assert.equal(__testing.repoCodeForCliRepoArg("server"), "B");
  } finally {
    __testing.paths.REPO_ROOTS = originalRoots;
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
});

test("COORD-022: resolveRepoIntegrationBranch honors configured branch and defaults to dev", () => {
  const original = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  try {
    __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "main", F: "dev" };
    assert.equal(__testing.resolveRepoIntegrationBranch("B"), "main");
    assert.equal(__testing.resolveRepoIntegrationBranch("F"), "dev");
    // Unconfigured repo falls back to the historical "dev" default.
    assert.equal(__testing.resolveRepoIntegrationBranch("Z"), "dev");
  } finally {
    __testing.paths.REPO_INTEGRATION_BRANCHES = original;
  }
});


// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================


test("resolveRepoCodeForTicket prefers canonical board repo metadata over ticket-id prefixes", () => {
  assert.equal(__testing.resolveRepoCodeForTicket("FE-001"), "F");
});
