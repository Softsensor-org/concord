const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveEngineModule } = require("../paths.js");

test("COORD-514 engine resolver accepts legacy and engine locations and rejects collisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-engine-resolver-"));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "engine", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "scripts", "legacy.js"), "module.exports = 1;\n");
  assert.equal(resolveEngineModule(path.join(root, "coord"), "scripts/legacy.js"), path.join(root, "coord", "scripts", "legacy.js"));
  fs.writeFileSync(path.join(root, "coord", "engine", "scripts", "migrated.js"), "module.exports = 2;\n");
  assert.equal(resolveEngineModule(path.join(root, "coord"), "scripts/migrated.js"), path.join(root, "coord", "engine", "scripts", "migrated.js"));
  fs.writeFileSync(path.join(root, "coord", "scripts", "migrated.js"), "module.exports = 3;\n");
  assert.throws(() => resolveEngineModule(path.join(root, "coord"), "scripts/migrated.js"), /engine module collision/);
  assert.throws(() => resolveEngineModule(path.join(root, "coord"), "../outside.js"), /must stay relative/);
});

// ---------------------------------------------------------------------------
// COORD-863: engine-only resolution and the shim registry.
// ---------------------------------------------------------------------------
const {
  loadShimRegistry, validateShimRegistry, verifyShimRegistry, isStableEntrypoint, shimDelegates, renderShimSource,
  SHIM_REGISTRY_RELATIVE_PATH,
} = require("../paths.js");

const COORD = path.resolve(__dirname, "..");
const ROOT = path.resolve(COORD, "..");
const APPROVED_STABLE_ENTRYPOINTS = [
  "scripts/gov", "scripts/agent", "scripts/coord", "scripts/governance.js", "scripts/coord-cli.js",
  "scripts/hooks/*.js", "scripts/runtime-authority-hook.js", "scripts/test-runner.js",
  "scripts/check-template-sync.sh", "scripts/template-sync-discovery.js",
  // COORD-871: human-admin approval 2026-11-04 (adopter .mcp.json files spell these paths).
  "scripts/governance-mcp.js", "scripts/mcp-optional-launcher.js",
  // COORD-879 (human-admin approval 2026-11-03): adopter crontabs run this legacy path.
  "scripts/quality-propose-cron.js",
];

