"use strict";

// COORD-669: owning assertions for the testing-infrastructure path/token
// primitives extracted out of the lifecycle.js composition root.
//
// Before the extraction these four helpers lived in the root and were only ever
// exercised INDIRECTLY — through governance-validation's readiness gate, and
// through testing-infra-audit.test.js, which injects its own LOCAL copy of
// tokenizeShellWords rather than the real one. The extraction therefore may not
// simply preserve coverage; these are the first direct assertions on the real
// implementations. Behavior asserted here is the behavior that shipped in
// lifecycle.js: every function body was moved verbatim.

const test = require("node:test");
const assert = require("node:assert/strict");

const createTestingInfraPaths = require("./testing-infra-paths.js");

function makePaths(overrides = {}) {
  return createTestingInfraPaths({
    // Identity normalizer by default: these tests assert the path/token
    // primitives, not the repo-prefix stripping that testing-infra-audit owns.
    normalizeTestingInfraAuditPath: (repoCode, ticketId, value) => value,
    toArray: (value) => (Array.isArray(value) ? value : value == null ? [] : [value]),
    ...overrides,
  });
}

test("tokenizeShellWords splits on whitespace and unwraps quoted runs", () => {
  const { tokenizeShellWords } = makePaths();
  assert.deepEqual(tokenizeShellWords("npm run gate:default"), ["npm", "run", "gate:default"]);
  assert.deepEqual(
    tokenizeShellWords('node --test "tests/arch/a b.test.ts"'),
    ["node", "--test", "tests/arch/a b.test.ts"],
  );
  assert.deepEqual(tokenizeShellWords("bash -c 'pnpm vitest run'"), ["bash", "-c", "pnpm vitest run"]);
  // Collapsed whitespace and empty/absent input are tolerated, not thrown on.
  assert.deepEqual(tokenizeShellWords("  a\t\tb  "), ["a", "b"]);
  assert.deepEqual(tokenizeShellWords(""), []);
  assert.deepEqual(tokenizeShellWords(null), []);
});

test("splitPlanPathValues flattens comma-joined entries, trims, and drops blanks", () => {
  const { splitPlanPathValues } = makePaths();
  assert.deepEqual(
    splitPlanPathValues(["tools/gates/a.ts, tools/testing/b.ts", "package.json"]),
    ["tools/gates/a.ts", "tools/testing/b.ts", "package.json"],
  );
  // A bare string is accepted via toArray, and empty segments are removed
  // rather than becoming falsy path entries downstream.
  assert.deepEqual(splitPlanPathValues("a.ts,,  ,b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(splitPlanPathValues([]), []);
  assert.deepEqual(splitPlanPathValues(null), []);
});

test("isTestingInfrastructureFilePath matches the tracked vocabulary and normalizes separators", () => {
  const { isTestingInfrastructureFilePath } = makePaths();
  for (const hit of [
    "tools/gates/run.ts",
    "tools/testing/setup.ts",
    "tools/hooks/pre-push",
    "tests/arch/layers.test.ts",
    "tests/contracts/api.test.ts",
    "packages/testkit/index.ts",
    "vitest.config.ts",
    "vitest.config.mjs",
    "package.json",
    "README.md",
    ".github/workflows/ci.yml",
    ".husky/pre-commit",
  ]) {
    assert.equal(isTestingInfrastructureFilePath(hit), true, `expected testing-infra path: ${hit}`);
  }
  for (const miss of [
    "src/app.ts",
    "packages/ui/button.tsx",
    "tests/unit/thing.test.ts",
    "docs/README.md",
    "nested/package.json",
    "",
    null,
  ]) {
    assert.equal(isTestingInfrastructureFilePath(miss), false, `expected non-testing-infra path: ${miss}`);
  }
  // Backslash separators normalize before matching, so a Windows-style path is
  // classified identically.
  assert.equal(isTestingInfrastructureFilePath("tools\\gates\\run.ts"), true);
  assert.equal(isTestingInfrastructureFilePath("  package.json  "), true);
});

test("extractFileReferencesFromCommands keeps only normalized testing-infra file tokens, deduped", () => {
  const { extractFileReferencesFromCommands } = makePaths();
  const files = extractFileReferencesFromCommands("COORD-1", { Repo: "B" }, [
    "pnpm vitest run tests/arch/layers.test.ts",
    "node --test tools/gates/run.ts src/app.ts",
    // Repeated to prove the Set dedupe.
    "pnpm vitest run tests/arch/layers.test.ts",
  ]);
  assert.deepEqual(files.sort(), ["tests/arch/layers.test.ts", "tools/gates/run.ts"]);
});

test("extractFileReferencesFromCommands strips wrapping punctuation and rejects URLs and extensionless tokens", () => {
  const { extractFileReferencesFromCommands } = makePaths();
  const files = extractFileReferencesFromCommands("COORD-1", { Repo: "B" }, [
    "see (package.json), and `.github/workflows/ci.yml`;",
    "curl https://example.com/vitest.config.ts",
    "pnpm run gate",
    // Extensionless, so not treated as a file reference even though the path
    // itself IS tracked testing infrastructure. Asserted to pin the behavior
    // that shipped: the extension filter runs before the vocabulary match.
    "bash .husky/pre-commit",
  ]);
  assert.deepEqual(files.sort(), [".github/workflows/ci.yml", "package.json"]);
});

test("extractFileReferencesFromCommands routes every token through the injected normalizer", () => {
  const seen = [];
  const { extractFileReferencesFromCommands } = makePaths({
    normalizeTestingInfraAuditPath: (repoCode, ticketId, value) => {
      seen.push({ repoCode, ticketId, value });
      // Mimic repo-prefix stripping: only the stripped form is a tracked path.
      return value.replace(/^backend\//, "");
    },
  });
  const files = extractFileReferencesFromCommands("COORD-9", { Repo: "B" }, [
    "node --test backend/vitest.config.ts",
  ]);
  assert.deepEqual(files, ["vitest.config.ts"]);
  assert.deepEqual(seen, [{ repoCode: "B", ticketId: "COORD-9", value: "backend/vitest.config.ts" }]);
});

test("extractFileReferencesFromCommands tolerates an absent command list", () => {
  const { extractFileReferencesFromCommands } = makePaths();
  assert.deepEqual(extractFileReferencesFromCommands("COORD-1", { Repo: "B" }, null), []);
  assert.deepEqual(extractFileReferencesFromCommands("COORD-1", { Repo: "B" }, []), []);
});

test("TESTING_INFRA_FILE_PATTERNS is exported for the vocabulary's owner", () => {
  assert.ok(Array.isArray(createTestingInfraPaths.TESTING_INFRA_FILE_PATTERNS));
  assert.ok(createTestingInfraPaths.TESTING_INFRA_FILE_PATTERNS.length > 0);
  for (const pattern of createTestingInfraPaths.TESTING_INFRA_FILE_PATTERNS) {
    assert.ok(pattern instanceof RegExp);
  }
});
