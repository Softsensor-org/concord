const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

async function run(coord, extra = []) {
  const mod = await import(pathToFileURL(SCRIPT).href);
  const stdout = [];
  const stderr = [];
  const code = mod.runCli(["--coord-dir", coord, "--framework", "eu-ai-act", ...extra], {
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
  });
  return { out: stdout.join(""), err: stderr.join(""), code };
}

test("evidence-export: complete ticket has all evidence and covered controls", async () => {
  const { coord } = fixture();
  const { out, code } = await run(coord, ["--ticket", "OK-001"]);
  const pkg = JSON.parse(out);
  const t = pkg.tickets[0];
  assert.equal(t.id, "OK-001");
  assert.equal(t.complete, true, "complete ticket should have no gaps");
  assert.deepEqual(t.evidence_gaps, []);
  const eu = pkg.frameworks[0];
  assert.ok(eu.controls.every((c) => c.status === "covered"), "all controls covered");
  assert.equal(code, 0, "exit 0 when no gaps");
});

test("evidence-export: fails closed on a ticket missing required evidence", async () => {
  const { coord } = fixture();
  const { out, code } = await run(coord, ["--ticket", "GAP-001"]);
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

test("evidence-export: output is deterministic / hash-stable for the same input", async () => {
  const { coord } = fixture();
  const a = (await run(coord, ["--ticket", "OK-001"])).out;
  const b = (await run(coord, ["--ticket", "OK-001"])).out;
  assert.equal(a, b, "same input must produce byte-identical output (no wall-clock in payload)");
  const pkg = JSON.parse(a);
  assert.match(pkg.integrity.journal_sha256, /^[0-9a-f]{64}$/);
});

test("evidence-export: never invents data — read-only over governed state", async () => {
  const { coord } = fixture();
  const before = fs.readFileSync(path.join(coord, "board", "tasks.json"), "utf8");
  await run(coord, ["--ticket", "OK-001"]);
  const after = fs.readFileSync(path.join(coord, "board", "tasks.json"), "utf8");
  assert.equal(before, after, "export must not mutate board state");
});

// COORD-156: live-MCP evidence section --------------------------------------

/** Adds a live-MCP ticket (declared `live_mcp` plan object) to a fixture coord. */
function addLiveMcp(coord, { id, declaration, receipt }) {
  // Register the ticket on the board so its status is surfaced.
  const boardPath = path.join(coord, "board", "tasks.json");
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  board.sections[0].rows.push({
    ID: id, Repo: "X", Type: "feature", Pri: "P2", Status: "doing", Owner: "a", Description: "", "Depends On": "",
  });
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
  // Declare the live_mcp plan object.
  writeJson(path.join(coord, ".runtime", "plans", `${id}.json`), { live_mcp: declaration });
  // Record a receipt under the ticket slug (matches runtime-evidence naming).
  if (receipt) {
    const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    writeJson(path.join(coord, "evidence", "live-mcp", `20260601T0000-${slug}-op.json`), receipt);
  }
}

test("evidence-export: surfaces live-MCP tickets with adapter/class/environment + receipt", async () => {
  const { coord } = fixture();
  addLiveMcp(coord, {
    id: "LIVE-001",
    declaration: {
      adapter: "aws-cli", operation: "describe", operation_class: "read_safe",
      environment: "prod", scope: "account 123",
      receipt_path: "coord/evidence/live-mcp/20260601T0000-live-001-op.json",
    },
    receipt: { kind: "live-mcp", ticket: "LIVE-001", operation_class: "read_safe", result: "observed" },
  });
  const { out } = await run(coord);
  const pkg = JSON.parse(out);
  assert.ok(pkg.live_mcp, "package must carry a live_mcp section");
  const t = pkg.live_mcp.tickets.find((x) => x.id === "LIVE-001");
  assert.ok(t, "declared live-MCP ticket must be listed");
  assert.equal(t.adapter, "aws-cli");
  assert.equal(t.operation_class, "read_safe");
  assert.equal(t.environment, "prod");
  assert.equal(t.receipt_present, true, "recorded receipt must be included");
  assert.equal(t.receipt.result, "observed");
  assert.equal(pkg.summary.live_mcp_tickets, 1);
});

test("evidence-export: live-MCP section honestly shows UNRESOLVED cleanup/promote blockers", async () => {
  const { coord } = fixture();
  // write_prod requires approval + redaction + cleanup + a receipt; omit them so
  // the lifecycle gate yields unresolved blockers the export must surface.
  addLiveMcp(coord, {
    id: "LIVE-002",
    declaration: {
      adapter: "ecs", operation: "run-task", operation_class: "write_prod",
      environment: "prod", scope: "cluster x", product_impact: true,
    },
    receipt: null,
  });
  const { out } = await run(coord);
  const pkg = JSON.parse(out);
  const t = pkg.live_mcp.tickets.find((x) => x.id === "LIVE-002");
  assert.ok(t, "declared live-MCP ticket must be listed even when not done");
  assert.equal(t.receipt_present, false, "missing receipt is surfaced as absent, not omitted");
  const codes = t.unresolved_blockers.map((b) => b.code);
  assert.ok(codes.includes("live_mcp_cleanup"), "unresolved cleanup blocker must be shown");
  assert.ok(codes.includes("live_mcp_promotion"), "unresolved promotion blocker must be shown");
  assert.ok(pkg.summary.live_mcp_with_unresolved_blockers >= 1);
});

test("evidence-export: no live-MCP tickets → empty live_mcp section, no spurious gaps", async () => {
  const { coord } = fixture();
  const { out } = await run(coord, ["--ticket", "OK-001"]);
  const pkg = JSON.parse(out);
  assert.ok(pkg.live_mcp, "live_mcp section is always present");
  assert.equal(pkg.live_mcp.total, 0, "no declared live-MCP tickets in the base fixture");
  assert.deepEqual(pkg.live_mcp.tickets, []);
});
