"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const gatePlan = require("./gate-plan.js");

function withCoordConfigFixture(callback) {
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gates-layout-"));
  try { return callback(coordDir); }
  finally { fs.rmSync(coordDir, { recursive: true, force: true }); }
}
const { evidenceRef, applyInvariantRetraction } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));

function writeMap(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-plan-"));
  const mapPath = path.join(dir, "affected-targets.json");
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
  return mapPath;
}

const MAP = {
  schema_version: 1,
  updated_at: "2026-06-28",
  full_gate: { commands: ["node --test"] },
  targets: [
    {
      id: "unit:planner",
      command: "node --test coord/engine/scripts/gate-plan.test.js",
      files: ["coord/engine/scripts/gate-plan.js", "coord/engine/scripts/gate-plan.test.js"],
    },
    {
      id: "unit:policy",
      command: "node --test coord/engine/scripts/track-evidence-policy.test.js",
      files: ["coord/engine/scripts/track-evidence-policy.js"],
      depends_on: ["unit:planner"],
    },
  ],
};

test("gate plan selects direct and transitive affected targets deterministically", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-379",
    row: { ID: "COORD-379", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" },
    planState: { intended_files: ["coord/engine/scripts/gate-plan.js"], repo_gates: ["node --test"] },
    mapPath: writeMap(MAP),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.track.name, "development");
  assert.equal(receipt.affected_targets.mode, "slice");
  assert.deepEqual(
    receipt.affected_targets.selected.map((target) => target.id),
    ["unit:planner", "unit:policy"]
  );
  assert.equal(receipt.selected_gates[0].id, "track:test");
});

test("gate plan falls back to full for unknown files", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-386",
    row: { ID: "COORD-386", Repo: "X", Type: "feature", Pri: "P2", Description: "affected target maps" },
    planState: { intended_files: ["unknown/file.js"] },
    mapPath: writeMap(MAP),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.match(receipt.fallback_reason, /unknown changed file/);
});

test("COORD-747: real unknown-file fallback selects the canonical recursive runner", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-747",
    row: { ID: "COORD-747", Repo: "X", Type: "bug", Pri: "P3", Description: "fallback routing" },
    planState: { intended_files: ["coord/scripts/new-unknown-surface.js"] },
    mapPath: path.join(__dirname, "..", "..", "gates", "affected-targets.json"),
    now: new Date().toISOString(),
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.deepEqual(receipt.affected_targets.selected.map((entry) => entry.command), ["node coord/scripts/test-runner.js"]);
});

test("default affected-target config resolves engine-first and supports a legacy-only install", () => {
  withCoordConfigFixture((coordDir) => {
    const enginePath = path.join(coordDir, "engine", "gates", "affected-targets.json");
    fs.mkdirSync(path.dirname(enginePath), { recursive: true });
    fs.writeFileSync(enginePath, JSON.stringify({ engine_only: true }));
    assert.equal(gatePlan.defaultMapPath(coordDir), enginePath);
    assert.equal(resolveEngineModule(coordDir, "gates/affected-targets.json"), enginePath);

    fs.rmSync(path.join(coordDir, "engine"), { recursive: true, force: true });
    const legacyPath = path.join(coordDir, "gates", "affected-targets.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ legacy_only: true }));
    assert.equal(gatePlan.defaultMapPath(coordDir), legacyPath);
    assert.equal(resolveEngineModule(coordDir, "gates/affected-targets.json"), legacyPath);
  });
});

test("COORD-947: gate plan engine selection reads no engine map and never reports map_stale for it", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-587",
    row: { ID: "COORD-587", Repo: "X", Type: "feature", Pri: "P2", Description: "gates migration" },
    planState: { intended_files: ["coord/engine/gates/affected-targets.json"] },
    now: new Date().toISOString(),
  });
  assert.equal(receipt.affected_targets.map.path, null, "the deprecated engine map is not read");
  assert.equal(receipt.affected_targets.map.reason, "COORD-924 selector (engine)");
  assert.equal(receipt.affected_targets.map.issues.some((issue) => issue.code === "map_stale"), false);
});

test("engine and compatibility affected-target maps remain byte-identical", () => {
  const enginePath = gatePlan.DEFAULT_MAP_PATH;
  const legacyPath = path.join(__dirname, "..", "..", "gates", "affected-targets.json");
  assert.equal(fs.readFileSync(enginePath).compare(fs.readFileSync(legacyPath)), 0);
});

