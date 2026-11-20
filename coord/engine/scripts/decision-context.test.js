"use strict";
// COORD-932: one versioned --decision-context packet expands into the existing
// canonical plan fields (adr_refs, decision_required, the business-context
// invariant, context_pack_ack). These tests are written before the module.
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { state: governanceState } = require("./governance-context.js");
const { executeCommand, withRegisterPromptHarness, __testing } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/governance-test-utils.js"));
const { parseFlags } = require("./cli.js").__testing;
const { parseLifecycleFlags } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/lifecycle-flags.js"))({});
const { BUSINESS_CONTEXT_INVESTIGATION_STATUSES, BUSINESS_CONTEXT_INVESTIGATION_PATTERN } =
  require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
const decisionContext = require("./decision-context.js");

const VALID = {
  schema_version: 1,
  adr_refs: ["ADR-0021"],
  decision_required: { required: true, status: "required", reason: "decision surface", adr_refs: ["ADR-0021"] },
  business_context: { status: "not-required" },
  context_pack_ack: { refs: ["coord/AGENTS.md"], considered: { adrs: ["ADR-0021"] } },
};

// ---- pure module: versioning, fail-closed keys, all problems together ------

test("COORD-932: the packet schema is versioned and only version 1 is accepted", () => {
  assert.equal(decisionContext.DECISION_CONTEXT_SCHEMA_VERSION, 1);
  for (const bad of [{ ...VALID, schema_version: 2 }, { ...VALID, schema_version: "1" }, (({ schema_version, ...rest }) => rest)(VALID)]) {
    const result = decisionContext.expandDecisionContext(bad);
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), /schema_version/);
  }
});

test("COORD-932: unknown keys are refused fail closed, including review verdicts", () => {
  for (const key of ["review_cycle", "waiver", "adr_refs_extra", "verdict"]) {
    const result = decisionContext.expandDecisionContext({ ...VALID, [key]: "x" });
    assert.equal(result.ok, false, `${key} accepted`);
    assert.match(result.problems.join("\n"), new RegExp(`unknown key "${key}"`));
  }
  const nested = decisionContext.expandDecisionContext({ ...VALID, business_context: { status: "not-required", waiver: "x" } });
  assert.equal(nested.ok, false);
  assert.match(nested.problems.join("\n"), /business_context.*unknown key "waiver"/);
});

test("COORD-932: structural problems are reported together, not one at a time", () => {
  const result = decisionContext.expandDecisionContext({
    schema_version: 9,
    adr_refs: ["not-an-adr"],
    business_context: { status: "bogus" },
    surprise: true,
  });
  assert.equal(result.ok, false);
  const text = result.problems.join("\n");
  assert.match(text, /schema_version/);
  assert.match(text, /unknown key "surprise"/);
  assert.match(text, /adr_refs/);
  assert.match(text, /business_context\.status/);
  assert.ok(result.problems.length >= 4, `expected all four problems, got ${result.problems.length}`);
});

test("COORD-932: a missing binding still refuses (required decision without any ADR ref)", () => {
  const result = decisionContext.expandDecisionContext({
    schema_version: 1,
    decision_required: { required: true, status: "required", reason: "decision surface" },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /decision_required\.required is true but no ADR ref is bound/);
});

test("COORD-932: a valid packet expands into the existing canonical field options", () => {
  const result = decisionContext.expandDecisionContext(VALID);
  assert.equal(result.ok, true, result.problems?.join("\n"));
  assert.deepEqual(result.options.adrRef, ["ADR-0021"]);
  assert.deepEqual(result.options.decisionRequired, VALID.decision_required);
  assert.deepEqual(result.options.contextPackAck, VALID.context_pack_ack);
  assert.deepEqual(result.options.invariant, ["business-context status: not-required"]);
});

test("COORD-932: the expanded business-context invariant is recognized by the existing gate", () => {
  const result = decisionContext.expandDecisionContext({ ...VALID, business_context: { status: "investigated", ref: "context-pack.json" } });
  assert.equal(result.ok, true, result.problems?.join("\n"));
  const [statusLine, refLine] = result.options.invariant;
  assert.match(statusLine, BUSINESS_CONTEXT_INVESTIGATION_PATTERN, `${statusLine} is not a recognized disposition`);
  assert.match(refLine, /^business-context: context-pack\.json$/, "the ref must use the business-context ref form the gate reads");
  assert.ok(result.options.invariant.includes("business-context: context-pack.json"));
  assert.ok(BUSINESS_CONTEXT_INVESTIGATION_STATUSES.includes("investigated"));
});

test("COORD-932: an out-of-vocabulary business-context status is refused", () => {
  const result = decisionContext.expandDecisionContext({ ...VALID, business_context: { status: "approved-by-me" } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /business_context\.status must be one of/);
});

test("COORD-932: the derived view of a legacy record matches its canonical source fields", () => {
  const legacy = {
    adr_refs: ["ADR-0021"],
    decision_required: VALID.decision_required,
    context_pack_ack: VALID.context_pack_ack,
    critical_invariants: ["business-context status: not-required", "unrelated invariant"],
  };
  const view = decisionContext.projectDecisionContextView(legacy);
  assert.deepEqual(view, {
    schema_version: 1,
    adr_refs: ["ADR-0021"],
    decision_required: VALID.decision_required,
    business_context: { status: "not-required" },
    context_pack_ack: VALID.context_pack_ack,
  });
  const empty = decisionContext.projectDecisionContextView({});
  assert.deepEqual(empty, { schema_version: 1, adr_refs: [], decision_required: null, business_context: null, context_pack_ack: null });
});

// ---- flags: both parsers accept the packet and its file form ---------------

test("COORD-932: both parsers accept --decision-context and --decision-context-file", (t) => {
  for (const parse of [parseFlags, parseLifecycleFlags]) {
    assert.deepEqual(parse(["--decision-context", "{}"]), { decisionContext: "{}" });
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "c932-flag-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "packet.json");
    fs.writeFileSync(file, JSON.stringify(VALID));
    assert.deepEqual(parse(["--decision-context-file", file]), { decisionContext: JSON.stringify(VALID) });
    assert.throws(() => parse(["--decision-context"]), /requires a value/);
  }
});

// ---- integration through the real update-plan writer -----------------------

function readRecord(ticketId) {
  return JSON.parse(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, `${ticketId}.json`), "utf8"));
}

