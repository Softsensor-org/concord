"use strict";

// COORD-492 slice 1: redacted, hash-chained action ledger for the optional
// managed-auto profile, plus the coverage verifier.
//
// Store and chain (ADR, COORD-492): this module EXTENDS the existing
// coord/.runtime/action-ledgers/<ticket>.ndjson store written by
// auto-mode-ledger.js (coord.auto-mode.ledger/v1, used by the runtime authority
// barrier). A v2 event uses the same sequence / previous_hash / hash fields and
// the same entryHash, so v1 barrier records and v2 managed records form one
// chain that both verifiers accept. v1 records never count toward managed
// coverage.
//
// Redaction happens BEFORE persistence and is whitelist based: only the named
// fields below are ever read from an event; raw tool input/output, environment
// values, payloads and source bodies are dropped by construction. A required
// field that cannot be safely normalized throws LedgerNormalizationError and
// nothing is written; the caller must fail the managed action.
//
// The verifier never infers safe behavior from missing events: no session,
// missing start or end, gaps, tamper, or any marker prevents "complete".
// This slice adds no gate wiring; slice 2 consumes the verdict.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { entryHash, verifyLedger } = require("./auto-mode-ledger.js");
const { PROVIDERS } = require("./auto-mode-adapters.js");
const { DECISIONS, EVENT_STATUSES, canonicalJson } = require("./auto-mode-policy.js");

