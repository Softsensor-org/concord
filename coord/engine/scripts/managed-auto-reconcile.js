"use strict";

// COORD-860 (ADR-0017 slice 2): reconcile one ticket's managed-auto evidence.
//
// Inputs are the existing local action ledger (v1/v2 chain), the declared
// policy it is bound to by digest, the ticket worktree's Git state and the
// ticket's declared file scope. The output is a closed, redacted summary:
// digests, counts, coverage, named gap and unexplained-effect codes and a
// verdict. Raw ledger rows, paths, diffs, commands, receipts and secret values
// stay in memory and never reach the summary.
//
// Claim boundary: only effects recorded inside the declared observation
// boundary and adapter coverage are assessed. A missing record, receipt or
// adapter is an explicit gap and never proof that no effect occurred.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");

const COORD = path.resolve(__dirname, "../..");
const load = (relative) => require(resolveEngineModule(COORD, relative));
const { gitTry } = require("./git-ops.js");
const { canonicalJson } = load("engine/scripts/auto-mode-policy.js");
const { PROVIDERS } = load("engine/scripts/auto-mode-adapters.js");
const { TARGET_CLASSES } = load("engine/scripts/capability-broker.js");
const { policyDigest } = load("engine/scripts/managed-auto-policy.js");
const { managedEvidencePaths } = load("engine/scripts/managed-auto-runner.js");
const {
  LEDGER_SCHEMA, POSSIBLE_EFFECT_RESULTS, PROCESS_RESULTS, readManagedLedger, receiptDigest, receiptProjection, verifyManagedLedger,
} = load("engine/scripts/managed-auto-ledger.js");

const SUMMARY_SCHEMA = "coord.managed-execution-summary/v1";
const VERDICTS = Object.freeze(["complete", "incomplete", "unexplained", "invalid"]);
const CLAIM_LIMIT = "Assesses only effects recorded inside the declared observation boundary and adapter coverage. "
  + "A missing record is never proof that no effect occurred. This is not a legal waiver or a universal observation guarantee.";
const REMOTE_GIT = /^(?:push|fetch|pull|remote|merge|tag)/;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// The declared scope must carry every list reconciliation reads; anything
// else is treated as a missing policy rather than an empty scope.
const POLICY_LISTS = ["command_classes", "network_allow", "secret_references", "broker_capabilities", "broker_targets"];
function readPolicy(file) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const shaped = policy && typeof policy.worktree === "string" && POLICY_LISTS.every((name) => Array.isArray(policy[name]))
    && policy.secret_references.every((entry) => entry && Array.isArray(entry.purposes));
  return shaped ? policy : null;
}

// A ticket is managed once a managed session or policy exists for it, or a
// summary was recorded. Ordinary tickets (no v2 events, no policy, no summary)
// stay unmanaged and keep their existing gates.
function isManagedTicket(files, record) {
  if (record || fs.existsSync(files.policy)) return true;
  return readManagedLedger(files.ledger).entries.some((entry) => entry.schema === LEDGER_SCHEMA);
}

function parseNulList(text) {
  return String(text).split("\0").filter(Boolean);
}

// Git status, committed changes since the merge base and non-merge commits.
// Only a content digest per changed path survives; content is never kept.
function observeGit(worktree, base, git = gitTry) {
  const run = (args) => {
    const result = git(worktree, args);
    if (result.status !== 0) throw new Error("git observation failed");
    return String(result.stdout);
  };
  try {
    if (fs.realpathSync(run(["rev-parse", "--show-toplevel"]).trim()) !== fs.realpathSync(worktree)) throw new Error("not a worktree root");
    const head = run(["rev-parse", "HEAD"]).trim();
    const baseCommit = run(["rev-parse", "--verify", `${base}^{commit}`]).trim();
    const committed = parseNulList(run(["diff", "--name-only", "-z", "--no-renames", `${baseCommit}...HEAD`]));
    const status = parseNulList(run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).map((entry) => entry.slice(3));
    const commits = run(["rev-list", "--no-merges", `${baseCommit}..HEAD`]).split("\n").filter(Boolean);
    const paths = [...new Set([...committed, ...status])].sort().map((relative) => {
      const file = path.join(worktree, relative);
      return { path: relative, digest: fs.existsSync(file) ? sha256(fs.readFileSync(file)) : "deleted" };
    });
    return { ok: true, head, base: baseCommit, paths, commits };
  } catch {
    return { ok: false, head: null, base: null, paths: [], commits: [] };
  }
}

