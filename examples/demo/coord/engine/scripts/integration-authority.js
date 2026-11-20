"use strict";

// COORD-915 / ADR 0021 Decision item 6: canonical integration is a separate
// permission. Three permissions are distinct:
//   1. register an identity (attribution only: agentid / agent-claim);
//   2. own a ticket attempt (the existing ticket-lock ownership);
//   3. integrate canonical state (this module).
// Each coordination domain (one canonical runtime directory) has at most one
// integration-authority holder, recorded in <runtime>/integration-authority.json.
// An integration OPERATION (merge -> record evidence -> finalize -> publish) is a
// reservation inside that record: while it is open, every other session's
// governed write in the domain is refused, and an interrupted operation stays
// recorded until `gov integration recover` verifies it.
//
// Ownership follows the domain, never the access location: an SSH session into
// the canonical checkout reads and writes the same runtime, so it is another
// writer in the same domain. An independent clone has its own runtime and is an
// independent domain.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
const context = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const createDirectoryLocks = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/directory-locks.js"));
const { writeFileAtomicSync } = require("./state-io.js");
// COORD-992 (F-06): the shared start-time reader and comparison.
const { startTimeVerdict } = require("./process-identity.js");
const attemptCoordination = require("./attempt-coordination.js");

const { state, GovernanceError, isProcessAlive, withGovernanceRuntimeLock } = context;
const RECORD_FILE = "integration-authority.json";
const SCHEMA = "coord.integration-authority/v1";
const HISTORY_LIMIT = 50;
const DEFAULT_LEASE_MS = 2 * 60 * 60 * 1000;
const HANDOFF_VERB = "coord/scripts/gov integration handoff --to <handle> --human-admin-override \"<reason>\"";
const RECOVER_VERB = "coord/scripts/gov integration recover";

// Every verb the dispatch router accepts is classified here. The guard test
// derives the router's verb set from cli.js and fails when a verb is missing,
// so a new canonical-writing verb cannot be added without choosing its class.
//   integration: publishes or integrates canonical state; requires the holder.
//   write:       a governed write; refused for other sessions while an
//                integration operation is open.
//   identity:    attribution/session upkeep only (runtime ledger); allowed.
//   read:        no state change.
//   authority:   the `integration` verb itself (self-authorizing subcommands).
// Classes and flag promotions DERIVE from the one declaration (command-declaration.js, COORD-934).
// Flag-dependent verbs: each promotion names the class a flag moves the verb into.
const { VERB_CLASSES, FLAG_PROMOTIONS } = require("./command-declaration.js");

const CLASS_BY_VERB = new Map();
for (const [cls, verbs] of Object.entries(VERB_CLASSES)) {
  for (const verb of verbs) CLASS_BY_VERB.set(verb, cls);
}

const TERMINAL_VERBS = new Set(["land", "close", "finish", "finalize", "mark-done", "finish-ticket"]);

function fail(message) {
  throw new GovernanceError(message);
}

// Resolve the class of one dispatched command. Unknown verbs are "read": the
// router refuses them before any handler runs.
function classifyCommand(command, args = []) {
  const base = CLASS_BY_VERB.get(command) || "read";
  const promotions = FLAG_PROMOTIONS[command] || {};
  for (const [flag, cls] of Object.entries(promotions)) {
    if (args.includes(flag)) return cls;
  }
  return base;
}

// ---- session readers ---------------------------------------------------------
// The thread resolver lives in the governance-session factory; the journal
// factory binds it here when the lifecycle composition root creates it.
let sessionReaders = null;
let journalMutation = null;
let readJournalEvents = null;
function bindSessionReaders(readers = {}) {
  if (typeof readers.resolveEffectiveThreadId === "function") {
    sessionReaders = { resolveEffectiveThreadId: readers.resolveEffectiveThreadId };
  }
  if (typeof readers.withGovernanceMutation === "function") journalMutation = readers.withGovernanceMutation;
  if (typeof readers.readGovernanceEventLog === "function") readJournalEvents = readers.readGovernanceEventLog;
}

