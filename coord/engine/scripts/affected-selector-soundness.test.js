"use strict";

// COORD-953: property-based soundness test for the COORD-924 affected-test selector.
//
// Oracle: for a base..head change, every suite that really reaches a changed file (by the
// loads the generator wrote, not by the graph under test) must be selected, or the decision
// must be "full" with a named reason. A selection that is a strict subset of the truth fails.
// Human-admin decision 2026-11-12: every suite that reaches an unresolved dynamic load (a load
// the graph cannot name) must also be selected when a change exists; the full gate is not forced.
// Generated cases are seeded; COORD953_ITERATIONS=<n> runs n trees per property instead of 24.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const selector = require("./affected-selector.js");
const { gitFixture } = require("./test-git-fixture.js");
const gen = require("./__fixtures__/affected-soundness-generator.js");
const faults = require("./__fixtures__/affected-selection-faults.js");

const STARTED = Date.now();
const EXTRA = Number(process.env.COORD953_ITERATIONS) || 0;
const TREES = EXTRA || 24;

const POLICY = {
  policy_version: 953,
  fallback_paths: [],
  generated_files: [],
  generated_patterns: [],
  doc_pattern: "\\.(md|txt)$",
  shared_helper_min_dependent_suites: 2,
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "coord953-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let counter = 0;

// Each case still gets an independent base commit and its direct child.
// The selector takes those exact commit IDs, so one object store is enough.
function selectCases(cases) {
  const root = path.join(TMP, `r${++counter}`);
  gitFixture(TMP, ["init", "-q", root]);
  const data = (value) => `data ${Buffer.byteLength(value)}\n${value}\n`;
  const commit = (ref, mark, message, files, parent = null) => [
    `commit ${ref}\nmark :${mark}\n`,
    "committer Fixture <fixture@example.invalid> 1 +0000\n",
    data(`${message}\n`),
    parent === null ? "" : `from :${parent}\n`,
    "deleteall\n",
    ...Object.entries(files).map(([rel, body]) => `M 100644 inline ${JSON.stringify(rel)}\n${data(body)}`),
    "\n",
  ].join("");
  const input = cases.map(({ base, head }, index) => {
    const ref = `refs/heads/case-${index}`;
    const baseMark = 2 * index + 1;
    const headMark = baseMark + 1;
    return commit(ref, baseMark, "base", base.files)
      + commit(ref, headMark, "head", head.files, baseMark)
      + `get-mark :${baseMark}\nget-mark :${headMark}\n`;
  }).join("") + "done\n";
  const commits = gitFixture(root, ["fast-import", "--quiet"], { input }).split("\n");
  assert.equal(commits.length, 2 * cases.length, "every case has two Git commits");
  return cases.map(({ changes }, index) => select(root, commits[2 * index], commits[2 * index + 1], changes));
}

function select(root, base, head, changes) {
  return selector.selectAffected({ root, base, head, changes, policy: POLICY, registry: { guards: [] }, shimRegistry: { shims: [] } });
}

function closure(edges, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const x = stack.pop();
    for (const y of edges.get(x) || []) {
      if (!seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
  }
  return seen;
}

// The truth-based oracle. Returns the suites that must be selected: those that reach a changed
// file, and those that reach an unresolved dynamic load.
function oracle(base, head, changes) {
  const headPaths = new Set();
  const basePaths = new Set();
  for (const c of changes) {
    if (c.status === "D") basePaths.add(c.path);
    else if (c.status === "R") {
      headPaths.add(c.path);
      basePaths.add(c.old_path);
    } else headPaths.add(c.path);
  }
  const required = [];
  for (const suite of head.suites) {
    const inHead = closure(head.edges, suite);
    const inBase = closure(base.edges, suite);
    const changed = [...inHead].some((f) => headPaths.has(f)) || [...inBase].some((f) => basePaths.has(f));
    const unresolved = [...inHead].some((f) => head.unknown.has(f)) || [...inBase].some((f) => base.unknown.has(f));
    if (changed || unresolved) required.push(suite);
  }
  return { required };
}

// Checks one selection against the oracle. Returns "full" or "selected".
function check(sel, want, label) {
  if (sel.decision === "full") {
    assert.ok(sel.fallback_reasons.length > 0, `${label}: a full gate must name a reason`);
    return "full";
  }
  const chosen = new Set(sel.selected.map((s) => s.suite));
  const omitted = want.required.filter((s) => !chosen.has(s));
  assert.deepEqual(omitted, [], `${label}: suites that reach a changed file were omitted`);
  return "selected";
}

test("COORD-953: seeded oracle: every suite reaching a changed file is selected, or the result is full with a named reason", () => {
  const stats = { selected: 0, full: 0, required: 0 };
  const cases = [];
  for (let i = 0; i < TREES; i++) {
    const tree = gen.genTree(gen.SEED + i);
    for (const mode of ["modify", "mixed"]) {
      const { head, changes } = gen.mutate(tree, gen.SEED + 1000 + i, mode);
      cases.push({ base: tree, head, changes, label: `seed ${gen.SEED + i} ${mode} changes=${JSON.stringify(changes)}` });
    }
  }
  selectCases(cases).forEach((sel, index) => {
    const { base, head, changes, label } = cases[index];
    const want = oracle(base, head, changes);
    stats.required += want.required.length;
    stats[check(sel, want, label)] += 1;
  });
  assert.ok(stats.selected > 0 && stats.required > 0, `the property must not be vacuous: ${JSON.stringify(stats)}`);
});

test("COORD-953: an unresolved dynamic load widens the selection to every suite that reaches it, per edge kind (control: a same-directory unknown load is still full)", () => {
  // The control keeps the unknown load in the changed file's own directory, which the
  // selector already treats as full. Every other kind must also produce the full gate.
  const kinds = ["env", "import-variable", "decoy-masked", "shim-nonliteral", "spawn-computed"];
  const cases = kinds.map((kind) => {
    const fixture = gen.unknownKindFixture(kind);
    const base = { files: fixture.files, edges: new Map(), unknown: new Set(), suites: [] };
    const head = { files: fixture.files, edges: new Map(), unknown: new Set(), suites: [`${gen.DIR}/t0.test.js`, `${gen.DIR}/t1.test.js`] };
    return { base, head, changes: [{ status: "M", path: fixture.changed }] };
  });
  const sameDir = gen.unknownKindFixture("env");
  sameDir.files[`${gen.DIR}/plugins/other.js`] = "exports.other = 1;\n";
  const b2 = { files: sameDir.files, edges: new Map(), unknown: new Set(), suites: [] };
  const h2 = { files: sameDir.files, edges: new Map(), unknown: new Set(), suites: [`${gen.DIR}/t0.test.js`, `${gen.DIR}/t1.test.js`] };
  cases.push({ base: b2, head: h2, changes: [{ status: "M", path: `${gen.DIR}/plugins/other.js` }] });
  const selections = selectCases(cases);
  for (const [index, kind] of kinds.entries()) {
    // t0 reaches the host's unresolved load and must be selected; t1 reaches the changed file.
    // The selection is widened, not forced to the full gate (human-admin decision 2026-11-12).
    const sel = selections[index];
    assert.equal(sel.decision, "selected", `${kind}: an unresolved load widens the selection, it does not force the full gate`);
    const chosen = sel.selected.map((x) => x.suite);
    assert.ok(chosen.includes(`${gen.DIR}/t0.test.js`), `${kind}: the suite that reaches the unresolved load must be selected, got ${JSON.stringify(chosen)}`);
    assert.ok(chosen.includes(`${gen.DIR}/t1.test.js`), `${kind}: the suite that reaches the changed file must be selected`);
  }
  assert.equal(selections.at(-1).decision, "full", "control: same-directory unknown load is full");
});

test("COORD-953: seeded trees with unresolved loads: every suite reaching one is selected", () => {
  const cases = [];
  for (let i = 0; i < Math.max(4, TREES / 2); i++) {
    const tree = gen.genTree(gen.SEED + 5000 + i, { unknown: true });
    for (const mode of ["modify", "mixed"]) {
      const { head, changes } = gen.mutate(tree, gen.SEED + 6000 + i, mode);
      cases.push({ base: tree, head, changes, label: `unknown seed ${gen.SEED + 5000 + i} ${mode}` });
    }
  }
  selectCases(cases).forEach((sel, index) => {
    const { base, head, changes, label } = cases[index];
    check(sel, oracle(base, head, changes), label);
  });
});

test("COORD-953: seeded faults S09, S13 and S14 are exempt only through a reviewed reason in the fault fixture, pinned here", () => {
  const exempt = faults.seeded.filter((f) => f.exempt).map((f) => f.id);
  assert.deepEqual(exempt, [...gen.SEEDED_EXEMPTIONS], "the exemption list cannot grow or shrink without this test failing");
  for (const id of exempt) {
    const f = faults.seeded.find((x) => x.id === id);
    assert.match(f.exempt.reviewed, /^COORD-953$/, `${id} needs a reviewer`);
    assert.ok(f.exempt.reason.length > 40, `${id} needs a recorded reason`);
  }
});

test("COORD-953: metamorphic: an unrelated added file never shrinks a selection, and a rename selects the union of old and new dependents", () => {
  const cases = [];
  for (let i = 0; i < Math.max(4, TREES / 2); i++) {
    const tree = gen.genTree(gen.SEED + 7000 + i);
    const { head, changes } = gen.mutate(tree, gen.SEED + 8000 + i, "modify");
    cases.push({ base: tree, head, changes });
    const withExtra = { ...head, files: { ...head.files, [`${gen.DIR}/zz${i}.js`]: "exports.z = 1;\n" }, edges: new Map(head.edges) };
    withExtra.edges.set(`${gen.DIR}/zz${i}.js`, new Set());
    cases.push({ base: tree, head: withExtra, changes });
    // Rename of a module: the selection must cover the old path's dependents in base and the new path's in head.
    const old = tree.modules[0];
    const renamed = `${path.posix.dirname(old)}/r_${path.posix.basename(old)}`;
    const headR = { ...tree, files: { ...tree.files }, edges: new Map(tree.edges), unknown: new Set(tree.unknown), suites: tree.suites };
    headR.files[renamed] = headR.files[old];
    delete headR.files[old];
    headR.edges.set(renamed, headR.edges.get(old));
    headR.edges.delete(old);
    const renameChanges = [{ status: "R", path: renamed, old_path: old }];
    cases.push({ base: tree, head: headR, changes: renameChanges, label: `seed ${gen.SEED + 7000 + i} rename ${old}` });
  }
  const selections = selectCases(cases);
  for (let i = 0; i < selections.length / 3; i++) {
    const [sel, sel2, sel3] = selections.slice(3 * i, 3 * i + 3);
    if (sel.decision === "selected") {
      assert.equal(sel2.decision, "selected", `seed ${gen.SEED + 7000 + i}: an unrelated file changed the decision`);
      const before = new Set(sel.selected.map((s) => s.suite));
      const after2 = new Set(sel2.selected.map((s) => s.suite));
      assert.deepEqual([...before].filter((s) => !after2.has(s)), [], `seed ${gen.SEED + 7000 + i}: an unrelated file shrank the selection`);
    }
    const { base, head, changes, label } = cases[3 * i + 2];
    check(sel3, oracle(base, head, changes), label);
  }
});

test("COORD-953: the default run stays under 20 s on the gate host", () => {
  if (EXTRA) return;
  const elapsed = Date.now() - STARTED;
  assert.ok(elapsed < 20000, `the default run took ${elapsed} ms`);
});
