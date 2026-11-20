"use strict";

// COORD-835: a lost journal (events log + latest snapshot deleted) over EXISTING
// coordination state must not let any verb, drift-tolerant or not, anchor the
// on-disk state as a new genesis baseline. Only the packet-bound human-admin
// reconcile may; a genuinely fresh workspace still initializes.

const { invokeFixtureReconcile } = require("./__fixtures__/approval-fixture.js");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const { __testing, executeCommand, withGovernedSurfaceSandbox } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
const { createIsolatedGovernanceWorkspace } = require("./fixtures/isolated-governance-workspace.js");
const {
  governedCoordinationStateExists,
  coordinationStatePathsFor,
  FRESH_DECISIONS_README_BYTES,
  isPacketBoundBaselineAdoption,
  formatJournalLostOverExistingStateMessage,
  formatUninitializedJournalMessage,
  JOURNAL_LOST_RECONCILE_COMMAND,
} = require("./journal-loss-guard.js");

for (const key of ["CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "COORD_SESSION_ID", "GEMINI_THREAD_ID"]) {
  delete process.env[key];
}

const env = { COORD_PROVIDER: "codex", COORD_INSTANCE_ID: "c835", CODEX_THREAD_ID: "thread-c835" };
const RECONCILE_NAMED = /gov reconcile --reason "<why>" --human-admin-override "<approval for these exact changes>" --expect-paths-file/;

function readEvents(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Seed an ADR through the governed verb (empty board), tamper it, then lose the
// journal: the launder3 reproduction from the COORD-722 review.
// isolateBoard keeps board validation (which gov doctor runs) on the sandbox board,
// so a doing row in the real repository board cannot leak into the result.
function withTamperedAdrAndLostJournal(run, { boardRow = false, isolateBoard = boardRow } = {}) {
  return withGovernedSurfaceSandbox(({ tempDir, logPath, boardPath }) => {
    const decisions = state.DECISIONS_DIR;
    fs.writeFileSync(path.join(decisions, "README.md"), "# Decision Records (ADRs)\n", "utf8");
    const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
    if (boardRow) {
      fs.writeFileSync(boardPath, `${JSON.stringify({
        version: 1,
        metadata: { title: "COORD-835 fixture", last_updated: "2026-10-14", canonical_references: [] },
        sections: [{
          kind: "table", level: 3, heading: "Backlog", separator_before: false,
          columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [],
        }],
        prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
      }, null, 2)}\n`, "utf8");
    }
    assert.equal(invoke(["agentid", "--assign"]).ok, true);
    const created = invoke(["adr", "new", "--title", "Existing decision", "--ticket", "COORD-722", "--json"]);
    assert.equal(created.ok, true, created.error);
    if (boardRow) {
      const filed = invoke(["file-ticket", "COORD-9835", "--repo", "X", "--type", "bug", "--pri", "P1",
        "--description", "Seed a live board row before the journal is lost"]);
      assert.equal(filed.ok, true, filed.error);
    }
    const adrPath = path.join(decisions, fs.readdirSync(decisions).find((name) => name.startsWith("0001")));
    fs.appendFileSync(adrPath, "\nTAMPERED\n");
    fs.rmSync(logPath, { force: true });
    fs.rmSync(state.GOVERNANCE_SNAPSHOT_PATH, { force: true });
    assert.equal(__testing.detectGovernanceProvenanceDrift().uninitialized, true);
    return run({ invoke, logPath, adrPath, boardPath, tamperedAdr: fs.readFileSync(adrPath, "utf8") });
  }, { isolateBoardValidation: isolateBoard });
}

function assertRefusedWithoutBaseline(result, { logPath, adrPath, tamperedAdr }, label) {
  assert.equal(result.ok, false, `${label} must refuse over a lost journal`);
  assert.match(result.error, /Refusing to auto-baseline the governance journal/, label);
  assert.match(result.error, RECONCILE_NAMED, `${label} must name the packet-bound reconcile`);
  assert.deepEqual(readEvents(logPath), [], `${label} must not write a genesis baseline`);
  assert.equal(__testing.detectGovernanceProvenanceDrift().uninitialized, true, label);
  assert.equal(fs.readFileSync(adrPath, "utf8"), tamperedAdr, label);
}

for (const verb of [["claim"], ["doctor", "--fix"], ["agentid", "--assign"], ["adr", "link", "COORD-998", "0001", "--json"]]) {
  test(`COORD-835: ${verb.join(" ")} refuses to adopt a tampered ADR after the journal is lost (empty board)`, () => {
    withTamperedAdrAndLostJournal((ctx) => {
      assertRefusedWithoutBaseline(ctx.invoke(verb), ctx, verb.join(" "));
      // The refusal is durable: the next ordinary verb refuses too.
      assertRefusedWithoutBaseline(ctx.invoke(["adr", "link", "COORD-999", "0001", "--json"]), ctx, "follow-up adr link");
    });
  });
}

test("COORD-835: drift-tolerant verbs refuse over lost-journal board rows as well", () => {
  withTamperedAdrAndLostJournal((ctx) => {
    for (const verb of [["claim", "COORD-9835"], ["doctor", "--fix"], ["recover", "COORD-9835"]]) {
      assertRefusedWithoutBaseline(ctx.invoke(verb), ctx, verb.join(" "));
    }
  }, { boardRow: true });
});

test("COORD-835: only the packet-bound human-admin reconcile re-establishes the baseline", () => {
  const fixture = createIsolatedGovernanceWorkspace({ prefix: "coord835-lost-journal-" });
  try {
    const state = fixture.governance.__testing;
    assert.equal(fixture.invoke(["agentid", "--assign"]).ok, true);
    const created = fixture.invoke(["adr", "new", "--title", "Existing decision", "--ticket", "COORD-722", "--json"]);
    assert.equal(created.ok, true, created.error);
    const decisions = path.join(fixture.coord, "docs", "decisions");
    const adrPath = path.join(decisions, "0001-existing-decision.md");
    fs.appendFileSync(adrPath, "\nTAMPERED\n");
    const logPath = path.join(fixture.coord, ".runtime", "governance-events.ndjson");
    fs.rmSync(logPath, { force: true });
    fs.rmSync(path.join(fixture.coord, ".runtime", "governance-latest-snapshot.json"), { force: true });
    const readFixtureEvents = () => readEvents(logPath);

    const reasonOnly = fixture.invoke(["reconcile", "--reason", "journal lost"]);
    assert.equal(reasonOnly.ok, false);
    assert.match(reasonOnly.error, /human-admin-override/);
    const approval = "Fixture administrator reviewed every listed path after the journal loss";
    const noPacket = fixture.invoke(["reconcile", "--reason", "journal lost", "--human-admin-override", approval]);
    assert.equal(noPacket.ok, false);
    assert.match(noPacket.error, /--expect-paths-file/);
    assert.deepEqual(readFixtureEvents(), []);

    const relative = (file) => path.relative(fixture.coord, file).split(path.sep).join("/");
    const expectedPaths = [path.join(fixture.coord, "board", "plan.schema.json"),
      path.join(fixture.coord, "board", "tasks.json"), path.join(fixture.coord, "board", "tasks.schema.json"),
      path.join(fixture.coord, "GOVERNANCE.md"), path.join(fixture.coord, "project.config.js"),
      path.join(fixture.coord, "PLAN.md"), path.join(fixture.coord, "QUESTIONS.md"),
      path.join(decisions, "README.md"), adrPath].map(relative).sort((a, b) => a.localeCompare(b));
    const expectedPacket = expectedPaths.map((entry) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(fixture.coord, entry))).digest("hex")} ${entry}`);
    const dryRun = fixture.invoke(["reconcile", "--reason", "journal lost", "--dry-run"]);
    assert.deepEqual(JSON.parse(dryRun.stdout).expect_paths_packet, expectedPacket,
      "the fixture declares the reviewed recovery paths independently of the dry run");
    const packetPath = path.join(fixture.root, "lost-journal.packet");
    fs.writeFileSync(packetPath, `${expectedPacket.join("\n")}\n`);
    const reconciled = invokeFixtureReconcile(fixture.coord, fixture.invoke, ["reconcile", "--reason", "journal lost", "--human-admin-override", approval, "--expect-paths-file", packetPath]);
    assert.equal(reconciled.ok, true, reconciled.error);
    const recovered = readFixtureEvents();
    assert.deepEqual(recovered.map((event) => event.event || event.command),
      ["approval.refused", "approval.verified", "journal-baseline", "manual-reconcile"]);
    assert.equal(recovered[3].details.approval_record, recovered[1].approval_record);
    assert.ok(recovered[2].snapshot_digest);
    assert.equal(state.detectGovernanceProvenanceDrift().uninitialized, false);
    const linked = fixture.invoke(["adr", "link", "COORD-999", "0001", "--json"]);
    assert.equal(linked.ok, true, linked.error);
  } finally {
    fixture.cleanup();
  }
});

test("COORD-835: a genuinely fresh workspace (empty board, decision index only) still initializes", () => {
  withGovernedSurfaceSandbox(({ tempDir, logPath }) => {
    fs.writeFileSync(path.join(state.DECISIONS_DIR, "README.md"), "# Decision Records (ADRs)\n", "utf8");
    const assigned = executeCommand(["agentid", "--assign"], { cwd: tempDir, env });
    assert.equal(assigned.ok, true, assigned.error);
    assert.equal(readEvents(logPath)[0].command, "journal-baseline");
  });
});

test("COORD-835: crash rollback on an uninitialized journal over existing state restores but journals nothing", () => {
  withTamperedAdrAndLostJournal((ctx) => {
    for (const metadata of [{ command: "adr", ticket: "COORD-722" }, null]) {
      const restorePoint = __testing.captureGovernanceRestorePoint();
      if (metadata) {
        __testing.persistGovernanceRestorePoint(restorePoint, metadata);
      } else {
        fs.mkdirSync(path.dirname(__testing.governanceRestorePointPath()), { recursive: true });
        fs.writeFileSync(__testing.governanceRestorePointPath(), JSON.stringify({ files: restorePoint }), "utf8");
      }
      // The interrupted verb had half-rewritten the ADR when it crashed.
      fs.writeFileSync(ctx.adrPath, "half written\n", "utf8");
      const outcome = __testing.recoverCrashedGovernanceMutation();
      assert.deepEqual(outcome, { action: "restored_unjournaled", interruptedCommand: metadata ? "adr" : null });
      assert.equal(fs.readFileSync(ctx.adrPath, "utf8"), ctx.tamperedAdr, "the restore point is reinstated");
      assert.equal(fs.existsSync(__testing.governanceRestorePointPath()), false);
      assert.deepEqual(readEvents(ctx.logPath), [], "no crash-rollback genesis over existing state");
    }
    // Through a real verb: the rollback runs, then the guard refuses and names reconcile.
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: "claim" });
    fs.writeFileSync(ctx.adrPath, "half written again\n", "utf8");
    assertRefusedWithoutBaseline(ctx.invoke(["claim"]), ctx, "claim after crash rollback");
  });
});

test("COORD-835: governedCoordinationStateExists treats decision records as state, the README index as fresh", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord835-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = {
    BOARD_PATH: path.join(root, "tasks.json"),
    PLAN_RECORDS_DIR: path.join(root, "plans"),
    PROMPTS_DIR: path.join(root, "prompts"),
    RENDERED_DIR: path.join(root, "rendered"),
    DECISIONS_DIR: path.join(root, "decisions"),
  };
  assert.equal(governedCoordinationStateExists({}), false, "unconfigured paths are fresh");
  assert.equal(governedCoordinationStateExists(paths), false, "absent board and directories are fresh");
  for (const board of ["null", JSON.stringify({ sections: [null, { rows: [] }, { heading: "no rows" }] })]) {
    fs.writeFileSync(paths.BOARD_PATH, board, "utf8");
    assert.equal(governedCoordinationStateExists(paths), false, board);
  }
  fs.writeFileSync(paths.BOARD_PATH, "{ torn", "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "an unparsable board is anomalous state");
  fs.writeFileSync(paths.BOARD_PATH, JSON.stringify({ sections: [{ rows: [{ ID: "X-1" }] }] }), "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "board rows are state");
  fs.writeFileSync(paths.BOARD_PATH, JSON.stringify({ sections: [] }), "utf8");

  fs.mkdirSync(path.join(paths.DECISIONS_DIR, "nested", "empty"), { recursive: true });
  const readme = path.join(paths.DECISIONS_DIR, "README.md");
  for (const fresh of FRESH_DECISIONS_README_BYTES) {
    fs.writeFileSync(readme, fresh, "utf8");
    assert.equal(governedCoordinationStateExists(paths), false, "the fresh top-level index and empty dirs are fresh");
  }
  // COORD-835 (review finding 2): a symlink is state whether it dangles or not.
  fs.symlinkSync(path.join(root, "outside.md"), path.join(paths.DECISIONS_DIR, "dangling.md"));
  assert.equal(governedCoordinationStateExists(paths), true, "a dangling symlink is state");
  fs.writeFileSync(path.join(root, "outside.md"), "# ADR\n", "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "a symlinked ADR is state");
  fs.rmSync(path.join(paths.DECISIONS_DIR, "dangling.md"));
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(paths.DECISIONS_DIR, "linked-dir"));
  fs.mkdirSync(path.join(root, "outside-dir"));
  assert.equal(governedCoordinationStateExists(paths), true, "a symlink to an empty directory is state, never descended");
  fs.rmSync(path.join(paths.DECISIONS_DIR, "linked-dir"));
  fs.rmSync(readme);
  fs.symlinkSync(path.join(root, "fresh-readme.md"), readme);
  fs.writeFileSync(path.join(root, "fresh-readme.md"), FRESH_DECISIONS_README_BYTES[0], "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "a symlinked README is state even with fresh bytes");
  fs.rmSync(readme);
  // COORD-835 (review finding 3): only the validator's fresh README bytes are exempt.
  for (const forged of ["# index\n", "# Decision Records\n\n| 0001 | forged decision accepted |\n",
    `${FRESH_DECISIONS_README_BYTES[1]}| [0001](./0001-forged.md) | Forged | Accepted |\n`,
    FRESH_DECISIONS_README_BYTES[0].trimEnd(), `${FRESH_DECISIONS_README_BYTES[0]}\nprose\n`]) {
    fs.writeFileSync(readme, forged, "utf8");
    assert.equal(governedCoordinationStateExists(paths), true, `README ${JSON.stringify(forged)} is state`);
  }
  fs.writeFileSync(readme, FRESH_DECISIONS_README_BYTES[0], "utf8");
  fs.writeFileSync(path.join(paths.DECISIONS_DIR, "nested", "README.md"), FRESH_DECISIONS_README_BYTES[0], "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "only the top-level index is ignored");
  fs.rmSync(path.join(paths.DECISIONS_DIR, "nested", "README.md"));
  fs.writeFileSync(path.join(paths.DECISIONS_DIR, "0001-decision.md"), "# ADR\n", "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "an ADR file is state");
  fs.rmSync(paths.DECISIONS_DIR, { recursive: true });
  fs.mkdirSync(paths.RENDERED_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "rendered\n", "utf8");
  assert.equal(governedCoordinationStateExists(paths), true, "a rendered view is state");
});

test("COORD-835: only the adopting reconcile mutation is exempt and the refusal names it", () => {
  assert.equal(isPacketBoundBaselineAdoption({ command: "manual-reconcile", allowProvenanceDrift: true, adoptProvenanceDrift: true }), true);
  assert.equal(isPacketBoundBaselineAdoption({ command: "manual-reconcile", allowProvenanceDrift: true }), false);
  assert.equal(isPacketBoundBaselineAdoption({ command: "claim-ticket", allowProvenanceDrift: true, adoptProvenanceDrift: true }), false);
  assert.equal(isPacketBoundBaselineAdoption({ command: "doctor-fix", allowProvenanceDrift: true }), false);
  const message = formatJournalLostOverExistingStateMessage();
  assert.ok(message.includes(JOURNAL_LOST_RECONCILE_COMMAND));
  assert.match(message, /decision records/);
  assert.doesNotMatch(message, /gov recover <ticket-id>/);
});

test("COORD-835: doctor and baseline-less mutations name the reconcile only when the lost journal sits over state", () => {
  withGovernedSurfaceSandbox(() => {
    const errors = [];
    __testing.appendGovernanceProvenanceIssues(errors, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Governance journal is uninitialized/, "a fresh workspace keeps the generic advice");
    assert.throws(() => __testing.withGovernanceMutation({ command: "no-baseline", ensureBaseline: false }, () => {}),
      /Governance journal is uninitialized/);
  });
  withTamperedAdrAndLostJournal((ctx) => {
    const errors = [];
    __testing.appendGovernanceProvenanceIssues(errors, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], RECONCILE_NAMED);
    assert.throws(() => __testing.withGovernanceMutation({ command: "no-baseline", ensureBaseline: false }, () => {}),
      RECONCILE_NAMED);
    const doctor = ctx.invoke(["doctor"]);
    assert.match(`${doctor.stdout || ""}\n${doctor.error || ""}`, RECONCILE_NAMED, "gov doctor names the reconcile");
    assert.deepEqual(readEvents(ctx.logPath), []);
  }, { isolateBoard: true });
  assert.equal(formatUninitializedJournalMessage({}, () => "fresh"), "fresh");
});

// COORD-835 coverage: the edited provenance report and the baseline helper it
// sits beside, on an INITIALIZED journal (no drift, then blocking drift) and on
// legacy events that carry an inline snapshot or none at all.
test("COORD-835: provenance issues and the baseline helper behave on initialized and legacy journals", () => {
  withGovernedSurfaceSandbox(({ boardPath, logPath }) => {
    assert.equal(__testing.ensureGovernanceJournalBaseline("COORD-835 initialized fixture"), true);
    const clean = [];
    __testing.appendGovernanceProvenanceIssues(clean, []);
    assert.deepEqual(clean, [], "an initialized journal with no drift reports nothing");
    fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [{ ID: "X-835" }] }] }), "utf8");
    const drifted = [];
    __testing.appendGovernanceProvenanceIssues(drifted, []);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0], /tasks\.json/);

    const snapshot = __testing.buildGovernanceSnapshot();
    fs.writeFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), command: "legacy-inline", snapshot })}\n`, "utf8");
    assert.equal(__testing.ensureGovernanceJournalBaseline("legacy inline snapshot"), false);
    fs.writeFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), command: "legacy-bare" })}\n`, "utf8");
    assert.equal(__testing.ensureGovernanceJournalBaseline("legacy bare event"), true);
  });
});

// COORD-835 review finding 2: a symlinked ADR is governed state, so a lost
// journal over it is refused instead of baselined by a drift-tolerant verb.
test("COORD-835: a symlinked ADR blocks the genesis over a lost journal", () => {
  withTamperedAdrAndLostJournal((ctx) => {
    const outside = path.join(path.dirname(state.DECISIONS_DIR), "outside-adr.md");
    fs.writeFileSync(outside, ctx.tamperedAdr, "utf8");
    fs.rmSync(ctx.adrPath);
    fs.symlinkSync(outside, ctx.adrPath);
    const result = ctx.invoke(["agentid", "--assign"]);
    assert.equal(result.ok, false, "a symlinked ADR is governed state");
    assert.match(result.error, RECONCILE_NAMED);
    assert.deepEqual(readEvents(ctx.logPath), []);
  });
});

// COORD-835 review finding 3: the exempt README bytes are exactly what the ADR
// validator writes for a registry with no records, not a hand-picked copy.
test("COORD-835: the fresh decisions README bytes match the validator's own empty-registry output", () => {
  withGovernedSurfaceSandbox(({ tempDir }) => {
    const decisions = state.DECISIONS_DIR;
    const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
    assert.equal(invoke(["agentid", "--assign"]).ok, true);
    assert.equal(fs.existsSync(path.join(decisions, "README.md")), false, "the validator starts from its default heading");
    const created = invoke(["adr", "new", "--title", "Only decision", "--ticket", "COORD-835", "--json"]);
    assert.equal(created.ok, true, created.error);
    const written = fs.readFileSync(path.join(decisions, "README.md"), "utf8");
    const withoutRows = written.split("\n").filter((line) => !/^\| \[[0-9]{4}\]/.test(line)).join("\n");
    assert.equal(withoutRows, FRESH_DECISIONS_README_BYTES[1], "empty-index form is the validator's index with no rows");
    assert.ok(written.startsWith(FRESH_DECISIONS_README_BYTES[0]), "heading-only form is the validator's default heading");
  });
});

test("COORD-835: a forged decisions README on an otherwise fresh workspace is not baselined", () => {
  withGovernedSurfaceSandbox(({ tempDir, logPath }) => {
    const readme = path.join(state.DECISIONS_DIR, "README.md");
    fs.writeFileSync(readme, "# Decision Records\n\n| 0001 | forged decision accepted |\n", "utf8");
    const forged = executeCommand(["agentid", "--assign"], { cwd: tempDir, env });
    assert.equal(forged.ok, false, "a forged README is not a fresh workspace");
    assert.match(forged.error, RECONCILE_NAMED);
    assert.deepEqual(readEvents(logPath), []);
  });
});

// COORD-835 review finding 1: the caller-supplied pre-existing-state refusal
// in the baseline helper, and the guard's injected-fs / paths.js seams that
// `coord init` reads its pre-write state through.
test("COORD-835: the baseline helper refuses a genesis its caller saw predate its writes, and the guard reads an injected fs", (t) => {
  withGovernedSurfaceSandbox(({ logPath }) => {
    assert.throws(() => __testing.ensureGovernanceJournalBaseline("coord-init-starter-board", { stateExisted: true }), RECONCILE_NAMED);
    assert.deepEqual(readEvents(logPath), [], "no genesis over pre-existing state");
    assert.equal(__testing.ensureGovernanceJournalBaseline("coord-init-starter-board", { stateExisted: false }), true);
    assert.equal(__testing.ensureGovernanceJournalBaseline("coord-init-starter-board", { stateExisted: true }), false,
      "an existing baseline makes the helper a no-op, not a refusal");
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord835-fs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordPaths = { coordDir: root, boardPath: path.join(root, "board/tasks.json"), planRecordsDir: path.join(root, ".runtime/plans"),
    renderedDir: path.join(root, "rendered"), decisionsDir: path.join(root, "docs/decisions") };
  const statePaths = coordinationStatePathsFor(coordPaths);
  assert.deepEqual(statePaths, { BOARD_PATH: coordPaths.boardPath, PLAN_RECORDS_DIR: coordPaths.planRecordsDir,
    PROMPTS_DIR: path.join(root, "prompts"), RENDERED_DIR: coordPaths.renderedDir, DECISIONS_DIR: coordPaths.decisionsDir });
  fs.mkdirSync(statePaths.PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(statePaths.PROMPTS_DIR, "X-1.md"), "prompt\n", "utf8");
  assert.equal(governedCoordinationStateExists(statePaths), true);
  assert.equal(governedCoordinationStateExists(statePaths, { existsSync: () => false }), false, "the injected fs is the one read");
});
