"use strict";

// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("../../scripts/governance-test-utils.js").sandboxProcessRuntimeLocks();
const test = require("node:test");
// ADR 0031 (COORD-1034): transfers need a fixture-signed record for their exact digest.
const { after } = require("node:test");
const { createApprovalFixture, retryTransferWithLogin } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");
const approvalVerifier = require("./approval-verifier.js");
const approvalFixture = createApprovalFixture({ allowedVerbs: ["claim --transfer-to", "correct-finding-severity", "correct-finding-round"] });
after(() => approvalFixture.cleanup());
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { executeCommand, setupCoord003Workspace } = require("../../scripts/governance-test-utils.js");
const { buildVerbHelpText } = require("./cli.js").__testing;
const boardModule = require("../../board/board.js");

// COORD-820: governed severity correction. Policy (QUESTIONS.md row 810 point
// 4, reconfirmed 2026-10-14): "the owner or a reviewer may raise a severity,
// lowering requires approval by a different identity, prior values stay in
// history." A recorded reviewer is a non-owner session the engine recorded as
// the added_by author of a finding on the ticket; anyone else needs the
// human-admin override to raise; lowering always needs it; history is
// append-only and attributed, anchored at original_severity; a refused
// correction writes nothing.

delete process.env.CODEX_THREAD_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.GEMINI_THREAD_ID;
delete process.env.GROK_THREAD_ID;

const OWNER = "claudea0000";
const REVIEWER = "claudea99";
const STRANGER = "claudea100";
const TICKET = "MSRV-820";

function envFor(thread) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/_(?:SESSION|THREAD|INSTANCE)_ID$/.test(key)) delete env[key];
  }
  return thread ? { ...env, CLAUDE_SESSION_ID: thread } : env;
}

function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out[path.relative(root, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

function workspace(body, { seedFindings = true, ticketStatus = "review" } = {}) {
  const ctx = setupCoord003Workspace("coord820-severity-", TICKET, OWNER, { ticketStatus, withCommit: true });
  const owner = (args) => executeCommand(args, { env: envFor("coord003-thread") });
  const reviewer = (args) => withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(),
    () => executeCommand(args, { env: envFor("coord820-reviewer-thread") }));
  const stranger = (args) => executeCommand(args, { env: envFor("coord820-stranger-thread") });
  const board = () => JSON.parse(fs.readFileSync(ctx.boardPath, "utf8"));
  const events = () => fs.readFileSync(path.join(ctx.coordRoot, ".runtime", "governance-events.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  try {
    const bound = reviewer(["agentid", "--owner", REVIEWER]);
    assert.equal(bound.ok, true, bound.error);
    const assigned = stranger(["agentid", "--assign"]);
    assert.equal(assigned.ok, true, assigned.error);
    assert.equal(JSON.parse(assigned.stdout).handle, STRANGER, "the third session is an unrelated registered identity");
    for (const severity of seedFindings ? ["LOW", "MED"] : []) {
      const added = owner(["add-finding", TICKET, "--severity", severity, "--summary", `understated ${severity}`, "--qref", "L1"]);
      assert.equal(added.ok, true, added.error);
    }
    body({ ctx, owner, reviewer, stranger, board, events });
  } finally {
    ctx.restore();
  }
}

function correct(run, id, severity, ...extra) {
  return run(["correct-finding-severity", TICKET, "--id", id, "--severity", severity, "--reason", "evidence", ...extra]);
}

function correctWithSignedApproval(run, id, severity, ...extra) {
  let result;
  withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), () => {
    result = correct(run, id, severity, ...extra);
    const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(result.error || ""));
    if (!digest) return;
    approvalFixture.login({ verb: "correct-finding-severity", ticket: TICKET, subject_sha256: digest[1] });
    result = correct(run, id, severity, ...extra);
  });
  return result;
}

function assertRefusedWithoutWrites(ctx, attempt, pattern) {
  const before = snapshotTree(ctx.coordRoot);
  const result = attempt();
  assert.equal(result.ok, false, "the correction must be refused");
  assert.match(result.error, pattern);
  assert.deepEqual(snapshotTree(ctx.coordRoot), before, "a refused correction must not change board, PLAN.md, plan record, journal or locks");
}

test("COORD-820: help advertises the verb, the canonical vocabulary and the approval policy", () => {
  const help = buildVerbHelpText("correct-finding-severity");
  for (const expected of ["--id <finding-id>", "--severity <HIGH|MED|LOW>", "--reason <text>", "--human-admin-override", "COORD-718", "severity_history", "original_severity", "The ticket owner or a recorded reviewer may raise", "added_by author of a finding on the ticket", "Any other raise needs the human-admin override"]) {
    assert.ok(help.includes(expected), `help must mention ${expected}; got: ${help}`);
  }
});

