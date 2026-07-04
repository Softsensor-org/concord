"use strict";

// COORD-283: unit + DI wiring-guard coverage for the testing-infra-audit.js
// extraction.
//
// The six testing-infrastructure audit/classification helpers
// (extractPackageScriptsFromCommands, buildTestingInfrastructureClassificationText,
// isTestingInfrastructureTicket, normalizeTestingInfraAuditPath,
// listCommitTouchedPaths, readJsonFileFromRef) were moved out of lifecycle.js into
// the createTestingInfraAudit factory. lifecycle.js re-wires them with deferred
// `(...a)=>fn(...a)` wrappers (REPO_ROOTS / PNPM_BUILTIN_COMMANDS /
// TESTING_INFRA_DESCRIPTION_PATTERN injected by reference) and re-destructures the
// six names back into scope so the `commands` dispatch, the `__testing` facade,
// and the audit call sites (deriveTestingInfrastructureAudit,
// extractFileReferencesFromCommands) still resolve.
//
// Two layers of coverage:
//   1. WIRING GUARD — the two facade-exposed names (isTestingInfrastructureTicket,
//      normalizeTestingInfraAuditPath) are driven THROUGH the fully-wired
//      lifecycle `__testing` facade, so a dropped dep / typo'd wrapper / broken
//      re-destructure fails the suite instead of shipping a call-time TypeError.
//      This includes the moved-from-lifecycle registry-prefix behavior test.
//   2. FACTORY UNIT — the four helpers not surfaced on the facade
//      (extractPackageScriptsFromCommands, buildTestingInfrastructureClassificationText,
//      listCommitTouchedPaths, readJsonFileFromRef) are exercised directly against
//      createTestingInfraAudit with stubbed deps, asserting behavior-preserving
//      logic.

const test = require("node:test");
const assert = require("node:assert/strict");

const { __testing } = require("./governance-test-utils.js");
const createTestingInfraAudit = require("./testing-infra-audit.js");

// ---------------------------------------------------------------------------
// 1. WIRING GUARD — through the live lifecycle `__testing` facade
// ---------------------------------------------------------------------------

test("COORD-283 wiring-guard: isTestingInfrastructureTicket resolves through the facade DI seam", () => {
  assert.equal(typeof __testing.isTestingInfrastructureTicket, "function");
  // QGATE-* tickets are always testing-infra.
  assert.equal(__testing.isTestingInfrastructureTicket({ ID: "QGATE-1", Description: "x" }), true);
  // Description-pattern match.
  assert.equal(
    __testing.isTestingInfrastructureTicket({ ID: "X-1", Description: "update test infrastructure lanes" }),
    true
  );
  // A plain feature ticket is not testing-infra.
  assert.equal(__testing.isTestingInfrastructureTicket({ ID: "X-2", Description: "add a button" }), false);
});

test("normalizeTestingInfraAuditPath strips canonical and legacy repo prefixes", () => {
  const originalRegistry = { ...__testing.paths.repoRegistry };
  const originalAliases = Object.fromEntries(
    Object.entries(__testing.paths.legacyRepoAliases).map(([code, aliases]) => [code, [...aliases]])
  );
  try {
    __testing.paths.repoRegistry = { ...originalRegistry, B: "msrv" };
    __testing.paths.legacyRepoAliases = { ...originalAliases, B: ["backend"] };

    assert.equal(
      __testing.normalizeTestingInfraAuditPath("B", "MSRV-100", "msrv/vitest.config.ts"),
      "vitest.config.ts"
    );
    assert.equal(
      __testing.normalizeTestingInfraAuditPath("B", "MSRV-100", "backend/vitest.config.ts"),
      "vitest.config.ts"
    );
    assert.equal(
      __testing.normalizeTestingInfraAuditPath("B", "MSRV-100", "msrv/.worktrees/codexa00/MSRV-100/vitest.config.ts"),
      "vitest.config.ts"
    );
    // Paths from a different repo should be rejected. COORD-006: derive the
    // foreign-repo prefix from the live registry (F repo) so this holds under
    // any registry, not only the template default where F maps to "frontend".
    const foreignRepoPrefix = __testing.repoNameForCode("F");
    assert.equal(
      __testing.normalizeTestingInfraAuditPath("B", "MSRV-100", `${foreignRepoPrefix}/vitest.config.ts`),
      null
    );
  } finally {
    __testing.paths.repoRegistry = originalRegistry;
    __testing.paths.legacyRepoAliases = originalAliases;
  }
});

// ---------------------------------------------------------------------------
// 2. FACTORY UNIT — direct against createTestingInfraAudit with stubbed deps
// ---------------------------------------------------------------------------

function tokenizeShellWords(value) {
  return (String(value || "").match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^\s]+/g) || [])
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

const PNPM_BUILTIN_COMMANDS = new Set(["install", "add", "remove", "test", "run"]);

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
});

test("listCommitTouchedPaths returns trimmed non-empty paths and [] on git failure", () => {
  const okAudit = createTestingInfraAudit({
    gitTry: () => ({ status: 0, stdout: "a/b.test.js\n\n  c/d.ts \n" }),
  });
  assert.deepEqual(okAudit.listCommitTouchedPaths("/repo", "abc123"), ["a/b.test.js", "c/d.ts"]);

  const failAudit = createTestingInfraAudit({ gitTry: () => ({ status: 1, stdout: "" }) });
  assert.deepEqual(failAudit.listCommitTouchedPaths("/repo", "abc123"), []);
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
});