function shimFixture(t, { shims = [], stable = ["scripts/hooks/*.js"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord863-shim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
  // The real resolver, so the shim template below runs exactly as shipped.
  fs.copyFileSync(path.join(COORD, "paths.js"), path.join(coord, "paths.js"));
  const writeRegistry = (entries) => fs.writeFileSync(path.join(coord, SHIM_REGISTRY_RELATIVE_PATH),
    JSON.stringify({ schema_version: 1, stable_entrypoints: stable, shims: entries }, null, 2));
  writeRegistry(shims);
  return { root, coord, writeRegistry };
}

const SHIM_SOURCE = (rel) => [
  '"use strict";',
  'const path = require("node:path");',
  'const { resolveEngineModule } = require("../paths.js");',
  `module.exports = require(resolveEngineModule(path.resolve(__dirname, ".."), "engine-only:${rel}"));`,
  "",
].join("\n");

test("COORD-863 engine-only resolves only the engine copy and never falls back to the legacy file", (t) => {
  const { coord } = shimFixture(t);
  fs.writeFileSync(path.join(coord, "scripts", "legacy-only.js"), "module.exports = 1;\n");
  assert.throws(() => resolveEngineModule(coord, "engine-only:scripts/legacy-only.js"), /engine-only module not found/);
  fs.writeFileSync(path.join(coord, "engine", "scripts", "legacy-only.js"), "module.exports = 2;\n");
  assert.equal(resolveEngineModule(coord, "engine-only:scripts/legacy-only.js"), path.join(coord, "engine", "scripts", "legacy-only.js"));
  assert.throws(() => resolveEngineModule(coord, "engine-only:"), TypeError);
  assert.throws(() => resolveEngineModule(coord, "engine-only:../x.js"), /must stay relative/);
});

test("COORD-863 a registered same-name shim delegates to its engine target and unregistered divergence still collides", (t) => {
  const { coord, writeRegistry } = shimFixture(t);
  fs.writeFileSync(path.join(coord, "engine", "scripts", "moved.js"), "module.exports = { where: 'engine' };\n");
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), renderShimSource("scripts/moved.js", { deprecated: true }));
  assert.throws(() => resolveEngineModule(coord, "scripts/moved.js"), /engine module collision: both/);
  writeRegistry([{ path: "scripts/moved.js", target: "engine/scripts/moved.js", kind: "removable" }]);
  assert.equal(resolveEngineModule(coord, "scripts/moved.js"), path.join(coord, "engine", "scripts", "moved.js"));
  assert.equal(resolveEngineModule(coord, "./scripts/moved.js"), path.join(coord, "engine", "scripts", "moved.js"));
  // Legacy callers that require the old path get the engine module through the shim.
  assert.deepEqual(require(path.join(coord, "scripts", "moved.js")), { where: "engine" });
  assert.deepEqual(verifyShimRegistry(coord), []);
  // A registered path whose file stopped delegating is a provenance error, not a shim.
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), "module.exports = { where: 'fork' };\n");
  assert.throws(() => resolveEngineModule(coord, "scripts/moved.js"), /registered shim .* does not delegate/);
  assert.deepEqual(verifyShimRegistry(coord), ["registered shim scripts/moved.js does not delegate to engine/scripts/moved.js"]);
  // Naming the engine path in a comment is not delegation for a JavaScript shim.
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), "// see engine/scripts/moved.js\nmodule.exports = {};\n");
  assert.throws(() => resolveEngineModule(coord, "scripts/moved.js"), /does not delegate/);
  // A shell launcher delegates by naming its engine target.
  writeRegistry([
    { path: "scripts/moved.js", target: "engine/scripts/moved.js", kind: "removable" },
    { path: "scripts/hooks/launch", target: "engine/scripts/hooks/launch", kind: "removable" },
  ]);
  fs.mkdirSync(path.join(coord, "scripts", "hooks"));
  fs.mkdirSync(path.join(coord, "engine", "scripts", "hooks"));
  fs.writeFileSync(path.join(coord, "scripts", "hooks", "launch"), 'exec "$(dirname "$0")/../../engine/scripts/hooks/launch" "$@"\n');
  fs.writeFileSync(path.join(coord, "engine", "scripts", "hooks", "launch"), "#!/bin/sh\n");
  assert.equal(resolveEngineModule(coord, "scripts/hooks/launch"), path.join(coord, "engine", "scripts", "hooks", "launch"));
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), "module.exports = { where: 'fork' };\n");
  fs.rmSync(path.join(coord, "scripts", "moved.js"));
  fs.rmSync(path.join(coord, "engine", "scripts", "moved.js"));
  fs.rmSync(path.join(coord, "scripts", "hooks"), { recursive: true });
  fs.rmSync(path.join(coord, "engine", "scripts", "hooks"), { recursive: true });
  assert.deepEqual(verifyShimRegistry(coord), [
    "registered shim scripts/moved.js is missing",
    "registered shim target engine/scripts/moved.js is missing",
    "registered shim scripts/hooks/launch is missing",
    "registered shim target engine/scripts/hooks/launch is missing",
  ]);
});