function inDeclaredScope(file, declared) {
  return declared.some((entry) => {
    const pattern = String(entry).trim().replace(/\/\*\*?$/, "/");
    return pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;
  });
}

function egressAllowed(resource, policy) {
  const [host, port] = resource.split(":");
  return policy.network_allow.map((entry) => String(entry).toLowerCase()).includes(host) && (!port || port === "443");
}

function createNotes() {
  const gaps = new Set();
  const unexplained = new Set();
  const diagnostics = [];
  const add = (set, code, operationClass, entry) => {
    set.add(operationClass ? `${code}:${operationClass}` : code);
    diagnostics.push({ code, class: operationClass || null, sequence: entry ? entry.sequence : null });
  };
  return {
    gap: (code, operationClass, entry) => add(gaps, code, operationClass, entry),
    unexplained: (code, operationClass, entry) => add(unexplained, code, operationClass, entry),
    gaps, unexplainedSet: unexplained, diagnostics,
  };
}

// Pair attempts with results. Legacy actions without correlation still count
// as effects for attribution but are a correlation gap.
function groupActions(actions, notes, effects) {
  const groups = new Map();
  for (const action of actions) {
    if (!action.phase) {
      notes.gap("correlation_missing", action.operation_class, action);
      effects.push({ attempt: action, result: action });
      continue;
    }
    const key = `${action.action_id}\u0000${action.attempt_id}`;
    const group = groups.get(key) || { attempt: null, results: [] };
    if (action.phase === "attempt") group.attempt = group.attempt || action;
    else group.results.push(action);
    groups.set(key, group);
  }
  return groups.values();
}

function judgeGroup({ attempt, results: [result, ...extra] }, notes, completed) {
  if (!attempt) return notes.unexplained("result_without_attempt", result.operation_class, result);
  const operationClass = attempt.operation_class;
  if (extra.length) notes.unexplained("conflicting_result", operationClass, extra[0]);
  if (!result) return notes.gap("result_missing", operationClass, attempt);
  if (attempt.decision !== "allow" && result.result !== "denied") notes.unexplained("denied_action_dispatched", operationClass, result);
  if (result.result === "interrupted") notes.gap("interrupted_effect", operationClass, result);
  // `allowed` records a permitted state, not an outcome: a process must end
  // completed, failed or interrupted, and any other effect's outcome is unknown.
  if (operationClass === "command" && !PROCESS_RESULTS.has(result.result)) notes.gap("process_result_missing", operationClass, result);
  else if (result.result === "allowed") notes.gap("outcome_unknown", operationClass, result);
  if (POSSIBLE_EFFECT_RESULTS.has(result.result)) {
    completed.set(attempt.action_id, (completed.get(attempt.action_id) || 0) + 1);
    if (completed.get(attempt.action_id) > 1) notes.unexplained("duplicate_effect", operationClass, result);
  }
  return { attempt, result };
}

function pairActions(actions, notes) {
  const effects = [];
  const completed = new Map();
  for (const group of groupActions(actions, notes, effects)) {
    const effect = judgeGroup(group, notes, completed);
    if (effect) effects.push(effect);
  }
  return effects.sort((a, b) => a.result.sequence - b.result.sequence);
}

function checkReceipt(attempt, result, policy, notes) {
  const operationClass = attempt.operation_class;
  if (!policy.broker_capabilities.includes(attempt.resource)) notes.unexplained("unexplained_remote_effect", operationClass, result);
  if (!result.receipt_id) {
    notes.gap("receipt_missing", operationClass, result);
    return;
  }
  const bound = result.receipt_digest === receiptDigest(receiptProjection(result))
    && result.receipt_capability === attempt.resource
    && result.receipt_result === result.result
    && result.receipt_target_class === (TARGET_CLASSES[attempt.resource] || "other");
  if (!bound) return notes.unexplained("receipt_mismatch", operationClass, result);
  const declared = policy.broker_targets.some((entry) => entry.capability === attempt.resource && sha256(entry.target) === result.receipt_target_digest);
  if (!declared) notes.unexplained("out_of_scope_remote_target", operationClass, result);
  return undefined;
}

