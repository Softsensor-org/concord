"use strict";

// COORD-924: the fault suite for affected-test selection.
//
// SEEDED faults run against a small workspace written to a temp git repo: each
// fault is committed on top of the base, the selector reads base..head, every
// suite runs, and the fault must be caught by a selected suite or force the
// full gate. HISTORICAL regressions replay the changed paths of real board
// incidents against this repository's own graph: the suites that caught them
// must be selected, or the selection must fall back.
// Every suite title starts with its file key, so a failure maps to its file.

const repo = {
  "coord/paths.js": [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "exports.resolveEngineModule = (coordDir, rel) => {",
    "  const engineOnly = rel.startsWith('engine-only:');",
    "  const clean = engineOnly ? rel.slice('engine-only:'.length) : rel;",
    "  const engine = path.join(coordDir, 'engine', clean);",
    "  return engineOnly || fs.existsSync(engine) ? engine : path.join(coordDir, clean);",
    "};",
  ].join("\n"),
  "coord/project.config.js": "module.exports = { limit: 3 };\n",
  "coord/MANIFEST.json": "{ \"files\": 3 }\n",
  "coord/scripts/fmt.js": "const path = require('node:path');\nmodule.exports = require(require('../paths.js').resolveEngineModule(path.join(__dirname, '..'), 'engine-only:scripts/fmt.js'));\n",
  "coord/engine/scripts/math.js": "exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n",
  "coord/engine/scripts/report.js": "const { add } = require('./math.js');\nexports.total = (rows) => rows.reduce(add, 0);\n",
  "coord/engine/scripts/fmt.js": "exports.format = (n) => `#${n}`;\n",
  "coord/engine/scripts/loader.js": "const path = require('node:path');\nconst { resolveEngineModule } = require('../../paths.js');\nconst fmt = require(resolveEngineModule(path.join(__dirname, '..', '..'), 'scripts/fmt.js'));\nexports.show = (n) => fmt.format(n);\n",
  "coord/engine/scripts/limits.js": "const path = require('node:path');\nconst configPath = path.join(__dirname, '..', '..', 'project.config.js');\nexports.limit = () => require(configPath).limit;\n",
  "coord/engine/scripts/upgrade.js": "exports.migrate = (v) => v + 1;\n",
  "coord/engine/scripts/owner.js": "exports.owns = (a, b) => a === b;\n",
  "coord/engine/scripts/plugins/host.js": "const path = require('node:path');\nexports.load = (name) => require(path.join(__dirname, name));\n",
  "coord/engine/scripts/plugins/greet.js": "exports.hello = () => 'hello';\n",
  "coord/engine/scripts/__fixtures__/table.json": "[1, 2, 3]\n",
  "coord/engine/scripts/math.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('./math.js');\ntest('math: add', () => assert.equal(m.add(2, 3), 5));\ntest('math: mul', () => assert.equal(m.mul(2, 3), 6));\n",
  "coord/engine/scripts/report.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { total } = require('./report.js');\ntest('report: total of the table', () => assert.equal(total(JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'table.json'), 'utf8'))), 6));\n",
  "coord/engine/scripts/loader.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('loader: shows through the engine module', () => assert.equal(require('./loader.js').show(4), '#4'));\n",
  "coord/engine/scripts/shim.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('shim: the legacy path delegates', () => assert.equal(require('../../scripts/fmt.js').format(1), '#1'));\n",
  "coord/engine/scripts/plugins.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\nconst host = require('./plugins/host.js');\ntest('plugins: greet loads dynamically', () => assert.equal(host.load(['gre', 'et'].join('')).hello(), 'hello'));\n",
  "coord/engine/scripts/limits.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('limits: the configured limit', () => assert.equal(require('./limits.js').limit(), 3));\n",
  "coord/engine/scripts/upgrade.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('upgrade: migrate', () => assert.equal(require('./upgrade.js').migrate(1), 2));\n",
  "coord/engine/scripts/owner.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('owner: owns', () => assert.equal(require('./owner.js').owns('a', 'a'), true));\n",
  "coord/engine/scripts/manifest.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('manifest: counts', () => assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'MANIFEST.json'), 'utf8')).files, 3));\n",
  "package-lock.json": "{}\n",
  "README.md": "# fixture\n",
};

const policy = {
  initial_state: "shadow",
  fallback_paths: [
    { pattern: "(^|/)(package\\.json|package-lock\\.json)$", reason: "dependency_change", category: "dependency" },
    { pattern: "^coord/project\\.config\\.js$", reason: "config_seam", category: "config-seam" },
  ],
  generated_files: [{ path: "coord/MANIFEST.json", suites: ["coord/engine/scripts/manifest.test.js"] }],
  doc_pattern: "\\.(md|txt)$",
  shared_helper_min_dependent_suites: 2,
};

const registry = {
  guards: [
    { id: "fixture-upgrade", tier: "T2", always_enforced: false, locations: [{ file: "coord/engine/scripts/upgrade.js" }] },
    { id: "fixture-owner", tier: "T0", always_enforced: true, locations: [{ file: "coord/engine/scripts/owner.js" }] },
  ],
};

