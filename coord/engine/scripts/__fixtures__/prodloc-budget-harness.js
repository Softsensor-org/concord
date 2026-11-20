"use strict";
// COORD-957: replays every production-LOC budget refusal and admission through the
// public guard entry points (arch-checks gate and closeout). The recorded outcomes are the
// equivalence fixture (prodloc-budget-equivalence.json). Uses only exports that survive the merge.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const COORD = path.resolve(__dirname, "..", "..", "..");
const { resolveEngineModule, loadShimRegistry } = require(path.join(COORD, "paths.js"));
const archChecks = require(resolveEngineModule(COORD, "scripts/arch-checks.js"));
const { DEFAULT_CONFIG, checkProductionModuleLocBudget } = archChecks;
const paths = require(resolveEngineModule(COORD, "scripts/control-plane-paths.js"));
const { assertProductionLocForCloseout } = require(resolveEngineModule(COORD, "scripts/prodloc-closeout.js"));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const lines = (n, tag = "carried") => Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i};`).join("\n") + "\n";
const declare = (entries) => "module.exports = {};\nconst opts = {\n  highWater: Object.freeze({\n" +
  Object.entries(entries).map(([k, v]) => `    "${k}": ${v},\n`).join("") + "  }),\n};\n";
const REG_LEGACY = "coord/scripts/lifecycle.js", REG_TARGET = "coord/engine/scripts/lifecycle.js";
const LEGACY = "coord/scripts/carry-legacy.js";
const ARCH = "coord/engine/scripts/arch-checks.js";

// Arch gate cases: checkProductionModuleLocBudget over its own config.
const ARCH_CASES = [
  { name: "arch: new module over 1200 fails", file: "coord/scripts/new-monolith.js", n: 1201 },
  { name: "arch: new module at 1200 passes", file: "coord/scripts/new-monolith.js", n: 1200 },
  { name: "arch: test file ignored at 5000", file: "coord/scripts/new-monolith.test.js", n: 5000 },
  { name: "arch: out of scope path ignored", file: "backend/src/foo.js", n: 5000 },
  { name: "arch: fixture path ignored", file: "coord/scripts/__fixtures__/foo.js", n: 5000 },
  { name: "arch: unbudgeted engine module over cap fails", file: "coord/engine/scripts/new-engine-module.js", n: 1201 },
  { name: "arch: unbudgeted engine test ignored", file: "coord/engine/scripts/new-engine-module.test.js", n: 5000 },
  { name: "arch: normalized ./ path keyed by budget", file: "./coord/scripts/legacy.js", n: 11, cfg: { highWater: { "coord/scripts/legacy.js": 10 } } },
  { name: "arch: tracked module at high-water passes", file: "coord/scripts/legacy.js", n: 10, cfg: { highWater: { "coord/scripts/legacy.js": 10 } } },
  { name: "arch: tracked module grown past high-water fails", file: "coord/scripts/legacy.js", n: 11, cfg: { highWater: { "coord/scripts/legacy.js": 10 } } },
  { name: "arch: backslash path keyed by budget", file: "coord\\scripts\\legacy.js", n: 11, cfg: { highWater: { "coord/scripts/legacy.js": 10 } } },
  { name: "arch: engine budgeted module at cap passes", file: "coord/engine/scripts/lifecycle.js", n: "cap" },
  { name: "arch: engine budgeted module over cap fails", file: "coord/engine/scripts/lifecycle.js", n: "cap+1" },
  { name: "arch: severity warn propagates", file: "coord/scripts/new-monolith.js", n: 1201, severity: "warn" },
];

function archOutcome(c) {
  const base = c.cfg ? { maxLoc: 1200, severity: "fail", include: ["coord/scripts/", "coord/engine/scripts/"], ...c.cfg } : DEFAULT_CONFIG.checks.prodloc;
  let n = c.n;
  if (n === "cap" || n === "cap+1") { const cap = base.highWater[c.file] ?? DEFAULT_CONFIG.checks.prodloc.highWater[c.file]; n = n === "cap" ? cap : cap + 1; }
  const findings = checkProductionModuleLocBudget({ file: c.file, source: lines(n, "m"), config: base, severity: c.severity || base.severity || "fail" });
  return { findings: findings.map(f => ({ check: f.check, file: f.file, value: f.value, threshold: f.threshold, severity: f.severity, message: f.message })) };
}

// Closeout cases: a committed base tree, a candidate tree (branch or head), trusted budgets.
const S = "\u0000SYMLINK";
const CLOSEOUT_CASES = [
  { name: "closeout: exact budget 1199 admitted", base: { [`coord/scripts/budget-fixture.js`]: lines(1199, "a") } },
  { name: "closeout: exact budget 1200 admitted", base: { [`coord/scripts/budget-fixture.js`]: lines(1200, "a") } },
  { name: "closeout: integrated breach 1201 refused", base: { [`coord/scripts/budget-fixture.js`]: lines(1201, "a") } },
  { name: "closeout: incoming breach refused on branch", base: { [`coord/scripts/budget-fixture.js`]: lines(1200, "a") }, candidate: { [`coord/scripts/budget-fixture.js`]: lines(1201, "a") } },
  { name: "closeout: combined addition over budget refused", base: { [`coord/scripts/budget-fixture.js`]: lines(1198, "a") }, candidate: { [`coord/scripts/budget-fixture.js`]: "const x1 = 1;\nconst x2 = 2;\n" + lines(1198, "a") + "const y1 = 1;\nconst y2 = 2;\nconst y3 = 3;\n" } },
  { name: "closeout: engine-scripts module 1201 refused (COORD-871)", base: { "coord/engine/scripts/budget-engine-fixture.js": lines(1201, "e") } },
  { name: "closeout: engine-scripts module 1200 admitted", base: { "coord/engine/scripts/budget-engine-fixture.js": lines(1200, "e") } },
  { name: "closeout: test file not measured", base: { "coord/scripts/budget-fixture.test.js": lines(5000, "t") } },
  { name: "closeout: fixture file not measured", base: { "coord/scripts/__fixtures__/big.js": lines(5000, "f") } },
  { name: "closeout: production source symlink refused", base: { "coord/scripts/budget-fixture.js": S } },
  { name: "closeout: every breach named", base: { "coord/scripts/budget-fixture.js": lines(1201, "a"), "coord/scripts/second-fixture.js": "void 0;\n".repeat(1202) } },
  { name: "closeout: shrink repair admitted over existing breach", base: { "coord/scripts/budget-fixture.js": lines(1201, "a") }, candidate: { "coord/scripts/budget-fixture.js": lines(1200, "a") } },
  { name: "closeout: uncommitted shrink does not hide committed breach", base: { "coord/scripts/budget-fixture.js": lines(1201, "a") }, candidate: { "coord/scripts/budget-fixture.js": lines(10, "a") }, onHead: true },
  { name: "closeout: candidate code never executed", base: { "coord/scripts/budget-fixture.js": lines(10, "a") + `require('node:fs').writeFileSync(process.env.EQ_SENTINEL || '/nonexistent/sentinel', 'x');\n` } },
  { name: "closeout: carried shim move at unchanged budget admitted (COORD-913)", trusted: { [REG_LEGACY]: 1500 }, base: { [REG_LEGACY]: lines(1500, "l") },
    candidate: { [REG_TARGET]: lines(1500, "l"), [REG_LEGACY]: "module.exports = require('./shim');\n", [ARCH]: declare({ [REG_TARGET]: 1500 }) } },
  { name: "closeout: carried git rename at unchanged budget admitted (COORD-913)", trusted: { [LEGACY]: 1500 }, base: { [LEGACY]: lines(1500, "c") },
    candidate: { [LEGACY]: null, "coord/engine/scripts/renamed-carry.js": lines(1500, "c") } },
  { name: "closeout: carried move raising re-keyed number refused as budget raised (COORD-913)", trusted: { [REG_LEGACY]: 1500 }, base: { [REG_LEGACY]: lines(1500, "l") },
    candidate: { [REG_TARGET]: lines(1500, "l"), [REG_LEGACY]: "module.exports = require('./shim');\n", [ARCH]: declare({ [REG_TARGET]: 1600 }) } },
  { name: "closeout: carried move declaring under-budget number admitted (COORD-913)", trusted: { [REG_LEGACY]: 1500 }, base: { [REG_LEGACY]: lines(1500, "l") },
    candidate: { [REG_TARGET]: lines(1500, "l"), [REG_LEGACY]: "module.exports = require('./shim');\n", [ARCH]: declare({ [REG_TARGET]: 1400 }) } },
  { name: "closeout: carried git rename over its budget refused (COORD-913)", trusted: { [LEGACY]: 1500 }, base: { [LEGACY]: lines(1500, "c") },
    candidate: { [LEGACY]: null, "coord/engine/scripts/renamed-over.js": lines(1501, "c") } },
  { name: "closeout: carried move onHead over budget refused (COORD-913)", trusted: { [REG_LEGACY]: 1500 }, base: { [REG_LEGACY]: lines(1500, "l") }, onHead: true,
    candidate: { [REG_TARGET]: lines(1501, "l"), [REG_LEGACY]: "module.exports = require('./shim');\n" } },
  { name: "closeout: unregistered copy at default budget refused (COORD-913)", trusted: { [LEGACY]: 1500 }, base: { [LEGACY]: lines(1500, "c") },
    candidate: { "coord/engine/scripts/unregistered-copy.js": lines(1201, "u") } },
  { name: "closeout: unregistered copy at default budget admitted (COORD-913)", trusted: { [LEGACY]: 1500 }, base: { [LEGACY]: lines(1500, "c") },
    candidate: { "coord/engine/scripts/unregistered-copy.js": lines(1200, "u") } },
  { name: "closeout: candidate-invented budget refused (COORD-913)", trusted: { [LEGACY]: 1500 }, base: { [LEGACY]: lines(1500, "c") },
    candidate: { "coord/engine/scripts/invented.js": lines(1201, "i"), [ARCH]: declare({ "coord/engine/scripts/invented.js": 1500 }) } },
  { name: "closeout: candidate-declared number for trusted path raised refused", trusted: { "coord/scripts/budget-fixture.js": 1200 }, base: { "coord/scripts/budget-fixture.js": lines(1200, "a") },
    candidate: { [ARCH]: declare({ "coord/scripts/budget-fixture.js": 1300 }) } },
  { name: "closeout: candidate-declared number for trusted path lowered admitted", trusted: { "coord/scripts/budget-fixture.js": 1200 }, base: { "coord/scripts/budget-fixture.js": lines(1200, "a") },
    candidate: { [ARCH]: declare({ "coord/scripts/budget-fixture.js": 1000 }) } },
];

const GIT_SHIM = null;
function gitIn(root) { return (dir, args, options = {}) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV, ...options }); }
function writeEntry(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (content === S) { fs.symlinkSync("../../outside.js", full); return; }
  fs.writeFileSync(full, content);
}
function closeoutOutcome(c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-prodloc-eq-"));
  try {
    const coord = path.join(root, "coord");
    fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
    const gitTry = gitIn(root);
    const git = (...args) => { const r = gitTry(root, args); if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`); return r.stdout.trim(); };
    git("init", "-b", "eq-base");
    for (const [rel, content] of Object.entries(c.base)) writeEntry(root, rel, content);
    git("add", "--all"); git("commit", "-m", "base");
    const layout = paths.resolveControlPlaneLayout({ coordDir: coord, workspaceRoot: root });
    const branch = "agent/codexa1-test-957-eq";
    const onHead = Boolean(c.onHead);
    if (!onHead) git("checkout", "-b", branch);
    if (c.candidate) {
      for (const [rel, content] of Object.entries(c.candidate)) {
        if (content === null) { git("rm", "-q", rel); continue; }
        writeEntry(root, rel, content);
      }
      git("add", "--all"); git("commit", "-m", "candidate");
    }
    if (!onHead) git("checkout", "eq-base");
    const trustedConfig = { ...DEFAULT_CONFIG.checks.prodloc, highWater: { ...(c.trusted || {}) } };
    if (c.name.startsWith("closeout: candidate code")) {
      // untrusted candidate: keep trusted budgets default; uncommitted in-tree change is out of scope
    }
    const shims = loadShimRegistry(COORD).shims;
    const r = assertProductionLocForCloseout("TEST-957", { layout, gitTry, branches: onHead ? [] : [branch], trustedConfig, shimRegistry: shims });
    return { admitted: true, result: r.result, checked: r.checked };
  } catch (error) {
    return { refused: String(error.message) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runCases() {
  const out = [];
  for (const c of ARCH_CASES) out.push({ name: c.name, outcome: archOutcome(c) });
  for (const c of CLOSEOUT_CASES) out.push({ name: c.name, outcome: closeoutOutcome(c) });
  return out;
}

module.exports = { runCases, ARCH_CASES, CLOSEOUT_CASES };