// Every authority event (grant, refresh, handoff, release, operation open,
// adopt, close, abort, interruption, recovery) is a journaled governed
// mutation: the hash-chained journal carries `integration-<event>` with these
// details, in addition to the record's own history. The record lives in the
// runtime ledger, so the event is forced and drift-tolerant: an authority
// event must never be lost because the failed verb it records left drift.
function journaled(event, details, fn) {
  // A nested authority write belongs to the enclosing transaction and event.
  if (activeTxn) return fn();
  const txn = `itx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  details.txn = txn;
  const metadata = { command: `integration-${event}`, ticket: details.ticket || null, details, forceLog: true, allowProvenanceDrift: true };
  const body = () => {
    const outer = activeTxn;
    activeTxn = txn;
    try {
      return fn();
    } finally {
      activeTxn = outer;
    }
  };
  let result;
  try {
    result = journalMutation ? journalMutation(metadata, body) : withGovernanceRuntimeLock(body);
  } catch (error) {
    // A journal callback can throw after the event was appended (for example,
    // while updating the snapshot checkpoint). Resolve the pair from complete
    // journal records before deciding whether to restore the prior authority.
    // If journal inspection itself fails, leave the pending mark in place so
    // no authority is usable until a later read can resolve it.
    withGovernanceRuntimeLock(() => settlePending(txn, journalHasTxn(txn)));
    throw error;
  }
  faultHook("journal-appended");
  withGovernanceRuntimeLock(() => settlePending(txn, journalHasTxn(txn) || !journalMutation));
  return result;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// The caller is the session most recently bound to this runtime thread on this
// board. A released session still attributes its thread (terminal verbs release
// the session; the same conversation remains the same writer). A thread that was
// never bound is unidentified.
function resolveCaller(readers = sessionReaders) {
  let threadId = null;
  try {
    threadId = readers ? readers.resolveEffectiveThreadId() : null;
  } catch {
    threadId = null;
  }
  if (!threadId) return null;
  const sessions = readJson(state.AGENT_SESSIONS_PATH, []);
  const mine = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.thread_id === threadId && s.board_path === state.BOARD_PATH && s.handle)
    .sort((a, b) => {
      const active = Number(b.status === "active") - Number(a.status === "active");
      return active || String(b.last_seen_at || b.claimed_at || "").localeCompare(String(a.last_seen_at || a.claimed_at || ""));
    });
  if (mine.length === 0) return null;
  return { handle: mine[0].handle, session_id: mine[0].session_id || null, thread_id: threadId };
}

// ---- record ------------------------------------------------------------------
function recordPath() {
  return path.join(state.RUNTIME_DIR, RECORD_FILE);
}

function readRawRecord() {
  const file = recordPath();
  if (!fs.existsSync(file)) return null;
  const value = readJson(file, undefined);
  if (!value || value.schema !== SCHEMA) {
    fail(`Integration-authority record ${file} is unreadable or has an unknown schema; refusing integration until a human admin repairs it.`);
  }
  return migrateEpoch(value);
}

// COORD-1041 (ADR 0023 section 5): a real authority epoch. Every committed grant, claim and
// handoff advances it by one, and a canonical record carries the epoch it was decided under.
// A record written before the field existed is migrated on read: a live holder is epoch 1, no
// holder is epoch 0. The migrated value is persisted by the next write.
function migrateEpoch(value) {
  if (!value || (Number.isInteger(value.authority_epoch) && value.authority_epoch >= 0)) return value;
  return { ...value, authority_epoch: value.holder ? 1 : 0 };
}

function nextEpoch(record) {
  return (record && Number.isInteger(record.authority_epoch) && record.authority_epoch >= 0 ? record.authority_epoch : 0) + 1;
}

function currentAuthorityEpoch(record = readRecord()) {
  if (record && record.holder && record.holder.provisional && executorState(record.holder.provisional) === "live") {
    return nextEpoch(record);
  }
  return record && Number.isInteger(record.authority_epoch) ? record.authority_epoch : 0;
}

// Journal atomicity. An authority write inside journaled() marks the record
// `pending` with its transaction id and the prior record. The pending mark is
// cleared only after the journal event carrying that id is appended. Any read
// that finds a foreign pending mark resolves it under the runtime lock: the
// event exists -> the pair completes; it does not -> the prior record returns.
// So authority is never usable without its journal event.
let activeTxn = null;
let faultHook = () => {};

function journalHasTxn(txn) {
  if (!readJournalEvents) fail("Integration authority cannot inspect governance journal events; refusing to resolve the pending transaction.");
  const events = readJournalEvents();
  return events.some((event) => event && event.details && event.details.txn === txn);
}

function settlePending(txn, committed) {
  const latest = readRawRecord();
  if (!latest || !latest.pending || latest.pending.txn !== txn) return;
  if (committed) {
    const { pending, ...rest } = latest;
    writeFileAtomicSync(recordPath(), JSON.stringify(rest, null, 2) + "\n");
  } else if (latest.pending.prior) {
    writeFileAtomicSync(recordPath(), JSON.stringify(latest.pending.prior, null, 2) + "\n");
  } else {
    fs.rmSync(recordPath(), { force: true });
  }
}

function readRecord() {
  const value = readRawRecord();
  if (value && value.pending && value.pending.txn !== activeTxn) {
    withGovernanceRuntimeLock(() => settlePending(value.pending.txn, journalHasTxn(value.pending.txn)));
    return maskProvisional(readRawRecord());
  }
  return maskProvisional(value);
}

// A provisional (unjournaled) grant is usable only while the process that
// reserved it is alive. After a crash it confers nothing; a preserved
// operation still needs recovery.
function maskProvisional(value) {
  if (!value || !value.holder || !value.holder.provisional) return value;
  if (executorState(value.holder.provisional) === "live") return value;
  // With no preserved operation the dead reservation was the whole record: the
  // domain is still empty and the next publication may make the first grant.
  return value.operation ? { ...value, holder: null } : null;
}

function writeRecord(record, event) {
  const next = { ...record, schema: SCHEMA };
  delete next.pending;
  next.history = [...(record.history || []), { ts: new Date().toISOString(), ...event }].slice(-HISTORY_LIMIT);
  if (activeTxn) {
    const onDisk = readRawRecord();
    const prior = onDisk && onDisk.pending && onDisk.pending.txn === activeTxn ? onDisk.pending.prior : onDisk;
    next.pending = { txn: activeTxn, event: event.event, prior };
  }
  writeFileAtomicSync(recordPath(), JSON.stringify(next, null, 2) + "\n");
  if (activeTxn) faultHook("record-written");
  return next;
}

function emptyRecord() {
  return { schema: SCHEMA, domain: { runtime_dir: state.RUNTIME_DIR, board_path: state.BOARD_PATH }, holder: null, operation: null, authority_epoch: 0, history: [] };
}

function describeHolder(holder) {
  if (!holder) return "no holder";
  return `${holder.handle} (session ${holder.session_id || "unknown"}, granted ${holder.granted_at} via ${holder.granted_via})`;
}

function leaseMs() {
  const value = Number(process.env.COORD_INTEGRATION_LEASE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LEASE_MS;
}

// Liveness of the process executing an operation. `held` means the operation
// is held across commands (opened by `integration begin` or resumed by recover)
// and has no executor process; `unknown` means the executor ran on another host.
// COORD-951: a live pid alone is not the executor once the pid was reused. The record
// carries the executor's process start time; a different start time means another process.
// Records written before COORD-951 carry no start time and keep the pid-only rule.
function processStartTime(pid) {
  // Read through the directory-locks seam (COORD-951 tests stub it); same reader as process-identity.
  return createDirectoryLocks.readOwnerIdentity(pid).pid_start_time ?? null;
}

function executorState(operation) {
  if (!operation || !operation.pid) return "held";
  if (operation.host !== os.hostname()) return "unknown";
  if (!isProcessAlive(operation.pid)) return "gone";
  // Only a KNOWN start time that differs proves a reused pid. An unreadable current start
  // time (no /proc, permission, non-Linux) is unknown and keeps the pid-only answer: fail
  // closed against takeover, never fail open.
  const recordedStart = typeof operation.pid_start_time === "string" ? operation.pid_start_time : null;
  return startTimeVerdict(operation.pid, recordedStart, processStartTime) === "different" ? "gone" : "live";
}

function operationIssues(operation, now = Date.now()) {
  if (!operation) return [];
  const issues = [];
  if (operation.status === "interrupted") issues.push(`interrupted: ${operation.interrupted_reason || "unknown failure"}`);
  if (operation.requires_recovery) issues.push(`requires recovery: ${operation.recovery_reason || "authority changed hands"}`);
  if (executorState(operation) === "gone") issues.push(`stale executor: process ${operation.pid} on ${operation.host} is gone`);
  if (Date.parse(operation.lease_expires_at) <= now) issues.push(`lease expired at ${operation.lease_expires_at}`);
  return issues;
}

function describeOperation(operation) {
  return `${operation.verb} ${operation.ticket || "(no ticket)"} step ${operation.step}, opened ${operation.started_at} by ${operation.holder_handle}`;
}

// ---- dispatch guard ----------------------------------------------------------
// The operation id this process is executing, so its own nested governed
// writes (closeout mutations, post-finalize sync) are not refused.
let activeOperationId = null;
let activeOperationFence = null;
let activeCommandFence = null;

// Compared under the runtime lock: a handle alone is not a lease. A handoff
// (including to a new session of the same handle) invalidates the executor.
function authorityFence(record) {
  return JSON.stringify({ holder: record && record.holder, operation: record && record.operation });
}

function assertFence(expected, command) {
  if (authorityFence(readRecord()) !== expected) {
    fail(`Refusing "${command}": integration authority changed while this executor was running; preserve the current holder and run ${RECOVER_VERB}.`);
  }
}

function runFenced(command, caller, run) {
  const fence = withGovernanceRuntimeLock(() => {
    authorityPlan(command, readRecord(), caller);
    assertOperationAllowsIntegration(command, caller);
    return authorityFence(readRecord());
  });
  const previous = activeCommandFence;
  activeCommandFence = fence;
  try {
    return run();
  } finally {
    activeCommandFence = previous;
    withGovernanceRuntimeLock(() => assertFence(fence, command));
  }
}

// Keep a guarded integration command's final publication atomic with its
// authority check. In particular, sync computes its canonical delta after a
// governed mutation; a handoff between that mutation and `git add` must not
// let the old executor publish afterward. The runtime lock prevents a handoff
// from overtaking a publication once this boundary is entered.
function withActiveCommandFence(command, run) {
  return withGovernanceRuntimeLock(() => {
    if (activeCommandFence) assertFence(activeCommandFence, command);
    else if (activeOperationId) assertActiveExecutor(command);
    else {
      const plan = authorityPlan(command, readRecord(), resolveCaller());
      if (plan) fail(`Refusing "${command}": canonical publication requires an active integration executor.`);
      // Preserve the documented fresh-domain bootstrap: before a holder or
      // operation exists, an unidentified legacy invocation may publish its
      // own initial sync journal. Established authority still requires the
      // matching command/operation fence above.
    }
    return run();
  });
}

function assertActiveExecutor(command) {
  const record = readRecord();
  const op = record && record.operation;
  if (!op || op.id !== activeOperationId || op.requires_recovery ||
      (activeOperationFence && authorityFence(record) !== activeOperationFence)) {
    fail(`Refusing "${command}": stale integration executor; authority changed or requires recovery. Run ${RECOVER_VERB}.`);
  }
}

function sameHolder(caller, handle) {
  return Boolean(caller && handle && caller.handle === handle);
}

// The reservation belongs to the domain's current holder: after a handoff the
// previous holder's writes are refused even though it opened the operation.
function reservationHolder(record) {
  return record.holder ? record.holder.handle : record.operation.holder_handle;
}

function refuseForeignOperation(command, record, caller) {
  const op = record.operation;
  fail(
    `Refusing "${command}": integration operation ${op.id} (${describeOperation(op)}) is open in this coordination domain and ` +
    `${caller ? `session ${caller.handle}` : "this unidentified session"} does not hold it. ` +
    `Wait for it to finish, or a human admin hands authority over with ${HANDOFF_VERB} and runs ${RECOVER_VERB}.`
  );
}

// Called once per dispatched command, before any handler runs.
function isUnguarded(cls, args) {
  return args.includes("--help") || args.includes("-h") || !["write", "integration"].includes(cls);
}

// An open operation lets only its holder integrate, and only once it needs no
// recovery.
function assertOperationAllowsIntegration(command, caller) {
  const current = readRecord();
  if (!current || !current.operation) return;
  const issues = operationIssues(current.operation);
  if (issues.length > 0) {
    fail(`Refusing "${command}": integration operation ${current.operation.id} (${describeOperation(current.operation)}) needs verified recovery (${issues.join("; ")}). Run ${RECOVER_VERB} to verify it, then --resume or --abandon --human-admin-override "<reason>".`);
  }
  if (!sameHolder(caller, current.operation.holder_handle)) refuseForeignOperation(command, current, caller);
}

// Called once per dispatched command, before any handler runs.
function guardCommand(command, args, run) {
  const cls = classifyCommand(command, args);
  if (isUnguarded(cls, args)) return run();
  if (activeOperationId || activeCommandFence) {
    withGovernanceRuntimeLock(() => {
      if (activeOperationId) assertActiveExecutor(command);
      if (activeCommandFence) assertFence(activeCommandFence, command);
    });
    return run();
  }
  const record = readRecord();
  if (cls === "write") {
    if (record && record.operation) {
      const writer = resolveCaller();
      if (!sameHolder(writer, reservationHolder(record))) refuseForeignOperation(command, record, writer);
    }
    return run();
  }
  const caller = resolveCaller();
  // A terminal verb defers its authority events to the end of its operation,
  // so a refused or no-op closeout leaves the journal byte-identical.
  if (TERMINAL_VERBS.has(command)) {
    if (!authorityPlan(command, record, caller)) return run();
    assertOperationAllowsIntegration(command, caller);
    return runTerminalOperation(command, args[0] || null, caller, run);
  }
  const plan = authorityPlan(command, record, caller);
  if (!plan) return run();
  assertOperationAllowsIntegration(command, caller);
  return runDeferredAuthority(command, caller, plan, run);
}

// A non-terminal integration verb other than sync (reconcile, pr-merge, ...)
// uses the same deferral as a terminal verb, without an operation: an implicit first
// grant is reserved provisionally under the lock before the verb runs, and the
// grant or holder-session refresh is journaled only when the verb changed
// canonical state. A refused or no-op verb restores the record and appends
// nothing, so reconcile's packet and baseline contracts are unchanged.
function runDeferredAuthority(command, caller, plan, run) {
  if (!plan.grant && !plan.refresh) return runFenced(command, caller, run);
  // `sync` publishes the journal itself. Its grant or refresh is journaled
  // first, so the same sync commits that event and the journal never lags
  // HEAD after a successful `sync --commit` (COORD-827 fresh install).
  if (command === "sync" || command === "publish-board") {
    if (plan.grant) commitGrant(command, caller);
    if (plan.refresh) commitRefresh(command, caller);
    return runFenced(command, caller, run);
  }
  const reserved = withGovernanceRuntimeLock(() => {
    const record = readRecord();
    const replan = authorityPlan(command, record, caller);
    if (replan.grant) writeRecord({ ...(record || emptyRecord()), holder: provisionalHolder(replan.holder) }, { event: "provisional-grant", handle: caller.handle, command });
    return { plan: replan, fence: authorityFence(readRecord()), journalBytes: journalBytes(), head: canonicalHead() };
  });
  try {
    return runFenced(command, caller, run);
  } finally {
    withGovernanceRuntimeLock(() => {
      assertFence(reserved.fence, command);
      const sideEffects = journalBytes() !== reserved.journalBytes || canonicalHead() !== reserved.head;
      if (sideEffects) {
        if (reserved.plan.grant) commitGrant(command, caller);
        if (reserved.plan.refresh) commitRefresh(command, caller);
      } else if (reserved.plan.grant) {
        restoreRecord();
      }
    });
  }
}

function provisionalHolder(holder) {
  return { ...holder, provisional: { pid: process.pid, host: os.hostname() } };
}

function restoreRecord() {
  fs.rmSync(recordPath(), { force: true });
}

const IMPLICIT_GRANT = "implicit-first-integration-verb";
// Only publication verbs make the implicit first grant. Repair verbs
// (reconcile, reconcile-landings, repair-chain, ...) require the holder once
// one exists, but in a domain that never had one they run without granting:
// their own journal contracts (COORD-715/722/835/836) admit no extra event.
const GRANTING_VERBS = new Set([...TERMINAL_VERBS, "sync", "publish-board", "supersede", "pr-merge"]);

// Integration verbs require the holder. The first holder of a domain that has
// never had one is the first identified session to run an integration verb;
// after an explicit release the domain needs an explicit claim. Pure: it
// refuses or returns what would change, and writes nothing.
function authorityPlan(command, record, caller) {
  if (!record || !record.holder) {
    if (!caller) {
      if (record) {
        fail(`Refusing "${command}": integration authority in this domain has no holder and this session is unidentified. Bind with coord/scripts/gov agentid --owner <handle>, then coord/scripts/gov integration claim.`);
      }
      return null;
    }
    if (record) {
      fail(`Refusing "${command}": integration authority in this domain has no holder (${describeReleased(record)}). Claim it explicitly with coord/scripts/gov integration claim.`);
    }
    if (!GRANTING_VERBS.has(command)) return null;
    return { holder: grantHolder(caller, IMPLICIT_GRANT, command), grant: true, refresh: false };
  }
  if (!sameHolder(caller, record.holder.handle)) {
    fail(
      `Refusing "${command}": integration authority in this coordination domain is held by ${describeHolder(record.holder)}; ` +
      `${caller ? `session ${caller.handle} (${caller.session_id || "no session"})` : "this unidentified session"} may own tickets and edit its worktree but may not integrate canonical state. ` +
      `Registration grants attribution only. Handoff is explicit: ${HANDOFF_VERB}.`
    );
  }
  return { holder: record.holder, grant: false, refresh: Boolean(caller.session_id && caller.session_id !== record.holder.session_id) };
}

function commitGrant(command, caller) {
  const details = { handle: caller.handle, session_id: caller.session_id, granted_via: IMPLICIT_GRANT, command };
  journaled("grant", details, () => {
    const latest = readRecord();
    if (latest) authorityPlan(command, latest, caller);
    assertOperationAllowsIntegration(command, caller);
    const holder = grantHolder(caller, IMPLICIT_GRANT, command);
    writeRecord({ ...(latest || emptyRecord()), holder, authority_epoch: nextEpoch(latest) }, { event: "granted", ...details });
  });
}

function commitRefresh(command, caller) {
  const details = { handle: caller.handle, session_id: caller.session_id, command };
  journaled("holder-session-refresh", details, () => {
    const latest = readRecord();
    authorityPlan(command, latest, caller);
    assertOperationAllowsIntegration(command, caller);
    Object.assign(details, { previous_session_id: latest.holder.session_id, granted_via: latest.holder.granted_via });
    writeRecord({ ...latest, holder: { ...latest.holder, session_id: caller.session_id, thread_id: caller.thread_id } }, { event: "holder-session-refreshed", ...details });
  });
}

function describeReleased(record) {
  const last = [...(record.history || [])].reverse().find((e) => e.event === "released");
  return last ? `released by ${last.handle} at ${last.ts}` : "no holder recorded";
}

function grantHolder(caller, via, reason) {
  return { handle: caller.handle, session_id: caller.session_id, thread_id: caller.thread_id, granted_at: new Date().toISOString(), granted_via: via, reason: reason || null };
}

function canonicalHead() {
  const r = spawnSync("git", ["-C", path.dirname(state.RUNTIME_DIR), "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function journalBytes() {
  try {
    return fs.statSync(state.GOVERNANCE_EVENT_LOG_PATH).size;
  } catch {
    return 0;
  }
}

function newOperation(verb, ticket, caller, via, expectedAuthorityEpoch) {
  const now = Date.now();
  const attemptFence = captureTicketFence(ticket, expectedAuthorityEpoch);
  return {
    id: `iop-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ticket, verb, step: via === "begin" ? "merge" : "closeout", status: "open", opened_via: via,
    holder_handle: caller.handle, session_id: caller.session_id,
    pid: via === "begin" ? null : process.pid,
    pid_start_time: via === "begin" ? null : processStartTime(process.pid),
    host: os.hostname(),
    started_at: new Date(now).toISOString(), lease_expires_at: new Date(now + leaseMs()).toISOString(),
    baseline: { head: canonicalHead(), journal_bytes: journalBytes(), ...(attemptFence ? { attempt_fence: attemptFence } : {}) },
    requires_recovery: false,
  };
}

