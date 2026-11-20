"use strict";

// COORD-283: owner-factory and lifecycle composition coverage for
// testing-infra-audit.js.
//
// The six testing-infrastructure audit/classification helpers
// (extractPackageScriptsFromCommands, buildTestingInfrastructureClassificationText,
// isTestingInfrastructureTicket, normalizeTestingInfraAuditPath,
// listCommitTouchedPaths, readJsonFileFromRef) were moved out of lifecycle.js into
// the createTestingInfraAudit factory. lifecycle.js re-wires them with deferred
// `(...a)=>fn(...a)` wrappers (REPO_ROOTS / PNPM_BUILTIN_COMMANDS /
// TESTING_INFRA_DESCRIPTION_PATTERN injected by reference) and re-destructures the
// six names back into scope so the `commands` dispatch and audit call sites
// (deriveTestingInfrastructureAudit,
// extractFileReferencesFromCommands) still resolve.
//
// Coverage:
//   1. FACTORY BEHAVIOR — classification and path normalization use the owner
//      factory and real path/registry collaborators.
//   2. FACTORY UNIT — the remaining helpers
//      (extractPackageScriptsFromCommands, buildTestingInfrastructureClassificationText,
//      listCommitTouchedPaths, readJsonFileFromRef) are exercised directly against
//      createTestingInfraAudit with stubbed deps, asserting behavior-preserving
//      logic.

const test = require("node:test");
const assert = require("node:assert/strict");

const { withScopedGovernanceTestContext } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js"));
const { DEFAULT_PATHS } = require("./governance-context.js");
const createTestingInfraAudit = require("./testing-infra-audit.js");
const { createTestingInfrastructureLandingAudit } = require("./testing-infra-audit.js");
const createTestingInfraPaths = require("./testing-infra-paths.js");
const createRepoRegistry = require("./repo-registry.js");
const createPlanRecords = require("./plan-records.js");
const { escapeRegex, toArray } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/lifecycle-utils.js"));
const lifecycle = require("./lifecycle.js");

// ---------------------------------------------------------------------------
// 1. WIRING GUARD — through the live lifecycle `__testing` facade
// ---------------------------------------------------------------------------

test("COORD-283: isTestingInfrastructureTicket behavior is owned by the module factory", () => {
  const audit = createTestingInfraAuditFixture();
  // QGATE-* tickets are always testing-infra.
  assert.equal(audit.isTestingInfrastructureTicket({ ID: "QGATE-1", Description: "x" }), true);
  // Description-pattern match.
  assert.equal(
    audit.isTestingInfrastructureTicket({ ID: "X-1", Description: "update test infrastructure lanes" }),
    true
  );
  // A plain feature ticket is not testing-infra.
  assert.equal(audit.isTestingInfrastructureTicket({ ID: "X-2", Description: "add a button" }), false);
  // Generic package/readme edits alone do not turn a feature into a testing-infra ticket.
  assert.equal(
    audit.isTestingInfrastructureTicket(
      { ID: "X-3", Repo: "B", Description: "update general docs" },
      { intended_files: ["package.json", "README.md"] },
    ),
    false,
  );
  assert.equal(lifecycle.__testing.isTestingInfrastructureTicket, undefined);
  assert.equal(lifecycle.__testing.normalizeTestingInfraAuditPath, undefined);
});

test("normalizeTestingInfraAuditPath strips canonical and legacy repo prefixes", () => {
  withScopedGovernanceTestContext({
    repoRegistry: { ...DEFAULT_PATHS.repoRegistry, B: "msrv" },
    legacyRepoAliases: { ...DEFAULT_PATHS.legacyRepoAliases, B: ["backend"] },
  }, () => {
    const audit = createTestingInfraAuditFixture();
    assert.equal(
      audit.normalizeTestingInfraAuditPath("B", "MSRV-100", "msrv/vitest.config.ts"),
      "vitest.config.ts"
    );
    assert.equal(
      audit.normalizeTestingInfraAuditPath("B", "MSRV-100", "backend/vitest.config.ts"),
      "vitest.config.ts"
    );
    assert.equal(
      audit.normalizeTestingInfraAuditPath("B", "MSRV-100", "msrv/.worktrees/codexa00/MSRV-100/vitest.config.ts"),
      "vitest.config.ts"
    );
    // Paths from a different repo should be rejected. COORD-006: derive the
    // foreign-repo prefix from the live registry (F repo) so this holds under
    // any registry, not only the template default where F maps to "frontend".
    const foreignRepoPrefix = createRepoRegistry({ context: DEFAULT_PATHS }).repoNameForCode("F");
    assert.equal(
      audit.normalizeTestingInfraAuditPath("B", "MSRV-100", `${foreignRepoPrefix}/vitest.config.ts`),
      null
    );
    for (const value of ["", "   ", "*", "msrv/*"]) {
      assert.equal(audit.normalizeTestingInfraAuditPath("B", "MSRV-100", value), null, `reject ${JSON.stringify(value)}`);
    }
    assert.equal(audit.normalizeTestingInfraAuditPath("B", "MSRV-100", "msrv/../outside.test.js"), "outside.test.js");
    assert.equal(audit.normalizeTestingInfraAuditPath("?", "X-1", "vitest.config.ts"), null);
  });
});

