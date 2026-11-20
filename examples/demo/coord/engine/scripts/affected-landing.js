"use strict";

// COORD-924/941: risk-based selection at landing and its evidence loop
// (ADR 0021). The governed test policy defaults to active after the explicit
// COORD-941 human-admin ruling; T0/T1 evidence can replace the full gate only
// when the exact selection manifest passes verification. Shadow remains a
// fail-closed rollback state.
//
//   runSelectedForLanding  — runs the selected suites plus the policy's
//                            always-required suites through the authoritative
//                            runner and writes a COORD-910 run manifest whose
//                            plan.selection records the selection (mode "landing").
//   verifyLandingEvidence  — what `gov add-repo-gate --selection-manifest` checks:
//                            a valid passing manifest for the exact tree and base
//                            (check-reuse at landing scope), this policy version
//                            and selector, a T0/T1 selection the landing policy
//                            accepts, and a run that covered every required suite.
//                            T2, fallbacks and suspended categories need the full gate.
//   compareFullRun         — the nightly and release-candidate comparison: given
//                            a full serial gate report of the same tree, what the
//                            selection would have run and whether it would have
//                            caught every failure. `gov selection nightly` journals
//                            the misses into the governed state (affected-state.js),
//                            which suspends their categories; they are listed in the
//                            refinement report.
//   recheckSelectionEntries — finalize, land and closeout re-validate every recorded
//                            selected-suite repo gate against the reviewed head and
//                            base, the policy and the governed state.
// The activation state and suspensions are read from the governed board.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const selector = require("./affected-selector.js");
const shadow = require("./affected-shadow.js");
const runManifest = require("./run-manifest.js");
const governedState = require("./affected-state.js");

const COMPARISONS = "comparisons.ndjson";
const REFINEMENT_REPORT = "refinement-report.md";
const INVENTORY_REL = "release/suite-inventory.json";

function requiredSuites(policy, universe) {
  const present = new Set(universe);
  return (policy.always_required_suites || []).filter((s) => present.has(s));
}

// The landing decision for base..head under the policy and the governed state.
function landingGateFor({ root, base, head = "HEAD", policy = selector.loadPolicy(), boardPath }) {
  const selection = selector.selectAffected({ root, base, head, policy });
  const universe = selection.selected.map((s) => s.suite).concat(selection.omitted.map((o) => o.suite));
  const state = governedState.readSelectionState({ root, boardPath, policy });
  const alwaysRequired = requiredSuites(policy, universe);
  const gate = shadow.landingPolicy({ selection, state, alwaysRequired });
  // In shadow the gate stays full; wouldGate preserves the selected plan for
  // receipts and the evidence loop while rollback is in effect.
  const wouldGate = state.state === "active" ? gate : shadow.landingPolicy({ selection, state: { ...state, state: "active" }, alwaysRequired });
  return { selection, state, gate, wouldGate };
}

function landingRecord(selection, gate) {
  return {
    mode: "landing", authorizes_landing: false,
    selector_version: selection.selector_version, selector_digest: selection.selector_digest, policy_version: selection.policy_version,
    base: selection.base, head: selection.head, tier: selection.tier, categories: selection.categories, decision: selection.decision,
    fallback_reasons: selection.fallback_reasons, selected: selection.selected, omitted: selection.omitted,
    always_required_checks: selection.always_required_checks, required_suites: gate.suites,
    missed_failures: [], wall_time_ms: { full: null, selected: null, saved: null },
  };
}

function runRunner(root, suites, reportPath) {
  const runner = path.join(root, "coord", "scripts", "test-runner.js");
  const started = Date.now();
  const r = spawnSync(process.execPath, [runner, ...suites.flatMap((s) => ["--file", s]), "--report", reportPath], { cwd: root, stdio: "inherit" });
  return { exit_code: r.status === null ? -1 : r.status, signal: r.signal || null, duration_ms: Date.now() - started };
}

