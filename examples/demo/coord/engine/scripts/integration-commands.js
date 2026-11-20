"use strict";

// COORD-915: `gov integration status|claim|handoff|release|begin|recover`.
// Every authority change is a journaled governed transaction under the runtime
// lock (authority.journaled -> withGovernanceMutation, "integration-<event>"). The record
// itself lives in the runtime ledger (<runtime>/integration-authority.json).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = path.resolve(__dirname, "..", "..");
const { state, GovernanceError } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-context.js"));
const authority = require("./integration-authority.js");
const attemptCoordination = require("./attempt-coordination.js");
const approvalVerifier = require("./approval-verifier.js");

const USAGE = [
  "coord/scripts/gov integration status [--json]",
  "coord/scripts/gov integration claim",
  "coord/scripts/gov integration handoff --to <handle> --human-admin-override \"<reason>\"",
  "coord/scripts/gov integration release",
  "coord/scripts/gov integration begin <ticket-id>",
  "coord/scripts/gov integration recover [--resume [--human-admin-override \"<reason>\"] | --abandon --human-admin-override \"<reason>\"] [--json]",
  "coord/scripts/gov integration attempts <ticket-id> [--remote <name>] [--json]",
  "coord/scripts/gov integration select <ticket-id> --attempt <id> [--reject <id> --reason <text> ...] [--remote <name>] [--json]",
].join("\n");

// Value flags, and the option each one fills.
const VALUE_FLAGS = { "--to": "to", "--human-admin-override": "override", "--remote": "remote", "--attempt": "attempt" };

function fail(message) {
  throw new GovernanceError(message);
}

