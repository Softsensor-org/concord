"use strict";


const { state: governanceState } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
const createGovernanceSession = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-session.js"));
// COORD-224: concurrent-agent burn-in — the acceptance PROOF that the sealed
// single-writer board protocol holds at the 10–20 concurrent-agent target.
//
// The protocol pieces are built and individually tested:
//   - COORD-220  withBoardTransaction / reserveTicketId (id reservation UNDER the
//                governance runtime lock) + the fail-closed out-of-band seal,
//   - COORD-221  gov file-ticket governed creator,
//   - COORD-222  the co-located-session guard (refuses a 2nd fresh writer on one
//                runtime; --allow-shared-worktree override),
//   - COORD-223  nested-lock order + idempotency + audited collision events,
//   - COORD-246  post-sync provenance baseline (the seal is self-baselining).
//
// This test exercises those REAL seams under GENUINE cross-process contention in
// an ISOLATED sandbox runtime (its own .runtime + board — NEVER the live coord
// board/journal) and asserts the five protocol guarantees:
//
//   1. ZERO duplicate ticket IDs            — reserveTicketId-under-lock
//   2. ZERO hash-chain breaks               — verifyGovernanceChain PASS (the
//                                             original COORD-115/123 failure mode)
//   3. ZERO lost/clobbered board rows       — no last-writer-wins clobber
//   4. every mutation journaled EXACTLY once — no dup/missing events (COORD-223)
//   5. out-of-band edits REJECTED           — the seal fails closed (COORD-220/246)
//
// It covers BOTH guard postures:
//   (a) override-forced concurrency — N concurrent governed mutators against ONE
//       shared runtime → guarantees 1–4 hold under real contention,
//   (b) guard-refuses — WITHOUT the override, a concurrent co-located fresh agent
//       is REFUSED by the COORD-222 guard (the first line of defense).
//
// CI-RELIABILITY: the assertions are on the deterministic INVARIANTS (distinct id
// set, chain PASS, all rows present, exactly-once events), which hold regardless
// of how the OS schedules the N processes. Scheduling varies run-to-run; the
// invariants do not. The genuine cross-process mutex is the mkdir-based
// governance-runtime lock, which every worker shares because they all bind the
// SAME GOVERNANCE_EVENT_LOCK_DIR. N is bounded (default 12) so the burn-in is a
// few seconds, not a stress soak.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

const {
  __testing,
  GovernanceError,
  withScopedGovernanceTestContext,
} = require("./governance-test-utils.js");

const WORKER_PATH = path.join(__dirname, "../engine/scripts/concurrent-burnin-worker.js");
const PREFIX = "BURN";

// Number of governed mutators in the burn-in. The ticket target is 10–20; 12
// sits in that band.
const N = Number(process.env.COORD_BURNIN_N || 12);

// Max workers IN FLIGHT at once. Genuine cross-process contention on the shared
// runtime lock needs only ≥2 simultaneous contenders; capping the in-flight pool
// (default 4) proves serialization just as rigorously while keeping the burn-in a
// GOOD CITIZEN inside the full parallel `node --test` suite — an unbounded fan-out
// of N heavy node processes oversubscribes CPU and starves other files' real-
// runtime lock acquisitions (a self-inflicted flake). All N reservations still
// run; only the simultaneity is bounded. Override with COORD_BURNIN_CONCURRENCY.
const CONCURRENCY = Math.max(2, Number(process.env.COORD_BURNIN_CONCURRENCY || 4));

const colocatedSessionOwner = createGovernanceSession({
  AGENT_SESSION_IDLE_MS: 15 * 60 * 1000,
  state: { BOARD_PATH: governanceState.BOARD_PATH },
});

// --- sandbox plumbing -------------------------------------------------------