test("COORD-864 a JavaScript shim delegates only when it is exactly the rendered template", (t) => {
  const rel = "scripts/moved.js";
  const shim = renderShimSource(rel);
  assert.equal(shim, SHIM_SOURCE(rel).replace("\nmodule.exports", "\n\nmodule.exports"), "the rendered template is the COORD-589 shim");
  assert.equal(shimDelegates(shim, rel), true);
  assert.equal(shimDelegates(renderShimSource(rel, { cli: true }), rel), true);
  // A shebang, whole-line `//` comments, blank lines, CRLF and trailing whitespace are not code.
  assert.equal(shimDelegates(`#!/usr/bin/env node\n// note\n  // indented note\n${shim.replace(/\n/g, "  \r\n\r\n")}`, rel), true);
  const nested = "scripts/adapters/moved.js";
  assert.match(renderShimSource(nested), /require\("\.\.\/\.\.\/paths\.js"\)/);
  assert.match(renderShimSource(nested), /path\.resolve\(__dirname, "\.\.", "\.\."\), "engine-only:scripts\/adapters\/moved\.js"/);
  for (const nearMiss of [
    `${shim}module.exports.extra = 1;\n`,
    shim.replace("engine-only:scripts/moved.js", "engine-only:scripts/other.js"),
    shim.replace("engine-only:", ""),
    shim.replace('"..")', '"..", "..")'),
    shim.replace("../paths.js", "../../paths.js"),
    shim.replace("));", ")); // trailing"),
    'module.exports = require(resolveEngineModule(root, "engine-only:scripts/moved.js"));\n',
    renderShimSource(nested),
    // COORD-864 review probe: a comment marker inside a string literal must not hide code.
    shim.replace('"use strict";', '"use strict/*"; evil(); "*/";'),
    // COORD-864 review probe: U+2028/U+2029 end a JavaScript line, so a "comment" could carry code.
    `// note\u2028globalThis.PWNED=1;\n${shim}`,
    `${shim}// note\u2029globalThis.PWNED=1;\n`,
    // Any character outside printable ASCII, tab, CR and LF is rejected.
    `// caf\u00e9\n${shim}`,
    `${shim}\u0000`,
    shim.replace('"use strict";', '"use strict";\u000b'),
    // Block comments and re-indentation are no longer ignored.
    `/* moved */\n${shim}`,
    shim.replace("module.exports", "  module.exports"),
    shim.replace("module.exports = ", "module.exports = /* x */ "),
  ]) assert.equal(shimDelegates(nearMiss, rel), false, nearMiss);
  assert.throws(() => renderShimSource("scripts/launch"), /only JavaScript shims/);
  assert.throws(() => renderShimSource("scripts/../x.js"), /normalized coord-relative/);

  // A rendered CLI shim re-dispatches the engine main only when it is the entrypoint.
  const { coord, writeRegistry } = shimFixture(t);
  writeRegistry([{ path: "scripts/launch.js", target: "engine/scripts/launch.js", kind: "removable" }]);
  fs.writeFileSync(path.join(coord, "engine", "scripts", "launch.js"),
    'function main() { process.stdout.write("engine-main:" + process.argv.slice(2).join(",")); }\nmodule.exports = { main };\n');
  fs.writeFileSync(path.join(coord, "scripts", "launch.js"), renderShimSource("scripts/launch.js", { cli: true, deprecated: true }));
  assert.deepEqual(verifyShimRegistry(coord), []);
  const run = require("node:child_process").spawnSync(process.execPath, [path.join(coord, "scripts", "launch.js"), "a", "b"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "engine-main:a,b");
  assert.equal(typeof require(path.join(coord, "scripts", "launch.js")).main, "function");
});

test("COORD-863 shim registry validation fails closed on every malformed entry", (t) => {
  const base = { schema_version: 1, stable_entrypoints: ["scripts/gov", "scripts/hooks/*.js"], shims: [] };
  const withShims = (...shims) => ({ ...base, shims });
  assert.equal(validateShimRegistry(base), base);
  const cases = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...base, schema_version: 2 }, /schema_version must be 1/],
    [{ ...base, shims: undefined }, /stable_entrypoints and shims arrays/],
    [{ ...base, stable_entrypoints: ["/abs/gov"] }, /normalized coord-relative/],
    [{ ...base, stable_entrypoints: [" scripts/gov"] }, /non-empty coord-relative/],
    [{ ...base, stable_entrypoints: ["scripts/*/x.js"] }, /final segment/],
    [{ ...base, stable_entrypoints: ["scripts/gov", "scripts/gov"] }, /duplicate stable entrypoint/],
    [withShims("scripts/x.js"), /entries must be objects/],
    [withShims({ path: "scripts/../x.js", target: "engine/x.js", kind: "removable" }), /normalized coord-relative/],
    [withShims({ path: "scripts\\x.js", target: "engine/scripts\\x.js", kind: "removable" }), /normalized coord-relative/],
    [withShims({ path: "engine/scripts/x.js", target: "engine/engine/scripts/x.js", kind: "removable" }), /legacy path outside engine/],
    [withShims({ path: "scripts/x.js", target: "engine/scripts/y.js", kind: "removable" }), /same-name engine path/],
    [withShims({ path: "scripts/x.js", target: "engine/scripts/x.js", kind: "temporary" }), /kind must be one of permanent\|removable/],
    [withShims({ path: "scripts/gov", target: "engine/scripts/gov", kind: "removable" }), /stable entrypoint and must be permanent/],
    [withShims({ path: "scripts/hooks/post-bash.js", target: "engine/scripts/hooks/post-bash.js", kind: "removable" }), /stable entrypoint and must be permanent/],
    [withShims({ path: "scripts/x.js", target: "engine/scripts/x.js", kind: "permanent" }), /not a stable entrypoint and must be removable/],
    [withShims(
      { path: "scripts/x.js", target: "engine/scripts/x.js", kind: "removable" },
      { path: "scripts/x.js", target: "engine/scripts/x.js", kind: "removable" },
    ), /duplicate shim path/],
  ];
  for (const [registry, pattern] of cases) assert.throws(() => validateShimRegistry(registry), pattern, JSON.stringify(registry));
  assert.equal(isStableEntrypoint(base, "scripts/hooks/post-bash.js"), true);
  assert.equal(isStableEntrypoint(base, "scripts/hooks/hook-lib.test.js"), false, "test suites are never entrypoints");
  assert.equal(isStableEntrypoint(base, "scripts/hooks/nested/x.js"), false);
  assert.equal(isStableEntrypoint(base, "scripts/governance.js"), false);

  const { coord } = shimFixture(t);
  fs.rmSync(path.join(coord, SHIM_REGISTRY_RELATIVE_PATH));
  assert.deepEqual(loadShimRegistry(coord).shims, [], "an install that predates the registry has no shims");
  fs.writeFileSync(path.join(coord, SHIM_REGISTRY_RELATIVE_PATH), "{ not json");
  assert.throws(() => loadShimRegistry(coord), /is not valid JSON/);
  fs.rmSync(path.join(coord, SHIM_REGISTRY_RELATIVE_PATH));
  fs.mkdirSync(path.join(coord, SHIM_REGISTRY_RELATIVE_PATH));
  assert.throws(() => loadShimRegistry(coord), /EISDIR/);
});

