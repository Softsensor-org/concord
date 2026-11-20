"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js")).sandboxProcessRuntime();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ensureControlPlaneLandingRecord } = require("./control-plane-landing.js");
const { withScopedGovernanceTestContext } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-test-utils.js"));
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");
const { withApprovalTestClient } = require("./__fixtures__/approval-test-client.js");

function signedCorrection(f, board, options) {
  const fixture = createApprovalFixture({ allowedVerbs: ["audit-landings correction"] });
  const runtimeDir = path.join(f.root, ".approval-runtime");
  const deps = {
    resolveHumanAdminOverride: (_verb, value) => ({ reason: String(value.humanAdminOverride || "").trim() }),
    fail: (message) => { throw new Error(message); },
    appendGovernanceEvent: (event) => {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.appendFileSync(path.join(runtimeDir, "events.ndjson"), `${JSON.stringify(event)}\n`);
    },
    runtimeDir,
  };
  const correctLanding = require("./landing-corrections.js").correctLanding;
  try {
    return withApprovalTestClient(COORD_ROOT_DIR, fixture.client(), () => {
      try { return correctLanding(board, options, deps); } catch (error) {
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
        if (!digest) throw error;
        fixture.login({ verb: "audit-landings correction", ticket: options.correctionTicket, subject_sha256: digest[1] });
        return correctLanding(board, options, deps);
      }
    });
  } finally { fixture.cleanup(); }
}

function withSignedAttempt(ticket, run) {
  const fixture = createApprovalFixture({ allowedVerbs: ["audit-landings correction"] });
  try {
    return withApprovalTestClient(COORD_ROOT_DIR, fixture.client(), () => {
      try { return run(); } catch (error) {
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(String(error.message));
        if (!digest) throw error;
        fixture.login({ verb: "audit-landings correction", ticket, subject_sha256: digest[1] });
        return run();
      }
    });
  } finally { fixture.cleanup(); }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "landing-correction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "base");
  git("checkout", "-b", "ticket");
  git("commit", "--allow-empty", "-m", "COORD-1 source");
  const source = git("rev-parse", "HEAD");
  git("checkout", "main");
  git("merge", "--no-ff", "ticket", "-m", "COORD-1 governed integration");
  const merge = git("rev-parse", "HEAD");
  git("init", "--bare", path.join(root, "remote.git"));
  git("remote", "add", "origin", path.join(root, "remote.git"));
  git("push", "origin", "main");
  const board = { sections: [{ rows: [{ ID: "COORD-1", Repo: "X", Status: "done" },
    { ID: "COORD-2", Repo: "X", Status: "doing" }] }],
    landing_index: { "COORD-1": { commit_sha: source, source_commit_sha: source,
      evidence: ["original unchanged"], method: "no_pr" } } };
  const options = { ticket: "COORD-1", correctionTicket: "COORD-2", correctMerge: merge,
    sourceCommit: source, humanAdminOverride: "Human approved append-only corrections",
    reason: "source parent was stored as merge", layout: { coordRepoRoot: root }, configuredBranch: "main" };
  return { root, git, source, merge, board, options };
}

test("new landing writer does not scavenge source hashes from prose or no-PR refs", (t) => {
  const f = fixture(t);
  const board = { pr_index: { "COORD-1": [`${f.source} (no PR)`] } };
  const record = ensureControlPlaneLandingRecord("COORD-1", board, { Repo: "X" }, {
    ...f.options, landed: `merge ${f.source}`, sourceCommit: f.source,
  });
  assert.equal(record.commit_sha, undefined);
  assert.equal(record.control_plane_verification, "local_only");
  const structured = ensureControlPlaneLandingRecord("COORD-1", { pr_index: board.pr_index }, { Repo: "X" }, {
    ...f.options, landed: `source ${f.source}`, commitSha: f.merge,
  });
  assert.equal(structured.commit_sha, f.merge);
  assert.equal(structured.source_commit_sha, f.source);
});

