"use strict";

// COORD-082 (CONTRACT-002): CI-safe, path-independent contract-policy tests.
// Pure policy + deterministic codegen + diff + CLI behavior. Temp fixtures only;
// no board/runtime/live-config side effects.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  validateContractConfig,
  resolveContractPaths,
  generateClient,
  checkContract,
  formatContractSummary,
  runCli,
} = require("./contract-policy.js");

const { createCoordPaths } = require("../paths.js");

// --- fixture helpers --------------------------------------------------------

const OPENAPI_FIXTURE = {
  openapi: "3.0.3",
  info: { title: "Fixture API", version: "1.2.3" },
  paths: {
    "/health": { get: { operationId: "getHealth", responses: {} } },
    "/widgets": { post: { operationId: "createWidget", responses: {} } },
  },
};

// Build a throwaway project tree: <root>/{api,web,coord} with a project.config.js
// that binds web's contract to api's OpenAPI artifact via repo codes (NOT a
// hardcoded sibling path). Returns { root, paths, sourceAbs, generatedAbs }.
function makeProject({ withContract = true, writeSource = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-contract-"));
  const coordDir = path.join(root, "coord");
  fs.mkdirSync(coordDir, { recursive: true });
  fs.mkdirSync(path.join(root, "api", "contract"), { recursive: true });
  fs.mkdirSync(path.join(root, "web", "src", "generated"), { recursive: true });

  const contractBlock = withContract
    ? `, contract: { sourceRepo: "A", sourcePath: "contract/openapi.json", generatedPath: "src/generated/api-client.js" }`
    : "";
  const config = `module.exports = {
    coordTicketPrefix: "PROJ",
    repos: {
      A: { path: "api", integrationBranch: "main" },
      W: { path: "web", integrationBranch: "main"${contractBlock} },
    },
  };`;
  fs.writeFileSync(path.join(coordDir, "project.config.js"), config);

  const sourceAbs = path.join(root, "api", "contract", "openapi.json");
  if (writeSource) {
    fs.writeFileSync(sourceAbs, JSON.stringify(OPENAPI_FIXTURE, null, 2) + "\n");
  }
  const generatedAbs = path.join(root, "web", "src", "generated", "api-client.js");

  const paths = createCoordPaths({ coordDir, rootDir: root, projectConfig: require(path.join(coordDir, "project.config.js")) });
  return { root, coordDir, paths, sourceAbs, generatedAbs };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// --- validateContractConfig -------------------------------------------------

test("validateContractConfig: absent block is valid (backward-compatible) -> null", () => {
  assert.equal(validateContractConfig("W", {}), null);
  assert.equal(validateContractConfig("W", { contract: null }), null);
});

test("validateContractConfig: malformed block throws", () => {
  assert.throws(() => validateContractConfig("W", { contract: { sourceRepo: "A", sourcePath: "x" } }), /generatedPath/);
  assert.throws(() => validateContractConfig("W", { contract: { sourceRepo: "ab", sourcePath: "x", generatedPath: "y" } }), /single uppercase/);
});

// --- resolveContractPaths (the path-independence core) ----------------------

test("resolveContractPaths resolves source via config + repoRoots, NOT a hardcoded sibling", () => {
  const { root, paths, sourceAbs, generatedAbs } = makeProject();
  try {
    const resolved = resolveContractPaths(paths, "W");
    assert.ok(resolved, "expected a resolved contract");
    assert.equal(resolved.sourceRepo, "A");
    // The resolved source path is the api repo root + configured relative path —
    // derived from repoRoots, so it is layout/CI-independent (no "../api/..").
    assert.equal(resolved.sourceAbs, sourceAbs);
    assert.equal(resolved.generatedAbs, generatedAbs);
    assert.ok(path.isAbsolute(resolved.sourceAbs));
    assert.ok(!resolved.config.sourcePath.includes(".."), "config must not encode a relative sibling traversal");
    // It resolves under the api repo root, proving registry-based resolution.
    assert.ok(resolved.sourceAbs.startsWith(paths.repoRoots.A));
  } finally {
    cleanup(root);
  }
});

test("resolveContractPaths returns null for a repo with no contract block", () => {
  const { root, paths } = makeProject({ withContract: false });
  try {
    assert.equal(resolveContractPaths(paths, "W"), null);
    assert.equal(resolveContractPaths(paths, "A"), null);
  } finally {
    cleanup(root);
  }
});

// --- generateClient (deterministic codegen) ---------------------------------

test("generateClient is deterministic and emits one wrapper per operation", () => {
  const a = generateClient(OPENAPI_FIXTURE);
  const b = generateClient(OPENAPI_FIXTURE);
  assert.equal(a, b, "same contract must produce byte-identical output");
  assert.match(a, /getHealth\(options\)/);
  assert.match(a, /createWidget\(options\)/);
  assert.match(a, /Fixture API v1\.2\.3/);
});

test("generateClient output changes when the contract changes", () => {
  const base = generateClient(OPENAPI_FIXTURE);
  const bumped = generateClient({
    ...OPENAPI_FIXTURE,
    paths: { ...OPENAPI_FIXTURE.paths, "/orders": { get: { operationId: "listOrders", responses: {} } } },
  });
  assert.notEqual(base, bumped);
  assert.match(bumped, /listOrders/);
});

// --- checkContract (the staleness gate) -------------------------------------

test("checkContract: passes when committed client is current", () => {
  const { root, paths, generatedAbs } = makeProject();
  try {
    const resolved = resolveContractPaths(paths, "W");
    fs.writeFileSync(generatedAbs, generateClient(OPENAPI_FIXTURE));
    const check = checkContract(resolved);
    assert.equal(check.result, "pass");
    assert.match(formatContractSummary(check, resolved), /^contract: pass/);
  } finally {
    cleanup(root);
  }
});

test("checkContract: FAILS when the source contract changes without regenerating", () => {
  const { root, paths, sourceAbs, generatedAbs } = makeProject();
  try {
    const resolved = resolveContractPaths(paths, "W");
    // Commit a client for the original contract...
    fs.writeFileSync(generatedAbs, generateClient(OPENAPI_FIXTURE));
    assert.equal(checkContract(resolved).result, "pass");
    // ...then change the SOURCE contract without regenerating the client.
    const bumped = {
      ...OPENAPI_FIXTURE,
      paths: { ...OPENAPI_FIXTURE.paths, "/orders": { get: { operationId: "listOrders", responses: {} } } },
    };
    fs.writeFileSync(sourceAbs, JSON.stringify(bumped, null, 2) + "\n");
    const stale = checkContract(resolved);
    assert.equal(stale.result, "fail");
    assert.match(stale.reason, /STALE/);
  } finally {
    cleanup(root);
  }
});

test("checkContract: FAILS when committed client is missing entirely", () => {
  const { root, paths } = makeProject();
  try {
    const resolved = resolveContractPaths(paths, "W");
    const check = checkContract(resolved); // no client written
    assert.equal(check.result, "fail");
    assert.equal(check.generatedExists, false);
  } finally {
    cleanup(root);
  }
});

test("checkContract: graceful skip when no contract config", () => {
  assert.equal(checkContract(null).result, "skip");
});

test("checkContract: graceful skip when no OpenAPI source artifact exists", () => {
  const { root, paths } = makeProject({ writeSource: false });
  try {
    const resolved = resolveContractPaths(paths, "W");
    const check = checkContract(resolved);
    assert.equal(check.result, "skip");
    assert.match(check.reason, /no OpenAPI source artifact/);
  } finally {
    cleanup(root);
  }
});

// --- CLI --------------------------------------------------------------------

function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), get: () => chunks.join("") };
}