function harnessRun(run, ticketId) {
  const bind = run(["agentid", "--owner", "claudea11"]);
  assert.equal(bind.ok, true, bind.error);
  const seed = run(["plan", ticketId, "--seed"]);
  assert.equal(seed.ok, true, seed.error);
}

function snapshot() {
  const files = [governanceState.PLAN_PATH, governanceState.BOARD_PATH, governanceState.GOVERNANCE_EVENT_LOG_PATH];
  return files.map((file) => fs.readFileSync(file, "utf8"));
}

test("COORD-932: update-plan --decision-context writes the expanded canonical fields and is a no-op on resubmission", () => {
  withRegisterPromptHarness("c932-packet-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c932-packet-thread" } });
    harnessRun(run, "IMP-932");
    const packet = JSON.stringify(VALID);
    const first = run(["update-plan", "IMP-932", "--decision-context", packet]);
    assert.equal(first.ok, true, first.error);
    const record = readRecord("IMP-932");
    assert.deepEqual(record.adr_refs, ["ADR-0021"]);
    assert.deepEqual(record.decision_required, VALID.decision_required);
    assert.deepEqual(record.context_pack_ack, VALID.context_pack_ack);
    assert.ok(record.critical_invariants.includes("business-context status: not-required"));
    assert.deepEqual(decisionContext.projectDecisionContextView(record), {
      schema_version: 1,
      adr_refs: VALID.adr_refs,
      decision_required: VALID.decision_required,
      business_context: VALID.business_context,
      context_pack_ack: VALID.context_pack_ack,
    }, "the rendered view must match the source data");

    const before = snapshot();
    const recordBefore = fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-932.json"), "utf8");
    const again = run(["update-plan", "IMP-932", "--decision-context", packet]);
    assert.equal(again.ok, true, again.error);
    assert.deepEqual(snapshot(), before, "resubmitting the same packet must not change any artifact");
    assert.equal(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-932.json"), "utf8"), recordBefore);
  });
});

test("COORD-932: an invalid packet changes nothing and reports every problem in one refusal", () => {
  withRegisterPromptHarness("c932-invalid-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c932-invalid-thread" } });
    harnessRun(run, "IMP-932");
    const before = snapshot();
    const recordBefore = fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-932.json"), "utf8");
    const bad = run(["update-plan", "IMP-932", "--decision-context", JSON.stringify({ schema_version: 1, adr_refs: ["nope"], extra: 1, business_context: { status: "bogus" } })]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /unknown key "extra"/);
    assert.match(bad.error, /adr_refs/);
    assert.match(bad.error, /business_context\.status/);
    const unrecognizedRef = run(["update-plan", "IMP-932", "--decision-context", JSON.stringify({
      ...VALID, business_context: { status: "not-required", ref: "status:legacy" },
    })]);
    assert.equal(unrecognizedRef.ok, false);
    assert.match(unrecognizedRef.error, /business-context line .* would not be recognized by the business-context gate/);
    assert.deepEqual(snapshot(), before, "a refused packet must not change the board, plan or events");
    assert.equal(fs.readFileSync(path.join(governanceState.PLAN_RECORDS_DIR, "IMP-932.json"), "utf8"), recordBefore);
  });
});

