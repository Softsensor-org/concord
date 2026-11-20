"use strict";

// COORD-936: the runner for a resolved test-policy plan, the shadow
// comparison classification, and `gov test-policy`.
//
//   runPlan      runs every check of the plan FRESH: engine suites through the
//                authoritative runner (coord/scripts/test-runner.js), commands
//                (product, adopter, smoke, verify-engine) through the shell with
//                a hard timeout. History (--history <previous report>) only
//                ORDERS units, failed first and then faster; it never removes a
//                check and never credits a prior pass. A failure is re-run once
//                only to classify it (consistent or flaky); the run still fails.
//                A ratchet-only failure is deterministic and is not re-run.
//                The results are a COORD-910 run manifest whose
//                inputs.gate_config.test_policy names the plan, plus a report with
//                the maturity metrics (scope, fallbacks, feedback time, flaky).
//   classify     the shadow comparison on top of COORD-924's compareFullRun
//                (which records it, with would_gate/would_suites): every failure
//                of a full run, by test identity (suite and title) and reason, is
//                caught, a detection miss (with the dependency-map correction it
//                implies) or environmental; omitted passing suites are skipped work.
// OPERATING MODE: COORD-941 activates the existing resolver in CI. This runner
// writes fresh check manifests; the landing verifier separately accepts only
// eligible COORD-924 selection evidence.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const runManifest = require("./run-manifest.js");
const testPolicy = require("./test-policy.js");
const exceptions = require("./test-policy-exceptions.js");
const schedule = require("./test-policy-schedule.js");
const approvalVerifier = require("./approval-verifier.js");
// COORD-909: product command units run with a copy of the env minus agent/session identity.
// Runner units are coord suites: test-runner.js already scrubs its own children.
const { scrubIdentityEnv } = require("./agent-identity-env.js");
const { readJson } = require("./lifecycle-utils.js");

const REPORT = "test-policy-report.json";
const MANIFEST = "test-policy.manifest.json";
const ENVIRONMENTAL = /\b(?:ETIMEDOUT|ENOSPC|EADDRINUSE|EMFILE|ECONNRESET|ECONNREFUSED|timed out|timeout)\b/i;

// The plan as runnable units: one runner invocation for all engine suites, one
// per command check.
function unitsOf(plan) {
  const units = [];
  const suites = [...new Set(plan.checks.filter((c) => c.suites).flatMap((c) => c.suites))];
  const full = plan.checks.find((c) => c.id === "full-suite");
  if (full) units.push({ id: "full-suite", kind: "runner", files: [], args: full.args || [] });
  else if (plan.checks.some((c) => c.suites)) units.push({ id: "engine-suites", kind: "runner", files: suites, args: [] });
  for (const c of plan.checks.filter((x) => x.command)) units.push({ id: c.target || c.id, kind: "command", command: c.command, cwd: c.cwd || "." });
  for (const c of plan.checks.filter((x) => x.unconfigured)) units.push({ id: c.id, kind: "unconfigured", reason: c.reason });
  return units;
}

// History orders, never selects: previously failed first, then shorter, then plan order.
function orderUnits(units, history = []) {
  const prior = new Map(history.map((r) => [r.id, r]));
  return units.map((u, index) => ({ u, index, h: prior.get(u.id) }))
    .sort((a, b) => Number(b.h?.result === "fail") - Number(a.h?.result === "fail") ||
      (a.h?.duration_ms ?? Infinity) - (b.h?.duration_ms ?? Infinity) || a.index - b.index)
    .map((x) => x.u);
}

function spawnUnit(argv, { cwd, timeoutMs, env, shell = false }) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, shell, stdio: "inherit", timeout: timeoutMs, killSignal: "SIGKILL" });
  const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT");
  return { exit_code: r.status === null ? -1 : r.status, signal: r.signal || null, duration_ms: Date.now() - started, timed_out: timedOut, error: r.error && !timedOut ? r.error.message : null };
}

function runnerUnit(unit, { root, plan, outDir, timeoutMs, env, spawn, tag = "", shards = null, qualificationMode = null }) {
  const report = path.join(outDir, `runner-report${tag}.json`);
  const argv = [process.execPath, path.join(root, "coord", "scripts", "test-runner.js"), ...unit.files.flatMap((f) => ["--file", f]), ...unit.args,
    ...(shards && !tag ? ["--shards", shards, "--qualification-stage", plan.base_stage, "--policy-stage", plan.stage,
      "--qualification-mode", qualificationMode] : []),
    "--report", report, "--manifest", path.join(outDir, `runner${tag}.manifest.json`), ...(plan.base ? ["--base", plan.base] : [])];
  // The adopter's config override is input to the resolver, not to the engine
  // suites: suites under test read the checkout's own configuration.
  const { COORD_PROJECT_CONFIG: _override, ...suiteEnv } = env;
  const lane = spawn(argv, { cwd: root, timeoutMs, env: suiteEnv });
  const r = readJson(report);
  const failing = r ? [...new Set(r.results.flatMap((m) => m.failing_tests))].sort() : [];
  const pass = !lane.timed_out && Boolean(r) && (lane.exit_code === 0 && r.result === "pass" ||
    shards && lane.exit_code === 2 && r.result === "provisional");
  const ratchet = r && r.engine_coverage && r.engine_coverage.ratchet ? r.engine_coverage.ratchet.result : null;
  return { ...lane, pass, failing_tests: failing, report: r ? report : null, totals: r ? r.totals : null, ratchet,
    shards: r && Array.isArray(r.shards) ? r.shards : null };
}

