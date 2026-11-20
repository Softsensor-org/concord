"use strict";

// ADR 0031 (COORD-1034): verification of signed human-admin approval records.
// The engine never mints an approval. It asks the coordapprove wrapper (`sign`, through
// one sudo rule) for a record, then verifies that record against the trust anchor before
// any human-only mutation. Override strings are not evidence.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRODUCTION_TRUST_ANCHOR = "/etc/coord-approval/approval-public.pem";
const PRODUCTION_SIGN_COMMAND = Object.freeze([
  "sudo", "-n", "-u", "coordapprove", "/usr/local/libexec/coord-approval/coord-approve", "sign",
]);
const REQUEST_SCHEMA = "coord.approval-request/v1";
const RECORD_SCHEMA = "coord.approval-record/v1";
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const SIGN_TIMEOUT_MS = 10 * 1000;

// Production always uses the OS-owned trust anchor. Test fixtures provide an
// explicit verifier dependency to their isolated test harness; environment
// variables and NODE_TEST_CONTEXT never select an approval authority.
function trustAnchorPath() {
  return PRODUCTION_TRUST_ANCHOR;
}

function signCommand() {
  return [...PRODUCTION_SIGN_COMMAND];
}

// Canonical JSON: object keys sorted at every depth, no whitespace. Both the signer and
// the verifier hash this form, so it must be stable.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// subject_sha256 = SHA-256 of canonical JSON of {verb, ticket, reason_sha256, state_sha256}
// (ADR 0031 section 2).
function subjectSha256({ verb, ticket, reason, state }) {
  return sha256Hex(canonicalJson({
    verb,
    ticket,
    reason_sha256: sha256Hex(String(reason ?? "")),
    state_sha256: sha256Hex(String(state ?? "")),
  }));
}

// Loads the trust anchor. key_id is the SHA-256 of the DER SubjectPublicKeyInfo (ADR 0031 section 1).
function loadTrustAnchor(filePath = trustAnchorPath()) {
  let pem;
  try {
    pem = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, refused: "store-unavailable", detail: `trust anchor unreadable at ${filePath}` };
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch {
    return { ok: false, refused: "store-unavailable", detail: "trust anchor is not a public key" };
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    return { ok: false, refused: "store-unavailable", detail: "trust anchor is not Ed25519" };
  }
  const der = publicKey.export({ type: "spki", format: "der" });
  return { ok: true, publicKey, key_id: sha256Hex(der), path: filePath };
}

// Verifies one record against the request that produced it. `isRecordUsed(record_id)`
// reports whether the journal already holds that record (single use).
function verifyApprovalRecord(record, { request, anchor, isRecordUsed, now = Date.now() }) {
  if (!record || typeof record !== "object" || record.schema !== RECORD_SCHEMA || typeof record.signature !== "string") {
    return { ok: false, refused: "bad-record", detail: "record is not a coord.approval-record/v1 with a signature" };
  }
  for (const field of ["verb", "ticket", "subject_sha256", "nonce"]) {
    if (record[field] !== request[field]) {
      return { ok: false, refused: "scope-mismatch", detail: `record ${field} differs from the request` };
    }
  }
  if (record.key_id !== anchor.key_id) {
    return { ok: false, refused: "key-mismatch", detail: "record key_id is not the trust anchor key" };
  }
  const { signature, ...unsigned } = record;
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, Buffer.from(canonicalJson(unsigned)), anchor.publicKey, Buffer.from(signature, "base64"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, refused: "bad-signature", detail: "Ed25519 signature does not verify" };
  const expires = Date.parse(record.expires_at);
  if (!Number.isFinite(expires) || now > expires) {
    return { ok: false, refused: "record-expired", detail: `record expired at ${record.expires_at}` };
  }
  const issued = Date.parse(record.issued_at);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, refused: "record-stale", detail: "record issued_at is outside the 60 second window" };
  }
  if (isRecordUsed(record.record_id)) {
    return { ok: false, refused: "record-reused", detail: `record ${record.record_id} is already in the journal` };
  }
  return { ok: true, record, key_id: anchor.key_id, session_id: record.session_id, record_id: record.record_id };
}