const LEDGER_FAMILY = "coord.auto-mode.ledger";
const LEDGER_SCHEMA = `${LEDGER_FAMILY}/v2`;
const LEGACY_SCHEMA = `${LEDGER_FAMILY}/v1`;
const VERDICT_SCHEMA = "coord.auto-mode.ledger-verdict/v1";
const REDACTION_SCHEMA = "coord.auto-mode.redaction/v1";
const COVERAGE_STATES = Object.freeze(["complete", "partial", "interrupted", "bypassed", "unmanaged"]);
const MARKERS = Object.freeze(["session_start", "heartbeat", "session_end", "interruption", "adapter_failure", "bypass", "unmanaged"]);
const EVENT_TYPES = new Set([...MARKERS, "action"]);
const COMMAND_CLASSES = new Set(["source", "test", "lint", "build", "git-local", "governance-submit", "other"]);
const MASK = "[REDACTED]";
const OUTSIDE = "[outside-worktree]";
const SENSITIVE_NAME = /(?:token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)/i;
const ASSIGNMENT = /\b(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|credential)(s?\s*[=:]\s*)(?:bearer\s+)?[^\s"']+/gi;
const BEARER = /\bbearer\s+[^\s"']+/gi;
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ALLOWED_FIELDS = new Set([
  "type", "kind", "tool", "decision", "rule", "result", "duration_ms", "reason", "adapter_version",
  "command", "command_class", "cwd", "path", "before_digest", "after_digest", "destination",
  "secret_ref", "purpose", "operation", "commit", "action_id", "attempt_id", "phase", "receipt",
]);
// COORD-860 (accepted ADR-0017 amendment): optional attempt/result correlation
// and a closed receipt projection on the same v2 chain.
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PHASES = new Set(["attempt", "result"]);
const TERMINAL_RESULTS = new Set([...EVENT_STATUSES].filter((status) => status !== "attempted"));
// ADR-0017 amendment section 2: `allowed` never establishes process completion,
// and a result that may have produced the effect blocks any further attempt.
const PROCESS_RESULTS = new Set(["completed", "failed", "interrupted", "denied"]);
const POSSIBLE_EFFECT_RESULTS = new Set(["completed", "allowed"]);
const RECEIPT_FIELDS = Object.freeze(["receipt_id", "ticket", "capability", "target_class", "target_digest", "result", "external_id_digest"]);
// Fields a result event inherits from its attempt; everything else is the result's own.
const INHERITED_ACTION_FIELDS = Object.freeze([
  "kind", "operation_class", "tool", "decision", "rule", "resource", "resource_scope", "command_class", "summary",
  "command_digest", "purpose", "before_digest", "action_id", "attempt_id",
]);
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

class LedgerNormalizationError extends Error {
  constructor(code, field) {
    // Only the code and the field NAME are reported; never a value.
    // guard:auto-mode-containment
    super(`managed-auto ledger refused event: ${code} (${field})`);
    this.name = "LedgerNormalizationError";
    this.code = code;
    this.field = field;
  }
}

// guard:auto-mode-containment
function refuse(field) { throw new LedgerNormalizationError(`invalid_${field}`, field); }

function scrub(value, secrets) {
  let text = String(value);
  for (const secret of secrets) text = text.split(secret).join(MASK);
  text = text.replace(ASSIGNMENT, `$1$2${MASK}`).replace(BEARER, `bearer ${MASK}`).replace(TOKEN_SHAPES, MASK);
  return { text, redacted: text !== String(value) };
}

// True when text carries a known secret or an assignment/bearer/token shape.
function isSensitiveText(text, secrets = []) { return scrub(text, knownSecrets(secrets)).redacted; }

function knownSecrets(list) {
  return [...new Set((list || []).filter((entry) => typeof entry === "string" && entry.length >= 6))].sort((a, b) => b.length - a.length);
}

function secretValuesFromEnvironment(environment = {}) {
  return knownSecrets(Object.entries(environment).filter(([name]) => SENSITIVE_NAME.test(name)).map(([, value]) => value));
}

function matching(value, pattern, field) {
  // guard:auto-mode-containment
  if (typeof value !== "string" || !pattern.test(value)) refuse(field);
  return value;
}

function member(value, set, field) {
  // guard:auto-mode-containment
  if (!set.has(value)) refuse(field);
  return value;
}

function optionalDigest(value, field, pattern = HEX64) {
  return value === undefined || value === null ? null : matching(value, pattern, field);
}

function boundedText(value, limit, secrets, state, field) {
  const { text, redacted } = scrub(value, secrets);
  if (redacted) state.redacted.push(field);
  return text.slice(0, limit);
}

// An identifier-like required field cannot be partially masked: refuse it.
function safeIdentifier(value, secrets, field, pattern = IDENT) {
  const text = matching(value, pattern, field);
  if (scrub(text, secrets).redacted) throw new LedgerNormalizationError("unsafe_value", field);
  return text;
}

function relativeResource(value, worktree, secrets, field) {
  // guard:auto-mode-containment
  if (typeof value !== "string" || !value.trim()) refuse(field);
  if (scrub(value, secrets).redacted) throw new LedgerNormalizationError("unsafe_value", field);
  const relative = path.relative(worktree, path.resolve(worktree, value));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { resource: OUTSIDE, resource_scope: "outside" };
  return { resource: relative.split(path.sep).join("/") || ".", resource_scope: "worktree" };
}

function destinationHost(value, secrets) {
  const raw = typeof value === "string" ? value.trim() : "";
  let host = "";
  try {
    const url = new URL(raw.includes("://") ? raw : `tcp://${raw}`);
    host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  // guard:auto-mode-containment
  } catch { refuse("destination"); }
  if (!host) refuse("destination");
  if (scrub(host, secrets).redacted) throw new LedgerNormalizationError("unsafe_value", "destination");
  return host.toLowerCase();
}

function summarizeCommand(scrubbed) {
  const words = scrubbed.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return words.slice(0, 2).map((word, index) => {
    const token = index === 0 ? path.posix.basename(word) : word;
    return /^[A-Za-z0-9._@+:-]{1,64}$/.test(token) ? token : "[arg]";
  }).join(" ");
}

function nonNegativeInteger(value, field) {
  if (value === undefined || value === null) return null;
  // guard:auto-mode-containment
  return Number.isInteger(value) && value >= 0 ? value : refuse(field);
}

function requiredText(value, field) {
  // guard:auto-mode-containment
  if (typeof value !== "string" || !value.trim()) refuse(field);
  return value;
}

// git, mcp and governance effects are named by a bounded operation identifier.
function operationFields(input, ctx, secrets, state, kind) {
  return {
    resource: safeIdentifier(input.operation, secrets, "operation", /^[A-Za-z0-9_.:/-]{1,64}$/),
    resource_scope: kind,
    commit: optionalDigest(input.commit, "commit", COMMIT),
  };
}

const KIND_FIELDS = Object.freeze({
  command(input, ctx, secrets, state) {
    const scrubbed = boundedText(requiredText(input.command, "command"), Infinity, secrets, state, "command");
    return {
      ...relativeResource(input.cwd === undefined ? "." : input.cwd, ctx.worktree, secrets, "cwd"),
      command_class: member(input.command_class, COMMAND_CLASSES, "command_class"),
      summary: summarizeCommand(scrubbed),
      command_digest: `sha256:${crypto.createHash("sha256").update(scrubbed).digest("hex")}`,
    };
  },
  file(input, ctx, secrets) {
    return {
      ...relativeResource(input.path, ctx.worktree, secrets, "path"),
      before_digest: optionalDigest(input.before_digest, "before_digest"),
      after_digest: optionalDigest(input.after_digest, "after_digest"),
    };
  },
  network(input, ctx, secrets) {
    return { resource: destinationHost(input.destination, secrets), resource_scope: "network" };
  },
  secret(input, ctx, secrets, state) {
    const purpose = requiredText(input.purpose, "purpose");
    return { resource: safeIdentifier(input.secret_ref, secrets, "secret_ref"), resource_scope: "secret-reference", purpose: boundedText(purpose, 120, secrets, state, "purpose") };
  },
  git: operationFields,
  mcp: operationFields,
  governance: operationFields,
});

const OPERATION_CLASSES = new Set(Object.keys(KIND_FIELDS));

function receiptFields(input, ctx, secrets, state) {
  // guard:auto-mode-containment
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : refuse("receipt");
  state.dropped += Object.keys(raw).filter((name) => !RECEIPT_FIELDS.includes(name)).length;
  if (raw.ticket !== ctx.ticket) refuse("receipt_ticket");
  const projection = {
    receipt_id: safeIdentifier(raw.receipt_id, secrets, "receipt_id", CORRELATION_ID),
    ticket: raw.ticket,
    capability: safeIdentifier(raw.capability, secrets, "receipt_capability", /^[A-Za-z0-9_.:-]{1,64}$/),
    target_class: safeIdentifier(raw.target_class, secrets, "receipt_target_class", /^[A-Za-z0-9_.:-]{1,64}$/),
    target_digest: matching(raw.target_digest, HEX64, "receipt_target_digest"),
    result: member(raw.result, TERMINAL_RESULTS, "receipt_result"),
    external_id_digest: optionalDigest(raw.external_id_digest, "receipt_external_id_digest"),
  };
  return {
    receipt_id: projection.receipt_id,
    receipt_digest: receiptDigest(projection),
    receipt_capability: projection.capability,
    receipt_target_class: projection.target_class,
    receipt_target_digest: projection.target_digest,
    receipt_result: projection.result,
    receipt_external_id_digest: projection.external_id_digest,
  };
}

function receiptDigest(projection) {
  return crypto.createHash("sha256").update(canonicalJson(projection)).digest("hex");
}

// The receipt projection a stored event claims, recomputed by reconciliation.
function receiptProjection(entry) {
  return {
    receipt_id: entry.receipt_id, ticket: entry.ticket, capability: entry.receipt_capability,
    target_class: entry.receipt_target_class, target_digest: entry.receipt_target_digest,
    result: entry.receipt_result, external_id_digest: entry.receipt_external_id_digest,
  };
}

function correlationFields(input, ctx, secrets, state, result) {
  const present = ["action_id", "attempt_id", "phase"].filter((name) => input[name] !== undefined);
  // guard:auto-mode-containment
  if (present.length === 0) return input.receipt === undefined ? {} : refuse("receipt");
  if (present.length !== 3) refuse("correlation");
  const phase = member(input.phase, PHASES, "phase");
  if ((phase === "attempt") !== (result === "attempted")) refuse("phase");
  if (input.receipt !== undefined && phase !== "result") refuse("receipt");
  return {
    action_id: safeIdentifier(input.action_id, secrets, "action_id", CORRELATION_ID),
    attempt_id: safeIdentifier(input.attempt_id, secrets, "attempt_id", CORRELATION_ID),
    phase,
    ...(input.receipt === undefined ? {} : receiptFields(input.receipt, ctx, secrets, state)),
  };
}

function actionFields(input, ctx, secrets, state) {
  const kind = member(input.kind, OPERATION_CLASSES, "kind");
  const result = member(input.result, EVENT_STATUSES, "result");
  return {
    kind,
    operation_class: kind,
    tool: safeIdentifier(input.tool, secrets, "tool", /^[A-Za-z0-9_.:-]{1,64}$/),
    decision: member(input.decision, DECISIONS, "decision"),
    rule: input.rule === undefined ? null : safeIdentifier(input.rule, secrets, "rule", /^[A-Za-z0-9_.:/-]{1,80}$/),
    result,
    duration_ms: nonNegativeInteger(input.duration_ms, "duration_ms"),
    ...KIND_FIELDS[kind](input, ctx, secrets, state, kind),
    ...correlationFields(input, ctx, secrets, state, result),
  };
}

// The provenance every v2 event carries, validated from the recorder context.
function envelope(type, ctx) {
  // guard:auto-mode-containment
  if (typeof ctx.worktree !== "string" || !path.isAbsolute(ctx.worktree)) refuse("worktree");
  const ts = ctx.now ? ctx.now() : new Date().toISOString();
  // A non-string clock value would hash differently from its serialized form.
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) refuse("ts");
  return {
    schema: LEDGER_SCHEMA,
    type,
    ts,
    ticket: matching(ctx.ticket, /^[A-Z][A-Z0-9]*-\d+$/, "ticket"),
    session: matching(ctx.session, /^[A-Za-z0-9._:-]{1,128}$/, "session"),
    provider: member(ctx.provider, new Set(Object.keys(PROVIDERS)), "provider"),
    policy_digest: matching(ctx.policy_digest, HEX64, "policy_digest"),
  };
}

function normalizeManagedEvent(input, ctx = {}) {
  const event = input && typeof input === "object" ? input : {};
  const secrets = knownSecrets(ctx.secrets);
  const state = { redacted: [], dropped: 0 };
  const body = envelope(member(event.type, EVENT_TYPES, "type"), ctx);
  if (body.type === "session_start") body.adapter_version = matching(event.adapter_version, /^[A-Za-z0-9._+-]{1,40}$/, "adapter_version");
  Object.assign(body, body.type === "action"
    ? actionFields(event, ctx, secrets, state)
    : { reason: event.reason === undefined ? null : boundedText(event.reason, 160, secrets, state, "reason") });
  body.redaction = {
    schema: REDACTION_SCHEMA,
    redacted_fields: state.redacted,
    dropped_field_count: Object.keys(event).filter((name) => !ALLOWED_FIELDS.has(name)).length + state.dropped,
  };
  return assertNoResidualSecret(body, secrets);
}

// Defense in depth: identifiers validated by pattern are not masked, so a
// known secret reaching the serialized body refuses the event outright.
// guard:auto-mode-containment
function assertNoResidualSecret(body, secrets) {
  const serialized = JSON.stringify(body);
  if (secrets.some((secret) => serialized.includes(secret))) throw new LedgerNormalizationError("residual_secret", "event");
  return body;
}

function createManagedEntry(body, previous = null) {
  const entry = { ...body, sequence: previous ? previous.sequence + 1 : 1, previous_hash: previous ? previous.hash : null };
  return { ...entry, hash: entryHash(entry) };
}

function readManagedLedger(file) {
  const entries = [];
  const issues = [];
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line) return;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* reported below */ }
    if (parsed && typeof parsed === "object") entries.push(parsed);
    else issues.push({ code: "unparseable_line", line: index + 1 });
  });
  return { entries, issues };
}

