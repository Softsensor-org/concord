"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
// COORD-991: a removable legacy shim adds exactly one deprecation line to stderr; a permanent entrypoint adds none.
const shimLine = (name) => require("../../paths.js").loadShimRegistry(COORD_ROOT_DIR).shims.some((s) => s.path === `scripts/${name}.js` && s.kind === "removable")
  ? `DEPRECATED: coord/scripts/${name}.js is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/${name}.js instead.\n` : "";

// COORD-867 (COORD-589 batch 4): the gate, policy, coverage and quality
// modules moved under coord/engine/scripts and their legacy coord/scripts paths
// became registered shims. Every CLI module exports a zero-argument main(),
// which the CLI shim re-dispatches when it is the process entrypoint. This
// suite runs both entrypoints of every CLI module end to end and checks that
// the shim, the engine module and the gov/coord dispatchers all reach the same
// engine code.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const MODULES = [
  "a11y-policy", "adr-reference", "adr-validator", "affected-targets", "analytics-gate", "arch-checks",
  "audit-policy", "bounded-process-runner", "check-testing-baseline", "comment-lexer", "content-gate",
  "contract-policy", "coverage-maturity", "coverage-policy", "coverage-rollup-cron", "data-contract-gate",
  "decomposition-proof-gate", "gate-artifact-schema", "gate-plan", "gate-proc-registry", "gate-result",
  "gate-runtime", "gates", "gates/adr", "gates/business-context", "gates/context-pack-ack",
  "gates/managed-evidence", "gates/readiness", "gates/registry", "gates/review-closeout", "infra-gate",
  "perf-budget-policy", "prodloc-attribution", "prompt-coverage", "prompt-paths", "publishability-check",
  "quality-propose-cron", "quality-scan", "review-lens-catalog", "sast-policy", "supply-chain-policy",
  "track-evidence-policy", "track-registry", "triage-core",
];

// Entrypoint modules and the arguments that print their usage without touching
// the board, the runtime tree or an external tool. COORD-876: every batch-4 CLI
// prints its usage and exits 0 on a leading --help; gate-proc-registry still
// refuses --help as an unknown verb with 2.
const CLI_USAGE = {
  "a11y-policy": { args: ["--help"], status: 0, usage: /^usage: a11y-policy\.js classify/ },
  "adr-validator": { args: ["--help"], status: 0, usage: /^Usage: adr-validate/ },
  "affected-targets": { args: ["--help"], status: 0, usage: /^Usage: affected-targets/ },
  "analytics-gate": { args: ["--help"], status: 0, usage: /^usage: node analytics-gate\.js/ },
  "arch-checks": { args: ["--help"], status: 0, usage: /^usage: arch-checks\.js classify/ },
  "audit-policy": { args: ["--help"], status: 0, usage: /^usage: audit-policy\.js classify/ },
  "content-gate": { args: ["--help"], status: 0, usage: /^usage: node content-gate\.js/ },
  "contract-policy": { args: ["--help"], status: 0, usage: /^usage: contract-policy\.js <gen\|check>/ },
  "coverage-maturity": { args: ["--help"], status: 0, usage: /^coord\/engine\/scripts\/coverage-maturity\.js — COORD-243/ },
  "coverage-policy": { args: ["--help"], status: 0, usage: /^usage: coverage-policy\.js classify/ },
  "data-contract-gate": { args: ["--help"], status: 0, usage: /^usage: node data-contract-gate\.js/ },
  "gate-plan": { args: ["--help"], status: 0, usage: /^usage: gate-plan\.js <ticket-id>/ },
  "gate-proc-registry": { args: ["--help"], status: 2, usage: /^Unknown verb "--help"\. Expected: register \| cleanup \| list \| detect\./ },
  "infra-gate": { args: ["--help"], status: 0, usage: /^usage: node infra-gate\.js/ },
  "perf-budget-policy": { args: ["--help"], status: 0, usage: /^usage: perf-budget-policy\.js classify/ },
  "quality-propose-cron": { args: ["--help"], status: 0, usage: /^usage: quality-propose-cron\.js \(no options\)/ },
  "quality-scan": { args: ["--help"], status: 0, usage: /^usage: quality-scan\.js/ },
  "sast-policy": { args: ["--help"], status: 0, usage: /^usage: sast-policy\.js classify/ },
  "supply-chain-policy": { args: ["--help"], status: 0, usage: /^usage: supply-chain-policy\.js classify/ },
};
// COORD-876 kept every non-help exit code: the policy adapters and track gates
// still exit 2 with the usage on stderr when the subcommand or target is
// missing or unknown, and gate-plan still rejects an unknown flag with 1.
const POLICY_CLIS = ["a11y-policy", "arch-checks", "audit-policy", "contract-policy", "coverage-policy", "perf-budget-policy", "sast-policy", "supply-chain-policy"];
const TRACK_GATES = ["analytics-gate", "content-gate", "data-contract-gate", "infra-gate"];
const CLI_USAGE_ERRORS = [
  ...POLICY_CLIS.flatMap((name) => [[name, [], 2, CLI_USAGE[name].usage], [name, ["--bogus"], 2, CLI_USAGE[name].usage]]),
  ...TRACK_GATES.map((name) => [name, [], 2, CLI_USAGE[name].usage]),
  ["gate-plan", ["--bogus"], 1, /^gate-plan: Unexpected argument: --bogus/],
];
// Entrypoints with no usage path: check-testing-baseline validates the live
// TESTING_BASELINE.md and coverage-rollup-cron rewrites TEST_MATURITY.md. Their
// own suites drive them in a sandbox; here they only need to export main for
// the shim.
const CLI_MODULES = [...Object.keys(CLI_USAGE), "check-testing-baseline", "coverage-rollup-cron"].sort();

