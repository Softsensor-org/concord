// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

// COORD-635 repair — the writer/schema seam.
//
// WHAT WENT WRONG. COORD-635 shipped a landing-record writer that emits
// `control_plane_verification` (+ `control_plane_verification_reason`), while
// coord/board/tasks.schema.json declares landing_index entries with
// `additionalProperties: false`. The two disagreed, so `gov land` refused the
// record the feature exists to write — the feature could not record its own
// evidence.
//
// WHY THE GATE WAS GREEN WHILE IT WAS BROKEN (confirmed, not assumed):
//   1. PRIMARY — every COORD-635 test asserted on the OBJECT RETURNED by
//      ensureControlPlaneLandingRecord. That object was never passed through
//      validateBoard, so the canonical schema never saw it. In-memory
//      assertions cannot catch a schema disagreement.
//   2. `npm test` does not run `node coord/board/board.js validate` at all —
//      that step lives in coord/scripts/preflight.sh. So a test must invoke the
//      validator ITSELF; relying on the suite to do it would not have worked.
//   3. Even the live-board validate passed, because no Repo-X landing record
//      had ever been written successfully — the first real write was the land
//      attempt that failed.
//   4. coord/board/board.test.js has landing_index fixtures, but every one is
//      `{}`. No fixture exercised a POPULATED landing record's key shape.
//
// So the fix is aimed at the seam that was actually unguarded: writer keys vs
// schema properties, and a persisted-then-RELOADED record validated by the
// canonical validator.
//
// The parity test derives the emitted key set FROM THE WRITER — statically from
// its record literal and dynamically by running it across every branch — so a
// field added later without a schema entry fails here instead of failing a land
// months later.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  CONTROL_PLANE_VERIFICATION,
  CONTROL_PLANE_VERIFICATION_REASON,
  ensureControlPlaneLandingRecord,
} = require("./control-plane-landing.js");
const { resolveControlPlaneLayout } = require("./control-plane-paths.js");
const { __testing: boardTesting } = require("../board/board.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WRITER_PATH = path.join(__dirname, "control-plane-landing.js");
const TASKS_SCHEMA_PATH = path.join(REPO_ROOT, "coord", "board", "tasks.schema.json");
const PLAN_SCHEMA_PATH = path.join(REPO_ROOT, "coord", "board", "plan.schema.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function landingEntrySchema() {
  return readJson(TASKS_SCHEMA_PATH).properties.landing_index.additionalProperties;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "coord test",
  GIT_AUTHOR_EMAIL: "coord@test.invalid",
  GIT_COMMITTER_NAME: "coord test",
  GIT_COMMITTER_EMAIL: "coord@test.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git -C ${dir} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

// A control-plane repository with a CONTROLLED bare fixture remote (never a
// live one), so remote-ancestry evidence can be produced hermetically.
function buildCoordRepo({ withRemote = true } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cp-schema-"));
  const coordDir = path.join(workspace, "coord");
  write(path.join(coordDir, "GOVERNANCE.md"), "# governance\n");
  git(coordDir, "init", "--initial-branch=main", ".");
  git(coordDir, "add", "-A");
  git(coordDir, "commit", "--no-verify", "-m", "governance baseline");
  if (withRemote) {
    const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-schema-remote-")), "origin.git");
    fs.mkdirSync(remote, { recursive: true });
    git(path.dirname(remote), "init", "--bare", "--initial-branch=main", remote);
    git(coordDir, "remote", "add", "origin", remote);
    git(coordDir, "push", "origin", "main");
    git(coordDir, "fetch", "origin", "main");
  }
  return { workspace, coordDir, layout: resolveControlPlaneLayout({ coordDir, workspaceRoot: workspace }) };
}

// ---------------------------------------------------------------------------
// 1. Writer -> schema parity, derived from the writer (requirement 2).
// ---------------------------------------------------------------------------

// STATIC derivation: pull the key names straight out of the writer's record
// literal, so a key that only appears on a branch no test happens to hit is
// still covered. Over-matching (e.g. a future nested object) fails the test
// rather than passing it — the fail-safe direction.
function staticallyEmittedLandingKeys() {
  const source = fs.readFileSync(WRITER_PATH, "utf8");
  const marker = "board.landing_index[ticketId] = {";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "the landing-record literal must be findable in the writer");
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, "the landing-record literal must be brace-balanced");
  const block = source.slice(start + marker.length - 1, end + 1);
  const keys = new Set();
  // Plain `key:` entries and keys inside `...(cond ? { key: v } : {})` spreads.
  for (const match of block.matchAll(/(?:^|[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    keys.add(match[1]);
  }
  return keys;
}

// DYNAMIC derivation: actually run the writer across every branch and union the
// keys it really produces.
function dynamicallyEmittedLandingKeys() {
  const keys = new Set();
  const scenarios = [];

  const remote = buildCoordRepo({ withRemote: true });
  const local = buildCoordRepo({ withRemote: false });
  try {
    const landed = git(remote.coordDir, "rev-parse", "HEAD");
    scenarios.push(
      // remote_ancestry: a commit that IS on the fixture remote
      { layout: remote.layout, landed: `landed ${landed}`, id: "COORD-8001" },
      // local_only: prose evidence naming no commit, remote present
      { layout: remote.layout, landed: "landed on the integration branch", id: "COORD-8002" },
      // local_only: no governance remote at all
      { layout: local.layout, landed: `landed ${git(local.coordDir, "rev-parse", "HEAD")}`, id: "COORD-8003" },
      // local_only: no control-plane repository at all
      { layout: { coordDir: "/nope/coord", coordRepoRoot: null, coordPathPrefix: null, topology: "none" }, landed: "landed somewhere", id: "COORD-8004" },
    );
    for (const scenario of scenarios) {
      const board = { landing_index: {}, pr_index: {} };
      const record = ensureControlPlaneLandingRecord(
        scenario.id, board, { Repo: "X" },
        { landed: scenario.landed, layout: scenario.layout }
      );
      assert.ok(record, `${scenario.id} must produce a record`);
      for (const key of Object.keys(record)) keys.add(key);
    }
  } finally {
    fs.rmSync(remote.workspace, { recursive: true, force: true });
    fs.rmSync(local.workspace, { recursive: true, force: true });
  }
  return keys;
}

test("COORD-635 repair: EVERY key the landing writer can emit is declared in the board schema", () => {
  const declared = new Set(Object.keys(landingEntrySchema().properties));
  const staticKeys = staticallyEmittedLandingKeys();
  const dynamicKeys = dynamicallyEmittedLandingKeys();

  // Sanity: the derivation must actually be finding keys, or the test is vacuous.
  assert.ok(staticKeys.size >= 6, `static derivation found too few keys: ${[...staticKeys]}`);
  assert.ok(dynamicKeys.size >= 5, `dynamic derivation found too few keys: ${[...dynamicKeys]}`);
  // The two new fields must be among what the writer emits, or this test is not
  // actually guarding the thing that broke.
  assert.ok(staticKeys.has("control_plane_verification"));
  assert.ok(dynamicKeys.has("control_plane_verification"));
  assert.ok(dynamicKeys.has("control_plane_verification_reason"));

  const undeclared = [...new Set([...staticKeys, ...dynamicKeys])].filter((key) => !declared.has(key)).sort();
  assert.deepEqual(
    undeclared, [],
    "control-plane-landing.js emits landing_index key(s) that coord/board/tasks.schema.json does not declare. " +
    "Add them explicitly to the schema (never additionalProperties:true) — this is the COORD-635 defect class."
  );
});

test("COORD-635 repair: the schema enums are pinned to the writer's constants, not hand-copied", () => {
  const properties = landingEntrySchema().properties;
  assert.deepEqual(
    properties.control_plane_verification.enum.slice().sort(),
    Object.values(CONTROL_PLANE_VERIFICATION).slice().sort(),
    "tasks.schema.json control_plane_verification enum drifted from CONTROL_PLANE_VERIFICATION"
  );
  assert.deepEqual(
    properties.control_plane_verification_reason.enum.slice().sort(),
    Object.values(CONTROL_PLANE_VERIFICATION_REASON).slice().sort(),
    "tasks.schema.json control_plane_verification_reason enum drifted from CONTROL_PLANE_VERIFICATION_REASON"
  );
  // Constrained, not loose: the enum field must not degrade to a bare string.
  assert.equal(properties.control_plane_verification.type, "string");
  assert.ok(Array.isArray(properties.control_plane_verification.enum));
  assert.equal(properties.control_plane_verification.enum.length, 2);
});

// ---------------------------------------------------------------------------
// 2. End-to-end: write -> persist -> validate with the CANONICAL validator ->
//    reload -> evidence survives the round trip (requirement 3).
// ---------------------------------------------------------------------------

// Validate a PERSISTED board file against the CANONICAL board schema, using the
// canonical validator. Deliberately the schema layer (validateSchema) and not
// validateBoard: validateBoard additionally cross-checks this checkout's live
// governance journal, plan records and locks, which have nothing to do with
// whether a persisted landing record's shape is legal and would make this test
// fail for unrelated environmental reasons. The schema layer is exactly the
// seam that was unguarded.
function validatePersistedBoard(boardPath) {
  const board = readJson(boardPath);
  const errors = [];
  boardTesting.validateSchema(readJson(TASKS_SCHEMA_PATH), board, "tasks.json", errors);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return board;
}

// A minimal board that satisfies the CANONICAL validator end to end. Using the
// live board here would drag in plan-record / lock cross-checks bound to this
// checkout's runtime state, which is unrelated to the seam under test and would
// make the test fail for reasons that are not schema disagreements. The ticket
// is `done` so no plan record is required; the landing_index entry is the
// subject.
function boardWithLanding(ticketId, landingRecord) {
  return {
    version: 1,
    metadata: {
      title: "COORD-635 landing round trip",
      last_updated: "2026-08-03",
      canonical_references: [],
      plan_markdown_render_statuses: ["doing", "review"],
    },
    sections: [{
      kind: "table",
      level: 2,
      heading: "Control plane",
      separator_before: false,
      columns: ["ID", "Repo", "Status", "Owner"],
      rows: [{ ID: ticketId, Repo: "X", Status: "done", Owner: "unassigned" }],
    }],
    prompt_index: {},
    pr_index: {},
    landing_index: landingRecord ? { [ticketId]: landingRecord } : {},
    review_findings: {},
    waiver_index: {},
    followup_exceptions: {},
  };
}

test("COORD-635 repair E2E: a control-plane landing record persists, validates against the canonical schema, and reloads intact", () => {
  const { workspace, coordDir, layout } = buildCoordRepo({ withRemote: true });
  const boardPath = path.join(workspace, "tasks.json");
  try {
    const landed = git(coordDir, "rev-parse", "HEAD");

    const ticketId = "COORD-635";
    const board = boardWithLanding(ticketId, null);

    // WRITE through the real writer.
    const record = ensureControlPlaneLandingRecord(
      ticketId, board, { Repo: "X" },
      { landed: `Merged to the control-plane integration branch as ${landed}`, layout }
    );
    assert.equal(record.control_plane_verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);

    // PERSIST.
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    // VALIDATE with the canonical validator — the step that was missing.
    assert.doesNotThrow(
      () => validatePersistedBoard(boardPath),
      "the persisted board must validate against coord/board/tasks.schema.json"
    );

    // RELOAD and confirm the evidence survived the round trip.
    const reloaded = readJson(boardPath).landing_index[ticketId];
    assert.ok(reloaded, "the landing record must survive persistence");
    assert.equal(reloaded.control_plane_verification, CONTROL_PLANE_VERIFICATION.REMOTE_ANCESTRY);
    assert.equal(reloaded.commit_sha, landed);
    assert.equal(reloaded.base_ref, "main");
    assert.equal(reloaded.method, "no_pr");
    assert.ok(reloaded.evidence.some((entry) => entry.includes(landed)));
    assert.deepEqual(reloaded, record, "the reloaded record must be byte-equivalent to what the writer produced");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 repair E2E: a local_only record (with its reason) also persists, validates and reloads", () => {
  // The reason field only appears on the local_only path, so the round trip
  // must be proven for it too — it is the field most likely to be forgotten.
  const { workspace, coordDir, layout } = buildCoordRepo({ withRemote: false });
  const boardPath = path.join(workspace, "tasks.json");
  try {
    const board = boardWithLanding("COORD-635", null);
    const record = ensureControlPlaneLandingRecord(
      "COORD-635", board, { Repo: "X" },
      { landed: `landed ${git(coordDir, "rev-parse", "HEAD")}`, layout }
    );
    assert.equal(record.control_plane_verification, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.equal(record.control_plane_verification_reason, CONTROL_PLANE_VERIFICATION_REASON.NO_REMOTE);

    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.doesNotThrow(() => validatePersistedBoard(boardPath));

    const reloaded = readJson(boardPath).landing_index["COORD-635"];
    assert.equal(reloaded.control_plane_verification, CONTROL_PLANE_VERIFICATION.LOCAL_ONLY);
    assert.equal(reloaded.control_plane_verification_reason, CONTROL_PLANE_VERIFICATION_REASON.NO_REMOTE);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2b. The SECOND latent defect, found by auditing every persisted write rather
//     than only the one that failed the land (requirement 2's real intent).
//
//     collectLandingAuditReport classifies Repo-X entries with
//     provenance:"control_plane". applyLandingAuditBackfill copies the report's
//     `provenance` into the RECORD's `provenance_status`, whose schema enum is
//     ["explicit","legacy","fulfilled_by","unknown"]. So a backfill over a board
//     containing any control-plane landing record would have written an illegal
//     value — a second land-time/validate-time failure, in a different verb.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// COORD-691 round 3, finding 1: the RECEIPT is part of the record, so it has to
// be validated as one.
//
// The parity test above derives TOP-LEVEL landing keys from the writer. It
// passed while `pre_closeout_push` carried four keys the schema forbade
// (`attempted`, `acknowledged`, `remote_moved`, `ack_lost`) under
// additionalProperties:false — canonical validation rejected every real
// receipt, and no test noticed, because nothing validated a real one. These
// tests write receipts through the REAL push path and validate the persisted
// board, so a field the pusher emits and the schema does not declare fails
// here rather than at a landing.
// ---------------------------------------------------------------------------

function unpushedCommit(coordDir) {
  write(path.join(coordDir, "docs", "note.md"), `unpushed ${Date.now()}\n`);
  git(coordDir, "add", "-A");
  git(coordDir, "commit", "--no-verify", "-m", "chore: unpushed control-plane landing");
  return git(coordDir, "rev-parse", "HEAD");
}

test("COORD-691: a REAL pushed receipt persists and validates against the canonical schema", () => {
  const { workspace, coordDir, layout } = buildCoordRepo({ withRemote: true });
  const boardPath = path.join(workspace, "tasks.json");
  try {
    const landed = unpushedCommit(coordDir);
    const ticketId = "COORD-691";
    const board = boardWithLanding(ticketId, null);

    const record = ensureControlPlaneLandingRecord(
      ticketId, board, { Repo: "X" },
      { landed: `landed ${landed}`, layout, pushBeforeCloseout: true }
    );

    const receipt = record.pre_closeout_push;
    assert.ok(receipt, "the fixture must actually have pushed, or this validates nothing");
    assert.equal(receipt.status, "pushed");
    // The keys the schema forbade. Named explicitly so the test fails loudly if
    // the pusher stops emitting them rather than silently validating less.
    for (const key of ["attempted", "acknowledged", "remote_moved"]) {
      assert.ok(key in receipt, `the receipt must carry ${key}`);
    }

    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.doesNotThrow(
      () => validatePersistedBoard(boardPath),
      "a real pushed receipt must validate against coord/board/tasks.schema.json"
    );
    assert.deepEqual(readJson(boardPath).landing_index[ticketId], record);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-691: a LOST-ACK receipt — the one carrying ack_lost — also validates", () => {
  const { workspace, coordDir, layout } = buildCoordRepo({ withRemote: true });
  const boardPath = path.join(workspace, "tasks.json");
  const { gitTry } = require("./git-ops.js");
  try {
    const landed = unpushedCommit(coordDir);
    const ticketId = "COORD-691";
    const board = boardWithLanding(ticketId, null);

    // The push runs; only the acknowledgement is lost.
    const gitFn = (repoRoot, args) => {
      const real = gitTry(repoRoot, args);
      return args[0] === "push"
        ? { status: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" }
        : real;
    };

    const record = ensureControlPlaneLandingRecord(
      ticketId, board, { Repo: "X" },
      { landed: `landed ${landed}`, layout, pushBeforeCloseout: true, gitFn }
    );

    const receipt = record.pre_closeout_push;
    assert.ok(receipt);
    assert.equal(receipt.ack_lost, true, "the fixture must produce the lost-ack shape");
    assert.equal(receipt.acknowledged, false);
    assert.equal(receipt.pushed, true);

    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.doesNotThrow(
      () => validatePersistedBoard(boardPath),
      "the lost-ack receipt must validate — it is the shape most likely to reach a real board under failure"
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("COORD-635 repair: the landing-record provenance vocabulary matches the schema enum", () => {
  const { LANDING_PROVENANCE_STATUSES } = require("./landing-audit-vocabulary.js");
  assert.deepEqual(
    [...LANDING_PROVENANCE_STATUSES].slice().sort(),
    landingEntrySchema().properties.provenance_status.enum.slice().sort(),
    "the landing-record provenance vocabulary drifted from the board schema enum"
  );
});

test("COORD-635 repair RED: backfill must NOT copy the report-only \"control_plane\" bucket into the record", () => {
  const { classifyControlPlaneLandingRecord: classify } = require("./control-plane-landing.js");
  const { LANDING_PROVENANCE_STATUSES } = require("./landing-audit-vocabulary.js");
  const noRepoLayout = { coordDir: "/nope/coord", coordRepoRoot: null, coordPathPrefix: null, topology: "none" };

  // The report bucket for a control-plane row is deliberately "control_plane"...
  const entry = classify("COORD-635", { Repo: "X" }, { evidence: ["landed"], method: "no_pr" }, { layout: noRepoLayout });
  assert.equal(entry.provenance, "control_plane");
  // ...and that value is NOT a legal record value. This is the assertion that
  // makes the two namespaces impossible to conflate again.
  assert.equal(
    LANDING_PROVENANCE_STATUSES.includes(entry.provenance), false,
    "a report-only bucket must never be a legal landing-record provenance_status"
  );
  assert.equal(landingEntrySchema().properties.provenance_status.enum.includes(entry.provenance), false);

  // And a record carrying it must be refused by the canonical schema, so the
  // guard is backed by the validator rather than by convention alone.
  const boardPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-schema-prov-")), "tasks.json");
  try {
    const board = boardWithLanding("COORD-635", {
      recorded_at: new Date().toISOString(),
      method: "no_pr",
      evidence: ["landed"],
      provenance_status: "control_plane",
    });
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(() => validatePersistedBoard(boardPath), /provenance_status must be one of/);
  } finally {
    fs.rmSync(path.dirname(boardPath), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Negative proof: compatibility was NOT bought by loosening the schema
//    (requirement 4).
// ---------------------------------------------------------------------------

test("COORD-635 repair RED: an unrelated unknown key is STILL rejected — the schema was not loosened", () => {
  const boardPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cp-schema-neg-")), "tasks.json");
  try {
    const board = boardWithLanding("COORD-635", null);
    board.landing_index["COORD-635"] = {
      recorded_at: new Date().toISOString(),
      base_ref: "main",
      method: "no_pr",
      provenance_status: "explicit",
      control_plane_verification: "local_only",
      evidence: ["landed"],
      // Not declared anywhere. additionalProperties:false must still bite.
      totally_made_up_key: "should be rejected",
    };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () => validatePersistedBoard(boardPath),
      /has unexpected key "totally_made_up_key"/,
      "additionalProperties:false must still reject unknown keys — the repair must not buy compatibility by loosening the schema"
    );

    // And the enum is a real constraint, not decoration.
    board.landing_index["COORD-635"] = {
      recorded_at: new Date().toISOString(),
      method: "no_pr",
      evidence: ["landed"],
      control_plane_verification: "definitely_not_a_valid_class",
    };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(
      () => validatePersistedBoard(boardPath),
      /control_plane_verification must be one of: remote_ancestry, local_only/
    );

    // Likewise the reason vocabulary.
    board.landing_index["COORD-635"] = {
      recorded_at: new Date().toISOString(),
      method: "no_pr",
      evidence: ["landed"],
      control_plane_verification: "local_only",
      control_plane_verification_reason: "made_up_reason",
    };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    assert.throws(() => validatePersistedBoard(boardPath), /control_plane_verification_reason must be one of/);
  } finally {
    fs.rmSync(path.dirname(boardPath), { recursive: true, force: true });
  }
});

test("COORD-635 repair RED: the parity test itself fails when the schema is missing a writer key", () => {
  // The guard must be seen to fail, or it is not evidence. Simulate the exact
  // defect: a schema whose properties omit control_plane_verification.
  const declared = new Set(Object.keys(landingEntrySchema().properties));
  declared.delete("control_plane_verification");
  const emitted = staticallyEmittedLandingKeys();
  const undeclared = [...emitted].filter((key) => !declared.has(key));
  assert.deepEqual(
    undeclared, ["control_plane_verification"],
    "with the schema entry removed the parity check must report exactly that key"
  );
});
