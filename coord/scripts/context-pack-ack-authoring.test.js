"use strict";
const { resolveEngineModule } = require("../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..");

const { state: governanceState } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));

// COORD-557: context_pack_ack authoring ergonomics, driven through the public
// CLI against a disposable workspace.
//   (1) the writer runs the review gate's own checks and refuses at write time;
//   (2) an explicit, journaled not-applicable path;
//   (3) a dedicated verb that machine-fills refs and DISPLAYS pack items but
//       takes the text of every considered section from the operator.
// The in-process dispatcher test at the end runs the real writer, so this
// worker's runtime, lock and seal surfaces are relocated to os.tmpdir() first.
require("./governance-test-utils.js").sandboxProcessRuntime();

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { VALID_ACK, fixture } = require("./fixtures/context-pack-ack-workspace.js");
const { withScopedGovernanceTestContext } = require("./governance-test-utils.js");

const SECTIONS = ["active_constraints", "adrs", "business_rules", "conflicts", "stale_warnings", "open_questions"];
const pack = (sections) => ({
  kind: "fixture.context_pack",
  sections: Object.fromEntries(Object.entries(sections).map(([name, ids]) => [name, { items: ids.map((id) => ({ id })) }])),
});

test("COORD-557 the writer refuses what the gate would refuse, and set-context-pack-ack authors without auto-populating", { timeout: 300000 }, () => {
  const f = fixture();
  try {
    const { cli, ok } = f.ownerSession;
    const id = "LANE-001";
    const packRef = `coord/.runtime/context-packs/${id}.json`;
    f.lane(id, "X");
    // Citing a pack is what makes the acknowledgement mandatory for this ticket.
    f.write(`.runtime/context-packs/${id}.json`, pack({ active_constraints: ["AC-7"], conflicts: ["CONFLICT-1"], stale_sources: [], open_questions: ["Q-1"] }));
    ok("update-plan", id, "--invariant", `business-context: ${packRef}`);
    const journal = () => fs.readFileSync(path.join(f.coord, ".runtime/governance-events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const gateCodes = () => JSON.stringify(JSON.parse(ok("guided-closeout", id, "--json").stdout)).match(/context_pack_[a-z_]+/g) || [];
    assert.deepEqual(gateCodes(), [], "the fixture starts with an acknowledgement the gate accepts");

    // (1) Write-time refusal, atomically, with the gate's own finding.
    const before = f.snapshot(id);
    const refusedWrite = (label, ack, pattern) => {
      const result = cli("update-plan", id, "--context-pack-ack", JSON.stringify(ack));
      assert.equal(result.status, 1, `${label} must be refused at write time\n${result.stdout}`);
      assert.match(result.stderr, pattern, label);
      assert.match(result.stderr, /nothing was written/);
      assert.deepEqual(f.snapshot(id), before, `${label} must leave plan, projection, board and journal untouched`);
    };
    refusedWrite("a mandatory section marked none while the pack has conflicts", { ...VALID_ACK, considered: { ...VALID_ACK.considered, conflicts: ["none"] } }, /marks mandatory section\(s\) conflicts as none/);
    refusedWrite("an unreadable pack ref", { ...VALID_ACK, refs: ["coord/.runtime/context-packs/ABSENT.json"] }, /references coord\/\.runtime\/context-packs\/ABSENT\.json, but it could not be read/);
    refusedWrite("an acknowledgement with unanswered sections", { considered: { adrs: ["No architecture change"] } }, /must explicitly say which active_constraints/);
    refusedWrite("an acknowledgement without a closeout learning disposition", { ...VALID_ACK, closeout_learning: {} }, /promoted, demoted, or left scratch-only/);
    refusedWrite("advisory memory cited as authority", { ...VALID_ACK, authority: { constraints: ["CONFLICT-1"], advisory_only: [] } }, /as implementation authority/);
    ok("update-plan", id, "--context-pack-ack", JSON.stringify(VALID_ACK));

    // (3) Display mode: refs machine-filled, pack items shown, nothing written.
    const beforeDisplay = f.snapshot(id);
    const shown = JSON.parse(ok("set-context-pack-ack", id).stdout);
    assert.equal(shown.written, false);
    assert.deepEqual(shown.refs, [packRef]);
    assert.deepEqual(shown.packs[0].sections, [
      { section: "active_constraints", acknowledged_by: null, item_ids: ["AC-7"] },
      { section: "conflicts", acknowledged_by: "considered.conflicts", item_ids: ["CONFLICT-1"] },
      { section: "open_questions", acknowledged_by: "considered.open_questions", item_ids: ["Q-1"] },
    ], "only non-empty pack sections are displayed, each with its item ids");
    assert.deepEqual(shown.operator_text_required_for, SECTIONS.map((section) => `considered.${section}`));
    assert.deepEqual(f.snapshot(id), beforeDisplay, "display mode is read-only");

    // Authoring: every section needs operator text; nothing is taken from the pack.
    const text = Object.fromEntries(SECTIONS.map((section) => [section, `operator wrote ${section}`]));
    const considered = (sections) => sections.flatMap((section) => ["--considered", `${section}=${text[section]}`]);
    const partial = cli("set-context-pack-ack", id, ...considered(SECTIONS.slice(0, 3)), "--learning", "scratch-only");
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /missing: conflicts, stale_warnings, open_questions\. Nothing is filled from the pack/);
    assert.match(cli("set-context-pack-ack", id, ...considered(SECTIONS)).stderr, /requires --learning/);
    assert.match(cli("set-context-pack-ack", id, "--considered", "confilcts=typo", "--learning", "none").stderr, /section one of/);
    assert.match(cli("set-context-pack-ack", id, "--from-pack").stderr, /from-pack/, "there is no auto-populate mode");
    assert.deepEqual(f.snapshot(id), beforeDisplay, "refused authoring writes nothing");
    const authored = JSON.parse(ok("set-context-pack-ack", id, ...considered(SECTIONS), "--authority", "Fixture contract", "--advisory-only", "CONFLICT-1", "--learning", "scratch-only", "--rationale", "Temporary fixture").stdout);
    assert.equal(authored.written, true);
    const stored = f.read(`.runtime/plans/${id}.json`).context_pack_ack;
    assert.deepEqual(stored, {
      refs: [packRef],
      considered: Object.fromEntries(SECTIONS.map((section) => [section, [text[section]]])),
      authority: { constraints: ["Fixture contract"], advisory_only: ["CONFLICT-1"] },
      closeout_learning: { decision: "scratch-only", rationale: "Temporary fixture" },
    });
    assert.equal(JSON.stringify(stored.considered).includes("Q-1"), false, "pack item ids never reach considered.* unless the operator typed them");
    assert.deepEqual(gateCodes(), []);

    // (2) not-applicable: reason required, and not available over a pack that
    // still has conflicts or open questions to answer.
    const beforeNa = f.snapshot(id);
    assert.match(cli("set-context-pack-ack", id, "--not-applicable").stderr, /requires --reason/);
    assert.match(cli("set-context-pack-ack", id, "--not-applicable", "--reason", "r", "--learning", "none").stderr, /cannot be combined/);
    const overPack = cli("set-context-pack-ack", id, "--not-applicable", "--reason", "no context applies");
    assert.equal(overPack.status, 1);
    assert.match(overPack.stderr, /marks mandatory section\(s\) conflicts, open_questions as none/);
    assert.deepEqual(f.snapshot(id), beforeNa, "a refused not-applicable disposition writes nothing");

    f.write(`.runtime/context-packs/${id}.json`, pack({ conflicts: [], stale_sources: [], open_questions: [] }));
    const eventsBefore = journal().length;
    const applied = JSON.parse(ok("set-context-pack-ack", id, "--not-applicable", "--reason", "docs-only lane, no business context is touched").stdout);
    assert.equal(applied.written, true);
    assert.equal(applied.disposition, "not-applicable");
    const events = journal();
    assert.equal(events.length, eventsBefore + 1, "exactly one journaled event");
    assert.equal(events.at(-1).ticket, id);
    assert.deepEqual(events.at(-1).details.context_pack_ack, { disposition: "not-applicable", reason: "docs-only lane, no business context is touched" });
    const na = f.read(`.runtime/plans/${id}.json`).context_pack_ack;
    assert.equal(na.closeout_learning.rationale, "not-applicable: docs-only lane, no business context is touched");
    assert.deepEqual(na.refs, [packRef]);
    assert.deepEqual(gateCodes(), [], "the gate accepts the not-applicable acknowledgement");

    // Clearing stays available and is not subject to the write-time gate.
    ok("update-plan", id, "--context-pack-ack", "none");
    assert.equal(f.read(`.runtime/plans/${id}.json`).context_pack_ack, undefined);
  } catch (error) {
    console.error("RETAINED SANDBOX", f.root);
    throw error;
  }
  fs.rmSync(f.root, { recursive: true, force: true });
});

// In-process contract of the same surface, so each refusal branch is exercised
// without a child process. The CLI test above proves the wiring.
function captured(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { result: fn(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}
const fail = (message) => { throw new Error(message); };

test("COORD-557 write-time check consults the gate only for a real acknowledgement write", () => {
  const { assertContextPackAckWriteReady } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/context-pack-ack-contract.js"));
  const calls = [];
  const deps = (issues, row = { ID: "T-1" }) => ({
    fail,
    readBoard: () => ({}),
    getTicketRef: () => (row ? { row } : null),
    collectReviewPlanReadinessIssues: (ticketId, seenRow) => { calls.push([ticketId, seenRow]); return issues; },
  });
  const gateIssue = { code: "context_pack_ack_ref", message: "pack unreadable", next_steps: ["regenerate the pack"] };
  for (const options of [{}, { contextPackAck: "none" }, { contextPackAck: " NONE " }, { contextPackAck: "" }]) {
    assert.doesNotThrow(() => assertContextPackAckWriteReady("T-1", options, deps([gateIssue])));
  }
  assert.deepEqual(calls, [], "clearing or not touching the ack never runs the gate");
  assert.doesNotThrow(() => assertContextPackAckWriteReady("T-1", { contextPackAck: "{}" }, deps([gateIssue], null)), "an unknown ticket is left to the writer's own refusal");
  // Unrelated review blockers must not stop an acknowledgement write.
  assert.doesNotThrow(() => assertContextPackAckWriteReady("T-1", { contextPackAck: { refs: [] } }, deps([{ code: "review_round", message: "x" }, { message: "no code" }])));
  assert.deepEqual(calls.at(-1), ["T-1", { ID: "T-1" }]);
  assert.throws(
    () => assertContextPackAckWriteReady("T-1", { contextPackAck: "{}" }, deps([{ code: "review_round", message: "x" }, gateIssue, { code: "context_pack_ack_sections", message: "sections missing" }])),
    (error) => {
      assert.match(error.message, /^Refusing to record context_pack_ack for T-1: .*nothing was written\.\n1\. pack unreadable\n {3}Next: regenerate the pack\n2\. sections missing$/);
      return true;
    }
  );
});

test("COORD-557 set-context-pack-ack builds the acknowledgement only from operator input", () => {
  const { setContextPackAckCommand } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/context-pack-ack-commands.js"));
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord557-unit-"));
  try {
    fs.writeFileSync(path.join(root, "T-1.json"), JSON.stringify({ ticket_id: "T-1", critical_invariants: ["no pack cited"] }));
    const writes = [];
    const run = (options) => captured(() => setContextPackAckCommand("T-1", { recordsDirs: [root], ...options }, {
      fail,
      updatePlanBlock: (ticketId, update, render) => { writes.push([ticketId, update]); render({}); },
    }));
    assert.throws(() => setContextPackAckCommand(undefined, {}, { fail }), /requires <ticket-id>/);
    assert.throws(() => setContextPackAckCommand("T-404", { recordsDirs: [root, null] }, { fail }), /No plan record found for T-404/);

    const shown = run({});
    assert.equal(shown.result.written, false);
    assert.deepEqual(shown.result.refs, []);
    assert.deepEqual(shown.result.packs, []);
    assert.equal(shown.result.stored, null);
    assert.match(shown.result.author, /--considered active_constraints="<your text>".*--learning <promote\|demote\|scratch-only\|mixed\|none>/);
    assert.deepEqual(JSON.parse(shown.output), shown.result);
    assert.deepEqual(writes, [], "display mode never reaches the writer");

    const sections = ["active_constraints", "adrs", "business_rules", "conflicts", "stale_warnings", "open_questions"];
    const considered = sections.map((section) => `${section}= text for ${section} `);
    assert.throws(() => run({ considered: "adrs" }), /expects <section>=<text>/);
    assert.throws(() => run({ considered: "adrs=  " }), /--considered adrs= requires operator text/);
    assert.throws(() => run({ considered: considered.slice(1), learning: "none" }), /missing: active_constraints\./);
    assert.throws(() => run({ considered, learning: "archive" }), /requires --learning/);
    assert.throws(() => run({ notApplicable: true }), /requires --reason/);
    assert.throws(() => run({ notApplicable: true, reason: "r", authority: "x" }), /cannot be combined/);
    assert.deepEqual(writes, []);

    // A repeated section keeps every operator entry, in order.
    const authored = run({ considered: [...considered, "adrs=second entry"], authority: "contract", learning: "mixed", humanAdminOverride: "authorized" });
    assert.equal(authored.result.written, true);
    assert.deepEqual(writes.pop(), ["T-1", {
      contextPackAck: {
        considered: Object.fromEntries(sections.map((section) => [section, section === "adrs" ? ["text for adrs", "second entry"] : [`text for ${section}`]])),
        authority: { constraints: ["contract"], advisory_only: [] },
        closeout_learning: { decision: "mixed" },
      },
      humanAdminOverride: "authorized",
    }]);

    const na = run({ notApplicable: true, reason: " no context applies " });
    assert.equal(na.result.disposition, "not-applicable");
    assert.deepEqual(writes.pop(), ["T-1", {
      contextPackAck: {
        considered: Object.fromEntries(sections.map((section) => [section, ["n/a"]])),
        authority: { constraints: [], advisory_only: [] },
        closeout_learning: { decision: "none", rationale: "not-applicable: no context applies" },
      },
      contextPackAckDisposition: { disposition: "not-applicable", reason: "no context applies" },
    }]);
    assert.equal(require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/context-pack-ack-contract.js")).contextPackAckViolation(na.result.context_pack_ack), null, "the generated object satisfies the canonical schema");

    // Blank repeated entries are dropped rather than recorded, and a rationale
    // is stored trimmed.
    const trimmed = run({ considered, authority: ["contract", ""], advisoryOnly: ["", " advisory item "], learning: "promote", rationale: "  durable rule  " });
    const trimmedAck = writes.pop()[1].contextPackAck;
    assert.deepEqual(trimmedAck.authority, { constraints: ["contract"], advisory_only: ["advisory item"] });
    assert.deepEqual(trimmedAck.closeout_learning, { decision: "promote", rationale: "durable rule" });
    assert.deepEqual(trimmed.result.context_pack_ack, trimmedAck);

    // A ticket that cites packs: refs are machine-filled from the plan evidence
    // (never from the acknowledgement being replaced), every readable pack is
    // displayed by section and item id, and an unreadable one is reported.
    const packPath = path.join(root, "pack.json"), emptyPath = path.join(root, "empty-pack.json"), nullPath = path.join(root, "null-pack.json"), absentPath = path.join(root, "absent-pack.json");
    fs.writeFileSync(packPath, JSON.stringify({ sections: {
      conflicts: { items: [{ id: "CONFLICT-1" }, { record_id: "REC-2" }, { source_record_id: "SRC-3" }, { title: "unidentified" }, null] },
      history: { items: [{ id: "HIST-1" }] },
      stale_sources: { items: [] },
      open_questions: { note: "no items key" },
      adr_history: null,
    } }));
    fs.writeFileSync(emptyPath, "{}");
    fs.writeFileSync(nullPath, "null");
    const refs = [packPath, emptyPath, nullPath, absentPath];
    const storedAck = { ...VALID_ACK, refs: ["coord/.runtime/context-packs/SUPERSEDED.json"] };
    fs.writeFileSync(path.join(root, "T-2.json"), JSON.stringify({ ticket_id: "T-2", critical_invariants: refs.map((ref) => `business-context: ${ref}`), context_pack_ack: storedAck }));
    const cited = (options) => captured(() => setContextPackAckCommand("T-2", { recordsDirs: [root], ...options }, {
      fail,
      updatePlanBlock: (ticketId, update, render) => { writes.push([ticketId, update]); render({}); },
    }));
    const display = cited({}).result;
    assert.deepEqual(display.refs, refs, "the stored acknowledgement's own refs are not a source of refs");
    assert.deepEqual(display.stored, storedAck, "the stored acknowledgement is displayed as stored");
    assert.deepEqual(display.packs.slice(0, 3), [
      { ref: packPath, readable: true, sections: [
        { section: "conflicts", acknowledged_by: "considered.conflicts", item_ids: ["CONFLICT-1", "REC-2", "SRC-3", "<no id>", "<no id>"] },
        { section: "history", acknowledged_by: null, item_ids: ["HIST-1"] },
      ] },
      { ref: emptyPath, readable: true, sections: [] },
      { ref: nullPath, readable: true, sections: [] },
    ]);
    assert.equal(display.packs[3].ref, absentPath);
    assert.equal(display.packs[3].readable, false);
    assert.match(display.packs[3].error, /ENOENT/);
    assert.deepEqual(display.packs[3].sections, []);
    assert.deepEqual(writes, [], "displaying cited packs never reaches the writer");

    cited({ considered, learning: "none" });
    const citedAck = writes.pop()[1].contextPackAck;
    assert.deepEqual(citedAck.refs, refs);
    assert.equal(JSON.stringify(citedAck.considered).includes("CONFLICT-1"), false, "pack item ids are displayed, never copied into considered.*");
    cited({ notApplicable: true, reason: "r" });
    assert.deepEqual(writes.pop()[1].contextPackAck.refs, refs, "a not-applicable acknowledgement still names the packs it dismisses");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-557 the missing-acknowledgement finding offers set-context-pack-ack as commands the live parser accepts", () => {
  const { createContextPackAcknowledgementGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/context-pack-ack.js"));
  const surface = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli-surface.js"));
  // COORD-989: the parser-dependent exports need the live cli.js parser bound first.
  surface.bindParser(() => require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli.js")).__testing.parseFlags);
  const { collectContextPackAcknowledgementIssues } = createContextPackAcknowledgementGate({
    isMeaningfulText: (value) => typeof value === "string" && value.trim() !== "",
    readBusinessContextEvidence: () => ({ refs: [], hasContextRef: true }),
    readBusinessContextPack: () => ({ ok: false, error: "unused" }),
    ticketRequiresAdrDecision: () => false,
    ticketTouchesBusinessContextRisk: () => false,
    toArray: (value) => (Array.isArray(value) ? value : []),
  });
  const [issue] = collectContextPackAcknowledgementIssues("T-1", {}, {});
  assert.equal(issue.code, "context_pack_ack");
  const steps = issue.next_steps.filter((step) => step.includes("set-context-pack-ack"));
  assert.deepEqual(steps, [
    "Or author it per section: coord/scripts/gov set-context-pack-ack T-1   # read-only: shows what each section must answer and the authoring command",
    'coord/scripts/gov set-context-pack-ack T-1 --not-applicable --reason "<why no context applies>"   # only when no context applies',
  ]);
  const parsed = steps.map((step) => surface.parseGovRemediation(surface.classifyRemediation(step).command));
  assert.deepEqual(parsed.map((entry) => [entry.verb, entry.ok]), [["set-context-pack-ack", true], ["set-context-pack-ack", true]]);
  assert.deepEqual(parsed[0].argv, [], "the display form carries no flags");
  assert.equal(parsed[1].options.notApplicable, true);
  assert.equal(parsed[1].options.reason, "<why no context applies>");
});

// The public dispatcher in this process, against this worker's own sandboxed
// plan-record directory: flag parsing, default directory resolution, the default
// refusal type, and the real journaled writer.
test("COORD-557 set-context-pack-ack dispatches through the workspace's own record and the real plan writer", () => {
  const os = require("node:os");
  const { __testing } = require("./governance-test-utils.js");
  const { GovernanceError } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
  const { dispatchCommand } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli.js")).__testing;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord557-dispatch-"));
  const runtimeDir = path.join(root, ".runtime");
  const sandbox = {
    BOARD_PATH: path.join(root, "tasks.json"),
    PLAN_PATH: path.join(root, "PLAN.md"),
    PLAN_RECORDS_DIR: path.join(root, "plans"),
    LEGACY_PLAN_RECORDS_DIR: path.join(root, "legacy-plans"),
    AGENT_SESSIONS_PATH: path.join(runtimeDir, "agent_sessions.json"),
    QUESTIONS_PATH: path.join(root, "QUESTIONS.md"),
    RUNTIME_DIR: runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: path.join(runtimeDir, "governance-events.ndjson"),
    GOVERNANCE_SNAPSHOT_PATH: path.join(runtimeDir, "governance-snapshot.json"),
    GOVERNANCE_SNAPSHOTS_DIR: path.join(runtimeDir, "snapshots"),
    GOVERNANCE_EVENT_LOCK_DIR: path.join(runtimeDir, "governance.lock"),
  };
  fs.mkdirSync(sandbox.PLAN_RECORDS_DIR);
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(sandbox.BOARD_PATH, JSON.stringify({ sections: [] }, null, 2));
  fs.writeFileSync(sandbox.PLAN_PATH, "");
  fs.writeFileSync(sandbox.AGENT_SESSIONS_PATH, "[]\n");
  fs.writeFileSync(sandbox.QUESTIONS_PATH, "## Instructions\n");
  return withScopedGovernanceTestContext(sandbox, () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  const dispatch = (...argv) => { lines.length = 0; dispatchCommand("set-context-pack-ack", argv); return JSON.parse(lines.join("\n")); };
  try {
    __testing.ensureGovernanceJournalBaseline("coord557-dispatch-seed");
    __testing.ensurePlanStub("ACK-1", "X", "codexa02");
    __testing.advanceGovernanceProvenanceBaseline("coord557-dispatch-plan-stub");
    const recordPath = path.join(sandbox.PLAN_RECORDS_DIR, "ACK-1.json");
    const storedAck = () => JSON.parse(fs.readFileSync(recordPath, "utf8")).context_pack_ack;
    const journal = () => fs.readFileSync(sandbox.GOVERNANCE_EVENT_LOG_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const tracked = [recordPath, sandbox.PLAN_PATH, sandbox.BOARD_PATH, sandbox.GOVERNANCE_EVENT_LOG_PATH];
    const bytes = () => tracked.map((file) => fs.readFileSync(file, "utf8"));
    const before = bytes();

    const refuses = (argv, pattern) => assert.throws(() => dispatch(...argv), (error) => {
      assert.ok(error instanceof GovernanceError, String(error && error.stack));
      assert.match(error.message, pattern);
      return true;
    });
    const considered = SECTIONS.flatMap((section) => ["--considered", `${section}=operator wrote ${section}`]);
    refuses([], /requires <ticket-id>/);
    refuses(["ACK-404"], /No plan record found for ACK-404\. Seed one first: coord\/scripts\/gov plan ACK-404 --seed/);
    refuses(["ACK-1", ...considered.slice(2), "--learning", "none"], /missing: active_constraints\. Nothing is filled from the pack/);
    refuses(["ACK-1", ...considered, "--learning", "archive"], /requires --learning <promote\|demote\|scratch-only\|mixed\|none>/);
    refuses(["ACK-1", "--not-applicable"], /requires --reason/);
    refuses(["ACK-1", "--not-applicable", "--reason", "r", "--advisory-only", "x"], /cannot be combined/);

    const shown = dispatch("ACK-1");
    assert.equal(shown.written, false);
    assert.equal(shown.ticket, "ACK-1");
    assert.equal(shown.stored, null);
    assert.equal(shown.not_applicable, 'coord/scripts/gov set-context-pack-ack ACK-1 --not-applicable --reason "<why no context applies>"');
    assert.deepEqual(bytes(), before, "display and every refusal leave record, projection, board and journal byte-identical");

    const authored = dispatch("ACK-1", ...considered, "--considered", "adrs=second entry", "--authority", "Fixture contract", "--authority", "Second authority", "--advisory-only", "ADVISORY-1", "--learning", "mixed", "--rationale", "Temporary fixture");
    assert.equal(authored.written, true);
    assert.equal(authored.disposition, undefined, "ordinary authoring carries no disposition");
    const expected = {
      considered: Object.fromEntries(SECTIONS.map((section) => [section, section === "adrs" ? ["operator wrote adrs", "second entry"] : [`operator wrote ${section}`]])),
      authority: { constraints: ["Fixture contract", "Second authority"], advisory_only: ["ADVISORY-1"] },
      closeout_learning: { decision: "mixed", rationale: "Temporary fixture" },
    };
    assert.deepEqual(storedAck(), expected);
    assert.deepEqual(authored.context_pack_ack, expected);
    const afterAuthoring = journal();
    assert.equal(afterAuthoring.at(-1).command, "update-plan");
    assert.equal(afterAuthoring.at(-1).ticket, "ACK-1");
    assert.equal(afterAuthoring.at(-1).details?.context_pack_ack, undefined, "only an explicit disposition is recorded in event details");
    assert.deepEqual(dispatch("ACK-1").stored, expected, "display mode then shows the stored acknowledgement");

    const applied = dispatch("ACK-1", "--not-applicable", "--reason", "docs-only lane");
    assert.equal(applied.written, true);
    assert.equal(applied.disposition, "not-applicable");
    assert.equal(applied.reason, "docs-only lane");
    const events = journal();
    assert.equal(events.length, afterAuthoring.length + 1, "exactly one journaled event");
    assert.deepEqual(events.at(-1).details.context_pack_ack, { disposition: "not-applicable", reason: "docs-only lane" });
    assert.deepEqual(storedAck(), {
      considered: Object.fromEntries(SECTIONS.map((section) => [section, ["n/a"]])),
      authority: { constraints: [], advisory_only: [] },
      closeout_learning: { decision: "none", rationale: "not-applicable: docs-only lane" },
    });
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  });
});
