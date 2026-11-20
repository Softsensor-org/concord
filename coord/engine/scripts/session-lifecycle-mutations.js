#!/usr/bin/env node
'use strict';
// COORD-712: explicit mutation run over the session-lifecycle proofs. Mutants
// live only in temporary copies; a syntax error never counts as a kill.
// COORD-852: the fixture now carries the engine tree, every anchor must match
// exactly once, every target is first run unmutated as a control, and
// `--check-anchors` is the fast form the ordinary suite runs so the list cannot
// rot silently again (session-lifecycle-mutations.test.js).
//   node coord/engine/scripts/session-lifecycle-mutations.js [--check-anchors] [--keep]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { wrap } = require('node:module');
const { installCanonicalEngine } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js"));

const SOURCE = path.resolve(__dirname, '..', '..');
const COPIED = ['scripts', 'engine', 'board', 'paths.js', 'project.config.js', 'GOVERNANCE.md', 'AGENTS.md', 'product', 'prompts',
  'schemas', 'docs', 'agents.json', 'gates', 'TEMPLATE_SYNC_MANIFEST.json', 'engine-pin.json'];
// Each target carries its own child env. The burn-in runs at its own defaults
// (N=12, 4 in flight): at N=3/3 a lock-free run raced visibly only ~3 of 4 times,
// at 12/4 it was killed 20 of 20 (COORD-852 review).
const BURNIN = { test: 'scripts/concurrent-burnin.test.js', pattern: 'COORD-224: N concurrent',
  env: { COORD_BURNIN_N: '12', COORD_BURNIN_CONCURRENCY: '4' } };
const WORKER = { worker: 'engine/scripts/session-lifecycle-worker.js' };
const PLAN = { test: 'board/board.test.js', pattern: 'COORD-687 integration:' };

function replaceOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Mutation anchor must match exactly once (found ${count}): ${anchor}`);
  return source.replace(anchor, () => replacement);
}
function duplicateSucceededJournalAppend(source) {
  const start = source.lastIndexOf('          appendGovernanceEvent({');
  const end = '\n          });';
  const stop = start < 0 ? -1 : source.indexOf(end, start);
  if (stop < 0) throw new Error('Journal success append missing');
  const call = source.slice(start, stop + end.length);
  if (!call.includes('result: "succeeded"')) throw new Error('Wrong journal mutation join');
  return source.slice(0, stop + end.length) + '\n' + call + source.slice(stop + end.length);
}
const MUTANTS = Object.freeze([
  { name: 'runtime-lock', file: 'engine/scripts/governance-context.js', target: BURNIN,
    change: s => replaceOnce(s, 'function withGovernanceRuntimeLock(fn) {', 'function withGovernanceRuntimeLock(fn) { return fn();') },
  { name: 'distinct-native-identity', file: 'engine/scripts/governance-session.js', target: WORKER,
    change: s => replaceOnce(s, 'function currentRuntimeThreadId() {', 'function currentRuntimeThreadId() { return "collapsed-native-thread";') },
  { name: 'transfer-authority', file: 'engine/scripts/agent-commands.js', target: WORKER,
    change: s => replaceOnce(s, 'if (explicitReason) {', 'if (true) {') },
  { name: 'repair-authority', file: 'engine/scripts/governance-session.js', target: WORKER,
    change: s => replaceOnce(s, 'if (identity.agent.handle !== expectedOwner) {\n    if (!String(options.humanAdminOverride || "").trim()) {',
      'if (false && identity.agent.handle !== expectedOwner) {\n    if (!String(options.humanAdminOverride || "").trim()) {') },
  { name: 'whole-plan-rendering', file: 'board/board.js', target: PLAN,
    change: s => replaceOnce(s, 'renderPlanMarkdown(board, planRecordsForRender(board))', 'renderPlanMarkdown(board, new Map([...planRecordsForRender(board)].slice(0, 1)))') },
  { name: 'exactly-once-journal', file: 'engine/scripts/journal.js', target: BURNIN, change: duplicateSucceededJournalAppend },
]);

// Throws a SyntaxError for a mutant that does not compile as a CommonJS module
// (Node's loader accepts a leading hashbang line; the wrapped script would not).
function compile(source, filename) { new vm.Script(wrap(source.replace(/^#!.*/, '')), { filename }); }
function mutate(sourceRoot, mutant) {
  const file = path.join(sourceRoot, mutant.file), original = fs.readFileSync(file, 'utf8');
  const mutated = mutant.change(original);
  if (mutated === original) throw new Error(`Mutant ${mutant.name} leaves ${mutant.file} unchanged`);
  compile(mutated, file);
  return { file, original, mutated };
}
function checkAnchors(sourceRoot = SOURCE, mutants = MUTANTS) {
  return mutants.map(m => { mutate(sourceRoot, m); return { mutation: m.name, file: m.file, anchor: 'ok' }; });
}
function prepareCopy(root, sourceRoot = SOURCE) {
  const copy = path.join(root, 'coord');
  installCanonicalEngine(copy, sourceRoot);
  for (const name of COPIED) {
    const from = path.join(sourceRoot, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(copy, name), { recursive: true });
  }
  return copy;
}
function childEnv(root, inherited = process.env, targetEnv = {}) {
  // Child fixtures (worker sandboxes, test temp dirs) stay inside the run root.
  // An inherited COORD_BURNIN_* never weakens a target's own parameters.
  const env = { ...inherited };
  for (const k of Object.keys(env)) if (/THREAD_ID|SESSION_ID|NODE_TEST_CONTEXT|NODE_CHANNEL_FD|NODE_V8_COVERAGE|^COORD_BURNIN_/.test(k)) delete env[k];
  return { ...env, ...targetEnv, TMPDIR: path.join(root, 'tmp') };
}
function targetArgs(copy, target) {
  return target.worker ? [path.join(copy, target.worker), '1']
    : ['--test', `--test-name-pattern=${target.pattern}`, path.join(copy, target.test)];
}
function targetKey(target) { return target.worker || `${target.test}#${target.pattern}`; }
// A kill is an assertion failure inside a run that finished on its own.
function classify(r) {
  const output = (r.stdout || '') + (r.stderr || '');
  return { output, passed: r.status === 0 && !r.error,
    killed: Number.isInteger(r.status) && r.status !== 0 && r.signal == null && !r.error && /AssertionError|ERR_ASSERTION/.test(output) };
}
function runMutants({ sourceRoot = SOURCE, mutants = MUTANTS, keep = false, spawn = spawnSync, log = console.log,
  targetTimeoutMs = 180000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord712-mutations-'));
  const copy = prepareCopy(root, sourceRoot);
  const run = (name, target) => {
    const env = childEnv(root, process.env, target.env);
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    const r = spawn(process.execPath, targetArgs(copy, target), { cwd: root, env, encoding: 'utf8', timeout: targetTimeoutMs, maxBuffer: 16 * 1024 * 1024 });
    const verdict = classify(r), logPath = path.join(root, `${name}.log`);
    fs.writeFileSync(logPath, verdict.output);
    fs.rmSync(env.TMPDIR, { recursive: true, force: true });
    return { ...verdict, exit: r.status, log: logPath };
  };
  const controls = [], results = [];
  for (const target of [...new Map(mutants.map(m => [targetKey(m.target), m.target])).values()]) {
    const r = run(`control-${controls.length + 1}`, target);
    controls.push({ control: targetKey(target), passed: r.passed, exit: r.exit, log: r.log });
    log(JSON.stringify(controls.at(-1)));
  }
  const controlsPassed = controls.every(c => c.passed);
  for (const m of controlsPassed ? mutants : []) {
    const { file, original, mutated } = mutate(copy, m);
    fs.writeFileSync(file, mutated);
    try {
      const r = run(m.name, m.target);
      results.push({ mutation: m.name, target: targetKey(m.target), killed: r.killed, exit: r.exit, log: r.log });
      log(JSON.stringify(results.at(-1)));
    } finally { fs.writeFileSync(file, original); }
  }
  const ok = controlsPassed && results.length === mutants.length && results.every(r => r.killed);
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ node: process.version, controls, results }, null, 2) + '\n');
  const retained = keep || !ok;
  if (retained) log(`Mutation evidence retained: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  return { ok, root, retained, controls, results };
}
function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || console.log, unknown = argv.filter(a => a !== '--check-anchors' && a !== '--keep');
  if (unknown.length) { log(`Unknown argument(s): ${unknown.join(' ')}\nUsage: session-lifecycle-mutations.js [--check-anchors] [--keep]`); return 2; }
  if (argv.includes('--check-anchors')) {
    for (const row of checkAnchors(deps.sourceRoot)) log(JSON.stringify(row));
    return 0;
  }
  return runMutants({ ...deps, keep: argv.includes('--keep'), log }).ok ? 0 : 1;
}
module.exports = { MUTANTS, replaceOnce, duplicateSucceededJournalAppend, mutate, checkAnchors, prepareCopy, childEnv, targetArgs, classify, runMutants, main };
if (require.main === module) process.exitCode = main();
// COORD-873: the CLI shim calls main() with no arguments; only then run the command
// line and set the exit code, exactly as the require.main block above does.
const runMutationsMain = module.exports.main;
module.exports.main = function main(argv, deps) {
  if (argv === undefined && deps === undefined) return (process.exitCode = runMutationsMain());
  return runMutationsMain(argv, deps);
};