// Snapshot the attempt-aware canonical decision before a terminal operation
// starts. An absent record is explicitly marked as legacy so later appearance
// does not silently turn an unfenced operation into a fenced one.
function captureTicketFence(ticket, expectedAuthorityEpoch) {
  if (!ticket) return null;
  const repoRoot = path.dirname(state.RUNTIME_DIR);
  const remote = process.env.COORD_ATTEMPT_REMOTE || "origin";
  const topLevel = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (topLevel.status !== 0) {
    const detail = String(topLevel.stderr || "").trim();
    // coord explicitly supports off-Git workspaces. Only Git's recognized
    // not-a-repository response proves there can be no configured attempt
    // remote here; path/configuration and other Git failures remain refusals.
    if (/not a git repository|outside a work tree/i.test(detail)) {
      return { status: "legacy-absent", remote, ticket, reason: "legacy-off-git" };
    }
    fail(`Could not inspect the Git topology for attempt fences in ${repoRoot}: ${detail || "git rev-parse failed"}`);
  }
  const remotes = spawnSync("git", ["-C", repoRoot, "remote"], { encoding: "utf8" });
  // Legacy standalone fixtures and old local installations have no attempt
  // remote configured. That is the only configuration treated as unfenced.
  if (remotes.status !== 0) fail(`Could not inspect configured attempt remotes in ${repoRoot}: ${String(remotes.stderr || "git remote failed").trim()}`);
  if (!String(remotes.stdout || "").split(/\s+/).includes(remote)) {
    return { status: "legacy-absent", remote, ticket, reason: "attempt-remote-unconfigured" };
  }
  const canonical = attemptCoordination.readCanonical(repoRoot, { remote, ticket });
  if (!canonical) return { status: "legacy-absent", remote, ticket };
  const localEpoch = expectedAuthorityEpoch === undefined ? currentAuthorityEpoch() : expectedAuthorityEpoch;
  if (canonical.record.authority_epoch !== localEpoch) {
    // guard:integration-authority
    fail(`Refusing ${ticket}: canonical authority epoch ${canonical.record.authority_epoch} differs from the holder's epoch ${localEpoch}; the canonical record must be re-established before integration.`);
  }
  return {
    status: "captured",
    remote,
    ticket,
    token: attemptCoordination.tokenFor(ticket, canonical.record, canonical.oid),
    authority_epoch: canonical.record.authority_epoch,
    selected_attempt: canonical.record.selected_attempt || null,
  };
}