function parseArgs(args) {
  const options = { positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json" || arg === "--resume" || arg === "--abandon") {
      options[arg.slice(2)] = true;
    } else if (VALUE_FLAGS[arg]) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value.`);
      options[VALUE_FLAGS[arg]] = value;
      i += 1;
    } else if (arg === "--reject") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fail("--reject requires an attempt id.");
      options.rejects = [...(options.rejects || []), { attempt: value, reason: null }];
      i += 1;
    } else if (arg === "--reason") {
      // A reason belongs to the --reject it follows (ADR 0023 section 6).
      const value = args[i + 1];
      const last = (options.rejects || []).slice(-1)[0];
      if (!value || value.startsWith("--")) fail("--reason requires a value.");
      if (!last || last.reason !== null) fail("--reason must follow the --reject <id> it explains.");
      last.reason = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      fail(`Unknown flag "${arg}" for gov integration.\n${USAGE}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function requireCaller(sub) {
  const caller = authority.resolveCaller();
  if (!caller) {
    fail(`gov integration ${sub} needs an attributed session. Bind with coord/scripts/gov agentid --owner <handle> first.`);
  }
  return caller;
}

function ticketStatus(ticket) {
  if (!ticket) return null;
  try {
    const board = JSON.parse(fs.readFileSync(state.BOARD_PATH, "utf8"));
    for (const section of board.sections || []) {
      const row = (section.rows || []).find((r) => r.ID === ticket);
      if (row) return row.Status || null;
    }
  } catch {
    return null;
  }
  return null;
}

function ticketOwner(ticket) {
  try {
    const board = JSON.parse(fs.readFileSync(state.BOARD_PATH, "utf8"));
    for (const section of board.sections || []) {
      const row = (section.rows || []).find((r) => r.ID === ticket);
      if (row) return row.Owner || "unassigned";
    }
  } catch {
    return "unassigned";
  }
  return "unassigned";
}

function canonicalDirtyPaths() {
  const r = spawnSync("git", ["-C", path.dirname(state.RUNTIME_DIR), "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
}

// Verification facts for an open operation. These are what recover records in
// the journal before it changes the reservation.
function verifyOperation(operation) {
  const head = authority.canonicalHead();
  return {
    operation: operation.id,
    ticket: operation.ticket,
    ticket_status: ticketStatus(operation.ticket),
    executor: authority.executorState(operation),
    issues: authority.operationIssues(operation),
    journal_grew: authority.journalBytes() !== operation.baseline.journal_bytes,
    head_before: operation.baseline.head,
    head_now: head,
    head_moved: head !== operation.baseline.head,
    canonical_dirty_paths: canonicalDirtyPaths(),
  };
}

function readJsonArray(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(value) ? value : [];
}

const GRANT_EVENTS = new Set(["integration-grant", "integration-claim", "integration-handoff"]);

// The journaled event that made `handle` the holder: the latest grant, claim or
// handoff naming it, read from the hash-chained journal.
function latestGrantEvent(handle) {
  const file = state.GOVERNANCE_EVENT_LOG_PATH;
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes("\"integration-")) continue;
    const event = JSON.parse(lines[i]);
    const d = event.details || {};
    if (GRANT_EVENTS.has(event.command) && (d.handle || d.to) === handle) {
      return { ts: event.ts, command: event.command, granted_via: d.granted_via || null, session_id: d.session_id || d.to_session_id || null };
    }
  }
  return null;
}

function print(options, payload, text) {
  console.log(options.json ? JSON.stringify(payload, null, 2) : text);
  return payload;
}

function createIntegrationCommands(deps = {}) {
  const appendGovernanceEvent = deps.appendGovernanceEvent;
  const runtimeDir = deps.runtimeDir || state.RUNTIME_DIR;
  // Authority changes go through the shared journaled transaction, so the
  // record and its journal event commit as a pair (see integration-authority.js).
  function mutate(sub, ticket, details, fn) {
    details.ticket = ticket || null;
    return authority.journaled(sub, details, fn);
  }

  function status(options) {
    const record = authority.readRecord();
    const caller = authority.resolveCaller();
    const payload = {
      record_path: authority.recordPath(),
      holder: record ? record.holder : null,
      operation: record && record.operation ? { ...record.operation, verification: verifyOperation(record.operation) } : null,
      caller,
      caller_holds_authority: Boolean(caller && record && record.holder && record.holder.handle === caller.handle),
      established: Boolean(record),
      grant_event: record && record.holder ? latestGrantEvent(record.holder.handle) : null,
    };
    const lines = [
      `[gov integration] domain runtime: ${state.RUNTIME_DIR}`,
      `holder: ${record ? authority.describeHolder(record.holder) : "none yet (the first identified integration verb or gov integration claim establishes it)"}`,
      `operation: ${payload.operation ? `${authority.describeOperation(record.operation)}; ${payload.operation.verification.issues.join("; ") || "no recovery issues"}` : "none open"}`,
      `grant event: ${payload.grant_event ? `${payload.grant_event.command} at ${payload.grant_event.ts} (granted_via ${payload.grant_event.granted_via})` : "none journaled"}`,
      `caller: ${caller ? `${caller.handle} (${caller.session_id || "no session"})` : "unidentified"}`,
    ];
    return print(options, payload, lines.join("\n"));
  }

  function claim(options) {
    const caller = requireCaller("claim");
    const details = { handle: caller.handle, session_id: caller.session_id, granted_via: "claim", command: "integration claim" };
    return mutate("claim", null, details, () => {
      const record = authority.readRecord() || authority.emptyRecord();
      if (record.holder && record.holder.handle === caller.handle) {
        return print(options, { holder: record.holder, changed: false }, `[gov integration] ${caller.handle} already holds integration authority.`);
      }
      if (record.holder) {
        fail(`Integration authority is held by ${authority.describeHolder(record.holder)}. Handoff is explicit: ${authority.HANDOFF_VERB}.`);
      }
      const holder = authority.grantHolder(caller, "claim", "gov integration claim");
      const next = authority.writeRecord({ ...record, holder, authority_epoch: authority.nextEpoch(record) }, { event: "granted", handle: caller.handle, session_id: caller.session_id, via: "claim" });
      return print(options, { holder: next.holder, changed: true }, `[gov integration] ${caller.handle} now holds integration authority for this domain.`);
    });
  }

  function registeredTarget(handle) {
    const agents = readJsonArray(state.AGENTS_PATH);
    if (!agents.some((a) => a.handle === handle && a.status !== "disabled")) {
      fail(`gov integration handoff --to ${handle}: not an active registered agent handle.`);
    }
    const sessions = readJsonArray(state.AGENT_SESSIONS_PATH).filter((s) => s.handle === handle && s.board_path === state.BOARD_PATH);
    return sessions.pop() || {};
  }

  function handoffDetails(options, targetSession, by) {
    return { to: options.to, to_session_id: targetSession.session_id || null, by, granted_via: "handoff",
      command: "integration handoff", human_admin_override: options.override };
  }

  function handoffHolder(options, targetSession, by) {
    return { handle: options.to, session_id: targetSession.session_id || null, thread_id: targetSession.thread_id || null,
      granted_at: new Date().toISOString(), granted_via: "handoff", reason: options.override, granted_by: by };
  }

  function handoff(options) {
    if (!options.to) fail(`gov integration handoff requires --to <handle>.\n${USAGE}`);
    if (!String(options.override || "").trim()) fail("gov integration handoff requires --human-admin-override \"<reason>\".");
    const targetSession = registeredTarget(options.to);
    const by = (authority.resolveCaller() || {}).handle || null;
    const before = authority.readRecord() || authority.emptyRecord();
    const approval = approvalVerifier.requireHumanAdminApprovalForState({
      verb: "integration handoff",
      ticket: options.to,
      reason: options.override,
      state: { authority: before, target: targetSession, by },
      appendGovernanceEvent,
      runtimeDir,
      approvalClient: deps.approvalClient,
      fail,
    });
    const details = handoffDetails(options, targetSession, by);
    Object.assign(details, { human_admin_session: approval.session_id || null, approval_record: approval.record_id || null,
      approval_verified: approval.key_id ? `key_id=${approval.key_id}` : null, approval_mode: approval.mode, approval_subject_sha256: approval.subject_sha256 });
    return mutate("handoff", null, details, () => {
      const record = authority.readRecord() || authority.emptyRecord();
      if (approvalVerifier.canonicalJson(record) !== approvalVerifier.canonicalJson(before)) fail("gov integration handoff: authority changed after human approval; review and retry.");
      if (approvalVerifier.canonicalJson(registeredTarget(options.to)) !== approvalVerifier.canonicalJson(targetSession) ||
          ((authority.resolveCaller() || {}).handle || null) !== by) fail("gov integration handoff: target session or caller changed after human approval; review and retry.");
      const previous = record.holder || {};
      const from = previous.handle || null;
      Object.assign(details, { from, from_session_id: previous.session_id || null, operation: record.operation && record.operation.id });
      const holder = handoffHolder(options, targetSession, by);
      // An open operation is preserved; the new holder did not run it, so it
      // must be verified before integration resumes.
      const operation = record.operation
        ? { ...record.operation, requires_recovery: true, recovery_reason: `authority handed from ${from} to ${options.to}` }
        : null;
      const next = authority.writeRecord({ ...record, holder, operation, authority_epoch: authority.nextEpoch(record) },
        { event: "handoff", from, to: options.to, by, reason: options.override, operation: operation && operation.id });
      const kept = operation ? ` Operation ${operation.id} is preserved and requires coord/scripts/gov integration recover.` : "";
      return print(options, { holder: next.holder, operation: next.operation },
        `[gov integration] integration authority handed from ${from || "no holder"} to ${options.to}.${kept}`);
    });
  }

  function release(options) {
    const caller = requireCaller("release");
    return mutate("release", null, { handle: caller.handle, session_id: caller.session_id, command: "integration release" }, () => {
      const record = authority.readRecord();
      if (!record || !record.holder) fail("No integration-authority holder to release.");
      if (record.holder.handle !== caller.handle) fail(`Only the holder (${record.holder.handle}) releases integration authority; a human admin uses ${authority.HANDOFF_VERB}.`);
      if (record.operation) fail(`Refusing release: integration operation ${record.operation.id} is open. Finish or recover it first.`);
      authority.writeRecord({ ...record, holder: null }, { event: "released", handle: caller.handle });
      return print(options, { released: true }, `[gov integration] ${caller.handle} released integration authority; the next holder must run gov integration claim.`);
    });
  }

  function begin(options) {
    const ticket = options.positional[0];
    if (!ticket) fail(`gov integration begin requires <ticket-id>.\n${USAGE}`);
    const caller = requireCaller("begin");
    const details = { handle: caller.handle, session_id: caller.session_id, command: "integration begin" };
    return mutate("begin", ticket, details, () => {
      const record = authority.readRecord();
      if (!record || !record.holder || record.holder.handle !== caller.handle) {
        fail(`gov integration begin: ${caller.handle} does not hold integration authority (${record ? authority.describeHolder(record.holder) : "no holder; run gov integration claim"}).`);
      }
      if (record.operation) fail(`gov integration begin: operation ${record.operation.id} (${authority.describeOperation(record.operation)}) is already open.`);
      const operation = authority.newOperation("begin", ticket, caller, "begin");
      details.operation = operation.id;
      authority.writeRecord({ ...record, operation }, { event: "operation-opened", operation: operation.id, ticket, verb: "begin", handle: caller.handle });
      return print(options, { operation }, `[gov integration] operation ${operation.id} reserves integration for ${ticket}; the terminal verb for ${ticket} adopts and closes it.`);
    });
  }

  function verificationReport(options, record) {
    const verification = verifyOperation(record.operation);
    const text = [`[gov integration] verification of ${authority.describeOperation(record.operation)}:`,
      ...Object.entries(verification).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
      "Resume with --resume (holder), or abandon with --abandon --human-admin-override \"<reason>\"."].join("\n");
    return print(options, { verification }, text);
  }

  // Refusals that hold for both actions: never resolve a running executor, and
  // an executor whose liveness this host cannot check needs a human admin.
  function assertRecoverable(record, verification, options, override, caller) {
    if (options.resume && options.abandon) fail("Choose one of --resume or --abandon.");
    const op = record.operation;
    if (verification.executor === "live") {
      fail(`Refusing recover: the executor process ${op.pid} is still running on this host. Wait for it to finish.`);
    }
    if (verification.executor === "unknown" && !override) {
      fail(`Refusing recover: executor ${op.pid} ran on ${op.host}, whose liveness cannot be checked here; pass --human-admin-override "<reason>".`);
    }
    if (options.abandon && !override) fail("gov integration recover --abandon requires --human-admin-override \"<reason>\".");
    if (options.resume && !(caller && record.holder && record.holder.handle === caller.handle)) {
      fail(`gov integration recover --resume is for the holder (${authority.describeHolder(record.holder)}). Hand authority over first with ${authority.HANDOFF_VERB}.`);
    }
  }

  function resumedOperation(op, caller) {
    return { ...op, status: "open", requires_recovery: false, pid: null, recovered_at: new Date().toISOString(),
      recovered_by: caller.handle, holder_handle: caller.handle, session_id: caller.session_id,
      lease_expires_at: authority.newOperation("recover", null, caller, "begin").lease_expires_at };
  }

  function recover(options) {
    const initial = authority.readRecord();
    if (!initial || !initial.operation) {
      return print(options, { operation: null }, "[gov integration] no integration operation is recorded; nothing to recover.");
    }
    if (!options.resume && !options.abandon) return verificationReport(options, initial);
    const override = String(options.override || "").trim();
    const caller = authority.resolveCaller();
    const action = options.resume ? "resume" : "abandon";
    const details = { action, handle: caller && caller.handle, session_id: caller && caller.session_id,
      command: `integration recover --${action}`, human_admin_override: override || null };
    const initialVerification = verifyOperation(initial.operation);
    // Approval audit events advance the journal by design. Bind all verification
    // facts but omit this derived bit from the subject; under-lock revalidation
    // applies the same projection after the signer returns.
    const withoutJournalGrowth = ({ journal_grew, ...rest }) => rest;
    assertRecoverable(initial, initialVerification, options, override, caller);
    let approval = null;
    if (options.abandon || (options.resume && override)) {
      approval = approvalVerifier.requireHumanAdminApprovalForState({
        verb: `integration recover --${action}`,
        ticket: initial.operation.ticket,
        reason: override,
        state: { operation: initial.operation, verification: withoutJournalGrowth(initialVerification), holder: initial.holder, caller },
        appendGovernanceEvent,
        runtimeDir,
        approvalClient: deps.approvalClient,
        fail,
      });
      Object.assign(details, { human_admin_session: approval.session_id || null, approval_record: approval.record_id || null,
        approval_verified: approval.key_id ? `key_id=${approval.key_id}` : null, approval_mode: approval.mode, approval_subject_sha256: approval.subject_sha256 });
    }
    // Verification and the change happen under the same runtime lock.
    return mutate("recover", initial.operation.ticket, details, () => {
      const record = authority.readRecord();
      if (approvalVerifier.canonicalJson(record) !== approvalVerifier.canonicalJson(initial)) fail("gov integration recover: operation changed after human approval; review and retry.");
      const currentCaller = authority.resolveCaller();
      if (approvalVerifier.canonicalJson(currentCaller) !== approvalVerifier.canonicalJson(caller)) fail("gov integration recover: caller session changed after human approval; review and retry.");
      const freshVerification = verifyOperation(record.operation);
      if (approvalVerifier.canonicalJson(withoutJournalGrowth(freshVerification)) !== approvalVerifier.canonicalJson(withoutJournalGrowth(initialVerification))) {
        fail("gov integration recover: executor or repository state changed after human approval; review and retry.");
      }
      const verification = { ...freshVerification, journal_grew: initialVerification.journal_grew };
      assertRecoverable(record, verification, options, override, caller);
      Object.assign(details, { verification, operation: record.operation.id });
      const operation = options.resume ? resumedOperation(record.operation, caller) : null;
      authority.writeRecord({ ...record, operation }, { event: `operation-${action === "resume" ? "resumed" : "abandoned"}`,
        operation: record.operation.id, ticket: record.operation.ticket, by: caller && caller.handle, reason: override || null, verification });
      return print(options, { action, verification, operation }, options.resume
        ? `[gov integration] operation ${record.operation.id} verified and resumed by ${caller.handle}; rerun the terminal verb for ${record.operation.ticket}.`
        : `[gov integration] operation ${record.operation.id} abandoned after verification; integration may resume.`);
    });
  }

  // COORD-1028 / ADR 0023 section 6: read-only listing of every attempt for a
  // ticket, with the canonical record it is compared against.
  function attempts(options) {
    const ticket = options.positional[0];
    // guard:integration-authority
    if (!ticket) fail(`gov integration attempts requires <ticket-id>.\n${USAGE}`);
    const remote = options.remote || "origin";
    const repoRoot = path.dirname(state.RUNTIME_DIR);
    const list = attemptCoordination.listAttempts(repoRoot, { remote, ticket });
    const canonical = attemptCoordination.readCanonical(repoRoot, { remote, ticket });
    const payload = {
      ticket,
      remote,
      canonical: canonical ? { ref: canonical.ref, oid: canonical.oid, token: attemptCoordination.tokenFor(ticket, canonical.record, canonical.oid), record: canonical.record } : null,
      attempts: list.map((a) => ({ ref: a.ref, oid: a.oid, attempt_id: a.record.attempt_id, domain_id: a.record.domain_id,
        domain_label: a.record.domain_label, agent: a.record.agent.handle, branch: a.record.branch, base_sha: a.record.base_sha,
        state: a.record.state, updated_at: a.record.updated_at, age_ms: a.classification.age_ms, classes: a.classification.classes })),
    };
    const lines = [`[gov integration] ${ticket}: ${list.length} attempt(s) on ${remote}`,
      canonical ? `canonical generation ${canonical.record.generation} owner ${canonical.record.owner} status ${canonical.record.status}` : "canonical record: none (created by the first select)",
      ...payload.attempts.map((a) => `  ${a.attempt_id} ${a.agent} domain=${a.domain_id} branch=${a.branch} state=${a.state} updated=${a.updated_at}${a.classes.length ? ` [${a.classes.join(", ")}]` : ""}`)];
    return print(options, payload, lines.join("\n"));
  }

  // COORD-1028 / ADR 0023 section 6, select-only (answer 5). COORD-1041 (a): the decision is
  // journaled as canonical-transition-intent BEFORE any canonical write (section 5.2). The
  // holder and attempt checks run again under the outer lock, the fence (verifyFence) is
  // checked immediately before the lease-guarded push, and an unapplied transition is journaled
  // as canonical-transition-abandoned. The outcome is journaled as attempt-selection.
  function select(options) {
    const ticket = options.positional[0];
    // guard:integration-authority
    if (!ticket) fail(`gov integration select requires <ticket-id>.\n${USAGE}`);
    // guard:integration-authority
    if (!options.attempt) fail("gov integration select requires --attempt <id>.");
    const rejects = options.rejects || [];
    for (const reject of rejects) {
      // guard:integration-authority
      if (!reject.reason || !String(reject.reason).trim()) fail(`gov integration select: --reject ${reject.attempt} needs a --reason.`);
      // guard:integration-authority
      if (reject.attempt === options.attempt) fail(`gov integration select: ${options.attempt} cannot be both selected and rejected.`);
    }
    const caller = requireCaller("select");
    const remote = options.remote || "origin";
    const repoRoot = path.dirname(state.RUNTIME_DIR);
    const base = { ticket, handle: caller.handle, session_id: caller.session_id, command: "integration select", remote,
      selected_attempt: options.attempt, rejected_attempts: rejects.map((r) => r.attempt) };
    const holderRefusal = (record) => {
      // guard:integration-authority
      if (!record || !record.holder || record.holder.handle !== caller.handle) {
        fail(`gov integration select: ${caller.handle} does not hold integration authority (${record ? authority.describeHolder(record.holder) : "no holder; run gov integration claim"}).`);
      }
      // guard:integration-authority
      if (record.operation) fail(`gov integration select: operation ${record.operation.id} is open; finish or recover it first.`);
    };
    const intent = { ...base };
    const decided = authority.journaled("canonical-transition-intent", intent, () => {
      const record = authority.readRecord();
      holderRefusal(record);
      const listed = attemptCoordination.listAttempts(repoRoot, { remote, ticket });
      const selected = listed.find((a) => a.record.attempt_id === options.attempt);
      // guard:integration-authority
      if (!selected) fail(`gov integration select: attempt ${options.attempt} is not published for ${ticket} on ${remote}.`);
      // guard:integration-authority
      if (selected.record.state !== "active") fail(`gov integration select: attempt ${options.attempt} is ${selected.record.state}, not active.`);
      for (const reject of rejects) {
        // guard:integration-authority
        if (!listed.some((a) => a.record.attempt_id === reject.attempt)) fail(`gov integration select: rejected attempt ${reject.attempt} is not published for ${ticket}.`);
      }
      const epoch = record.authority_epoch;
      const canonical = attemptCoordination.readCanonical(repoRoot, { remote, ticket });
      // guard:integration-authority
      if (canonical && canonical.record.authority_epoch !== epoch) {
        fail(`gov integration select: canonical authority epoch ${canonical.record.authority_epoch} differs from the holder's epoch ${epoch}; the canonical record must be re-established before selection.`);
      }
      const baseGeneration = canonical ? canonical.record.generation : 0;
      const next = attemptCoordination.canonicalRecord({
        ticket, generation: baseGeneration + 1, owner: selected.record.agent.handle, status: "doing",
        selected: selected.record.attempt_id,
        rejected: [...(canonical ? canonical.record.rejected_attempts || [] : []), ...rejects.map((r) => ({ attempt_id: r.attempt, reason: r.reason }))],
        integrator: { handle: caller.handle, session_id: caller.session_id, domain_id: null },
        authorityEpoch: epoch, txn: intent.txn, now: new Date().toISOString(),
      });
      return {
        epoch, bootstrap: !canonical, base_generation: baseGeneration, next_record: next,
        owner_before: canonical ? canonical.record.owner : null,
        expected_token: canonical ? attemptCoordination.tokenFor(ticket, canonical.record, canonical.oid) : null,
        selected: selected.record.attempt_id,
        rejected: [...(canonical ? canonical.record.rejected_attempts || [] : []), ...rejects.map((r) => ({ attempt_id: r.attempt, reason: r.reason }))],
      };
    });
    const details = { ...base, intent_txn: intent.txn };
    try {
      return mutate("attempt-selection", ticket, details, () => {
        const record = authority.readRecord();
        holderRefusal(record);
        // guard:integration-authority
        if (record.authority_epoch !== decided.epoch) {
          fail(`gov integration select: authority epoch moved from ${decided.epoch} to ${record.authority_epoch} after the intent was journaled; re-run gov integration select.`);
        }
        let current = attemptCoordination.readCanonical(repoRoot, { remote, ticket });
        if (decided.bootstrap && current) {
          // guard:integration-authority
          fail(`gov integration select: canonical ${ticket} appeared after the intent was journaled; re-run gov integration attempts ${ticket}.`);
        }
        if (!decided.bootstrap && !current) {
          // guard:integration-authority
          fail(`gov integration select: canonical ${ticket} is absent; the record decided from is gone.`);
        }
        if (decided.bootstrap) {
          current = attemptCoordination.bootstrapCanonical(repoRoot, { remote, ticket, owner: ticketOwner(ticket), status: "todo", authorityEpoch: decided.epoch });
        }
        const tokenToVerify = decided.bootstrap ? attemptCoordination.tokenFor(ticket, current.record, current.oid) : decided.expected_token;
        const fence = attemptCoordination.verifyFence(repoRoot, { remote, ticket, token: tokenToVerify, authorityEpoch: decided.epoch });
        // guard:integration-authority
        if (!fence.ok) {
          fail(`gov integration select: canonical ${ticket} fence refused (${fence.reason}); current token ${fence.current_token || "absent"}. Re-run gov integration attempts ${ticket} and retry from the current generation.`);
        }
        const published = attemptCoordination.publishCanonicalTransition(repoRoot, { remote, ticket, expected: current, next: decided.next_record });
        if (published.status !== "published") {
          // guard:integration-authority
          fail(`gov integration select: canonical ${ticket} moved or refused the lease (${published.reason}); current holder ${published.holder || "absent"}. Re-run gov integration attempts ${ticket} and retry from the current generation.`);
        }
        Object.assign(details, {
          bootstrapped: decided.bootstrap, generation_before: decided.base_generation, generation_after: decided.next_record.generation,
          token_before: decided.bootstrap ? null : decided.expected_token,
          token_after: attemptCoordination.tokenFor(ticket, decided.next_record, published.oid),
          owner_before: decided.owner_before, owner_after: decided.next_record.owner, authority_epoch: decided.epoch,
        });
        return print(options, { ticket, selected: decided.selected, rejected: details.rejected_attempts, generation: decided.next_record.generation, token: details.token_after },
          `[gov integration] ${ticket}: selected ${options.attempt} at generation ${decided.next_record.generation} (owner ${decided.next_record.owner}, status doing).`);
      });
    } catch (error) {
      // The intent was journaled and no canonical transition applied: record the abandonment
      // (ADR 0023 window C1). Journaled outside the outer mutation so it is a separate event.
      authority.journaled("canonical-transition-abandoned", { ...base, intent_txn: intent.txn, reason: String(error.message || error).slice(0, 300) }, () => null);
      throw error;
    }
  }

  function integrationCommand(args = []) {
    const [sub, ...rest] = args;
    const options = parseArgs(rest);
    switch (sub) {
      case "status": return status(options);
      case "claim": return claim(options);
      case "handoff": return handoff(options);
      case "release": return release(options);
      case "begin": return begin(options);
      case "recover": return recover(options);
      case "attempts": return attempts(options);
      case "select": return select(options);
      default: return fail(`gov integration requires a subcommand.\n${USAGE}`);
    }
  }

  return { integrationCommand, verifyOperation };
}

module.exports = { createIntegrationCommands, USAGE, parseArgs };
