"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const audit = require("./architecture-audit.js");

const BLOCK = [
  "function buildRow(input, options) {",
  "  const row = { id: input.id, owner: input.owner, status: input.status };",
  "  if (options.strict && !row.owner) throw new Error(\"missing owner\");",
  "  row.label = String(input.label || \"\").trim();",
  "  row.tags = Array.isArray(input.tags) ? input.tags.slice(0, 8) : [];",
  "  return Object.freeze(row);",
  "}",
  "module.exports = { buildRow };",
].join("\n");

test("production engine modules exclude tests, fixtures and other directories", () => {
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/journal.js"), true);
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/nested/deeper/org-collector.js"), true);
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/journal.test.js"), false);
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/__fixtures__/x/a.js"), false);
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/fixtures/quality/a.js"), false);
  assert.equal(audit.isEngineProductionModule("coord/scripts/journal.js"), false);
  assert.equal(audit.isEngineProductionModule("coord/engine/scripts/notes.md"), false);
  assert.equal(audit.isEngineProductionModule(null), false);
});

test("measureEngine counts modules, LOC and guards from the registry text", () => {
  const sources = [
    { path: "coord/engine/scripts/a.js", source: "const x = 1;\n\n// comment only\nmodule.exports = x;\n" },
    { path: "coord/engine/scripts/a.test.js", source: "test('x', () => {});\n" },
    { path: "coord/engine/scripts/__fixtures__/f.js", source: "module.exports = 1;\n" },
    { path: "coord/scripts/shim.js", source: "module.exports = 1;\n" },
  ];
  const measured = audit.measureEngine(sources, JSON.stringify({ guards: [{ id: "a" }, { id: "b" }] }));
  assert.equal(measured.production_modules, 1);
  assert.equal(measured.production_loc, 2);
  assert.equal(measured.test_files, 1);
  assert.equal(measured.fixture_files, 1);
  assert.equal(measured.guards, 2);
  assert.equal(audit.measureEngine(sources, null).guards, null);
  for (const invalid of ["null", "{}", '{"guards":false}']) {
    assert.equal(audit.measureEngine(sources, invalid).guards, null);
  }
  assert.equal(audit.measureEngine(sources, '{"guards":[]}').guards, 0);
});

test("clone detection finds a block duplicated across two modules deterministically", () => {
  const sources = [
    { path: "coord/engine/scripts/one.js", source: `// header\n${BLOCK}\n` },
    { path: "coord/engine/scripts/two.js", source: `const other = 1;\n${BLOCK}\n` },
    { path: "coord/engine/scripts/three.js", source: "const unrelated = () => 42;\n" },
  ];
  const first = audit.findCloneClusters(sources);
  const second = audit.findCloneClusters([...sources].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].files, ["coord/engine/scripts/one.js", "coord/engine/scripts/two.js"]);
  assert.ok(first[0].duplicated_windows >= 1);
  const enterprisePath = ["coord", "engine", "scripts", "enterprise", "two.js"].join("/");
  const edition = audit.findCloneClusters([sources[0], { ...sources[1], path: enterprisePath }]);
  assert.deepEqual(edition[0].files, ["@enterprise/two.js", "coord/engine/scripts/one.js"]);
});

test("clone detection ignores import and destructuring boilerplate", () => {
  const imports = [
    "const { alpha, beta, gamma } = require(\"./deps.js\");",
    "const delta = require(\"./delta.js\");",
    "const epsilon = require(\"./epsilon.js\");",
    "const zeta = require(\"./zeta.js\");",
    "const eta = require(\"./eta.js\");",
    "const theta = require(\"./theta.js\");",
    "const iota = require(\"./iota.js\");",
    "const kappa = require(\"./kappa.js\");",
  ].join("\n");
  const clusters = audit.findCloneClusters([
    { path: "coord/engine/scripts/p.js", source: imports },
    { path: "coord/engine/scripts/q.js", source: imports },
  ]);
  assert.deepEqual(clusters, []);
});