test("correction is dry-run by default, append-only, digest-bound and idempotent", (t) => {
  const { correctLanding, validateLandingCorrections } = require("./landing-corrections.js");
  const f = fixture(t);
  const before = JSON.stringify(f.board);
  const preview = correctLanding(f.board, f.options);
  assert.equal(preview.changed, false);
  assert.equal(JSON.stringify(f.board), before);
  const original = JSON.stringify(f.board.landing_index);
  const result = signedCorrection(f, f.board, { ...f.options, write: true });
  assert.equal(result.changed, true);
  assert.equal(JSON.stringify(f.board.landing_index), original);
  assert.equal(result.correction.commit_sha, f.merge);
  assert.deepEqual(validateLandingCorrections(f.board, f.options), []);
  assert.equal(signedCorrection(f, f.board, { ...f.options, write: true }).changed, false);
  assert.equal(f.board.landing_corrections["COORD-1"].length, 1);
  signedCorrection(f, f.board, { ...f.options, reason: "Additional approved explanation", write: true });
  assert.equal(f.board.landing_corrections["COORD-1"].length, 2);
  assert.deepEqual(validateLandingCorrections(f.board, f.options), []);
  const first = f.board.landing_corrections["COORD-1"][0];
  const reason = first.reason;
  first.reason = "altered prior correction";
  assert.match(validateLandingCorrections(f.board, f.options).join("\n"), /previous correction digest/i);
  const damagedBoard = JSON.stringify(f.board);
  assert.throws(() => correctLanding(f.board, { ...f.options, write: true }), /previous correction digest/i);
  assert.equal(JSON.stringify(f.board), damagedBoard, "a new correction cannot overwrite a damaged history");
  first.reason = reason;
  f.board.landing_index["COORD-1"].evidence.push("tampered");
  assert.match(validateLandingCorrections(f.board, f.options).join("\n"), /original.*digest/i);
});

test("corrections reject wrong merge, source, missing authority, and offline writes", (t) => {
  const { correctLanding } = require("./landing-corrections.js");
  const f = fixture(t);
  const before = JSON.stringify(f.board);
  for (const [override, refusal] of [
    [{ correctMerge: f.source }, /requires an actual merge/],
    [{ sourceCommit: f.merge }, /does not prove first-introduction/],
    [{ ticket: undefined }, /naming a done control-plane ticket/],
    [{ humanAdminOverride: undefined }, /requires --human-admin-override, --reason/],
    [{ reason: undefined }, /requires --human-admin-override, --reason/],
    [{ correctionTicket: undefined }, /requires --human-admin-override, --reason/],
    [{ correctionTicket: "COORD-1" }, /requires --human-admin-override, --reason/],
  ]) {
    assert.throws(() => correctLanding(f.board, { ...f.options, ...override, write: true }), refusal);
    assert.equal(JSON.stringify(f.board), before);
  }
  f.git("remote", "set-url", "origin", path.join(f.root, "missing.git"));
  assert.throws(() => correctLanding(f.board, { ...f.options, write: true }), /fetch/i);
  assert.equal(f.board.landing_corrections, undefined);
});

test("a later unrelated merge cannot relabel an already introduced source", (t) => {
  const { correctLanding } = require("./landing-corrections.js");
  const f = fixture(t);
  f.git("checkout", "-b", "other");
  f.git("commit", "--allow-empty", "-m", "other source");
  f.git("checkout", "main");
  f.git("merge", "--no-ff", "other", "-m", "COORD-1 unrelated later merge");
  f.git("push", "origin", "main");
  assert.throws(() => correctLanding(f.board, { ...f.options, correctMerge: f.git("rev-parse", "HEAD"), write: true }), /first.introduction/i);
});

test("public CLI dry-run reaches correction verifier, leaves board intact, and audit preserves original", (t) => {
  const f = fixture(t);
  const cli = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/cli.js")).__testing;
  const layouts = require("./control-plane-paths.js").__testing;
  const boardPath = path.join(f.root, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(f.board));
  const originalLog = console.log;
  const output = [];
  console.log = (value) => output.push(value);
  t.after(() => { layouts.reset(); console.log = originalLog; });
  return withScopedGovernanceTestContext({ BOARD_PATH: boardPath }, () => {
    layouts.override(f.options.layout);
  const argv = ["--ticket", "COORD-1", "--correct-merge", f.merge, "--source-commit", f.source,
    "--correction-ticket", "COORD-2", "--human-admin-override", f.options.humanAdminOverride,
    "--reason", f.options.reason];
  const before = fs.readFileSync(boardPath, "utf8");
  cli.dispatchCommand("audit-landings", argv);
  assert.equal(JSON.parse(output.pop()).correction.commit_sha, f.merge);
  assert.equal(fs.readFileSync(boardPath, "utf8"), before);
  assert.throws(() => cli.dispatchCommand("audit-landings", [...argv, "--correct-merge", f.source]), /actual merge/);
  // Model an already-held outer transaction only in this isolated fixture so
  // the real CLI -> composition root -> ownership join is exercised directly.
  // The fixture has no registered owner; the real ownership guard must refuse.
  const { state } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/governance-context.js"));
  const savedMutation = state.activeGovernanceMutationContext;
  state.activeGovernanceMutationContext = { depth: 0 };
  try {
    assert.throws(() => cli.dispatchCommand("audit-landings", [...argv, "--write"]), /not a registered agent/);
    assert.equal(fs.readFileSync(boardPath, "utf8"), before);
  } finally { state.activeGovernanceMutationContext = savedMutation; }
  signedCorrection(f, f.board, { ...f.options, write: true });
  fs.writeFileSync(boardPath, JSON.stringify(f.board));
  cli.dispatchCommand("audit-landings", ["--ticket", "COORD-1", "--repo", "X"]);
  const entry = JSON.parse(output.pop()).entries[0];
  assert.equal(entry.resolved_commit_sha, f.merge);
  assert.equal(entry.original_landing.commit_sha, f.source);
  assert.equal(entry.corrections.length, 1);
  });
});