// Builds a request, asks the wrapper to sign it, and verifies the result. `runSign` is
// injectable for tests; the default runs the sign command with a reset environment, no shell,
// a 10 second timeout and the request on stdin (ADR 0031 section 4).
function requestApproval({ verb, ticket, subject_sha256, isRecordUsed, runSign, anchor, now = new Date() }) {
  const request = {
    schema: REQUEST_SCHEMA,
    verb,
    ticket,
    subject_sha256,
    nonce: crypto.randomBytes(16).toString("hex"),
    requested_at: now.toISOString(),
  };
  const requestText = JSON.stringify(request);
  if (Buffer.byteLength(requestText) > 4096) return { ok: false, refused: "bad-request", detail: "request exceeds 4096 bytes" };
  const trust = anchor || loadTrustAnchor();
  if (!trust.ok) return trust;
  const sign = runSign || defaultRunSign;
  const result = sign(requestText);
  if (!result.ok) return result;
  let record;
  try {
    record = JSON.parse(result.stdout);
  } catch {
    return { ok: false, refused: "bad-record", detail: "wrapper output is not JSON" };
  }
  return verifyApprovalRecord(record, { request, anchor: trust, isRecordUsed, now: now.getTime() });
}

function defaultRunSign(requestText) {
  const { spawnSync } = require("child_process");
  const [command, ...args] = signCommand();
  const result = spawnSync(command, args, {
    input: requestText,
    encoding: "utf8",
    timeout: SIGN_TIMEOUT_MS,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const refused = (() => {
      // guard:bound-owner
      try { return JSON.parse((result.stderr || "").trim().split("\n").pop()).refused; } catch { return "store-unavailable"; }
    })();
    return { ok: false, refused, detail: `sign exited ${result.status}` };
  }
  return { ok: true, stdout: result.stdout };
}

// ADR 0031 section 3 transition window (human decision 2026-11-16). Only these verbs may
// proceed on an unsigned override, and only until window_ends_at in the engine config.
const WINDOW_VERBS = new Set(["integration handoff", "integration recover --abandon"]);
// Refusals that mean no verified record exists yet (no wrapper, no session). Tampering,
// scope, key and replay refusals never fall through to the window.
const WINDOW_CODES = new Set(["no-session", "store-unavailable"]);
const TRANSITION_CONFIG_PATH = path.resolve(__dirname, "..", "approval-transition.json");

function readTransitionConfig(file = TRANSITION_CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { window_ends_at: null };
  }
}

function transitionWindowOpen(verb, { now = Date.now(), config = readTransitionConfig() } = {}) {
  if (!WINDOW_VERBS.has(verb)) return false;
  const ends = Date.parse(config.window_ends_at);
  return Number.isFinite(ends) && now < ends;
}

// Single-use check against the governance journal: a verified record id is journaled as
// approval_record. The journal is append-only NDJSON, so a substring match on the field is exact
// for 32-hex record ids.
function journalRecordUsed(journalFile) {
  // No journal location known: fail closed and treat every record as already used.
  if (!journalFile) return () => true;
  return (recordId) => {
    try {
      return fs.readFileSync(journalFile, "utf8").includes(`"approval_record":"${recordId}"`);
    } catch {
      return false;
    }
  };
}

// What a dry-run preview reports: the signed approval the human must give, never a grant.
function approvalRequirement({ verb, ticket, reason, row }) {
  const subjectDigest = subjectSha256({ verb, ticket, reason, state: canonicalJson(row) });
  return {
    signed_approval: "required",
    verb,
    ticket,
    subject_sha256: subjectDigest,
    login_command: loginCommand({ verb, ticket, subjectDigest }),
    note: "an override string is not evidence; the engine verifies a signed record at execution",
  };
}

function loginCommand({ verb, ticket, subjectDigest }) {
  return `sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb ${verb} --ticket ${ticket} --subject ${subjectDigest} --ttl-minutes 15`;
}

// The one central check (ADR 0031 section 4). Returns a result; the caller decides how to fail.
//   ok:true, mode:"signed"      a record verified and was journaled by the caller
//   ok:true, mode:"transition"  unsigned override accepted in the window (warning set, journaled)
//   ok:false                    refused; message names the subject digest and the login command
function requireHumanAdminApproval({ verb, ticket, subjectDigest, reason, journal, recordUsed, runSign, anchor, now = new Date(), config }) {
  const verified = requestApproval({
    verb,
    ticket,
    subject_sha256: subjectDigest,
    isRecordUsed: recordUsed,
    runSign,
    anchor: anchor || loadTrustAnchor(),
    now,
  });
  if (verified.ok) {
    journal({
      event: "approval.verified",
      command: verb,
      ticket,
      subject_sha256: subjectDigest,
      human_admin_session: verified.session_id,
      approval_record: verified.record_id,
      approval_verified: `key_id=${verified.key_id}`,
      override_reason: reason,
    });
    return { ok: true, mode: "signed", session_id: verified.session_id, record_id: verified.record_id, key_id: verified.key_id };
  }
  const windowOpen = transitionWindowOpen(verb, { now: now.getTime(), config });
  if (windowOpen && WINDOW_CODES.has(verified.refused) && String(reason || "").trim()) {
    const warning = `unverified override (ADR 0031 transition): ${verb} accepted on a reason alone until ${(config || readTransitionConfig()).window_ends_at}; no signed approval record`;
    // guard:bound-owner
    journal({ event: "override_without_session", command: verb, ticket, subject_sha256: subjectDigest, override_reason: reason, refused: verified.refused });
    return { ok: true, mode: "transition", warning };
  }
  // guard:bound-owner
  journal({ event: "approval.refused", command: verb, ticket, subject_sha256: subjectDigest, refused: verified.refused, override_reason: reason || null });
  return {
    ok: false,
    refused: verified.refused,
    message:
      // guard:bound-owner
      `${verb} on ${ticket} requires a signed human-admin approval (ADR 0031); refused: ${verified.refused}. ` +
      `An override string is not evidence. Subject digest: ${subjectDigest}. ` +
      `A human admin reads the board row, then runs on a terminal: ${loginCommand({ verb, ticket, subjectDigest })}`,
  };
}