test("allowlist parsing fails loudly on malformed entries", () => {
  assert.throws(() => audit.parseAllowlist({ entries: [{ files: [], reason: "x" }] }), /at least one path/);
  assert.throws(() => audit.parseAllowlist({ entries: [{ files: ["a.js"], reason: "" }] }), /needs a reason/);
  assert.deepEqual(audit.parseAllowlist({ entries: [{ files: ["a.js"], reason: "within-module repeat" }] })[0].files, ["a.js"]);
  assert.throws(() => audit.parseAllowlist({ entries: [{ files: ["a.js", "b.js"], reason: " " }] }), /needs a reason/);
  assert.throws(() => audit.parseAllowlist({ entries: [{ files: ["a.js", "b.js"], reason: "x" }, { files: ["b.js", "a.js"], reason: "y" }] }), /duplicates/);
  assert.throws(() => audit.parseAllowlist({}), /entries must be an array/);
  assert.deepEqual(audit.parseAllowlist(null), []);
});

test("allowlist detects duplicate file sets even when equivalent paths use different spelling", () => {
  assert.throws(() => audit.parseAllowlist({ entries: [
    { files: ["scripts/a.js", "./scripts/a.js", "scripts/b.js"], reason: "initial review" },
    { files: ["scripts\\b.js", "scripts\\a.js", "./scripts/a.js"], reason: "repeat review" },
  ] }), /entry 1 duplicates an earlier file set/);
});

test("applyAllowlist separates allowlisted, unallowlisted and stale entries", () => {
  const clusters = [
    { files: ["coord/engine/scripts/a.js", "coord/engine/scripts/b.js"], duplicated_windows: 2, sample: "s" },
    { files: ["coord/engine/scripts/c.js", "coord/engine/scripts/d.js"], duplicated_windows: 1, sample: "t" },
  ];
  const entries = audit.parseAllowlist({
    entries: [
      { files: ["coord/engine/scripts/b.js", "coord/engine/scripts/a.js"], reason: "reviewed" },
      { files: ["coord/engine/scripts/x.js", "coord/engine/scripts/y.js"], reason: "gone" },
    ],
  });
  const result = audit.applyAllowlist(clusters, entries);
  assert.equal(result.allowlisted.length, 1);
  assert.equal(result.allowlisted[0].reason, "reviewed");
  assert.equal(result.unallowlisted.length, 1);
  assert.deepEqual(result.stale, ["coord/engine/scripts/x.js|coord/engine/scripts/y.js"]);
});

test("ratchet passes at the cap with no base and refuses growth above it", () => {
  const ratchet = { values: { guards: 5, production_modules: 10, production_loc: 1000 }, growth: [] };
  const within = { guards: 5, production_modules: 10, production_loc: 1000 };
  assert.deepEqual(audit.evaluateRatchet({ ticketId: "T-1", measured: within, ratchet, baseRatchet: null }), []);
  const over = { guards: 6, production_modules: 10, production_loc: 1000 };
  const refusals = audit.evaluateRatchet({ ticketId: "T-1", measured: over, ratchet, baseRatchet: null });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /^guards: measured 6 exceeds the recorded ratchet 5/);
});

test("ratchet raise against the base needs a growth record naming the ticket", () => {
  const base = { values: { guards: 5, production_modules: 10, production_loc: 1000 }, growth: [] };
  const measured = { guards: 5, production_modules: 11, production_loc: 1000 };
  const unrecorded = { values: { guards: 5, production_modules: 11, production_loc: 1000 }, growth: [] };
  const refused = audit.evaluateRatchet({ ticketId: "T-2", measured, ratchet: unrecorded, baseRatchet: base });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /raised from 10 to 11 without a growth record naming T-2/);

  const recorded = {
    values: { guards: 5, production_modules: 11, production_loc: 1000 },
    growth: [{ ticket: "T-2", metric: "production_modules", from: 10, to: 11, reason: "one new module" }],
  };
  assert.deepEqual(audit.evaluateRatchet({ ticketId: "T-2", measured, ratchet: recorded, baseRatchet: base }), []);
  // A record for another ticket does not authorise this one.
  assert.equal(audit.evaluateRatchet({ ticketId: "T-3", measured, ratchet: recorded, baseRatchet: base }).length, 1);
});