const shimRegistry = { shims: [{ path: "scripts/fmt.js", target: "engine/scripts/fmt.js", kind: "removable" }] };

const E = ["coord", "engine", "scripts", ""].join("/");
const seeded = [
  { id: "S01", category: "shared-helper", expect: "selected", fault: { replace: [`${E}math.js`, "a + b", "a - b"] } },
  { id: "S02", category: "engine-module", expect: "selected", fault: { replace: [`${E}fmt.js`, "`#${n}`", "`${n}`"] } },
  { id: "S03", category: "shim-registered-move", expect: "selected", fault: { rename: [`${E}fmt.js`, `${E}format.js`] } },
  { id: "S04", category: "rename-move-delete", expect: "selected", fault: { delete: `${E}__fixtures__/table.json` } },
  { id: "S05", category: "fixture", expect: "selected", fault: { write: [`${E}__fixtures__/table.json`, "[1, 2]\n"] } },
  { id: "S06", category: "engine-module", expect: "fallback", reason: "dynamic_dependency", fault: { replace: [`${E}plugins/greet.js`, "'hello'", "'bye'"] } },
  { id: "S07", category: "generated", expect: "selected", fault: { write: ["coord/MANIFEST.json", "{ \"files\": 4 }\n"] } },
  { id: "S08", category: "config-seam", expect: "fallback", reason: "config_seam", fault: { write: ["coord/project.config.js", "module.exports = { limit: 4 };\n"] } },
  { id: "S09", category: "dependency", expect: "fallback", reason: "dependency_change", fault: { write: ["package-lock.json", "{ \"lockfileVersion\": 3 }\n"] } , exempt: { reviewed: "COORD-953", reason: "A lockfile edit is a dependency change: the policy routes it to the full gate (dependency_change), so no suite needs to fail; the fallback itself is the detection." } },
  { id: "S10", category: "test-only", expect: "selected", fault: { replace: [`${E}math.test.js`, "m.add(2, 3), 5", "m.add(2, 3), 6"] } },
  { id: "S11", category: "engine-module", expect: "fallback", reason: "t2_surface", fault: { replace: [`${E}upgrade.js`, "v + 1", "v + 2"] } },
  { id: "S12", category: "engine-module", expect: "fallback", reason: "always_enforced_guard", fault: { replace: [`${E}owner.js`, "a === b", "a !== b"] } },
  { id: "S13", category: "docs", expect: "selected", fault: { write: ["README.md", "# fixture, edited\n"] } , exempt: { reviewed: "COORD-953", reason: "A README edit is a documentation change: no suite reads README.md, so nothing can fail; the doc_pattern class covers it and the selection correctly selects no suites." } },
  { id: "S14", category: "engine-module", expect: "fallback", reason: "unknown_dependents", fault: { write: [`${E}orphan.js`, "exports.x = 1;\n"] } , exempt: { reviewed: "COORD-953", reason: "An orphan module no suite reaches has no detecting suite by construction; the unknown_dependents fallback forces the full gate, which is the detection." } },
];

// Changed paths of real incidents, replayed on this repository's graph.
const historical = [
  {
    id: "H-COORD-893", source: "COORD-893 foreign-release regression, caught by COORD-689 (missing-ticket-lock.test.js)",
    changes: [{ status: "M", path: `${E}agent-commands.js` }],
    catchers: [`${E}missing-ticket-lock.test.js`, `${E}agent-commands.test.js`],
  },
  {
    id: "H-COORD-872-finer-arms", source: "COORD-871..888 finer-arm coverage findings (COORD-872: session-start.js catch arms baselined with the move)",
    changes: [
      { status: "M", path: `${E}hooks/session-start.js` }, { status: "M", path: `${E}hooks/session-start.test.js` },
      { status: "M", path: `${E}engine-coverage-baseline-node22.json` }, { status: "M", path: `${E}engine-coverage-baseline-node24.json` },
    ],
    catchers: [`${E}hooks/session-start.test.js`],
  },
  {
    id: "H-COORD-872-finer-arms-code-only", source: "COORD-871..888 finer arms without the baseline edit: the exposing suite must be selected (the whole-suite ratchet stays authoritative, ADR 0021 decision 4)",
    changes: [{ status: "M", path: `${E}hooks/session-start.js` }],
    catchers: [`${E}hooks/session-start.test.js`],
  },
  {
    id: "H-COORD-916", source: "COORD-916 fixed-/tmp collisions in paths.test.js, caught by the concurrent regression in tmp-path-isolation.test.js",
    changes: [{ status: "M", path: "coord/scripts/paths.test.js" }],
    catchers: ["coord/scripts/paths.test.js", `${E}tmp-path-isolation.test.js`],
  },
  {
    id: "H-COORD-902-890", source: "COORD-902 vs COORD-890 runner interaction: the runner gained git-prerequisite.js, which runner-copy fixtures lacked",
    changes: [{ status: "M", path: `${E}test-runner.js` }, { status: "A", path: `${E}git-prerequisite.js` }],
    catchers: ["release/suite-inventory.test.js", "create-concord/install-plan.test.js"],
  },
];

module.exports = { repo, policy, registry, shimRegistry, seeded, historical };