test("public correction writer is inside mutation and ownership guards; denial writes nothing", (t) => {
  const f = fixture(t);
  const layouts = require("./control-plane-paths.js").__testing;
  layouts.override(f.options.layout);
  t.after(() => layouts.reset());
  const create = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle-maintenance-commands.js"));
  const calls = [];
  let deny = true;
  const commands = create({
    REPO_ROOTS: { B: f.root },
    applyLandingAuditBackfill: (board, filters) => {
      assert.equal(board, f.board);
      assert.deepEqual(filters, { ticket: null, repo: null });
      calls.push("backfill");
      return { backfilled: [] };
    },
    readBoard: () => f.board,
    getTicketRef: (board, id) => {
      const row = board.sections[0].rows.find((row) => row.ID === id);
      return row ? { row } : null;
    },
    fail: (message) => { throw new Error(message); },
    withGovernanceMutation: (metadata, action) => {
      assert.equal(metadata.command, "audit-landings");
      assert.equal(metadata.ticket, metadata.allowProvenanceDrift ? null : "COORD-2");
      calls.push("mutation"); return action();
    },
    ensureTicketMutationOwnership: (ticket, row) => {
      assert.equal(ticket, "COORD-2"); assert.equal(row.ID, ticket);
      calls.push("ownership"); if (deny) throw new Error("foreign ownership");
    },
    writeBoard: () => calls.push("write"), runBoardSync: () => calls.push("sync"),
    resolveHumanAdminOverride: (_verb, options) => ({ reason: options.humanAdminOverride }),
    appendGovernanceEvent: (event) => { const dir = path.join(f.root, ".runtime"); fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "events.ndjson"), `${JSON.stringify(event)}\n`); },
    runtimeDir: path.join(f.root, ".runtime"),
  });
  assert.throws(() => commands.auditLandings({ ...f.options, correctionTicket: "COORD-404" }), /known --correction-ticket/);
  assert.deepEqual(calls, []);
  assert.throws(() => commands.auditLandings({ ...f.options, write: true }), /foreign ownership/);
  assert.deepEqual(calls, ["mutation", "ownership"]);
  assert.equal(f.board.landing_corrections, undefined);
  deny = false; calls.length = 0;
  const originalLog = console.log; console.log = () => {};
  try { withSignedAttempt("COORD-2", () => commands.auditLandings({ ...f.options, write: true })); } finally { console.log = originalLog; }
  assert.deepEqual(calls, ["mutation", "ownership", "mutation", "ownership", "write", "sync"]);
  calls.length = 0;
  assert.throws(() => commands.auditLandings({ repo: "UNKNOWN", write: true }), /Unsupported repo code "UNKNOWN"/);
  assert.deepEqual(calls, []);
  console.log = () => {};
  try { commands.auditLandings({ write: true }); } finally { console.log = originalLog; }
  assert.deepEqual(calls, ["mutation", "backfill"], "an empty backfill does not write or sync");
});

