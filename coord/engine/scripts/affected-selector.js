"use strict";

// COORD-924: affected-test selection for a base..head range (ADR 0021).
//
// The selector never authorizes a landing by itself (authorizes_landing is
// always false). COORD-941 activates eligible T0/T1 selected-suite evidence
// through the governed landing verifier; T2, unknown and incomplete changes
// still fall back to the full gate.
// Given the changed paths it selects suites from:
//   - test-file ownership: a changed suite selects itself;
//   - the module graph (affected-graph.js): suites that can reach a changed
//     file through static requires, shim-registry resolution
//     (resolveEngineModule) or mentions, in the head tree and, for deleted
//     and renamed paths, in the base tree;
//   - generated-file rules: the suites that check a generated artifact.
// It falls back to "full gate required", naming each reason, for: unknown or
// dynamic dependencies, incomplete analysis, T2 surfaces (guard registry and
// policy paths), any always_enforced guard's implementation file, and the
// policy's own fallback paths (dependencies, config seams, coverage
// baselines, the selector itself).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const graphLib = require("./affected-graph.js");

const SELECTOR_VERSION = 1;
// COORD-936: the selection policy is the `selection` section of the one test
// policy; the file's policy_version versions it.
const POLICY_PATH = path.join(__dirname, "..", "test-policy.json");
const REGISTRY_REL = "coord/engine/governance-guards.json";
const SHIM_REGISTRY_REL = "coord/engine/shim-registry.json";
const SUITE_ROOTS = Object.freeze(["coord/", "create-concord/", "test/", "release/"]);
const EXCLUDED_SEGMENTS = Object.freeze(["node_modules", ".worktrees", ".runtime", "__fixtures__", "fixtures", "dist", ".next", "coverage", "reports", ".git"]);
const FIXTURE_SEGMENT = /(?:^|\/)(?:__fixtures__|fixtures)\//;
const SELECTOR_FILES = Object.freeze(["affected-graph.js", "affected-selector.js", "affected-shadow.js", "affected-evaluation.js"]);

function loadPolicy(file = POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...policy.selection, policy_version: policy.policy_version };
}