// Reuse the operation's original decision. Re-reading a fresh token here would
// conceal a stale decision after a retry or recovery.
// guard:integration-authority
function assertTicketFence(ticket) {
  const expectedFence = arguments.length > 1 ? arguments[1] : null;
  const record = readRecord();
  const operation = record && record.operation;
  const fence = operation && operation.ticket === ticket && operation.baseline && operation.baseline.attempt_fence;
  if (expectedFence && fence && JSON.stringify(expectedFence) !== JSON.stringify(fence)) {
    // guard:integration-authority
    fail(`Refusing ${ticket}: supplied attempt fence differs from the persisted integration decision; run ${RECOVER_VERB}.`);
  }
  if (!fence) {
    // An operation opened by an older engine has no captured expectation. It
    // may continue only when a fresh read proves this is still a legacy ticket
    // with no canonical decision; never substitute a newly observed token for
    // the decision the old operation should have captured.
    if (operation && operation.ticket === ticket) {
      const snapshot = captureTicketFence(ticket);
      if (snapshot.status === "legacy-absent") return { ok: true, legacy: true };
      // guard:integration-authority
      fail(`Refusing ${ticket}: persisted integration operation has no captured attempt fence; abandon and reopen it with ${RECOVER_VERB}.`);
    }
    const snapshot = expectedFence || captureTicketFence(ticket);
    if (!snapshot || snapshot.status === "legacy-absent") return { ok: true, legacy: true };
    return verifyCapturedTicketFence(snapshot);
  }
  if (fence.status === "legacy-absent") return { ok: true, legacy: true };
  return verifyCapturedTicketFence(fence);
}

