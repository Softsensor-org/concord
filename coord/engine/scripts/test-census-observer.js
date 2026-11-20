"use strict";

// Descriptor transport for release test observation. This module never loads
// the observer. Its byte checks establish integrity; the donor must separately
// supply its canonical logger path before treating an observer as approved.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const FIELDS = Object.freeze(["kind", "logger_path", "logger_sha256", "mode", "output_root", "schema_version"]);
const HASH = /^sha256:[a-f0-9]{64}$/;
const MODES = new Set(["serial", "sharded"]);
const hash = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function refuse(message) { throw new Error(`test census observer: ${message}`); }
function validateCensusObserverOptions(opts) {
  if (opts.censusObserverDescriptor !== null && !String(opts.censusObserverDescriptor).trim()) {
    opts.errors.push("--census-observer requires a non-empty descriptor path");
  }
  if (opts.censusObserverDescriptor) {
    if (opts.qualificationStage !== "release" || opts.policyStage !== "release" || opts.qualificationMode !== "full") {
      opts.errors.push("--census-observer requires the exact full release qualification stage");
    }
    if (!opts.engineCoverage || opts.writeCoverageBaseline) {
      opts.errors.push("--census-observer requires --engine-coverage and cannot write a baseline");
    }
    if (opts.passthrough.length || opts.modules.length || opts.changedSince != null || opts.list ||
        (!opts.shardChild && opts.files.length > 0) || (opts.shardChild && opts.files.length === 0)) {
      opts.errors.push("--census-observer does not permit arbitrary filters, advisory selection or inventory-only mode");
    }
  }
}
function canonicalPath(value, label, directory = false) {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value) || path.normalize(value) !== value) {
    refuse(`${label} must be a canonical absolute path`);
  }
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || fs.realpathSync(value) !== value) {
    refuse(`${label} must be a canonical ${directory ? "directory" : "regular file"}, without symlinks`);
  }
  return value;
}
function loadCensusObserverDescriptor({ descriptorPath, expectedMode, expectedOutputRoot, canonicalLoggerPath } = {}) {
  try {
    if (!MODES.has(expectedMode)) refuse("expectedMode must be serial or sharded");
    const file = canonicalPath(descriptorPath, "descriptor");
    if (fs.statSync(file).size > 65536) refuse("descriptor exceeds 64 KiB");
    const bytes = fs.readFileSync(file);
    if (bytes.length > 65536) refuse("descriptor exceeds 64 KiB");
    const descriptor = JSON.parse(bytes.toString("utf8"));
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
        JSON.stringify(Object.keys(descriptor).sort()) !== JSON.stringify(FIELDS)) refuse("descriptor fields do not match the supported schema");
    if (descriptor.schema_version !== 1 || descriptor.kind !== "release-suite-census") refuse("unsupported descriptor version or kind");
    if (!MODES.has(descriptor.mode) || descriptor.mode !== expectedMode) refuse("observer mode does not match execution mode");
    if (!HASH.test(descriptor.logger_sha256)) refuse("logger_sha256 must be a lowercase sha256 digest");
    const logger = canonicalPath(descriptor.logger_path, "logger");
    const outputRoot = canonicalPath(descriptor.output_root, "output root", true);
    if (path.dirname(file) !== path.dirname(outputRoot)) refuse("descriptor must be a sibling of its private output root");
    if (expectedOutputRoot !== undefined && canonicalPath(expectedOutputRoot, "expected output root", true) !== outputRoot) {
      refuse("observer output root differs from the expected root");
    }
    const loggerDigest = hash(fs.readFileSync(logger));
    if (loggerDigest !== descriptor.logger_sha256) refuse("logger bytes differ from the descriptor digest");
    if (canonicalLoggerPath !== undefined) {
      const canonicalLogger = canonicalPath(canonicalLoggerPath, "canonical donor logger");
      if (canonicalLogger !== logger || hash(fs.readFileSync(canonicalLogger)) !== loggerDigest) refuse("observer is not the canonical donor logger");
    }
    return Object.freeze({ mode: descriptor.mode, loggerPath: logger, loggerSha256: loggerDigest,
      outputRoot, descriptorPath: file, descriptorSha256: hash(bytes) });
  } catch (error) {
    if (String(error.message).startsWith("test census observer:")) throw error;
    refuse(error.message);
  }
}

function requireEmptyCensusDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} must be a canonical directory`);
  }
  if (fs.readdirSync(directory).length) throw new Error(`${label} must be empty before the release test run`);
}

function prepareCensusObserver({ descriptorPath, shards, shardChild, workerId } = {}) {
  const expectedMode = shards || shardChild ? "sharded" : "serial";
  const observer = loadCensusObserverDescriptor({ descriptorPath: path.resolve(descriptorPath), expectedMode });
  let censusDirectory = null;
  if (shardChild) {
    if (!/^[1-9][0-9]*$/.test(String(workerId || ""))) throw new Error("shard child has no executor-assigned worker identity");
    censusDirectory = path.join(observer.outputRoot, "workers", String(Number(workerId)));
    requireEmptyCensusDirectory(censusDirectory, "worker census directory");
  } else if (shards) {
    requireEmptyCensusDirectory(observer.outputRoot, "release census output root");
  } else {
    censusDirectory = observer.outputRoot;
    requireEmptyCensusDirectory(censusDirectory, "release census output root");
  }
  return { observer, censusDirectory };
}

function observerDescriptorProjection(observer) {
  return { schema_version: 1, kind: "release-suite-census", mode: observer.mode,
    logger_path: observer.loggerPath, logger_sha256: observer.loggerSha256, output_root: observer.outputRoot };
}

function hashFile(file) { return hash(fs.readFileSync(file)); }

function observerFiles(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    if (!name.endsWith(".json")) throw new Error(`unexpected census artifact: ${name}`);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) {
      throw new Error(`census artifact is not a canonical regular file: ${name}`);
    }
    return { path: name, sha256: hashFile(file), bytes: stat.size };
  });
}

function collectCensusEvidence({ observer, manifestDraft, shardRun, censusDirectory }) {
  const artifactPaths = [];
  let indexBinding = null;
  const workerMetadata = new Map();
  let error = null;
  if (!observer) return { artifactPaths, indexBinding, workerMetadata, error };
  artifactPaths.push(observer.descriptorPath);
  try {
    if (!manifestDraft) throw new Error("release census observer requires a run manifest");
    if (shardRun) {
      const indexPath = path.join(observer.outputRoot, "index.json");
      const workers = shardRun.workers.map((worker) => {
        const censusDirectoryRel = `workers/${worker.id}`;
        const censusDirectoryAbs = path.join(observer.outputRoot, censusDirectoryRel);
        const logFiles = observerFiles(censusDirectoryAbs);
        const reportPathAbs = path.resolve(worker.report_path);
        const manifestPathAbs = path.resolve(worker.manifest_path);
        const reportRel = path.relative(observer.outputRoot, reportPathAbs).split(path.sep).join("/");
        const manifestRel = path.relative(observer.outputRoot, manifestPathAbs).split(path.sep).join("/");
        if (!reportRel || reportRel === ".." || reportRel.startsWith("../") || path.isAbsolute(reportRel) ||
            !manifestRel || manifestRel === ".." || manifestRel.startsWith("../") || path.isAbsolute(manifestRel)) {
          throw new Error(`shard ${worker.id} report evidence escapes the census output root`);
        }
        const sourceManifest = JSON.parse(fs.readFileSync(manifestPathAbs, "utf8"));
        const assignment = worker.assigned.slice();
        const metadata = { worker_id: worker.id, workspace_root: worker.workspace, assignment,
          source_commit: shardRun.sourceCommit, source_tree: shardRun.sourceTree,
          observer_sha256: observer.loggerSha256, census_dir: censusDirectoryRel,
          report_path: reportRel, report_sha256: hashFile(reportPathAbs),
          manifest_path: manifestRel, manifest_sha256: hashFile(manifestPathAbs) };
        if (sourceManifest.inputs?.source?.commit !== shardRun.sourceCommit || sourceManifest.inputs?.source?.tree !== shardRun.sourceTree ||
            sourceManifest.inputs?.source?.dirty !== false) throw new Error(`shard ${worker.id} manifest is not bound to the clean source snapshot`);
        workerMetadata.set(worker.id, metadata);
        artifactPaths.push(reportPathAbs, manifestPathAbs, ...logFiles.map((entry) => path.join(censusDirectoryAbs, entry.path)));
        return { ...metadata, files: logFiles };
      });
      const index = { schema_version: 1, kind: "release-suite-census-index", run_input_digest: manifestDraft.input_digest,
        source_commit: shardRun.sourceCommit, source_tree: shardRun.sourceTree,
        observer_sha256: observer.loggerSha256, workers };
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      indexBinding = { path: indexPath, sha256: hashFile(indexPath) };
      artifactPaths.push(indexPath);
    } else if (censusDirectory) {
      artifactPaths.push(...observerFiles(censusDirectory).map((entry) => path.join(censusDirectory, entry.path)));
    }
  } catch (caught) {
    error = caught.message;
    indexBinding = null;
    workerMetadata.clear();
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
        else if (entry.isFile() && !entry.isSymbolicLink()) artifactPaths.push(file);
      }
    };
    try { walk(observer.outputRoot); } catch { /* preserve the original observer failure */ }
  }
  return { artifactPaths: [...new Set(artifactPaths)], indexBinding, workerMetadata, error };
}

function censusReportFields({ observer, evidence, shardRun, opts, censusDirectory }) {
  return { shard_error: shardRun ? (shardRun.validationError || evidence.error) : null, census_error: evidence.error,
    shards: shardRun ? shardRun.workers.map((worker) => ({ id: worker.id, result: worker.result,
      assigned: worker.assigned, duration_ms: worker.duration_ms, exit_code: worker.exit_code, signal: worker.signal || null,
      error: worker.error || null, port: worker.port, runtime_dir: worker.runtime, temp_dir: worker.tmp,
      ui_bootstrap: worker.ui_bootstrap || null, census: evidence.workerMetadata.get(worker.id) || null })) : null,
    release_observer: observer ? observerDescriptorProjection(observer) : null,
    release_observer_binding: observer ? { path: observer.descriptorPath, sha256: observer.descriptorSha256 } : null,
    census_index: evidence.indexBinding, shard_assignment: opts.shardChild ? opts.files.slice() : null,
    census_directory: censusDirectory };
}

function persistCensusReport({ report, reportPath, manifestDraft, manifestPath, runManifest, artifactPaths }) {
  let error = null;
  try {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  } catch (caught) { error = caught; }
  if (manifestDraft && error === null) {
    try { runManifest.writeManifest(manifestPath, runManifest.finalizeManifest(manifestDraft, [reportPath, ...artifactPaths])); }
    catch (caught) { error = new Error(`run manifest ${manifestPath}: ${caught.message}`); }
  }
  return { error, persisted: error === null };
}

module.exports = { validateCensusObserverOptions, loadCensusObserverDescriptor, prepareCensusObserver, observerDescriptorProjection,
  collectCensusEvidence, censusReportFields, persistCensusReport };