function commandUnit(unit, { root, timeoutMs, env, spawn }) {
  const argv = Array.isArray(unit.command) ? unit.command : [unit.command];
  const lane = spawn(argv, { cwd: path.resolve(root, unit.cwd), timeoutMs, env: scrubIdentityEnv(env), shell: !Array.isArray(unit.command) });
  return { ...lane, pass: !lane.timed_out && lane.exit_code === 0 && !lane.error, failing_tests: [] };
}

// Re-run a failure once only when it can clarify flaky tests or commands. The
// unit's result stays fail; a ratchet-only runner failure is already conclusive.
function classifyFailure(unit, first, ctx, runOne) {
  if (first.pass || unit.kind === "unconfigured" || first.timed_out) return first.timed_out ? "timeout" : null;
  // A failed coverage ratchet is deterministic evidence from the completed
  // full run. Repeating every suite cannot make that qualification pass; keep
  // the failure and avoid paying for a second full run just to label it.
  if (unit.kind === "runner" && first.ratchet === "fail" && first.failing_tests.length === 0) return "consistent";
  const files = unit.kind === "runner" && first.failing_tests.length ? suitesOf(first.failing_tests, ctx.inventory) : null;
  const again = runOne(files && files.length ? { ...unit, files, args: [] } : unit, "-rerun");
  return again.pass ? "flaky" : "consistent";
}

function suitesOf(names, inventory) {
  const { attributeFailures } = require("./affected-landing.js");
  return [...new Set(attributeFailures(names, inventory).flatMap((f) => f.suites))].sort();
}

function testPolicyRecord(plan, order) {
  return { stage: plan.stage, base_stage: plan.base_stage, trigger: plan.trigger, decision: plan.decision, qualifies: plan.qualifies,
    policy_version: plan.policy.policy_version, policy_digest: plan.policy.digest, scopes: plan.scopes.map((s) => s.scope + (s.repo ? `:${s.repo}` : "")),
    checks: plan.checks.map((c) => c.id), order, landing_gates: plan.operating_mode.landing_gates,
    execution: plan.execution || "policy", exceptions: plan.exceptions || [] };
}

function landingSelectionFor(plan) {
  if (!plan.selection || plan.selection.mode !== "selection" || plan.decision !== "selected" || !["developer", "pr"].includes(plan.base_stage)) return null;
  const policySuites = plan.checks.flatMap((c) => c.suites || []);
  return { ...plan.selection, mode: "landing", authorizes_landing: false, fallback_reasons: plan.selection.fallback_details || [],
    required_suites: [...new Set([...(plan.selection.would_suites || []), ...policySuites])].sort(),
    missed_failures: [], wall_time_ms: { full: null, selected: null, saved: null },
    test_policy: { stage: plan.stage, base_stage: plan.base_stage, policy_version: plan.policy.policy_version,
      policy_digest: plan.policy.digest, decision: plan.decision, required_checks: plan.checks.map((c) => c.id) } };
}

function metricsOf(plan, results, wallMs) {
  return {
    execution: plan.execution || "policy",
    selection_scope: plan.selection ? { would_gate: plan.selection.would_gate, selected: plan.selection.selected_count, omitted: plan.selection.omitted_count, tier: plan.selection.tier } : { decision: plan.decision },
    suites_run: [...new Set(plan.checks.filter((c) => c.suites).flatMap((c) => c.suites))].length,
    fallback_reasons: [...plan.reasons, ...(plan.selection ? plan.selection.fallback_reasons : [])],
    feedback_ms: wallMs,
    flaky_failures: results.filter((r) => r.classification === "flaky").map((r) => r.id),
    timeouts: results.filter((r) => r.classification === "timeout").map((r) => r.id),
    promotion_outcome: plan.base_stage === "promotion" ? { stage: plan.stage, result: results.every((r) => r.result === "pass") ? "pass" : "fail" } : null,
  };
}

// guard:test-policy-qualification
// A qualifying run (scheduled full run, promotion, urgent release) of engine
// code passes only with the full suite and a passing coverage ratchet; a
// promotion also only on the exact, committed candidate.
function qualificationRefusals({ root, plan, results, env }) {
  const qualifyingFullRun = plan.qualifies || shardingModeForPlan(plan, unitsOf(plan)) === "full";
  if (!qualifyingFullRun || !plan.scopes.some((s) => s.scope === "engine")) return [];
  const refusals = [];
  const full = results.find((r) => r.id === "full-suite");
  if (!full) refusals.push("the full suite did not run");
  else if (full.ratchet !== "pass") refusals.push(`the coverage ratchet did not pass (${full.ratchet || "not measured"})`);
  if (plan.base_stage === "promotion" && runManifest.collectInputs({ root, env }).inputs.source.dirty) refusals.push("the candidate has uncommitted changes: promotion qualifies only the exact committed candidate");
  return refusals;
}