function verifyCapturedTicketFence(fence) {
  // guard:integration-authority
  if (fence.status !== "captured" || !fence.token) fail(`Refusing ${fence.ticket}: integration operation has an invalid attempt fence; run ${RECOVER_VERB}.`);
  const localEpoch = currentAuthorityEpoch();
  if (fence.authority_epoch !== localEpoch) {
    // guard:integration-authority
    fail(`Refusing ${fence.ticket}: canonical authority epoch ${fence.authority_epoch} differs from the holder's epoch ${localEpoch}; the canonical record must be re-established before integration.`);
  }
  const result = attemptCoordination.verifyFence(path.dirname(state.RUNTIME_DIR), {
    remote: fence.remote,
    ticket: fence.ticket,
    token: fence.token,
    authorityEpoch: fence.authority_epoch,
  });
  if (!result.ok) {
    // guard:integration-authority
    fail(`Refusing ${fence.ticket}: canonical attempt fence is ${result.reason}; captured ${fence.token}, current ${result.current_token || "absent"}. Re-run gov integration attempts ${fence.ticket} and retry from the current generation.`);
  }
  if (result.selected_attempt !== fence.selected_attempt) {
    // guard:integration-authority
    fail(`Refusing ${fence.ticket}: selected attempt changed from ${fence.selected_attempt || "none"} to ${result.selected_attempt || "none"}. Re-run gov integration attempts ${fence.ticket} and retry from the current generation.`);
  }
  return result;
}

