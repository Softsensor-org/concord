"use strict";

// COORD-899 / ADR 0023 (Accepted 2026-11-15): bounded slice of attempt-aware coordination.
//
// Implemented here, and only here:
//   - the attempt record (coord.attempt/v1) and canonical ticket record
//     (coord.canonical-ticket/v1) shapes, with validators;
//   - the generation token <ticket>@<generation>:<oid> (ADR 0023 section 5.1);
//   - the namespace-restricted, exact-lease ref push primitive (section 5.3):
//     create-only with an empty expected value, advance only with an explicit
//     full object id and only as a fast-forward, and a refusal that names the
//     holder when the lease does not match;
//   - the crash-window classifier for a publish whose result is unknown
//     (windows A2 and C2 of section 7).
//
// Deliberately NOT implemented here (ADR 0023 open questions or later wiring):
//   - the physical namespace prefix (open question 1): every entry point requires
//     the caller to pass the full root; no default root exists;
//   - any governed verb (start, pick, next, explain, doctor, integration select,
//     board push, PR, land, finalize). This module is not called by any verb;
//   - host qualification (section 9) and reservations (section 8).
//
// The primitive is separate from the COORD-691 governed-push allowlist
// (control-plane-push.js assertGovernedPushArgv), which is unchanged and still
// refuses every force form for the integration branch.

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

const ATTEMPT_SCHEMA = "coord.attempt/v1";
const CANONICAL_SCHEMA = "coord.canonical-ticket/v1";
const ATTEMPT_STATES = Object.freeze(["active", "submitted", "withdrawn"]);
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TICKET_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const REMOTE_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const ROOT_RE = /^refs\/[A-Za-z0-9._\/-]+\/$/;
const REF_CHAR_RE = /^[A-Za-z0-9._\/-]+$/;

// guard:governed-push-safety
function refuse(message) {
  throw new Error(message);
}

// guard:governed-push-safety
function assertNamespaceRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    refuse(
      "Refusing a coordination ref operation with no namespace root. The physical prefix is an open " +
      "question of ADR 0023 (item 1) and no default is supplied; the caller must name it explicitly."
    );
  }
  if (root === "refs/heads/" || root === "refs/tags/") {
    refuse(`Refusing the namespace root "${root}": it covers every branch or tag, so it is not a coordination namespace.`);
  }
  if (!ROOT_RE.test(root) || root.includes("..") || root.includes("//")) {
    refuse(
      `Refusing the namespace root "${root}": it must be a refs/ path ending in "/" with no traversal ` +
      "(ADR 0023 section 2)."
    );
  }
  return root;
}

// guard:governed-push-safety
function assertRefInNamespace(ref, root) {
  assertNamespaceRoot(root);
  if (typeof ref !== "string" || !ref.startsWith(root) || ref.length === root.length) {
    refuse(`Refusing the ref "${ref}": it is outside the coordination namespace "${root}".`);
  }
  if (!REF_CHAR_RE.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock")) {
    refuse(`Refusing the ref "${ref}": not a plain ref name inside the coordination namespace.`);
  }
  return ref;
}

function attemptRef(root, ticket, domainId, attemptId) {
  assertNamespaceRoot(root);
  assertTicket(ticket);
  return assertRefInNamespace(`${root}attempts/${ticket}/${domainId}/${attemptId}`, root);
}

function canonicalRef(root, ticket) {
  assertNamespaceRoot(root);
  assertTicket(ticket);
  return assertRefInNamespace(`${root}canonical/${ticket}`, root);
}

// guard:governed-push-safety
function assertTicket(ticket) {
  if (typeof ticket !== "string" || !TICKET_RE.test(ticket)) {
    refuse(`Refusing the ticket id "${ticket}": expected a PREFIX-NUMBER id.`);
  }
  return ticket;
}

// Deterministic attempt id (ADR 0023 section 3): a retried publish from the same
// domain journal transaction converges on one id.
// guard:plan-record-schema
function deriveAttemptId(domainId, journalTxId) {
  if (typeof domainId !== "string" || domainId.length === 0 || typeof journalTxId !== "string" || journalTxId.length === 0) {
    refuse("Refusing to derive an attempt id without a domain id and a journal transaction id.");
  }
  return crypto.createHash("sha256").update(`${domainId}\n${journalTxId}`).digest("hex").slice(0, 32);
}