function shardingModeForPlan(plan, units) {
  const fullSuite = units.find((unit) => unit.id === "full-suite" && unit.kind === "runner" && unit.args.includes("--engine-coverage"));
  if (fullSuite && plan.decision === "full" && ["nightly", "promotion"].includes(plan.base_stage) && plan.qualifies === true) return "full";
  if (fullSuite && plan.decision === "full" && plan.base_stage === "pr") {
    const selection = plan.selection || {};
    if (selection.tier === "T2" || (Array.isArray(selection.fallback_reasons) && selection.fallback_reasons.length > 0) || selection.would_gate === "full") return "full";
  }
  if (fullSuite || !["developer", "pr"].includes(plan.base_stage) || plan.decision !== "selected" || !plan.selection) return null;
  const selectedSuites = units.find((unit) => unit.kind === "runner" && unit.id === "engine-suites");
  if (!selectedSuites?.files?.length || selectedSuites.args?.includes("--engine-coverage")) return null;
  if (!plan.checks.some((item) => item.id === "always-required-suites" && Array.isArray(item.suites))) return null;
  // unitsOf already builds the runner inventory from the same selected and mandatory checks.
  return "selection";
}

function runPlan({ root, plan, policy, outDir, history = [], env = process.env, spawn = spawnUnit, inventory = null, now = () => Date.now(), shards = null, readBoard = () => readJson(path.join(root, "coord", "board", "tasks.json")) }) {
  fs.mkdirSync(outDir, { recursive: true });
  const unrankedUnits = unitsOf(plan);
  let effectiveShards = shards;
  let shardMode = shards ? shardingModeForPlan(plan, unrankedUnits) : null;
  let shardingFallback = null;
  if (shards && (!/^(?:auto|[1-9]\d*)$/.test(shards) || !shardMode)) {
    throw new Error("test-policy --shards requires a complete resolved full gate or an exact resolved selected-suite set");
  }
  const selectedRunner = unrankedUnits.find((unit) => unit.kind === "runner" && unit.id === "engine-suites");
  if (shards === "auto" && shardMode === "selection" && selectedRunner.files.length <= 1) {
    effectiveShards = null;
    shardMode = null;
    shardingFallback = "auto sharding skipped: the resolved selected-plus-mandatory set has only one suite; ran serially because one worker adds no parallelism";
  }
  if (shardMode === "selection" && /^\d+$/.test(String(shards)) && Number(shards) > selectedRunner.files.length) {
    throw new Error(`test-policy --shards ${shards} exceeds the resolved selected-plus-mandatory suite count ${selectedRunner.files.length}`);
  }
  if (effectiveShards) {
    const authority = require("./test-sharding.js").resolveShardAuthority({ contentRoot: path.join(root, "coord"), workspaceRoot: root, donorWrapper: true, board: readBoard() });
    if (!authority.authoritative) throw new Error(`test-policy sharded qualification refused: ${authority.reason}`);
  }
  const initial = runManifest.collectInputs({ root, env, base: plan.base });
  const requestedHead = plan.head ? spawnSync("git", ["rev-parse", `${plan.head}^{commit}`], { cwd: root, encoding: "utf8" }) : null;
  const requestedHeadMismatch = requestedHead && (requestedHead.status !== 0 || requestedHead.stdout.trim() !== initial.inputs.source.commit);
  const identity = (source) => JSON.stringify({ commit: source.commit, tree: source.tree, base: source.base, dirty: source.dirty, dirty_digest: source.dirty_digest });
  const timeoutMs = policy.execution.timeout_seconds * 1000;
  const units = orderUnits(unrankedUnits, history);
  const ctx = { root, plan, outDir, timeoutMs, env, spawn, inventory: inventory || require("./affected-landing.js").readInventory(root) };
  const runOne = (unit, tag = "") => (unit.kind === "runner" ? runnerUnit(unit, { ...ctx, tag, shards: effectiveShards, qualificationMode: shardMode }) : commandUnit(unit, ctx));
  const started = now();
  const results = requestedHeadMismatch ? [] : units.map((unit) => {
    if (unit.kind === "unconfigured") return { id: unit.id, kind: unit.kind, result: "fail", classification: "unconfigured", reason: unit.reason, exit_code: 2, signal: null, duration_ms: 0, failing_tests: [] };
    const first = runOne(unit);
    const classification = classifyFailure(unit, first, ctx, runOne);
    return { id: unit.id, kind: unit.kind, result: first.pass ? "pass" : "fail", classification, exit_code: first.pass ? 0 : first.exit_code || 1, signal: first.signal,
      duration_ms: first.duration_ms, failing_tests: first.failing_tests, totals: first.totals || null, ratchet: first.ratchet === undefined ? null : first.ratchet,
      shards: first.shards || null, ...(unit.kind === "runner" ? { report: first.report } : {}) };
  });
  const finalInputs = runManifest.collectInputs({ root, env, base: plan.base });
  const sourceRefusals = [];
  if (requestedHeadMismatch) {
    sourceRefusals.push(`the requested head ${plan.head} is not the exact checked-out candidate`);
  }
  if (identity(initial.inputs.source) !== identity(finalInputs.inputs.source)) {
    sourceRefusals.push("the source commit, tree or working-tree state changed while checks were running");
  }
  const required = [...qualificationRefusals({ root, plan, results, env }), ...sourceRefusals];
  if (effectiveShards) {
    const liveAuthority = require("./test-sharding.js").resolveShardAuthority({ contentRoot: path.join(root, "coord"), workspaceRoot: root, donorWrapper: true, board: readBoard() });
    if (!liveAuthority.authoritative) required.push(`donor authority changed during sharded execution: ${liveAuthority.reason}`);
  }
  if (required.length) results.push({ id: "qualification-requirements", kind: "requirement", result: "fail", classification: "requirement", reason: required.join("; "), exit_code: 1, signal: null, duration_ms: 0, failing_tests: [] });
  const wallMs = now() - started;
  const record = testPolicyRecord(plan, requestedHeadMismatch ? [] : units.map((u) => u.id));
  const executionPass = results.every((r) => r.result === "pass");
  const report = { kind: "coord-test-policy-report", schema_version: 1, plan, results, metrics: { ...metricsOf(plan, results, wallMs), ...(requestedHeadMismatch ? { suites_run: 0 } : {}) },
    ...(shardingFallback ? { sharding: { requested: shards, mode: "serial-fallback", reason: shardingFallback } } : {}),
    result: executionPass ? (effectiveShards ? "provisional" : "pass") : "fail",
    ...(effectiveShards && executionPass ? { qualification: "provisional; donor receipt required" } : {}) };
  const reportFile = path.join(outDir, REPORT);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const { inputs, host } = runManifest.collectInputs({ root, env, base: plan.base, gateConfig: { test_policy: record, shards: effectiveShards || null } });
  // The receipt binds the tree observed before any command ran. If execution
  // changed it, the requirement lane above makes this manifest fail closed.
  inputs.source = initial.inputs.source;
  const manifest = runManifest.finalizeManifest(runManifest.buildManifest({
    tool: "gov test-policy run", inputs, host, plan: { shards: units.map((u) => ({ lane: u.id, files: u.files || [] })), selection: landingSelectionFor(plan) },
    lanes: results.map((r) => ({ name: r.id, exit_code: r.exit_code, signal: r.signal, duration_ms: r.duration_ms })),
    shards: results.flatMap((r) => r.shards || []),
    qualification: effectiveShards && executionPass ? "provisional" : null,
  }), [reportFile]);
  runManifest.writeManifest(path.join(outDir, MANIFEST), manifest);
  return { report, manifest, reportFile, manifestFile: path.join(outDir, MANIFEST) };
}