// Build a throwaway sandbox coord runtime + board on disk and return the path
// config a worker (and this parent) bind to. NOTHING here touches the live
// coord board/journal: every path is under os.tmpdir().
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord224-burnin-"));
  const runtimeDir = path.join(root, ".runtime");
  const locksDir = path.join(runtimeDir, "locks");
  const planRecordsDir = path.join(runtimeDir, "plans");
  const snapshotsDir = path.join(runtimeDir, "governance-snapshots");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(planRecordsDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const cfg = {
    prefix: PREFIX,
    boardPath: path.join(root, "tasks.json"),
    planPath: path.join(root, "PLAN.md"),
    questionsPath: path.join(root, "QUESTIONS.md"),
    agentsPath: path.join(root, "agents.json"),
    sessionsPath: path.join(runtimeDir, "agent_sessions.json"),
    planRecordsDir,
    locksDir,
    legacyLocksDir: path.join(root, "locks"),
    runtimeDir,
    eventLogPath: path.join(runtimeDir, "governance-events.ndjson"),
    snapshotPath: path.join(runtimeDir, "governance-latest-snapshot.json"),
    snapshotsDir,
    eventLockDir: path.join(runtimeDir, "governance.lock"),
    // COORD-300: the two coarse directory locks default to ABSOLUTE paths under the
    // LIVE coord/ tree (independent of RUNTIME_DIR), so without binding them every
    // governed mutation here acquired coord/.coord-state.lock + .agent-state.lock on
    // the live tree. Point them at the SHARED sandbox root so the N workers still
    // contend on ONE real cross-process mutex — just a sandboxed one, not the live lock.
    coordStateLockDir: path.join(root, ".coord-state.lock"),
    agentStateLockDir: path.join(root, ".agent-state.lock"),
  };

  const board = {
    version: 1,
    metadata: { title: "COORD-224 burn-in sandbox board", preamble: [] },
    sections: [
      {
        kind: "table",
        level: 3,
        heading: "Burn-in",
        separator_before: false,
        columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
        rows: [
          { ID: `${PREFIX}-001`, Repo: "X", Type: "chore", Pri: "P2", Status: "todo", Owner: "unassigned", Description: "seed", "Depends On": "" },
        ],
      },
    ],
    prompt_index: {},
    pr_index: {},
    landing_index: {},
    review_findings: {},
    followup_exceptions: {},
  };
  fs.writeFileSync(cfg.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  fs.writeFileSync(cfg.planPath, "plan\n", "utf8");
  fs.writeFileSync(cfg.questionsPath, "# Questions\n", "utf8");
  fs.writeFileSync(cfg.agentsPath, "[]\n", "utf8");
  fs.writeFileSync(cfg.sessionsPath, "[]\n", "utf8");

  return { root, cfg };
}

// Bind THIS process's governance path seam at the sandbox so we can seed the
// journal baseline and read back the result with the same module the workers use.
function withSandboxPaths(cfg, fn) {
  const keys = {
    BOARD_PATH: cfg.boardPath,
    PLAN_PATH: cfg.planPath,
    QUESTIONS_PATH: cfg.questionsPath,
    AGENTS_PATH: cfg.agentsPath,
    AGENT_SESSIONS_PATH: cfg.sessionsPath,
    PLAN_RECORDS_DIR: cfg.planRecordsDir,
    LOCKS_DIR: cfg.locksDir,
    LEGACY_LOCKS_DIR: cfg.legacyLocksDir,
    RUNTIME_DIR: cfg.runtimeDir,
    GOVERNANCE_EVENT_LOG_PATH: cfg.eventLogPath,
    GOVERNANCE_SNAPSHOT_PATH: cfg.snapshotPath,
    GOVERNANCE_SNAPSHOTS_DIR: cfg.snapshotsDir,
    GOVERNANCE_EVENT_LOCK_DIR: cfg.eventLockDir,
    COORD_STATE_LOCK_DIR: cfg.coordStateLockDir,
    AGENT_STATE_LOCK_DIR: cfg.agentStateLockDir,
  };
  return withScopedGovernanceTestContext(keys, fn);
}

// Seed a journal baseline + snapshot so the journal is initialized (an
// uninitialized journal intentionally skips the bypass seal). After this the
// latest snapshot matches the sandbox surface, so a clean governed mutation has
// zero out-of-band drift at entry — exactly the real-runtime steady state.
function seedJournalBaseline(cfg) {
  withSandboxPaths(cfg, () => {
    __testing.appendGovernanceEvent({
      ts: "2026-06-24T00:00:00.000Z",
      command: "journal-baseline",
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      details: { reason: "coord224-burnin" },
      changed_paths: [],
      snapshot: __testing.buildGovernanceSnapshot(),
    });
  });
}

// Spawn one worker child bound to the shared sandbox. Resolves with the parsed
// worker result ({ ok, id, ... }). The worker uses real OS-process concurrency.
function spawnWorker(cfg, workerIndex, extra = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...cfg, workerIndex, ...extra });
    const child = fork(WORKER_PATH, options.omitConfig ? [] : [payload], {
      execArgv: options.execArgv || [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let out = "";
    let err = "";
    let message = null;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("message", (m) => { message = m; });
    child.on("error", reject);
    child.on("close", (code) => {
      let parsed = message && typeof message === "object" ? message : null;
      try { parsed = JSON.parse(out); } catch { /* fall through */ }
      if (!parsed) {
        reject(new Error(`worker ${workerIndex} produced no parseable result (exit ${code}); stderr:\n${err}`));
        return;
      }
      parsed.exitCode = code;
      resolve(parsed);
    });
  });
}