// Exclusive-create lock. lock_wait_ms (default 0: refuse at once, as v1 does)
// lets a writer in another process wait its turn instead of failing.
function acquireLock(lock, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

// Same lock-file protocol as auto-mode-ledger.appendEntry, so v1 barrier
// writers and v2 managed writers serialize on one ledger. `decide` sees the
// verified-readable chain under the lock and returns { body } to append or
// { existing } to replay without writing.
function withLedgerLock(file, ctx, decide) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const descriptor = acquireLock(lock, ctx.lock_wait_ms);
  try {
    const { entries, issues } = readManagedLedger(file);
    if (issues.length) throw new LedgerNormalizationError("unreadable_ledger", "ledger");
    const decision = decide(entries);
    if (decision.existing) return { entry: decision.existing, replayed: true };
    const entry = createManagedEntry(decision.body, entries.at(-1) || null);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return { entry, replayed: false };
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function appendManagedEvent(file, input, ctx) {
  const body = normalizeManagedEvent(input, ctx);
  return withLedgerLock(file, ctx, () => ({ body })).entry;
}

const SEMANTIC_EXCLUDED = new Set(["ts", "sequence", "previous_hash", "hash"]);
function semanticBody(entry) {
  return canonicalJson(Object.fromEntries(Object.entries(entry).filter(([name]) => !SEMANTIC_EXCLUDED.has(name))));
}

function correlated(entries, ctx, actionId) {
  return entries.filter((entry) => entry.schema === LEDGER_SCHEMA && entry.type === "action" && entry.ticket === ctx.ticket
    && entry.session === ctx.session && entry.action_id === actionId);
}

function replayOrRefuse(existing, body, field) {
  if (semanticBody(existing) !== semanticBody(body)) throw new LedgerNormalizationError("conflicting_replay", field);
  return { existing };
}

// Attempt phase, appended before dispatch. Replay of the same key returns the
// stored entry (replayed: true) and the caller must not dispatch again. A new
// attempt of a logical action is allowed only after every earlier attempt has
// a terminal result and none of them completed the effect.
function beginManagedAction(file, input, ctx) {
  const body = normalizeManagedEvent({ ...input, type: "action", phase: "attempt", result: "attempted" }, ctx);
  return withLedgerLock(file, ctx, (entries) => {
    const prior = correlated(entries, ctx, body.action_id);
    const same = prior.find((entry) => entry.attempt_id === body.attempt_id && entry.phase === "attempt");
    if (same) return replayOrRefuse(same, body, "attempt_id");
    if (prior.some((entry) => entry.attempt_id === body.attempt_id)) throw new LedgerNormalizationError("result_before_attempt", "attempt_id");
    const attempts = prior.filter((entry) => entry.phase === "attempt");
    const results = prior.filter((entry) => entry.phase === "result");
    if (attempts.some((attempt) => !results.some((result) => result.attempt_id === attempt.attempt_id))) {
      throw new LedgerNormalizationError("unknown_outcome", "action_id");
    }
    if (results.some((result) => POSSIBLE_EFFECT_RESULTS.has(result.result))) throw new LedgerNormalizationError("duplicate_effect", "action_id");
    if (attempts.length >= (ctx.max_attempts || 3)) throw new LedgerNormalizationError("retry_limit", "action_id");
    return { body };
  });
}

// Terminal result phase for an existing attempt. It inherits the attempt's
// normalized action fields, so a result can never describe a different action.
function completeManagedAction(file, input, ctx) {
  const event = input && typeof input === "object" ? input : {};
  const head = envelope("action", ctx);
  const secrets = knownSecrets(ctx.secrets);
  const actionId = safeIdentifier(event.action_id, secrets, "action_id", CORRELATION_ID);
  const attemptId = safeIdentifier(event.attempt_id, secrets, "attempt_id", CORRELATION_ID);
  const result = member(event.result, TERMINAL_RESULTS, "result");
  return withLedgerLock(file, ctx, (entries) => {
    const prior = correlated(entries, ctx, actionId).filter((entry) => entry.attempt_id === attemptId);
    const attempt = prior.find((entry) => entry.phase === "attempt");
    if (!attempt) throw new LedgerNormalizationError("result_without_attempt", "attempt_id");
    if (attempt.decision !== "allow" && result !== "denied") throw new LedgerNormalizationError("denied_dispatch", "result");
    if (attempt.kind === "command" && !PROCESS_RESULTS.has(result)) throw new LedgerNormalizationError("invalid_process_result", "result");
    const state = { redacted: [], dropped: 0 };
    const body = {
      ...head,
      ...Object.fromEntries(INHERITED_ACTION_FIELDS.filter((name) => name in attempt).map((name) => [name, attempt[name]])),
      phase: "result",
      result,
      duration_ms: nonNegativeInteger(event.duration_ms, "duration_ms"),
      ...(attempt.kind === "file" ? { after_digest: optionalDigest(event.after_digest, "after_digest") } : {}),
      // A git result may name the commit it created; otherwise it keeps the attempt's.
      ...("commit" in attempt ? { commit: optionalDigest(event.commit, "commit", COMMIT) || attempt.commit } : {}),
      ...(event.receipt === undefined ? {} : receiptFields(event.receipt, ctx, secrets, state)),
    };
    const allowed = new Set(["action_id", "attempt_id", "result", "duration_ms", "after_digest", "commit", "receipt"]);
    body.redaction = {
      schema: REDACTION_SCHEMA, redacted_fields: [],
      dropped_field_count: Object.keys(event).filter((name) => !allowed.has(name)).length + state.dropped,
    };
    assertNoResidualSecret(body, secrets);
    const existing = prior.find((entry) => entry.phase === "result");
    return existing ? replayOrRefuse(existing, body, "result") : { body };
  });
}

function createSessionRecorder(options) {
  const { file, ...ctx } = options;
  const emit = (input) => appendManagedEvent(file, input, ctx);
  return {
    start: (adapterVersion) => emit({ type: "session_start", adapter_version: adapterVersion }),
    heartbeat: () => emit({ type: "heartbeat" }),
    action: (input) => emit({ ...input, type: "action" }),
    beginAction: (input) => beginManagedAction(file, input, ctx),
    completeAction: (input) => completeManagedAction(file, input, ctx),
    end: (reason) => emit({ type: "session_end", reason }),
    interrupt: (reason) => emit({ type: "interruption", reason }),
    adapterFailure: (reason) => emit({ type: "adapter_failure", reason }),
    bypass: (reason) => emit({ type: "bypass", reason }),
    unmanaged: (reason) => emit({ type: "unmanaged", reason }),
  };
}

function tally(list, key) {
  const counts = {};
  for (const entry of list) if (entry[key]) counts[entry[key]] = (counts[entry[key]] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function integrityIssues(entries, parseIssues) {
  const issues = [...parseIssues, ...verifyLedger(entries).issues.map((detail) => ({ code: "chain_break", detail }))];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.sequence)) issues.push({ code: "duplicate_sequence", sequence: entry.sequence });
    seen.add(entry.sequence);
    if (entry.schema !== LEDGER_SCHEMA && entry.schema !== LEGACY_SCHEMA) issues.push({ code: "unknown_schema", sequence: entry.sequence });
  }
  return issues;
}

function boundaryIssues(events) {
  const issues = [];
  const at = (type) => events.filter((entry) => entry.type === type);
  const starts = at("session_start");
  const ends = at("session_end");
  if (starts.length === 0) issues.push({ code: "missing_start" });
  if (starts.length > 1) issues.push({ code: "duplicate_start", sequence: starts[1].sequence });
  if (starts.length && events[0] !== starts[0]) issues.push({ code: "events_before_start", sequence: events[0].sequence });
  if (ends.length === 0) issues.push({ code: "missing_end" });
  if (ends.length > 1) issues.push({ code: "duplicate_end", sequence: ends[1].sequence });
  if (ends.length && events.at(-1) !== ends[0]) issues.push({ code: "events_after_end", sequence: events.at(-1).sequence });
  return issues;
}

function sessionIssues(events, options) {
  const issues = boundaryIssues(events);
  const gaps = [];
  events.forEach((entry, index) => {
    if (options.ticket && entry.ticket !== options.ticket) issues.push({ code: "ticket_mismatch", sequence: entry.sequence });
    if (entry.policy_digest !== events[0].policy_digest) issues.push({ code: "policy_digest_changed", sequence: entry.sequence });
    if (entry.provider !== events[0].provider) issues.push({ code: "provider_changed", sequence: entry.sequence });
    if (index === 0) return;
    const elapsed = Date.parse(entry.ts) - Date.parse(events[index - 1].ts);
    if (!(elapsed >= 0)) issues.push({ code: "clock_regression", sequence: entry.sequence });
    if (options.max_gap_ms && elapsed > options.max_gap_ms) gaps.push({ code: "heartbeat_gap", from_sequence: events[index - 1].sequence, to_sequence: entry.sequence });
  });
  return { issues, gaps, markers: new Set(events.map((entry) => entry.type)) };
}

function coverageOf(events, session, issues, gaps) {
  if (!events.length || session.markers.has("unmanaged")) return "unmanaged";
  if (session.markers.has("bypass")) return "bypassed";
  if (session.markers.has("interruption") || session.markers.has("adapter_failure") || !session.markers.has("session_end")) return "interrupted";
  return issues.length || gaps.length ? "partial" : "complete";
}

function verifyManagedLedger(entries = [], options = {}) {
  const integrity = integrityIssues(entries, options.parse_issues || []);
  const managed = entries.filter((entry) => entry.schema === LEDGER_SCHEMA);
  const selected = options.session
    || managed.filter((entry) => entry.type === "session_start").at(-1)?.session
    || managed.at(-1)?.session
    || null;
  const events = managed.filter((entry) => entry.session === selected);
  const session = events.length ? sessionIssues(events, options) : { issues: [{ code: "no_managed_session" }], gaps: [], markers: new Set() };
  const issues = [...integrity, ...session.issues];
  const coverage = coverageOf(events, session, issues, session.gaps);
  return {
    schema: VERDICT_SCHEMA,
    ok: integrity.length === 0 && coverage === "complete",
    integrity: integrity.length === 0 ? "valid" : "invalid",
    coverage,
    ticket: events[0]?.ticket || options.ticket || null,
    session: selected,
    provider: events[0]?.provider || null,
    policy_digest: events[0]?.policy_digest || null,
    chain_root: entries.at(-1)?.hash || null,
    session_head: events.at(-1)?.hash || null,
    counts: {
      entries: entries.length,
      legacy_v1: entries.filter((entry) => entry.schema === LEGACY_SCHEMA).length,
      session_events: events.length,
      by_type: tally(events, "type"),
      by_class: tally(events, "operation_class"),
    },
    gaps: session.gaps,
    issues,
  };
}

function verifyManagedLedgerFile(file, options = {}) {
  const { entries, issues } = readManagedLedger(file);
  return verifyManagedLedger(entries, { ...options, parse_issues: issues });
}

module.exports = {
  COMMAND_CLASSES, COVERAGE_STATES, LEDGER_SCHEMA, LedgerNormalizationError, MARKERS, OPERATION_CLASSES, VERDICT_SCHEMA,
  POSSIBLE_EFFECT_RESULTS, PROCESS_RESULTS, TERMINAL_RESULTS, appendManagedEvent, isSensitiveText, beginManagedAction, completeManagedAction, createManagedEntry, createSessionRecorder,
  normalizeManagedEvent, readManagedLedger, receiptDigest, receiptProjection, secretValuesFromEnvironment,
  verifyManagedLedger, verifyManagedLedgerFile,
};
