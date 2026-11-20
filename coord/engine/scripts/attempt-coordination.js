"use strict";

// COORD-1028 / ADR 0023 (human-admin answers 2026-11-16): attempt publishing, the
// canonical fence and integration selection on top of attempt-ref-lease.js.
//
// Answers applied here:
//   1. refs live under refs/heads/coord-state/ (COORD_STATE_ROOT);
//   2. opening an attempt never changes canonical status, and a selection moves
//      status to doing only through the integrator;
//   3. the fence checked here (verifyFence) is the enforced client-side guarantee;
//      host-side restriction is advisory;
//   5. select-only: one selected attempt, no combine;
//   7. domain_id is minted once per runtime and kept in domain-id.json.
//
// COORD-1047 added publish at gov start (d) and report-only attempt health (b, c).
// Not implemented in this module (see the COORD-1028 report): fence checks at board push, PR creation, land and finalize,
// canonical bootstrap from the live board, pick/next/explain/doctor listing,
// reservations, the hosting probe, and crash-window recovery.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const lease = require("./attempt-ref-lease.js");

const COORD_STATE_ROOT = "refs/heads/coord-state/";
const DOMAIN_FILE = "domain-id.json";
const RECORD_FILE = "record.json";
const CANONICAL_STATUSES = Object.freeze(["todo", "doing", "review", "done"]);

// guard:governed-push-safety
function fail(message) {
  throw new Error(message);
}

function git(repoRoot, args, input) {
  const env = { ...process.env };
  if (!env.GIT_AUTHOR_NAME) env.GIT_AUTHOR_NAME = "coord-attempt";
  if (!env.GIT_AUTHOR_EMAIL) env.GIT_AUTHOR_EMAIL = "coord-attempt@invalid";
  if (!env.GIT_COMMITTER_NAME) env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  if (!env.GIT_COMMITTER_EMAIL) env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", input, env });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

// ---- domain identity (ADR 0023 section 1, answer 7) -------------------------

// Mints a random, stable domain id on first use and keeps it in the runtime
// directory. Host, clone path and handle are diagnostics only.
function mintDomainId(runtimeDir, { label = null, now = new Date().toISOString() } = {}) {
  const file = path.join(runtimeDir, DOMAIN_FILE);
  if (fs.existsSync(file)) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^[0-9a-f]{32}$/.test(String(record.domain_id))) fail(`${file} holds an invalid domain_id.`);
    return record;
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const record = { domain_id: crypto.randomBytes(16).toString("hex"), domain_label: label, minted_at: now };
  try {
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") return mintDomainId(runtimeDir, { label, now });
    throw error;
  }
  return record;
}

// ---- record commits ---------------------------------------------------------

// One commit whose tree holds RECORD_FILE and whose parent is the previous record.
function writeRecordCommit(repoRoot, record, parentOid, message) {
  const blob = git(repoRoot, ["hash-object", "-w", "--stdin"], `${JSON.stringify(record, null, 2)}\n`);
  if (blob.status !== 0) fail(`Could not store the record blob: ${blob.stderr}`);
  const tree = git(repoRoot, ["mktree"], `100644 blob ${blob.stdout}\t${RECORD_FILE}\n`);
  if (tree.status !== 0) fail(`Could not build the record tree: ${tree.stderr}`);
  const args = ["commit-tree", tree.stdout, "-m", message];
  if (parentOid) args.push("-p", parentOid);
  const commit = git(repoRoot, args);
  if (commit.status !== 0) fail(`Could not write the record commit: ${commit.stderr}`);
  return commit.stdout;
}

function readRecordAt(repoRoot, oid) {
  const shown = git(repoRoot, ["show", `${oid}:${RECORD_FILE}`]);
  if (shown.status !== 0) fail(`Could not read ${RECORD_FILE} at ${oid}: ${shown.stderr}`);
  return JSON.parse(shown.stdout);
}

// Fetches one remote ref and returns its record and oid, or null when absent.
function readRemoteRecord(repoRoot, remote, ref) {
  const oid = lease.readRemoteRef(repoRoot, remote, ref);
  if (oid === null) return null;
  const fetched = git(repoRoot, ["fetch", "--no-tags", "--quiet", remote, ref]);
  if (fetched.status !== 0) fail(`Could not fetch ${ref} from ${remote}: ${fetched.stderr}`);
  return { ref, oid, record: readRecordAt(repoRoot, oid) };
}

// ---- attempts ---------------------------------------------------------------