function decisionFenceForTicket(ticket) {
  const record = readRecord();
  const operation = record && record.operation;
  const persisted = operation && operation.ticket === ticket && operation.baseline && operation.baseline.attempt_fence;
  if (operation && operation.ticket === ticket) {
    return persisted || { status: "legacy-absent", remote: process.env.COORD_ATTEMPT_REMOTE || "origin", ticket, reason: "operation-predates-capture" };
  }
  return captureTicketFence(ticket);
}

// Consumer factories may use the canonical implementation by default while
// retaining explicit dependency overrides for isolated tests and embedders.
function resolveTicketFenceDependencies(deps = {}, { includeDecision = false } = {}) {
  const resolved = { ...deps };
  if (resolved.assertTicketFence === undefined) resolved.assertTicketFence = assertTicketFence;
  if (includeDecision && resolved.decisionFenceForTicket === undefined) resolved.decisionFenceForTicket = decisionFenceForTicket;
  return resolved;
}

// A terminal verb opens (or adopts) an operation before its first side effect
// and closes it after its publication step. A failure that left no side effect
// (no journal growth, no canonical commit) clears the operation; any other
// failure keeps it recorded as interrupted.
// A terminal verb opens (or adopts) an operation before its first side effect.
// The open is a lock-only reservation in the runtime record; an implicit first
// grant is held provisionally inside it. When the verb ends, the outcome
// decides what reaches the journal:
//   side effects (journal growth or a moved canonical HEAD): the grant, any
//     holder-session refresh and the close or interruption are journaled;
//   no side effect: the record is restored exactly and nothing is journaled,
//     unless the verb closed a journaled `integration begin` reservation.
function runTerminalOperation(verb, ticket, caller, run) {
  const opened = withGovernanceRuntimeLock(() => {
    const record = readRecord();
    const plan = authorityPlan(verb, record, caller);
    assertOperationAllowsIntegration(verb, caller);
    const existing = record ? record.operation : null;
    if (existing && existing.ticket !== ticket) {
      fail(`Refusing "${verb} ${ticket}": integration operation ${existing.id} for ${existing.ticket} is still open. Finish it, or run ${RECOVER_VERB}.`);
    }
    const operation = existing
      ? { ...existing, verb, step: "closeout", pid: process.pid, pid_start_time: processStartTime(process.pid), host: os.hostname(), adopted_at: new Date().toISOString() }
      : newOperation(verb, ticket, caller, "terminal-verb", plan.grant ? nextEpoch(record) : record.authority_epoch);
    const holder = plan.grant ? provisionalHolder(plan.holder) : record.holder;
    writeRecord({ ...(record || emptyRecord()), holder, operation }, { event: existing ? "operation-adopted" : "operation-opened", operation: operation.id, ticket, handle: caller.handle, command: verb });
    return { operation, plan, prior: record, fence: authorityFence(readRecord()), previous: existing || null, journalBytes: journalBytes() };
  });
  activeOperationId = opened.operation.id;
  activeOperationFence = opened.fence;
  let result;
  try {
    result = run();
  } catch (error) {
    activeOperationId = null;
    activeOperationFence = null;
    settleOperation(opened, caller, error);
    throw error;
  }
  activeOperationId = null;
  activeOperationFence = null;
  settleOperation(opened, caller, null);
  return result;
}