// Classify a full run against what selection would have run (COORD-924's
// corrected shadow record). `selected` (optional) is a report of the selected run.
function classifyComparison({ fullReport, line, inventory, selectedReport = null, changedFiles = [] }) {
  const would = line.would_run === "full" ? null : new Set(line.would_run);
  const reproduced = selectedReport ? new Set(selectedReport.results.flatMap((m) => m.failing_tests)) : null;
  const modules = new Map(fullReport.results.flatMap((m) => m.failing_tests.map((t) => [t, m])));
  const { attributeFailures } = require("./affected-landing.js");
  const failures = attributeFailures([...modules.keys()].sort(), inventory).map((f) => {
    const m = modules.get(f.name);
    const env = m.signal || m.exit_code === -1 || ENVIRONMENTAL.test(f.name);
    let kind = "caught";
    if (env) kind = "environmental";
    else if (would && !f.suites.some((s) => would.has(s))) kind = "detection-miss";
    else if (reproduced && !reproduced.has(f.name)) kind = "not-reproduced";
    return { test: f.name, suites: f.suites, module: m.module, reason: m.signal ? `signal ${m.signal}` : `exit ${m.exit_code}`, kind,
      map_correction: kind === "detection-miss" ? { suites: f.suites, changed_files: changedFiles, action: "add the dependency (graph edge, or repoMaps target files) from these files to these suites" } : null };
  });
  const failingSuites = new Set(failures.flatMap((f) => f.suites));
  const skipped = would ? fullReport.inventory.flatMap((m) => m.files).filter((s) => !would.has(s) && !failingSuites.has(s)) : [];
  return { gate: line.gate, state: line.state, would_suites: would ? would.size : "full", failures,
    detection_misses: failures.filter((f) => f.kind === "detection-miss").length, environmental: failures.filter((f) => f.kind === "environmental").length,
    skipped_work: { suites: skipped.length } };
}