// Publishes one attempt record create-only. A retry from the same domain journal
// transaction converges on the same attempt id: when the ref already holds this
// attempt, the existing oid is returned instead of a second publish.
function publishAttempt(repoRoot, options) {
  const { remote, root = COORD_STATE_ROOT, ticket, domainId, domainLabel = null, journalTxId, agent, baseSha, branch, observedCanonical, now = new Date().toISOString() } = options;
  const record = lease.makeAttemptRecord({ ticket, agent, domainId, domainLabel, journalTxId, baseSha, branch, observedCanonical, state: "active", now });
  const ref = lease.attemptRef(root, ticket, domainId, record.attempt_id);
  const existing = lease.readRemoteRef(repoRoot, remote, ref);
  if (existing !== null) {
    const held = readRemoteRecord(repoRoot, remote, ref).record;
    if (held.attempt_id !== record.attempt_id || held.domain_id !== domainId) fail(`Attempt id collision on ${ref}.`);
    return { status: "already-published", ref, oid: existing, attempt_id: record.attempt_id };
  }
  const commit = writeRecordCommit(repoRoot, record, null, `${ticket}: attempt ${record.attempt_id} from ${domainId}`);
  const published = lease.publishWithLease(repoRoot, { remote, ref, root, expectedOid: null, newOid: commit });
  return { ...published, ref, attempt_id: record.attempt_id, record };
}

// COORD-1041 (ADR 0023 section 7 and answer 6): report-only thresholds. Nothing here deletes or
// rewrites a ref; the classes are advisory for doctor and the attempts listing.
const ATTEMPT_STALE_MS = 72 * 60 * 60 * 1000;
const ATTEMPT_ORPHAN_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Classifies one attempt against the canonical record it is compared with. Classes:
//   attempt-stale       active and not updated for ATTEMPT_STALE_MS;
//   attempt-orphaned    active and (canonical done, or another attempt selected, or not
//                       updated for ATTEMPT_ORPHAN_MS);
//   retention-eligible  canonical done for TERMINAL_RETENTION_MS. Eligibility only: deletion
//                       is not implemented (ADR 0023 section 2 forbids automatic deletion).
function classifyAttempt(attempt, canonical, nowMs) {
  const classes = [];
  const updated = Date.parse(attempt.record.updated_at);
  if (Number.isNaN(updated)) return { age_ms: null, classes: ["timestamp-invalid"] };
  const age = nowMs - updated;
  const canonicalRecord = canonical ? canonical.record : null;
  const terminal = Boolean(canonicalRecord && canonicalRecord.status === "done");
  const selectedOther = Boolean(canonicalRecord && canonicalRecord.selected_attempt && canonicalRecord.selected_attempt !== attempt.record.attempt_id);
  const active = attempt.record.state === "active";
  if (active && age >= ATTEMPT_STALE_MS) classes.push("attempt-stale");
  if (active && (terminal || selectedOther || age >= ATTEMPT_ORPHAN_MS)) classes.push("attempt-orphaned");
  if (terminal) {
    const terminalSince = Date.parse(canonicalRecord.updated_at);
    if (!Number.isNaN(terminalSince) && nowMs - terminalSince >= TERMINAL_RETENTION_MS) classes.push("retention-eligible");
  }
  return { age_ms: age, classes };
}

// Read-only listing of every attempt for one ticket, across all domains. Each entry carries a
// report-only classification against the canonical record (COORD-1041 (c)).
function listAttempts(repoRoot, { remote, root = COORD_STATE_ROOT, ticket, now = Date.now() }) {
  lease.assertNamespaceRoot(root);
  // guard:governed-push-safety
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(String(ticket))) fail(`Refusing the ticket id "${ticket}": expected a PREFIX-NUMBER id.`);
  const prefix = `${root}attempts/${ticket}/`;
  const listed = git(repoRoot, ["ls-remote", remote]);
  if (listed.status !== 0) fail(`Could not list refs of ${remote}: ${listed.stderr}`);
  const refs = listed.stdout.split("\n")
    .map((line) => line.split("\t")[1])
    .filter((ref) => typeof ref === "string" && ref.startsWith(prefix));
  const canonical = readCanonical(repoRoot, { remote, root, ticket });
  return refs.map((ref) => readRemoteRecord(repoRoot, remote, ref)).filter(Boolean)
    .map((attempt) => ({ ...attempt, classification: classifyAttempt(attempt, canonical, now) }));
}