test("persisted corrections obey canonical schema; altered SHA, original and chain are rejected", (t) => {
  const f = fixture(t);
  const { correctLanding, validateLandingCorrections } = require("./landing-corrections.js");
  signedCorrection(f, f.board, { ...f.options, write: true });
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../board/tasks.schema.json"))).properties.landing_corrections;
  // Keep the board schema seam distinct from the governance facade scanner.
  const { __testing: schemaTesting } = require("../../board/board.js");
  const validateSchema = schemaTesting.validateSchema;
  const errors = [];
  const persisted = JSON.parse(JSON.stringify(f.board));
  validateSchema(schema, persisted.landing_corrections, "landing_corrections", errors);
  assert.deepEqual(errors, []);
  for (const change of [ { commit_sha: f.source }, { previous_correction_digest: "a".repeat(64) },
    { original_record_digest: "b".repeat(64) }, { approval: "" } ]) {
    const mutated = structuredClone(persisted);
    Object.assign(mutated.landing_corrections["COORD-1"][0], change);
    assert.notEqual(validateLandingCorrections(mutated, f.options).length, 0);
  }
  persisted.landing_corrections["COORD-1"][0].unknown = true;
  validateSchema(schema, persisted.landing_corrections, "landing_corrections", errors);
  assert.match(errors.join("\n"), /unexpected key/);
});

test("canonical board validator rejects correction tampering after persistence", (t) => {
  const f = fixture(t);
  signedCorrection(f, f.board, { ...f.options, write: true });
  const layouts = require("./control-plane-paths.js").__testing;
  layouts.override(f.options.layout);
  t.after(() => layouts.reset());
  const board = { ...f.board, version: 1,
    metadata: { title: "correction fixture", last_updated: "2026-01-01", canonical_references: [] },
    prompt_index: {}, pr_index: {}, review_findings: {}, followup_exceptions: {},
    sections: [{ kind: "table", level: 2, heading: "fixture", separator_before: false,
      columns: ["ID", "Repo", "Status", "Owner"], rows: f.board.sections[0].rows.map((row) =>
        ({ ...row, Status: "done", Owner: "unassigned" })) }],
  };
  board.landing_index["COORD-1"].recorded_at = "2026-01-01T00:00:00.000Z";
  // Recreate only the fixture correction after adding required original metadata.
  board.landing_corrections["COORD-1"][0].original_record_digest = require("./landing-corrections.js").digest(board.landing_index["COORD-1"]);
  const boardPath = path.join(f.root, "persisted-board.json");
  fs.writeFileSync(boardPath, JSON.stringify(board));
  const persisted = JSON.parse(fs.readFileSync(boardPath));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../board/tasks.schema.json")));
  const planSchema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../board/plan.schema.json")));
  const boardTesting = require("../../board/board.js").__testing;
  const savedPaths = { ...boardTesting.paths };
  boardTesting.paths.PLAN_RECORDS_DIR = path.join(f.root, "empty-plans");
  boardTesting.paths.LEGACY_PLAN_RECORDS_DIR = path.join(f.root, "empty-legacy-plans");
  t.after(() => Object.assign(boardTesting.paths, savedPaths));
  const validate = boardTesting.validateBoard;
  const options = { governanceEventLogPath: path.join(f.root, "empty-journal") };
  assert.doesNotThrow(() => validate(persisted, schema, planSchema, options));
  persisted.landing_corrections["COORD-1"][0].commit_sha = f.source;
  assert.throws(() => validate(persisted, schema, planSchema, options), /actual merge/);
});

test("legacy landing corrections require an exact ticket on the merge when structured provenance is missing", (t) => {
  const { correctLanding } = require("./landing-corrections.js");
  const f = fixture(t);
  const emptyRows = { ...f.board, sections: [{ title: "Notes" }] };
  assert.throws(() => correctLanding(emptyRows, f.options), /naming a done control-plane ticket/);
  const original = f.board.landing_index["COORD-1"];
  delete original.source_commit_sha;
  const fallback = correctLanding(f.board, f.options);
  assert.equal(fallback.correction.source_commit_sha, f.source);
  assert.equal(fallback.changed, false);

  delete original.commit_sha;
  const legacy = correctLanding(f.board, f.options);
  assert.equal(legacy.correction.commit_sha, f.merge);
  assert.equal(legacy.changed, false);

  const otherTicket = "COORD-10";
  f.board.sections[0].rows.push({ ID: otherTicket, Repo: "X", Status: "done" });
  f.board.landing_index[otherTicket] = { ...original };
  const before = JSON.stringify(f.board);
  assert.throws(() => correctLanding(f.board, { ...f.options, ticket: otherTicket, write: true }),
    /Historical merge has no exact ticket binding/);
  assert.equal(JSON.stringify(f.board), before);
});
