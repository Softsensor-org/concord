"use strict";

// COORD-710: immutable observation store and the `gov observe` verb.
//
// Store layout (default root: coord/evidence/observations, gitignored like every
// other evidence receipt bucket):
//   runs/<content_digest>.json      immutable canonical run artifact
//   attempts/<sha256(attempt key)>  create-if-absent claim: one payload per attempt
//   quarantines/<quarantine_id>.json governed quarantine objects
//   rejections/<receipt_key>.json   attributable refusals
//   series.json                     DERIVED, rebuildable from runs/ + quarantines/
//
// Every artifact, claim and quarantine is written with link(2) from a private
// temporary file, which is an atomic create-if-absent: concurrent duplicate
// delivery produces exactly one file and the loser observes EEXIST. The
// hash-chained governance journal receives ONE compact event per ingestion
// (digests, pointer, counts), never one event per test case, and an idempotency
// key makes a repeated delivery a journal no-op.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const defaultCore = require("./quality-observation.js");

const INGEST_EVENT_TYPE = "quality.observation_ingested";
const REJECT_EVENT_TYPE = "quality.observation_rejected";
const QUARANTINE_EVENT_TYPE = "quality.quarantine_recorded";
const REPLAY_RESULT_TYPE = "quality.observation_replay";

const OBSERVE_USAGE = [
  "usage:",
  "  gov observe ingest --format <node-test-tap|junit-xml|jest-json|pytest-json> --report <path> --repo <code> --suite <name>",
  "                     --commit <sha> --runtime <identity> [--attempt <n>] [--expect-measurement] [--source-root <dir>] [--store <dir>] [--ticket <id>]",
  "  gov observe replay [--check] [--store <dir>]",
  "  gov observe series [--store <dir>]",
  "  gov observe quarantine --repo <code> --suite <name> --test-id <id> --owner <handle> --reason <text>",
  "                         --expires-at <iso> --max-age-days <n> [--created-at <iso>] [--store <dir>] [--ticket <id>]",
].join("\n");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function createObservationStore({ root, core }) {
  const dir = (name) => path.join(root, name);
  const rel = (file) => toPosix(path.relative(root, file));

  function writeOnce(file, bytes) {
    fs.mkdirSync(dir(".tmp"), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(dir(".tmp"), `${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(tmp, bytes, "utf8");
    let created = true;
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      fs.unlinkSync(tmp);
      if (error.code !== "EEXIST") throw error;
      created = false;
    }
    if (created) fs.unlinkSync(tmp);
    return created;
  }

  function readJson(file) {
    const bytes = fs.readFileSync(file, "utf8");
    try {
      return { bytes, value: JSON.parse(bytes) };
    } catch {
      throw new core.ObservationError("digest-mismatch", `${rel(file)} is not valid JSON`);
    }
  }

  function readArtifact(file) {
    const { bytes, value } = readJson(file);
    core.verifyArtifact(value);
    if (path.basename(file) !== `${value.content_digest}.json` || core.artifactBytes(value) !== bytes) {
      throw new core.ObservationError("digest-mismatch", `${rel(file)} is not the canonical artifact for its digest`);
    }
    return { artifact: value, artifact_digest: core.sha256Hex(bytes), path: rel(file) };
  }

  function listDir(name) {
    const directory = dir(name);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort().map((entry) => path.join(directory, entry));
  }

  function ingest(artifact) {
    core.verifyArtifact(artifact);
    const { repository, suite, commit_sha: commit, runtime, attempt, adapter } = artifact.content;
    const key = core.canonicalize([
      repository, suite, commit, runtime,
      adapter.id, adapter.contract_version, adapter.format_version,
      attempt,
    ]);
    const claimFile = path.join(dir("attempts"), `${core.sha256Hex(key)}.json`);
    if (!writeOnce(claimFile, core.canonicalBytes({ attempt_key: key, content_digest: artifact.content_digest }))) {
      const claimed = readJson(claimFile).value.content_digest;
      if (claimed !== artifact.content_digest) {
        throw new core.ObservationError("attempt-conflict", `attempt ${key} is already recorded as ${claimed}`);
      }
    }
    const runFile = path.join(dir("runs"), `${artifact.content_digest}.json`);
    const created = writeOnce(runFile, core.artifactBytes(artifact));
    return { status: created ? "created" : "duplicate", ...readArtifact(runFile) };
  }

  function listArtifacts() {
    return listDir("runs").map(readArtifact);
  }

  function listQuarantines() {
    return listDir("quarantines").map((file) => core.verifyQuarantine(readJson(file).value));
  }

  function recordQuarantine(record) {
    core.verifyQuarantine(record);
    return writeOnce(path.join(dir("quarantines"), `${record.quarantine_id}.json`), core.canonicalBytes(record)) ? "created" : "duplicate";
  }

  function writeRejection(receipt) {
    const file = path.join(dir("rejections"), `${receipt.receipt_key}.json`);
    writeOnce(file, core.canonicalBytes(receipt));
    return rel(file);
  }

  function rebuildSeries({ write }) {
    const derived = core.deriveSeries(listArtifacts().map((entry) => entry.artifact), listQuarantines());
    const file = dir("series.json");
    const stored = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (write) {
      const tmp = path.join(dir(".tmp"), `series-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
      fs.mkdirSync(dir(".tmp"), { recursive: true });
      fs.writeFileSync(tmp, derived.bytes, "utf8");
      fs.renameSync(tmp, file);
    }
    return { ...derived, stored_matches: stored === null ? null : stored === derived.bytes };
  }

  return { root, ingest, readArtifact, listArtifacts, listQuarantines, recordQuarantine, writeRejection, rebuildSeries };
}

const BOOLEAN_FLAGS = new Set(["expect-measurement", "check"]);
const VALUE_FLAGS = new Set([
  "format", "report", "repo", "suite", "commit", "runtime", "attempt", "source-root", "store", "ticket",
  "test-id", "owner", "reason", "created-at", "expires-at", "max-age-days",
]);

function parseObserveArgs(argv, fail) {
  const [sub, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const name = token.startsWith("--") ? token.slice(2) : null;
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) fail(`gov observe: unexpected argument ${JSON.stringify(token)}.\n${OBSERVE_USAGE}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`gov observe: --${name} requires a value.`);
    flags[name] = value;
    i += 1;
  }
  return { sub, flags };
}

function compactObservation(stored, storeRef, core) {
  const { content } = stored.artifact;
  return {
    store: storeRef,
    artifact_path: stored.path,
    schema: stored.artifact.schema,
    content_digest: stored.artifact.content_digest,
    artifact_digest: stored.artifact_digest,
    adapter: content.adapter.id,
    repository: content.repository,
    suite: content.suite,
    commit_sha: content.commit_sha,
    runtime: content.runtime,
    attempt: content.attempt,
    run_status: content.run_status,
    passing_evidence: core.isPassingEvidence(stored.artifact),
    counts: content.counts,
  };
}

// The content digest deliberately excludes provenance, so readArtifact's
// content check cannot authenticate fields such as ingested_at. Bind every
// stored run's full-byte digest to its compact governance receipt before any
// command uses the store to derive or extend a series.
function verifyJournaledArtifacts(store, storeRef, events, core) {
  const entries = store.listArtifacts();
  const byDigest = new Map(entries.map((entry) => [entry.artifact.content_digest, entry]));
  const quarantines = store.listQuarantines();
  const byQuarantineId = new Map(quarantines.map((record) => [record.quarantine_id, record]));
  const journaled = new Set();
  const receiptDigests = new Map();
  const journaledQuarantines = new Set();
  const quarantineReceipts = new Map();
  const problems = [];
  for (const event of events) {
    const details = event.details || {};
    if (details.event_type === QUARANTINE_EVENT_TYPE) {
      const quarantine = details.quarantine;
      if (!quarantine || typeof quarantine !== "object" || Array.isArray(quarantine)) {
        problems.push("journaled quarantine receipt is malformed");
        continue;
      }
      if (quarantine.store !== storeRef) continue;
      const record = { ...quarantine };
      delete record.store;
      const id = record.quarantine_id;
      if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) {
        problems.push(`journaled quarantine receipt for ${storeRef} has an invalid quarantine_id`);
        continue;
      }
      try {
        core.verifyQuarantine(record);
      } catch (error) {
        problems.push(`journaled quarantine ${id} does not match its quarantine_id: ${error.message}`);
        continue;
      }
      const receipt = core.canonicalize(record);
      const previous = quarantineReceipts.get(id);
      if (previous && previous !== receipt) {
        problems.push(`journaled quarantine ${id} has conflicting receipt records`);
      } else {
        quarantineReceipts.set(id, receipt);
      }
      const stored = byQuarantineId.get(id);
      journaledQuarantines.add(id);
      if (!stored) problems.push(`journaled quarantine ${id} is missing from the store`);
      else if (core.canonicalize(stored) !== receipt) problems.push(`quarantine ${id} does not match its journal receipt`);
      continue;
    }
    if (details.event_type !== INGEST_EVENT_TYPE) continue;
    const observation = details.observation;
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      problems.push("journaled observation receipt is malformed");
      continue;
    }
    if (observation.store !== storeRef) continue;
    const { content_digest: digest, artifact_digest: artifactDigest } = observation;
    if (typeof digest !== "string" || typeof artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{64}$/.test(artifactDigest)) {
      problems.push(`journaled observation receipt for ${storeRef} has invalid digests`);
      continue;
    }
    const previousDigest = receiptDigests.get(digest);
    if (previousDigest && previousDigest !== artifactDigest) {
      problems.push(`journaled artifact ${digest} has conflicting artifact digests ${previousDigest} and ${artifactDigest}`);
    } else {
      receiptDigests.set(digest, artifactDigest);
    }
    const entry = byDigest.get(digest);
    journaled.add(digest);
    if (!entry) problems.push(`journaled artifact ${digest} is missing from the store`);
    else if (entry.artifact_digest !== artifactDigest) problems.push(`artifact ${digest} bytes do not match the journaled digest ${artifactDigest}`);
  }
  for (const digest of byDigest.keys()) {
    if (!journaled.has(digest)) problems.push(`artifact ${digest} has no governance journal receipt`);
  }
  for (const id of byQuarantineId.keys()) {
    if (!journaledQuarantines.has(id)) problems.push(`quarantine ${id} has no governance journal receipt`);
  }
  if (problems.length > 0) {
    throw new core.ObservationError("digest-mismatch", problems.join("; "));
  }
  return { entries, quarantines, journaled_count: journaled.size };
}

// deps are supplied by the control-plane entry point (lifecycle.js), never
// inferred here (ADR-0013): fail, withGovernanceMutation, readGovernanceEventLog,
// ensureCurrentAgentIdentity and runtimeState (the live, sandboxable state whose
// RUNTIME_DIR is read at call time). The default store is
// <dirname(RUNTIME_DIR)>/evidence/observations, i.e. coord/evidence/observations
// in a real checkout. now, log and core are optional seams for tests.
function createObservationCommands(deps) {
  const { fail, withGovernanceMutation, readGovernanceEventLog, ensureCurrentAgentIdentity, runtimeState } = deps;
  const now = deps.now || (() => new Date().toISOString());
  const log = deps.log || ((line) => console.log(line));
  const core = deps.core || defaultCore;
  const resolveStoreBase = () => path.dirname(runtimeState.RUNTIME_DIR);
  const resolveStoreDir = () => path.join(resolveStoreBase(), "evidence", "observations");

  function actor() {
    try {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch {
      return null;
    }
  }

  function storeFor(flags) {
    const root = flags.store ? path.resolve(flags.store) : resolveStoreDir();
    return { store: createObservationStore({ root, core }), storeRef: toPosix(path.relative(resolveStoreBase(), root)) };
  }

  function readReportText(file) {
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new core.ObservationError("unreadable-report", `cannot read report ${file}: ${error.code}`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new core.ObservationError("malformed", "report is not valid UTF-8");
    }
  }

  function mutationBase(command, flags, identity) {
    return { command, ticket: flags.ticket || null, allowProvenanceDrift: true, forceLog: true, identity };
  }

  function commit(store, storeRef, artifact, flags, identity) {
    let stored = null;
    let series = null;
    const metadata = {
      ...mutationBase("observe-ingest", flags, identity),
      idempotencyKey: `observe-ingest:${storeRef}:${artifact.content_digest}`,
      details: { event_type: INGEST_EVENT_TYPE },
    };
    const apply = () => {
      // Fail closed on a corrupt store BEFORE claiming the attempt, so a refused
      // ingestion never leaves an unjournaled claim or artifact behind.
      verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      store.rebuildSeries({ write: false });
      stored = store.ingest(artifact);
      series = store.rebuildSeries({ write: true });
      metadata.details = { event_type: INGEST_EVENT_TYPE, observation: compactObservation(stored, storeRef, core) };
    };
    withGovernanceMutation(metadata, apply);
    // An idempotent replay of an already-journaled delivery skips `apply`; the
    // store is still re-verified so the reported digests are the stored ones.
    // Do not treat any skipped callback as permission to create a new artifact:
    // only a matching pre-existing receipt makes this a safe replay.
    if (stored === null) {
      const verified = verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      if (!verified.entries.some((entry) => entry.artifact.content_digest === artifact.content_digest)) {
        throw new core.ObservationError("digest-mismatch", `idempotent ingestion ${artifact.content_digest} has no existing journaled artifact to replay`);
      }
      apply();
    }
    return { event_type: INGEST_EVENT_TYPE, status: stored.status, ...compactObservation(stored, storeRef, core), series_digest: series.series_digest };
  }

  // guard:quality-observation-ingest
  function refuse(store, storeRef, error, context, flags, identity) {
    const receipt = core.buildRejectionReceipt({ error, ...context, rejectedAt: now() });
    const receiptPath = store.writeRejection(receipt);
    const rejection = {
      store: storeRef, receipt_path: receiptPath, receipt_key: receipt.receipt_key,
      code: receipt.code, adapter: receipt.adapter, source_digest: receipt.source_digest,
    };
    withGovernanceMutation({
      ...mutationBase("observe-reject", flags, identity),
      idempotencyKey: `observe-reject:${storeRef}:${receipt.receipt_key}`,
      details: { event_type: REJECT_EVENT_TYPE, rejection },
    }, () => receiptPath);
    log(JSON.stringify({ event_type: REJECT_EVENT_TYPE, ...rejection }, null, 2));
    return fail(`gov observe ingest refused (${error.message}). Receipt: ${receiptPath} under ${store.root}`);
  }

  function ingest(flags) {
    if (!flags.format || !flags.report) fail(`gov observe ingest requires --format and --report.\n${OBSERVE_USAGE}`);
    const { store, storeRef } = storeFor(flags);
    const identity = actor();
    const context = {
      format: flags.format, repository: flags.repo, suite: flags.suite, commitSha: flags.commit,
      runtime: flags.runtime, attempt: flags.attempt, actor: identity?.agent?.handle || null, text: null,
    };
    let result;
    try {
      context.text = readReportText(flags.report);
      const artifact = core.normalizeRun({
        ...context, expectMeasurement: flags["expect-measurement"] === true, sourceRoot: flags["source-root"], ingestedAt: now(),
      });
      result = commit(store, storeRef, artifact, flags, identity);
    } catch (error) {
      if (!(error instanceof core.ObservationError)) throw error;
      // guard:quality-observation-ingest
      return refuse(store, storeRef, error, context, flags, identity);
    }
    log(JSON.stringify(result, null, 2));
    if (result.run_status === "measurement-expected-but-absent") {
      fail(`gov observe ingest: measurement was expected but absent (COORD-705); recorded ${result.content_digest} as a non-passing observation.`);
    }
    return result;
  }

  function replay(flags) {
    const { store, storeRef } = storeFor(flags);
    let entries;
    let derived;
    let journaledCount;
    try {
      const verified = verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      entries = verified.entries;
      journaledCount = verified.journaled_count;
      derived = store.rebuildSeries({ write: false });
    } catch (error) {
      // guard:quality-observation-ingest
      return fail(`gov observe replay refused: ${error.message}`);
    }
    if (flags.check === true && derived.stored_matches !== true) {
      fail(`gov observe replay --check: stored series.json does not match the rebuilt series ${derived.series_digest}.`);
    }
    if (flags.check !== true) store.rebuildSeries({ write: true });
    const result = {
      event_type: REPLAY_RESULT_TYPE, store: storeRef, run_count: entries.length, journal_events_verified: journaledCount,
      series_digest: derived.series_digest, stored_series_matched: derived.stored_matches, wrote_series: flags.check !== true,
    };
    log(JSON.stringify(result, null, 2));
    return result;
  }

  function series(flags) {
    const { store, storeRef } = storeFor(flags);
    let derived;
    try {
      verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      derived = store.rebuildSeries({ write: false });
    } catch (error) {
      // guard:quality-observation-ingest
      return fail(`gov observe series refused: ${error.message}`);
    }
    log(derived.bytes.trimEnd());
    return derived.series;
  }

  function quarantine(flags) {
    const { store, storeRef } = storeFor(flags);
    let record;
    try {
      record = core.validateQuarantine({
        repository: flags.repo, suite: flags.suite, testId: flags["test-id"], owner: flags.owner, reason: flags.reason,
        createdAt: flags["created-at"] || now(), expiresAt: flags["expires-at"], maxAgeDays: flags["max-age-days"],
      });
    } catch (error) {
      // guard:quality-observation-ingest
      return fail(`gov observe quarantine refused (${error.message}).`);
    }
    let status = null;
    const apply = () => {
      verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      status = store.recordQuarantine(record);
      store.rebuildSeries({ write: true });
    };
    withGovernanceMutation({
      ...mutationBase("observe-quarantine", flags, actor()),
      idempotencyKey: `observe-quarantine:${storeRef}:${record.quarantine_id}`,
      details: { event_type: QUARANTINE_EVENT_TYPE, quarantine: { store: storeRef, ...record } },
    }, apply);
    if (status === null) {
      const verified = verifyJournaledArtifacts(store, storeRef, readGovernanceEventLog(), core);
      if (!verified.quarantines.some((stored) => stored.quarantine_id === record.quarantine_id)) {
        throw new core.ObservationError("digest-mismatch", `idempotent quarantine ${record.quarantine_id} has no existing journaled record to replay`);
      }
      apply();
    }
    const result = { event_type: QUARANTINE_EVENT_TYPE, status, store: storeRef, ...record };
    log(JSON.stringify(result, null, 2));
    return result;
  }

  const SUBCOMMANDS = { ingest, replay, series, quarantine };

  function observe(argv) {
    const { sub, flags } = parseObserveArgs(argv, fail);
    if (!Object.hasOwn(SUBCOMMANDS, sub)) return fail(`gov observe: unknown subcommand ${JSON.stringify(sub)}.\n${OBSERVE_USAGE}`);
    return SUBCOMMANDS[sub](flags);
  }

  return { observe };
}

module.exports = {
  INGEST_EVENT_TYPE,
  REJECT_EVENT_TYPE,
  QUARANTINE_EVENT_TYPE,
  REPLAY_RESULT_TYPE,
  OBSERVE_USAGE,
  createObservationStore,
  createObservationCommands,
};