test("COORD-820: the owner or a recorded reviewer may raise; anyone else needs a second party; every change is journaled", () => {
  workspace(({ ctx, owner, reviewer, stranger, board, events }) => {
    const filed = reviewer(["add-finding", TICKET, "--severity", "LOW", "--summary", "reviewer finding", "--qref", "L2"]);
    assert.equal(filed.ok, true, filed.error);
    assert.deepEqual(board().review_findings[TICKET].map((entry) => [entry.added_by, entry.original_severity]), [[OWNER, "LOW"], [OWNER, "MED"], [REVIEWER, "LOW"]]);
    const raised = correct(owner, `${TICKET}-F1`, "MED");
    assert.equal(raised.ok, true, raised.error);
    assert.match(raised.stdout, /LOW -> MED \(raise\) by claudea0000\./);
    assertRefusedWithoutWrites(
      ctx,
      () => correct(stranger, `${TICKET}-F1`, "HIGH"),
      /Only the ticket owner \(claudea0000\) or a recorded reviewer of the ticket may raise MSRV-820-F1; claudea100 is neither .*Any other raise needs --human-admin-override/
    );
    // The recorded reviewer raises a finding it did not author, with no approval.
    const byReviewer = correct(reviewer, `${TICKET}-F1`, "HIGH");
    assert.equal(byReviewer.ok, true, byReviewer.error);
    const byStranger = correctWithSignedApproval(stranger, `${TICKET}-F3`, "MED", "--human-admin-override", "admin agrees");
    assert.equal(byStranger.ok, true, byStranger.error);
    assert.match(byStranger.stdout, /approved by human-admin: admin agrees/);

    const [f1, , f3] = board().review_findings[TICKET];
    assert.equal(f1.severity, "HIGH");
    assert.equal(f1.original_severity, "LOW", "the original value stays recorded");
    const pick = ({ from, to, direction, actor, approval }) => ({ from, to, direction, actor, approval });
    assert.deepEqual(f1.severity_history.map(pick), [
      { from: "LOW", to: "MED", direction: "raise", actor: OWNER, approval: null },
      { from: "MED", to: "HIGH", direction: "raise", actor: REVIEWER, approval: null },
    ]);
    assert.deepEqual(f3.severity_history.map(({ from, to, direction, actor, approval }) => ({ from, to, direction, actor,
      approval: approval && { kind: approval.kind, approver: approval.approver, reason: approval.reason } })), [
      { from: "LOW", to: "MED", direction: "raise", actor: STRANGER, approval: { kind: "human-admin-override", approver: "human-admin", reason: "admin agrees" } },
    ]);
    assert.ok(f3.severity_history[0].approval.record_id);
    assert.ok(f3.severity_history[0].approval.key_id);
    for (const entry of [...f1.severity_history, ...f3.severity_history]) {
      assert.ok(!Number.isNaN(Date.parse(entry.at)), "each entry records when it happened");
      assert.equal(entry.reason, "evidence");
    }
    const journaled = events().filter((event) => event.command === "correct-finding-severity" && event.result === "succeeded");
    assert.deepEqual(
      journaled.map((event) => [event.identity.owner, event.details.actor, event.details.ticket_owner, event.details.before_severity, event.details.after_severity, event.details.direction, event.details.raise_authority]),
      [[OWNER, OWNER, OWNER, "LOW", "MED", "raise", "owner"], [REVIEWER, REVIEWER, OWNER, "MED", "HIGH", "raise", "reviewer"], [STRANGER, STRANGER, OWNER, "LOW", "MED", "raise", null]]
    );
    const { kind, approver, reason } = journaled[2].details.approval;
    assert.deepEqual({ kind, approver, reason },
      { kind: "human-admin-override", approver: "human-admin", reason: "admin agrees" });
    assert.ok(journaled[2].details.approval_record);
    const addEvents = events().filter((event) => event.command === "add-finding" && event.result === "succeeded");
    assert.deepEqual(addEvents.map((event) => event.identity && event.identity.owner), [OWNER, OWNER, REVIEWER], "add-finding journals its author");
  });
});