const LEGACY_DIR = path.join(COORD_ROOT_DIR, "scripts");
const REPO_ROOT = path.dirname(COORD_ROOT_DIR);

function runNode(file, args, options = {}) {
  return spawnSync(process.execPath, [file, ...args], { cwd: REPO_ROOT, encoding: "utf8", ...options });
}

// COORD-879: quality-propose-cron is a permanent stable entrypoint (adopter
// crontabs run its legacy path); every other batch-4 shim is removable.
const PERMANENT_MODULES = ["quality-propose-cron"];

test("COORD-867: every batch-4 module is registered as a shim at its legacy path, removable unless a stable entrypoint", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(COORD_ROOT_DIR, "engine/shim-registry.json"), "utf8"));
  for (const name of MODULES) {
    const shim = registry.shims.find((entry) => entry.path === `scripts/${name}.js`);
    assert.ok(shim, `scripts/${name}.js is registered`);
    assert.equal(shim.target, `engine/scripts/${name}.js`);
    assert.equal(shim.kind, PERMANENT_MODULES.includes(name) ? "permanent" : "removable", name);
    assert.ok(fs.existsSync(path.join(__dirname, `${name}.js`)), `engine module ${name}.js exists`);
    const legacyModule = require(path.join(LEGACY_DIR, `${name}.js`));
    assert.equal(legacyModule, require(path.join(__dirname, `${name}.js`)), `${name}: the shim is the engine module`);
    assert.equal(legacyModule, require(resolveEngineModule(COORD_ROOT_DIR, `scripts/${name}.js`)));
    assert.equal(typeof legacyModule.main, CLI_MODULES.includes(name) ? "function" : "undefined", name);
  }
});

for (const [name, { args, status, usage }] of Object.entries(CLI_USAGE)) {
  test(`COORD-867: ${name} usage runs through the legacy CLI shim and the engine entrypoint`, () => {
    const engine = runNode(path.join(__dirname, `${name}.js`), args);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), args);
    assert.ifError(engine.error);
    assert.ifError(legacy.error);
    assert.equal(engine.status, status, engine.stderr || engine.stdout);
    assert.equal(legacy.status, status, legacy.stderr || legacy.stdout);
    assert.match(`${engine.stdout}${engine.stderr}`, usage);
    assert.doesNotMatch(`${engine.stdout}${engine.stderr}`, /coord\/scripts\/[\w-]+\.js/, "usage names the engine path, not the shim");
    assert.equal(legacy.stdout, engine.stdout, "the shim re-dispatches the engine main");
    assert.equal(legacy.stderr, `${shimLine(name)}${engine.stderr}`);
  });
}

for (const [name, args, status, usage] of CLI_USAGE_ERRORS) {
  test(`COORD-876: ${name} ${JSON.stringify(args)} keeps its usage-error exit ${status} on stderr through both entrypoints`, () => {
    const engine = runNode(path.join(__dirname, `${name}.js`), args);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), args);
    assert.ifError(engine.error);
    assert.ifError(legacy.error);
    assert.equal(engine.status, status, engine.stderr || engine.stdout);
    assert.equal(legacy.status, status, legacy.stderr || legacy.stdout);
    // gate-plan logs its refusal through stdout; every other usage error goes to stderr.
    assert.match(name === "gate-plan" ? engine.stdout : engine.stderr, usage);
    assert.equal(legacy.stdout, engine.stdout);
    assert.equal(legacy.stderr, `${shimLine(name)}${engine.stderr}`);
  });
}

test("COORD-867: a failing gate CLI keeps its non-zero exit code through the shim", () => {
  const cases = [
    ["gate-proc-registry", ["bogus-verb"]],
    ["adr-validator", ["--dir", path.join(REPO_ROOT, "definitely-missing-adr-dir")]],
    ["affected-targets", ["--definitely-unknown-option"]],
  ];
  for (const [name, args] of cases) {
    const engine = runNode(path.join(__dirname, `${name}.js`), args);
    const legacy = runNode(path.join(LEGACY_DIR, `${name}.js`), args);
    assert.notEqual(engine.status, 0, `${name}: ${engine.stdout}${engine.stderr}`);
    assert.equal(legacy.status, engine.status, name);
    assert.equal(legacy.stdout, engine.stdout, name);
  }
});