test("COORD-932: a required decision without an ADR ref refuses through update-plan with no write", () => {
  withRegisterPromptHarness("c932-binding-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c932-binding-thread" } });
    harnessRun(run, "IMP-932");
    const before = snapshot();
    const missing = run(["update-plan", "IMP-932", "--decision-context", JSON.stringify({ schema_version: 1, decision_required: { required: true, status: "required" } })]);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no ADR ref is bound/);
    assert.deepEqual(snapshot(), before);
  });
});

test("COORD-932: per-field flags stay additive, and a packet cannot silently override one", () => {
  withRegisterPromptHarness("c932-additive-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c932-additive-thread" } });
    harnessRun(run, "IMP-932");
    const perField = run(["update-plan", "IMP-932", "--adr-ref", "ADR-0001", "--decision-required", JSON.stringify({ required: false, status: "not-required" })]);
    assert.equal(perField.ok, true, perField.error);
    const before = snapshot();
    const conflict = run(["update-plan", "IMP-932", "--decision-context", JSON.stringify(VALID), "--decision-required", JSON.stringify({ required: false, status: "not-required" })]);
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /decision_required is also given by --decision-required/);
    assert.deepEqual(snapshot(), before);
  });
  const { selectPlanUpdateOptions } = require("./plan-update-options.js");
  assert.deepEqual(selectPlanUpdateOptions({ decisionContext: VALID }),
    selectPlanUpdateOptions({ decisionContext: JSON.stringify(VALID) }));
});

test("COORD-1052: malformed packets and duplicate context acknowledgements refuse without writes", () => {
  withRegisterPromptHarness("c1052-packet-refusal-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c1052-packet-refusal" } });
    harnessRun(run, "IMP-932");
    const before = snapshot();
    const recordPath = path.join(governanceState.PLAN_RECORDS_DIR, "IMP-932.json");
    const recordBefore = fs.readFileSync(recordPath, "utf8");
    for (const [flags, expected] of [
      [["--decision-context", "{invalid"], /--decision-context expects a JSON object/],
      [["--decision-context", JSON.stringify(VALID), "--context-pack-ack", JSON.stringify(VALID.context_pack_ack)], /context_pack_ack is also given by --context-pack-ack/],
    ]) {
      const result = run(["update-plan", "IMP-932", ...flags]);
      assert.equal(result.ok, false);
      assert.match(result.error, expected);
      assert.deepEqual(snapshot(), before);
      assert.equal(fs.readFileSync(recordPath, "utf8"), recordBefore);
    }
  });
});

test("COORD-932: the merged decision-context guard registers the packet implementation", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(ENGINE_COORD_DIR, "engine", "governance-guards.json"), "utf8"));
  const merge = (registry.review?.proposed_merges || []).find((entry) => entry.id === "decision-context-record");
  assert.ok(merge, "decision-context-record proposed merge is missing");
  assert.match(merge.into, /coord\/engine\/scripts\/decision-context\.js/, "the merged entry must name its implementation");
  assert.match(merge.into, /human review/, "the proposal must still say it needs human review");
  assert.ok(__testing, "governance test utils are available");
});

// ---- COORD-1000: follow-up of COORD-932 -------------------------------------

test("COORD-1000: explain shows the derived decision-context view, byte for byte with the stored invariants", () => {
  withRegisterPromptHarness("c1000-explain-", { ticketId: "IMP-932" }, () => {
    const run = (args) => executeCommand(args, { env: { ...process.env, AGENT_THREAD_ID: "c1000-explain-thread" } });
    harnessRun(run, "IMP-932");
    const packet = { ...VALID, business_context: { status: "investigated", ref: "coord/.runtime/context-packs/IMP-932.json" } };
    const written = run(["update-plan", "IMP-932", "--decision-context", JSON.stringify(packet)]);
    assert.equal(written.ok, true, written.error);
    const record = readRecord("IMP-932");
    const expectedLines = decisionContext.expandDecisionContext(packet).options.invariant;
    for (const line of expectedLines) {
      assert.ok(record.critical_invariants.includes(line), `stored invariant must be exactly ${JSON.stringify(line)}`);
    }
    const explained = run(["explain", "IMP-932"]);
    assert.equal(explained.ok, true, explained.error);
    const report = JSON.parse(explained.stdout);
    const view = report.decision_context;
    assert.deepEqual(view, decisionContext.projectDecisionContextView(record), "explain must print the derived view of the stored record");
    // Re-render the view's business-context fields and compare them with the stored invariant lines, byte for byte.
    const rendered = [];
    if (view.business_context.status !== undefined) rendered.push(`business-context status: ${view.business_context.status}`);
    if (view.business_context.ref !== undefined) rendered.push(`business-context: ${view.business_context.ref}`);
    assert.deepEqual(rendered, expectedLines, "the view must match the stored invariant text byte for byte");
    // Additive: the existing explain readiness fields are still present.
    assert.ok(report.submit_readiness && report.start_readiness, "existing explain fields are unchanged");
  });
});