test("COORD-844: a former owner who authored a recorded finding may still raise it", () => {
  workspace(({ owner, reviewer, board }) => {
    const filed = owner(["add-finding", TICKET, "--severity", "LOW", "--summary", "former owner authored", "--qref", "L8"]);
    assert.equal(filed.ok, true, filed.error);
    const transfer = retryTransferWithLogin(approvalFixture, TICKET, () => reviewer(["claim", TICKET, "--transfer-to", REVIEWER, "--human-admin-override", "fixture ownership transfer"]));
    assert.equal(transfer.ok, true, transfer.error);
    assert.equal(board().sections[0].rows.find((row) => row.ID === TICKET).Owner, REVIEWER);
    const raised = correct(owner, `${TICKET}-F1`, "MED");
    assert.equal(raised.ok, true, raised.error);
  }, { seedFindings: false, ticketStatus: "doing" });
});

test("COORD-844: former ownership alone and unknown legacy authorship do not grant raise authority", () => {
  workspace(({ ctx, owner, reviewer, board }) => {
    const added = reviewer(["add-finding", TICKET, "--severity", "LOW", "--summary", "reviewer authored", "--qref", "L9"]);
    assert.equal(added.ok, true, added.error);
    const transfer = retryTransferWithLogin(approvalFixture, TICKET, () => reviewer(["claim", TICKET, "--transfer-to", REVIEWER, "--human-admin-override", "fixture ownership transfer"]));
    assert.equal(transfer.ok, true, transfer.error);
    assert.equal(JSON.parse(fs.readFileSync(ctx.boardPath, "utf8")).sections[0].rows[0].Owner, REVIEWER);
    assertRefusedWithoutWrites(
      ctx,
      () => correct(owner, `${TICKET}-F1`, "MED"),
      /Only the ticket owner \(claudea99\) or a recorded reviewer of the ticket may raise .*claudea0000 is neither/
    );
  }, { seedFindings: false, ticketStatus: "doing" });

  workspace(({ ctx, owner, reviewer, board }) => {
    const anonymous = executeCommand(["add-finding", TICKET, "--severity", "LOW", "--summary", "legacy unknown author", "--qref", "L10"], { env: envFor(null) });
    assert.equal(anonymous.ok, true, anonymous.error);
    assert.equal(Object.hasOwn(board().review_findings[TICKET][0], "added_by"), false);
    const transfer = retryTransferWithLogin(approvalFixture, TICKET, () => reviewer(["claim", TICKET, "--transfer-to", REVIEWER, "--human-admin-override", "fixture ownership transfer"]));
    assert.equal(transfer.ok, true, transfer.error);
    assertRefusedWithoutWrites(
      ctx,
      () => correct(owner, `${TICKET}-F1`, "MED"),
      /Only the ticket owner \(claudea99\) or a recorded reviewer of the ticket may raise .*claudea0000 is neither/
    );
  }, { seedFindings: false, ticketStatus: "doing" });
});

test("COORD-820: lowering needs a second identity; the requester's own session is never enough, owner or not", () => {
  workspace(({ ctx, owner, reviewer, board }) => {
    // A recorded reviewer may raise but never lower on its own authority.
    assert.equal(reviewer(["add-finding", TICKET, "--severity", "LOW", "--summary", "s", "--qref", "L2"]).ok, true);
    for (const [run, actor] of [[owner, OWNER], [reviewer, REVIEWER]]) {
      assertRefusedWithoutWrites(
        ctx,
        () => correct(run, `${TICKET}-F2`, "LOW"),
        new RegExp(`requires approval by an identity other than the requester \\(${actor}\\).*COORD-718`)
      );
    }
    assertRefusedWithoutWrites(ctx, () => correct(owner, `${TICKET}-F2`, "LOW", "--human-admin-override", "   "), /requires --human-admin-override/);
    const beforeBareRefusal = snapshotTree(ctx.coordRoot);
    const bareRefusal = withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(),
      () => correct(owner, `${TICKET}-F2`, "LOW", "--human-admin-override", "bare string"));
    assert.equal(bareRefusal.ok, false);
    assert.match(bareRefusal.error, /requires a signed human-admin approval/);
    const afterBareRefusal = snapshotTree(ctx.coordRoot);
    for (const [file, digest] of Object.entries(beforeBareRefusal)) {
      if (/\.runtime\/governance-(?:events\.ndjson|latest-snapshot\.json|snapshots\/)/.test(file)) continue;
      assert.equal(afterBareRefusal[file], digest, `bare approval refusal must preserve ${file}`);
    }
    const lowered = correctWithSignedApproval(owner, `${TICKET}-F2`, "LOW", "--human-admin-override", "false positive, confirmed by admin");
    assert.equal(lowered.ok, true, lowered.error);
    assert.match(lowered.stdout, /MED -> LOW \(lower\) by claudea0000; approved by human-admin: false positive, confirmed by admin\./);
    const finding = board().review_findings[TICKET][1];
    assert.equal(finding.severity, "LOW");
    assert.deepEqual(finding.severity_history.map((entry) => [entry.from, entry.to, entry.direction, entry.actor, entry.approval.approver, entry.approval.reason]), [
      ["MED", "LOW", "lower", OWNER, "human-admin", "false positive, confirmed by admin"],
    ]);
  });
});