// One reconciliation rule per operation class; governance effects are
// lifecycle mutations journaled by gov itself.
const CLASS_CHECKS = {
  file(attempt, result, policy, notes, recorded) {
    if (attempt.resource_scope !== "worktree") return notes.unexplained("out_of_scope_file", "file", result);
    const before = recorded.writes.get(attempt.resource)?.before ?? attempt.before_digest;
    return recorded.writes.set(attempt.resource, { before, after: result.after_digest ?? null });
  },
  command(attempt, result, policy, notes) {
    if (!policy.command_classes.includes(attempt.command_class)) notes.unexplained("out_of_scope_command", "command", result);
  },
  network(attempt, result, policy, notes) {
    if (!egressAllowed(attempt.resource, policy)) notes.unexplained("unexplained_egress", "network", result);
  },
  secret(attempt, result, policy, notes) {
    const declared = policy.secret_references.find((entry) => entry.ref === attempt.resource);
    if (!declared || !declared.purposes.includes(attempt.purpose)) notes.unexplained("unexplained_secret_use", "secret", result);
  },
  git(attempt, result, policy, notes, recorded) {
    if (REMOTE_GIT.test(attempt.resource)) notes.unexplained("unexplained_remote_effect", "git", result);
    else if (result.commit) recorded.commits.add(result.commit);
  },
  mcp(attempt, result, policy, notes) {
    notes.unexplained("unattributed_remote_effect", "mcp", result);
  },
  governance() {},
};

// Per-class reconciliation of every non-denied effect against declared scope.
function checkEffects(effects, policy, notes) {
  const recorded = { writes: new Map(), commits: new Set() };
  for (const { attempt, result } of effects) {
    if (result.result === "denied") continue;
    if (attempt.tool === "capability-broker") checkReceipt(attempt, result, policy, notes);
    else CLASS_CHECKS[attempt.operation_class](attempt, result, policy, notes, recorded);
  }
  return recorded;
}

function checkChangedPaths(git, recorded, declared, notes) {
  const changed = new Set();
  for (const { path: file, digest } of git.paths) {
    changed.add(file);
    if (declared.length && !inDeclaredScope(file, declared)) notes.unexplained("out_of_scope_file", "file");
    const write = recorded.writes.get(file);
    if (!write) notes.unexplained("unexplained_file_change", "file");
    else if (write.after !== (digest === "deleted" ? null : digest)) notes.unexplained("file_digest_mismatch", "file");
  }
  for (const [file, write] of recorded.writes) {
    if (!changed.has(file) && write.after !== write.before) notes.gap("file_write_without_git_effect", "file");
  }
}

function checkGit(git, recorded, declared, notes) {
  if (!git.ok) return notes.gap("git_unavailable");
  if (!declared.length) notes.gap("declared_scope_missing", "file");
  checkChangedPaths(git, recorded, declared, notes);
  for (const commit of git.commits) if (!recorded.commits.has(commit)) notes.unexplained("unexplained_commit", "git");
  for (const commit of recorded.commits) if (!git.commits.includes(commit)) notes.gap("recorded_commit_missing", "git");
  return undefined;
}