// ---- records --------------------------------------------------------------

function validateAttemptRecord(record) {
  const problems = [];
  if (!record || typeof record !== "object") return ["attempt record must be an object"];
  if (record.schema !== ATTEMPT_SCHEMA) problems.push(`schema must be ${ATTEMPT_SCHEMA}`);
  if (!TICKET_RE.test(String(record.ticket))) problems.push("ticket must be a PREFIX-NUMBER id");
  if (!/^[0-9a-f]{32}$/.test(String(record.attempt_id))) problems.push("attempt_id must be 32 lowercase hex characters");
  if (!record.agent || typeof record.agent.handle !== "string") problems.push("agent.handle is required");
  if (typeof record.domain_id !== "string" || record.domain_id.length === 0) problems.push("domain_id is required");
  if (!OID_RE.test(String(record.base_sha))) problems.push("base_sha must be a full object id");
  if (typeof record.branch !== "string" || record.branch.length === 0) problems.push("branch is required");
  if (!record.observed_canonical || !Number.isInteger(record.observed_canonical.generation)) {
    problems.push("observed_canonical.generation must be an integer");
  }
  if (!ATTEMPT_STATES.includes(record.state)) problems.push(`state must be one of ${ATTEMPT_STATES.join(", ")}`);
  return problems;
}

// guard:plan-record-schema
function makeAttemptRecord({ ticket, agent, domainId, domainLabel, journalTxId, baseSha, branch, observedCanonical, state = "active", now }) {
  const record = {
    schema: ATTEMPT_SCHEMA,
    ticket,
    attempt_id: deriveAttemptId(domainId, journalTxId),
    agent,
    domain_id: domainId,
    domain_label: domainLabel || null,
    base_sha: baseSha,
    branch,
    observed_canonical: observedCanonical,
    state,
    updated_at: now,
  };
  const problems = validateAttemptRecord(record);
  if (problems.length > 0) refuse(`Refusing to build an invalid attempt record: ${problems.join("; ")}.`);
  return record;
}

function validateCanonicalRecord(record) {
  const problems = [];
  if (!record || typeof record !== "object") return ["canonical record must be an object"];
  if (record.schema !== CANONICAL_SCHEMA) problems.push(`schema must be ${CANONICAL_SCHEMA}`);
  if (!TICKET_RE.test(String(record.ticket))) problems.push("ticket must be a PREFIX-NUMBER id");
  if (!Number.isInteger(record.generation) || record.generation < 0) problems.push("generation must be a non-negative integer");
  if (typeof record.status !== "string" || record.status.length === 0) problems.push("status is required");
  if (typeof record.owner !== "string" || record.owner.length === 0) problems.push("owner is required");
  if (record.selected_attempt !== null && !/^[0-9a-f]{32}$/.test(String(record.selected_attempt))) {
    problems.push("selected_attempt must be null or an attempt id");
  }
  return problems;
}

// ---- generation token ------------------------------------------------------

// guard:plan-record-schema
function formatGenerationToken(ticket, generation, oid) {
  assertTicket(ticket);
  if (!Number.isInteger(generation) || generation < 0) refuse(`Refusing a generation ${generation}: must be a non-negative integer.`);
  if (!OID_RE.test(String(oid))) refuse(`Refusing the generation token oid "${oid}": must be a full object id.`);
  return `${ticket}@${generation}:${oid}`;
}

// guard:plan-record-schema
function parseGenerationToken(token) {
  const match = /^([A-Z][A-Z0-9]*-\d+)@(0|[1-9]\d*):([0-9a-f]{40}|[0-9a-f]{64})$/.exec(String(token));
  if (!match) refuse(`Refusing the generation token "${token}": expected <TICKET>@<generation>:<oid>.`);
  return { ticket: match[1], generation: Number(match[2]), oid: match[3] };
}

// ---- lease push primitive --------------------------------------------------