test("COORD-867: the coord and gov CLIs dispatch gate commands to the engine modules", () => {
  const cli = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));
  const lines = [];
  const result = cli.dispatch(["affected-targets", "--help"], { log: (line) => lines.push(String(line)) });
  assert.equal(result.code, 0);
  assert.match(lines.join("\n"), /^Usage: affected-targets /);
  const spawned = runNode(path.join(LEGACY_DIR, "coord-cli.js"), ["adr-validate", "--help"]);
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.equal(spawned.stdout, runNode(path.join(__dirname, "adr-validator.js"), ["--help"]).stdout);
  // gov quality-scan hands argv to the engine quality-scan CLI verbatim; an
  // ungoverned option is refused by the engine usage text, not by gov.
  const gov = runNode(path.join(LEGACY_DIR, "cli.js"), ["quality-scan", "--not-a-governed-option"]);
  assert.equal(gov.status, 2, gov.stderr);
  assert.match(gov.stderr, /unknown flag --not-a-governed-option\n\s*usage: quality-scan\.js/);
  // The governance entrypoint refuses an unknown gate verb as a governed error: a
  // one-line refusal and exit 1, never a stack trace.
  const unknown = runNode(path.join(LEGACY_DIR, "governance.js"), ["definitely-not-a-gate-verb"]);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /^Unknown command "definitely-not-a-gate-verb"\./);
  assert.doesNotMatch(unknown.stderr, /\n\s+at /, "a governed refusal prints no stack trace");
});

// ---------------------------------------------------------------------------
// COORD-867 lost-credit coverage. The move changed the owner text of these
// sites (path hops, the zero-arg main() wrappers, the CLI re-dispatch), so
// their baseline identities no longer apply; per the 2026-10-27 ruling they
// are covered by real in-process tests instead of being written back into the
// baselines. Coverage of spawned CLI children is not collected, so every
// entrypoint is driven in-process with process.exit/stdout stubbed.
// ---------------------------------------------------------------------------
const os = require("node:os");

class ExitSignal extends Error {
  constructor(code) { super(`process.exit(${code})`); this.code = code; }
}