test("ratchet refuses a deleted file, malformed records and unmeasurable counts", () => {
  const base = { values: { guards: 5, production_modules: 10, production_loc: 1000 }, growth: [] };
  assert.deepEqual(audit.evaluateRatchet({ ticketId: "T", measured: {}, ratchet: null, baseRatchet: null }), []);
  assert.equal(audit.evaluateRatchet({ ticketId: "T", measured: {}, ratchet: null, baseRatchet: base }).length, 1);
  const malformed = { values: base.values, growth: [{ ticket: "T", metric: "bogus", from: 1, to: 2, reason: "x" }] };
  const measured = { guards: 5, production_modules: 10, production_loc: 1000 };
  assert.ok(audit.evaluateRatchet({ ticketId: "T", measured, ratchet: malformed, baseRatchet: null })
    .some((text) => /malformed growth record/.test(text)));
  const missing = audit.evaluateRatchet({ ticketId: "T", measured: { guards: 5, production_modules: 10, production_loc: null }, ratchet: base, baseRatchet: null });
  assert.ok(missing.some((text) => /could not be measured/.test(text)));
});

test("report carries deltas only against a previous report and never files tickets", () => {
  const sources = [{ path: "coord/engine/scripts/a.js", source: "module.exports = 1;\n" }];
  const guardsText = JSON.stringify({ guards: [{ id: "a" }] });
  const first = audit.buildReport({ revision: "abc", sources, guardsText, ratchet: null, allowlistObj: null, registry: { review: {} }, previous: null });
  assert.equal(first.deltas, null);
  assert.equal(first.proposals.filed, false);
  assert.equal(first.ratchet.present, false);
  const previous = { schema: audit.REPORT_SCHEMA, metrics: { ...first.metrics, production_modules: 0 } };
  const second = audit.buildReport({ revision: "abc", sources, guardsText, ratchet: null, allowlistObj: null, registry: { review: {} }, previous });
  assert.equal(second.deltas.production_modules, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(audit.buildReport({ revision: "abc", sources, guardsText, ratchet: null, allowlistObj: null, registry: { review: {} }, previous: null }))));
});