function runSelectedForLanding({ root, base, head = "HEAD", outDir, boardPath, policy = selector.loadPolicy(), run = runRunner, env = process.env }) {
  const { selection, gate } = landingGateFor({ root, base, head, policy, boardPath });
  // guard:affected-selection-evidence
  if (gate.gate !== "affected") throw new Error(`refusing a selected-suite run: the full gate is required (${gate.reason})`);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "selected-report.json");
  const lane = run(root, gate.suites, reportPath);
  const { inputs, host } = runManifest.collectInputs({ root, env, base, gateConfig: { selection: true, policy_version: selection.policy_version, selector_digest: selection.selector_digest } });
  const draft = runManifest.buildManifest({
    tool: "affected-selection run-selected", inputs, host,
    plan: { shards: [{ lane: "selected", files: gate.suites }], selection: landingRecord(selection, gate) },
    lanes: [{ name: "selected", ...lane }],
  });
  const file = path.join(outDir, "selection.manifest.json");
  runManifest.writeManifest(file, runManifest.finalizeManifest(draft, [reportPath]));
  return { file, gate, lane };
}

function evidenceRefusals(manifest, policy) {
  const sel = manifest.plan && manifest.plan.selection;
  if (!sel || sel.mode !== "landing") return ["the manifest records no landing selection"];
  const refusals = [];
  if (sel.policy_version !== policy.policy_version || sel.selector_digest !== selector.selectorDigest()) {
    refusals.push(`the selector or its policy changed since the run (policy v${sel.policy_version} -> v${policy.policy_version})`);
  }
  return refusals;
}

function verifyLandingEvidence({ root, manifest, base, head = "HEAD", policy = selector.loadPolicy(), boardPath }) {
  const errors = runManifest.validateManifest(manifest);
  if (errors.length) return { ok: false, refusals: errors.map((e) => `manifest invalid: ${e}`) };
  const refusals = evidenceRefusals(manifest, policy);
  const { inputs, host } = runManifest.collectInputs({ root, base });
  const current = runManifest.buildManifest({ tool: "landing", inputs, host });
  refusals.push(...runManifest.checkEvidenceReuse(manifest, current, { root, scope: "landing" }).refusals);
  const { selection, gate } = landingGateFor({ root, base, head, policy, boardPath });
  refusals.push(...gateRefusals(manifest, gate, { root, base, head, policy }));
  return { ok: refusals.length === 0, refusals, tier: selection.tier, suites: gate.suites || [], input_digest: manifest.input_digest, tree: manifest.inputs.source.tree, base: manifest.inputs.source.base };
}

function policyGateRefusals({ root, manifest, gate, base, head, policy }) {
  if (manifest.tool !== "gov test-policy run") {
    // Before COORD-941's schema-v2 activation, selection manifests from the
    // COORD-924 runner remain useful in legacy fixtures. Under the active
    // stage policy, only the authoritative policy runner can prove mandatory
    // developer/PR checks were run.
    if (Number(policy?.policy_version) >= 2) {
      return ["active stage policy requires a fresh gov test-policy run receipt; legacy run-selected evidence is not accepted"];
    }
    return [];
  }
  const testPolicy = require("./test-policy.js");
  const { policy: effective, config } = testPolicy.loadTestPolicy({ root });
  const record = manifest.inputs.gate_config?.test_policy || {};
  const stage = record.stage;
  if (!["developer", "pr"].includes(record.base_stage)) return ["only a fresh developer or PR policy run can be landing evidence"];
  if (record.exceptions?.length) return ["exception-bearing policy runs require governed ticket-bound exception revalidation before landing evidence can be accepted"];
  const resolved = testPolicy.resolveStage({ root, stage, base, head, policy: effective, config, landingGateFor });
  const refusals = [];
  if (resolved.decision !== "selected" || !resolved.selection || resolved.selection.would_gate !== "affected") {
    refusals.push(...(resolved.reasons.length ? resolved.reasons : ["the current policy requires the full gate"]));
  }
  const expectedChecks = resolved.checks.map((c) => c.id);
  if (record.base_stage !== resolved.base_stage || record.decision !== "selected" || record.policy_version !== effective.policy_version ||
      record.policy_digest !== effective.digest || JSON.stringify(record.checks) !== JSON.stringify(expectedChecks)) {
    refusals.push("the manifest does not match the current developer/PR test-policy checks");
  }
  const selected = manifest.plan.selection;
  if (!selected || selected.mode !== "landing" || selected.policy_version !== effective.policy_version ||
      selected.selector_digest !== selector.selectorDigest() || selected.test_policy?.policy_digest !== effective.digest ||
      JSON.stringify(selected.test_policy?.required_checks) !== JSON.stringify(expectedChecks)) {
    refusals.push("the manifest does not carry the current selected landing policy receipt");
  }
  const required = [...new Set([...(gate.suites || []), ...resolved.checks.flatMap((c) => c.suites || [])])];
  const ran = new Set(manifest.plan.shards.flatMap((s) => s.files));
  const missing = required.filter((suite) => !ran.has(suite));
  if (missing.length) refusals.push(`the policy run did not cover required suites: ${missing.join(", ")}`);
  const lanes = new Map(manifest.lanes.map((lane) => [lane.name, lane]));
  if (manifest.result !== "pass" || manifest.lanes.some((lane) => lane.exit_code !== 0 || lane.signal)) {
    refusals.push("the policy run did not pass every fresh check");
  }
  const expectedCommands = resolved.checks.filter((c) => c.command).map((c) => c.target || c.id);
  const missingCommands = expectedCommands.filter((id) => !lanes.has(id));
  if (missingCommands.length) refusals.push(`the policy run omitted required checks: ${missingCommands.join(", ")}`);
  if (resolved.checks.some((c) => c.suites) && !lanes.has("engine-suites")) refusals.push("the policy run omitted its fresh engine-suite lane");
  return refusals;
}