function tally(effects) {
  const counts = {};
  for (const { attempt } of effects) counts[attempt.operation_class] = (counts[attempt.operation_class] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function reconcileManagedExecution({ ticketId, runtimeDir, baseCommit, declaredFiles = [], git = gitTry, maxGapMs } = {}) {
  const files = managedEvidencePaths(runtimeDir, ticketId);
  const { entries, issues: parseIssues } = readManagedLedger(files.ledger);
  const policy = readPolicy(files.policy);
  const ledger = verifyManagedLedger(entries, { ticket: ticketId, parse_issues: parseIssues, max_gap_ms: maxGapMs ?? policy?.limits?.heartbeat_max_ms });
  const notes = createNotes();
  for (const issue of [...ledger.issues, ...ledger.gaps]) notes.gap(issue.code);
  if (ledger.coverage !== "complete") notes.gap(`coverage_${ledger.coverage}`);
  // The declared policy binds by digest to the selected session (when there is
  // one); a policy with no session still scopes the Git reconciliation.
  const policyBound = Boolean(policy) && policy.digest === policyDigest(policy) && policy.ticket === ticketId
    && (ledger.policy_digest === null || policy.digest === ledger.policy_digest);
  if (!policy) notes.gap("policy_missing");
  else if (!policyBound) notes.gap("policy_digest_mismatch");
  const events = entries.filter((entry) => entry.schema === LEDGER_SCHEMA && entry.session === ledger.session);
  const effects = pairActions(events.filter((entry) => entry.type === "action"), notes);
  let observed = { ok: false, head: null, base: null, paths: [], commits: [] };
  if (policyBound) {
    const provider = PROVIDERS[ledger.provider];
    if (provider && policy.child_process_egress !== "deny" && provider.unmanaged.includes("network")) notes.gap("adapter_coverage_missing", "network");
    observed = observeGit(policy.worktree, baseCommit || policy.base_sha, git);
    checkGit(observed, checkEffects(effects, policy, notes), declaredFiles, notes);
  }
  const integrityValid = ledger.integrity === "valid" && policyBound;
  const verdict = !integrityValid ? "invalid" : notes.unexplainedSet.size ? "unexplained" : notes.gaps.size ? "incomplete" : "complete";
  const body = {
    schema: SUMMARY_SCHEMA,
    ticket: ticketId,
    session: ledger.session,
    provider: ledger.provider,
    policy_digest: ledger.policy_digest,
    chain_root: ledger.chain_root,
    session_head: ledger.session_head,
    base_commit: observed.base,
    head_commit: observed.head,
    integrity: ledger.integrity,
    coverage: ledger.coverage,
    counts: {
      entries: ledger.counts.entries,
      legacy_v1: ledger.counts.legacy_v1,
      session_events: ledger.counts.session_events,
      effects: effects.length,
      changed_paths: observed.paths.length,
      commits: observed.commits.length,
      by_class: tally(effects),
    },
    gaps: [...notes.gaps].sort(),
    unexplained: [...notes.unexplainedSet].sort(),
    diff_digest: observed.ok ? `sha256:${sha256(canonicalJson({ base: observed.base, head: observed.head, paths: observed.paths }))}` : null,
    verdict,
  };
  return { summary: { ...body, summary_digest: sha256(canonicalJson(body)) }, diagnostics: notes.diagnostics };
}

// Review/landing decision for one ticket. Unmanaged tickets get no issue and
// the unmanaged label; a managed ticket passes only with a fresh complete
// summary, or with a human-admin technical exception bound to that summary.
function evaluateManagedEvidence({ ticketId, plan, runtimeDir, git = gitTry }) {
  const files = managedEvidencePaths(runtimeDir, ticketId);
  const record = plan?.managed_execution;
  if (!isManagedTicket(files, record)) return { label: "unmanaged", issues: [] };
  const recordCommand = `coord/scripts/gov record-managed-evidence ${ticketId}`;
  const block = (code, message) => ({ label: "blocked", issues: [{ code, message: `${ticketId}: ${message} ${CLAIM_LIMIT}`, next_steps: [recordCommand] }] });
  if (!record) return block("managed_evidence_missing", "a managed-auto session exists but no reconciled execution summary is recorded.");
  const fresh = reconcileManagedExecution({
    ticketId, runtimeDir, baseCommit: record.summary.base_commit || undefined, declaredFiles: plan.intended_files || [], git,
  }).summary;
  if (fresh.summary_digest !== record.summary.summary_digest) {
    return block("managed_evidence_stale", "the ledger, declared scope or Git state changed after the execution summary was recorded; reconcile again.");
  }
  if (record.summary.verdict === "complete") return { label: "complete", issues: [] };
  const named = [...record.summary.gaps, ...record.summary.unexplained].sort();
  const exception = record.exception;
  if (exception && exception.summary_digest === record.summary.summary_digest && canonicalJson(exception.gaps) === canonicalJson(named)) {
    return { label: "technical-exception", issues: [] };
  }
  return block("managed_evidence_incomplete", `managed execution evidence is ${record.summary.verdict} (${named.join(", ")}); `
    + "only a complete reconciliation or a human-admin technical exception naming exactly these gaps can pass review or landing.");
}

module.exports = {
  CLAIM_LIMIT, SUMMARY_SCHEMA, VERDICTS, evaluateManagedEvidence, inDeclaredScope, isManagedTicket, observeGit, reconcileManagedExecution,
};
