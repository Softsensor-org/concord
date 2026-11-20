"use strict";

// COORD-936 item 8: selection is automatic; a human exception is the exception.
//
// Agents resolve and run a stage's checks from the policy and the blast radius
// with no approval prompt. An authorized human may, as an EXCEPTION:
//   - ADD checks (suites or commands) on top of the recommended selection, or
//   - REDUCE the recommended scope (drop suites or checks, or run the would-be
//     selection instead of the full suite).
// The two are distinct records. Both go through the existing human-admin
// override path (--human-admin-override "<reason>", resolveHumanAdminOverride)
// and are one journaled board mutation (`test-policy-exception`), stored in
// tasks.json metadata.test_policy_exceptions[<ticket>] with:
//   scope      the ticket's reviewed change scope: the immutable submission
//              (plan record review_submission: repository and commit, the
//              reviewed head), its tree, the base, the changed files and the
//              recommended set at authorization;
//   reason     the override reason;
//   authority  human-admin-override, and the bound session that recorded it.
// On every later plan the exception is re-evaluated against the current change:
//   - within scope (no new files, no path outside the bound set, no newly
//     affected consumer) both kinds apply, across replanning;
//   - when the scope expands, a reduction LAPSES (selection reverts to policy
//     until re-authorized) and an addition is KEPT unless withdrawn.
// A ticket exception can never reduce the mandatory guards (the policy's
// always-required suites; policy DATA, changed only by a governed policy change). Plans
// and run manifests label normal policy execution versus execution under an
// exception, naming it.

const KEY = "test_policy_exceptions";
const KINDS = Object.freeze(["add", "reduce"]);
const APPROVER = "human-admin";

function protectedItems(policy) {
  return new Set(["always-required-suites", ...policy.selection.always_required_suites]);
}

// Everything the plan recommends, by suite path and by check id.
function recommendedSet(plan) {
  const items = new Set();
  for (const c of plan.checks) {
    items.add(c.target || c.id);
    for (const s of c.suites || []) items.add(s);
  }
  return [...items].sort();
}

// guard:test-policy-exception-authority
function exceptionRefusals({ kind, items, policy, plan, override, stage = "pr" }) {
  const refusals = [];
  if (kind === "reduce" && stage === "promotion") refusals.push("promotion always runs the full suite and the coverage ratchet on the exact candidate; it cannot be reduced");
  if (!override || !override.reason.trim()) refusals.push(`a test-policy ${kind === "reduce" ? "reduction" : "addition"} is a human exception and requires --human-admin-override "<reason>"`);
  if (!KINDS.includes(kind)) refusals.push(`unknown exception kind ${kind}`);
  if (!items.length) refusals.push("an exception names at least one suite or check");
  if (kind === "reduce") {
    const guarded = protectedItems(policy);
    const recommended = new Set(recommendedSet(plan));
    for (const item of items) {
      if (guarded.has(item)) refusals.push(`${item} is a mandatory guard (always-required) and can never be reduced`);
      else if (item === "full-suite" && !(plan.selection && plan.selection.would_suites.length &&
        (plan.selection.human_exception_eligible === true || (plan.selection.tier !== "T2" &&
          (plan.selection.would_gate === "affected" || plan.selection.tier == null))))) {
        refusals.push("the full suite can be narrowed only to an eligible would-be selection, and this change has none");
      }
      else if (!recommended.has(item)) refusals.push(`${item} is not in the recommended selection; there is nothing to reduce`);
    }
  }
  return refusals;
}

function newException({ id, ticket, kind, stage, items, reason, recordedBy, scope, plan, now }) {
  return {
    id, ticket, kind, stage, items: [...items], reason,
    authority: { kind: "human-admin-override", approver: APPROVER, recorded_by: recordedBy || null },
    scope: { ...scope, recommended: recommendedSet(plan) },
    recorded_at: now, withdrawn_at: null,
  };
}

function withException(board, exception) {
  const all = { ...((board.metadata && board.metadata[KEY]) || {}) };
  all[exception.ticket] = [...(all[exception.ticket] || []), exception];
  return all;
}

function allFor(board, ticket) { return (board.metadata[KEY] || {})[ticket] || []; }