function gateRefusals(manifest, gate, context = {}) {
  const refusals = [];
  if (gate.gate !== "affected") refusals.push(`the full gate is required: ${gate.reason}`);
  const ran = new Set(manifest.plan.shards.flatMap((s) => s.files));
  const missing = (gate.suites || []).filter((s) => !ran.has(s));
  if (missing.length) refusals.push(`the run did not cover required suites: ${missing.join(", ")}`);
  if (context.root) refusals.push(...policyGateRefusals({ ...context, manifest, gate }));
  return refusals;
}

const ENTRY = /^affected-selection run (\S+) - result=pass tier=\S+ suites=\d+ tree=([0-9a-f]+) base=(\S+) input_digest=(sha256:[0-9a-f]+)$/;

function treeOf(root, commit) {
  const r = spawnSync("git", ["rev-parse", `${commit}^{tree}`], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// One recorded selected-suite repo gate, re-validated at the reviewed head:
// the manifest is the one recorded, check-reuse (landing scope) still holds for
// the head's tree and the recorded base, the policy and selector are unchanged,
// and the governed state still accepts the selection.
function recheckEntry({ root, entry, head, policy, boardPath }) {
  const [, file, tree, base, digest] = ENTRY.exec(entry);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
  } catch {
    return [`the recorded selection manifest ${file} cannot be read`];
  }
  if (manifest.input_digest !== digest || manifest.inputs.source.tree !== tree) return [`the selection manifest ${file} is not the one recorded`];
  const refusals = evidenceRefusals(manifest, policy);
  const current = JSON.parse(JSON.stringify(manifest));
  current.inputs.source = { ...current.inputs.source, commit: head, tree: treeOf(root, head), dirty: false, dirty_digest: null };
  current.input_digest = runManifest.digestOf(current.inputs);
  refusals.push(...runManifest.checkEvidenceReuse(manifest, current, { root, scope: "landing" }).refusals);
  refusals.push(...gateRefusals(manifest, landingGateFor({ root, base, head, policy, boardPath }).gate, { root, base, head, policy }));
  return refusals;
}

// Blockers for finalize, land and closeout: every selected-suite repo gate must
// still hold at the reviewed head. Without a reviewed head (move-review) the
// workspace HEAD is used.
function recheckSelectionEntries({ ticketId, repoGates, root, head = "HEAD", policy = selector.loadPolicy(), boardPath }) {
  const issues = [];
  for (const entry of (repoGates || []).map(String).filter((e) => ENTRY.test(e))) {
    const refusals = recheckEntry({ root, entry, head, policy, boardPath });
    if (!refusals.length) continue;
    issues.push({
      // guard:affected-selection-evidence
      code: "affected_selection_evidence",
      message: `The selected-suite repo gate of ${ticketId} no longer holds at ${head}: ${refusals.join("; ")}. Re-run the gate.`,
      next_steps: [
        "node coord/engine/scripts/affected-evaluation.js run-selected --base <base> --out <dir>, then coord/scripts/gov add-repo-gate --selection-manifest <dir>/selection.manifest.json --base <base>",
        `coord/scripts/gov add-repo-gate ${ticketId} --command "<the full gate>"`,
      ],
    });
  }
  return issues;
}

// guard:affected-selection-evidence
function formatLandingRefusal(verdict) {
  return `add-repo-gate refusing the selected-suite evidence: ${verdict.refusals.join("; ")}`;
}

function repoGateEntry(manifestPath, verdict) {
  return `affected-selection run ${manifestPath} - result=pass tier=${verdict.tier} suites=${verdict.suites.length} tree=${verdict.tree} base=${verdict.base} input_digest=${verdict.input_digest}`;
}

// Failing test names mapped to suites through the release suite inventory:
// a name attributes to every suite with a registered title of that name.
function attributeFailures(names, inventory) {
  const owners = new Map();
  for (const edition of Object.values((inventory && inventory.editions) || {})) {
    for (const [file, paths] of Object.entries(edition.tests || {})) {
      for (const p of paths) for (const title of [p[p.length - 1], p.join(" > ")]) {
        if (!owners.has(title)) owners.set(title, new Set());
        owners.get(title).add(file);
      }
    }
  }
  return names.map((name) => ({ name, suites: [...(owners.get(name) || [])].sort() }));
}

function readInventory(root, file) {
  try {
    return JSON.parse(fs.readFileSync(file || path.join(root, INVENTORY_REL), "utf8"));
  } catch {
    return null;
  }
}

// Nightly / release-candidate comparison against a full serial gate report.
function compareFullRun({ root, base, head = "HEAD", fullReport, ledgerDir, boardPath, inventoryFile = null, policy = selector.loadPolicy(), now = new Date().toISOString() }) {
  const { selection, gate, wouldGate, state } = landingGateFor({ root, base, head, policy, boardPath });
  const would = wouldGate.gate === "affected" ? new Set(wouldGate.suites) : null;
  const failures = attributeFailures(shadow.failingTests(fullReport), readInventory(root, inventoryFile));
  // A failure the inventory cannot attribute counts as missed: selection could not prove it ran.
  const missed = would ? failures.filter((f) => !f.suites.some((s) => would.has(s))).map((f) => f.name) : [];
  const line = {
    at: now, base: selection.base, head: selection.head, tier: selection.tier, categories: selection.categories,
    gate: gate.gate, reason: gate.reason, state: state.state, would_run: would ? [...would] : "full", full_failures: failures.map((f) => f.name),
    missed, policy_version: selection.policy_version, selector_digest: selection.selector_digest, node_version: fullReport.node_version || null,
  };
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.appendFileSync(path.join(ledgerDir, COMPARISONS), `${JSON.stringify(line)}\n`);
  fs.writeFileSync(path.join(ledgerDir, REFINEMENT_REPORT), renderRefinementReport(ledgerDir, policy, now, state));
  return line;
}

function renderRefinementReport(ledgerDir, policy, now, state) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(ledgerDir, COMPARISONS), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    lines = [];
  }
  const misses = lines.filter((l) => l.missed.length);
  const suspended = Object.entries(state.suspended_categories);
  return [
    "# Affected-test selection: refinement report",
    "",
    `Generated ${now}. Policy version ${policy.policy_version}. Comparisons: ${lines.length}; with misses: ${misses.length}.`,
    "",
    "## Suspended categories",
    "",
    ...(suspended.length ? suspended.map(([c, s]) => `- ${c}: ${s.reason} (since ${s.since}, policy v${s.policy_version})`) : ["- none"]),
    "",
    "## Misses to refine",
    "",
    ...(misses.length ? misses.map((m) => `- ${m.at} ${m.head} tier ${m.tier} [${m.categories.join(", ")}]: ${m.missed.join("; ")}`) : ["- none"]),
    "",
    "Misses are recorded in the governed state by `gov selection nightly` (or `gov selection suspend`). Resolve a category with `gov selection resolve --category <c> --investigation <ref>` after raising policy_version with tightened criteria.",
    "",
  ].join("\n");
}

module.exports = {
  COMPARISONS, REFINEMENT_REPORT, requiredSuites, landingGateFor, landingRecord, runRunner, runSelectedForLanding,
  verifyLandingEvidence, recheckSelectionEntries, formatLandingRefusal, repoGateEntry, attributeFailures, readInventory, compareFullRun, renderRefinementReport,
};
