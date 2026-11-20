"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadCensusObserverDescriptor } = require("./test-census-observer.js");
const hash = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function fixture(t, mode = "serial") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-observer-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = path.join(root, "observer.js");
  fs.writeFileSync(logger, 'throw new Error("observer must never execute during validation");\n');
  const output = path.join(root, "logs");
  fs.mkdirSync(output, { mode: 0o700 });
  const descriptorPath = path.join(root, "observer.json");
  const descriptor = { schema_version: 1, kind: "release-suite-census", mode,
    logger_path: logger, logger_sha256: hash(fs.readFileSync(logger)), output_root: output };
  const write = (value = descriptor) => fs.writeFileSync(descriptorPath, JSON.stringify(value, null, 2) + "\n");
  write();
  const load = (extra = {}) => loadCensusObserverDescriptor({ descriptorPath, expectedMode: mode,
    expectedOutputRoot: output, canonicalLoggerPath: logger, ...extra });
  return { root, logger, output, descriptorPath, descriptor, write, load };
}

test("COORD-1052: census observer binds descriptor and logger bytes in both execution modes without loading code", (t) => {
  for (const mode of ["serial", "sharded"]) {
    const f = fixture(t, mode);
    const normalized = f.load();
    assert.deepEqual(normalized, { mode, loggerPath: f.logger, loggerSha256: f.descriptor.logger_sha256,
      outputRoot: f.output, descriptorPath: f.descriptorPath, descriptorSha256: hash(fs.readFileSync(f.descriptorPath)) });
    assert.equal(Object.isFrozen(normalized), true);
    assert.deepEqual(loadCensusObserverDescriptor({ descriptorPath: f.descriptorPath, expectedMode: mode }), normalized,
      "transport integrity can be checked without falsely supplying a donor trust anchor");
    fs.writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
    assert.notEqual(f.load().descriptorSha256, normalized.descriptorSha256, "binding covers exact bytes, including formatting");
  }
});

test("COORD-1052: census observer rejects unsupported fields, modes, versions and malformed descriptors", (t) => {
  const f = fixture(t);
  for (const value of [null, [], {}, { ...f.descriptor, extra: "--test-name-pattern=only-one" },
    { ...f.descriptor, schema_version: 2 }, { ...f.descriptor, kind: "arbitrary-preload" },
    { ...f.descriptor, mode: "selection" }, { ...f.descriptor, mode: "sharded" },
    { ...f.descriptor, logger_sha256: "SHA256:" + "0".repeat(64) }]) {
    f.write(value);
    assert.throws(() => f.load(), /test census observer:/);
  }
  fs.writeFileSync(f.descriptorPath, "{");
  assert.throws(() => f.load(), /test census observer:/);
  fs.writeFileSync(f.descriptorPath, " ".repeat(65537));
  assert.throws(() => f.load(), /exceeds 64 KiB/);
  f.write();
  assert.throws(() => f.load({ expectedMode: undefined }), /expectedMode/);
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => file === f.descriptorPath
    ? Buffer.alloc(65537, " ")
    : readFileSync(file, ...args));
  assert.throws(() => f.load(), /exceeds 64 KiB/, "a descriptor that grows after stat is also refused");
});

test("COORD-1052: census observer refuses relative, linked, nonregular and unexpected output paths", (t) => {
  const f = fixture(t);
  f.write({ ...f.descriptor, logger_path: "observer.js" });
  assert.throws(() => f.load(), /canonical absolute/);
  f.write({ ...f.descriptor, logger_path: f.output });
  assert.throws(() => f.load(), /regular file/);
  f.write({ ...f.descriptor, output_root: f.logger });
  assert.throws(() => f.load(), /directory/);
  const link = path.join(f.root, "linked.js");
  fs.symlinkSync(f.logger, link);
  f.write({ ...f.descriptor, logger_path: link });
  assert.throws(() => f.load(), /without symlinks/);
  f.write();
  const descriptorLink = path.join(f.root, "linked.json");
  fs.symlinkSync(f.descriptorPath, descriptorLink);
  assert.throws(() => f.load({ descriptorPath: descriptorLink }), /without symlinks/);
  const other = path.join(f.root, "other"); fs.mkdirSync(other);
  assert.throws(() => f.load({ expectedOutputRoot: other }), /differs from the expected root/);
  const nested = path.join(f.output, "nested"); fs.mkdirSync(nested);
  f.write({ ...f.descriptor, output_root: nested });
  assert.throws(() => f.load({ expectedOutputRoot: nested }), /sibling/);
});

test("COORD-1052: observer integrity cannot substitute for the donor logger trust anchor", (t) => {
  const f = fixture(t);
  const alternative = path.join(f.root, "alternative.js");
  fs.copyFileSync(f.logger, alternative);
  f.write({ ...f.descriptor, logger_path: alternative });
  assert.throws(() => f.load(), /not the canonical donor logger/,
    "another file with identical bytes is not the donor's selected logger");
  f.write();
  const original = f.load();
  fs.appendFileSync(f.logger, "// changed after validation\n");
  assert.throws(() => f.load(), /logger bytes differ/);
  assert.equal(original.loggerSha256, f.descriptor.logger_sha256, "previous normalized evidence remains unchanged");
  fs.unlinkSync(f.logger);
  assert.throws(() => f.load(), /test census observer:.*ENOENT/);
});