test("COORD-863 the shipped registry pins the approved stable-entrypoint set and every shim is live", () => {
  const registry = loadShimRegistry(COORD);
  assert.deepEqual(registry.stable_entrypoints, APPROVED_STABLE_ENTRYPOINTS);
  for (const pattern of registry.stable_entrypoints) {
    const dir = path.join(COORD, path.dirname(pattern));
    const matched = fs.readdirSync(dir).some((name) => isStableEntrypoint({ stable_entrypoints: [pattern] }, `${path.dirname(pattern)}/${name}`));
    assert.ok(matched, `stable entrypoint ${pattern} matches no file`);
  }
  assert.deepEqual(verifyShimRegistry(COORD, registry), []);
});

// COORD-821 style: once a removable shim exists, nothing live may still spell
// its legacy path; the only holders are the shim, the registry, the integrity
// inventories that must name it, the self-contained demo snapshot (whose
// relative paths name its own copies) and records that describe history.
const SHIM_REFERENCE_HOLDERS = [
  "coord/engine/shim-registry.json", "coord/TEMPLATE_SYNC_MANIFEST.json", "coord/engine-pin.json",
  "coord/docs/architecture/COORD-513-seam-inventory.json", "release/suite-inventory.json",
  // Coverage identities are logical (engine/ stripped), so a moved module keeps its key.
  "coord/engine/scripts/engine-coverage-baseline.json", "coord/engine/scripts/engine-coverage-baseline-node22.json",
  "coord/engine/scripts/engine-coverage-baseline-node24.json",
  // COORD-866: the engine-coverage exclusion contract and its doc name the same logical key for the moved test-support helper.
  "coord/engine/scripts/engine-coverage.js", "coord/engine/scripts/engine-coverage.test.js", "coord/product/ENGINE_COVERAGE.md",
  "CHANGELOG.md", "coord/QUESTIONS.md", "coord/board/tasks.json",
  // COORD-868: the dated template-feedback and test-maturity ledgers record paths as they were.
  "coord/TEMPLATE_FEEDBACK.md", "coord/TEST_MATURITY.md",
  // COORD-864: the rendered active-plan view mirrors plan records (coord/.runtime/plans), which list moved paths.
  "coord/PLAN.md",
];
const SHIM_REFERENCE_HOLDER_DIRS = [
  "examples/demo/", "coord/.runtime/", "coord/board/plans/", "coord/docs/decisions/", "coord/docs/evidence/", "coord/evidence/",
  "coord/docs/reviews/", "coord/history/", "coord/prompts/", "coord/rendered/",
];

