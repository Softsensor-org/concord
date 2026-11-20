"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");

const COORD_DIR = path.resolve(__dirname, "..", "..");
const ROOT = path.resolve(COORD_DIR, "..");
const gr = require(resolveEngineModule(COORD_DIR, "scripts/guard-registry.js"));

function realRegistry() {
  return gr.loadRegistry(ROOT);
}

function sink() {
  let text = "";
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}

// A minimal workspace the scanner can read: one engine module, the stage
// sources it parses, a registry and the schema.
function fixture(t, { engine = "", registry = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("coord/engine/scripts/mod.js", engine);
  write("coord/engine/scripts/mod.test.js", "fail('refused in a test');\n");
  write("coord/engine/scripts/__fixtures__/f.js", "fail('refused in a fixture');\n");
  write("coord/engine/scripts/lifecycle-help.js", "const help = 'refused in usage text';\n");
  write("coord/engine/scripts/test-runner.js", "const overallPass = testsPassed && treeViolations.length === 0;\n");
  write("coord/engine/scripts/arch-checks.js", 'const CHECKS = Object.freeze([\n  "size",\n]);\n');
  write("release/check-public-release.sh", "CHECKS=(board)\n");
  write("release/verify-upgrade-bridge.sh", 'step "0. start"\n');
  write("release/verify-dual-release.sh", '# guard:demo-stage\n[ -d x ] || fail "missing x"\n');
  write(gr.SCHEMA_REL, fs.readFileSync(path.join(ROOT, gr.SCHEMA_REL), "utf8"));
  const base = JSON.parse(JSON.stringify(realRegistry().registry));
  const reg = registry || { ...base, review: { proposed_merges: [], retirement_candidates: [] }, guards: [] };
  write(gr.REGISTRY_REL, JSON.stringify(reg, null, 2));
  fs.mkdirSync(path.join(root, path.dirname(gr.VIEW_REL)), { recursive: true });
  return { root, write };
}

function guard(id, extra = {}) {
  return {
    id, title: id, kind: "verb-guard", editions: ["Community", "Enterprise"], tier: "T1", always_enforced: false, verbs: ["start"], intent: "i", answers: ["COORD-914"], overlaps: [],
    locations: [{ file: "coord/engine/scripts/mod.js", function: "f", marker: false }],
    cost: { frequency: "1 check per landing", wall_time: null, tests: null, cost_status: "unknown", source: null, note: "Not measured." },
    remedy: "r", retirement_criteria: "rc", review_date: "2027-02-06", ...extra,
  };
}

// The real registry's top level, with its Enterprise naming cleared so a
// fixture's own guards decide it.
function fixtureRegistry(guards, review = { proposed_merges: [], retirement_candidates: [] }) {
  const base = JSON.parse(JSON.stringify(realRegistry().registry));
  const notCovered = base.coverage.not_covered.map(({ guards: _named, ...item }) => item);
  return { ...base, coverage: { ...base.coverage, not_covered: notCovered }, review, guards };
}

function problemsOf(root) {
  const { registry, schema } = gr.loadRegistry(root);
  return gr.checkRegistry(registry, schema, gr.scanWorkspace(root), { exists: (rel) => fs.existsSync(path.join(root, gr.realPath(rel))) }).problems;
}

// Turn a donor fixture into a release cut: release/ is stripped and the
// pruned manifest lists what the cut ships.
function makeCut(root, write, shipped) {
  for (const rel of ["release/check-public-release.sh", "release/verify-upgrade-bridge.sh", "release/verify-dual-release.sh"]) {
    fs.rmSync(path.join(root, rel), { force: true });
  }
  write("coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ discovery: { engine_managed_roots: ["coord/engine"] }, items: shipped.map((p) => ({ path: p })) }));
}

const exists = (root) => (rel) => fs.existsSync(path.join(root, rel));

const STAGE_GUARD = guard("demo-stage", { kind: "gate-stage", stage_refs: [
  "check-public-release:board", "test-runner:testsPassed", "test-runner:treeViolations",
  "arch-checks:size", "verify-upgrade-bridge:step-0"] });

test("COORD-914: the guard registry is schema-valid and registers every scanned refusal site and gate stage", () => {
  const { registry, schema } = realRegistry();
  const scan = gr.scanWorkspace(ROOT);
  const { problems } = gr.checkRegistry(registry, schema, scan, { exists: exists(ROOT) });
  assert.deepEqual(problems, []);
  assert.ok(scan.sites.length > 300, `scanned ${scan.sites.length} sites`);
  // A release cut strips release/, so its shell stages are absent there.
  const kinds = ["refusal-call", "refusal-text", "wrapper", "blocker-code", "deny-decision"].concat(scan.donor ? ["shell-fail"] : []);
  for (const kind of kinds) {
    assert.ok(scan.sites.some((site) => site.kind === kind), `no ${kind} site scanned`);
  }
});

test("COORD-914: the registry lists every guard named in the ticket, with a tier, remedy, review date and an honest cost", () => {
  const { registry } = realRegistry();
  const ids = new Set(registry.guards.map((g) => g.id));
  // COORD-956: prompt-content-contract, prompt-coverage and prompt-preconditions are merged into prompt-record.
  for (const id of ["prompt-record", "adr-requirement", "adr-compliance-closure",
    "business-context-status", "context-pack-ack", "review-cycles", "requirement-closure", "feature-proof-resolution",
    "evidence-record", "seal-journal-drift", "workspace-merge-guard", "production-loc-budget",
    "coverage-ratchet", "suite-inventory", "engine-surface-integrity", "dual-release-hygiene", "legacy-entrypoints",
    "upgrade-bridge", "owner-lease", "co-located-writer", "tree-mutation-safety"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  for (const retired of ["prompt-content-contract", "prompt-coverage", "prompt-preconditions"]) {
    assert.equal(ids.has(retired), false, `${retired} is retired into prompt-record (COORD-956)`);
  }
  // COORD-957: prodloc-closeout and prodloc-budget are merged into production-loc-budget.
  for (const retired of ["prodloc-closeout", "prodloc-budget"]) {
    assert.equal(ids.has(retired), false, `${retired} is retired into production-loc-budget (COORD-957)`);
  }
  // COORD-958: template-sync and engine-pin are merged into engine-surface-integrity.
  for (const retired of ["template-sync", "engine-pin"]) {
    assert.equal(ids.has(retired), false, `${retired} is retired into engine-surface-integrity (COORD-958)`);
  }
  // COORD-1025: adr-path-packet is retired. Its metadata-only admission is the landing-decision classifier, and its body refusals are re-homed to reconcile-approved-packet and workspace-merge-guard (landing-decision-packet.test.js).
  assert.equal(ids.has("adr-path-packet"), false, "adr-path-packet is retired (COORD-1025)");
  // COORD-963: wip-cap is retired (ADR 0021; retirement review 2026-11-14). Its incident coverage is the owner-doing warning (followups-owner-doing.test.js).
  assert.equal(ids.has("wip-cap"), false, "wip-cap is retired (COORD-963)");
  // COORD-959: repo-gate-record, gate-plan-receipt and closeout-landing-evidence are merged into evidence-record.
  for (const retired of ["repo-gate-record", "gate-plan-receipt", "closeout-landing-evidence"]) {
    assert.equal(ids.has(retired), false, `${retired} is retired into evidence-record (COORD-959)`);
  }
  for (const g of registry.guards) {
    assert.equal(g.review_date, "2027-02-06");
    if (g.cost.cost_status === "measured") assert.match(g.cost.source, /2026-11-05/);
    else assert.equal(g.cost.wall_time, null, `${g.id} records an unmeasured time`);
  }
  const measured = registry.guards.filter((g) => g.cost.cost_status === "measured").map((g) => g.id).sort();
  assert.deepEqual(measured, ["dual-release-verify", "governance-full-suite"]);
});

test("COORD-914: the generated guard registry view is current", () => {
  const { registry } = realRegistry();
  const expected = gr.renderView(registry);
  assert.equal(fs.readFileSync(path.join(ROOT, gr.VIEW_REL), "utf8"), expected,
    "run node coord/engine/scripts/guard-registry.js write");
  assert.match(expected, /## Not covered by the completeness check/);
  assert.match(expected, /## Review: proposed merges/);
  assert.match(expected, /## Review: retirement candidates/);
});

test("COORD-914: a marker covers the following sites until a blank line, and each site kind is recognised", () => {
  const source = [
    "// guard:alpha",
    "function assertThing() {",
    "  fail(`Refusing to proceed`);",
    "",
    "  throw new Error(",
    "    `still refused across lines`",
    "  );",
    "const msg = \"we refuse here\";",
    "// a refused comment is not a site",
    "return { decision: \"deny\", reason: \"x\" };",
    "fail(\"plain argument error\");",
  ].join("\n");
  const { sites, markers } = gr.scanSource("coord/engine/scripts/x.js", source);
  assert.deepEqual(markers, [{ file: "coord/engine/scripts/x.js", line: 1, id: "alpha" }]);
  assert.deepEqual(sites.map((s) => [s.line, s.kind, s.marker]), [
    [2, "wrapper", "alpha"], [3, "refusal-call", "alpha"], [5, "refusal-call", null], [8, "refusal-text", null], [10, "deny-decision", null],
  ]);
  assert.equal(sites[2].text, "throw new Error( `still refused across lines` );");
  assert.equal(sites[0].name, "assertThing");
});

test("COORD-914: blocker codes count only in the readiness collectors, and shell fail calls only in shell mode", () => {
  const blocker = "issues.push({\n  code: \"repo_gates\",\n});\nfoo({\n  code: \"other\",\n});\n";
  assert.deepEqual(gr.scanSource("coord/engine/scripts/gates/x.js", blocker).sites.map((s) => [s.line, s.kind]), [[2, "blocker-code"]]);
  assert.deepEqual(gr.scanSource("coord/engine/scripts/other.js", blocker).sites, []);
  const shell = "# fail \"comment\"\n[ -d x ] || fail \"missing\"\nfail() { echo; }\n";
  assert.deepEqual(gr.scanSource("release/x.sh", shell, { shell: true }).sites.map((s) => [s.line, s.kind]), [[2, "shell-fail"]]);
  const arrow = "const collectThingIssues = (a) => [];\nconst helper = (a) => 1;\n";
  assert.deepEqual(gr.scanSource("coord/engine/scripts/y.js", arrow).sites.map((s) => s.name), ["collectThingIssues"]);
});

test("COORD-914: the engine scan skips tests, fixtures, usage text and the scanner itself", (t) => {
  const { root } = fixture(t, { engine: "fail('refused');\n" });
  assert.deepEqual(gr.listEngineSources(root), ["coord/engine/scripts/arch-checks.js", "coord/engine/scripts/mod.js", "coord/engine/scripts/test-runner.js"]);
  assert.deepEqual(gr.discoverStageRefs(root), ["check-public-release:board", "test-runner:testsPassed", "test-runner:treeViolations",
    "arch-checks:size", "verify-upgrade-bridge:step-0"]);
});

test("COORD-914: stage discovery finds nothing in sources without a stage list", (t) => {
  const { root, write } = fixture(t);
  write("release/check-public-release.sh", "echo no checks\n");
  write("coord/engine/scripts/test-runner.js", "module.exports = {};\n");
  write("coord/engine/scripts/arch-checks.js", "module.exports = {};\n");
  write("release/verify-upgrade-bridge.sh", "echo no steps\n");
  assert.deepEqual(gr.discoverStageRefs(root), []);
});

test("COORD-914: the completeness check names unregistered sites, unknown markers, stale anchors and stage drift", (t) => {
  const engine = "fail('first refused');\n\n// guard:ghost\nfail('second refused');\n\nfail('third refused');\n";
  const reg = fixtureRegistry([guard("demo-stage", { stage_refs: ["check-public-release:board", "check-public-release:gone"] }),
    guard("anchored", { anchors: [{ file: "coord/engine/scripts/mod.js", text: "fail('third refused" }, { file: "coord/engine/scripts/mod.js", text: "never present" }] })]);
  const { root } = fixture(t, { engine, registry: reg });
  const { registry, schema } = gr.loadRegistry(root);
  const { problems } = gr.checkRegistry(registry, schema, gr.scanWorkspace(root), { exists: exists(root) });
  assert.deepEqual(problems, [
    "unregistered refusal-call site coord/engine/scripts/mod.js:1: fail('first refused');",
    "marker guard:ghost at coord/engine/scripts/mod.js:3 has no registry entry",
    "anchored: stale anchor coord/engine/scripts/mod.js \"never present\" matches no site (reworded? update the anchor in the same change)",
    "unregistered gate stage test-runner:testsPassed",
    "unregistered gate stage test-runner:treeViolations",
    "unregistered gate stage arch-checks:size",
    "unregistered gate stage verify-upgrade-bridge:step-0",
    "stale stage_ref check-public-release:gone",
  ]);
});

test("COORD-914: references, duplicate ids, cost honesty and declared markers are checked", (t) => {
  const measuredNoSource = guard("measured", { cost: { frequency: "f", wall_time: "1 min", tests: 1, cost_status: "measured", source: null, note: "n" } });
  const unknownWithTime = guard("guess", { overlaps: ["nobody"], cost: { frequency: "f", wall_time: "2 min", tests: null, cost_status: "unknown", source: null, note: "n" } });
  const marked = guard("marked", { locations: [{ file: "coord/engine/scripts/mod.js", function: "f", marker: true }] });
  const review = { proposed_merges: [{ id: "m", guards: ["marked", "missing"], into: "x", rationale: "r", must_still_cover: ["c"] }],
    retirement_candidates: [{ guard: "absent", rationale: "r", must_still_cover: ["c"] }] };
  const reg = fixtureRegistry([STAGE_GUARD, measuredNoSource, unknownWithTime, marked, guard("marked")], review);
  const { root } = fixture(t, { registry: reg });
  const { registry, schema } = gr.loadRegistry(root);
  const { problems } = gr.checkRegistry(registry, schema, gr.scanWorkspace(root), { exists: exists(root) });
  assert.deepEqual(problems, [
    "duplicate guard id marked",
    "guess: overlaps unknown guard nobody",
    "proposed merge m: unknown guard missing",
    "retirement candidate: unknown guard absent",
    "measured: measured cost needs wall_time and source",
    "guess: unknown cost must have wall_time null",
    "marked: no guard:marked marker in coord/engine/scripts/mod.js",
  ]);
});

test("COORD-914: the schema subset reports type, const, enum, pattern, length, count and shape errors", () => {
  const schema = {
    type: "object", required: ["a", "b"], additionalProperties: false,
    properties: {
      a: { const: 1 }, b: { enum: ["x"] }, c: { type: "string", pattern: "^z", minLength: 3 },
      d: { type: "array", minItems: 2, items: { type: ["integer", "null"] } }, e: { type: "number" },
    },
  };
  assert.deepEqual(gr.validateSchema(schema, { a: 2, b: "y", c: "ab", d: [1.5], e: 3, f: true }), [
    "$.a: must equal 1", "$.b: must be one of x", "$.c: shorter than 3", "$.c: does not match ^z",
    "$.d: fewer than 2 items", "$.d[0]: expected integer|null, got number", "$: unexpected property \"f\"",
  ]);
  assert.deepEqual(gr.validateSchema(schema, []), ["$: expected object, got array"]);
  assert.deepEqual(gr.validateSchema(schema, { a: 1 }), ["$: missing required \"b\""]);
  assert.deepEqual(gr.validateSchema({ type: "object" }, null), ["$: expected object, got null"]);
  assert.deepEqual(gr.validateSchema({ properties: { n: { type: "string" } } }, { n: "ok", m: 1 }), []);
  const { problems } = gr.checkRegistry({ schema_version: 2 }, realRegistry().schema, { sites: [], markers: [], stageRefs: [] });
  assert.ok(problems.includes("$: must equal 1") || problems.some((p) => p.startsWith("$.schema_version")), problems.join("\n"));
});

test("COORD-914: main writes the view, then check passes; sites lists; an unknown command is a usage error", (t) => {
  const anchored = guard("anchored", { anchors: [{ file: "coord/engine/scripts/mod.js", text: "fail('anchored refusal" }] });
  const { root } = fixture(t, { engine: "// guard:demo-stage\nfail('refused');\n\nfail('anchored refusal');\n", registry: fixtureRegistry([STAGE_GUARD, anchored]) });
  const run = (args) => { const out = sink(); const err = sink(); return { code: gr.main(args, { root, out, err }), out: out.text, err: err.text }; };
  const stale = run([]);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /GUARD_REGISTRY\.md is missing or stale/);
  assert.match(run(["write"]).out, /wrote coord\/engine\/docs\/GUARD_REGISTRY\.md/);
  const pass = run(["check"]);
  assert.equal(pass.code, 0);
  assert.match(pass.out, /PASS guards=2 sites=3 stages=5 problems=0/);
  const sites = run(["sites"]).out;
  assert.match(sites, /coord\/engine\/scripts\/mod\.js:2\trefusal-call\tdemo-stage\t/);
  assert.match(sites, /coord\/engine\/scripts\/mod\.js:4\trefusal-call\t-\t/);
  const bad = run(["bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown command bogus/);
  const view = fs.readFileSync(path.join(root, gr.VIEW_REL), "utf8");
  assert.match(view, /### demo-stage — demo-stage/);
  assert.match(view, /time: unknown \(unknown\)/);
});

test("COORD-914: write refuses to regenerate the view while the registry has problems", (t) => {
  const { root } = fixture(t, { engine: "fail('refused');\n", registry: fixtureRegistry([STAGE_GUARD]) });
  const out = sink();
  const err = sink();
  assert.equal(gr.main(["write"], { root, out, err }), 1);
  assert.match(err.text, /unregistered refusal-call site/);
  assert.equal(fs.existsSync(path.join(root, gr.VIEW_REL)), false);
});

test("COORD-914: the view renders measured costs, anchors, empty fields and escaped cells", () => {
  const reg = fixtureRegistry([guard("a|b", {
    overlaps: [], answers: ["line\nbreak"],
    cost: { frequency: "1 run", wall_time: "about 35 min", tests: 2, cost_status: "measured", source: "run", note: "" },
  })]);
  const view = gr.renderView(reg);
  assert.match(view, /\| a\\\|b \| T1 \|/);
  assert.match(view, /time: about 35 min \(measured\)\n/);
  assert.match(view, /\*\*Overlaps:\*\* none recorded/);
  assert.match(view, /\*\*Answers:\*\* line break/);
});

test("COORD-914: the guard-registry CLI checks the real workspace", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "guard-registry.js")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /guard-registry: PASS/);
});

test("COORD-914: a registered file missing from a full checkout fails", (t) => {
  const { root } = fixture(t, { registry: fixtureRegistry([STAGE_GUARD, guard("stripped", {
    locations: [{ file: "release/gone.sh", function: "f", marker: true }],
    anchors: [{ file: "coord/engine/scripts/gone.js", text: "fail('gone refused" }],
  })]) });
  assert.deepEqual(problemsOf(root), [
    "stripped: anchor file coord/engine/scripts/gone.js does not exist",
    "stripped: location file release/gone.sh does not exist",
  ]);
});

test("COORD-914: a newly added refusal site with no registry entry fails", (t) => {
  const { root, write } = fixture(t, { engine: "// guard:demo-stage\nfail('refused');\n", registry: fixtureRegistry([STAGE_GUARD]) });
  assert.deepEqual(problemsOf(root), []);
  write("coord/engine/scripts/mod.js", "// guard:demo-stage\nfail('refused');\n\nthrow new Error(`push refused: a new guard`);\n");
  assert.deepEqual(problemsOf(root), ["unregistered refusal-call site coord/engine/scripts/mod.js:4: throw new Error(`push refused: a new guard`);"]);
});

test("COORD-914: duplicate and ambiguous anchors fail; a declared match count is honoured", (t) => {
  const engine = "fail('same refused');\n\nfail('same refused');\n\nfail('one refused');\n";
  const anchors = [{ file: "coord/engine/scripts/mod.js", text: "fail('same refused" },
    { file: "coord/engine/scripts/mod.js", text: "fail('one refused" }, { file: "coord/engine/scripts/mod.js", text: "fail('one refused" }];
  const { root, write } = fixture(t, { engine, registry: fixtureRegistry([STAGE_GUARD, guard("anchored", { anchors })]) });
  assert.deepEqual(problemsOf(root), [
    "anchored: ambiguous anchor coord/engine/scripts/mod.js \"fail('same refused\" matches 2 sites, declared 1",
    "anchored: duplicate anchor coord/engine/scripts/mod.js \"fail('one refused\"",
  ]);
  write(gr.REGISTRY_REL, JSON.stringify(fixtureRegistry([STAGE_GUARD, guard("anchored", {
    anchors: [{ ...anchors[0], matches: 2 }, anchors[1]] })])));
  assert.deepEqual(problemsOf(root), []);
});

test("COORD-914: rewording an anchored refusal without updating its anchor fails", (t) => {
  const anchors = [{ file: "coord/engine/scripts/mod.js", text: "fail('push refused: old wording" }];
  const { root, write } = fixture(t, { engine: "fail('push refused: old wording');\n", registry: fixtureRegistry([STAGE_GUARD, guard("anchored", { anchors })]) });
  assert.deepEqual(problemsOf(root), []);
  write("coord/engine/scripts/mod.js", "fail('push refused: new wording');\n");
  assert.deepEqual(problemsOf(root), [
    "unregistered refusal-call site coord/engine/scripts/mod.js:1: fail('push refused: new wording');",
    "anchored: stale anchor coord/engine/scripts/mod.js \"fail('push refused: old wording\" matches no site (reworded? update the anchor in the same change)",
  ]);
});

test("COORD-914: a cut skips only what its edition strips; a missing shipped guard file fails", (t) => {
  const enterpriseOnly = guard("edition-broker", { editions: ["Enterprise"], locations: [{ file: "@enterprise/broker.js", function: "f", marker: true }] });
  const shippedGuard = guard("shipped", { locations: [{ file: "coord/engine/scripts/mod.js", function: "f", marker: true }] });
  const tooling = guard("tooling", { locations: [{ file: "release/gone.sh", function: "f", marker: false }] });
  const reg = fixtureRegistry([STAGE_GUARD, enterpriseOnly, shippedGuard, tooling]);
  reg.coverage.not_covered.push({ surface: "Enterprise-only guards in a Community cut", reason: "r", guards: ["edition-broker"] });
  const { root, write } = fixture(t, { engine: "// guard:shipped\nfail('refused');\n", registry: reg });
  write("coord/engine/scripts/enterprise/broker.js", "// guard:edition-broker\nfail('refused in the edition subtree');\n");
  write("release/gone.sh", "echo\n");
  assert.deepEqual(problemsOf(root), []);
  makeCut(root, write, ["coord/engine/scripts/mod.js", "coord/engine/scripts/enterprise/broker.js"]);
  const enterpriseCut = gr.scanWorkspace(root);
  assert.equal(enterpriseCut.edition, "Enterprise");
  assert.deepEqual(enterpriseCut.absentStageSources, ["check-public-release", "verify-upgrade-bridge"]);
  assert.deepEqual(problemsOf(root), []);
  fs.rmSync(path.join(root, "coord/engine/scripts/enterprise"), { recursive: true });
  makeCut(root, write, ["coord/engine/scripts/mod.js"]);
  assert.equal(gr.scanWorkspace(root).edition, "Community");
  assert.deepEqual(problemsOf(root), []);
  fs.rmSync(path.join(root, "coord/engine/scripts/mod.js"));
  const MISSING = ["demo-stage", "shipped"].map((id) => `${id}: location file coord/engine/scripts/mod.js is missing from this Community cut`);
  assert.deepEqual(problemsOf(root), MISSING);
  makeCut(root, write, []);
  assert.deepEqual(problemsOf(root), MISSING);
});

test("COORD-914: a cut whose manifest lists a file outside the managed roots still requires it", (t) => {
  const reg = fixtureRegistry([STAGE_GUARD, guard("extra", { locations: [{ file: "docs/extra.md", function: "f", marker: false }] })]);
  const { root, write } = fixture(t, { registry: reg });
  write("docs/extra.md", "x\n");
  makeCut(root, write, ["docs/extra.md"]);
  assert.deepEqual(problemsOf(root), []);
  fs.rmSync(path.join(root, "docs/extra.md"));
  assert.deepEqual(problemsOf(root), ["extra: location file docs/extra.md is missing from this Community cut"]);
  fs.rmSync(path.join(root, "coord/TEMPLATE_SYNC_MANIFEST.json"));
  assert.deepEqual(problemsOf(root), []);
});

test("COORD-914: Enterprise-only entries must be named in not_covered, and always-enforced guards are T0", (t) => {
  const reg = fixtureRegistry([STAGE_GUARD, guard("edition-broker", { editions: ["Enterprise"] }), guard("owner", { always_enforced: true, tier: "T1" })]);
  reg.coverage.not_covered.push({ surface: "s", reason: "r", guards: ["owner", "nobody"] });
  const { root } = fixture(t, { registry: reg });
  assert.deepEqual(problemsOf(root), [
    "owner: always_enforced guards must be tier T0",
    "edition-broker: Enterprise-only entry is not named in coverage.not_covered",
    "coverage.not_covered names owner, which is not an Enterprise-only entry",
    "coverage.not_covered names nobody, which is not an Enterprise-only entry",
  ]);
});

test("COORD-914: tiers are documented as proposals and ownership guards are always enforced", () => {
  const { registry, schema } = realRegistry();
  assert.match(registry.tier_semantics, /PROPOSED review classifications, not enforcement thresholds/);
  assert.match(schema.description, /PROPOSED review classifications, not enforcement thresholds/);
  assert.match(registry.ownership, /human-admin review through a governed ticket that cites ADR 0021/);
  assert.match(registry.ownership, /stale anchor is the intended signal/);
  const always = new Set(registry.guards.filter((g) => g.always_enforced).map((g) => g.id));
  for (const id of ["owner-lease", "bound-owner", "co-located-writer", "canonical-authority-write", "seal-journal-drift",
    "closeout-pr-ancestry", "landing-record-integrity", "workspace-merge-guard", "tree-mutation-safety", "runtime-authority-hook"]) {
    assert.ok(always.has(id), `${id} is not always_enforced`);
  }
  const view = gr.renderView(registry);
  assert.match(view, /## Tiers/);
  assert.match(view, /## Changing this registry/);
  assert.match(view, /Entries: enterprise-policy-broker, enterprise-warehouse-identity\./);
});