test("COORD-1052: worker census preparation refuses missing identity and occupied or linked directories", (t) => {
  const { prepareCensusObserver } = require("./test-census-observer.js");
  const f = fixture(t, "sharded");
  for (const workerId of [undefined, "0", "-1", "1.5", "../1"]) {
    assert.throws(() => prepareCensusObserver({ descriptorPath: f.descriptorPath, shardChild: true, workerId }),
      /no executor-assigned worker identity/);
  }
  const worker = path.join(f.output, "workers", "1");
  fs.mkdirSync(worker, { recursive: true });
  const prepared = prepareCensusObserver({ descriptorPath: f.descriptorPath, shardChild: true, workerId: "1" });
  assert.equal(prepared.censusDirectory, worker);
  const prior = path.join(worker, "prior.json");
  fs.writeFileSync(prior, "retained prior evidence\n");
  assert.throws(() => prepareCensusObserver({ descriptorPath: f.descriptorPath, shardChild: true, workerId: 1 }), /must be empty/);
  assert.equal(fs.readFileSync(prior, "utf8"), "retained prior evidence\n");
  fs.symlinkSync(worker, path.join(f.output, "workers", "2"));
  assert.throws(() => prepareCensusObserver({ descriptorPath: f.descriptorPath, shardChild: true, workerId: 2 }), /canonical directory/);
  fs.writeFileSync(path.join(f.output, "workers", "3"), "ordinary file");
  assert.throws(() => prepareCensusObserver({ descriptorPath: f.descriptorPath, shardChild: true, workerId: 3 }), /canonical directory/);
  assert.equal(fs.readFileSync(prior, "utf8"), "retained prior evidence\n");
});

test("COORD-1052: malformed census artifacts retain recovery evidence without an index", (t) => {
  const { collectCensusEvidence } = require("./test-census-observer.js");
  for (const kind of ["unexpected-name", "directory", "symlink", "missing-manifest"]) {
    const f = fixture(t);
    const raw = path.join(f.output, "retained.json");
    fs.writeFileSync(raw, "original evidence\n");
    if (kind === "unexpected-name") fs.writeFileSync(path.join(f.output, "other.txt"), "unexpected");
    if (kind === "directory") fs.mkdirSync(path.join(f.output, "nested.json"));
    if (kind === "symlink") fs.symlinkSync(raw, path.join(f.output, "linked.json"));
    const result = collectCensusEvidence({ observer: f.load(), censusDirectory: f.output,
      manifestDraft: kind === "missing-manifest" ? null : { input_digest: "fixture" } });
    assert.match(result.error, kind === "missing-manifest" ? /requires a run manifest/ :
      kind === "unexpected-name" ? /unexpected census artifact/ : /not a canonical regular file/);
    assert.equal(result.indexBinding, null);
    assert.equal(result.workerMetadata.size, 0);
    assert.ok(result.artifactPaths.includes(raw));
    assert.equal(fs.readFileSync(raw, "utf8"), "original evidence\n");
    assert.equal(fs.existsSync(path.join(f.output, "index.json")), false);
  }
  const lost = fixture(t);
  const observer = lost.load();
  fs.rmdirSync(lost.output);
  const result = collectCensusEvidence({ observer, censusDirectory: lost.output, manifestDraft: null });
  assert.match(result.error, /requires a run manifest/);
  assert.deepEqual(result.artifactPaths, [lost.descriptorPath]);
  assert.equal(result.indexBinding, null);
});

test("COORD-1052: census collection rejects escaped reports and dirty worker manifests before indexing", (t) => {
  const { collectCensusEvidence } = require("./test-census-observer.js");
  for (const kind of ["escaped-report", "escaped-manifest", "dirty-source"]) {
    const f = fixture(t, "sharded");
    const directory = path.join(f.output, "workers", "1");
    fs.mkdirSync(directory, { recursive: true });
    const raw = path.join(directory, "observed.json");
    fs.writeFileSync(raw, "observed evidence\n");
    const reportPath = path.join(kind === "escaped-report" ? f.root : f.output, "worker-report.json");
    const manifestPath = path.join(kind === "escaped-manifest" ? f.root : f.output, "worker-manifest.json");
    fs.writeFileSync(reportPath, "{}\n");
    fs.writeFileSync(manifestPath, JSON.stringify({ inputs: { source: { commit: "commit", tree: "tree", dirty: kind === "dirty-source" } } }));
    const reportBefore = fs.readFileSync(reportPath), manifestBefore = fs.readFileSync(manifestPath);
    const result = collectCensusEvidence({ observer: f.load(), manifestDraft: { input_digest: "fixture" },
      shardRun: { sourceCommit: "commit", sourceTree: "tree", workers: [{ id: 1, report_path: reportPath,
        manifest_path: manifestPath, workspace: path.join(f.root, "workspace"), assigned: ["fixture.test.js"] }] } });
    assert.match(result.error, kind === "dirty-source" ? /not bound to the clean source snapshot/ : /escapes the census output root/);
    assert.equal(result.indexBinding, null);
    assert.equal(result.workerMetadata.size, 0);
    assert.equal(fs.existsSync(path.join(f.output, "index.json")), false);
    assert.ok(result.artifactPaths.includes(raw));
    assert.deepEqual(fs.readFileSync(reportPath), reportBefore);
    assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore);
    assert.equal(fs.readFileSync(raw, "utf8"), "observed evidence\n");
  }
});
