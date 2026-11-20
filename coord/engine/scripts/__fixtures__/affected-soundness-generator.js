"use strict";

// COORD-953: seeded generator of synthetic engine trees for the affected-selector soundness
// property. Each tree is a map of repo-relative paths to source text, plus the GROUND TRUTH
// the generator wrote: which files really load which (`edges`), and which files hold a dynamic
// load whose target the generator cannot name (`unknown`). The test's oracle reads only that
// truth, never the graph under test. Every edge kind affected-graph.js extracts is emitted,
// plus the escaping kinds (dynamic, non-literal shim, computed spawn) that must fail closed.

const path = require("node:path");

const DIR = "coord/engine/scripts";
const SEED = 0x953;

// Edges the graph extracts (static require / import / import(), shim and engine-only
// resolveEngineModule, path and string mentions, spawned scripts, config reads, and a dynamic
// require whose constant names a loadable file).
const KNOWN_KINDS = ["require", "import", "esm-from", "shim", "engine-only", "data", "spawn", "config", "string-path", "known-dynamic"];
// Loads the graph cannot name: they must always produce the full gate.
const UNKNOWN_KINDS = ["unknown-env", "unknown-import", "unknown-decoy", "unknown-shim", "unknown-spawn"];

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (rand, n) => Math.floor(rand() * n);
const pickOne = (rand, list) => list[range(rand, list.length)];

// One source line that loads `to` from `from` by the given kind (or an unknown load).
function edgeLine(kind, from, to, c) {
  const rel = (target) => {
    const r = path.posix.relative(path.posix.dirname(from), target);
    return r.startsWith(".") ? r : `./${r}`;
  };
  const eng = to.slice("coord/engine/".length);
  switch (kind) {
    case "require": case "suite": return `require('${rel(to)}');`;
    case "import": return `import('${rel(to)}');`;
    case "esm-from": return `import v${c} from '${rel(to)}';`;
    case "shim": return `require(resolveEngineModule(path.join(__dirname, '..', '..'), '${eng}'));`;
    case "engine-only": return `require(resolveEngineModule(__dirname, 'engine-only:${eng}'));`;
    case "data": return `fs.readFileSync(path.join(__dirname, '${rel(to)}'));`;
    case "spawn": return `spawnSync(process.execPath, [path.join(__dirname, '${rel(to)}')]);`;
    case "config": return `require(path.join(__dirname, '${rel(to)}'));`;
    case "string-path": return `const ref${c} = '${to}';`;
    case "known-dynamic": return `const NAME${c} = '${rel(to)}'; require(path.join(__dirname, NAME${c}));`;
    default: throw new Error(`unknown edge kind ${kind}`);
  }
}

function unknownLine(kind, c) {
  switch (kind) {
    case "unknown-env": return `require(process.env.HELPER_${c});`;
    case "unknown-import": return `import(spec${c});`;
    // The constant masks the dynamic site: the file names a loadable code file, which the
    // graph used to read as "known". The actual target is `pick(...)`, which it cannot name.
    case "unknown-decoy": return `const DECOY${c} = 'decoy.js'; require(path.join(__dirname, pick(process.argv[${c}])));`;
    case "unknown-shim": return `require(resolveEngineModule(path.join(__dirname, '..', '..'), pick('scripts/m' + process.argv[${c}])));`;
    case "unknown-spawn": return `spawnSync(process.execPath, [path.join(__dirname, pick(process.argv[${c}]))]);`;
    default: throw new Error(`unknown unknown-kind ${kind}`);
  }
}

// Emits one file's source, recording its truth edges and unknown loads.
function emit(tree, from, rand, unknown) {
  const lines = ["\"use strict\";"];
  const out = new Set();
  tree.edges.set(from, out);
  const isSuite = tree.suites.includes(from);
  const count = 1 + range(rand, 3);
  for (let c = 0; c < count; c++) {
    const kind = isSuite && rand() < 0.2 ? "suite" : pickOne(rand, KNOWN_KINDS);
    let to;
    if (kind === "data") to = pickOne(rand, tree.data);
    else if (kind === "config") to = tree.config;
    else if (kind === "suite") to = pickOne(rand, tree.suites.filter((x) => x !== from));
    else to = pickOne(rand, tree.modules.filter((x) => x !== from));
    lines.push(edgeLine(kind, from, to, c));
    out.add(to);
  }
  if (unknown && rand() < 0.3) {
    lines.push(unknownLine(pickOne(rand, UNKNOWN_KINDS), count));
    tree.unknown.add(from);
  }
  tree.files[from] = `${lines.join("\n")}\n`;
}