// `gov test-policy <show | resolve | run | compare | except>`.
const FLAGS = Object.freeze({ "--stage": "stage", "--base": "base", "--head": "head", "--ticket": "ticket", "--repo": "repo", "--trigger": "trigger",
  "--out": "out", "--history": "history", "--shards": "shards", "--full-report": "fullReport", "--selected-report": "selectedReport", "--inventory": "inventory",
  "--serial-report": "serialReport", "--serial-manifest": "serialManifest", "--sharded-report": "shardedReport", "--sharded-manifest": "shardedManifest",
  "--report": "report", "--manifest": "manifest", "--receipt-out": "receiptOut", "--skip-log-dir": "skipLogDir",
  "--withdraw": "withdraw", "--human-admin-override": "humanAdminOverride", "--last-qualified": "lastQualified",
  "--edge": "edge", "--commit": "commit" });
const REPEATED = Object.freeze({ "--add": "add", "--reduce": "reduce" });

function parseArgs(argv) {
  const options = { json: false, add: [], reduce: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") { options.json = true; continue; }
    if (argv[i] === "--dry-run") { options.dryRun = true; continue; }
    const key = FLAGS[argv[i]] || REPEATED[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`test-policy: unknown or valueless argument ${argv[i]}`);
    if (REPEATED[argv[i]]) options[key].push(argv[++i]);
    else options[key] = argv[++i];
  }
  return options;
}

function repoRootFor(root, config, code) { return code && code !== "X" ? path.resolve(root, config.repos[code].path) : root; }