function settleOperation(opened, caller, error) {
  return withGovernanceRuntimeLock(() => {
    assertFence(opened.fence, opened.operation.verb);
    const op = opened.operation;
    const sideEffects = journalBytes() !== opened.journalBytes || canonicalHead() !== op.baseline.head;
    const reason = error ? String(error.message || error).slice(0, 300) : null;
    if (!sideEffects && !(opened.previous && !error)) {
      withGovernanceRuntimeLock(() => restoreBeforeOperation(opened, reason));
      return;
    }
    if (opened.plan.grant) commitGrant(op.verb, caller);
    if (opened.plan.refresh) commitRefresh(op.verb, caller);
    const details = { ticket: op.ticket, operation: op.id, handle: caller.handle, session_id: caller.session_id, command: op.verb, reason };
    journaled(error ? "operation-interrupt" : "operation-close", details, () => {
      // The caller still holds the runtime lock acquired above, and assertFence
      // verified this operation before entering settlement. No governed writer
      // can replace it before this synchronous journal callback.
      const record = readRecord();
      const current = record.operation;
      const operation = error
        ? { ...current, status: "interrupted", pid: null, pid_start_time: null, interrupted_at: new Date().toISOString(), interrupted_reason: reason }
        : null;
      writeRecord({ ...record, operation }, { event: error ? "operation-interrupted" : "operation-closed", ...details });
    });
  });
}

