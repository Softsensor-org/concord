"use strict";

// COORD-936 item 9(b): the scheduled full run is CONDITIONAL. When the
// install's existing scheduler invokes `gov test-policy run --stage nightly`,
// this decides run or skip against the last successful full qualification,
// by change significance (risk, unknown impact, shared libraries, affected
// components, maximum age of unqualified changes), never by commit count:
//   skip  the tree is unchanged, or every change is an ordinary document
//         (no pinned file), or the change is below every trigger;
//   run   no previous success, or a configured trigger fired.
// Every decision is recorded with its reason. A full run that passes (with
// the coverage ratchet) becomes the new last-qualified record.

const fs = require("node:fs");
const path = require("node:path");
const { gitOrNull } = require("./git-ops.js");
const testPolicy = require("./test-policy.js");
const { readJson } = require("./lifecycle-utils.js");

const LAST_QUALIFIED = "last-qualified.json";
const DECISIONS = "schedule-decisions.ndjson";

// Hours since the oldest commit in base..head (the oldest unqualified change).
function oldestUnqualifiedHours(root, base, head, nowMs) {
  const times = (gitOrNull(root, ["log", "--format=%ct", `${base}..${head}`]) || "").trim().split("\n").filter(Boolean).map(Number);
  return times.length ? (nowMs - Math.min(...times) * 1000) / 3600000 : 0;
}

function pinnedFiles(root, head) {
  try {
    return new Set(Object.keys(JSON.parse(gitOrNull(root, ["show", `${head}:coord/engine-pin.json`])).files || {}));
  } catch {
    return new Set();
  }
}

// The decision for head against the last qualified record.
function scheduleDecision({ root, policy, last, head = "HEAD", now = Date.now(), landingGateFor = (o) => require("./affected-landing.js").landingGateFor(o) }) {
  const triggers = policy.stages.nightly.triggers;
  const headCommit = gitOrNull(root, ["rev-parse", `${head}^{commit}`])?.trim() ?? null;
  const at = new Date(now).toISOString();
  const decide = (decision, reason, extra = {}) => ({ decision, reason, head: headCommit, last_qualified: last ? last.commit : null, at, ...extra });
  if (!last || !last.commit || !gitOrNull(root, ["rev-parse", "--verify", "-q", `${last.commit}^{commit}`])?.trim()) {
    return triggers.no_previous_success ? decide("run", "no previous successful full run") : decide("skip", "no previous successful full run, and the trigger is off");
  }
  if (gitOrNull(root, ["rev-parse", `${head}^{tree}`])?.trim() === gitOrNull(root, ["rev-parse", `${last.commit}^{tree}`])?.trim()) return decide("skip", "unchanged tree since the last successful full run");
  const files = testPolicy.changedFiles(root, last.commit, head);
  const docs = new RegExp(policy.selection.doc_pattern);
  const pinned = pinnedFiles(root, head);
  if (files.every((f) => docs.test(f) && !pinned.has(f))) return decide("skip", `ordinary docs-only changes (${files.length} file(s))`, { files: files.length });
  const { selection, wouldGate } = landingGateFor({ root, base: last.commit, head, policy: testPolicy.selectionPolicy(policy) });
  const age = oldestUnqualifiedHours(root, last.commit, head, now);
  const facts = { files: files.length, tier: selection.tier, categories: selection.categories, affected_suites: selection.selected.length, oldest_unqualified_hours: Math.round(age * 10) / 10 };
  const fired = [
    [triggers.t2_change && selection.tier === "T2", "t2_change: a high-risk change"],
    [triggers.unknown_impact && wouldGate.gate !== "affected" && selection.tier !== "T2", `unknown_impact: ${wouldGate.reason}`],
    [triggers.shared_helper && selection.categories.includes("shared-helper"), "shared_helper: a shared library changed"],
    [selection.selected.length >= triggers.min_affected_suites, `affected components: ${selection.selected.length} suites reached (trigger ${triggers.min_affected_suites})`],
    [age >= triggers.max_unqualified_hours, `max_unqualified_hours: the oldest unqualified change is ${facts.oldest_unqualified_hours} h old (trigger ${triggers.max_unqualified_hours} h)`],
  ].filter(([hit]) => hit).map(([, why]) => why);
  return fired.length ? decide("run", fired.join("; "), facts) : decide("skip", `below every significance trigger: ${facts.files} file(s), ${facts.affected_suites} suite(s), oldest unqualified change ${facts.oldest_unqualified_hours} h`, facts);
}

function recordDecision(dir, decision) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, DECISIONS), `${JSON.stringify(decision)}\n`);
  return decision;
}

function readLastQualified(dir, file = null) { return readJson(file || path.join(dir, LAST_QUALIFIED)); }

function writeLastQualified(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LAST_QUALIFIED), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

module.exports = { LAST_QUALIFIED, DECISIONS, oldestUnqualifiedHours, scheduleDecision, recordDecision, readLastQualified, writeLastQualified };