test("run is read-only without --out, writes only under --out, and rejects unknown flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-audit-"));
  const engine = path.join(root, "coord", "engine", "scripts");
  fs.mkdirSync(engine, { recursive: true });
  fs.writeFileSync(path.join(engine, "a.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(root, "coord", "engine", "governance-guards.json"), JSON.stringify({ guards: [] }));
  const lines = [];
  const quiet = { log: (text) => lines.push(text), errorLog: (text) => lines.push(text) };
  assert.equal(audit.run(["--root", root, "--revision", "t"], quiet).code, 0);
  assert.match(lines.join(""), /# Architecture audit/);
  assert.equal(fs.existsSync(path.join(root, "coord", "docs")), false);
  const prefix = path.join(root, "out", "report");
  assert.equal(audit.run(["--root", root, "--revision", "t", "--out", prefix], quiet).code, 0);
  const written = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
  assert.equal(written.schema, audit.REPORT_SCHEMA);
  assert.equal(written.metrics.production_modules, 1);
  assert.equal(audit.run(["--bogus"], quiet).code, 2);
});

test("COORD-1052: architecture report separates reviewed clones and advisory guard changes", () => {
  const sources = ["a", "b", "c", "d"].map((name, index) => ({
    path: `coord/engine/scripts/${name}.js`,
    source: index < 2 ? BLOCK : BLOCK.replaceAll("buildRow", "buildOther").replaceAll("input", "record"),
  }));
  const report = audit.buildReport({
    sources, guardsText: JSON.stringify({ guards: [] }),
    ratchet: { values: { guards: 0, production_modules: 4, production_loc: 100 } },
    allowlistObj: { entries: [
      { files: [sources[0].path, sources[1].path], reason: "reviewed compatibility copy" },
      { files: ["coord/engine/scripts/removed.js"], reason: "retired" },
    ] },
    registry: { review: {
      proposed_merges: [{ guards: ["one", "two"], into: "combined" }, { guards: ["three", "four"] }],
      retirement_candidates: [{ guard: "legacy", rationale: "migration complete" }],
    } },
    previous: { schema: audit.REPORT_SCHEMA, metrics: { production_modules: 3, guards: null } },
  });
  assert.equal(report.revision, "unknown");
  assert.equal(report.clones.allowlisted.length, 1);
  assert.equal(report.clones.allowlisted[0].reason, "reviewed compatibility copy");
  assert.ok(report.clones.unallowlisted_count > 0);
  assert.equal(report.guard_registry.proposed_merges, 2);
  assert.equal(report.guard_registry.retirement_candidates, 1);
  assert.equal(report.proposals.filed, false);
  assert.ok(report.proposals.items.some((item) => item.kind === "clone-cluster"));
  assert.ok(report.proposals.items.some((item) => item.summary === "Merge one, two into combined"));
  assert.ok(report.proposals.items.some((item) => item.summary === "Merge three, four"));
  assert.equal(report.deltas.production_modules, 1);
  assert.equal(report.deltas.guards, null, "unmeasured previous counts must not imply zero");
  const markdown = audit.renderMarkdown(report);
  assert.match(markdown, /Retire guard legacy: migration complete/);
  assert.match(markdown, /removed\.js/);
  assert.match(markdown, /\[clone-cluster\]/);
});

test("COORD-1052: architecture ratchet refuses incomplete caps and malformed growth records", () => {
  const measured = { guards: 1, production_modules: 1, production_loc: 1 };
  for (const ratchet of [{}, { values: { guards: "1", production_modules: Infinity } }]) {
    const refused = audit.evaluateRatchet({ ticketId: "COORD-1052", measured, ratchet });
    assert.equal(refused.length, 3);
    assert.ok(refused.every((text) => text.includes("missing or not a number")));
  }
  for (const record of [null, { ticket: 1 }, { ticket: "T", metric: "guards", from: 0, to: 1, reason: " " }]) {
    const refused = audit.evaluateRatchet({ ticketId: "COORD-1052", measured, ratchet: { values: measured, growth: [record] } });
    assert.ok(refused.some((text) => text.includes("malformed growth record")));
  }
});

test("COORD-1052: architecture CLI refuses malformed evidence and reports an empty non-Git workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-audit-errors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = [], errors = [];
  const io = { log: (text) => output.push(text), errorLog: (text) => errors.push(text) };
  const empty = audit.run(["--root", root, "--json"], io);
  assert.equal(empty.code, 0);
  assert.equal(empty.report.revision, "unknown");
  assert.equal(JSON.parse(output.at(-1)).metrics.production_modules, 0);
  const previous = path.join(root, "previous.json");
  fs.writeFileSync(previous, JSON.stringify({ schema: audit.REPORT_SCHEMA, metrics: { production_modules: 2 } }));
  const compared = audit.run(["--root", root, "--previous", previous, "--json"], io);
  assert.equal(compared.code, 0);
  assert.equal(compared.report.deltas.production_modules, -2);
  for (const rel of [audit.RATCHET_REL, audit.ALLOWLIST_REL, audit.GUARDS_REL]) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "invalid JSON");
    assert.equal(audit.run(["--root", root], io).code, 1);
    assert.ok(errors.at(-1).includes(`${rel} is not valid JSON`));
    fs.unlinkSync(file);
  }
  fs.writeFileSync(previous, "invalid JSON");
  assert.equal(audit.run(["--root", root, "--previous", previous], io).code, 1);
  for (const args of [["--out"], ["--previous", "--json"], ["--revision"]]) {
    assert.equal(audit.run(args, io).code, 2);
    assert.match(errors.at(-1), /needs a value/);
  }
  assert.equal(fs.existsSync(path.join(root, "out")), false);
});


test("COORD-1052: default architecture CLI uses its engine root and standard output streams without writing", () => {
  const stdout = [], stderr = [];
  const originalOut = process.stdout.write, originalErr = process.stderr.write;
  let result, invalid;
  try {
    process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    result = audit.run(["--json"]);
    invalid = audit.run(["--unknown-option"]);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(result.code, 0);
  assert.equal(result.report.revision.length > 0, true);
  assert.equal(JSON.parse(stdout[0]).schema, audit.REPORT_SCHEMA);
  assert.equal(invalid.code, 2);
  assert.match(stderr.join(""), /unknown argument: --unknown-option/);
  assert.match(stderr.join(""), /usage: gov audit-architecture/);
});

test("COORD-1052: public audit-architecture command propagates invalid argument exit status", () => {
  const { spawnSync } = require("node:child_process");
  const cli = path.join(__dirname, "..", "..", "scripts", "governance.js");
  const result = spawnSync(process.execPath, [cli, "audit-architecture", "--unknown-option"], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --unknown-option/);
  assert.match(result.stderr, /usage: gov audit-architecture/);
});