// No side effect: put back the record the verb found, byte for byte in
// authority terms (holder and reservation), with only a history note.
function restoreBeforeOperation(opened, reason) {
  // Only settleOperation calls this, under the same runtime lock after checking
  // the full authority fence. The reserved operation cannot change here.
  const record = readRecord();
  if (!opened.prior) {
    restoreRecord();
    return;
  }
  writeRecord({ ...record, holder: opened.prior.holder, operation: opened.previous ? { ...opened.previous } : null },
    { event: "operation-aborted-before-side-effects", operation: opened.operation.id, ticket: opened.operation.ticket, command: opened.operation.verb, reason });
}

// Defense in depth for governed writes that do not pass the dispatch guard
// (MCP-free in-process callers, nested helpers): withGovernanceMutation calls
// this under the runtime lock.
// Identity-only journaled mutations (session binding, registration) stay
// allowed: registration is attribution, never integration.
const IDENTITY_MUTATIONS = new Set([...VERB_CLASSES.identity, "claim", "agents-register", "agents-recover-lease-registry"]);

function assertNoForeignOperation(metadata = {}) {
  if (activeOperationId || activeCommandFence) {
    if (activeOperationId) assertActiveExecutor(metadata.command || "governed write");
    if (activeCommandFence) assertFence(activeCommandFence, metadata.command || "governed write");
    return;
  }
  const command = String(metadata.command || "");
  if (command.startsWith("integration-") || IDENTITY_MUTATIONS.has(command)) return;
  const file = recordPath();
  if (!fs.existsSync(file)) return;
  const record = readRecord();
  if (!record || !record.operation) return;
  const caller = resolveCaller();
  if (sameHolder(caller, reservationHolder(record))) return;
  refuseForeignOperation(metadata.command || "governed write", record, caller);
}

module.exports = {
  RECORD_FILE,
  SCHEMA,
  VERB_CLASSES,
  FLAG_PROMOTIONS,
  TERMINAL_VERBS,
  HANDOFF_VERB,
  classifyCommand,
  bindSessionReaders,
  resolveCaller,
  readRecord,
  writeRecord,
  emptyRecord,
  recordPath,
  executorState,
  operationIssues,
  describeOperation,
  describeHolder,
  guardCommand,
  withActiveCommandFence,
  assertNoForeignOperation,
  newOperation,
  assertTicketFence,
  captureTicketFence,
  decisionFenceForTicket,
  resolveTicketFenceDependencies,
  grantHolder,
  migrateEpoch,
  nextEpoch,
  canonicalHead,
  journalBytes,
  journaled,
  __testing: {
    setActiveOperationId: (id) => { activeOperationId = id; },
    getSessionReaders: () => sessionReaders,
    setSessionReaders: (readers) => { sessionReaders = readers; },
    getJournalReader: () => readJournalEvents,
    setJournalReader: (reader) => { readJournalEvents = reader; },
    getJournalMutation: () => journalMutation,
    setFaultHook: (fn) => { faultHook = fn || (() => {}); },
    setJournalMutation: (fn) => { journalMutation = fn; },
  },
};
