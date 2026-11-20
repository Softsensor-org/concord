"use strict";

// COORD-936: the one stage-aware testing policy and its resolver.
//
// coord/engine/test-policy.json ships the engine defaults: the base stages
// (developer, pr, nightly, promotion), the workflow-stage aliases (main,
// staging, beta, production, release), the checks each stage requires per
// scope and, as its `selection` section, the COORD-924 affected-selection
// policy. An adopter tunes it in install configuration, the `testPolicy` block
// of coord/project.config.js (the project-owned seam track-registry.js also
// reads), never in engine code.
//
// resolveStage() is the ONE resolver: `gov test-policy resolve|run`, locally
// and in CI. Scopes keep engine and product qualification apart:
//   engine          engine files in the engine's own repository: the COORD-924
//                   would-be landing gate (selected plus always-required suites),
//                   else the full suite;
//   product         a product repository: its dependency map (affected-targets.js
//                   format) or its testCommand; never the Concord engine suite;
//   engine-upgrade  engine files in an installed workspace: verify-engine against
//                   the pinned release, not the engine suite;
//   workspace       board, prompts and docs of an installed workspace: adopter
//                   checks only.
// OPERATING MODE: COORD-941 activates the existing resolver for fresh developer
// and PR checks. The landing verifier separately accepts only eligible,
// verified selection manifests; this plan alone is not landing evidence.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const runManifest = require("./run-manifest.js");
const targets = require("./affected-targets.js");
const triggers = require("./test-policy-triggers.js");

const POLICY_PATH = path.join(__dirname, "..", "test-policy.json");
const CONFIG_KEY = "testPolicy";
const BASE_STAGES = Object.freeze(["developer", "pr", "nightly", "promotion"]);
const SCOPES = Object.freeze(["engine", "product", "engine-upgrade", "workspace"]);
const TRIGGERS = Object.freeze(["urgent-release"]);
const OVERRIDE_KEYS = Object.freeze(["stageMap", "stages", "repoMaps", "execution"]);
const STAGE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

function loadEngineDefaults(file = POLICY_PATH) { return JSON.parse(fs.readFileSync(file, "utf8")); }