function gitOne(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// The ticket's reviewed change scope. After submit: its immutable submission
// (plan record review_submission), that head's tree and files. During
// implementation: the working tree, with HEAD, its tree and a digest that
// includes the uncommitted changes. Either way the scope digest binds it.
function boundScope({ root, config, ticket, planRecordsDir, base }) {
  if (!base) throw new Error("test-policy except requires --base <ref> (the base the change is compared with)");
  const record = readJson(path.join(planRecordsDir, `${ticket}.json`));
  const submission = record && record.review_submission && record.review_submission.commit ? record.review_submission : null;
  const repo = testPolicy.repoForTicket(ticket, config);
  const cwd = repoRootFor(root, config, repo);
  const baseCommit = gitOne(cwd, ["rev-parse", `${base}^{commit}`]);
  const source = runManifest.collectInputs({ root: cwd, env: {} }).inputs.source;
  const commit = submission ? submission.commit : source.commit;
  const scope = { repository: submission ? submission.repository : path.basename(cwd), repo, source: submission ? "submission" : "working-tree", commit,
    tree: gitOne(cwd, ["rev-parse", `${commit}^{tree}`]), base: baseCommit, dirty_digest: submission ? null : source.dirty_digest,
    files: testPolicy.changedFiles(cwd, baseCommit, submission ? commit : null) };
  return { ...scope, digest: runManifest.digestOf(scope) };
}

function formatExecution(plan) {
  return [`  execution: ${plan.execution}\n`, ...plan.exceptions.map((e) => `  exception ${e.id} (${e.kind} ${e.items.join(", ")}): ${e.status}${e.detail ? ` - ${e.detail}` : ""}; reason: ${e.reason}; authority: ${e.authority.kind}\n`)].join("");
}

function createTestPolicyCommands({ root, fail, log = (t) => console.log(t.replace(/\n$/, "")), env = process.env, ledgerDir, boardPath, planRecordsDir, run = runPlan, compareFullRun,
  readBoard = () => readJson(boardPath), withBoardTransaction, writeBoard, readJournalEvents = () => [], readIntegrationRecord = () => null,
  resolveHumanAdminOverride, currentHandle, scheduleDecide = schedule.scheduleDecision, appendGovernanceEvent = null, runtimeDir,
  landingGateFor = (o) => require("./affected-landing.js").landingGateFor(o) }) {
  const now = () => new Date().toISOString();
  const load = () => testPolicy.loadTestPolicy({ root, env });
  // COORD-974: the landings and the last passing full run that the full-suite triggers count from.
  const triggerInputsFor = (board) => ({
    landings: Object.entries((board && board.landing_index) || {}).map(([ticket, row]) => ({ ticket, recorded_at: row && row.recorded_at })).filter((l) => l.recorded_at),
    lastQualified: ledgerDir ? schedule.readLastQualified(path.join(ledgerDir, "..", "test-policy")) : null,
  });
  // Selection is automatic: no approval is asked. A ticket's recorded human
  // exceptions are re-evaluated against the change as it is now.
  const resolvePlan = (o) => {
    if (!o.stage) throw new Error("test-policy requires --stage <stage>");
    const { policy, config } = load();
    const plan = testPolicy.resolveStage({ root, stage: o.stage, base: o.base || null, head: o.head || null, ticket: o.ticket || null, repo: o.repo || null, trigger: o.trigger || null, policy, config, landingGateFor,
      triggerInputs: triggerInputsFor(readBoard()) });
    const held = o.ticket ? exceptions.exceptionsFor(readBoard(), o.ticket) : [];
    if (!held.length) return { policy, config, plan: { ...plan, execution: "policy", exceptions: [] } };
    exceptions.applyExceptions(plan, held, { policy, filesFor: (e) => testPolicy.changedFiles(repoRootFor(root, config, e.scope.repo), e.scope.base, o.head || null) });
    return { policy, config, plan };
  };
  const mutate = (ticket, details, change) => withBoardTransaction({ command: "test-policy-exception", ticket, details }, ({ board }) => {
    board.metadata[exceptions.KEY] = change(board);
    writeBoard(board);
    return board.metadata[exceptions.KEY][ticket];
  });
  const authorize = (o, what, state) => {
    if (!o.humanAdminOverride) return null;
    return approvalVerifier.requireSignedOverride({ commandName: `test-policy except (${what})`, ticketId: o.ticket,
      row: state, options: { humanAdminOverride: o.humanAdminOverride },
      deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent, runtimeDir } });
  };
  function except(o) {
    if (!o.ticket) throw new Error("test-policy except requires --ticket <id>");
    if (o.withdraw) {
      const board = readBoard();
      const active = exceptions.allFor(board, o.ticket).find((entry) => entry.id === o.withdraw && !entry.withdrawn_at);
      if (!active) throw new Error(`no active test-policy exception ${o.withdraw} on ${o.ticket}`);
      const override = authorize(o, "withdrawal", { ticket: o.ticket, withdraw: o.withdraw, exception: active });
      if (!override) throw new Error(`withdrawing a test-policy exception requires --human-admin-override "<reason>"`);
      mutate(o.ticket, { withdraw: o.withdraw, reason: override.reason, approval: override.approval }, (board) => exceptions.withWithdrawal(board, { ticket: o.ticket, id: o.withdraw, reason: override.reason, now: now() }));
      log(`test-policy: withdrew ${o.withdraw} on ${o.ticket}\n`);
      return { withdrawn: o.withdraw };
    }
    if (o.add.length && o.reduce.length) throw new Error("an exception is an addition or a reduction, never both: record them separately");
    const recordedBy = currentHandle();
    const kind = o.reduce.length ? "reduce" : "add";
    const items = kind === "reduce" ? o.reduce : o.add;
    const { policy, config } = load();
    const scope = boundScope({ root, config, ticket: o.ticket, planRecordsDir, base: o.base });
    const stage = testPolicy.baseStage(policy, o.stage || "pr");
    const plan = testPolicy.resolveStage({ root, stage, base: scope.base, head: scope.source === "submission" ? scope.commit : null, ticket: o.ticket, policy, config, landingGateFor });
    const refusals = exceptions.exceptionRefusals({ kind, items, policy, plan, stage, override: o.humanAdminOverride ? { reason: o.humanAdminOverride } : null });
    // guard:test-policy-exception-authority
    if (refusals.length) throw new Error(`test-policy refusing the ${kind === "reduce" ? "reduction" : "addition"}: ${refusals.join("; ")}`);
    const existing = exceptions.allFor(readBoard(), o.ticket);
    const override = authorize(o, kind === "reduce" ? "reduction" : "addition", {
      ticket: o.ticket, kind, items, stage, scope, plan, existing_exceptions: existing,
    });
    const n = exceptions.allFor(readBoard(), o.ticket).length + 1;
    const exception = exceptions.newException({ id: `TPX-${o.ticket}-${n}`, ticket: o.ticket, kind, stage, items, reason: override.reason, recordedBy, scope, plan, now: now() });
    mutate(o.ticket, { exception, approval: override.approval }, (board) => exceptions.withException(board, exception));
    log(`test-policy: recorded ${kind} exception ${exception.id} on ${o.ticket} (${items.join(", ")}), bound to the ${scope.source} scope ${scope.commit.slice(0, 12)} tree ${scope.tree.slice(0, 12)} digest ${scope.digest.slice(7, 19)}\n`);
    return exception;
  }
  function compareSharding(o) {
    const required = ["serialReport", "serialManifest", "shardedReport", "shardedManifest"];
    const missing = required.filter((key) => !o[key]);
    if (missing.length) throw new Error(`test-policy compare-sharding requires ${missing.map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(", ")}`);
    if (readIntegrationRecord()?.operation) throw new Error("test-policy compare-sharding must run after the active integration operation closes; defer the journaled comparison through the post-run handoff");
    const shardingGovernance = require("./test-sharding-governance.js");
    let comparison;
    try {
      comparison = shardingGovernance.compareReports({ serialReport: o.serialReport, serialManifest: o.serialManifest,
        shardedReport: o.shardedReport, shardedManifest: o.shardedManifest });
    } catch (error) {
      comparison = { matched: false, mismatches: [{ field: "comparison_evidence", reason: error.message }],
        identity: { commit: null, tree: null, policy_digest: null, edition: null, node_version: null },
        evidence: { error: error.message }, compared: require("./test-sharding-governance.js").REQUIRED_COMPARISONS };
    }
    const at = now();
    const id = shardingGovernance.comparisonId(comparison, at);
    withBoardTransaction({ command: "test-sharding-compare", details: { comparison_id: id, matched: comparison.matched,
      tree: comparison.identity.tree, edition: comparison.identity.edition, node_version: comparison.identity.node_version,
      evidence: comparison.evidence, mismatches: comparison.mismatches } }, ({ board }) => {
      shardingGovernance.updateBoardState(board, comparison, { at, id });
      writeBoard(board);
      return board.metadata[shardingGovernance.KEY];
    });
    const result = { ...comparison, comparison_id: id, recorded_at: at,
      suspension_active: Boolean(readBoard()?.metadata?.[shardingGovernance.KEY]?.suspension?.active) };
    log(`${JSON.stringify(result, null, 2)}\n`);
    if (!comparison.matched) fail(`serial/sharded comparison mismatch recorded and sharding suspended (${id})`);
    return result;
  }

  function verifyShardResult(o) {
    if (o.stage !== "release") throw new Error("verify-shard-result requires --stage release");
    if (!o.report || !o.manifest || !o.receiptOut || !o.skipLogDir) throw new Error("verify-shard-result requires --report, --manifest, --skip-log-dir, and --receipt-out");
    const shardingGovernance = require("./test-sharding-governance.js");
    const chain = require("./journal-chain.js");
    const donorPolicy = readJson(path.join(root, "coord", "engine", "test-policy.json"));
    const events = readJournalEvents();
    const receipt = shardingGovernance.createReceipt({ reportPath: o.report, manifestPath: o.manifest, skipLogDir: o.skipLogDir, board: readBoard(), policy: donorPolicy, journalEvents: events,
      eventDigest: chain.hashGovernanceEventRecord, verifyJournal: (records) => chain.verifyGovernanceChain(records).ok });
    const output = path.resolve(o.receiptOut);
    if ([o.report, o.manifest].some((file) => output === path.resolve(file))) throw new Error("receipt output must be separate from report and manifest artifacts");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, output);
    log(`test-policy: verified sharded release result; receipt=${output} digest=${receipt.receipt_digest}\n`);
    return receipt;
  }

  const handlers = {
    show: (o) => {
      const { policy } = load();
      // guard:test-policy-override
      log(o.json ? `${JSON.stringify(policy, null, 2)}\n` : `test-policy v${policy.policy_version} ${policy.digest}\n  stages: ${testPolicy.BASE_STAGES.join(", ")}; workflow stages: ${Object.entries(policy.stage_aliases).map(([k, v]) => `${k}->${v}`).join(", ")}\n  operating mode: ${policy.operating_mode.pilot}; landing gates ${policy.operating_mode.landing_gates}\n${policy.override_errors.map((e) => `  override refused: ${e}\n`).join("")}`);
      return policy;
    },
    resolve: (o) => {
      const { plan } = resolvePlan(o);
      log(o.json ? `${JSON.stringify(plan, null, 2)}\n` : `${testPolicy.formatPlan(plan)}${formatExecution(plan)}`);
      return plan;
    },
    run: (o) => {
      const { policy, plan } = resolvePlan(o);
      log(`${testPolicy.formatPlan(plan)}${formatExecution(plan)}`);
      const runtimeDir = path.join(ledgerDir, "..", "test-policy");
      if (plan.base_stage === "nightly" && plan.trigger !== "urgent-release") {
        const decision = schedule.recordDecision(runtimeDir, scheduleDecide({ root, policy, last: schedule.readLastQualified(runtimeDir, o.lastQualified || null), head: o.head || "HEAD" }));
        log(`test-policy: scheduled run ${decision.decision}: ${decision.reason}\n`);
        if (decision.decision === "skip") return { result: "skipped", plan, decision, results: [] };
      }
      const prior = o.history ? readJson(o.history) : null;
      const out = path.resolve(o.out || path.join(ledgerDir, "..", "test-policy", `${plan.stage}-${Date.now()}`));
      let { report, manifest, manifestFile } = run({ root, plan, policy, outDir: out, history: (prior && prior.results) || [], env, shards: o.shards || null, readBoard });
      if (o.shards && report.result === "provisional") {
        const full = report.results.find((result) => result.kind === "runner" && result.report);
        const runnerReport = full?.report ? readJson(full.report) : null;
        const runnerManifest = runnerReport?.run_manifest?.path;
        if (!runnerReport || !runnerManifest) throw new Error("sharded policy plan remains provisional: runner report or manifest is missing");
        if (runManifest.validateManifest(manifest).length) throw new Error("sharded policy plan remains provisional: invalid policy run manifest");
        const shardingGovernance = require("./test-sharding-governance.js");
        const chain = require("./journal-chain.js");
        const donorPolicy = readJson(path.join(root, "coord", "engine", "test-policy.json"));
        const events = readJournalEvents();
        const qualificationMode = shardingModeForPlan(plan, unitsOf(plan));
        const receipt = shardingGovernance.createReceipt({ reportPath: full.report, manifestPath: runnerManifest, stage: plan.base_stage, qualificationMode, qualificationPlan: plan,
          board: readBoard(), policy: donorPolicy, journalEvents: events,
          eventDigest: chain.hashGovernanceEventRecord, verifyJournal: (records) => chain.verifyGovernanceChain(records).ok });
        shardingGovernance.verifyReceipt({ receipt, reportPath: full.report, manifestPath: runnerManifest, stage: plan.base_stage, qualificationMode, qualificationPlan: plan,
          board: readBoard(), policy: donorPolicy, journalEvents: readJournalEvents(), eventDigest: chain.hashGovernanceEventRecord,
          verifyJournal: (records) => chain.verifyGovernanceChain(records).ok });
        const receiptFile = path.join(out, "shard-authority-receipt.json");
        const reportFile = path.join(out, REPORT);
        const qualifiedReport = { ...report, result: "pass", qualification: "donor receipt verified",
          authority_receipt: { path: receiptFile, sha256: receipt.receipt_digest },
          metrics: { ...report.metrics, sharding: { mode: qualificationMode, resolved_stage: plan.stage, result: "pass", authority: "donor receipt verified" } } };
        const staging = fs.mkdtempSync(path.join(out, ".shard-qualification-"));
        try {
          const stagedReport = path.join(staging, REPORT);
          const stagedReceipt = path.join(staging, path.basename(receiptFile));
          const stagedManifest = path.join(staging, MANIFEST);
          fs.writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
          fs.writeFileSync(stagedReport, `${JSON.stringify(qualifiedReport, null, 2)}\n`);
          const { qualification: _qualification, ...manifestBase } = manifest;
          const qualifiedManifest = runManifest.finalizeManifest({ ...manifestBase, result: "pass" }, [stagedReport, stagedReceipt]);
          for (const artifact of qualifiedManifest.artifacts) artifact.path = path.join(out, path.basename(artifact.path));
          const errors = runManifest.validateManifest(qualifiedManifest);
          if (errors.length) throw new Error(`donor sharded-plan manifest invalid: ${errors.join("; ")}`);
          runManifest.writeManifest(stagedManifest, qualifiedManifest);
          fs.renameSync(stagedReceipt, receiptFile);
          fs.renameSync(stagedManifest, manifestFile);
          // The passing report is published only after its receipt and manifest exist.
          fs.renameSync(stagedReport, reportFile);
          report = qualifiedReport;
          manifest = qualifiedManifest;
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
      log(`test-policy: ${report.result} in ${report.metrics.feedback_ms}ms; ${report.results.map((r) => `${r.id}=${r.result}${r.classification ? `(${r.classification})` : ""}`).join(" ")}\n  manifest: ${manifestFile}\n`);
      if (report.result === "pass" && plan.qualifies) schedule.writeLastQualified(runtimeDir, { commit: manifest.inputs.source.commit, tree: manifest.inputs.source.tree, stage: plan.stage, at: new Date().toISOString(), manifest: manifestFile });
      return report;
    },
    except,
    compare: (o) => {
      if (!o.fullReport || !o.base) throw new Error("test-policy compare requires --full-report <full runner report> and --base <ref>");
      const fullReport = readJson(o.fullReport);
      if (!fullReport) throw new Error(`test-policy compare: unreadable full report ${o.fullReport}`);
      const landing = require("./affected-landing.js");
      const cmp = compareFullRun || landing.compareFullRun;
      const line = cmp({ root, base: o.base, head: o.head || "HEAD", fullReport, ledgerDir, boardPath, inventoryFile: o.inventory || null });
      const result = classifyComparison({ fullReport, line, inventory: landing.readInventory(root, o.inventory || null), selectedReport: o.selectedReport ? readJson(o.selectedReport) : null,
        changedFiles: testPolicy.changedFiles(root, o.base, o.head || "HEAD") });
      log(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    },
    // COORD-1036 / ADR 0028: the gate manifest `gov promote --gate-manifest` verifies, for one edge at one commit.
    "promotion-manifest": (o) => {
      // COORD-1043: the producer journals each manifest it writes; promote binds the file to that event.
      const result = require("./promote.js").produceGateManifest({ edge: o.edge, commit: o.commit, out: o.out, dryRun: o.dryRun }, { repo: root, appendGovernanceEvent });
      log(`${JSON.stringify(result, null, 2)}\n`);
      if (result.red && result.red.length) throw new Error(`promotion-manifest recorded red gate(s) ${result.red.join(", ")} for ${o.edge}; promote refuses that manifest`);
      return result;
    },
    "compare-sharding": compareSharding,
    "verify-shard-result": verifyShardResult,
  };
  return function testPolicyCommand(sub, argv = []) {
    const handler = handlers[sub];
    if (!handler) return fail(`test-policy requires a subcommand: ${Object.keys(handlers).join(" | ")}.`);
    let result;
    try {
      result = handler(parseArgs(argv));
    } catch (e) {
      return fail(e.message);
    }
    const failed = sub === "run" ? result.results.filter((r) => r.result !== "pass").map((r) => r.id) : [];
    if (failed.length) fail(`test-policy run failed at stage ${result.plan.stage}: ${failed.join(", ")}`);
    return result;
  };
}

module.exports = { REPORT, MANIFEST, unitsOf, orderUnits, spawnUnit, runPlan, classifyComparison, parseArgs, boundScope, formatExecution, landingSelectionFor, createTestPolicyCommands };