// Argv for one exact-lease publish. expectedOid === null means create-only:
// `--force-with-lease=<ref>:` with an empty expected value requires the ref to be
// absent. Otherwise the lease names the exact previous oid.
// guard:governed-push-safety
function buildLeasedPushArgv({ remote, ref, root, expectedOid, newOid }) {
  if (typeof remote !== "string" || !REMOTE_RE.test(remote)) refuse(`Refusing the remote name "${remote}".`);
  assertRefInNamespace(ref, root);
  if (!OID_RE.test(String(newOid))) refuse(`Refusing the new value "${newOid}": a publish names an explicit full object id.`);
  if (expectedOid !== null && !OID_RE.test(String(expectedOid))) {
    refuse(`Refusing the lease value "${expectedOid}": a lease names an explicit full object id, or null for create-only.`);
  }
  if (expectedOid === newOid) refuse(`Refusing a no-op publish of ${newOid} to ${ref}.`);
  const lease = `--force-with-lease=${ref}:${expectedOid === null ? "" : expectedOid}`;
  return ["push", "--porcelain", lease, remote, `${newOid}:${ref}`];
}

function git(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

// The value the remote currently advertises for one ref, or null when absent.
// guard:governed-push-safety
function readRemoteRef(repoRoot, remote, ref) {
  const result = git(repoRoot, ["ls-remote", remote, ref]);
  if (result.status !== 0) refuse(`Could not read ${ref} from ${remote}: ${result.stderr || "ls-remote failed"}`);
  const line = result.stdout.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
  return line ? line.split("\t")[0] : null;
}

function isFastForward(repoRoot, expectedOid, newOid) {
  const result = git(repoRoot, ["merge-base", "--is-ancestor", expectedOid, newOid]);
  return result.status === 0;
}

// Publishes one ref under an exact lease. Returns one of:
//   { status: "published", oid }
//   { status: "refused", reason: "lease-mismatch" | "lost-race", holder }   (holder names the current oid, or null when absent)
//   { status: "error", stderr }
// A refusal is decided against the advertised value, not against push rejection text.
// guard:governed-push-safety
function publishWithLease(repoRoot, options) {
  const { remote, ref, root, expectedOid = null, newOid } = options;
  const argv = buildLeasedPushArgv({ remote, ref, root, expectedOid, newOid });
  if (expectedOid !== null && !isFastForward(repoRoot, expectedOid, newOid)) {
    refuse(`Refusing to advance ${ref} to ${newOid}: it does not descend from the lease value ${expectedOid} (fast-forward only).`);
  }
  const advertised = readRemoteRef(repoRoot, remote, ref);
  if (advertised !== expectedOid) {
    return { status: "refused", reason: "lease-mismatch", holder: advertised };
  }
  const pushed = git(repoRoot, argv);
  if (pushed.status === 0) return { status: "published", oid: newOid };
  const after = readRemoteRef(repoRoot, remote, ref);
  if (after !== expectedOid) return { status: "refused", reason: "lost-race", holder: after };
  return { status: "error", stderr: pushed.stderr || pushed.stdout };
}

// Recovery for a publish whose result is unknown (ADR 0023 section 7, windows A2 and C2).
// The remote value decides: the intended new oid means the push applied; the expected
// value (or absent, for create-only) means it did not apply and may be retried; anything
// else is a foreign advance and must be refused for operator recovery.
function classifyUnknownPublish(repoRoot, { remote, ref, root, expectedOid = null, newOid }) {
  buildLeasedPushArgv({ remote, ref, root, expectedOid, newOid });
  const current = readRemoteRef(repoRoot, remote, ref);
  if (current === newOid) return { window: "published", action: "journal-published", holder: current };
  if (current === expectedOid) return { window: "unapplied", action: "retry", holder: current };
  return { window: "foreign", action: "report-foreign-advance", holder: current };
}

module.exports = {
  ATTEMPT_SCHEMA,
  CANONICAL_SCHEMA,
  ATTEMPT_STATES,
  assertNamespaceRoot,
  assertRefInNamespace,
  attemptRef,
  canonicalRef,
  deriveAttemptId,
  makeAttemptRecord,
  validateAttemptRecord,
  validateCanonicalRecord,
  formatGenerationToken,
  parseGenerationToken,
  buildLeasedPushArgv,
  readRemoteRef,
  publishWithLease,
  classifyUnknownPublish,
};