function isShimReferenceHolder(rel, registry) {
  return registry.shims.some((shim) => `coord/${shim.path}` === rel) || SHIM_REFERENCE_HOLDERS.includes(rel) ||
    SHIM_REFERENCE_HOLDER_DIRS.some((dir) => rel.startsWith(dir));
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A match is the shim's file name (or, for a JS module, its extensionless
// require spelling, which needs a directory prefix) plus the path segments
// written directly before it. It
// routes through the shim when that spelling resolves to the legacy file from
// the referencing file's directory, the repo root or coord/. Spellings handed
// to resolveEngineModule (or written as engine-only:) resolve to the engine
// target and are not routed through the shim.
function removableShimReferencesIn(root, rel, text, registry) {
  const removable = registry.shims.filter((shim) => shim.kind === "removable");
  if (removable.length === 0) return [];
  const legacy = new Set();
  const stems = new Set();
  const extensionless = new Set();
  for (const shim of removable) {
    const abs = path.join(root, "coord", shim.path);
    legacy.add(abs);
    const base = path.posix.basename(shim.path);
    stems.add(escapeRegExp(base));
    if (base.endsWith(".js")) {
      legacy.add(abs.slice(0, -3));
      stems.add(escapeRegExp(base.slice(0, -3)));
      extensionless.add(base.slice(0, -3));
    }
  }
  const coordRelative = [...legacy].map((abs) => path.relative(path.join(root, "coord"), abs).split(path.sep).join("/"));
  // COORD-867: a spelling that continues into a nested directory names that directory, not a module of the same name.
  const pattern = new RegExp(`(?<![\\w./-])(/?(?:[\\w.-]+/)*)(${[...stems].join("|")})(?![\\w-/]|\\.\\w)`, "g");
  const hits = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const spelled = match[1] + match[2];
      // Without a directory prefix only a quoted or link-target spelling is a
      // path (path.join(__dirname, "x.js"), [x](x.js)); a bare name in prose is not.
      if (!match[1] && (extensionless.has(match[2]) || !/["'`(]$/.test(line.slice(0, match.index)))) continue;
      if (line.slice(0, match.index).endsWith("engine-only:")) continue;
      if (new RegExp(`resolveEngineModule\\(.*["'\`]${escapeRegExp(spelled)}["'\`]`).test(line)) continue;
      const routed = spelled.startsWith("/")
        ? coordRelative.some((rest) => spelled.endsWith(`/coord/${rest}`))
        : [path.dirname(path.join(root, rel)), ...(match[1] ? [root, path.join(root, "coord")] : [])]
          .some((base) => legacy.has(path.resolve(base, spelled)));
      if (routed) hits.push(`${rel}:${index + 1}: ${spelled}`);
    }
  });
  return hits;
}

function listTrackedFiles() {
  try {
    return require("node:child_process").execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory() && ![".git", "node_modules", ".worktrees", ".runtime"].includes(entry.name)) walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

test("COORD-863: the shim reference scan recognises every spelling that routes through a removable shim", () => {
  const root = "/srv/fixture";
  const registry = { stable_entrypoints: ["scripts/gov"], shims: [
    { path: "scripts/moved.js", target: "engine/scripts/moved.js", kind: "removable" },
    { path: "scripts/gov", target: "engine/scripts/gov", kind: "permanent" },
  ] };
  const sample = [
    'const a = require("./moved.js"); const b = require("./moved");',
    "Run node coord/scripts/moved.js; see /opt/x/coord/scripts/moved.js.",
    'const c = require(resolveEngineModule(path.resolve(__dirname, ".."), "scripts/moved.js"));',
    "The moved helper is documented in moved.js; a bare moved is a word.",
    'const d = path.join(__dirname, "moved.js"); see [the helper](moved.js).',
    'module.exports = require(resolveEngineModule(root, "engine-only:scripts/moved.js"));',
    'require("../engine/scripts/moved.js"); require("./moved.test.js"); require("./moved-helper.js");',
    'require("./moved/nested.js"); see coord/scripts/moved/nested.js (a directory named like the module).',
    "coord/scripts/gov is a permanent entrypoint.",
  ].join("\n");
  assert.deepEqual(removableShimReferencesIn(root, "coord/scripts/caller.js", sample, registry), [
    "coord/scripts/caller.js:1: ./moved.js",
    "coord/scripts/caller.js:1: ./moved",
    "coord/scripts/caller.js:2: coord/scripts/moved.js",
    "coord/scripts/caller.js:2: /opt/x/coord/scripts/moved.js",
    "coord/scripts/caller.js:5: moved.js",
    "coord/scripts/caller.js:5: moved.js",
  ]);
  // From coord/engine/scripts the same relative spelling names the engine target.
  assert.deepEqual(removableShimReferencesIn(root, "coord/engine/scripts/caller.js", 'require("./moved.js")', registry), []);
  assert.deepEqual(removableShimReferencesIn(root, "coord/engine/scripts/caller.js", 'require("../../scripts/moved.js")', registry), [
    "coord/engine/scripts/caller.js:1: ../../scripts/moved.js",
  ]);
  assert.equal(isShimReferenceHolder("coord/scripts/moved.js", registry), true);
  assert.equal(isShimReferenceHolder("coord/engine-pin.json", registry), true);
  assert.equal(isShimReferenceHolder("coord/engine/scripts/engine-coverage-baseline-node24.json", registry), true);
  assert.equal(isShimReferenceHolder("examples/demo/coord/scripts/moved.js", registry), true);
  assert.equal(isShimReferenceHolder("coord/scripts/caller.js", registry), false);
  assert.deepEqual(removableShimReferencesIn(root, "x.md", "coord/scripts/moved.js", { shims: [registry.shims[1]] }), []);
});

// Exact legacy spellings retained only where an executable test or immutable
// fixture must exercise or describe the removable-shim seam. Every entry is
// checked against the scanner output: new hits and stale exceptions both fail.
const EXPECTED_LEGACY_SHIM_PROBES = Object.freeze([
  [["coord", "engine", "scripts", "__fixtures__", "landing-decision", "coord-1024-0b57a9f2-readme.patch"].join("/"), 31, ["coord", "scripts", "decision-extractor" + ".js"].join("/"), "immutable historical patch fixture"],
  [["coord", "engine", "scripts", "__fixtures__", "prodloc-budget-equivalence.json"].join("/"), 271, ["coord", "scripts", "lifecycle" + ".js"].join("/"), "captured refusal text proves carried budget provenance"],
  [["coord", "engine", "scripts", "__fixtures__", "prodloc-budget-equivalence.json"].join("/"), 291, ["coord", "scripts", "lifecycle" + ".js"].join("/"), "captured refusal text proves carried budget provenance"],
  [["coord", "engine", "scripts", "__fixtures__", "prodloc-budget-harness.js"].join("/"), 18, ["coord", "scripts", "lifecycle" + ".js"].join("/"), "test compares registered legacy and engine targets"],
  [["coord", "engine", "scripts", "architecture-audit.test.js"].join("/"), 26, ["coord", "scripts", "journal" + ".js"].join("/"), "test asserts legacy shim is not an engine production module"],
  [["coord", "engine", "scripts", "evidence-export-entrypoints.test.js"].join("/"), 91, ["coord", "scripts", "evidence-export" + ".mjs"].join("/"), "test compares deprecated shim CLI with engine entrypoint"],
  [["coord", "engine", "scripts", "hooks-authority-shims.test.js"].join("/"), 77, ["coord", "scripts", "mutation-policy" + ".js"].join("/"), "test compares legacy authority shim with engine target"],
  [["coord", "engine", "scripts", "lifecycle-closeout-shims.test.js"].join("/"), 84, ["coord", "scripts", "prodloc-closeout" + ".js"].join("/"), "test compares legacy closeout shim with engine target"],
  [["coord", "engine", "scripts", "lifecycle-closeout-shims.test.js"].join("/"), 119, ["coord", "scripts", "dispatch" + ".mjs"].join("/"), "test verifies legacy dispatch deprecation warning"],
  [["coord", "engine", "scripts", "shim-deprecation.test.js"].join("/"), 22, ["scripts", "closeout" + ".js"].join("/"), "test renders deprecation template for a removable shim"],
  [["coord", "engine", "scripts", "shim-deprecation.test.js"].join("/"), 32, ["scripts", "closeout-summary" + ".js"].join("/"), "test renders deprecated CLI template"],
  [["coord", "engine", "scripts", "shim-deprecation.test.js"].join("/"), 33, ["scripts", "evidence-export" + ".mjs"].join("/"), "test renders deprecated ESM template"],
  [["coord", "engine", "scripts", "shim-deprecation.test.js"].join("/"), 44, ["scripts", "closeout" + ".js"].join("/"), "test compares removable and permanent shim templates"],
  [["coord", "engine", "scripts", "shim-deprecation.test.js"].join("/"), 72, ["scripts", "closeout" + ".js"].join("/"), "test verifies every removable shim against rendered output"],
]);

test("COORD-863: no live reference in the tree routes through a removable shim", () => {
  const registry = loadShimRegistry(COORD);
  const hits = [];
  if (registry.shims.some((shim) => shim.kind === "removable")) {
    for (const rel of listTrackedFiles()) {
      if (isShimReferenceHolder(rel, registry)) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      } catch {
        continue;
      }
      hits.push(...removableShimReferencesIn(ROOT, rel, text, registry));
    }
  }
  const expected = EXPECTED_LEGACY_SHIM_PROBES.map(([file, line, spelling]) => `${file}:${line}: ${spelling}`).sort();
  assert.equal(new Set(expected).size, expected.length, "legacy-probe exception entries must be unique");
  assert.deepEqual(hits.sort(), expected, `unexpected or stale legacy shim reference:\n${hits.join("\n")}`);
});

// The public cut deliberately excludes this donor-only migration census.
const SEAM_INVENTORY = path.join(ROOT, "coord/docs/architecture/COORD-513-seam-inventory.json");
test("COORD-863: every registered shim and its engine target are classified in the seam inventory", {
  skip: !fs.existsSync(SEAM_INVENTORY) && "Donor migration census is excluded by build-public-release.sh",
}, () => {
  const inventory = JSON.parse(fs.readFileSync(SEAM_INVENTORY, "utf8"));
  const classified = new Map(inventory.entries.map((entry) => [entry.path, entry.classification]));
  assert.equal(classified.size, inventory.entries.length, "the inventory classifies each path once");
  const missing = [];
  for (const shim of loadShimRegistry(COORD).shims) {
    for (const rel of [shim.path, shim.target]) if (!classified.has(`coord/${rel}`)) missing.push(`coord/${rel}`);
  }
  assert.deepEqual(missing, []);
  for (const rel of ["coord/engine/shim-registry.json", "coord/paths.js"]) assert.ok(classified.has(rel), rel);
});

test("COORD-872: the fail-closed hook shim template delegates only as rendered for its own path", () => {
  const rel = "scripts/hooks/guard.js";
  for (const cli of [false, true]) {
    const shim = renderShimSource(rel, { cli, failClosed: true });
    assert.equal(shimDelegates(shim, rel), true, `cli=${cli}`);
    assert.equal(shimDelegates(`#!/usr/bin/env node\n// header\n${shim}`, rel), true, "comments and shebang are ignored");
    assert.equal(shimDelegates(shim, "scripts/hooks/other.js"), false, "the template names only its own path");
    for (const tampered of [
      shim.replace("process.exit(2);", "process.exit(0);"),
      shim.replace("  if (require.main !== module) throw error;\n", ""),
      shim.replace("module.exports = engine;", "module.exports = engine; globalThis.PWNED = 1;"),
    ]) assert.equal(shimDelegates(tampered, rel), false, tampered);
  }
  assert.match(renderShimSource(rel, { cli: true, failClosed: true }), /process\.exit\(2\);/);
});

// COORD-971: the two fail-closed hook shims are the renderer's output byte for byte,
// and only the barrier shim is lock-gated (the guard always blocks).
test("COORD-971: the fail-closed barrier and guard shims are byte-identical to the renderer output", () => {
  for (const rel of ["scripts/runtime-authority-hook.js", "scripts/hooks/pre-bash-guard.js"]) {
    const onDisk = fs.readFileSync(path.join(COORD, rel), "utf8");
    assert.equal(onDisk, renderShimSource(rel, { cli: true, failClosed: true }), rel);
  }
  const barrier = renderShimSource("scripts/runtime-authority-hook.js", { cli: true, failClosed: true });
  assert.match(barrier, /process\.exit\(governedWorkInFlight\(\) \? 2 : 0\);/);
  const guard = renderShimSource("scripts/hooks/pre-bash-guard.js", { cli: true, failClosed: true });
  assert.match(guard, /process\.exit\(2\);/);
  assert.doesNotMatch(guard, /governedWorkInFlight/);
});

// COORD-879: coord/scripts/quality-propose-cron.js is a permanent stable
// entrypoint because adopter crontabs run it by that path. Run the shipped shim
// as a process from a disposable install (the shipped registry, resolver, shim
// and engine modules, a stub gov and a scratch board) and check its documented
// exit codes: 0 when every proposal files, 1 when a gov filing fails, 2 when
// the board cannot be read. The stub gov keeps the live board untouched.
const { buildQualityCronInstall } = require("../engine/scripts/__fixtures__/quality-cron-install.js");

test("COORD-879: the legacy quality-propose-cron path runs as a CLI with its documented exit codes", {
  skip: process.platform === "win32" && "the stub gov is a POSIX shell script",
}, (t) => {
  const registry = loadShimRegistry(COORD);
  assert.equal(isStableEntrypoint(registry, "scripts/quality-propose-cron.js"), true);
  assert.equal(registry.shims.find((shim) => shim.path === "scripts/quality-propose-cron.js").kind, "permanent");

  const { root, coord, boardPath: board, env, readCalls } = buildQualityCronInstall(t, { label: "coord879-cron" });
  const run = (extra = {}) => require("node:child_process").spawnSync(process.execPath,
    [path.join(coord, "scripts", "quality-propose-cron.js")], { cwd: root, encoding: "utf8", env: { ...env, ...extra } });

  const ok = run();
  assert.ifError(ok.error);
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  assert.match(ok.stdout, /mode=APPLY status=proposed floor=warn cap=3/);
  assert.match(ok.stdout, /FILED QSCAN-001/);
  const filed = readCalls();
  assert.ok(filed.length >= 1 && filed.length <= 3, `the cadence cap bounds the filings: ${filed.length}`);
  for (const line of filed) assert.match(line, /^file-ticket .*--status proposed /);

  const refused = run({ FAKE_GOV_STATUS: "1" });
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(refused.stderr, /FAILED to file .*stub gov refused/);

  fs.rmSync(board);
  const unreadable = run();
  assert.equal(unreadable.status, 2, unreadable.stderr || unreadable.stdout);
  assert.match(unreadable.stderr, /quality-scan: could not read --board /);
});

// ---------------------------------------------------------------------------
// COORD-878: ES module shims.
// ---------------------------------------------------------------------------
test("COORD-878 an ES module shim re-exports named and default bindings and delegates only as the rendered template", (t) => {
  const rel = "scripts/moved.mjs";
  const target = '"../engine/scripts/moved.mjs"';
  assert.equal(renderShimSource(rel), `export * from ${target};\nexport { default } from ${target};\n`);
  assert.equal(renderShimSource(rel, { cli: true }), [
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `import * as engine from ${target};`,
    "",
    `export * from ${target};`,
    `export { default } from ${target};`,
    "if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) engine.main();",
    "",
  ].join("\n"));
  assert.match(renderShimSource("scripts/adapters/moved.mjs"), /^export \* from "\.\.\/\.\.\/engine\/scripts\/adapters\/moved\.mjs";$/m);
  // CommonJS extensions keep the CommonJS template.
  assert.match(renderShimSource("scripts/moved.cjs"), /require\(resolveEngineModule\(path\.resolve\(__dirname, "\.\."\), "engine-only:scripts\/moved\.cjs"\)\)/);

  const shim = renderShimSource(rel);
  const cli = renderShimSource(rel, { cli: true });
  assert.equal(shimDelegates(shim, rel), true);
  assert.equal(shimDelegates(cli, rel), true);
  assert.equal(shimDelegates(`#!/usr/bin/env node\n// note\n${cli.replace(/\n/g, "  \r\n\r\n")}`, rel), true);
  for (const nearMiss of [
    `${shim}export const extra = 1;\n`,
    shim.replace(`export { default } from ${target};\n`, ""),
    shim.replace(/moved\.mjs/g, "other.mjs"),
    shim.replace(/"\.\.\/engine\//g, '"../../engine/'),
    shim.replace(/"\.\.\/engine\/scripts\//g, '"./'),
    renderShimSource("scripts/adapters/moved.mjs"),
    cli.replace("if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ", ""),
    cli.replace("engine.main();", "engine.main(); globalThis.PWNED = 1;"),
    `import "./evil.mjs";\n${shim}`,
    `${shim}// note globalThis.PWNED=1;\n`,
    // The CommonJS template is not delegation for an ES module path.
    SHIM_SOURCE(rel),
  ]) assert.equal(shimDelegates(nearMiss, rel), false, nearMiss);

  // A registered ES module shim resolves, verifies and runs exactly like its engine target.
  const { coord, writeRegistry } = shimFixture(t);
  writeRegistry([{ path: rel, target: `engine/${rel}`, kind: "removable" }]);
  const enginePath = path.join(coord, "engine", rel);
  const legacyPath = path.join(coord, rel);
  fs.writeFileSync(enginePath, [
    "export const where = 'engine';",
    "export function main() { process.stdout.write('engine-main:' + process.argv.slice(2).join(',')); process.exitCode = 7; }",
    "export default { where, main };",
    "",
  ].join("\n"));
  fs.writeFileSync(legacyPath, renderShimSource(rel, { cli: true, deprecated: true }));
  assert.deepEqual(verifyShimRegistry(coord), []);
  assert.equal(resolveEngineModule(coord, rel), enginePath);
  const { spawnSync } = require("node:child_process");
  const viaShim = spawnSync(process.execPath, [legacyPath, "a", "b"], { encoding: "utf8" });
  const viaEngine = spawnSync(process.execPath, [enginePath, "a", "b"], { encoding: "utf8" });
  assert.equal(viaShim.status, 7, viaShim.stderr);
  assert.equal(viaShim.stdout, "engine-main:a,b");
  assert.equal(viaEngine.status, 0, "the engine module has no entrypoint guard of its own in this fixture");
  // Importing the shim re-exports the same bindings and never runs main.
  const probe = [
    `const shim = await import(${JSON.stringify(require("node:url").pathToFileURL(legacyPath).href)});`,
    `const engine = await import(${JSON.stringify(require("node:url").pathToFileURL(enginePath).href)});`,
    "process.stdout.write(JSON.stringify([shim.where, shim.main === engine.main, shim.default === engine.default, Object.keys(shim).sort()]));",
  ].join("\n");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(JSON.parse(imported.stdout), ["engine", true, true, ["default", "main", "where"]]);
  // A legacy ES module that stopped delegating is reported and collides.
  fs.writeFileSync(legacyPath, "export const where = 'fork';\nexport default {};\n");
  assert.deepEqual(verifyShimRegistry(coord), [`registered shim ${rel} does not delegate to engine/${rel}`]);
  assert.throws(() => resolveEngineModule(coord, rel), /registered shim .* does not delegate/);
});