function requireHumanAdminApprovalForState({ verb, ticket, reason, state, appendGovernanceEvent, runtimeDir, recordUsed, fail, approvalClient, now = new Date(), config }) {
  const subjectDigest = subjectSha256({ verb, ticket, reason, state: canonicalJson(state) });
  const verdict = requireHumanAdminApproval({
    verb,
    ticket,
    subjectDigest,
    reason,
    journal: (event) => appendGovernanceEvent({ ts: now.toISOString(), ...event }),
    recordUsed: recordUsed || journalRecordUsed(runtimeDir ? path.join(runtimeDir, "governance-events.ndjson") : null),
    anchor: approvalClient?.anchor,
    runSign: approvalClient?.runSign,
    now,
    config,
  });
  if (!verdict.ok) {
    if (typeof fail === "function") fail(verdict.message);
    throw new Error(verdict.message);
  }
  if (verdict.mode === "transition") process.stderr.write(`${verdict.warning}\n`);
  return { ...verdict, subject_sha256: subjectDigest };
}

// Claim --transfer-to glue (agent-commands.js calls this). The reason is still required (resolved),
// the bare --force alias is refused, and the central check decides. Refusals go through deps.fail.
function requireSignedOverride({ commandName, ticketId, row, options, deps, approvalClient }) {
  if (!deps || typeof deps.resolveHumanAdminOverride !== "function" || typeof deps.fail !== "function" ||
      typeof deps.appendGovernanceEvent !== "function" || !deps.runtimeDir) {
    throw new TypeError("requireSignedOverride requires explicit resolver, fail, journal, and runtimeDir dependencies");
  }
  const { resolveHumanAdminOverride, fail, appendGovernanceEvent, runtimeDir } = deps;
  const normalizedOptions = options && options.humanAdminOverride === undefined && options.override !== undefined
    ? { ...options, humanAdminOverride: options.override }
    : options;
  const resolved = resolveHumanAdminOverride(commandName, normalizedOptions);
  if (resolved.legacyForceAlias) {
    // guard:bound-owner
    fail(`${commandName}: bare --force is refused under ADR 0031; use a signed human-admin approval.`);
  }
  const subjectDigest = subjectSha256({ verb: commandName, ticket: ticketId, reason: resolved.reason, state: canonicalJson(row) });
  const verdict = requireHumanAdminApproval({
    verb: commandName,
    ticket: ticketId,
    subjectDigest,
    reason: resolved.reason,
    journal: (details) => appendGovernanceEvent({ ts: new Date().toISOString(), ...details }),
    recordUsed: journalRecordUsed(path.join(runtimeDir, "governance-events.ndjson")),
    anchor: approvalClient?.anchor,
    runSign: approvalClient?.runSign,
  });
  if (!verdict.ok) {
    // guard:bound-owner
    fail(verdict.message);
  }
  if (verdict.mode === "transition") process.stderr.write(`${verdict.warning}\n`);
  return { ...resolved, approval: {
    mode: verdict.mode,
    session_id: verdict.session_id || null,
    record_id: verdict.record_id || null,
    key_id: verdict.key_id || null,
    subject_sha256: subjectDigest,
  } };
}

module.exports = {
  PRODUCTION_TRUST_ANCHOR,
  REQUEST_SCHEMA,
  RECORD_SCHEMA,
  trustAnchorPath,
  signCommand,
  canonicalJson,
  subjectSha256,
  loadTrustAnchor,
  verifyApprovalRecord,
  requestApproval,
  requireHumanAdminApproval,
  requireHumanAdminApprovalForState,
  approvalRequirement,
  requireSignedOverride,
  transitionWindowOpen,
  readTransitionConfig,
  journalRecordUsed,
  WINDOW_VERBS,
};