test("COORD-820: refused corrections write nothing and the actor cannot be supplied by a flag", () => {
  workspace(({ ctx, owner }) => {
    const cases = [
      [() => correct(owner, `${TICKET}-F1`, "LOW"), /already recorded as LOW; nothing to correct/],
      [() => correct(owner, `${TICKET}-F9`, "HIGH"), /Finding MSRV-820-F9 does not exist/],
      [() => owner(["correct-finding-severity", "MSRV-999", "--id", "MSRV-999-F1", "--severity", "HIGH", "--reason", "r"]), /Unknown ticket "MSRV-999"/],
      [() => owner(["correct-finding-severity", TICKET, "--id", `${TICKET}-F1`, "--severity", "HIGH", "--reason", "  "]), /nonblank --reason/],
      [() => owner(["correct-finding-severity", TICKET, "--id", `${TICKET}-F1`, "--severity", "HIGH"]), /nonblank --reason/],
      [() => owner(["correct-finding-severity", TICKET, "--severity", "HIGH", "--reason", "r"]), /requires --id/],
      [() => owner(["correct-finding-severity", TICKET, "--id", `${TICKET}-F1`, "--reason", "r"]), /requires --severity <HIGH\|MED\|LOW>/],
      [() => correct(owner, `${TICKET}-F1`, "CRITICAL"), /--severity must be one of: HIGH \| MED \| LOW \(got "CRITICAL"\)/],
      [() => correct(owner, `${TICKET}-F1`, "HIGH", "--owner", "claudea99"), /does not accept option "owner"/],
      [() => owner(["correct-finding-severity", "msrv-820", "--id", "x", "--severity", "HIGH", "--reason", "r"]), /requires an existing <ticket-id>/],
      [() => executeCommand(["correct-finding-severity", TICKET, "--id", `${TICKET}-F1`, "--severity", "HIGH", "--reason", "r"], { env: envFor(null) }), /No active claimed agent session/],
      [() => owner(["update-finding", TICKET, "--id", `${TICKET}-F1`, "--status", "open", "--severity", "HIGH"]), /update-finding changes status only and does not accept --severity\. Correct a recorded severity with `coord\/scripts\/gov correct-finding-severity MSRV-820 --id <finding-id>/],
      [() => owner(["update-finding", TICKET, "--id", `${TICKET}-F1`, "--severity", "HIGH"]), /does not accept --severity/],
    ];
    for (const [attempt, pattern] of cases) {
      assertRefusedWithoutWrites(ctx, attempt, pattern);
    }
  });
});

test("COORD-820: a ticket with no recorded findings has nothing to correct", () => {
  workspace(({ ctx, owner }) => {
    assertRefusedWithoutWrites(ctx, () => correct(owner, `${TICKET}-F1`, "HIGH"), /Finding MSRV-820-F1 does not exist under MSRV-820/);
  }, { seedFindings: false });
});

function provenanceErrors(fields) {
  const errors = [];
  boardModule.__testing.validateFindings(
    { "IMP-820": [{ id: "IMP-820-F1", summary: "s", status: "open", round: 1, qref: "L1", ...fields }] },
    new Map([["IMP-820", {}]]),
    errors
  );
  return errors;
}

function historyErrors(severity, history, original = "LOW") {
  return provenanceErrors({ severity, original_severity: original, severity_history: history });
}

test("COORD-820: the board validator refuses a severity_history that hides, breaks or self-approves a correction", () => {
  const raise = { from: "LOW", to: "MED", direction: "raise", actor: "a1", at: "2026-10-14T00:00:00Z", reason: "r", approval: null };
  const approval = { kind: "human-admin-override", approver: "human-admin", reason: "ok" };
  const lower = { from: "MED", to: "LOW", direction: "lower", actor: "a1", at: "2026-10-14T00:01:00Z", reason: "r", approval };
  assert.deepEqual(historyErrors("MED", [raise]), []);
  assert.deepEqual(historyErrors("LOW", [raise, lower]), [], "a history may return to the original value");
  const cases = [
    ["MED", [], /must be a non-empty array/],
    ["MED", "LOW", /must be a non-empty array/],
    ["MED", [null], /must change between two values/],
    ["MED", [{ ...raise, to: "LOW" }], /must change between two values/],
    ["HIGH", [raise, { ...raise, from: "LOW", to: "HIGH" }], /starts at LOW but the previous entry ended at MED/],
    ["MED", [{ ...raise, direction: "lower" }], /direction "lower" does not match LOW -> MED/],
    ["MED", [{ ...raise, actor: " " }], /must record actor, at and reason/],
    ["LOW", [raise, { ...lower, approval: null }], /lowers the severity without approval/],
    ["LOW", [raise, { ...lower, approval: { ...approval, approver: "a1" } }], /approval must be a human-admin-override by an identity other than "a1"/],
    ["LOW", [raise, { ...lower, approval: { ...approval, kind: "self" } }], /approval must be a human-admin-override/],
    ["HIGH", [raise], /severity HIGH does not match its last severity_history entry \(MED\)/],
  ];
  for (const [severity, history, pattern] of cases) {
    const errors = historyErrors(severity, history);
    assert.ok(errors.some((error) => pattern.test(error)), `expected ${pattern}; got: ${errors.join(" / ")}`);
  }
});

test("COORD-820: the board validator anchors the history at original_severity and defines the legacy rule", () => {
  const approval = { kind: "human-admin-override", approver: "human-admin", reason: "ok" };
  const approvedLowering = { from: "HIGH", to: "LOW", direction: "lower", actor: "a1", at: "2026-10-14T00:00:00Z", reason: "r", approval };
  // Legacy: created before original_severity existed and never corrected.
  for (const severity of ["HIGH", "MED", "LOW"]) assert.deepEqual(provenanceErrors({ severity }), []);
  assert.deepEqual(provenanceErrors({ severity: "MED", original_severity: "MED", added_by: "a1" }), [], "an uncorrected finding");
  assert.deepEqual(historyErrors("LOW", [approvedLowering], "HIGH"), [], "an approved lowering from the original value");
  const cases = [
    // The severity_history was deleted after the severity was lowered.
    [{ severity: "LOW", original_severity: "MED" }, /severity LOW differs from its original_severity MED but no severity_history records the change/],
    // A self-consistent approved lowering that does not start at the original value.
    [{ severity: "LOW", original_severity: "MED", severity_history: [approvedLowering] }, /severity_history\[0\] starts at HIGH but its original_severity is MED/],
    // A history with its anchor removed (the engine always writes both).
    [{ severity: "LOW", severity_history: [approvedLowering] }, /has a severity_history but no original_severity/],
    [{ severity: "LOW", original_severity: "CRITICAL" }, /invalid original_severity "CRITICAL"/],
    [{ severity: "LOW", original_severity: "LOW", added_by: " " }, /added_by must be a nonblank handle/],
  ];
  for (const [fields, pattern] of cases) {
    const errors = provenanceErrors(fields);
    assert.ok(errors.some((error) => pattern.test(error)), `expected ${pattern}; got: ${errors.join(" / ")}`);
  }
});

test("COORD-820: add-finding without a bound session records no author; return-doing records the owner", () => {
  workspace(({ owner, board }) => {
    const anonymous = executeCommand(["add-finding", TICKET, "--severity", "HIGH", "--summary", "unbound", "--qref", "L3"], { env: envFor(null) });
    assert.equal(anonymous.ok, true, anonymous.error);
    const unbound = board().review_findings[TICKET][2];
    assert.equal(unbound.original_severity, "HIGH");
    assert.equal(Object.hasOwn(unbound, "added_by"), false, "no bound session, no recorded author, no reviewer authority");
    const returned = owner(["return-doing", TICKET, "--summary", "repair needed", "--severity", "MED", "--qref", "L4"]);
    assert.equal(returned.ok, true, returned.error);
    const repaired = board().review_findings[TICKET].at(-1);
    assert.deepEqual([repaired.severity, repaired.original_severity, repaired.added_by], ["MED", "MED", OWNER]);
  });
});

// COORD-820 found that return-doing attribution and owner selection could
// diverge. COORD-844 applies the accepted contract: --owner asserts the current
// owner only, and the bound session remains both journal actor and author.
test("COORD-844: return-doing accepts --owner only as an assertion and journals the bound actor", () => {
  workspace(({ owner, board, events }) => {
    const returned = owner(["return-doing", TICKET, "--owner", OWNER, "--summary", "bound author", "--severity", "LOW", "--qref", "L6"]);
    assert.equal(returned.ok, true, returned.error);
    const recorded = board().review_findings[TICKET].at(-1);
    assert.equal(recorded.summary, "bound author");
    assert.equal(recorded.added_by, OWNER, "added_by is the bound session, never the --owner flag");
    const event = events().findLast((entry) => entry.command === "return-doing" && entry.result === "succeeded");
    assert.equal(event.identity.owner, OWNER, "the journal actor is the bound session");
  });
});

test("COORD-844: a different return-doing --owner is refused before any persisted write", () => {
  workspace(({ ctx, owner }) => {
    assertRefusedWithoutWrites(
      ctx,
      () => owner(["return-doing", TICKET, "--owner", REVIEWER, "--summary", "attempted rewrite", "--severity", "LOW", "--qref", "L6"]),
      /return-doing --owner is only an assertion of the current owner .*Use `coord\/scripts\/gov claim MSRV-820 --transfer-to claudea99 --human-admin-override/
    );
  });
});

test("COORD-844: return-doing with --owner refuses a nonexistent ticket without governance writes", () => {
  workspace(({ ctx, owner }) => {
    assertRefusedWithoutWrites(
      ctx,
      () => owner(["return-doing", "MSRV-820-MISSING", "--owner", OWNER, "--summary", "missing ticket", "--severity", "LOW", "--qref", "L12"]),
      /Unknown ticket "MSRV-820-MISSING"/
    );
  });
});

test("COORD-844: a registered simple-id alias for the current owner remains compatible", () => {
  workspace(({ owner, board }) => {
    const returned = owner(["return-doing", TICKET, "--owner", "a00", "--summary", "simple-id assertion", "--severity", "LOW", "--qref", "L11"]);
    assert.equal(returned.ok, true, returned.error);
    assert.equal(board().review_findings[TICKET].at(-1).added_by, OWNER);
  });
});

test("COORD-820: return-doing without a bound session records no author", () => {
  // Through the CLI an unbound return-doing is refused by the ownership check
  // before any finding exists, so --owner cannot stand in for a session there.
  workspace(({ ctx }) => {
    assertRefusedWithoutWrites(ctx, () => executeCommand(["return-doing", TICKET, "--owner", OWNER, "--summary", "unbound return", "--severity", "MED", "--qref", "L7"], { env: envFor(null) }), /not a registered agent \/ not the bound owner of MSRV-820/);
  });
  // The stamp itself: the bound session's handle, or nothing at all.
  const { boundFindingAuthorStamp } = require("./ticket-transitions.js");
  const calls = [];
  const bound = (options) => { calls.push(options); return { agent: { handle: OWNER } }; };
  assert.deepEqual(boundFindingAuthorStamp(bound), { added_by: OWNER });
  assert.deepEqual(calls, [{ readOnly: true }], "the author lookup must not bind, touch or auto-claim a session");
  assert.deepEqual(boundFindingAuthorStamp(() => { throw new Error("no bound session"); }), {});
  assert.deepEqual(boundFindingAuthorStamp(() => null), {});
  assert.deepEqual(boundFindingAuthorStamp(() => ({ agent: null })), {});
  assert.deepEqual(boundFindingAuthorStamp(() => ({ agent: { handle: "" } })), {});
});

test("COORD-820: add-finding and update-finding keep their argument checks and optional links", () => {
  workspace(({ ctx, owner, board }) => {
    const refusals = [
      [() => owner(["add-finding"]), /add-finding requires <ticket-id>/],
      [() => owner(["add-finding", TICKET, "--severity", "LOW", "--summary", "s"]), /add-finding requires --severity, --summary, and --qref/],
      [() => owner(["add-finding", "MSRV-999", "--severity", "LOW", "--summary", "s", "--qref", "L1"]), /Unknown ticket "MSRV-999"/],
      [() => owner(["update-finding"]), /update-finding requires <ticket-id>/],
      [() => owner(["update-finding", TICKET, "--id", `${TICKET}-F1`]), /update-finding requires --id <finding-id> and --status <status>/],
      [() => owner(["update-finding", TICKET, "--id", `${TICKET}-F9`, "--status", "resolved"]), /Finding MSRV-820-F9 does not exist under MSRV-820/],
    ];
    for (const [attempt, pattern] of refusals) assertRefusedWithoutWrites(ctx, attempt, pattern);
    const linked = owner(["add-finding", TICKET, "--severity", "MED", "--summary", "linked", "--qref", "L5",
      "--deferred-to", TICKET, "--consolidated-into", `${TICKET}-F1`]);
    assert.equal(linked.ok, true, linked.error);
    const added = board().review_findings[TICKET].at(-1);
    assert.deepEqual([added.deferred_to, added.consolidated_into, added.original_severity, added.added_by], [TICKET, `${TICKET}-F1`, "MED", OWNER]);
    const updated = owner(["update-finding", TICKET, "--id", `${TICKET}-F1`, "--status", "deferred", "--deferred-to", TICKET, "--consolidated-into", `${TICKET}-F2`]);
    assert.equal(updated.ok, true, updated.error);
    const first = board().review_findings[TICKET][0];
    assert.deepEqual([first.status, first.deferred_to, first.consolidated_into, first.severity, first.original_severity], ["deferred", TICKET, `${TICKET}-F2`, "LOW", "LOW"]);
  });
});

test("COORD-820: return-doing and correct-finding-round keep their refusals around the stamped finding", () => {
  workspace(({ ctx, owner, board }) => {
    const roundOverride = ["--human-admin-override", "admin"];
    const refusals = [
      [() => owner(["return-doing"]), /return-doing requires <ticket-id>/],
      [() => owner(["return-doing", TICKET, "--summary", "s"]), /return-doing requires --summary, --severity, and --qref/],
      [() => owner(["return-doing", "MSRV-999", "--summary", "s", "--severity", "LOW", "--qref", "L1"]), /Unknown ticket "MSRV-999"/],
      [() => owner(["correct-finding-round"]), /correct-finding-round requires <ticket-id>/],
      [() => owner(["correct-finding-round", TICKET, ...roundOverride]), /correct-finding-round requires --id <finding-id>/],
      [() => owner(["correct-finding-round", TICKET, "--id", `${TICKET}-F1`, "--round", "0", ...roundOverride]), /requires --round <positive integer>; got "0"/],
    ];
    for (const [attempt, pattern] of refusals) assertRefusedWithoutWrites(ctx, attempt, pattern);
    const returned = owner(["return-doing", TICKET, "--summary", "repair", "--severity", "HIGH", "--qref", "L4"]);
    assert.equal(returned.ok, true, returned.error);
    assert.match(returned.stdout, /recorded MSRV-820-F3, reacquired lock, and updated plan under owner=claudea0000\./);
    assert.deepEqual(board().review_findings[TICKET].map((entry) => entry.original_severity), ["LOW", "MED", "HIGH"]);
    // The ticket is now doing, so a second rejection has no review to return from.
    assertRefusedWithoutWrites(ctx, () => owner(["return-doing", TICKET, "--summary", "again", "--severity", "LOW", "--qref", "L5"]), /Ticket MSRV-820 must be review; current status is "doing"/);
  });
});

test("COORD-820: the first correction of a legacy finding pins its original_severity", () => {
  const createCorrectFindingSeverity = require("./correct-finding-severity.js");
  const legacy = { id: `${TICKET}-F1`, severity: "LOW", summary: "s", status: "open", round: 1, qref: "L1" };
  const board = { review_findings: { [TICKET]: [legacy] } };
  let written = null;
  const correctFindingSeverity = createCorrectFindingSeverity({
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (_mutation, fn) => fn(),
    withCoordStateLock: (fn) => fn(),
    readBoard: () => board,
    writeBoard: (value) => { written = JSON.parse(JSON.stringify(value)); },
    runBoardSync: () => {},
    getTicketRef: () => ({ row: { Owner: OWNER } }),
    ensureCurrentAgentIdentity: () => ({ agent: { handle: OWNER } }),
    resolveHumanAdminOverride: () => { throw new Error("no override expected"); },
    inferTicketStatus: () => "review",
    ORDERED_FINDING_SEVERITIES: require("./governance-constants.js").ORDERED_FINDING_SEVERITIES,
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    correctFindingSeverity(TICKET, { id: legacy.id, severity: "MED", reason: "re-triaged" });
  } finally {
    console.log = originalLog;
  }
  const finding = written.review_findings[TICKET][0];
  assert.equal(finding.original_severity, "LOW");
  assert.equal(finding.severity, "MED");
  const errors = [];
  boardModule.__testing.validateFindings(written.review_findings, new Map([[TICKET, {}]]), errors);
  assert.deepEqual(errors, [], "the pinned original chains into the recorded history");
});

test("COORD-820: correct-finding-round refuses a missing or non-positive --round before reading the board", () => {
  const createLifecycleTicketAdmin = require("./lifecycle-ticket-admin.js");
  const { integerOrDefault } = require("./lifecycle-utils.js");
  const mutations = [];
  const admin = createLifecycleTicketAdmin({
    fail: (message) => { throw new Error(message); },
    integerOrDefault,
    inferTicketStatus: () => "review",
    withGovernanceMutation: (mutation, fn) => { mutations.push(mutation.command); return fn(); },
    readBoard: () => { throw new Error("the board must not be read for a refused round"); },
    writeBoard: () => { throw new Error("the board must not be written for a refused round"); },
  });
  const base = { id: `${TICKET}-F1`, humanAdminOverride: "admin" };
  for (const [round, shown] of [[undefined, ""], ["0", "0"], ["-2", "-2"], ["two", "two"]]) {
    assert.throws(
      () => admin.correctFindingRound(TICKET, round === undefined ? base : { ...base, round }),
      new RegExp(`correct-finding-round requires --round <positive integer>; got "${shown}"\\.$`),
      `--round ${round}`
    );
  }
  assert.deepEqual(mutations, Array(4).fill("correct-finding-round"), "each refusal is inside the governed mutation");
});

test("COORD-1048: correct-finding-round requires a signature over the finding and requested round", () => {
  const createLifecycleTicketAdmin = require("./lifecycle-ticket-admin.js");
  const { integerOrDefault } = require("./lifecycle-utils.js");
  const ticketId = "COORD-1048";
  const reason = "fixture admin approved this exact finding correction";
  const row = { ID: ticketId, Status: "review", Owner: OWNER, Repo: "X", Type: "task", Pri: "P1", Description: "synthetic finding correction" };
  const finding = { id: "COORD-1048-F1", round: 2, status: "open", severity: "MED", added_by: REVIEWER };
  const board = { review_findings: { [ticketId]: [finding] }, sections: [{ rows: [row] }] };
  const events = [];
  const mutations = [];
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1048-round-runtime-"));
  const admin = createLifecycleTicketAdmin({
    fail: (message) => { throw new Error(message); },
    integerOrDefault,
    inferTicketStatus: () => "review",
    currentReviewRound: (plan, findings) => plan?.review_round || Math.max(1, ...findings.map((item) => item.round || 1)),
    readPlanRecord: () => ({ review_round: 2 }),
    ensureReviewFindings: (source, id) => source.review_findings[id],
    getTicketRef: (_source, id) => id === ticketId ? { row } : null,
    readBoard: () => board,
    writeBoard: () => {},
    runBoardSync: () => {},
    withCoordStateLock: (fn) => fn(),
    withGovernanceMutation: (mutation, fn) => { const result = fn(); mutations.push(mutation); return result; },
    resolveHumanAdminOverride: (command, options) => ({ reason: options.humanAdminOverride, legacyForceAlias: false }),
    appendGovernanceEvent: (event) => events.push(event),
    runtimeDir,
  });
  const options = { id: finding.id, round: "1", humanAdminOverride: reason };
  const approvalState = {
    ticket: row,
    finding,
    requested_round: 1,
    reached_review_round: 2,
    findings: [finding],
  };
  const before = JSON.stringify(board);
  try {
    assert.throws(() => admin.reopenTicket(), /reopen-ticket requires <ticket-id>/);
    assert.throws(() => admin.reopenTicket("COORD-404"), /Unknown ticket "COORD-404"/);
    assert.throws(() => admin.reopenTicket(ticketId), /open-followup.*return-doing/);
    assert.throws(() => admin.correctFindingRound(ticketId, options), /signed human-admin approval.*Subject digest:/);
    assert.equal(JSON.stringify(board), before, "unsigned text does not reclassify the finding");
    const digest = approvalVerifier.subjectSha256({ verb: "correct-finding-round", ticket: ticketId, reason,
      state: approvalVerifier.canonicalJson(approvalState) });
    approvalFixture.login({ verb: "correct-finding-round", ticket: ticketId, subject_sha256: digest });
    withApprovalTestClient(path.resolve(__dirname, "..", ".."), approvalFixture.client(), () =>
      admin.correctFindingRound(ticketId, options));
    assert.equal(board.review_findings[ticketId][0].round, 1);
    assert.equal(events.filter((event) => event.event === "approval.verified").length, 1);
    assert.equal(mutations.at(-1).details.approval_subject_sha256, digest);
    assert.match(mutations.at(-1).details.human_admin_session, /^[a-f0-9]{32}$/);
    assert.match(mutations.at(-1).details.approval_record, /^[a-f0-9]{32}$/);
    assert.match(mutations.at(-1).details.approval_verified, /^key_id=[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