// ---------------------------------------------------------------------------
// 2. FACTORY UNIT — direct against createTestingInfraAudit with stubbed deps
// ---------------------------------------------------------------------------

function tokenizeShellWords(value) {
  return (String(value || "").match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^\s]+/g) || [])
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

const PNPM_BUILTIN_COMMANDS = new Set(["install", "add", "remove", "test", "run"]);

function createTestingInfraAuditFixture() {
  const paths = createTestingInfraPaths({ toArray });
  const registry = createRepoRegistry({ context: DEFAULT_PATHS });
  const planRecords = createPlanRecords();
  return createTestingInfraAudit({
    normalizePlanPathValue: (...args) => planRecords.normalizePlanPathValue(...args),
    repoPrefixesForCode: (...args) => registry.repoPrefixesForCode(...args),
    escapeRegex,
    splitPlanPathValues: (...args) => paths.splitPlanPathValues(...args),
    isTestingInfrastructureFilePath: (...args) => paths.isTestingInfrastructureFilePath(...args),
    tokenizeShellWords: (...args) => paths.tokenizeShellWords(...args),
    REPO_ROOTS: DEFAULT_PATHS.repoRoots,
    PNPM_BUILTIN_COMMANDS,
    TESTING_INFRA_DESCRIPTION_PATTERN: createTestingInfraAudit.TESTING_INFRA_DESCRIPTION_PATTERN,
  });
}

test("extractPackageScriptsFromCommands pulls script names across pnpm/npm/yarn", () => {
  const audit = createTestingInfraAudit({ tokenizeShellWords, PNPM_BUILTIN_COMMANDS });
  assert.deepEqual(
    audit.extractPackageScriptsFromCommands([
      "pnpm run test:unit",
      "pnpm -C packages/app lint",
      "npm run typecheck",
      "yarn build",
      "yarn install",
    ]),
    ["test:unit", "lint", "typecheck", "build"]
  );
  // pnpm builtin subcommands (in PNPM_BUILTIN_COMMANDS) are not treated as scripts.
  assert.deepEqual(audit.extractPackageScriptsFromCommands(["pnpm install"]), []);
  assert.deepEqual(audit.extractPackageScriptsFromCommands([
    "pnpm -r --recursive --workspace-root -C app --dir packages --dir=packages --filter @scope/app --filter=docs run test:ci",
    "pnpm -C=app --dir=packages --filter=docs lint",
    "npm --silent --prefix=app run test:unit",
    "yarn dlx eslint",
    "yarn install",
    "yarn",
    "pnpm",
    "pnpm run",
    "npm run",
    "yarn ';;;',",
  ]), ["test:ci", "lint", "test:unit"]);
  assert.deepEqual(audit.extractPackageScriptsFromCommands(null), []);
});

test("buildTestingInfrastructureClassificationText concatenates id/description/change-summary (pure)", () => {
  const audit = createTestingInfraAudit();
  assert.equal(
    audit.buildTestingInfrastructureClassificationText(
      { ID: "X-1", Description: "do a thing" },
      { change_summary: ["touched gate", "added config"] }
    ),
    "X-1 do a thing touched gate added config"
  );
  // Null plan-state and missing fields degrade gracefully.
  assert.equal(audit.buildTestingInfrastructureClassificationText(null, null), " ");
  const classificationAudit = createTestingInfraAudit({
    TESTING_INFRA_DESCRIPTION_PATTERN: /test infrastructure/i,
    splitPlanPathValues: (values) => Array.isArray(values) ? values : [],
  });
  assert.equal(classificationAudit.isTestingInfrastructureTicket(null), false);
});