// ---- canonical record and fence (ADR 0023 sections 4 and 5) -----------------

function canonicalRefFor(root, ticket) {
  return lease.canonicalRef(root, ticket);
}

function readCanonical(repoRoot, { remote, root = COORD_STATE_ROOT, ticket }) {
  return readRemoteRecord(repoRoot, remote, canonicalRefFor(root, ticket));
}

// The generation token for a canonical record at a known oid (<ticket>@<gen>:<oid>).
function tokenFor(ticket, record, oid) {
  return lease.formatGenerationToken(ticket, record.generation, oid);
}

// Creates a canonical record at generation 0. Create-only: an existing record is
// returned unchanged.
function bootstrapCanonical(repoRoot, { remote, root = COORD_STATE_ROOT, ticket, owner, status = "todo", authorityEpoch, now = new Date().toISOString() }) {
  const ref = canonicalRefFor(root, ticket);
  const existing = readRemoteRecord(repoRoot, remote, ref);
  if (existing) return { ...existing, bootstrapped: false };
  const record = canonicalRecord({ ticket, generation: 0, owner, status, selected: null, rejected: [], integrator: null, authorityEpoch, txn: null, now });
  const commit = writeRecordCommit(repoRoot, record, null, `${ticket}: canonical bootstrap generation 0`);
  const published = lease.publishWithLease(repoRoot, { remote, ref, root, expectedOid: null, newOid: commit });
  if (published.status !== "published") fail(`Canonical bootstrap for ${ticket} was not published: ${JSON.stringify(published)}`);
  return { ref, oid: commit, record, bootstrapped: true };
}

function canonicalRecord({ ticket, generation, owner, status, selected, rejected, integrator, authorityEpoch, txn, now }) {
  // guard:governed-push-safety
  if (!CANONICAL_STATUSES.includes(status)) fail(`Refusing canonical status "${status}".`);
  const record = {
    schema: lease.CANONICAL_SCHEMA,
    ticket,
    generation,
    status,
    owner,
    selected_attempt: selected,
    rejected_attempts: rejected,
    integrator,
    authority_epoch: authorityEpoch,
    decision_txn: txn,
    updated_at: now,
  };
  const problems = lease.validateCanonicalRecord(record);
  // guard:governed-push-safety
  if (problems.length > 0) fail(`Refusing an invalid canonical record: ${problems.join("; ")}.`);
  return record;
}

// Advances the canonical ref under an exact lease. The new commit's parent is the
// oid the integrator decided from, and the generation must step by one.
function publishCanonicalTransition(repoRoot, { remote, root = COORD_STATE_ROOT, ticket, expected, next }) {
  if (next.generation !== expected.record.generation + 1) fail(`Canonical generation must step from ${expected.record.generation} to ${expected.record.generation + 1}.`);
  const ref = canonicalRefFor(root, ticket);
  const commit = writeRecordCommit(repoRoot, next, expected.oid, `${ticket}: canonical generation ${next.generation}`);
  return { ...lease.publishWithLease(repoRoot, { remote, ref, root, expectedOid: expected.oid, newOid: commit }), ref, commit };
}

// The client-side fence (answer 3). A holder presenting a token that is not the
// current canonical generation, or whose authority epoch differs, is refused.
function verifyFence(repoRoot, { remote, root = COORD_STATE_ROOT, ticket, token, authorityEpoch }) {
  const parsed = lease.parseGenerationToken(token);
  if (parsed.ticket !== ticket) return { ok: false, reason: "wrong-ticket", current_token: null };
  const current = readCanonical(repoRoot, { remote, root, ticket });
  if (!current) return { ok: false, reason: "absent", current_token: null };
  const currentToken = tokenFor(ticket, current.record, current.oid);
  if (current.oid !== parsed.oid || current.record.generation !== parsed.generation) {
    return { ok: false, reason: "stale", current_token: currentToken,
      authority_epoch: current.record.authority_epoch, selected_attempt: current.record.selected_attempt || null };
  }
  if (authorityEpoch !== undefined && current.record.authority_epoch !== authorityEpoch) {
    return { ok: false, reason: "epoch", current_token: currentToken,
      authority_epoch: current.record.authority_epoch, selected_attempt: current.record.selected_attempt || null };
  }
  return { ok: true, reason: "current", current_token: currentToken,
    authority_epoch: current.record.authority_epoch, selected_attempt: current.record.selected_attempt || null };
}

// ---- COORD-1047 (d): publish at gov start, best-effort ----------------------