function readJsonAt(root, ref, rel) {
  try {
    if (!ref) return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    const r = spawnSync("git", ["show", `${ref}:${rel}`], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

// Implementation files of T2 and always_enforced guards, from the registry.
function registrySurfaces(registry) {
  const t2 = new Map();
  const always = new Map();
  const { realPath: real } = require("./guard-registry.js");
  for (const guard of (registry && registry.guards) || []) {
    for (const loc of guard.locations || []) {
      if (guard.tier === "T2") t2.set(real(loc.file), guard.id);
      if (guard.always_enforced) always.set(real(loc.file), guard.id);
    }
  }
  const alwaysIds = ((registry && registry.guards) || []).filter((g) => g.always_enforced).map((g) => g.id);
  return { t2, always, alwaysIds };
}

function shimPaths(shimRegistry) {
  const out = new Set();
  for (const shim of (shimRegistry && shimRegistry.shims) || []) {
    out.add(`coord/${shim.path}`);
    out.add(`coord/${shim.target}`);
  }
  return out;
}

function isSuite(rel) {
  return rel.endsWith(".test.js") && SUITE_ROOTS.some((r) => rel.startsWith(r)) &&
    !rel.split("/").slice(0, -1).some((seg) => EXCLUDED_SEGMENTS.includes(seg));
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

// base..head name-status with rename detection; head null = working tree.
function changedPaths(root, base, head) {
  const range = head ? [base, head] : [base];
  const out = git(root, ["diff", "--name-status", "-M", "--no-color", ...range, "--"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [status, a, b] = line.split("\t");
    const code = status[0];
    return code === "R" || code === "C" ? { status: code, old_path: a, path: b } : { status: code, path: a };
  });
}

function matchFallback(policy, rel) {
  return policy.fallback_paths.find((rule) => new RegExp(rule.pattern).test(rel)) || null;
}

function selectorDigest(dir = __dirname) {
  const crypto = require("node:crypto");
  const h = crypto.createHash("sha256");
  for (const name of SELECTOR_FILES) {
    try {
      h.update(name).update(fs.readFileSync(path.join(dir, name)));
    } catch {
      h.update(`${name}:absent`);
    }
  }
  h.update(fs.readFileSync(POLICY_PATH));
  return `sha256:${h.digest("hex")}`;
}

function createContext({ root, base, head, policy, registry, shimRegistry, universe }) {
  const ctx = {
    root, base, head, policy,
    surfaces: registrySurfaces(registry),
    shims: shimPaths(shimRegistry),
    fallback: [], selected: new Map(), categories: new Set(), notes: [],
    graphs: {},
  };
  ctx.graph = (side) => {
    if (!ctx.graphs[side]) ctx.graphs[side] = graphLib.buildGraph({ root, ref: side === "base" ? base : head });
    return ctx.graphs[side];
  };
  ctx.universe = universe;
  return ctx;
}

function addFallback(ctx, code, rel, detail) { ctx.fallback.push({ code, path: rel, detail }); }

function select(ctx, suite, reason) {
  if (ctx.universe && !ctx.universe.has(suite)) return;
  if (!ctx.selected.has(suite)) ctx.selected.set(suite, []);
  const reasons = ctx.selected.get(suite);
  if (!reasons.includes(reason)) reasons.push(reason);
}

// Suites that can reach `rel` in the given tree; dynamic loaders whose
// directory contains `rel` make its dependents unknown.
function graphDependents(ctx, rel, side) {
  const graph = ctx.graph(side);
  if (graph.unreadable.length) addFallback(ctx, "incomplete_analysis", rel, `${graph.unreadable.length} unreadable file(s) in the ${side} tree`);
  for (const site of graph.dynamic.filter((d) => !d.known && !d.computed)) {
    if (rel.startsWith(`${path.posix.dirname(site.file)}/`)) {
      addFallback(ctx, "dynamic_dependency", rel, `unknown dynamic load at ${site.file}:${site.line} (${site.argument})`);
    }
  }
  return [...graphLib.dependentsOf(graph, [rel])].filter(isSuite);
}

// COORD-953 (human-admin decision 2026-11-12): a suite that reaches a dynamic load the graph
// cannot name (any load that is not a config read) may depend on any changed file, so every
// such suite is selected when a change exists. This widens the selection; it does not force
// the full gate. A mention of a loadable file never resolves a computed load.
function selectUnresolvedReachers(ctx, graph) {
  for (const site of graph.dynamic.filter((d) => !d.config)) {
    for (const suite of [...graphLib.dependentsOf(graph, [site.file])].filter(isSuite)) {
      select(ctx, suite, `reaches unresolved dynamic load at ${site.file}:${site.line}`);
    }
  }
}

// COORD-966: a generated file's dependents are the suites that LOAD it (a require or import of
// the file, and the loaders above them). A suite that only names the file in a string does not
// run it; the checker suites the policy names for the file are selected by classifyGenerated.
function generatedLoaderSuites(ctx, rel, side) {
  const graph = ctx.graph(side);
  const starts = [...(graph.reverse.get(rel) || [])].filter((dep) => graph.loadEdges.get(dep).has(rel));
  return [...graphLib.dependentsOf(graph, starts)].filter(isSuite);
}

function classifyRegistry(ctx, rel) {
  const t2 = ctx.surfaces.t2.get(rel);
  if (t2) addFallback(ctx, "t2_surface", rel, `implementation of T2 guard ${t2}`);
  const always = ctx.surfaces.always.get(rel);
  if (always) addFallback(ctx, "always_enforced_guard", rel, `implementation of always_enforced guard ${always}`);
}

function classifyCategories(ctx, rel, change, dependentCount) {
  if (change.status === "R" || change.status === "D") ctx.categories.add("rename-move-delete");
  if (ctx.shims.has(rel) && (change.status === "R" || change.status === "D" || change.status === "A")) ctx.categories.add("shim-registered-move");
  if (FIXTURE_SEGMENT.test(rel)) ctx.categories.add("fixture");
  else if (isSuite(rel)) ctx.categories.add("test-only");
  else if (/\.(?:c|m)?js$/.test(rel)) ctx.categories.add(dependentCount >= ctx.policy.shared_helper_min_dependent_suites ? "shared-helper" : "engine-module");
}

// A generated file selects the suites its rule names; one no rule attributes
// requires the full gate.
function classifyGenerated(ctx, rel, rule) {
  const generated = ctx.policy.generated_files.find((g) => g.path === rel);
  if (generated) {
    ctx.categories.add("generated");
    for (const suite of generated.suites) select(ctx, suite, `checks generated file ${rel}`);
  } else if (!rule && (ctx.policy.generated_patterns || []).some((p) => new RegExp(p).test(rel))) {
    ctx.categories.add("generated");
    addFallback(ctx, "unattributed_generated", rel, "a generated file no rule attributes to the suites that check it");
  }
  return generated;
}

function analysePath(ctx, rel, change, side) {
  const rule = matchFallback(ctx.policy, rel);
  if (rule) {
    addFallback(ctx, rule.reason, rel, `policy fallback path ${rule.pattern}`);
    ctx.categories.add(rule.category);
  }
  classifyRegistry(ctx, rel);
  const generated = classifyGenerated(ctx, rel, rule);
  if (isSuite(rel) && side === "head") select(ctx, rel, "changed suite");
  // On the base side the path itself is gone (deleted or renamed away).
  const reached = graphDependents(ctx, rel, side);
  const dependents = (generated ? generatedLoaderSuites(ctx, rel, side) : reached).filter((suite) => side === "head" || suite !== rel);
  for (const suite of dependents) select(ctx, suite, `reaches ${rel} (${side} graph)`);
  classifyCategories(ctx, rel, change, dependents.length);
  const docs = new RegExp(ctx.policy.doc_pattern).test(rel);
  // A path is accounted for when something covers it; a deleted suite needs nothing.
  return dependents.length > 0 || Boolean(generated || rule || docs) || (isSuite(rel) && side === "base");
}

// A change is unknown when none of its paths is accounted for (a rename is
// covered by the old path's dependents).
function analyseChange(ctx, change) {
  const sides = change.status === "D" ? [[change.path, "base"]] : [[change.path, "head"]];
  if (change.old_path) sides.push([change.old_path, "base"]);
  const covered = sides.map(([rel, side]) => analysePath(ctx, rel, change, side));
  if (!covered.some(Boolean)) {
    addFallback(ctx, "unknown_dependents", change.path, "no suite reaches this file; it may be loaded dynamically or run by a tool");
  }
}

function tierOf(ctx, changes) {
  if (ctx.fallback.some((f) => f.code === "t2_surface")) return "T2";
  const docs = new RegExp(ctx.policy.doc_pattern);
  const low = changes.every((c) => [c.path, c.old_path].filter(Boolean).every((p) => isSuite(p) || FIXTURE_SEGMENT.test(p) || docs.test(p)));
  return low ? "T0" : "T1";
}

function uniqueFallbacks(list) {
  const seen = new Set();
  return list.filter((f) => {
    const key = `${f.code}\0${f.path}\0${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The selection for base..head. `changes` may be supplied (fixtures and
// historical cases); otherwise it is read from git. `universe` restricts
// suites to an inventory (a cut's full-run report).
function selectAffected({ root, base, head = null, changes = null, policy = loadPolicy(), registry, shimRegistry, universe = null }) {
  const reg = registry === undefined ? readJsonAt(root, head, REGISTRY_REL) : registry;
  const shims = shimRegistry === undefined ? readJsonAt(root, head, SHIM_REGISTRY_REL) : shimRegistry;
  const ctx = createContext({ root, base, head, policy, registry: reg, shimRegistry: shims, universe: universe && new Set(universe) });
  let changed = changes;
  try {
    if (!changed) changed = changedPaths(root, base, head);
    if (!reg) addFallback(ctx, "incomplete_analysis", REGISTRY_REL, "guard registry unreadable: T2 and always_enforced surfaces unknown");
    for (const change of changed) analyseChange(ctx, change);
  } catch (e) {
    changed = changed || [];
    addFallback(ctx, "incomplete_analysis", null, e.message);
  }
  let allSuites = universe ? [...new Set(universe)].sort() : [];
  if (!universe) {
    try {
      allSuites = ctx.graph("head").files.filter(isSuite);
    } catch (e) {
      addFallback(ctx, "incomplete_analysis", null, e.message);
    }
  }
  if (changed.length) {
    try {
      selectUnresolvedReachers(ctx, ctx.graph("head"));
      if (ctx.graphs.base) selectUnresolvedReachers(ctx, ctx.graphs.base);
    } catch (e) {
      addFallback(ctx, "incomplete_analysis", null, e.message);
    }
  }
  const fallback = uniqueFallbacks(ctx.fallback);
  const present = new Set(allSuites);
  const selected = [...ctx.selected].filter(([suite]) => present.has(suite)).map(([suite, reasons]) => ({ suite, reasons })).sort((a, b) => a.suite.localeCompare(b.suite));
  const chosen = new Set(selected.map((s) => s.suite));
  const decision = fallback.length ? "full" : "selected";
  // A fallback omits nothing: the full gate runs, and `selected` is kept as
  // what the selection would have been, for the shadow record.
  const omitted = decision === "full" ? [] : allSuites.filter((s) => !chosen.has(s))
    .map((suite) => ({ suite, reason: "no changed file reaches this suite in the head or base graph" }));
  return {
    selector_version: SELECTOR_VERSION,
    selector_digest: selectorDigest(),
    policy_version: policy.policy_version || null,
    mode: "selection",
    authorizes_landing: false,
    base, head,
    changes: changed,
    tier: tierOf(ctx, changed),
    categories: [...ctx.categories].sort(),
    decision,
    fallback_reasons: fallback,
    selected,
    omitted,
    // COORD-974: the suite total, so the radius share is known under a fallback too.
    suites_total: allSuites.length,
    always_required_checks: ctx.surfaces.alwaysIds,
  };
}

module.exports = {
  SELECTOR_VERSION, POLICY_PATH, SUITE_ROOTS, SELECTOR_FILES,
  loadPolicy, registrySurfaces, shimPaths, isSuite, changedPaths, matchFallback, selectorDigest, selectAffected,
};