test("COORD-1000: decision_required shape problems are collected with the other packet problems", () => {
  // The shape validator is fail-fast per decision_required object, so the first shape problem is collected.
  const shape = decisionContext.expandDecisionContext({
    schema_version: 1,
    decision_required: { required: "yes", status: "not-required" },
    business_context: { status: "bogus" },
  });
  assert.equal(shape.ok, false);
  assert.ok(shape.problems.some((p) => /decision_required\.required must be a boolean/.test(p)), shape.problems.join(" | "));
  assert.ok(shape.problems.some((p) => /business_context\.status must be one of/.test(p)), "the other problems are still reported together");
  const unknown = decisionContext.expandDecisionContext({ schema_version: 1, decision_required: { required: false, unexpected: true } });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.problems.some((p) => /decision_required contains unknown field "unexpected"/.test(p)), unknown.problems.join(" | "));
});

test("COORD-1000: the view reads invariants through the shared business-context parser", () => {
  const gate = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
  assert.equal(typeof gate.parseBusinessContextInvariant, "function", "the gate must export its invariant parser");
  assert.deepEqual(gate.parseBusinessContextInvariant("business-context status: investigated"), { status: "investigated" });
  assert.deepEqual(gate.parseBusinessContextInvariant("business-context: coord/.runtime/context-packs/X.json"), { ref: "coord/.runtime/context-packs/X.json" });
  assert.equal(gate.parseBusinessContextInvariant("unrelated invariant"), null);
  assert.equal(gate.parseBusinessContextInvariant(null), null);
  const businessContext = gate.createBusinessContextGate({ COORD_DIR: ENGINE_COORD_DIR, fs, path });
  assert.equal(businessContext.resolveBusinessContextRef(".runtime/context-packs/X.json"),
    path.join(ENGINE_COORD_DIR, ".runtime/context-packs/X.json"));
});

test("COORD-1000: decision-context reuses lifecycle-utils isPlainObject and the ADR ref constant", () => {
  const source = fs.readFileSync(path.join(__dirname, "decision-context.js"), "utf8");
  assert.doesNotMatch(source, /function isPlainObject/, "isPlainObject must come from lifecycle-utils.js, not a copy");
  assert.match(source, /lifecycle-utils\.js/);
  const { normalizeAdrRef } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/adr-reference.js"));
  for (const ref of ["ADR-0021", "0021", "nope", "ADR-21"]) {
    const accepted = decisionContext.expandDecisionContext({ schema_version: 1, adr_refs: [ref] }).ok;
    assert.equal(accepted, Boolean(normalizeAdrRef(ref)), `packet and ADR gate must agree on ${ref}`);
  }
});

// COORD-964: the decision-context packet expands plan fields only; it carries no
// ADR file, path or digest key. COORD-1025 retired guard adr-path-packet without
// adding one: ADR metadata-only edits are admitted by the docs/decisions
// classifier (landing-decision-classifier.js), and body edits still need the
// approved packet. This tripwire fails if an ADR file, path or digest key is ever
// added to the packet, so that change gets its own review.
test("COORD-964: the decision-context packet has no ADR file, path or digest key, so the adr-path-packet retirement criterion stays unmet", () => {
  for (const key of ["adr_path", "adr_paths", "adr_sha256", "adr_file", "docs_decisions", "adr_metadata"]) {
    const result = decisionContext.expandDecisionContext({ ...VALID, [key]: "docs/decisions/0021-x.md" });
    assert.equal(result.ok, false, `${key} accepted as a decision-context key`);
    assert.match(result.problems.join("\n"), new RegExp(`unknown key "${key}"`));
  }
});

test("malformed decision packets report all field-shape errors without partial options", () => {
  for (const input of [null, [], "packet"]) {
    assert.deepEqual(decisionContext.expandDecisionContext(input), {
      ok: false, problems: ["decision-context packet must be a JSON object."],
    });
  }
  const result = decisionContext.expandDecisionContext({
    schema_version: 1, adr_refs: [], decision_required: false, business_context: [], context_pack_ack: "yes",
  });
  assert.deepEqual(result, { ok: false, problems: [
    "adr_refs must be a non-empty array of ADR references.",
    "decision_required must be an object.",
    "business_context must be an object.",
    "context_pack_ack must be an object.",
  ] });
});

test("business context references reject invalid types, blank values and embedded separators", () => {
  for (const ref of [42, "  ", "docs/a b", "a,b", "a;b"]) {
    assert.deepEqual(decisionContext.expandDecisionContext({
      ...VALID, business_context: { status: "not-required", ref },
    }), { ok: false, problems: ["business_context.ref must be a non-empty string without spaces, commas or semicolons."] });
  }
});
