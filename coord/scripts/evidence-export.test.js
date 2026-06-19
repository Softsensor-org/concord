const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "evidence-export.mjs");

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

/** Builds a self-contained fixture coord dir with one complete + one gappy ticket. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evx-"));
  const coord = path.join(root, "coord");
  writeJson(path.join(coord, "board", "tasks.json"), {
    version: 1,
    metadata: { title: "T" },
    sections: [{
      kind: "table", heading: "B",
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: [
        { ID: "OK-001", Repo: "B", Type: "feature", Pri: "P2", Status: "done", Owner: "a", Description: "", "Depends On": "" },
        { ID: "GAP-001", Repo: "B", Type: "feature", Pri: "P2", Status: "done", Owner: "a", Description: "", "Depends On": "" },
      ],
    }],
    prompt_index: {}, pr_index: { "OK-001": ["pr"], "GAP-001": ["pr"] },
    landing_index: { "OK-001": { commit_sha: "abc" } }, review_findings: {},
    followup_exceptions: {}, waiver_index: {},
  });
  // complete ticket: closure complete, 4 cycles, 4 proofs, gate pass
  writeJson(path.join(coord, ".runtime", "plans", "OK-001.json"), {
    requirement_closure: ["Ticket ask: x", "Implemented: y", "Closeout verdict: complete"],
    feature_proof: ["path:a", "symbol:b#c", "text:d", "route:/e"],
    repo_gates: ["npm test [result=pass] - ok"],
    self_review_cycles: [{ lens: "1", verdict: "pass" }, { lens: "2", verdict: "pass" }, { lens: "3", verdict: "pass" }, { lens: "4", verdict: "pass" }],
    critical_invariants: ["i1", "i2"],
  });
  // gappy ticket: no closure verdict, 0 proofs, 1 cycle, no gate
  writeJson(path.join(coord, ".runtime", "plans", "GAP-001.json"), {
    requirement_closure: ["Ticket ask: x"],
    feature_proof: [], repo_gates: [], self_review_cycles: [{ lens: "1", verdict: "pass" }], critical_invariants: [],
  });
  fs.writeFileSync(path.join(coord, ".runtime", "governance-events.ndjson"),
    [JSON.stringify({ ts: "2026-06-01T00:00:00Z", command: "start", ticket: "OK-001", after_status: "doing", identity: { owner: "a" } }),
     JSON.stringify({ ts: "2026-06-02T00:00:00Z", command: "land", ticket: "OK-001", after_status: "done", identity: { owner: "a" } }),
     JSON.stringify({ ts: "2026-06-01T00:00:00Z", command: "start", ticket: "GAP-001", after_status: "doing", identity: { owner: "a" } })].join("\n") + "\n");
  // minimal control maps
  writeJson(path.join(coord, "product", "control-maps", "eu-ai-act.json"), {
    framework: "EU AI Act", version: "t",
    controls: [
      { id: "Art. 11 / Annex IV", title: "Tech docs", evidence: ["requirement_closure", "feature_proof"] },
      { id: "Art. 12", title: "Logging", evidence: ["journal_log"] },
    ],
  });
  return { root, coord };
}

function run(coord, extra = []) {
  try {
    const out = execFileSync("node", [SCRIPT, "--coord-dir", coord, "--framework", "eu-ai-act", ...extra], { encoding: "utf8" });
    return { out, code: 0 };
  } catch (e) {
    return { out: e.stdout || "", code: e.status };
  }
}

test("evidence-export: complete ticket has all evidence and covered controls", () => {
  const { coord } = fixture();
  const { out, code } = run(coord, ["--ticket", "OK-001"]);
  const pkg = JSON.parse(out);
  const t = pkg.tickets[0];
  assert.equal(t.id, "OK-001");
  assert.equal(t.complete, true, "complete ticket should have no gaps");
  assert.deepEqual(t.evidence_gaps, []);
  const eu = pkg.frameworks[0];
  assert.ok(eu.controls.every((c) => c.status === "covered"), "all controls covered");
  assert.equal(code, 0, "exit 0 when no gaps");
});

test("evidence-export: fails closed on a ticket missing required evidence", () => {
  const { coord } = fixture();
  const { out, code } = run(coord, ["--ticket", "GAP-001"]);
  const pkg = JSON.parse(out);
  const t = pkg.tickets[0];
  assert.equal(t.complete, false);
  assert.ok(t.evidence_gaps.includes("requirement_closure"));
  assert.ok(t.evidence_gaps.includes("feature_proof"));
  assert.ok(t.evidence_gaps.includes("review_cycles"));
  const techdocs = pkg.frameworks[0].controls.find((c) => c.control === "Art. 11 / Annex IV");
  assert.equal(techdocs.status, "gap", "control with missing evidence is a gap, not omitted");
  assert.equal(code, 3, "non-zero exit when gaps (CI fail-closed)");
});

test("evidence-export: output is deterministic / hash-stable for the same input", () => {
  const { coord } = fixture();
  const a = run(coord, ["--ticket", "OK-001"]).out;
  const b = run(coord, ["--ticket", "OK-001"]).out;
  assert.equal(a, b, "same input must produce byte-identical output (no wall-clock in payload)");
  const pkg = JSON.parse(a);
  assert.match(pkg.integrity.journal_sha256, /^[0-9a-f]{64}$/);
});

test("evidence-export: never invents data — read-only over governed state", () => {
  const { coord } = fixture();
  const before = fs.readFileSync(path.join(coord, "board", "tasks.json"), "utf8");
  run(coord, ["--ticket", "OK-001"]);
  const after = fs.readFileSync(path.join(coord, "board", "tasks.json"), "utf8");
  assert.equal(before, after, "export must not mutate board state");
});