test("engine and compatibility affected-target schemas remain byte-identical", () => {
  const enginePath = path.join(__dirname, "..", "..", "engine", "gates", "affected-targets.schema.json");
  const legacyPath = path.join(__dirname, "..", "..", "gates", "affected-targets.schema.json");
  assert.equal(fs.readFileSync(enginePath).compare(fs.readFileSync(legacyPath)), 0);
});

test("gate plan falls back to full for stale maps", () => {
  const staleMap = { ...MAP, updated_at: "2025-01-01" };
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-386",
    row: { ID: "COORD-386", Repo: "X", Type: "feature", Pri: "P2", Description: "affected target maps" },
    planState: { intended_files: ["coord/engine/scripts/gate-plan.js"] },
    mapPath: writeMap(staleMap),
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.match(receipt.affected_targets.map.reason, /older than/);
  assert.deepEqual(
    receipt.affected_targets.selected.map((entry) => entry.command),
    ["node coord/scripts/test-runner.js"],
  );
});

test("gate plan uses the canonical runner when the dependency map is missing", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-782",
    row: { ID: "COORD-782", Repo: "X", Type: "bug", Pri: "P1", Description: "affected target fallback" },
    planState: { intended_files: ["coord/engine/scripts/affected-targets.js"] },
    mapPath: path.join(os.tmpdir(), `missing-affected-targets-${process.pid}.json`),
    now: "2026-09-29T12:00:00.000Z",
  });
  assert.equal(receipt.affected_targets.mode, "full");
  assert.equal(receipt.affected_targets.map.fallback, true);
  assert.deepEqual(
    receipt.affected_targets.selected.map((entry) => entry.command),
    ["node coord/scripts/test-runner.js"],
  );
});

test("gate plan resolves configured tracks from prefixes", () => {
  const registryDeps = {
    projectConfig: {
      tracks: {
        marketing: { prefixes: ["WEB"], gateProc: "content", defaultLane: "default" },
      },
    },
  };
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "WEB-101",
    row: { ID: "WEB-101", Repo: "X", Type: "feature", Pri: "P1", Description: "public page" },
    planState: { intended_files: ["coord/product/site.html"] },
    registryDeps,
    mapPath: writeMap(MAP),
    full: true,
    now: "2026-06-28T12:00:00.000Z",
  });
  assert.equal(receipt.track.name, "marketing");
  assert.equal(receipt.track.gate_proc, "content");
});