function withWithdrawal(board, { ticket, id, reason, now }) {
  const all = { ...board.metadata[KEY] };
  const list = allFor(board, ticket);
  const held = list.find((e) => e.id === id && !e.withdrawn_at);
  if (!held) throw new Error(`no active test-policy exception ${id} on ${ticket}`);
  all[ticket] = list.map((e) => (e === held ? { ...e, withdrawn_at: now, withdrawn_reason: reason } : e));
  return all;
}

function exceptionsFor(board, ticket) {
  return (((board && board.metadata && board.metadata[KEY]) || {})[ticket] || []).filter((e) => !e.withdrawn_at);
}

// Why the current change is outside the exception's bound scope, or null.
function expansion(exception, { files, recommended }) {
  const bound = new Set(exception.scope.files);
  const outside = files.filter((f) => !bound.has(f));
  if (outside.length) return `the change expanded beyond the bound scope: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`;
  const known = new Set(exception.scope.recommended);
  const newly = recommended.filter((r) => !known.has(r));
  if (newly.length) return `the new head reaches newly affected consumers: ${newly.slice(0, 5).join(", ")}${newly.length > 5 ? ", ..." : ""}`;
  return null;
}

function reduce(plan, items, policy) {
  const drop = new Set(items);
  const would = plan.selection && plan.selection.would_suites.length ? plan.selection.would_suites : null;
  // The full suite is only ever narrowed to the would-be selection, never to nothing.
  if (drop.has("full-suite") && !would) drop.delete("full-suite");
  if (drop.has("full-suite")) {
    const guarded = new Set(policy.selection.always_required_suites);
    const suites = would;
    plan.checks = plan.checks.filter((c) => c.id !== "full-suite");
    plan.checks.unshift({ id: "selected-suites", kind: "engine-suites", suites: suites.filter((s) => !guarded.has(s)) },
      { id: "always-required-suites", kind: "engine-suites", suites: suites.filter((s) => guarded.has(s)) });
    plan.qualifies = false;
    plan.qualification_note = "human exception: focused PR checks do not qualify the full suite; full qualification remains required at promotion";
  }
  plan.checks = plan.checks.filter((c) => !drop.has(c.target || c.id))
    .map((c) => (c.suites && c.id !== "always-required-suites" ? { ...c, suites: c.suites.filter((s) => !drop.has(s)) } : c));
}

function add(plan, exception) {
  const suites = exception.items.filter((i) => i.endsWith(".test.js"));
  if (suites.length) plan.checks.push({ id: `exception:${exception.id}`, kind: "engine-suites", suites, exception: exception.id });
  for (const spec of exception.items.filter((i) => !i.endsWith(".test.js"))) {
    const [id, ...command] = spec.split("=");
    plan.checks.push({ id: `exception:${id}`, kind: "exception-command", command: command.join("="), exception: exception.id });
  }
}

// Apply the ticket's active exceptions for this stage to a policy plan.
// `filesFor(exception)` is the change as it is now, from the exception's bound
// base, relative to the bound repository; the recommended set is the plan's
// before any exception.
function applyExceptions(plan, exceptions, { filesFor, policy }) {
  const recommended = recommendedSet(plan);
  plan.exceptions = [];
  for (const e of exceptions.filter((x) => x.stage === plan.base_stage)) {
    const lapse = expansion(e, { files: filesFor(e), recommended });
    const entry = { id: e.id, kind: e.kind, items: e.items, reason: e.reason, authority: e.authority,
      scope: { repository: e.scope.repository, commit: e.scope.commit, tree: e.scope.tree, source: e.scope.source || "submission", digest: e.scope.digest || null } };
    if (e.kind === "reduce" && lapse) plan.exceptions.push({ ...entry, status: "lapsed", detail: `${lapse}; selection reverts to policy until re-authorized` });
    else {
      if (e.kind === "reduce") reduce(plan, e.items, policy);
      else add(plan, e);
      plan.exceptions.push({ ...entry, status: e.kind === "add" && lapse ? "kept" : "applied", detail: e.kind === "add" && lapse ? `${lapse}; an addition is kept unless withdrawn` : null });
    }
  }
  const active = plan.exceptions.filter((x) => x.status !== "lapsed");
  const named = active.map((x) => `${x.kind} ${x.id}`);
  plan.execution = active.length ? `policy + exception: ${named.join(", ")}` : "policy";
  return plan;
}

module.exports = { KEY, KINDS, APPROVER, allFor, protectedItems, recommendedSet, exceptionRefusals, newException, withException, withWithdrawal, exceptionsFor, expansion, applyExceptions };