// Called by the start verb AFTER the runtime lock is released (cli.js), never from inside
// withGovernanceMutation. It never throws and never blocks start: every failure is returned as a
// warning. The attempt is then unpublished (ADR 0023 window A1) and invisible to integration.
// The attempt id derives from the branch and base, so a retried start converges on one id.
function publishStartAttempt(repoRoot, { remote = "origin", runtimeDir, ticket, handle, branch, baseSha = null, baseRef = null, now = new Date().toISOString() }) {
  const base = baseSha || (baseRef ? git(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).stdout : "") || null;
  if (!base) {
    return { status: "skipped", ref: null, attempt_id: null, warning: `attempt for ${ticket} not published: no base commit was resolved for this repo.` };
  }
  try {
    const domain = mintDomainId(runtimeDir, { label: handle, now });
    const canonical = readCanonical(repoRoot, { remote, ticket });
    const result = publishAttempt(repoRoot, {
      remote, ticket, domainId: domain.domain_id, domainLabel: handle,
      journalTxId: `start:${ticket}:${branch}:${base}`,
      agent: { handle }, baseSha: base, branch,
      observedCanonical: { generation: canonical ? canonical.record.generation : 0 },
      now,
    });
    return { status: result.status, ref: result.ref, attempt_id: result.attempt_id, warning: null };
  } catch (error) {
    return {
      status: "failed", ref: null, attempt_id: null,
      warning: `attempt for ${ticket} not published to ${remote}: ${error.message} Start continues; the attempt stays local (ADR 0023 window A1) and integration cannot see it until it is published.`,
    };
  }
}

// ---- COORD-1047 (b) and (c): report-only attempt health ----------------------

function hasRemote(repoRoot, remote) {
  return git(repoRoot, ["remote", "get-url", remote]).status === 0;
}

// Read-only attempts of one ticket for explain and doctor. A repository without the remote has no
// coordination namespace to read and returns skipped; a listing failure is returned as a problem.
function listTicketAttempts(repoRoot, { remote = "origin", ticket, now = Date.now() }) {
  if (!hasRemote(repoRoot, remote)) return { skipped: "no-remote", attempts: [], problems: [] };
  try {
    const attempts = listAttempts(repoRoot, { remote, ticket, now }).map((attempt) => ({
      ref: attempt.ref, attempt_id: attempt.record.attempt_id, domain_id: attempt.record.domain_id,
      domain_label: attempt.record.domain_label, agent: attempt.record.agent.handle, branch: attempt.record.branch,
      base_sha: attempt.record.base_sha, state: attempt.record.state, updated_at: attempt.record.updated_at,
      age_ms: attempt.classification.age_ms, classes: attempt.classification.classes,
    }));
    return { skipped: null, attempts, problems: [] };
  } catch (error) {
    return { skipped: null, attempts: [], problems: [{ ticket, message: String(error.message || error) }] };
  }
}

// Report-only attempt health for doctor. Returns only the stale and orphaned classes as findings.
// Never writes, rewrites or deletes a ref.
function attemptHealth(repoRoot, { remote = "origin", tickets = [], now = Date.now() }) {
  const findings = [];
  const problems = [];
  let skipped = null;
  for (const ticket of tickets) {
    const listed = listTicketAttempts(repoRoot, { remote, ticket, now });
    if (listed.skipped) { skipped = listed.skipped; break; }
    problems.push(...listed.problems);
    for (const attempt of listed.attempts) {
      for (const cls of attempt.classes) {
        if (cls !== "attempt-stale" && cls !== "attempt-orphaned") continue;
        findings.push({ ticket, class: cls, attempt_id: attempt.attempt_id, domain_id: attempt.domain_id,
          agent: attempt.agent, updated_at: attempt.updated_at, age_ms: attempt.age_ms, ref: attempt.ref });
      }
    }
  }
  return { skipped, findings, problems };
}

module.exports = {
  COORD_STATE_ROOT,
  DOMAIN_FILE,
  RECORD_FILE,
  mintDomainId,
  publishAttempt,
  publishStartAttempt,
  attemptHealth,
  listTicketAttempts,
  listAttempts,
  readCanonical,
  tokenFor,
  bootstrapCanonical,
  canonicalRecord,
  publishCanonicalTransition,
  verifyFence,
  classifyAttempt,
  ATTEMPT_STALE_MS,
  ATTEMPT_ORPHAN_MS,
  TERMINAL_RETENTION_MS,
};