test("listCommitTouchedPaths returns trimmed non-empty paths and [] on git failure", () => {
  const okAudit = createTestingInfraAudit({
    gitTry: () => ({ status: 0, stdout: "a/b.test.js\n\n  c/d.ts \n" }),
  });
  assert.deepEqual(okAudit.listCommitTouchedPaths("/repo", "abc123"), ["a/b.test.js", "c/d.ts"]);

  const failAudit = createTestingInfraAudit({ gitTry: () => ({ status: 1, stdout: "" }) });
  assert.deepEqual(failAudit.listCommitTouchedPaths("/repo", "abc123"), []);
  const emptyAudit = createTestingInfraAudit({ gitTry: () => ({ status: 0, stdout: "  \n\n" }) });
  assert.deepEqual(emptyAudit.listCommitTouchedPaths("/repo", "abc123"), []);
  const absentStdoutAudit = createTestingInfraAudit({ gitTry: () => ({ status: 0 }) });
  assert.deepEqual(absentStdoutAudit.listCommitTouchedPaths("/repo", "abc123"), []);
});

test("readJsonFileFromRef parses JSON, returns null on non-zero status or parse error", () => {
  const okAudit = createTestingInfraAudit({
    gitTry: () => ({ status: 0, stdout: '{"name":"pkg","scripts":{"test":"x"}}' }),
  });
  assert.deepEqual(okAudit.readJsonFileFromRef("/repo", "HEAD", "package.json"), {
    name: "pkg",
    scripts: { test: "x" },
  });

  const failAudit = createTestingInfraAudit({ gitTry: () => ({ status: 1, stdout: "" }) });
  assert.equal(failAudit.readJsonFileFromRef("/repo", "HEAD", "package.json"), null);

  const badJsonAudit = createTestingInfraAudit({ gitTry: () => ({ status: 0, stdout: "not json" }) });
  assert.equal(badJsonAudit.readJsonFileFromRef("/repo", "HEAD", "package.json"), null);
  const emptyJsonAudit = createTestingInfraAudit({ gitTry: () => ({ status: 0 }) });
  assert.equal(emptyJsonAudit.readJsonFileFromRef("/repo", "HEAD", "package.json"), null);
});

test("deriveTestingInfrastructureAudit uses landed paths when the record is missing", () => {
  const audit = createTestingInfrastructureLandingAudit({
    DEFAULT_INTEGRATION_BRANCH: "dev",
    REPO_INTEGRATION_BRANCHES: {},
    TESTING_INFRA_LANDING_EVIDENCE_PREFIX: "testing-infra audit:",
    isRepoBackedCode: () => true,
    readPlanRecord: () => null,
    readPlanState: () => null,
    isTestingInfrastructureTicket: () => true,
    getRepoRoot: () => "/repo",
    repoDisplayNameForCode: () => "backend",
    resolveCommitishInRepo: () => "abc123",
    resolveLandingCommitSha: () => null,
    mergeUniqueRefs: (...lists) => lists.flat(),
    splitPlanPathValues: (values) => Array.isArray(values) ? values : [],
    extractFileReferencesFromCommands: () => [],
    normalizeTestingInfraAuditPath: (_repo, _ticket, value) => value,
    isTestingInfrastructureFilePath: (value) => String(value).endsWith(".test.js"),
    listCommitTouchedPaths: () => ["test/runner.test.js"],
    extractPackageScriptsFromCommands: () => [],
    gitPathExistsAtRef: () => true,
    readJsonFileFromRef: () => ({ scripts: {} }),
  });
  const result = audit.deriveTestingInfrastructureAudit(
    "QGATE-13",
    { ID: "QGATE-13", Repo: "B" },
    { base_ref: "dev", commit_sha: "abc123" },
  );
  assert.deepEqual(result.requiredFiles, ["test/runner.test.js"]);
  assert.deepEqual(result.presentFiles, ["test/runner.test.js"]);
  assert.deepEqual(result.requiredScripts, []);
  assert.deepEqual(result.missingScripts, []);
});