// Run `total` workers through a bounded in-flight POOL of `limit`. At any instant
// up to `limit` workers race for the shared runtime lock — genuine concurrent
// contention — but the suite never sees more than `limit` heavy node processes
// from this test at once. Returns results in completion order (the burn-in
// asserts on sets/counts, so order is irrelevant).
async function runWorkerPool(cfg, total, limit, extra = {}) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      if (i >= total) return;
      next += 1;
      results.push(await spawnWorker(cfg, i, extra));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));
  return results;
}

function readBoardRows(cfg) {
  const board = JSON.parse(fs.readFileSync(cfg.boardPath, "utf8"));
  return board.sections[0].rows;
}

function readJournalEvents(cfg) {
  return fs
    .readFileSync(cfg.eventLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- (a) override-forced concurrency: N concurrent mutators, one runtime -----

test("COORD-224: N concurrent governed mutators against one runtime hold all four lower-protection invariants", async () => {
  const { root, cfg } = makeSandbox();
  try {
    seedJournalBaseline(cfg);

    // Genuine cross-process concurrency: run N workers through a bounded pool so
    // up to CONCURRENCY of them race for the shared governance-runtime lock at
    // once. Real contention (≥2 simultaneous contenders) exercises the mkdir
    // mutex; all N reservations still happen.
    const results = await runWorkerPool(cfg, N, CONCURRENCY);

    // Every worker's governed create must have SUCCEEDED — the runtime lock
    // serializes them; none should have to fail.
    const failures = results.filter((r) => !r.ok);
    assert.equal(
      failures.length,
      0,
      `all ${N} governed creates must succeed; failures:\n${JSON.stringify(failures, null, 2)}`
    );

    const ids = results.map((r) => r.id);

    // INVARIANT 1: ZERO duplicate ticket IDs. Every concurrent reservation got a
    // distinct id — this is the reserveTicketId-under-lock guarantee.
    assert.equal(
      new Set(ids).size,
      N,
      `expected ${N} DISTINCT reserved ids, got duplicates in: ${ids.join(", ")}`
    );

    // INVARIANT 3: ZERO lost/clobbered board rows. Every successful create's row
    // is present on the final board (no last-writer-wins clobber of a sibling's
    // concurrent write). Seed row + N created rows.
    const rows = readBoardRows(cfg);
    const rowIds = rows.map((r) => r.ID);
    assert.ok(rowIds.includes(`${PREFIX}-001`), "seed row must survive");
    for (const id of ids) {
      assert.ok(rowIds.includes(id), `created row ${id} must be present (not clobbered)`);
    }
    assert.equal(rows.length, N + 1, "board must hold the seed row + every created row, with no losses");

    // INVARIANT 2: ZERO hash-chain breaks. The journal the concurrent appends
    // produced must verify end-to-end — proving the runtime lock serialized the
    // appends (the original COORD-115/123 chain-corruption failure mode).
    const events = readJournalEvents(cfg);
    const chain = withSandboxPaths(cfg, () => __testing.verifyGovernanceChain(events));
    assert.equal(chain.ok, true, `hash-chain conformance must PASS; report: ${JSON.stringify(chain)}`);

    // INVARIANT 4: every successful mutation journaled EXACTLY once. Count the
    // burnin-create success events: exactly N, one per worker, no dups/misses.
    const createEvents = events.filter(
      (e) => e.command === "burnin-create" && e.result === "succeeded"
    );
    assert.equal(
      createEvents.length,
      N,
      `expected exactly ${N} journaled burnin-create events (one per mutation), got ${createEvents.length}`
    );
    // And every reserved id appears in exactly one journaled event.
    for (const id of ids) {
      const matches = createEvents.filter((e) => e.ticket === id);
      assert.equal(matches.length, 1, `ticket ${id} must be journaled exactly once, saw ${matches.length}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- (a') the seal: an out-of-band edit injected mid-burn-in is REJECTED ------

test("COORD-224: an out-of-band board edit injected into the burn-in runtime is REJECTED (seal fails closed)", async () => {
  const { root, cfg } = makeSandbox();
  try {
    seedJournalBaseline(cfg);

    // First, a clean governed create succeeds (establishes a real steady state).
    const first = await spawnWorker(cfg, 0);
    assert.equal(first.ok, true, "the first governed create must succeed");

    // Now simulate a rogue agent hand-editing the board OUTSIDE any governed
    // transaction (the COORD-115/123 hazard, and the very bypass the seal exists
    // to stop) — a direct write with no journaled transaction.
    const board = JSON.parse(fs.readFileSync(cfg.boardPath, "utf8"));
    board.sections[0].rows.push({
      ID: `${PREFIX}-999`, Repo: "X", Type: "chore", Pri: "P2",
      Status: "todo", Owner: "unassigned", Description: "rogue hand edit", "Depends On": "",
    });
    fs.writeFileSync(cfg.boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

    // INVARIANT 5: the NEXT governed mutation must FAIL CLOSED on top of the
    // out-of-band edit — the worker reports a governance refusal, not a success.
    const second = await spawnWorker(cfg, 1);
    assert.equal(second.ok, false, "a governed mutation on top of an out-of-band edit must be refused");
    assert.equal(second.refusal, true, "the refusal must be a GovernanceError (the seal), not a crash");
    assert.match(
      second.error,
      /out-of-band coordination-state change/,
      `expected the COORD-220/246 seal message, got: ${second.error}`
    );

    // The chain is still intact (the seal refuses BEFORE appending), so the
    // protocol degraded safely rather than corrupting the journal.
    const chain = withSandboxPaths(cfg, () =>
      __testing.verifyGovernanceChain(readJournalEvents(cfg))
    );
    assert.equal(chain.ok, true, "the journal chain must remain intact after a refused bypass");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- (b) guard-refuses: WITHOUT the override the 2nd co-located writer is denied

test("COORD-224: WITHOUT --allow-shared-worktree the co-located-session guard REFUSES a 2nd fresh writer (first line of defense)", () => {
  // The COORD-222 guard is the FIRST line: two fresh governed writers bound to
  // one runtime on different threads are refused by default. The lower
  // protections proven above (runtime-lock serialization, id reservation, chain
  // integrity) are the SAFETY NET if the guard is deliberately overridden. Here
  // we assert the guard itself, deterministically, with no timing dependence.
  const now = Date.now();
  const sessions = [
    // A heartbeat-FRESH foreign governed session already bound to this runtime,
    // on a DIFFERENT thread than the caller.
    {
      session_id: "foreign-1",
      handle: "claudeb01",
      thread_id: "thread-foreign",
      board_path: governanceState.BOARD_PATH,
      status: "active",
      last_seen_at: new Date(now).toISOString(),
      heartbeat_utc: new Date(now).toISOString(),
    },
  ];

  const detection = colocatedSessionOwner.detectColocatedForeignSessions({
    sessions,
    currentThreadId: "thread-mine",
    now,
    idleMs: 15 * 60 * 1000,
  });

  // The guard MUST see the co-located foreign writer.
  assert.equal(detection.present, true, "the guard must detect a co-located fresh foreign writer");
  assert.equal(detection.foreign_sessions.length, 1);
  assert.equal(detection.foreign_sessions[0].thread_id, "thread-foreign");

  // And the refusal message names the runtime-sharing hazard and the explicit
  // override (--allow-shared-worktree) the burn-in's override path uses.
  const message = colocatedSessionOwner.buildColocatedForeignSessionMessage("start", detection);
  assert.match(message, /Refusing start/);
  assert.match(message, /hash-chained journal/);
  assert.match(message, /--allow-shared-worktree/);

  // Symmetry: the caller's OWN session (same thread) is never a co-located
  // conflict — a lone writer / resume must not false-block.
  const lone = colocatedSessionOwner.detectColocatedForeignSessions({
    sessions: [{ ...sessions[0], thread_id: "thread-mine" }],
    currentThreadId: "thread-mine",
    now,
    idleMs: 15 * 60 * 1000,
  });
  assert.equal(lone.present, false, "the caller's own session must never be a co-located conflict");
});

// --- guard rationale guard: GovernanceError is the refusal type --------------

test("COORD-224: the burn-in proves the protocol via real seams, not mocks (GovernanceError is the refusal class)", () => {
  assert.equal(typeof GovernanceError, "function");
  assert.equal(typeof __testing.withBoardTransaction, "function");
  assert.equal(typeof __testing.verifyGovernanceChain, "function");
});

// --- COORD-711: documentation-conformance guard ------------------------------
//
// The operator-facing docs used to assert that two governed agents sharing one
// checkout/runtime "will interleave writes to the hash-chained journal and
// corrupt the chain", and directed `repair-chain` after concurrent use. The
// burn-in above disproves that: withGovernanceMutation takes the mkdir runtime
// mutex first (coord/engine/scripts/journal.js:1917 -> governance-context.js:1851-1876), so governed
// mutations queue rather than interleave.
//
// The docs must not drift back — in EITHER direction. Over-claiming ("shared
// runtime is safe", "the override makes it atomic") is just as wrong as the old
// corruption claim, because the burn-in exercises exactly ONE
// withBoardTransaction ticket-create shape against LOCAL governed files, and
// says nothing about leases, the wider lifecycle, Git working files, or
// irreversible external effects.
//
// These assertions are on the DOC TEXT, so a future edit that contradicts the
// executable contract fails the same gate that runs the contract.

const TOPOLOGIES_DOC = path.join(__dirname, "..", "engine", "docs", "MULTI_AGENT_TOPOLOGIES.md");
const BURNIN_DOC = path.join(__dirname, "..", "engine", "docs", "MULTI_AGENT_BURNIN_RUNBOOK.md");

function readDoc(docPath) {
  assert.ok(fs.existsSync(docPath), `${docPath} must exist`);
  return fs.readFileSync(docPath, "utf8");
}

test("COORD-711: the topology guide no longer makes the disproved will-corrupt / repair-after-concurrency claims", () => {
  const doc = readDoc(TOPOLOGIES_DOC);

  // (a) the absolute corruption claims are gone.
  for (const forbidden of [
    /will interleave\s+writes to the hash-chained journal/i,
    /corrupt the chain/i,
    /corrupt the journal/i,
  ]) {
    assert.ok(
      !forbidden.test(doc),
      `MULTI_AGENT_TOPOLOGIES.md must not claim concurrent governed writers corrupt the journal ` +
      `(the mkdir runtime mutex serializes them; see the burn-in above). Offending pattern: ${forbidden}`
    );
  }

  // ...and repair-chain is not prescribed as the routine cure for concurrency.
  assert.ok(
    !/If the chain is crossed/i.test(doc),
    "MULTI_AGENT_TOPOLOGIES.md must not direct repair-chain as the follow-up to concurrent use"
  );
  assert.match(
    doc,
    /repair-chain[\s\S]{0,200}break-glass/i,
    "repair-chain must be described as a break-glass path, not routine post-concurrency cleanup"
  );

  // ...and the correction must not flip into a blanket safety claim.
  for (const overclaim of [
    /shared (runtime|worktree|checkout) is (generally )?safe/i,
    /safe to share (one|a) (runtime|worktree|checkout)/i,
    /fully atomic/i,
  ]) {
    assert.ok(
      !overclaim.test(doc),
      `MULTI_AGENT_TOPOLOGIES.md must not over-claim shared-runtime safety. Offending pattern: ${overclaim}`
    );
  }
});

test("COORD-711: the topology guide states exactly the five invariants the burn-in proves, and their one mutation shape", () => {
  const doc = readDoc(TOPOLOGIES_DOC);

  // (b) the five invariants, in the same terms the assertions above use.
  for (const invariant of [
    /duplicate ticket IDs/i,
    /hash-chain breaks/i,
    /lost or clobbered board rows/i,
    /journaled exactly once/i,
    /[Oo]ut-of-band edits rejected/,
  ]) {
    assert.match(doc, invariant, `the five COORD-224 invariants must be stated; missing: ${invariant}`);
  }

  // ...named as the ONE mutation shape the workers actually run.
  assert.match(
    doc,
    /one `withBoardTransaction` ticket-create shape/,
    "the guide must say the burn-in workers perform one withBoardTransaction ticket-create shape"
  );
  assert.match(
    doc,
    /concurrent-burnin-worker\.js/,
    "the guide must cite the worker that defines that shape"
  );
});

test("COORD-711: the topology guide separates serializable local mutations from Git and external effects", () => {
  const doc = readDoc(TOPOLOGIES_DOC);

  // (c) the three-way distinction, each anchored to the code that settles it.
  assert.match(doc, /journal\.js:1917/, "must cite withGovernanceMutation");
  assert.match(doc, /governance-context\.js:1851-1876/, "must cite the mkdir runtime mutex");
  assert.match(doc, /journal\.js:94-133/, "must cite the governed-file restore-point set");
  assert.match(doc, /journal\.js:2064-2105/, "must cite the external-side-effect survival path");
  assert.match(
    doc,
    /Git working state and\s+external effects are not/,
    "must state that Git working state and external effects are NOT serialized"
  );

  // (f) and must never imply the override buys lifecycle atomicity.
  assert.match(
    doc,
    /No override makes the full lifecycle atomic/,
    "the guide must explicitly deny that any override makes the full lifecycle atomic"
  );

  // (d) default posture and the separate-worktree recommendation stay put.
  assert.match(doc, /--allow-shared-worktree/, "the override must still be named");
  assert.match(doc, /fail closed/i, "the default guard posture must remain documented as fail-closed");
  assert.match(doc, /own `coord\/\.runtime`/, "the separate-runtime recommendation must remain");

  // (e) the three known boundaries are linked.
  for (const ticket of ["COORD-689", "COORD-698", "COORD-702"]) {
    assert.match(doc, new RegExp(ticket), `${ticket} must be linked as a known boundary`);
  }
});

test("COORD-711: the burn-in runbook scopes its proof to the one ticket-create shape and links the boundaries", () => {
  const doc = readDoc(BURNIN_DOC);
  assert.match(
    doc,
    /exactly one `withBoardTransaction` ticket-create shape/,
    "the runbook must name the single mutation shape its workers run"
  );
  assert.match(doc, /What it does NOT prove/, "the runbook must carry an explicit out-of-scope section");
  assert.match(doc, /journal\.js:94-133/, "the runbook must cite the governed-file restore-point set");
  assert.match(doc, /journal\.js:2064-2105/, "the runbook must cite the external-side-effect survival path");
  for (const ticket of ["COORD-689", "COORD-698", "COORD-702"]) {
    assert.match(doc, new RegExp(ticket), `${ticket} must be linked as a known boundary`);
  }
});

test("COORD-711: the co-located guard and doctor advisory no longer claim journal interleaving", () => {
  const guardSource = fs.readFileSync(path.join(__dirname, "../engine/scripts/governance-session.js"), "utf8");
  const doctorSource = fs.readFileSync(path.join(__dirname, "../engine/scripts/doctor-report.js"), "utf8");

  assert.ok(
    !/can interleave writes to the hash-chained journal/.test(doctorSource),
    "gov doctor must not tell operators that co-located writers interleave journal writes"
  );
  // Both surfaces must point at the section that carries the reconciled contract,
  // by NAME (a line number silently rots as the doc grows).
  for (const [name, source] of [["../engine/scripts/governance-session.js", guardSource], ["../engine/scripts/doctor-report.js", doctorSource]]) {
    assert.ok(
      !/MULTI_AGENT_TOPOLOGIES\.md:\d+/.test(source),
      `${name} must not reference the topology guide by line number (it rots); use the section name`
    );
    assert.match(
      source,
      /MULTI_AGENT_TOPOLOGIES\.md § "Concurrency contract"/,
      `${name} must point at the reconciled concurrency-contract section`
    );
  }

  // The section it points at must actually exist.
  assert.match(
    readDoc(TOPOLOGIES_DOC),
    /^## Concurrency contract/m,
    "the section the guard cites must exist in the topology guide"
  );

  // `repair-chain` help must not name concurrent governed mutation as a cause of
  // a crossed chain — the runtime mutex is exactly what prevents that.
  const helpSource = fs.readFileSync(path.join(__dirname, "../engine/scripts/lifecycle-help.js"), "utf8");
  assert.ok(
    !/two governed agents appending concurrently/.test(helpSource),
    "repair-chain help must not blame concurrent governed appends for a crossed hash-chain"
  );
});


test("COORD-825: burn-in worker defaults, refusal and empty-error protocol survive real child exits", async () => {
  const { root, cfg } = makeSandbox();
  try {
    seedJournalBaseline(cfg);

    // With no argv payload, main parses its documented empty-object default.
    // The missing path configuration must fail closed and return a parseable
    // child result instead of escaping as an unhandled process error.
    const defaultConfig = await spawnWorker({}, undefined, {}, { omitConfig: true });
    assert.equal(defaultConfig.ok, false);
    assert.equal(defaultConfig.refusal, false);
    assert.equal(defaultConfig.exitCode, 1);
    assert.ok(defaultConfig.error, "the child reports the ordinary configuration error");

    // Invalid prefixes fail through the real governance refusal path. This
    // proves the worker preserves the typed refusal and distinct exit status.
    const refusal = await spawnWorker(cfg, 1, { prefix: "!!!" });
    assert.equal(refusal.ok, false);
    assert.equal(refusal.refusal, true);
    assert.equal(refusal.exitCode, 2);
    assert.match(refusal.error, /letters-only --prefix/);

    // An empty-message Error takes the worker's String(error) protocol fallback.
    // Patch only this subprocess's transaction seam; no production export or
    // parent-process state is changed.
    const preloadPath = path.join(root, "empty-worker-error-preload.js");
    fs.writeFileSync(preloadPath, `
      const Module = require("node:module");
      const load = Module._load;
      Module._load = function (request, parent, isMain) {
        const loaded = load.call(this, request, parent, isMain);
        if (/(^\\.|[\\\\/]scripts)[\\\\/]governance\\.js$/.test(request) && parent && parent.filename === ${JSON.stringify(WORKER_PATH)}) {
          loaded.__testing.withBoardTransaction = () => { throw new Error(""); };
        }
        return loaded;
      };
    `);
    const emptyError = await spawnWorker(cfg, 2, {}, { execArgv: ["--require", preloadPath] });
    assert.equal(emptyError.ok, false);
    assert.equal(emptyError.refusal, false);
    assert.equal(emptyError.error, "Error");
    assert.equal(emptyError.exitCode, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