function withProcessStubs(fn) {
  const saved = {
    exit: process.exit, out: process.stdout.write, err: process.stderr.write,
    log: console.log, error: console.error, exitCode: process.exitCode,
  };
  const io = { stdout: "", stderr: "", exits: [] };
  process.exit = (code) => { io.exits.push(code); throw new ExitSignal(code); };
  process.stdout.write = (chunk) => { io.stdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { io.stderr += String(chunk); return true; };
  console.log = (...args) => { io.stdout += `${args.join(" ")}\n`; };
  console.error = (...args) => { io.stderr += `${args.join(" ")}\n`; };
  try {
    io.returned = fn(io);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    process.exit = saved.exit; process.stdout.write = saved.out; process.stderr.write = saved.err;
    console.log = saved.log; console.error = saved.error; process.exitCode = saved.exitCode;
  }
  return io;
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coord867-${label}-`));
}

test("COORD-867: analytics-gate main() prints usage, emits JSON or text, and exits with the gate result", () => {
  const gate = require("./analytics-gate.js");
  const usage = withProcessStubs(() => gate.main([]));
  assert.deepEqual(usage.exits, [2]);
  assert.match(usage.stderr, /^usage: node analytics-gate\.js/);
  const dir = tmpDir("evidence");
  const json = withProcessStubs(() => gate.main(["T-1", "--json", "--evidence-dir", dir]));
  assert.equal(json.exits.length, 1);
  assert.equal(typeof JSON.parse(json.stdout).result, "string");
  const text = withProcessStubs(() => gate.main(["--ticket", "T-1", "--evidence-dir", dir]));
  assert.equal(text.exits.length, 1);
  assert.ok(text.stdout.length > 0);
  // Without --evidence-dir the gate reads coord/evidence/live-mcp beside the engine tree (read-only).
  const report = gate.runEvidenceGate({ ticket: "COORD-867-no-such-ticket" });
  assert.equal(typeof report.result, "string");
});

test("COORD-867: content-gate, infra-gate and data-contract-gate main() drive usage, JSON and text output in-process", () => {
  const content = require("./content-gate.js");
  const infra = require("./infra-gate.js");
  const data = require("./data-contract-gate.js");
  const site = tmpDir("site");
  fs.writeFileSync(path.join(site, "index.html"), "<html><head><title>t</title></head><body><a href=\"/\">home</a></body></html>\n");
  assert.deepEqual(withProcessStubs(() => content.main([])).exits, [2]);
  const contentJson = withProcessStubs(() => content.main(["--dir", site, "--json"]));
  assert.equal(contentJson.exits.length, 1);
  assert.equal(typeof JSON.parse(contentJson.stdout).result, "string");
  assert.equal(withProcessStubs(() => content.main([site])).exits.length, 1);

  const cfg = path.join(site, "staticwebapp.config.json");
  const wf = path.join(site, "deploy.yml");
  fs.writeFileSync(cfg, "{}\n");
  fs.writeFileSync(wf, "name: deploy\n");
  assert.deepEqual(withProcessStubs(() => infra.main([])).exits, [2]);
  const infraJson = withProcessStubs(() => infra.main(["--config", cfg, "--workflow", wf, "--json"]));
  assert.equal(infraJson.exits.length, 1);
  assert.equal(typeof JSON.parse(infraJson.stdout).result, "string");
  assert.equal(withProcessStubs(() => infra.main(["--config", cfg, "--workflow", wf])).exits.length, 1);

  const registry = path.join(site, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ contracts: [] }) + "\n");
  assert.deepEqual(withProcessStubs(() => data.main([])).exits, [2]);
  const dataJson = withProcessStubs(() => data.main(["--registry", registry, "--json"]));
  assert.equal(dataJson.exits.length, 1);
  assert.equal(typeof JSON.parse(dataJson.stdout).result, "string");
  assert.equal(withProcessStubs(() => data.main([registry])).exits.length, 1);
});

test("COORD-867: check-testing-baseline defaults to the engine's coord tree, reports missing rows and runs main()", () => {
  const { validateTestingBaseline, main } = require("./check-testing-baseline.js");
  const live = validateTestingBaseline();
  assert.equal(typeof live.ok, "boolean");
  const dir = tmpDir("baseline");
  const baselinePath = path.join(dir, "TESTING_BASELINE.md");
  fs.writeFileSync(baselinePath, "# Baseline\n\n| repo | command |\n|---|---|\n", "utf8");
  const missing = validateTestingBaseline({
    baselinePath,
    expectedBaseline: { B: { repo: "backend/", command: "npm run test:ci" } },
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => /missing repo row/.test(error)));
  assert.ok(missing.errors.some((error) => /missing baseline command/.test(error)));
  const io = withProcessStubs(() => main());
  assert.ok(io.exits.length === 0 ? /Testing baseline contract OK/.test(io.stdout) : io.exits[0] === 1);
});

test("COORD-867: contract-policy runCli resolves coord paths itself and reports every repo-selection and gen outcome", () => {
  const { runCli } = require("./contract-policy.js");
  const capture = () => { const chunks = []; return { write: (s) => chunks.push(String(s)), get: () => chunks.join("") }; };
  const contract = { sourceRepo: "A", sourcePath: "openapi.json", generatedPath: "client.js" };
  // No injected paths: the policy loads coord/paths.js itself and reads the live project config.
  assert.equal(typeof runCli(["check"], { stdout: capture(), stderr: capture() }), "number");
  const none = capture();
  assert.equal(runCli(["check"], { paths: { projectConfig: { repos: {} }, repoRoots: {} }, stdout: none, stderr: capture() }), 0);
  assert.match(none.get(), /no repo declares a contract block/);
  const many = capture();
  assert.equal(runCli(["check"], { paths: { projectConfig: { repos: { A: { contract }, B: { contract } } }, repoRoots: {} }, stdout: capture(), stderr: many }), 2);
  assert.match(many.get(), /multiple repos declare a contract block/);
  const unresolved = capture();
  assert.equal(runCli(["check", "--repo", "W"], { paths: { projectConfig: { repos: { W: { contract } } }, repoRoots: {} }, stdout: capture(), stderr: unresolved }), 2);
  assert.match(unresolved.get(), /has no resolved root/);
  const noBlock = capture();
  assert.equal(runCli(["gen", "--repo", "W"], { paths: { projectConfig: { repos: { W: {} } }, repoRoots: {} }, stdout: noBlock, stderr: capture() }), 0);
  assert.match(noBlock.get(), /has no contract block/);
  const root = tmpDir("contract");
  const repoRoots = { W: path.join(root, "w"), A: path.join(root, "a") };
  for (const dir of Object.values(repoRoots)) fs.mkdirSync(dir, { recursive: true });
  const paths = { projectConfig: { repos: { W: { contract }, A: {} } }, repoRoots };
  const noSource = capture();
  assert.equal(runCli(["gen", "--repo", "W"], { paths, stdout: noSource, stderr: capture() }), 0);
  assert.match(noSource.get(), /no OpenAPI source artifact/);
  fs.writeFileSync(path.join(repoRoots.A, "openapi.json"), "{ not json\n");
  const broken = capture();
  assert.equal(runCli(["gen", "--repo", "W"], { paths, stdout: capture(), stderr: broken }), 1);
  assert.match(broken.get(), /could not generate client/);
});

test("COORD-867: coverage-rollup-cron main() reports a refreshed and an unchanged rollup", () => {
  const engine = require("./coverage-maturity.js");
  const cron = require("./coverage-rollup-cron.js");
  const original = engine.rollup;
  const result = (changed) => ({ changed, outputPath: "x", inputs: { gate: { failing_cycles: 1, total_cycles: 3 }, recovery_events: 2 } });
  try {
    engine.rollup = () => result(true);
    assert.match(withProcessStubs(() => cron.main()).stdout, /refreshed TEST_MATURITY\.md — gate 1\/3 failing, 2 recoveries/);
    engine.rollup = () => result(false);
    assert.match(withProcessStubs(() => cron.main()).stdout, /no change \(idempotent\)/);
  } finally {
    engine.rollup = original;
  }
});

test("COORD-867: gate-proc-registry main() lists, detects, refuses an unknown verb and re-dispatches with the process exit code", () => {
  const reg = require("./gate-proc-registry.js");
  const list = withProcessStubs(() => reg.main(["list"]));
  assert.equal(list.returned, 0);
  assert.ok(Array.isArray(JSON.parse(list.stdout)));
  const detect = withProcessStubs(() => reg.main(["detect", "--json", "--since", "0"]));
  assert.equal(detect.returned, 0);
  JSON.parse(detect.stdout);
  const unknown = withProcessStubs(() => reg.main(["bogus"]));
  assert.equal(unknown.returned, 2);
  assert.match(unknown.stderr, /Unknown verb "bogus"/);
  const savedArgv = process.argv;
  process.argv = [process.argv[0], "gate-proc-registry.js", "bogus"];
  try {
    assert.deepEqual(withProcessStubs(() => reg.main()).exits, [2]);
  } finally {
    process.argv = savedArgv;
  }
});

// COORD-882: main() always applies (--apply --propose), and quality-scan
// resolves its repo root, board and gov from its own location. So the real
// main() runs here with quality-scan loaded from a disposable install (stub
// gov, scratch board, one oversized source file): the require cache entry for
// ./quality-scan.js points at the fixture copy while the real
// quality-propose-cron.js is reloaded, then both entries are restored. The test
// also proves the tree under test is untouched: its board bytes and the git
// status of the paths gov file-ticket writes are the same before and after.
function treeUnderTestState() {
  const board = path.join(COORD_ROOT_DIR, "board", "tasks.json");
  const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "coord/board", "coord/prompts"], {
    cwd: path.resolve(COORD_ROOT_DIR, ".."), encoding: "utf8",
  });
  return {
    board: fs.existsSync(board) ? fs.readFileSync(board, "utf8") : null,
    git: git.status === 0 ? git.stdout : null,
  };
}

test("COORD-882: quality-propose-cron main() files through a stub gov in a disposable install and sets the process exit code", {
  skip: process.platform === "win32" && "the stub gov is a POSIX shell script",
}, (t) => {
  const { buildQualityCronInstall } = require("./__fixtures__/quality-cron-install.js");
  const fixture = buildQualityCronInstall(t, { label: "coord882-cron" });
  const before = treeUnderTestState();
  const scanKey = require.resolve("./quality-scan.js");
  const cronKey = require.resolve("./quality-propose-cron.js");
  const saved = { scan: require.cache[scanKey], cron: require.cache[cronKey], gov: process.env.FAKE_GOV_STATUS };
  const runMain = () => {
    let exitCode;
    const io = withProcessStubs(() => { cron.main(); exitCode = process.exitCode; });
    return { ...io, exitCode };
  };
  let cron;
  try {
    require(path.join(fixture.coord, "engine", "scripts", "quality-scan.js"));
    require.cache[scanKey] = require.cache[path.join(fixture.coord, "engine", "scripts", "quality-scan.js")];
    delete require.cache[cronKey];
    cron = require("./quality-propose-cron.js");
    delete process.env.FAKE_GOV_STATUS;

    const ok = runMain();
    assert.equal(ok.exitCode, 0, ok.stderr || ok.stdout);
    assert.deepEqual(ok.exits, []);
    assert.match(ok.stdout, /mode=APPLY status=proposed floor=warn cap=3/);
    assert.match(ok.stdout, /FILED QSCAN-001/);
    const filed = fixture.readCalls();
    assert.ok(filed.length >= 1 && filed.length <= 3, `the cadence cap bounds the filings: ${filed.length}`);
    for (const line of filed) assert.match(line, /^file-ticket .*--status proposed /);

    fixture.resetCalls();
    process.env.FAKE_GOV_STATUS = "1";
    const refused = runMain();
    assert.equal(refused.exitCode, 1, refused.stderr || refused.stdout);
    assert.match(refused.stderr, /FAILED to file .*stub gov refused/);
    assert.ok(fixture.readCalls().length >= 1, "the failing filing still went to the stub gov");
  } finally {
    if (saved.gov === undefined) delete process.env.FAKE_GOV_STATUS; else process.env.FAKE_GOV_STATUS = saved.gov;
    if (saved.scan) require.cache[scanKey] = saved.scan; else delete require.cache[scanKey];
    if (saved.cron) require.cache[cronKey] = saved.cron; else delete require.cache[cronKey];
  }
  assert.deepEqual(treeUnderTestState(), before, "main() left the board and git status of the tree under test unchanged");
});

test("COORD-867: track-registry loads the project config from the engine's coord tree or COORD_PROJECT_CONFIG", () => {
  const createTrackRegistry = require("./track-registry.js");
  const saved = process.env.COORD_PROJECT_CONFIG;
  try {
    delete process.env.COORD_PROJECT_CONFIG;
    assert.equal(typeof createTrackRegistry().resolveTrack, "function");
    const dir = tmpDir("track-config");
    const configPath = path.join(dir, "project.config.js");
    fs.writeFileSync(configPath, "module.exports = { tracks: { custom: { gateProc: 'content', defaultLane: 'default', prefixes: ['ZZZ'] } } };\n");
    process.env.COORD_PROJECT_CONFIG = configPath;
    assert.equal(createTrackRegistry().resolveTrack("ZZZ-1").name, "custom");
    process.env.COORD_PROJECT_CONFIG = path.join(dir, "missing.config.js");
    assert.equal(typeof createTrackRegistry().resolveTrack, "function");
  } finally {
    if (saved === undefined) delete process.env.COORD_PROJECT_CONFIG; else process.env.COORD_PROJECT_CONFIG = saved;
  }
});

test("COORD-867: adr-validator renders an empty registry and the cockpit view through main()", () => {
  const adr = require("./adr-validator.js");
  assert.match(adr.renderMarkdown({ summary: { adrs: 0, findings: 0, ok: true }, findings: [] }), /No findings\./);
  const dir = tmpDir("adr");
  const run = (argv) => { const lines = []; const exits = []; adr.main(argv, { cwd: dir, log: (line) => lines.push(String(line)), exit: (code) => exits.push(code) }); return { lines, exits }; };
  const plain = run(["--dir", dir]);
  assert.equal(plain.exits.length, 1);
  assert.match(plain.lines.join("\n"), /ADR Registry Validation/);
  const cockpit = run(["--dir", dir, "--cockpit"]);
  assert.equal(cockpit.exits.length, 1);
  assert.ok(cockpit.lines.join("\n").length > 0);
});

test("COORD-867: the track gates and policies reach their remaining in-process branches", () => {
  const content = require("./content-gate.js");
  const infra = require("./infra-gate.js");
  const data = require("./data-contract-gate.js");
  const gate = require("./analytics-gate.js");
  const { runCli } = require("./contract-policy.js");
  const reg = require("./gate-proc-registry.js");
  const createTrackRegistry = require("./track-registry.js");
  const adr = require("./adr-validator.js");

  // content-gate: a nested site with a sitemap and every CLI flag; a passing site exits 0.
  const site = tmpDir("site2");
  fs.mkdirSync(path.join(site, "about"), { recursive: true });
  fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><html lang=\"en\"><head><title>Home</title><meta name=\"description\" content=\"home page\"></head><body><h1>Home</h1><a href=\"/about/\">about</a></body></html>\n");
  fs.writeFileSync(path.join(site, "about", "index.html"), "<!doctype html><html lang=\"en\"><head><title>About</title><meta name=\"description\" content=\"about page\"></head><body><h1>About</h1><a href=\"/\">home</a></body></html>\n");
  fs.writeFileSync(path.join(site, "robots.txt"), "User-agent: *\n");
  const sitemap = path.join(site, "sitemap.xml");
  fs.writeFileSync(sitemap, "<?xml version=\"1.0\"?><urlset><url><loc>https://example.test/</loc></url><url><loc>https://example.test/about/</loc></url></urlset>\n");
  const flagged = withProcessStubs(() => content.main(["--dir", site, "--site", "example", "--sitemap", sitemap, "--lighthouse-score", "95", "--preview-url", "https://example.test", "--json"]));
  assert.equal(flagged.exits.length, 1);
  const contentReport = JSON.parse(flagged.stdout);
  assert.equal(typeof contentReport.result, "string");
  const pagesOnly = content.runContentGate({ pages: content.loadSite(site), site: "example" });
  assert.equal(typeof pagesOnly.result, "string");

  // infra-gate: missing config/workflow files degrade to undefined inputs; --target is parsed.
  assert.equal(infra.loadConfig(path.join(site, "missing.json")), undefined);
  assert.equal(infra.loadWorkflow(path.join(site, "missing.yml")), undefined);
  const infraMissing = withProcessStubs(() => infra.main(["--config", path.join(site, "missing.json"), "--workflow", path.join(site, "missing.yml"), "--target", "preview", "--json"]));
  assert.equal(infraMissing.exits.length, 1);
  JSON.parse(infraMissing.stdout);

  // data-contract-gate: a failing contract prints its detail line.
  const registry = path.join(site, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({ contracts: [{ name: "orders", output: "missing.csv", checks: [{ type: "row_count", min: 1 }] }] }) + "\n");
  const dataText = withProcessStubs(() => data.main([registry]));
  assert.equal(dataText.exits.length, 1);

  // analytics-gate: receipts named for the ticket are read, including an unparsable one.
  const evidence = tmpDir("evidence2");
  // One receipt satisfies the read_safe policy end to end; one declares no evidence, so the
  // validator's evidence refusal runs in this process too (the live-MCP validator keeps its
  // credit in-process rather than through a spawned CLI).
  fs.writeFileSync(path.join(evidence, "2026-01-01-t-2-ok.json"), JSON.stringify({
    ticket: "T-2", operation_class: "read_safe", adapter: "fixture", operation: "query", scope: "fixture-scope",
    result: "ok", evidence: [{ kind: "row_count", value: 1 }],
  }) + "\n");
  fs.writeFileSync(path.join(evidence, "2026-01-02-t-2-bad.json"), "{ not json\n");
  fs.writeFileSync(path.join(evidence, "2026-01-03-t-2-no-evidence.json"), JSON.stringify({
    ticket: "T-2", operation_class: "read_safe", adapter: "fixture", operation: "query", scope: "fixture-scope",
    result: "ok", evidence: [],
  }) + "\n");
  // A destructive-class receipt exercises the redaction, approval and cleanup requirements as well.
  fs.writeFileSync(path.join(evidence, "2026-01-04-t-2-destructive.json"), JSON.stringify({
    ticket: "T-2", operation_class: "destructive", adapter: "fixture", operation: "purge", scope: "fixture-scope",
    result: "ok", redaction: "rows hashed", approval: "human_admin: fixture", cleanup: "fixture rows restored",
    evidence: [{ kind: "row_count", value: 0 }],
  }) + "\n");
  const receipts = gate.loadReceiptsForTicket("T-2", evidence);
  assert.ok(Array.isArray(receipts) && receipts.length >= 1);
  assert.equal(withProcessStubs(() => gate.main(["T-2", "--evidence-dir", evidence, "--json"])).exits.length, 1);

  // contract-policy: a missing project config and a null repo entry both fall through to the skip path.
  const out = { chunks: [], write(s) { this.chunks.push(String(s)); } };
  assert.equal(runCli(["check"], { paths: { repoRoots: {} }, stdout: out, stderr: out }), 0);
  assert.equal(runCli(["check"], { paths: { projectConfig: { repos: { A: null } }, repoRoots: {} }, stdout: out, stderr: out }), 0);

  // gate-proc-registry: an empty verb is reported as "".
  const empty = withProcessStubs(() => reg.main([]));
  assert.equal(empty.returned, 2);
  assert.match(empty.stderr, /Unknown verb ""/);

  // track-registry: a config module exporting nothing still resolves the built-in tracks.
  const saved = process.env.COORD_PROJECT_CONFIG;
  try {
    const nullConfig = path.join(site, "null.config.js");
    fs.writeFileSync(nullConfig, "module.exports = null;\n");
    process.env.COORD_PROJECT_CONFIG = nullConfig;
    assert.equal(typeof createTrackRegistry().resolveTrack, "function");
  } finally {
    if (saved === undefined) delete process.env.COORD_PROJECT_CONFIG; else process.env.COORD_PROJECT_CONFIG = saved;
  }

  // adr-validator: the cockpit view over the live ADR registry (read-only) renders every section.
  const lines = [];
  adr.main(["--cockpit"], { cwd: REPO_ROOT, log: (line) => lines.push(String(line)), exit: () => {} });
  assert.match(lines.join("\n"), /Supersession Chains/);
});

test("COORD-867: analytics-gate turns a receipt read that throws into a loudly-unreadable receipt", () => {
  const gate = require("./analytics-gate.js");
  const evidence = tmpDir("evidence3");
  const poison = path.join(evidence, "2026-01-03-t-3-poison.json");
  fs.writeFileSync(poison, JSON.stringify({
    ticket: "T-3", operation_class: "read_safe", adapter: "fixture", operation: "query", scope: "fixture-scope",
    result: "ok", evidence: [{ kind: "row_count", value: 1 }],
  }) + "\n");
  // readReceipt resolves the path before its guarded reads; a resolver that throws for this
  // file is the one way a receipt read escapes the fail callback, and the loader must survive it.
  const savedResolve = path.resolve;
  path.resolve = (...parts) => {
    if (String(parts[parts.length - 1]).endsWith("t-3-poison.json")) throw new Error("poisoned receipt path");
    return savedResolve(...parts);
  };
  let receipts;
  try {
    receipts = gate.loadReceiptsForTicket("T-3", evidence);
  } finally {
    path.resolve = savedResolve;
  }
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].source, poison);
  assert.match(receipts[0].receipt.__unreadable, /poisoned receipt path/);
  const unreadable = withProcessStubs(() => gate.main(["T-3", "--evidence-dir", evidence, "--json"]));
  assert.equal(unreadable.exits.length, 1);
  assert.equal(typeof JSON.parse(unreadable.stdout).result, "string");
});

test("COORD-867: the adr-validator cockpit dashes out a bare ADR and lists the supersession chain that replaced it", () => {
  const adr = require("./adr-validator.js");
  const dir = tmpDir("adr-bare");
  fs.writeFileSync(path.join(dir, "0001-bare-decision.md"), [
    "# ADR 0001: Bare decision",
    "",
    "- **Status:** Accepted",
    "",
    "## Context",
    "",
    "Nothing is linked here.",
    "",
    "## Decision",
    "",
    "Keep it bare.",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "0002-bare-decision-revisited.md"), [
    "# ADR 0002: Bare decision revisited",
    "",
    "- **Status:** Accepted",
    "",
    "## Context",
    "",
    "This decision supersedes ADR 0001.",
    "",
    "## Decision",
    "",
    "Keep it bare, again.",
    "",
  ].join("\n"));
  const lines = [];
  const exits = [];
  adr.main(["--dir", dir, "--cockpit"], { cwd: dir, log: (line) => lines.push(String(line)), exit: (code) => exits.push(code) });
  assert.deepEqual(exits, [0]);
  const rendered = lines.join("\n").split("\n");
  const row = rendered.find((line) => line.startsWith("| ADR-0001 |"));
  assert.ok(row, "the cockpit table lists the bare ADR");
  assert.equal(row, "| ADR-0001 | Accepted | - | - | - | - |");
  // The chain walks from the replacing ADR back to the one it supersedes; the walker names its last id as current.
  assert.ok(rendered.includes("- ADR-0002 -> ADR-0001 (current: ADR-0001)"), `supersession chain rendered: ${rendered.join(" / ")}`);
});

// ---------------------------------------------------------------------------
// COORD-876: the --help branches added to each batch-4 main() are covered
// in-process (spawned CLI children are not measured), with both outcomes of
// every new condition exercised.
// ---------------------------------------------------------------------------
async function runMainWithArgv(mod, argv) {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  process.argv = [process.argv[0], "cli.js", ...argv];
  process.exitCode = undefined;
  try {
    // A synchronous main() sets process.exitCode before withProcessStubs
    // restores it; the async policy adapters set it once runCli settles.
    let syncExitCode;
    const io = withProcessStubs(() => { mod.main(); syncExitCode = process.exitCode; });
    await new Promise((resolve) => setImmediate(resolve));
    const exitCode = process.exitCode === undefined ? syncExitCode : process.exitCode;
    return { ...io, exitCode };
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
}

test("COORD-876: policy adapter main() prints the usage on stdout and exits 0 on --help, and keeps exit 2 otherwise", async () => {
  for (const name of POLICY_CLIS) {
    const mod = require(`./${name}.js`);
    const help = await runMainWithArgv(mod, ["--help"]);
    assert.equal(help.exitCode, 0, name);
    assert.match(help.stdout, CLI_USAGE[name].usage, name);
    assert.equal(help.stderr, "", name);
    const bare = await runMainWithArgv(mod, []);
    assert.equal(bare.exitCode, 2, name);
    assert.match(bare.stderr, CLI_USAGE[name].usage, name);
    assert.equal(bare.stdout, "", name);
  }
});

test("COORD-876: track gate main() prints the usage on stdout and exits 0 on --help", () => {
  for (const name of TRACK_GATES) {
    const help = withProcessStubs(() => require(`./${name}.js`).main(["--help"]));
    assert.deepEqual(help.exits, [0], name);
    assert.match(help.stdout, CLI_USAGE[name].usage, name);
    assert.equal(help.stderr, "", name);
  }
});

test("COORD-876: gate-plan and quality-propose-cron main() print their usage and exit 0 on --help", async () => {
  for (const name of ["gate-plan", "quality-propose-cron"]) {
    const help = await runMainWithArgv(require(`./${name}.js`), ["--help"]);
    assert.equal(help.exitCode, 0, name);
    assert.match(help.stdout, CLI_USAGE[name].usage, name);
    assert.equal(help.stderr, "", name);
  }
  // Without --help gate-plan still refuses an unknown flag with 1 (the
  // quality-propose-cron non-help path is driven by the COORD-867 test above).
  const refused = await runMainWithArgv(require("./gate-plan.js"), ["--bogus"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /^gate-plan: Unexpected argument: --bogus/);
});
