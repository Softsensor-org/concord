const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateTestingBaseline, deriveExpectedBaseline } = require("./check-testing-baseline.js");
const { createCoordPaths } = require("../paths.js");

function writeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writePackage(rootDir, repo, scripts = {}) {
  writeFile(rootDir, `${repo}/package.json`, `${JSON.stringify({ scripts }, null, 2)}\n`);
}

// COORD-071: the expected baseline (repo dirs + commands) is derived from the
// active project config (coord/paths.js), so build the doc and fixture repos
// from that derivation. This keeps the test green under BOTH legs of the
// config matrix (default B=backend/F=frontend; non-default 7-repo registry).
function activeExpectedBaseline(rootDir) {
  const paths = createCoordPaths({ coordDir: path.join(rootDir, "coord"), rootDir });
  return deriveExpectedBaseline(paths);
}

function baselineDocFor(expected) {
  const rows = Object.values(expected)
    .map((spec) => `| \`${spec.repo}\` | \`${spec.command}\` | Regression tests. | Existing tests. |`)
    .join("\n");
  return `# Practical Testing Baseline

| Repo | Baseline command | Required proof | Current source |
| --- | --- | --- | --- |
${rows}
`;
}

test("testing baseline checker accepts the documented baseline contract", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-baseline-pass-"));
  const expected = activeExpectedBaseline(rootDir);
  writeFile(rootDir, "coord/product/TESTING_BASELINE.md", baselineDocFor(expected));
  for (const spec of Object.values(expected)) {
    writePackage(rootDir, spec.repo.replace(/\/$/, ""), { test: "jest --forceExit" });
  }

  const result = validateTestingBaseline({
    coordDir: path.join(rootDir, "coord"),
    rootDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, Object.keys(expected).length);
});

test("testing baseline checker rejects canonical ci scripts that use forceExit", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-baseline-fail-"));
  const expected = activeExpectedBaseline(rootDir);
  const [firstSpec] = Object.values(expected);
  const firstRepoDir = firstSpec.repo.replace(/\/$/, "");
  writeFile(rootDir, "coord/product/TESTING_BASELINE.md", baselineDocFor(expected));
  writePackage(rootDir, firstRepoDir, {
    "test:ci": "jest --forceExit tests/auth.test.ts",
  });

  const result = validateTestingBaseline({
    coordDir: path.join(rootDir, "coord"),
    rootDir,
  });

  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    new RegExp(`${firstSpec.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} test:ci uses --forceExit`)
  );
});

test("testing baseline checker reports a clear error when the baseline file is missing", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-baseline-missing-"));
  // Intentionally do NOT write coord/product/TESTING_BASELINE.md.
  const baselinePath = path.join(rootDir, "coord", "product", "TESTING_BASELINE.md");

  const result = validateTestingBaseline({
    coordDir: path.join(rootDir, "coord"),
    rootDir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /testing baseline not found at/);
  assert.match(result.errors[0], new RegExp(baselinePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("validateTestingBaseline honors an injected expectedBaseline override", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-baseline-override-"));
  writeFile(
    rootDir,
    "coord/product/TESTING_BASELINE.md",
    `# Practical Testing Baseline

| Repo | Baseline command | Required proof | Current source |
| --- | --- | --- | --- |
| \`svc/\` | \`pnpm test:ci\` | Service tests. | Existing. |
`,
  );

  const result = validateTestingBaseline({
    coordDir: path.join(rootDir, "coord"),
    rootDir,
    expectedBaseline: { B: { repo: "svc/", command: "pnpm test:ci" } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});
