"use strict";

// COORD-936: the one stage-aware test policy and its resolver.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

const tp = require("./test-policy.js");
const realLandingGate = require("./affected-landing.js").landingGateFor;

const DEFAULTS = tp.loadEngineDefaults();
const CONFIG = {
  coordTicketPrefix: "COORD",
  repos: { B: { path: "backend", testCommand: "npm test", ticketPrefixes: ["MSRV"] }, F: { path: "frontend", ticketPrefixes: ["FE"] }, R: { path: "." } },
};
const policyWith = (override, config = CONFIG) => tp.effectivePolicy({ defaults: DEFAULTS, override, repos: config.repos });

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = gitFixtureSpawn(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A repository with a product directory, committed once; returns its root.
function repo(t, files) {
  const root = tmp(t, "coord936-repo-");
  gitFixture(root, ["init", "-q"]);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

const gate = (over = {}) => () => ({
  selection: { tier: "T1", decision: "selected", categories: ["engine-module"], fallback_reasons: [], selected: [{ suite: "coord/a.test.js" }], omitted: [{ suite: "coord/b.test.js" }], ...over.selection },
  wouldGate: { gate: "affected", reason: "complete selection", suites: ["coord/a.test.js", DEFAULTS.selection.always_required_suites[0]], ...over.wouldGate },
});

test("COORD-936: the shipped policy is one file: base stages, workflow aliases, operating mode and the migrated selection section", () => {
  assert.deepEqual([DEFAULTS.schema_version, DEFAULTS.policy_version, DEFAULTS.migrated_from.path], [2, 2, "coord/engine/affected-selection-policy.json"]);
  assert.deepEqual([DEFAULTS.operating_mode.pilot, DEFAULTS.operating_mode.landing_gates], ["runnable-now", "active"]);
  assert.deepEqual(Object.keys(DEFAULTS.stages), tp.BASE_STAGES);
  assert.deepEqual(DEFAULTS.stage_aliases, { staging: "promotion", beta: "promotion", production: "promotion", release: "promotion" }, "no branch maps to the scheduled run by default");
  assert.deepEqual([DEFAULTS.stages.developer.coverage, DEFAULTS.stages.pr.coverage, DEFAULTS.stages.nightly.coverage, DEFAULTS.stages.promotion.coverage], ["advisory", "advisory", "ratchet", "ratchet"]);
  assert.equal(DEFAULTS.stages.nightly.conditional, true, "the scheduled full run is conditional");
  assert.deepEqual(DEFAULTS.stages.promotion.requires, ["clean_candidate", "full_suite", "coverage_ratchet"]);
  assert.equal(DEFAULTS.selection.initial_state, "active", "the human-authorized COORD-941 policy activates eligible selection");
  const selector = require("./affected-selector.js");
  assert.deepEqual(selector.loadPolicy(), { ...DEFAULTS.selection, policy_version: 2 }, "the selector reads the selection section");
  assert.deepEqual(tp.selectionPolicy(policyWith()), selector.loadPolicy());
  for (const stage of ["nightly", "promotion"]) assert.equal(DEFAULTS.stages[stage].checks.engine[0], "full-suite", `${stage} runs the full qualification`);
  for (const stage of ["developer", "pr"]) assert.deepEqual(DEFAULTS.stages[stage].checks.engine, ["selected-suites", "always-required-suites", "docs-checks", "pinned-file-checks"]);
  for (const stage of tp.BASE_STAGES) assert.ok(!DEFAULTS.stages[stage].checks.product.some((id) => DEFAULTS.checks[id].kind === "engine-suites"), `${stage}: product scope never runs an engine suite`);
  // The single engine policy also names donor release checks. The authoritative
  // runner discovers those modules only in the donor; release/ is intentionally
  // removed from both public editions. Installed engine checks remain required.
  const runner = require("./test-runner.js");
  const contentRoot = path.resolve(__dirname, "..", "..");
  const workspaceRoot = path.dirname(contentRoot);
  const donor = runner.isDonorWorkspace(workspaceRoot, contentRoot);
  const donorRoots = Object.values(runner.DONOR_MODULE_ROOTS).flat();
  for (const suite of DEFAULTS.checks["docs-checks"].suites) {
    const donorOnly = donorRoots.some((root) => suite.startsWith(`${root}/`));
    assert.equal(fs.existsSync(path.join(workspaceRoot, suite)), donor || !donorOnly,
      `${suite}: ${donorOnly ? "donor-only check" : "installed engine check"}`);
  }
});

test("COORD-936: adopter overrides are validated; engine-owned keys and replaced engine checks are refused", () => {
  assert.deepEqual(tp.validateOverride(undefined, DEFAULTS), []);
  assert.deepEqual(tp.validateOverride([], DEFAULTS), ["testPolicy must be an object"]);
  const cases = [
    [{ operating_mode: {} }, /operating_mode: refused \(engine-owned/],
    [{ surprise: 1 }, /surprise: refused \(unknown key/],
    [{ stageMap: [] }, /stageMap must be an object/],
    [{ stageMap: { pr: "nightly" } }, /a workflow stage name/],
    [{ stageMap: { qa: "staging" } }, /maps to staging, not one of/],
    [{ stages: [] }, /stages must be an object/],
    [{ stages: { qa: { checks: [] } } }, /unknown stage \(map it first/],
    [{ stages: { pr: { replace: true } } }, /only added checks, smoke and \(nightly\) triggers/],
    [{ stages: { pr: { triggers: {} } } }, /only the scheduled \(nightly\) run has triggers/],
    [{ stages: { nightly: { triggers: [] } } }, /triggers must be an object/],
    [{ stages: { nightly: { triggers: { t2_change: "yes" } } } }, /t2_change must be true or false/],
    [{ stages: { nightly: { triggers: { max_unqualified_hours: -1 } } } }, /max_unqualified_hours must be a number >= 0/],
    [{ stages: { nightly: { triggers: { weekday: 1 } } } }, /weekday: unknown trigger/],
    [{ stages: { pr: { checks: "x" } } }, /checks must be a list/],
    [{ stages: { pr: { checks: [{ id: "x" }] } } }, /needs an id and a command/],
    [{ stages: { pr: { checks: [{ id: "full-suite", command: "true" }] } } }, /is an engine check and cannot be redefined/],
    [{ stages: { pr: { checks: [{ id: "x", command: ["a"], scope: "moon" }] } } }, /unknown scope moon/],
    [{ stages: { pr: { smoke: [{ id: "s", command: "true" }] } } }, /smoke checks belong to promotion stages/],
    [{ repoMaps: [] }, /repoMaps must be an object/],
    [{ repoMaps: { Q: {} } }, /repoMaps.Q: no such repository/],
    [{ execution: { timeout_seconds: 0 } }, /timeout_seconds must be an integer/],
    [{ execution: { timeout_seconds: 5, other: 1 } }, /timeout_seconds must be an integer/],
  ];
  for (const [override, pattern] of cases) assert.match(tp.validateOverride(override, DEFAULTS, CONFIG.repos).join("\n"), pattern, JSON.stringify(override));
  const good = { stageMap: { qa: "promotion" }, stages: { qa: { smoke: [{ id: "qa-ping", command: "true" }] }, pr: { checks: [{ id: "lint", command: "npm run lint", scope: "product" }] } }, execution: { timeout_seconds: 60 } };
  assert.deepEqual(tp.validateOverride(good, DEFAULTS, CONFIG.repos), []);
  const policy = policyWith(good);
  assert.deepEqual([policy.stage_aliases.qa, policy.execution.timeout_seconds, policy.override_errors], ["promotion", 60, []]);
  assert.notEqual(policy.digest, policyWith().digest, "an override changes the effective digest");
  assert.equal(policyWith().engine_digest, policy.engine_digest);
  const refused = policyWith({ stages: { pr: { checks: "x" } } });
  assert.deepEqual([refused.override_errors.length, refused.stage_overrides, refused.digest], [1, {}, policyWith().digest], "an invalid override is not applied");
  assert.deepEqual(tp.effectivePolicy({ configError: "broken" }).override_errors, ["broken"]);
});

test("COORD-936: the override comes from install configuration (coord/project.config.js testPolicy)", (t) => {
  const root = tmp(t, "coord936-config-");
  assert.deepEqual(tp.loadProjectConfig(root, {}).config, {}, "no config file is an empty config");
  fs.mkdirSync(path.join(root, "coord"));
  const file = path.join(root, "coord", "project.config.js");
  fs.writeFileSync(file, "module.exports = { repos: {}, testPolicy: { stageMap: { qa: 'promotion' } } };\n");
  const { policy, config } = tp.loadTestPolicy({ root, env: {} });
  assert.deepEqual([policy.stage_aliases.qa, config.repos], ["promotion", {}]);
  const other = path.join(root, "other.config.js");
  fs.writeFileSync(other, "module.exports = null;\n");
  assert.deepEqual(tp.loadProjectConfig(root, { COORD_PROJECT_CONFIG: other }).config, {});
  fs.writeFileSync(file, "throw new Error('boom');\n");
  assert.match(tp.loadTestPolicy({ root, env: {} }).policy.override_errors[0], /project config unreadable: boom/);
});

test("COORD-936: scopes keep engine and product apart; a product ticket never reaches the engine suite", (t) => {
  const policy = policyWith();
  assert.deepEqual([tp.repoForTicket("COORD-9", CONFIG), tp.repoForTicket("msrv-12", CONFIG), tp.repoForTicket("ZZ-1", CONFIG), tp.repoForTicket("COORD-1", {}), tp.repoForTicket("ZZ-1", {})], ["X", "B", "X", "X", "X"]);
  assert.throws(() => tp.classifyScopes({ policy, config: {}, edition: "donor", repo: "B", files: [] }), /unknown repository B/);
  const scopes = (o) => tp.classifyScopes({ policy, config: CONFIG, ...o }).map((s) => s.scope + (s.repo ? `:${s.repo}` : ""));
  assert.deepEqual(scopes({ edition: "donor", repo: "B", files: ["coord/engine/scripts/x.js"] }), ["product:B"]);
  assert.throws(() => scopes({ edition: "donor", repo: "Q", files: [] }), /unknown repository Q/);
  assert.deepEqual(scopes({ edition: "donor", files: ["coord/engine/scripts/x.js", "backend/a.js", "README.md"] }), ["engine", "product:B"]);
  assert.deepEqual(scopes({ edition: "donor", files: [] }), ["engine"]);
  assert.deepEqual(scopes({ edition: "Community", files: ["coord/engine/scripts/x.js", "coord/board/tasks.json", "frontend/a.js"] }), ["engine-upgrade", "workspace", "product:F"]);
  assert.deepEqual(scopes({ edition: "Enterprise", files: [] }), ["workspace"]);
  const plan = tp.resolveStage({ root: "/r", stage: "pr", ticket: "MSRV-3", policy, config: CONFIG, edition: "donor", landingGateFor: () => assert.fail("a product ticket must not consult the engine selection") });
  assert.deepEqual([plan.decision, plan.checks.map((c) => [c.id, c.command, c.cwd])], ["product", [["product-tests", "npm test", "backend"]]]);
  const upgrade = tp.resolveStage({ landingGateFor: realLandingGate, root: "/r", stage: "pr", repo: "X", policy, config: CONFIG, edition: "Community" });
  assert.deepEqual([upgrade.decision, upgrade.checks], ["workspace", []]);

  const installed = repo(t, { "coord/engine/scripts/x.js": "before\n" });
  fs.writeFileSync(path.join(installed, "coord/engine/scripts/x.js"), "after\n");
  const upgradePlan = tp.resolveStage({ landingGateFor: realLandingGate, root: installed, policy, config: CONFIG, edition: "Community", stage: "pr", base: "HEAD" });
  assert.deepEqual([upgradePlan.decision, upgradePlan.scopes.map((s) => s.scope), upgradePlan.checks.map((c) => [c.id, c.command])],
    ["engine-release-evidence", ["engine-upgrade"], [["engine-release-evidence", ["coord/scripts/gov", "verify-engine"]]]]);
});

test("COORD-936: developer and pr run the would-be selection plus mandatory guards; high risk and unknown impact run full", (t) => {
  const root = repo(t, { "coord/engine/scripts/x.js": "1\n", "docs/a.md": "a\n" });
  fs.writeFileSync(path.join(root, "coord/engine/scripts/x.js"), "2\n");
  const policy = policyWith();
  const resolve = (o) => tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", base: "HEAD", ...o });
  const scoped = tp.resolveStage({ root, policy: policyWith({ stages: { pr: { checks: [{ id: "lint", command: "npm run lint", scope: "product" }, { id: "spell", command: "spell" }] } } }), config: {}, edition: "donor", base: "HEAD", stage: "pr", landingGateFor: gate() });
  assert.deepEqual(scoped.checks.map((c) => c.id).slice(-1), ["spell"], "an added check for another scope is not run");
  const real = tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", base: "HEAD", stage: "pr" });
  assert.equal(real.decision, "full", "the real COORD-924 selector: no guard registry here, so analysis is incomplete and the full suite runs");
  assert.match(real.reasons[0], /selection-fallback: selection fell back: incomplete_analysis/);
  const pr = resolve({ stage: "pr", landingGateFor: gate() });
  assert.deepEqual([pr.decision, pr.qualifies, pr.checks.map((c) => [c.id, c.suites])], ["selected", false, [["selected-suites", ["coord/a.test.js"]], ["always-required-suites", [DEFAULTS.selection.always_required_suites[0]]]]]);
  assert.deepEqual([pr.selection.would_gate, pr.selection.selected_count, pr.selection.omitted_count], ["affected", 1, 1]);
  const t2 = resolve({ stage: "pr", landingGateFor: gate({ selection: { tier: "T2" }, wouldGate: { gate: "full", reason: "T2 changes always run the full relevant gate" } }) });
  assert.deepEqual([t2.decision, t2.reasons, t2.checks.map((c) => c.id)], ["full", ["t2-change: T2 changes always run the full relevant gate"], ["full-suite"]]);
  const knownT2 = resolve({ stage: "pr", landingGateFor: gate({
    selection: { tier: "T2", selected: [{ suite: "coord/a.test.js" }], fallback_reasons: [{ code: "t2_surface" }] },
    wouldGate: { gate: "full", reason: "T2 changes always run the full relevant gate" },
  }) });
  assert.deepEqual([knownT2.decision, knownT2.checks.map((c) => c.id), knownT2.selection.human_exception_eligible, knownT2.selection.would_suites],
    ["full", ["full-suite"], true, [...new Set(["coord/a.test.js", ...policy.selection.always_required_suites])].sort()],
    "T2 remains automatically full while exposing only its complete known counterfactual set for human exception review");
  const uncertainT2 = resolve({ stage: "pr", landingGateFor: gate({
    selection: { tier: "T2", selected: [{ suite: "coord/a.test.js" }], fallback_reasons: [{ code: "t2_surface" }, { code: "incomplete_analysis" }] },
    wouldGate: { gate: "full", reason: "incomplete analysis" },
  }) });
  assert.equal(uncertainT2.selection.human_exception_eligible, false, "an incomplete T2 analysis cannot be reduced");
  const unknown = resolve({ stage: "pr", landingGateFor: gate({ selection: { fallback_reasons: [{ code: "unknown_dependents" }] }, wouldGate: { gate: "full", reason: "selection fell back: unknown_dependents" } }) });
  assert.deepEqual([unknown.decision, unknown.reasons, unknown.selection.fallback_reasons], ["full", ["selection-fallback: selection fell back: unknown_dependents"], ["unknown_dependents"]]);
  const dev = resolve({ stage: "developer", landingGateFor: gate({ wouldGate: { gate: "full", reason: "selection fell back: x", suites: undefined } }) });
  assert.equal(dev.decision, "full", "developer uses the full fallback when impact is unknown");
  assert.deepEqual(dev.checks.map((c) => c.id), ["full-suite"]);
  assert.deepEqual(dev.notes, []);
  // A different versioned engine policy may retain fast developer feedback;
  // this does not change the shipped fallback policy or adopter override rules.
  const fastDeveloperPolicy = { ...policy, stages: { ...policy.stages,
    developer: { ...policy.stages.developer, full_on: [] } } };
  const fallbackFeedback = tp.resolveStage({ landingGateFor: realLandingGate, root, policy: fastDeveloperPolicy, config: {}, edition: "donor",
    base: "HEAD", stage: "developer", landingGateFor: gate({ wouldGate: { gate: "full", reason: "unknown consumer", suites: undefined } }) });
  assert.equal(fallbackFeedback.decision, "selected");
  assert.deepEqual(fallbackFeedback.checks.find((check) => check.id === "selected-suites").suites, ["coord/a.test.js"]);
  assert.deepEqual(fallbackFeedback.checks.find((check) => check.id === "always-required-suites").suites,
    [...new Set(fastDeveloperPolicy.selection.always_required_suites)].sort());
  assert.deepEqual(fallbackFeedback.notes, ["selection would fall back (unknown consumer); developer keeps the reached suites"]);
  assert.equal(fallbackFeedback.qualifies, false);
  const urgent = resolve({ stage: "pr", trigger: "urgent-release", landingGateFor: gate() });
  assert.deepEqual([urgent.decision, urgent.qualifies, urgent.reasons, urgent.checks.map((c) => c.id)], ["full", true, ["trigger urgent-release: the full qualification"], ["full-suite"]]);
  const devUrgent = resolve({ stage: "developer", trigger: "urgent-release", landingGateFor: gate() });
  assert.equal(devUrgent.decision, "full");
  const noBase = tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", stage: "pr" });
  assert.deepEqual([noBase.decision, noBase.reasons], ["full", ["no --base: the blast radius cannot be established"]]);
  assert.throws(() => resolve({ stage: "qa" }), /unknown stage qa/);
  assert.throws(() => resolve({ stage: "pr", trigger: "whim" }), /unknown trigger whim/);
});

test("COORD-936: an ordinary docs change adds the documentation checks; nightly and promotion run the full qualification", (t) => {
  const root = repo(t, { "docs/a.md": "a\n", "coord/scripts/documented-gov-verbs.test.js": "" });
  fs.writeFileSync(path.join(root, "docs/a.md"), "b\n");
  const policy = policyWith({ stages: { production: { smoke: [{ id: "prod-ping", command: "true" }] }, promotion: { checks: [{ id: "deploy-dry-run", command: "true" }] } } });
  const docs = tp.resolveStage({ root, policy, config: {}, edition: "donor", stage: "pr", base: "HEAD", landingGateFor: gate() });
  assert.deepEqual(docs.checks.map((c) => [c.id, c.suites]).at(-1), ["docs-checks", ["coord/scripts/documented-gov-verbs.test.js"]]);
  assert.throws(() => tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", stage: "main" }), /unknown stage main/, "main is not the scheduled run unless an adopter maps it");
  const mapped = policyWith({ stageMap: { main: "nightly" }, stages: { nightly: { triggers: { max_unqualified_hours: 6 } } } });
  assert.equal(mapped.stages.nightly.triggers.max_unqualified_hours, 6);
  assert.equal(mapped.stages.nightly.triggers.t2_change, true, "unset triggers keep the engine defaults");
  const nightly = tp.resolveStage({ landingGateFor: realLandingGate, root, policy: mapped, config: {}, edition: "donor", stage: "main" });
  assert.deepEqual([nightly.base_stage, nightly.decision, nightly.qualifies, nightly.checks.map((c) => c.id)], ["nightly", "full", true, ["full-suite"]]);
  const prod = tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", stage: "production" });
  assert.deepEqual([prod.base_stage, prod.decision, prod.checks.map((c) => [c.id, c.kind])], ["promotion", "full", [["full-suite", "engine-suites"], ["deploy-dry-run", "adopter-command"], ["prod-ping", "smoke"]]]);
  assert.deepEqual(prod.notes, []);
  const staging = tp.resolveStage({ landingGateFor: realLandingGate, root, policy, config: {}, edition: "donor", stage: "staging" });
  assert.deepEqual(staging.notes, ["no smoke checks configured for staging (testPolicy.stages.staging.smoke)"]);
  const text = tp.formatPlan(prod);
  assert.match(text, /stage=production \(promotion\) decision=full qualifies=true/);
  assert.match(text, /check prod-ping \(smoke\): true/);
  assert.match(text, /operating mode: runnable-now pilot; landing gates active/);
  const pr = tp.formatPlan({ ...docs, reasons: ["r"], notes: ["n"], policy: { ...docs.policy, override_errors: ["e"] } });
  for (const line of [/selection: tier=T1 would_gate=affected selected=1 omitted=1 fallbacks=none/, /full because: r/, /check docs-checks \(engine-suites\): 1 suite\(s\)/, /override refused: e/, /note: n/]) assert.match(pr, line);
  assert.match(tp.formatPlan({ ...docs, selection: { ...docs.selection, fallback_reasons: ["x", "y"] } }), /fallbacks=x,y/);
});

test("COORD-936: a product dependency map selects mapped targets and their consumers; an untrusted map or full stage runs everything", (t) => {
  const root = repo(t, { "backend/api/a.js": "1\n", "backend/lib/u.js": "1\n", "backend/docs/x.md": "1\n", "backend/other.js": "1\n" });
  const today = new Date().toISOString().slice(0, 10);
  const map = { updated_at: today, full_gate: { commands: ["npm run test:all"] }, targets: [
    { id: "lib", files: ["lib/"], command: "npm run test:lib" },
    { id: "api", files: ["api/"], command: "npm run test:api", depends_on: ["lib"] },
    { id: "docs", files: ["docs/"], command: "npm run docs:check" },
  ] };
  const config = { repos: { B: { path: "backend", testCommand: "npm test" } } };
  const resolve = (override, o = {}) => tp.resolveStage({ landingGateFor: realLandingGate, root, policy: policyWith(override, config), config, edition: "donor", stage: "pr", repo: "B", base: "HEAD", ...o });
  const ids = (plan) => plan.checks.map((c) => c.command);
  fs.writeFileSync(path.join(root, "backend/lib/u.js"), "2\n");
  assert.deepEqual(ids(resolve({ repoMaps: { B: map } })), ["npm run test:lib", "npm run test:api"], "a shared library selects its mapped consumers");
  git(root, "checkout", "-q", "--", ".");
  fs.writeFileSync(path.join(root, "backend/docs/x.md"), "2\n");
  assert.deepEqual(ids(resolve({ repoMaps: { B: map } })), ["npm run docs:check"], "mapped docs select only their doc checks");
  fs.writeFileSync(path.join(root, "backend/other.js"), "2\n");
  const unknown = resolve({ repoMaps: { B: map } });
  assert.deepEqual([ids(unknown), unknown.checks[0].reason], [["npm run test:all"], "unknown changed file(s): other.js"]);
  git(root, "checkout", "-q", "--", ".");
  assert.match(resolve({ repoMaps: { B: map } }).checks[0].reason, /no base or no changed files: full checks/);
  assert.match(resolve({ repoMaps: { B: { ...map, updated_at: "2020-01-01" } } }).checks[0].reason, /invalid or stale dependency map/);
  assert.match(resolve({ repoMaps: { B: map } }, { stage: "nightly" }).checks[0].reason, /full qualification/);
  assert.deepEqual([resolve({}).checks[0].command, resolve({}).checks[0].reason], ["npm test", "no dependency map: the repository's testCommand"]);
  const bare = { repos: { B: { path: "backend" } } };
  const none = tp.resolveStage({ landingGateFor: realLandingGate, root, policy: policyWith(undefined, bare), config: bare, edition: "donor", stage: "pr", repo: "B" });
  assert.deepEqual([none.checks[0].unconfigured, none.checks[0].reason], [true, "repository B has no testCommand and no dependency map"]);
  assert.deepEqual(tp.changedFiles(path.join(root, "backend"), "HEAD", null), []);
  assert.throws(() => tp.changedFiles(root, "no-such-ref", null), /git diff/);
  const missingRoot = path.join(os.tmpdir(), `coord936-no-root-${process.pid}`);
  assert.throws(() => tp.changedFiles(missingRoot, "HEAD", null), /git diff --name-only --no-renames --relative HEAD --:\s*$/,
    "an OS-level git launch error has no stderr, so the diagnostic's empty-stderr fallback is covered");
});

test("COORD-936: a pinned file selects the suites that verify the tree against the engine pin (a correction from a recorded miss)", (t) => {
  const pin = { files: { "coord/engine/scripts/x.js": { sha256: "a" } } };
  const root = repo(t, { "coord/engine/scripts/x.js": "1\n", "coord/engine/scripts/y.js": "1\n", "coord/engine-pin.json": JSON.stringify(pin), "coord/engine/scripts/closeout.test.js": "" });
  const policy = policyWith();
  const ids = (plan) => plan.checks.map((c) => [c.id, c.suites]);
  const resolve = (o) => tp.resolveStage({ root, policy, config: {}, edition: "donor", stage: "pr", landingGateFor: gate(), ...o });
  fs.writeFileSync(path.join(root, "coord/engine/scripts/x.js"), "2\n");
  assert.deepEqual(ids(resolve({ base: "HEAD" })).at(-1), ["pinned-file-checks", ["coord/engine/scripts/closeout.test.js"]], "the working-tree pin lists the changed file");
  git(root, "commit", "-qam", "pinned edit");
  assert.deepEqual(ids(resolve({ base: "HEAD~1", head: "HEAD" })).at(-1), ["pinned-file-checks", ["coord/engine/scripts/closeout.test.js"]], "a head ref reads the pin at that ref");
  fs.writeFileSync(path.join(root, "coord/engine/scripts/y.js"), "2\n");
  assert.ok(!ids(resolve({ base: "HEAD" })).some(([id]) => id === "pinned-file-checks"), "an unpinned file selects nothing extra");
  fs.writeFileSync(path.join(root, "coord/engine-pin.json"), "{not json");
  fs.writeFileSync(path.join(root, "coord/engine/scripts/x.js"), "3\n");
  assert.ok(!ids(resolve({ base: "HEAD" })).some(([id]) => id === "pinned-file-checks"), "an unreadable pin adds nothing; the pin's own suites are selected through its generated-file rule");
  fs.writeFileSync(path.join(root, "coord/engine-pin.json"), "{}");
  assert.ok(!ids(resolve({ base: "HEAD" })).some(([id]) => id === "pinned-file-checks"), "a pin without files pins nothing");
});

// COORD-974 (ADR 0025): resolve reports the full-suite triggers; the decision is unchanged by them.
const suiteList = (n) => Array.from({ length: n }, (_, i) => ({ suite: `coord/s${i}.test.js` }));
const landedAt = (n) => Array.from({ length: n }, (_, i) => ({ ticket: `COORD-${i}`, recorded_at: `2026-11-16T${String(i % 24).padStart(2, "0")}:00:00.000Z` }));
const lastRun = { at: "2026-11-15T00:00:00.000Z" };

test("COORD-974: resolve names the counter, radius and unknown triggers that fired and why; the plan decision is unchanged", (t) => {
  const root = repo(t, { "coord/engine/scripts/x.js": "1\n" });
  fs.writeFileSync(path.join(root, "coord/engine/scripts/x.js"), "2\n");
  const policy = policyWith();
  const run = (selection, wouldGate, triggerInputs) => tp.resolveStage({ root, policy, config: {}, edition: "donor", base: "HEAD", stage: "pr",
    landingGateFor: gate({ selection, wouldGate }), triggerInputs });
  const quietSel = { selected: suiteList(260), omitted: suiteList(129), suites_total: 389 };
  const base = run(quietSel, {}, null);
  const quiet = run(quietSel, {}, { landings: landedAt(9), lastQualified: lastRun });
  assert.deepEqual([quiet.full_suite_triggers.fired, quiet.decision], [[], base.decision], "9 landed, 66.8 percent: nothing fires");
  const counter = run(quietSel, {}, { landings: landedAt(10), lastQualified: lastRun });
  assert.deepEqual([counter.full_suite_triggers.fired, counter.full_suite_triggers.primary, counter.decision], [["counter"], "counter", base.decision]);
  assert.match(counter.full_suite_triggers.reasons[0], /counter: 10 tickets landed on dev since the last full run .*threshold of 10 is reached/);
  const radius = run({ selected: suiteList(701), omitted: suiteList(299), suites_total: 1000 }, {}, { landings: landedAt(1), lastQualified: lastRun });
  assert.deepEqual([radius.full_suite_triggers.fired, radius.decision], [["radius"], "selected"], "70.1 percent fires the radius trigger, and the decision stays selected");
  assert.match(radius.full_suite_triggers.reasons[0], /radius: 701 of 1000 suites \(70.1%\) are affected, above the 70% radius threshold/);
  const unknown = run({ selected: suiteList(3), omitted: suiteList(7), suites_total: 10, fallback_reasons: [{ code: "dynamic_dependency", path: "x", detail: "d" }] },
    { gate: "full", reason: "unknown dynamic dependency" }, { landings: landedAt(1), lastQualified: lastRun });
  assert.deepEqual([unknown.full_suite_triggers.fired, unknown.decision], [["unknown"], "full"]);
  assert.match(unknown.full_suite_triggers.reasons[0], /unknown: the selector cannot establish the impact \(dynamic_dependency\)/);
  const t2 = run({ selected: suiteList(3), omitted: suiteList(7), suites_total: 10, fallback_reasons: [{ code: "t2_surface" }] }, { gate: "full", reason: "T2" }, { landings: landedAt(1), lastQualified: lastRun });
  assert.deepEqual(t2.full_suite_triggers.fired, [], "a T2 surface is not an unknown-impact trigger");
});

test("COORD-974: the trigger line is printed by resolve; stages that run the full qualification report the radius as not evaluated", (t) => {
  const root = repo(t, { "coord/engine/scripts/x.js": "1\n" });
  fs.writeFileSync(path.join(root, "coord/engine/scripts/x.js"), "2\n");
  const policy = policyWith();
  const plan = tp.resolveStage({ root, policy, config: {}, edition: "donor", base: "HEAD", stage: "pr",
    landingGateFor: gate({ selection: { selected: suiteList(701), omitted: suiteList(299), suites_total: 1000 } }), triggerInputs: { landings: landedAt(10), lastQualified: lastRun } });
  const text = tp.formatPlan(plan);
  assert.match(text, /  full-suite triggers: fired counter, radius/);
  assert.match(text, /  trigger counter: 10 tickets landed on dev since the last full run/);
  const nightly = tp.resolveStage({ root, policy, config: {}, edition: "donor", base: "HEAD", stage: "nightly", landingGateFor: gate(), triggerInputs: { landings: [], lastQualified: lastRun } });
  assert.equal(nightly.full_suite_triggers.radius.measurable, false);
  assert.match(tp.formatPlan(nightly), /  full-suite triggers: none fired/);
});