// A synthetic engine tree. Modules live in DIR or DIR/sub, so a changed file and an unknown
// load may sit in different directories; suites are the t<k>.test.js files of DIR.
function genTree(seed, { unknown = false } = {}) {
  const rand = prng(seed);
  const modules = [];
  const n = 4 + range(rand, 3);
  for (let i = 0; i < n; i++) modules.push(rand() < 0.5 ? `${DIR}/m${i}.js` : `${DIR}/sub/m${i}.js`);
  const suites = [];
  const s = 2 + range(rand, 3);
  for (let k = 0; k < s; k++) suites.push(`${DIR}/t${k}.test.js`);
  const tree = {
    files: {}, edges: new Map(), unknown: new Set(), modules, suites,
    data: [`${DIR}/data/d0.json`, `${DIR}/data/d1.json`], config: "coord/config.json", decoy: `${DIR}/decoy.js`,
  };
  for (const f of tree.data) { tree.files[f] = "[]\n"; tree.edges.set(f, new Set()); }
  tree.files[tree.config] = "{}\n";
  tree.edges.set(tree.config, new Set());
  tree.files[tree.decoy] = "exports.decoy = 1;\n";
  tree.edges.set(tree.decoy, new Set());
  for (const f of [...modules, ...suites]) emit(tree, f, rand, unknown);
  return tree;
}

// Applies a change set to `tree`. mode "modify": content edits only. mode "mixed": also
// deletes, renames and adds an unrelated file. Returns the head tree and the changed paths in
// the shape selectAffected takes. Truth edges of unchanged files carry over; a rename keeps
// its outgoing edges while references to the old name dangle.
function mutate(tree, seed, mode) {
  const rand = prng(seed);
  const head = {
    files: { ...tree.files }, edges: new Map([...tree.edges].map(([k, v]) => [k, new Set(v)])),
    unknown: new Set(tree.unknown), suites: tree.suites, modules: tree.modules,
  };
  const changes = [];
  const code = [...tree.modules, ...tree.suites];
  const editable = [...code, ...tree.data, tree.config];
  const picks = new Set();
  const edits = mode === "modify" ? 1 + range(rand, 2) : 1 + range(rand, 3);
  for (let i = 0; i < edits; i++) {
    const op = mode === "modify" ? "M" : pickOne(rand, ["M", "D", "R", "A"]);
    if (op === "M") {
      const f = pickOne(rand, editable);
      if (picks.has(f)) continue;
      picks.add(f);
      head.files[f] = `${head.files[f]}// v2\n`;
      changes.push({ status: "M", path: f });
    } else if (op === "D") {
      const f = pickOne(rand, tree.modules);
      if (picks.has(f)) continue;
      picks.add(f);
      delete head.files[f];
      head.edges.delete(f);
      head.unknown.delete(f);
      changes.push({ status: "D", path: f });
    } else if (op === "R") {
      const f = pickOne(rand, tree.modules);
      if (picks.has(f)) continue;
      picks.add(f);
      const to = path.posix.join(path.posix.dirname(f), `r_${path.posix.basename(f)}`);
      head.files[to] = head.files[f];
      delete head.files[f];
      head.edges.set(to, head.edges.get(f));
      head.edges.delete(f);
      if (head.unknown.delete(f)) head.unknown.add(to);
      changes.push({ status: "R", path: to, old_path: f });
    } else {
      const to = `${DIR}/x${i}.js`;
      head.files[to] = "exports.x = 1;\n";
      head.edges.set(to, new Set());
      changes.push({ status: "A", path: to });
    }
  }
  head.suites = tree.suites.filter((f) => head.files[f] !== undefined);
  return { head, changes };
}

// Single-kind fixtures: a suite reaches `host`, which holds the unknown load, and a second
// suite reaches the changed `other`. The selection must then be the full gate.
function unknownKindFixture(kind) {
  const hostDir = `${DIR}/plugins`;
  const loads = {
    "env": "require(process.env.HELPER);",
    "import-variable": "import(spec);",
    "decoy-masked": "const DECOY = 'decoy.js'; require(path.join(__dirname, pick(process.argv[2])));",
    "shim-nonliteral": "require(resolveEngineModule(path.join(__dirname, '..', '..'), pick('scripts/x')));",
    "spawn-computed": "spawnSync(process.execPath, [path.join(__dirname, pick(process.argv[2]))]);",
  };
  return {
    files: {
      [`${hostDir}/host.js`]: `"use strict";\nconst path = require('node:path');\n${loads[kind]}\n`,
      [`${hostDir}/decoy.js`]: "exports.decoy = 1;\n",
      [`${DIR}/t0.test.js`]: "require('./plugins/host.js');\n",
      [`${DIR}/t1.test.js`]: "require('./other.js');\n",
      [`${DIR}/other.js`]: "exports.other = 1;\n",
    },
    changed: `${DIR}/other.js`,
  };
}

// Seeded faults the fault suite expects to escape detection; each must carry a reviewed reason.
const SEEDED_EXEMPTIONS = Object.freeze(["S09", "S13", "S14"]);

module.exports = {
  DIR, SEED, KNOWN_KINDS, UNKNOWN_KINDS, SEEDED_EXEMPTIONS, prng, genTree, mutate, unknownKindFixture,
};