test("gate plan readiness blocks high-risk missing receipts but not light lane", () => {
  const blocker = gatePlan.collectGatePlanReadinessIssues(
    "OPS-101",
    { ID: "OPS-101", Type: "feature", Pri: "P1", Description: "production deploy" },
    {},
    { now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(blocker.length, 1);
  assert.equal(blocker[0].code, "gate_plan_receipt");

  const light = gatePlan.collectGatePlanReadinessIssues(
    "DOC-101",
    { ID: "DOC-101", Type: "docs", Pri: "P2", Description: "docs" },
    {},
    { lightLane: true, now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(light.length, 0);
});

test("gate plan readiness keeps low-risk receipt evidence issues warning-first", () => {
  const issues = gatePlan.collectGatePlanReadinessIssues(
    "COORD-379",
    { ID: "COORD-379", Type: "feature", Pri: "P1", Description: "gate planner" },
    {
      gate_plan: {
        planner_version: "gate-plan-v1",
        generated_at: "2026-06-28T12:00:00.000Z",
        risk_class: "R2",
        enforcement: "warning-first",
        affected_targets: { mode: "slice", selected: [] },
        evidence_issues: [{ code: "track_evidence_repo_gate", severity: "blocker", message: "missing" }],
      },
    },
    { now: "2026-06-28T12:00:00.000Z" }
  );
  assert.equal(issues.length, 0);
});

test("COORD-807 prototype: risk classification ignores retracted invariant text", () => {
  const oldRisk = "production deployment requires an ADR";
  const corrected = applyInvariantRetraction({ critical_invariants: [oldRisk] }, {
    entry: evidenceRef("critical_invariant", 1, oldRisk),
    reason: "This was an obsolete observation, not a current invariant.",
    actor: "codexa756",
    timestamp: "2026-10-05T19:30:00.000Z",
  }).record;
  const input = { row: { Type: "feature", Description: "ordinary feature" }, track: { name: "unknown" }, files: [] };
  assert.equal(gatePlan.classifyRisk({ ...input, planState: { critical_invariants: [oldRisk] } }), "R4");
  assert.equal(gatePlan.classifyRisk({ ...input, planState: corrected }), "R1");
});

test("COORD-807: risk classes come from active evidence, declared surfaces and the changed files", () => {
  const classify = (overrides = {}) => gatePlan.classifyRisk({
    row: { Type: "feature", Description: "ordinary feature" }, track: { name: "unknown" }, files: [], planState: {}, ...overrides,
  });
  assert.equal(classify(), "R1");
  // Non-invariant plan evidence still raises the class after the active-evidence join.
  assert.equal(classify({ planState: { security_surface: "tenant permission boundary" } }), "R3");
  assert.equal(classify({ planState: { bootstrap_risk: { startup_work_class: "production_repair" } } }), "R4");
  assert.equal(classify({ planState: { bootstrap_risk: { startup_work_class: "local_script" } } }), "R1");
  assert.equal(classify({ planState: { live_mcp: { operation_class: "write_prod" } } }), "R4");
  assert.equal(classify({ planState: { live_mcp: { operation_class: "read" } } }), "R1");
  assert.equal(classify({ track: { name: "product-engineering" } }), "R2");
  assert.equal(classify({ planState: { critical_invariants: ["shared orchestration stays serialized"] } }), "R2");

  // R0 is reserved for docs/chore rows that change prose files only.
  const docs = { Type: "docs", Description: "wording" };
  assert.equal(classify({ row: docs, files: ["README.md", "notes.txt"] }), "R0");
  assert.equal(classify({ row: docs, files: [] }), "R1");
  assert.equal(classify({ row: docs, files: ["README.md", "tool.js"] }), "R1");
  assert.equal(classify({ files: ["README.md"] }), "R1");

  // A retracted R2 phrase does not keep a docs-only change out of R0.
  const stale = "shared orchestration stays serialized";
  const retracted = applyInvariantRetraction({ critical_invariants: [stale] }, {
    entry: evidenceRef("critical_invariant", 1, stale),
    reason: "Recorded against the wrong ticket.",
    actor: "codexa756",
    timestamp: "2026-10-05T19:30:00.000Z",
  }).record;
  assert.equal(classify({ row: docs, files: ["README.md"], planState: { critical_invariants: [stale] } }), "R2");
  assert.equal(classify({ row: docs, files: ["README.md"], planState: retracted }), "R0");
});

test("standalone run is read-only without --write", () => {
  const lines = [];
  const result = gatePlan.run(["COORD-379", "--files", "coord/engine/scripts/gate-plan.js", "--map", writeMap(MAP)], {
    row: { ID: "COORD-379", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" },
    planState: { repo_gates: ["node --test"] },
    now: "2026-06-28T12:00:00.000Z",
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(lines.join("")).ticket_id, "COORD-379");
});

// COORD-690 (review round 1): declared_files carries forward from the previous
// receipt, which makes anything recorded there permanent. A comma-joined entry
// (one `--files` argument naming eleven paths) therefore became evidence
// metadata that no regeneration could correct. It must resolve into the real
// paths it names rather than persist as one uninterpretable string.
test("COORD-690: a comma-joined declared_files entry resolves into its real paths on regeneration", () => {
  const receipt = gatePlan.buildGatePlanReceipt({
    ticketId: "COORD-690",
    row: { ID: "COORD-690", Repo: "X", Type: "bug", Pri: "P1" },
    planState: {
      intended_files: ["coord/engine/scripts/guided-closeout.js"],
      gate_plan: {
        declared_files: ["coord/engine/scripts/plan-records.js,coord/engine/scripts/gate-plan.js"],
      },
    },
  });
  assert.ok(
    receipt.declared_files.every((entry) => !entry.includes(",")),
    `no declared file may name several paths: ${JSON.stringify(receipt.declared_files)}`
  );
  assert.ok(receipt.declared_files.includes("coord/engine/scripts/plan-records.js"));
  assert.ok(receipt.declared_files.includes("coord/engine/scripts/gate-plan.js"));
  assert.ok(receipt.declared_files.includes("coord/engine/scripts/guided-closeout.js"));
});

// Exercise actual process status and flushed output, not an injected run() result.
test("COORD-587: gate-plan CLI preserves success JSON and argument failure status", () => {
  const { spawnSync } = require("node:child_process");
  const cli = path.join(__dirname, "gate-plan.js");
  const success = spawnSync(process.execPath, [cli, "COORD-587", "--full"], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ticket_id, "COORD-587");
  const failure = spawnSync(process.execPath, [cli, "--unsupported-587"], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stdout, /gate-plan:/);
});

test("COORD-924: gate-plan options, the row's ticket id and a track override reach the receipt", () => {
  const now = "2026-06-28T12:00:00.000Z";
  assert.deepEqual(gatePlan.parseArgs(["COORD-7", "--json", "--md", "--write", "--risk", "R2", "--track", "marketing"]).options,
    { files: [], json: true, md: true, write: true, full: false, ticketId: "COORD-7", riskClass: "R2", trackOverride: "marketing" });
  const mapPath = writeMap(MAP);
  const row = { ID: "COORD-7", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" };
  assert.equal(gatePlan.buildGatePlanReceipt({ row, mapPath, now }).ticket_id, "COORD-7", "the ticket id falls back to the board row");
  assert.throws(() => gatePlan.buildGatePlanReceipt({ mapPath, now }), /gate plan requires a ticket id/);
  assert.equal(gatePlan.buildGatePlanReceipt({ ticketId: "COORD-7", trackOverride: "marketing", mapPath, now }).track.name, "marketing");
  const lines = [];
  assert.equal(gatePlan.run(["COORD-7", "--map", mapPath, "--md"], { row, log: (line) => lines.push(String(line)), now }).code, 0);
  assert.match(lines.join(""), /^# Gate plan: COORD-7\n/, "--md renders the receipt as Markdown");
  const withEvidence = { ...gatePlan.buildGatePlanReceipt({ row, mapPath, now }), required_evidence: ["unit test output", "gate log"] };
  assert.match(gatePlan.renderMarkdown(withEvidence), /\n## Required Evidence\n- unit test output\n- gate log\n/, "required evidence is listed under its own heading");
});

test("COORD-924: with --base the receipt names the landing gate the selection policy requires", (t) => {
  const lines = [];
  const seen = [];
  const result = gatePlan.run(["COORD-924", "--files", "coord/engine/scripts/gate-plan.js", "--map", writeMap(MAP), "--base", "dev"], {
    row: { ID: "COORD-924", Repo: "X", Type: "feature", Pri: "P1", Description: "gate planner" },
    planState: { repo_gates: ["node --test"] },
    now: "2026-06-28T12:00:00.000Z",
    log: (line) => lines.push(String(line)),
    landingGateSummary: (args) => { seen.push(args); return { gate: "affected", tier: "T1", reason: "r", suites: ["a.test.js"] }; },
  });
  assert.deepEqual([result.code, seen, result.receipt.landing_gate.gate], [0, [{ base: "dev" }], "affected"]);
  assert.equal("landing_gate" in gatePlan.run(["COORD-924", "--map", writeMap(MAP)], { log: () => {}, now: "2026-06-28T12:00:00.000Z" }).receipt, false, "without --base the receipt is unchanged");
  const shipped = gatePlan.run(["COORD-924", "--map", writeMap(MAP), "--base", "HEAD"], { log: () => {}, now: "2026-06-28T12:00:00.000Z" }).receipt.landing_gate;
  assert.equal(shipped.gate, "affected", "without an injected summary the shipped COORD-941 policy is active for this T1 change");
  assert.doesNotMatch(shipped.reason || "", /^affected selection is shadow/, "the shipped active policy is not silently treated as shadow");
  const selector = require("./affected-selector.js");
  const landing = require("./affected-landing.js");
  const shadowPolicy = { ...selector.loadPolicy(), initial_state: "shadow" };
  const shadowFixture = { landingGateFor: (args) => landing.landingGateFor({ ...args, policy: shadowPolicy }) };
  const rollback = gatePlan.landingGateSummary({ base: "HEAD", root: path.resolve(__dirname, "../../.."), landing: shadowFixture });
  assert.deepEqual([rollback.gate, /^affected selection is shadow/.test(rollback.reason)], ["full", true], "an explicitly shadow-configured rollback policy keeps the full gate");
  const stub = { landingGateFor: (args) => ({ gate: { gate: "full", tier: "T2", reason: `T2 at ${args.base}` }, ledger: args.ledgerDir }) };
  assert.deepEqual(gatePlan.landingGateSummary({ base: "dev", root: "/r", landing: stub }), { gate: "full", tier: "T2", reason: "T2 at dev", suites: [], would_gate: "full", would_suites: [] });
  const { initRepo, git } = require("./affected-evaluation.js");
  const root = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), "gate-plan-924-")), { "README.md": "# r\n", "coord/board/tasks.json": "{\"metadata\":{}}\n" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = gatePlan.landingGateSummary({ base: git(root, ["rev-parse", "HEAD"]), root });
  assert.equal(real.gate, "full");
  assert.doesNotMatch(real.reason || "", /^affected selection is shadow/, "the active policy falls back to full when the fixture lacks a readable guard registry");
  assert.deepEqual([real.would_gate, real.would_suites], ["full", []], "a workspace without a guard registry cannot be classified, so selection would not reduce it either");
  const unclassified = gatePlan.buildGatePlanReceipt({
    row: { ID: "COORD-924", Repo: "X", Type: "feature", Pri: "P1" },
    root, base: "HEAD", changedFiles: ["coord/engine/scripts/unknown.js"],
  });
  assert.match(unclassified.affected_targets.reason, /incomplete_analysis/);
  const createCommands = require("./lifecycle-gate-code-commands.js");
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(line);
  try {
    const commands = createCommands({
      gatePlan: { buildGatePlanReceipt: (input) => ({ landing_gate: input.landingGate }), landingGateSummary: (args) => ({ gate: "full", base: args.base }), renderMarkdown: () => "" },
      fail: (m) => { throw new Error(m); }, getTicketRef: () => ({ row: {} }), readBoard: () => ({}), readPlanRecord: () => ({}), readPlanState: () => ({}), toArray: (v) => [].concat(v || []), updatePlanBlock: () => {},
    });
    assert.deepEqual(commands.gatePlanCommand("COORD-924", { base: "dev" }).landing_gate, { gate: "full", base: "dev" });
    assert.equal(commands.gatePlanCommand("COORD-924", {}).landing_gate, null);
    const inputs = [];
    const written = [];
    const make = (over = {}) => createCommands({
      gatePlan: { buildGatePlanReceipt: (input) => { inputs.push(input); return { ticket_id: input.ticketId }; }, landingGateSummary: () => null, renderMarkdown: () => "# receipt\n" },
      fail: (m) => { throw new Error(m); }, getTicketRef: (board, id) => (id === "COORD-924" ? { row: { ID: id } } : null), readBoard: () => ({}),
      readPlanRecord: () => null, readPlanState: () => null, toArray: (v) => [].concat(v || []), updatePlanBlock: (id, block) => written.push([id, block]), ...over,
    });
    assert.throws(() => make().gatePlanCommand(), /gate-plan requires <ticket-id>\./);
    assert.throws(() => make().gatePlanCommand("COORD-0"), /Unknown ticket "COORD-0"\./);
    make().gatePlanCommand("COORD-924", { write: true, md: true });
    assert.deepEqual([inputs.at(-1).planState, written, logged.at(-1)], [{}, [["COORD-924", { gatePlan: "{\"ticket_id\":\"COORD-924\"}" }]], "# receipt"], "no plan record or state: an empty plan; --write records, --md renders");
    make({ readPlanState: () => ({ from: "state" }) }).gatePlanCommand("COORD-924", {});
    assert.deepEqual(inputs.at(-1).planState, { from: "state" }, "the plan state is the fallback for a missing plan record");
  } finally {
    console.log = original;
  }
});

test("lifecycle gate-plan previews the requested risk and its write respects the missing-journal guard", (t) => {
  const { withGovernedSurfaceSandbox } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
  const { gatePlanCommand } = require("./lifecycle.js").commands;
  const ticket = "COORD-379";
  const mapPath = writeMap({ ...MAP, updated_at: new Date().toISOString().slice(0, 10) });
  t.after(() => fs.rmSync(path.dirname(mapPath), { recursive: true, force: true }));
  withGovernedSurfaceSandbox(({ boardPath, recordsDir, planPath }) => {
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [{
      ID: ticket, Repo: "X", Type: "feature", Pri: "P1", Status: "todo", Description: "gate planner",
    }] }] }));
    const before = fs.readFileSync(planPath);
    const preview = gatePlanCommand(ticket, { risk: ["R2"], files: ["coord/engine/scripts/gate-plan.js"], mapPath });
    assert.equal(preview.risk_class, "R2");
    assert.deepEqual(preview.affected_targets.selected.map((target) => target.id), ["unit:planner", "unit:policy"]);
    assert.throws(() => gatePlanCommand(ticket, { write: true, mapPath }), /Refusing to auto-baseline the governance journal/);
    assert.deepEqual(fs.readdirSync(recordsDir), []);
    assert.deepEqual(fs.readFileSync(planPath), before);
  });
});
