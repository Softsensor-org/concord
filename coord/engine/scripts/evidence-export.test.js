const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { evidenceRef, stableSupersessionId, stableDispositionId } = require("./plan-evidence-supersession.js");

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
  const oldInvariant = "i1";
  const invariantRef = evidenceRef("critical_invariant", 1, oldInvariant);
  writeJson(path.join(coord, ".runtime", "plans", "OK-001.json"), {
    requirement_closure: ["Ticket ask: x", "Implemented: y", "Closeout verdict: complete"],
    feature_proof: ["path:a", "symbol:b#c", "text:d", "route:/e"],
    repo_gates: ["npm test [result=pass] - ok"],
    self_review_cycles: [{ lens: "1", verdict: "pass" }, { lens: "2", verdict: "pass" }, { lens: "3", verdict: "pass" }, { lens: "4", verdict: "pass" }],
    critical_invariants: [oldInvariant, "i2"],
    evidence_dispositions: [{
      id: stableDispositionId(invariantRef, "retracted"), kind: "critical_invariant", source_ref: invariantRef,
      disposition: "retracted", reason: "Retired fixture invariant.", actor: "fixture",
      timestamp: "2026-10-05T19:30:00.000Z",
    }],
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
  assert.deepEqual(t.critical_invariants, ["i2"]);
  assert.equal(t.critical_invariant_history[0].status, "retracted");
  assert.equal(t.critical_invariant_history[0].value, "i1");
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

// Mutation canary: bypassing either the current-evidence projection or history
// join leaves the old pass in repo_gates or drops its source/reason assertions.
test("COORD-713: export separates current gate evidence from historical correction provenance", async () => {
  const { coord } = fixture();
  const planPath = path.join(coord, ".runtime", "plans", "OK-001.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.repo_gates = ["npm test [result=pass] stale head", "npm run full-gate [result=pass] current head"];
  const sourceRef = evidenceRef("repo_gate", 1, plan.repo_gates[0]);
  const successorRef = evidenceRef("repo_gate", 2, plan.repo_gates[1]);
  plan.evidence_supersessions = [{
    id: stableSupersessionId(sourceRef, successorRef), kind: "repo_gate", source_ref: sourceRef,
    successor_ref: successorRef, reason: "The prior result was tied to an old head.", actor: "fixture-agent",
    timestamp: "2026-10-05T00:00:00.000Z",
  }];
  writeJson(planPath, plan);
  const { out } = await run(coord, ["--ticket", "OK-001"]);
  const ticket = JSON.parse(out).tickets.find((entry) => entry.id === "OK-001");
  assert.deepEqual(ticket.repo_gates, [plan.repo_gates[1]]);
  assert.equal(ticket.evidence_supersessions.length, 1);
  assert.equal(ticket.evidence_supersessions[0].source.value, plan.repo_gates[0]);
  assert.equal(ticket.evidence_supersessions[0].reason, "The prior result was tied to an old head.");
});

test("COORD-860: managed execution evidence exports only the redacted summary and keeps unmanaged distinct", async () => {
  const { coord } = fixture();
  const canary = "cnry-860-export-3c7a1e";
  const H = "a".repeat(64);
  const summary = (verdict, gaps = []) => ({
    schema: "coord.managed-execution-summary/v1", ticket: "OK-001", session: "s1", provider: "codex", policy_digest: H, chain_root: H,
    session_head: H, base_commit: "b".repeat(40), head_commit: "c".repeat(40), integrity: "valid", coverage: verdict === "complete" ? "complete" : "interrupted",
    counts: { entries: 4, legacy_v1: 0, session_events: 4, effects: 1, changed_paths: 1, commits: 0, by_class: { file: 1 } },
    gaps, unexplained: [], diff_digest: verdict === "complete" ? `sha256:${H}` : null, verdict, summary_digest: "d".repeat(64),
  });
  const planFile = (id) => path.join(coord, ".runtime", "plans", `${id}.json`);
  const read = (id) => JSON.parse(fs.readFileSync(planFile(id), "utf8"));
  const exception = { schema: "coord.managed-execution-exception/v1", summary_digest: "d".repeat(64), chain_root: H, gaps: ["coverage_interrupted"],
    reason: "adapter outage", residual_risk: "unobserved tail", approval: `approved ${canary}`, actor: "claudea12", recorded_at: "2026-10-25T00:00:00.000Z", legal_waiver: false };
  writeJson(planFile("OK-001"), { ...read("OK-001"), managed_execution: { summary: summary("complete"), exception: null, recorded_at: "2026-10-25T00:00:00.000Z", actor: "claudea12", raw_ledger: canary } });
  writeJson(planFile("GAP-001"), { ...read("GAP-001"), managed_execution: { summary: summary("incomplete", ["coverage_interrupted"]), exception, recorded_at: "2026-10-25T00:00:00.000Z", actor: "claudea12" } });
  // The raw local ledger is never opened by the exporter.
  fs.mkdirSync(path.join(coord, ".runtime", "action-ledgers"), { recursive: true });
  fs.writeFileSync(path.join(coord, ".runtime", "action-ledgers", "OK-001.ndjson"), `${JSON.stringify({ secret: canary })}\n`);
  const { out } = await run(coord, ["--ticket", "OK-001", "--ticket", "GAP-001"]);
  assert.equal(out.includes(canary), false, "no raw ledger row, unknown field or approval text is exported");
  const [ok, gap] = JSON.parse(out).tickets;
  assert.equal(ok.managed_execution.label, "complete");
  assert.equal(ok.evidence_status.managed_execution, "present");
  assert.equal(ok.managed_execution.summary.chain_root, H);
  assert.match(ok.managed_execution.claim_limit, /not a legal waiver/);
  assert.equal(gap.managed_execution.label, "technical-exception");
  assert.equal(gap.managed_execution.exception.residual_risk, "unobserved tail");
  assert.equal(gap.managed_execution.exception.legal_waiver, false);
  assert.equal(gap.managed_execution.summary.verdict, "incomplete", "the exception never rewrites the verdict");
  const md = (await run(coord, ["--ticket", "OK-001", "--ticket", "GAP-001", "--format", "md"])).out;
  assert.match(md, /- Managed execution: complete · coverage complete/);
  assert.match(md, /- Managed execution: technical-exception · coverage interrupted · chain root `aaaaaaaaaaaaaaaa` · diff unavailable · ⚠️ coverage_interrupted · technical exception by claudea12 \(not a legal waiver\)/);
  // A stale exception does not bind, and an unexcepted gap is absent evidence.
  writeJson(planFile("GAP-001"), { ...read("GAP-001"), managed_execution: { ...read("GAP-001").managed_execution, exception: { ...exception, summary_digest: H } } });
  const stale = JSON.parse((await run(coord, ["--ticket", "GAP-001"])).out).tickets[0];
  assert.equal(stale.managed_execution.label, "incomplete");
  assert.equal(stale.managed_execution.exception, null);
  assert.ok(stale.evidence_gaps.includes("managed_execution"));
  const unmanaged = JSON.parse((await run(coord, ["--ticket", "UNKNOWN-1"])).out).tickets[0];
  assert.equal(unmanaged.managed_execution.label, "unmanaged");
  assert.equal(unmanaged.evidence_status.managed_execution, "not_applicable");
  assert.match((await run(coord, ["--ticket", "UNKNOWN-1", "--format", "md"])).out, /- Managed execution: unmanaged \(no managed-auto session recorded\)/);
});