// The raw project config; a missing file is an empty config, a broken one is reported.
function loadProjectConfig(root, env = process.env) {
  const file = env.COORD_PROJECT_CONFIG ? path.resolve(env.COORD_PROJECT_CONFIG) : path.join(root, "coord", "project.config.js");
  if (!fs.existsSync(file)) return { config: {}, file, error: null };
  try {
    delete require.cache[require.resolve(file)];
    return { config: require(file) || {}, file, error: null };
  } catch (e) {
    return { config: {}, file, error: `project config unreadable: ${e.message}` };
  }
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isCommand = (c) => (typeof c === "string" && c.trim().length > 0) || (Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string" && x));

function checkListErrors(where, list, engineIds) {
  if (!Array.isArray(list)) return [`${where} must be a list`];
  return list.flatMap((c, i) => {
    if (!isObject(c) || typeof c.id !== "string" || !c.id || !isCommand(c.command)) return [`${where}[${i}] needs an id and a command`];
    if (engineIds.includes(c.id)) return [`${where}[${i}]: ${c.id} is an engine check and cannot be redefined`];
    if (c.scope !== undefined && !SCOPES.includes(c.scope)) return [`${where}[${i}]: unknown scope ${c.scope}`];
    return [];
  });
}

function stageMapErrors(stageMap) {
  if (!isObject(stageMap)) return ["testPolicy.stageMap must be an object"];
  return Object.entries(stageMap).flatMap(([name, base]) => {
    if (!STAGE_NAME.test(name) || BASE_STAGES.includes(name)) return [`testPolicy.stageMap.${name}: a workflow stage name (lowercase, not a base stage)`];
    return BASE_STAGES.includes(base) ? [] : [`testPolicy.stageMap.${name}: maps to ${base}, not one of ${BASE_STAGES.join(", ")}`];
  });
}

const TRIGGER_FLAGS = Object.freeze(["no_previous_success", "t2_change", "unknown_impact", "shared_helper"]);
const TRIGGER_NUMBERS = Object.freeze(["min_affected_suites", "max_unqualified_hours"]);

function triggerErrors(triggers) {
  if (!isObject(triggers)) return ["testPolicy.stages.nightly.triggers must be an object"];
  return Object.entries(triggers).flatMap(([k, v]) => {
    if (TRIGGER_FLAGS.includes(k)) return typeof v === "boolean" ? [] : [`testPolicy.stages.nightly.triggers.${k} must be true or false`];
    if (TRIGGER_NUMBERS.includes(k)) return Number.isFinite(v) && v >= 0 ? [] : [`testPolicy.stages.nightly.triggers.${k} must be a number >= 0`];
    return [`testPolicy.stages.nightly.triggers.${k}: unknown trigger (${[...TRIGGER_FLAGS, ...TRIGGER_NUMBERS].join(", ")})`];
  });
}

function stageErrors(stages, aliases, engineIds) {
  if (!isObject(stages)) return ["testPolicy.stages must be an object"];
  return Object.entries(stages).flatMap(([name, stage]) => {
    const base = BASE_STAGES.includes(name) ? name : aliases[name];
    if (!base) return [`testPolicy.stages.${name}: unknown stage (map it first with stageMap)`];
    if (!isObject(stage) || Object.keys(stage).some((k) => !["checks", "smoke", "triggers"].includes(k))) return [`testPolicy.stages.${name}: only added checks, smoke and (nightly) triggers are allowed; engine checks cannot be removed or replaced`];
    const errors = stage.checks === undefined ? [] : checkListErrors(`testPolicy.stages.${name}.checks`, stage.checks, engineIds);
    if (stage.triggers !== undefined) errors.push(...(name === "nightly" ? triggerErrors(stage.triggers) : [`testPolicy.stages.${name}.triggers: only the scheduled (nightly) run has triggers`]));
    if (stage.smoke !== undefined) errors.push(...(base === "promotion" ? checkListErrors(`testPolicy.stages.${name}.smoke`, stage.smoke, engineIds) : [`testPolicy.stages.${name}.smoke: smoke checks belong to promotion stages`]));
    return errors;
  });
}

function repoMapErrors(maps, repos) {
  if (!isObject(maps)) return ["testPolicy.repoMaps must be an object"];
  return Object.keys(maps).filter((code) => !isObject(repos) || !repos[code]).map((code) => `testPolicy.repoMaps.${code}: no such repository in repos`);
}

// guard:test-policy-override
function validateOverride(override, defaults, repos = {}) {
  if (override === undefined || override === null) return [];
  if (!isObject(override)) return ["testPolicy must be an object"];
  const engineIds = Object.keys(defaults.checks);
  const errors = Object.keys(override).filter((k) => !OVERRIDE_KEYS.includes(k))
    .map((k) => `testPolicy.${k}: refused (${defaults.adopter_overrides.refused.includes(k) ? "engine-owned" : "unknown key"}; allowed: ${OVERRIDE_KEYS.join(", ")})`);
  const mapErrors = override.stageMap === undefined ? [] : stageMapErrors(override.stageMap);
  errors.push(...mapErrors);
  const aliases = { ...defaults.stage_aliases, ...(mapErrors.length ? {} : override.stageMap || {}) };
  if (override.stages !== undefined) errors.push(...stageErrors(override.stages, aliases, engineIds));
  if (override.repoMaps !== undefined) errors.push(...repoMapErrors(override.repoMaps, repos));
  const ex = override.execution;
  if (ex !== undefined && !(isObject(ex) && Object.keys(ex).every((k) => k === "timeout_seconds") && Number.isInteger(ex.timeout_seconds) && ex.timeout_seconds >= 1 && ex.timeout_seconds <= 86400)) errors.push("testPolicy.execution.timeout_seconds must be an integer 1..86400");
  return errors;
}

// Engine defaults plus a VALID override. An invalid override is not applied;
// its errors are carried in the plan.
function effectivePolicy({ defaults = loadEngineDefaults(), override, repos = {}, configError = null } = {}) {
  const errors = configError ? [configError] : validateOverride(override, defaults, repos);
  const applied = errors.length === 0 && isObject(override) ? override : {};
  const stages = JSON.parse(JSON.stringify(defaults.stages));
  stages.nightly.triggers = { ...stages.nightly.triggers, ...((applied.stages || {}).nightly || {}).triggers };
  const policy = {
    ...defaults,
    stages,
    stage_aliases: { ...defaults.stage_aliases, ...(applied.stageMap || {}) },
    execution: { ...defaults.execution, ...(applied.execution || {}) },
    stage_overrides: applied.stages || {},
    repo_maps: applied.repoMaps || {},
    override_errors: errors,
  };
  policy.engine_digest = runManifest.digestOf(defaults);
  policy.override_digest = runManifest.digestOf(applied);
  policy.digest = runManifest.digestOf({ engine: policy.engine_digest, override: policy.override_digest });
  return policy;
}

function loadTestPolicy({ root, env = process.env, defaults } = {}) {
  const { config, error } = loadProjectConfig(root, env);
  const policy = effectivePolicy({ defaults, override: config[CONFIG_KEY], repos: config.repos, configError: error });
  return { policy, config };
}

function selectionPolicy(policy) { return { ...policy.selection, policy_version: policy.policy_version }; }

function baseStage(policy, stage) {
  const base = BASE_STAGES.includes(stage) ? stage : policy.stage_aliases[stage];
  if (!base) throw new Error(`test-policy: unknown stage ${stage} (${[...BASE_STAGES, ...Object.keys(policy.stage_aliases)].join(", ")})`);
  return base;
}

// A ticket id's repository from the project config's ticket prefixes.
function repoForTicket(ticket, config) {
  const prefix = String(ticket).replace(/-\d+$/, "").toUpperCase();
  if (prefix === String(config.coordTicketPrefix || "COORD").toUpperCase()) return "X";
  const hit = Object.entries(config.repos || {}).find(([, r]) => (r.ticketPrefixes || []).map((p) => String(p).toUpperCase()).includes(prefix));
  return hit ? hit[0] : "X";
}

// Changed paths of base..head (head null: the working tree), relative to cwd.
function changedFiles(cwd, base, head) {
  const args = ["diff", "--name-only", "--no-renames", "--relative", base, ...(head ? [head] : []), "--"];
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

function repoPrefixes(config) {
  return Object.entries(config.repos || {}).map(([code, r]) => ({ code, prefix: `${String(r.path).replace(/\/+$/, "")}/` }))
    .filter((r) => r.prefix !== "./" && r.prefix !== "/" && !path.isAbsolute(r.prefix));
}

// The scopes a change touches. A product ticket is its repository's scope only.
function classifyScopes({ policy, edition, repo, files, config }) {
  if (repo && repo !== "X") {
    if (!(config.repos || {})[repo]) throw new Error(`test-policy: unknown repository ${repo}`);
    return [{ scope: "product", repo, reason: `repository ${repo} (product work)` }];
  }
  const engineRe = policy.engine_paths.map((p) => new RegExp(p));
  const products = repoPrefixes(config);
  const scopes = new Map();
  const add = (key, entry) => { if (!scopes.has(key)) scopes.set(key, entry); };
  for (const file of files) {
    const product = products.find((p) => file.startsWith(p.prefix));
    if (product) add(`product:${product.code}`, { scope: "product", repo: product.code, reason: `changes under ${product.prefix}` });
    else if (edition === "donor") add("engine", { scope: "engine", reason: "engine repository change" });
    else if (engineRe.some((re) => re.test(file))) add("engine-upgrade", { scope: "engine-upgrade", reason: `engine file ${file} changed in an installed workspace` });
    else add("workspace", { scope: "workspace", reason: "coordination-workspace files" });
  }
  const fallback = edition === "donor" ? "engine" : "workspace";
  if (scopes.size === 0) add(fallback, { scope: fallback, reason: "no changed files" });
  return [...scopes.values()];
}

const check = (policy, id, extra) => ({ id, kind: policy.checks[id].kind, ...extra });
const fullSuite = (policy) => check(policy, "full-suite", { args: policy.checks["full-suite"].runner_args });

function selectionSummary(s, wouldGate) {
  return { mode: s.mode, authorizes_landing: false, selector_version: s.selector_version, selector_digest: s.selector_digest,
    policy_version: s.policy_version, base: s.base, head: s.head, changes: s.changes, tier: s.tier, categories: s.categories,
    decision: s.decision, fallback_reasons: [...new Set(s.fallback_reasons.map((f) => f.code))], fallback_details: s.fallback_reasons,
    selected: s.selected, omitted: s.omitted, suites_total: s.suites_total ?? null,
    always_required_checks: s.always_required_checks, would_gate: wouldGate.gate, would_reason: wouldGate.reason,
    would_suites: wouldGate.suites || [], selected_count: s.selected.length, omitted_count: s.omitted.length };
}

// Engine scope: the COORD-924 would-be landing gate, else the full suite when
// it falls back (unknown impact), is T2 (high risk), or the stage or trigger
// asks for full qualification.
// Ordinary documents run the documentation checks.
function docsCheck(policy, root, files) {
  const docs = new RegExp(policy.selection.doc_pattern);
  if (!files.some((f) => docs.test(f))) return [];
  return [check(policy, "docs-checks", { suites: policy.checks["docs-checks"].suites.filter((s) => fs.existsSync(path.join(root, s))) })];
}

// Pinned files are a content-hash dependency of the suites that verify the
// tree against the engine pin; the module graph cannot see it.
function pinnedCheck(policy, root, head, files) {
  const args = head ? ["show", `${head}:coord/engine-pin.json`] : null;
  let pin = {};
  try {
    pin = JSON.parse(args ? spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout : fs.readFileSync(path.join(root, "coord", "engine-pin.json"), "utf8")).files || {};
  } catch {
    pin = {};
  }
  if (!files.some((f) => Object.hasOwn(pin, f))) return [];
  return [check(policy, "pinned-file-checks", { suites: policy.checks["pinned-file-checks"].suites.filter((s) => fs.existsSync(path.join(root, s))) })];
}

function engineChecks({ policy, stageBase, ids, trigger, root, base, head, files, landingGateFor }) {
  if (ids.includes("full-suite")) return { decision: "full", reasons: [trigger ? `trigger ${trigger}: the full qualification` : `${stageBase} runs the full qualification`], checks: [fullSuite(policy)] };
  const fullOn = policy.stages[stageBase].full_on;
  const reasons = [];
  if (!base) return { decision: "full", reasons: [...reasons, "no --base: the blast radius cannot be established"], checks: [fullSuite(policy)] };
  const { selection: s, wouldGate } = landingGateFor({ root, base, head, policy: selectionPolicy(policy) });
  const selection = selectionSummary(s, wouldGate);
  const t2AutomaticFull = s.tier === "T2" && fullOn.includes("t2-change");
  // A T2 change remains an automatic full-gate decision. For a human-admin
  // exception only, expose the selector's counterfactual set when T2 is the
  // sole fallback; uncertainty, policy paths, and suspended categories never
  // become reducible through this field.
  const fallbackCodes = new Set(selection.fallback_reasons);
  const t2CounterfactualSafe = t2AutomaticFull && fallbackCodes.size > 0 &&
    [...fallbackCodes].every((code) => code === "t2_surface" || code === "always_enforced_guard") &&
    s.selected.length > 0;
  if (t2CounterfactualSafe) {
    selection.would_suites = [...new Set([
      ...s.selected.map((item) => item.suite),
      ...policy.selection.always_required_suites,
    ])].sort();
    selection.human_exception_eligible = true;
  } else {
    selection.human_exception_eligible = false;
  }
  if (t2AutomaticFull) reasons.push(`t2-change: ${wouldGate.reason}`);
  else if (wouldGate.gate !== "affected" && fullOn.includes("selection-fallback")) reasons.push(`selection-fallback: ${wouldGate.reason}`);
  if (reasons.length) return { decision: "full", reasons, checks: [fullSuite(policy)], selection };
  // developer keeps fast feedback on a fallback: the reached suites, with the reason noted.
  const suites = wouldGate.gate === "affected" ? wouldGate.suites : [...new Set([...s.selected.map((x) => x.suite), ...policy.selection.always_required_suites])].sort();
  const required = new Set(policy.selection.always_required_suites.filter((x) => suites.includes(x)));
  const out = [check(policy, "selected-suites", { suites: suites.filter((x) => !required.has(x)) }), check(policy, "always-required-suites", { suites: suites.filter((x) => required.has(x)) })];
  if (ids.includes("docs-checks")) out.push(...docsCheck(policy, root, files));
  if (ids.includes("pinned-file-checks")) out.push(...pinnedCheck(policy, root, head, files));
  const notes = wouldGate.gate === "affected" ? [] : [`selection would fall back (${wouldGate.reason}); ${stageBase} keeps the reached suites`];
  return { decision: "selected", reasons: [], checks: out, selection, notes };
}

// Product scope: the repository's dependency map (affected-targets.js format:
// mapped targets plus transitive depends_on consumers) when configured, else
// its testCommand. Full stages, an untrusted map or an empty change run full.
function productChecks({ policy, repo, config, root, base, head, full }) {
  const entry = config.repos[repo];
  const map = policy.repo_maps[repo] || null;
  let selected;
  let reason;
  if (!map) {
    selected = entry.testCommand ? [{ id: `${repo}:test`, command: entry.testCommand }] : [];
    reason = "no dependency map: the repository's testCommand";
  } else {
    // Any map issue (invalid, undated or stale) means the map cannot be trusted.
    const validation = targets.validateAffectedTargetMap(map, { requireUpdatedAt: true, now: new Date().toISOString() });
    const valid = validation.ok && validation.issues.length === 0;
    const files = !full && valid && base ? changedFiles(path.resolve(root, entry.path), base, head) : [];
    const pick = targets.selectAffectedTargets({ files, map, full: full || !valid || files.length === 0 });
    selected = pick.selected.map((t) => ({ id: `${repo}:${t.id}`, command: t.command }));
    reason = full ? "full qualification" : !valid ? "invalid or stale dependency map: full checks" : files.length === 0 ? "no base or no changed files: full checks" : pick.reason;
  }
  if (!selected.length) return [check(policy, "product-tests", { repo, unconfigured: true, reason: `repository ${repo} has no testCommand and no dependency map` })];
  return selected.map((s) => check(policy, "product-tests", { repo, target: s.id, command: s.command, cwd: entry.path, reason }));
}

function addedChecks(policy, stage, scopes) {
  const present = new Set(scopes.map((s) => s.scope));
  const over = policy.stage_overrides[stage] || {};
  const added = (over.checks || []).filter((c) => !c.scope || present.has(c.scope))
    .map((c) => ({ id: c.id, kind: "adopter-command", command: c.command, scope: c.scope || null }));
  return [...added, ...(over.smoke || []).map((c) => ({ id: c.id, kind: "smoke", command: c.command, environment: stage }))];
}

function newPlan({ policy, stage, base, trigger, edition, baseRef, head, ticket }) {
  return {
    kind: "coord-test-policy-plan", schema_version: 1, stage, base_stage: base, trigger, edition, base: baseRef, head, ticket,
    policy: { policy_version: policy.policy_version, digest: policy.digest, engine_digest: policy.engine_digest, override_digest: policy.override_digest, override_errors: policy.override_errors },
    operating_mode: { pilot: policy.operating_mode.pilot, landing_gates: policy.operating_mode.landing_gates },
    scopes: [], decision: null, qualifies: false, reasons: [], checks: [], notes: [], selection: null,
    coverage: policy.stages[base].coverage,
  };
}

// triggerInputs (COORD-974): { landings, lastQualified } for the full-suite triggers reported on the plan.
function resolveStage({ root, stage, base = null, head = null, ticket = null, repo = null, trigger = null, policy, config = {}, edition = runManifest.detectEdition(root),
  landingGateFor, triggerInputs = null }) {
  const stageBase = baseStage(policy, stage);
  if (trigger && !TRIGGERS.includes(trigger)) throw new Error(`test-policy: unknown trigger ${trigger} (${TRIGGERS.join(", ")}; T2 changes and unknown impact are detected)`);
  const plan = newPlan({ policy, stage, base: stageBase, trigger, edition, baseRef: base, head, ticket });
  const repoCode = repo || (ticket ? repoForTicket(ticket, config) : null);
  const files = repoCode && repoCode !== "X" ? [] : base ? changedFiles(root, base, head) : [];
  plan.scopes = classifyScopes({ policy, edition, repo: repoCode, files, config });
  const full = Boolean(policy.stages[stageBase].qualifies) || trigger === "urgent-release";
  plan.qualifies = full;
  const decisions = [];
  for (const s of plan.scopes) {
    let ids = policy.stages[stageBase].checks[s.scope].filter((id) => id !== "smoke");
    if (trigger === "urgent-release" && s.scope === "engine") ids = ["full-suite"];
    if (s.scope === "engine") {
      const e = engineChecks({ policy, stageBase, ids, trigger, root, base, head, files, landingGateFor });
      decisions.push(e.decision);
      plan.reasons.push(...e.reasons);
      plan.notes.push(...(e.notes || []));
      plan.checks.push(...e.checks);
      plan.selection = e.selection || null;
    } else if (s.scope === "product") {
      decisions.push(full ? "full" : "product");
      plan.checks.push(...productChecks({ policy, repo: s.repo, config, root, base, head, full }));
    } else if (s.scope === "engine-upgrade") {
      decisions.push("engine-release-evidence");
      plan.checks.push(check(policy, "engine-release-evidence", { command: policy.checks["engine-release-evidence"].command }));
    } else decisions.push("workspace");
  }
  plan.checks.push(...addedChecks(policy, stageBase, plan.scopes), ...(stage === stageBase ? [] : addedChecks(policy, stage, plan.scopes)));
  if (stageBase === "promotion" && !plan.checks.some((c) => c.kind === "smoke")) plan.notes.push(`no smoke checks configured for ${stage} (testPolicy.stages.${stage}.smoke)`);
  plan.decision = ["full", "selected", "product", "engine-release-evidence", "workspace"].find((d) => decisions.includes(d));
  // COORD-974: reported only; the decision above is not changed by a trigger.
  const sel = plan.selection;
  plan.full_suite_triggers = triggers.evaluateTriggers({ config: policy.full_suite_triggers, landings: triggerInputs?.landings || [],
    lastQualified: triggerInputs?.lastQualified ?? null,
    selection: sel ? { selected_count: sel.selected_count, suites_total: sel.suites_total ?? null, fallback_reasons: sel.fallback_reasons } : null });
  return plan;
}

function formatPlan(plan) {
  const lines = [`test-policy: stage=${plan.stage}${plan.stage === plan.base_stage ? "" : ` (${plan.base_stage})`} decision=${plan.decision} qualifies=${plan.qualifies} policy=v${plan.policy.policy_version} ${plan.policy.digest.slice(0, 19)}`];
  const scopes = plan.scopes.map((s) => s.scope + (s.repo ? `:${s.repo}` : ""));
  lines.push(`  scopes: ${scopes.join(", ")}`);
  if (plan.selection) lines.push(`  selection: tier=${plan.selection.tier} would_gate=${plan.selection.would_gate} selected=${plan.selection.selected_count} omitted=${plan.selection.omitted_count} fallbacks=${plan.selection.fallback_reasons.join(",") || "none"}`);
  for (const r of plan.reasons) lines.push(`  full because: ${r}`);
  if (plan.full_suite_triggers) {
    const t = plan.full_suite_triggers;
    lines.push(`  full-suite triggers: ${t.fired.length ? `fired ${t.fired.join(", ")}` : "none fired"}`);
    for (const r of t.reasons) lines.push(`  trigger ${r}`);
  }
  for (const c of plan.checks) lines.push(`  check ${c.id} (${c.kind})${c.suites ? `: ${c.suites.length} suite(s)` : ""}${c.command ? `: ${[].concat(c.command).join(" ")}` : ""}`);
  // guard:test-policy-override
  for (const e of plan.policy.override_errors) lines.push(`  override refused: ${e}`);
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  lines.push(`  coverage: ${plan.coverage === "advisory" ? "advisory (the whole-suite ratchet is never applied to a partial run)" : "the authoritative coverage ratchet"}`);
  lines.push(`  operating mode: ${plan.operating_mode.pilot} pilot; landing gates ${plan.operating_mode.landing_gates}`);
  return `${lines.join("\n")}\n`;
}

module.exports = {
  POLICY_PATH, CONFIG_KEY, BASE_STAGES, SCOPES,
  loadEngineDefaults, loadProjectConfig, validateOverride, effectivePolicy, loadTestPolicy, selectionPolicy, baseStage,
  repoForTicket, changedFiles, classifyScopes, resolveStage, formatPlan,
};