test("CLI gen writes the client; subsequent check passes (current)", () => {
  const { root, paths, generatedAbs } = makeProject();
  try {
    const out = capture();
    const rcGen = runCli(["gen", "--repo", "W"], { paths, stdout: out, stderr: capture() });
    assert.equal(rcGen, 0);
    assert.ok(fs.existsSync(generatedAbs));
    assert.match(out.get(), /contract: generated/);

    const out2 = capture();
    const rcCheck = runCli(["check", "--repo", "W"], { paths, stdout: out2, stderr: capture() });
    assert.equal(rcCheck, 0);
    assert.match(out2.get(), /^contract: pass/);
  } finally {
    cleanup(root);
  }
});

test("CLI check exits non-zero (fail) when client is stale vs source", () => {
  const { root, paths, sourceAbs } = makeProject();
  try {
    runCli(["gen", "--repo", "W"], { paths, stdout: capture(), stderr: capture() });
    const bumped = {
      ...OPENAPI_FIXTURE,
      paths: { ...OPENAPI_FIXTURE.paths, "/orders": { get: { operationId: "listOrders", responses: {} } } },
    };
    fs.writeFileSync(sourceAbs, JSON.stringify(bumped, null, 2) + "\n");
    const out = capture();
    const rc = runCli(["check", "--repo", "W"], { paths, stdout: out, stderr: capture() });
    assert.equal(rc, 1);
    assert.match(out.get(), /contract: fail/);
  } finally {
    cleanup(root);
  }
});

test("CLI auto-picks the sole repo with a contract block when --repo omitted", () => {
  const { root, paths, generatedAbs } = makeProject();
  try {
    fs.writeFileSync(generatedAbs, generateClient(OPENAPI_FIXTURE));
    const out = capture();
    const rc = runCli(["check"], { paths, stdout: out, stderr: capture() });
    assert.equal(rc, 0);
    assert.match(out.get(), /^contract: pass/);
  } finally {
    cleanup(root);
  }
});

test("CLI usage error on unknown subcommand", () => {
  const err = capture();
  const rc = runCli(["bogus"], { stdout: capture(), stderr: err });
  assert.equal(rc, 2);
  assert.match(err.get(), /usage/);
});
