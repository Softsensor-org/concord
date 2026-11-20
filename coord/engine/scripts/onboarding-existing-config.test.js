"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveEngineModule } = require("../../paths.js");
const { readDeclaredConfig } = require(resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/static-config-declaration.js"));
const { readExistingOnboardConfig, readOnboardConfigDeclaration } = require("./onboarding-existing-config.js");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord527-config-"));
  const deps = { fs, readDeclaredConfig, discoveredPaths: ["service"] };
  const write = (value) => {
    fs.mkdirSync(path.join(root, "coord"), { recursive: true });
    const source = `// operator comment\nmodule.exports = ${JSON.stringify(value)};\n`;
    fs.writeFileSync(path.join(root, "coord/project.config.js"), source);
    return source;
  };
  try { run({ root, deps, write }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("COORD-527 static projection binds the exact read bytes and keeps only supported settings", () => fixture(({ root, deps, write }) => {
  const source = write({
    repos: { S: { path: "./service", integrationBranch: "develop", testCommand: "node --test", ticketPrefixes: ["SERV"] } },
    coordTicketPrefix: "TEAM", governance: { tier: "standard", unprojected: "CANARY" },
    adoption: { profile: "software-product", phase: "delivery", tracks: ["development"], gates: ["test"], private: "CANARY" },
    secret: "CANARY", notes: "🪐",
  });
  const read = readDeclaredConfig(path.join(root, "coord/project.config.js"), { containmentRoot: root });
  assert.equal(read.source_digest, crypto.createHash("sha256").update(source).digest("hex"));
  const result = readExistingOnboardConfig(root, deps);
  assert.equal(result.digest, read.source_digest);
  assert.deepEqual(result.repositoryPaths, ["service"]);
  assert.deepEqual(result.answers, {
    repos: [{ code: "S", path: "./service", integrationBranch: "develop", testCommand: "node --test", ticketPrefixes: ["SERV"] }],
    coordTicketPrefix: "TEAM", tier: "standard", profile: "software-product", phase: "delivery", tracks: ["development"], gates: ["test"],
  });
  assert.equal(JSON.stringify(result).includes("CANARY"), false);
}));

test("COORD-527 absent config needs no secure-open capability and optional settings use established defaults", () => fixture(({ root, deps, write }) => {
  const absentDeps = { ...deps, readDeclaredConfig: () => assert.fail("absent config must not be opened") };
  assert.equal(readExistingOnboardConfig(root, absentDeps), null);
  fs.mkdirSync(path.join(root, "coord"));
  assert.equal(readExistingOnboardConfig(root, absentDeps), null);
  write({ repos: { S: { path: "service" } }, adoption: { profile: null, phase: null } });
  assert.deepEqual(readExistingOnboardConfig(root, deps).answers, {
    repos: [{ code: "S", path: "service", integrationBranch: "main", testCommand: "npm test", ticketPrefixes: [] }],
  });
}));

test("COORD-527 invalid configured shapes refuse instead of defaulting or echoing unknown content", () => fixture(({ root, deps, write }) => {
  const repo = { path: "service" };
  const cases = [
    {}, { repos: [] }, { repos: { X: repo } }, { repos: { many: repo } }, { repos: { S: null } },
    { repos: { S: { path: "" } } }, { repos: { S: { path: 3 } } }, { repos: { S: { path: "bad\npath" } } },
    ...["..", ".", "../service", "/outside", "service\\nested", "missing", "service/nested"].map((value) => ({ repos: { S: { path: value } } })),
    { repos: { S: repo, T: repo } }, { repos: { S: { ...repo, integrationBranch: null } } },
    { repos: { S: { ...repo, testCommand: " " } } }, { repos: { S: { ...repo, ticketPrefixes: "SERV" } } },
    { repos: { S: { ...repo, ticketPrefixes: [null] } } },
    { repos: { S: repo }, coordTicketPrefix: false }, { repos: { S: repo }, governance: [] },
    { repos: { S: repo }, governance: { tier: "" } }, { repos: { S: repo }, adoption: [] },
    { repos: { S: repo }, adoption: { profile: [] } }, { repos: { S: repo }, adoption: { gates: "test" } },
  ];
  for (const config of cases) {
    write({ ...config, private: "UNPROJECTED_REFUSAL_CANARY" });
    assert.throws(() => readExistingOnboardConfig(root, deps), (error) => {
      assert.match(error.message, /onboard:/);
      assert.equal(error.message.includes("UNPROJECTED_REFUSAL_CANARY"), false);
      return true;
    });
  }
}));

test("COORD-891: an empty repository map is the unmapped starter: projected for regeneration, settings still validated", () => fixture(({ root, deps, write }) => {
  write({ coordTicketPrefix: "TEAM", repos: {}, governance: { tier: "lite" }, private: "UNPROJECTED_CANARY" });
  const result = readExistingOnboardConfig(root, deps);
  assert.equal(result.unmapped, true);
  assert.deepEqual(result.repositoryPaths, []);
  assert.deepEqual(result.answers, { coordTicketPrefix: "TEAM", tier: "lite" });
  assert.equal(JSON.stringify(result).includes("UNPROJECTED_CANARY"), false);
  for (const config of [{ repos: {}, coordTicketPrefix: false }, { repos: {}, governance: [] }, { repos: {}, adoption: { gates: "test" } }]) {
    write(config);
    assert.throws(() => readExistingOnboardConfig(root, deps), /onboard:/);
  }
}));

test("COORD-527 dynamic config cannot execute and unsafe parent/file types are not treated as absent", () => fixture(({ root, deps, write }) => {
  write({ repos: { S: { path: "service" } } });
  const file = path.join(root, "coord/project.config.js");
  const sentinel = path.join(root, "executed");
  fs.writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad'); module.exports = {};`);
  assert.throws(() => readExistingOnboardConfig(root, deps), /without executing/);
  assert.equal(fs.existsSync(sentinel), false);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readOnboardConfigDeclaration(root, deps), /regular file/);
  fs.rmdirSync(file);
  fs.symlinkSync(path.join(root, "missing"), file);
  assert.throws(() => readOnboardConfigDeclaration(root, deps), /regular file/);
  fs.unlinkSync(file);
  fs.rmdirSync(path.join(root, "coord"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "coord"));
  assert.throws(() => readOnboardConfigDeclaration(root, deps), /real directory/);
  fs.unlinkSync(path.join(root, "coord"));
  fs.writeFileSync(path.join(root, "coord"), "not a directory");
  assert.throws(() => readOnboardConfigDeclaration(root, deps), /real directory/);
  const inaccessible = { ...deps, fs: { lstatSync: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } } };
  assert.throws(() => readOnboardConfigDeclaration(root, inaccessible), /permission denied/);
}));
