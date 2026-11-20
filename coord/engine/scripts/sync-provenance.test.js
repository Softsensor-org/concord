"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createSyncProvenanceImpl = require("./sync-provenance.js");
const attemptCoordination = require("./attempt-coordination.js");
// These factory-level tests exercise sync policy and Git path scoping without
// an integration CLI executor. Keep that seam explicit; guarded CLI coverage
// belongs to integration-authority.test.js.
const createSyncProvenance = (deps = {}) => createSyncProvenanceImpl({
  withActiveCommandFence: (_command, run) => run(),
  ...deps,
});
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const lifecycleModule = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle.js"));
const cliModule = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/cli.js"));
const { gitTry: realGitTry } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/git-ops.js"));

const { gitFixture } = require("./test-git-fixture.js");

function git(cwd, args) {
  return gitFixture(cwd, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo, message) {
  fs.appendFileSync(path.join(repo, "history.txt"), `${message}\n`);
  git(repo, ["add", "history.txt"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function makePublicationWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-696-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  fs.mkdirSync(remote);
  fs.mkdirSync(local);
  gitFixture(remote, ["init", "--bare", "--initial-branch=main"]);
  gitFixture(local, ["init", "--initial-branch=main"]);
  git(local, ["remote", "add", "origin", remote]);
  const base = commit(local, "base");
  git(local, ["push", "--set-upstream", "origin", "main:main"]);
  return { root, remote, local, base };
}

// COORD-292: behavior tests for the sync / provenance-baseline service extracted
// from lifecycle.js into sync-provenance.js (lifecycle decomposition slice #1,
// per the COORD-291 boundary contract). The behavior tests below were relocated
// from lifecycle.test.js to co-locate the coverage with the module that now owns
// it. COORD-297 (final decomposition slice) then made that ownership real: the
// behaviors below construct the extracted factory DIRECTLY (`createSyncProvenance`)
// and inject `syncFn`/`pushFn` per call, so they no longer reach through the
// lifecycle `__testing` facade — which let COORD-297 drop the now-redundant
// `runSyncCommand`/`autoSyncAfterLifecycle`/`pushOnFinalizeEnabled`/
// `pushAfterLifecycleSync`/`buildAutoSyncMessage` re-exports from that facade.
// The DI-wiring guard and the COORD-275 wrapper-level scope invariant exercise
// the extracted factory directly too.

// Factory-direct service for the pure / injected-fn behaviors below. Every test
// here passes its own syncFn/pushFn (or exercises a pure formatter); the only
// wired deps the autoSync path touches are the COORD-275 scope derivation
// (`canonicalSyncablePaths` + board path) and the post-sync baseline advance,
// which are stubbed here as benign no-ops — these behaviors assert on the
// captured syncFn/pushFn opts, not on scope/baseline side effects (those are
// covered by the COORD-275 scope-invariant tests below, which build their own
// fully-specified service). This is exactly the module-owned contract.
const syncSvc = createSyncProvenance({
  canonicalSyncablePaths: () => [],
  COORD_DIR: "/repo/coord",
  DEFAULT_PATHS: { boardPath: "/repo/coord/board/tasks.json" },
  advanceGovernanceProvenanceBaseline: () => true,
});

// --- DI wiring guard: factory shape + lifecycle composition-root wiring --------

test("COORD-1047: sync provenance resolves canonical fence providers and rejects invalid overrides", () => {
  assert.doesNotThrow(() => createSyncProvenance({}), "the factory resolves canonical fence providers");
  assert.throws(
    () => createSyncProvenance({ decisionFenceForTicket: null }),
    /governance_factory_dependency_missing|decisionFenceForTicket/,
  );
});

test("COORD-292/696/911 wiring: createSyncProvenance returns exactly the ten public functions", () => {
  const svc = createSyncProvenance({});
  const expected = [
    "runSyncCommand",
    "commitCanonicalDelta",
    "buildAutoSyncMessage",
    "pushOnFinalizeEnabled",
    "pushAfterLifecycleSync",
    "lifecycleSyncScopePaths",
    "advanceProvenanceBaselineAfterLifecycle",
    "autoSyncAfterLifecycle",
    "assessCanonicalPublication",
    "publishBoardState",
  ];
  assert.deepEqual(Object.keys(svc).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof svc[name], "function", `${name} must be a function`);
  }
});

test("COORD-292/297 wiring: lifecycle.js dispatches the sync verbs via commands; the facade keeps only the cross-module-shared re-export", () => {
  // The dispatchable sync verbs stay wired in the composition-root `commands`
  // map (the public dispatch surface) — unchanged by COORD-297.
  for (const name of [
    "runSyncCommand",
    "autoSyncAfterLifecycle",
    "pushOnFinalizeEnabled",
    "pushAfterLifecycleSync",
  ]) {
    assert.equal(typeof lifecycleModule.commands[name], "function", `lifecycle commands[${name}] resolves`);
  }
  // COORD-297: the sync service's behaviors are now owned by this test via the
  // factory directly, so lifecycle's `__testing` facade no longer re-exports
  // them. The ONLY sync internal still surfaced through the facade is
  // `commitCanonicalDelta` — depended on by cross-module facade tests
  // (governance.test.js + state-io.test.js), so it is conservatively kept.
  // Use BRACKET access so the COORD-280 auto-derived facade scanner (dot-form
  // `__testing.<name>` only) does not mistake these for required keys.
  assert.equal(
    typeof lifecycleModule.__testing["commitCanonicalDelta"],
    "function",
    "lifecycle __testing[commitCanonicalDelta] is conservatively kept (cross-module facade dependency)"
  );
  for (const removed of [
    "runSyncCommand",
    "buildAutoSyncMessage",
    "pushOnFinalizeEnabled",
    "pushAfterLifecycleSync",
    "autoSyncAfterLifecycle",
  ]) {
    assert.equal(
      lifecycleModule.__testing[removed],
      undefined,
      `COORD-297: lifecycle __testing[${removed}] is dropped (behavior owned by this module test)`
    );
  }
});

// --- COORD-275 scope invariant, proven through the extracted wrappers ----------
// The deep journal-level absorb/preserve behavior is covered in journal.test.js
// (the injected `advanceGovernanceProvenanceBaseline` seam). Here we prove the
// EXTRACTED lifecycle wrappers (a) derive the exact authorized derived-path scope
// — canonical synced artifacts PLUS the board json, nothing wider — and (b)
// forward that scope unchanged to the injected scope-checked advance, so an
// out-of-scope concurrent edit is never absorbed (preserved as drift) while the
// in-scope mutation output IS absorbed.

test("COORD-275/246: lifecycleSyncScopePaths derives canonical synced artifacts + the board json, and never a wider set", () => {
  const canonical = ["plans/x.json", "rendered/TASKS.md", "QUESTIONS.md"];
  const svc = createSyncProvenance({
    canonicalSyncablePaths: () => canonical.slice(),
    COORD_DIR: "/repo/coord",
    DEFAULT_PATHS: { boardPath: "/repo/coord/board/tasks.json" },
  });
  const scope = svc.lifecycleSyncScopePaths();
  assert.ok(scope.includes("board/tasks.json"), "board json must join the terminal-boundary scope");
  for (const p of canonical) {
    assert.ok(scope.includes(p), `canonical synced path ${p} must be in scope`);
  }
  // Exactly the canonical set + the single board json — no ambient widening.
  assert.equal(scope.length, canonical.length + 1);
  assert.ok(!scope.includes("prompts/tickets/COORD-999.md"), "an out-of-band path must NOT be in scope");
});

test("COORD-668: terminal sync never advances provenance by path, including skip and failure", () => {
  for (const mode of ["success", "failure", "no-sync", "off-git"]) {
    let advanced = false;
    const svc = createSyncProvenance({
      COORD_DIR: "/repo/coord",
      advanceGovernanceProvenanceBaseline: () => { advanced = true; },
    });
    svc.autoSyncAfterLifecycle({
      verb: "finalize", ticketId: "COORD-668", options: {noSync: mode === "no-sync"},
      syncFn: () => {
        if (mode === "failure") throw new Error("refused semantic drift");
        if (mode === "off-git") throw new Error("not a git repository");
        return {committed: true};
      },
    });
    assert.equal(advanced, false, `must preserve residual drift after ${mode}`);
  }
});

test("GCV-3 slice 2: buildAutoSyncMessage is deterministic on (verb, ticket)", () => {
  assert.equal(
    syncSvc.buildAutoSyncMessage("land", "FE-385"),
    "chore(coord): sync canonical derived artifacts (post-land FE-385)"
  );
  assert.equal(
    syncSvc.buildAutoSyncMessage("finalize", "X-12"),
    "chore(coord): sync canonical derived artifacts (post-finalize X-12)"
  );
  // Ticket-less form (verb only)
  assert.equal(
    syncSvc.buildAutoSyncMessage("mark-done", ""),
    "chore(coord): sync canonical derived artifacts (post-mark-done)"
  );
  // Same inputs -> same string (determinism is the whole point).
  assert.equal(
    syncSvc.buildAutoSyncMessage("land", "FE-385"),
    syncSvc.buildAutoSyncMessage("land", "FE-385")
  );
});

test("GCV-3 slice 2: --no-sync skips autoSyncAfterLifecycle without invoking sync", () => {
  let called = false;
  const result = syncSvc.autoSyncAfterLifecycle({
    verb: "land",
    ticketId: "FE-385",
    options: { noSync: true },
    syncFn: () => {
      called = true;
      return { faked: true };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "--no-sync");
  assert.equal(called, false, "--no-sync must not invoke the sync function");
});

test("GCV-3 slice 2: happy path invokes syncFn with the deterministic message + quiet:true", () => {
  let captured = null;
  const result = syncSvc.autoSyncAfterLifecycle({
    verb: "land",
    ticketId: "FE-385",
    options: {},
    syncFn: (opts) => {
      captured = opts;
      return { committed: true, message: opts.commit, delta: ["rendered/TASKS.md"] };
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.failed, undefined);
  assert.equal(
    captured.commit,
    "chore(coord): sync canonical derived artifacts (post-land FE-385)"
  );
  assert.equal(captured.quiet, true, "auto-trigger must run sync quietly");
  assert.equal(result.result.committed, true);
});

test("COORD-196: autoSyncAfterLifecycle (every terminal boundary) passes includeBoardJson:true so the board row transition is committed atomically", () => {
  let captured = null;
  const result = syncSvc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "COORD-196",
    options: {},
    syncFn: (opts) => {
      captured = opts;
      return { committed: true, message: opts.commit, delta: ["board/tasks.json", "rendered/TASKS.md"] };
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(
    captured.includeBoardJson,
    true,
    "terminal-boundary auto-sync must opt the canonical board json into the scope-limited sync commit"
  );
  assert.equal(captured.quiet, true);
});

test("ENT-001: push-on-finalize is OPT-IN — default does NOT push", () => {
  let pushed = false;
  const result = syncSvc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "ENT-001",
    options: {},
    syncFn: () => ({ committed: true, delta: [".runtime/governance-events.ndjson"] }),
    pushFn: () => {
      pushed = true;
      return { status: 0 };
    },
  });
  assert.equal(pushed, false, "default behavior must not push");
  assert.equal(result.push.pushed, false);
  assert.equal(result.push.reason, "not-requested");
});

test("ENT-001/COORD-696: --push-after-sync also converges earlier unpublished canonical commits", () => {
  let pushCalls = 0;
  const pushFn = () => {
    pushCalls += 1;
    return { status: 0 };
  };
  const committed = syncSvc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "ENT-001",
    options: { pushAfterSync: true },
    syncFn: () => ({ committed: true }),
    pushFn,
  });
  assert.equal(committed.push.pushed, true);
  assert.equal(pushCalls, 1);

  const noCommit = syncSvc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "ENT-001",
    options: { pushAfterSync: true },
    syncFn: () => ({ committed: false, note: "nothing to commit" }),
    pushFn,
  });
  assert.equal(noCommit.push.pushed, true);
  assert.equal(pushCalls, 2, "the explicit governed push must recover a previously stranded canonical commit");
});

test("ENT-001: COORD_PUSH_ON_FINALIZE env enables push; pushOnFinalizeEnabled honors flag/env precedence", () => {
  assert.equal(syncSvc.pushOnFinalizeEnabled({}), false);
  assert.equal(syncSvc.pushOnFinalizeEnabled({ pushAfterSync: true }), true);
  const prev = process.env.COORD_PUSH_ON_FINALIZE;
  try {
    process.env.COORD_PUSH_ON_FINALIZE = "1";
    assert.equal(syncSvc.pushOnFinalizeEnabled({}), true);
    process.env.COORD_PUSH_ON_FINALIZE = "0";
    assert.equal(syncSvc.pushOnFinalizeEnabled({}), false);
    process.env.COORD_PUSH_ON_FINALIZE = "false";
    assert.equal(syncSvc.pushOnFinalizeEnabled({}), false);
  } finally {
    if (prev === undefined) delete process.env.COORD_PUSH_ON_FINALIZE;
    else process.env.COORD_PUSH_ON_FINALIZE = prev;
  }
});

test("ENT-001: push is best-effort — a missing upstream skips quietly, never throws", () => {
  const result = syncSvc.pushAfterLifecycleSync({
    verb: "finalize",
    pushFn: () => ({ status: 1, stderr: "fatal: The current branch has no upstream branch." }),
  });
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "no-upstream-or-remote");
  assert.equal(result.failed, undefined);
});

test("GCV-3 slice 2: best-effort — sync failure does NOT throw out (lifecycle action stays committed)", () => {
  let warned = false;
  const originalWarn = console.warn;
  console.warn = () => {
    warned = true;
  };
  try {
    const result = syncSvc.autoSyncAfterLifecycle({
      verb: "land",
      ticketId: "FE-999",
      options: {},
      syncFn: () => {
        throw new Error("simulated git failure during sync");
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.failed, true);
    assert.match(result.error, /simulated git failure/);
    assert.equal(warned, true, "best-effort failures must emit a clear warning");
  } finally {
    console.warn = originalWarn;
  }
});

test("COORD-696 RED: a committed canonical tip ahead of its configured upstream is not publication-safe", (t) => {
  const { local } = makePublicationWorld(t);
  const localTip = commit(local, "unpublished closeout");
  const svc = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local });

  const publication = svc.assessCanonicalPublication();

  assert.equal(publication.required, true);
  assert.equal(publication.published, false);
  assert.equal(publication.status, "ahead");
  assert.equal(publication.local_sha, localTip);
  assert.equal(publication.ahead_by, 1);
});

test("COORD-696: missing publication wiring fails closed instead of disabling the release guard", () => {
  const publication = createSyncProvenance({ COORD_DIR: "/repo/coord" })
    .assessCanonicalPublication();
  assert.equal(publication.required, true);
  assert.equal(publication.published, false);
  assert.equal(publication.status, "publication-check-not-configured");
});

test("COORD-696 RED: publication follows the configured upstream ref, not the local branch name", (t) => {
  const { local, remote } = makePublicationWorld(t);
  git(local, ["push", "origin", "main:trunk"]);
  git(local, ["fetch", "origin", "trunk"]);
  git(local, ["branch", "--set-upstream-to=origin/trunk", "main"]);
  const mainBefore = git(remote, ["rev-parse", "main"]);
  const published = commit(local, "published to trunk only");
  git(local, ["push", "origin", "main:trunk"]);

  const svc = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local });
  const publication = svc.assessCanonicalPublication();

  assert.equal(publication.published, true);
  assert.equal(publication.status, "published");
  assert.equal(publication.upstream, "origin/trunk");
  assert.equal(publication.remote_sha, published);
  assert.equal(git(remote, ["rev-parse", "main"]), mainBefore, "origin/main is deliberately stale");
});

test("COORD-696 RED: a no-op terminal sync still retains the session when earlier canonical commits are unpublished", (t) => {
  const { local } = makePublicationWorld(t);
  commit(local, "earlier unpublished governance history");
  const svc = createSyncProvenance({
    gitTry: realGitTry,
    COORD_DIR: local,
    canonicalSyncablePaths: () => [],
    DEFAULT_PATHS: { boardPath: path.join(local, "coord/board/tasks.json") },
    advanceGovernanceProvenanceBaseline: () => true,
  });

  const result = svc.autoSyncAfterLifecycle({
    verb: "land",
    ticketId: "COORD-696",
    syncFn: () => ({ committed: false, note: "nothing to commit" }),
  });

  assert.equal(result.result.committed, false);
  assert.equal(result.publication.status, "ahead");
  assert.equal(result.session_release_safe, false);
});

test("COORD-696 RED: --push-after-sync recovers a pre-existing ahead tip even when the current sync is a no-op", (t) => {
  const { local, remote } = makePublicationWorld(t);
  const stranded = commit(local, "stranded closeout from an earlier failed sync");
  const svc = createSyncProvenance({
    gitTry: realGitTry,
    COORD_DIR: local,
    canonicalSyncablePaths: () => [],
    DEFAULT_PATHS: { boardPath: path.join(local, "coord/board/tasks.json") },
    advanceGovernanceProvenanceBaseline: () => true,
  });

  const result = svc.autoSyncAfterLifecycle({
    verb: "land",
    ticketId: "COORD-696",
    options: { pushAfterSync: true },
    syncFn: () => ({ committed: false, note: "nothing new to commit" }),
  });

  assert.equal(result.push.pushed, true);
  assert.equal(result.publication.status, "published");
  assert.equal(result.session_release_safe, true);
  assert.equal(git(remote, ["rev-parse", "main"]), stranded);
});

test("COORD-696: a diverged or untracked canonical branch is never publication-safe", (t) => {
  const { local, remote, root } = makePublicationWorld(t);
  const other = path.join(root, "other");
  git(root, ["clone", remote, other]);
  commit(other, "remote-only");
  git(other, ["push", "origin", "main:main"]);
  commit(local, "local-only");

  const diverged = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local })
    .assessCanonicalPublication();
  assert.equal(diverged.status, "diverged");
  assert.equal(diverged.published, false);

  git(local, ["branch", "--unset-upstream"]);
  const untracked = createSyncProvenance({ gitTry: realGitTry, COORD_DIR: local })
    .assessCanonicalPublication();
  assert.equal(untracked.status, "no-upstream");
  assert.equal(untracked.published, false);
});

test("COORD-696 RED: a failed terminal sync is never session-release-safe even when HEAD is published", (t) => {
  const { local } = makePublicationWorld(t);
  const svc = createSyncProvenance({
    gitTry: realGitTry,
    COORD_DIR: local,
    canonicalSyncablePaths: () => [],
    DEFAULT_PATHS: { boardPath: path.join(local, "coord/board/tasks.json") },
    advanceGovernanceProvenanceBaseline: () => true,
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = svc.autoSyncAfterLifecycle({
      verb: "land",
      ticketId: "COORD-696",
      syncFn: () => {
        throw new Error("simulated terminal sync failure");
      },
    });

    assert.equal(result.failed, true);
    assert.equal(result.publication.status, "published");
    assert.equal(result.session_release_safe, false);
  } finally {
    console.warn = originalWarn;
  }
});

test("COORD-696 RED: the terminal CLI boundary passes publication evidence into session release", () => {
  assert.equal(typeof cliModule.__testing.runTerminalLifecycle, "function");
  let releaseOptions = null;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const lifecycleResult = cliModule.__testing.runTerminalLifecycle(
      "land",
      "COORD-696",
      {},
      () => ({ status: "done" }),
      {
        autoSyncAfterLifecycle: () => ({
          session_release_safe: false,
          publication: { status: "ahead", published: false },
        }),
        releaseTerminalTicketSession: (_ticketId, options) => {
          releaseOptions = options;
          return { released: [], reason: "canonical-publication-unverified" };
        },
      },
    );

    assert.deepEqual(lifecycleResult, { status: "done" });
    assert.equal(releaseOptions.terminalSync.session_release_safe, false);
    assert.equal(releaseOptions.terminalSync.publication.status, "ahead");
  } finally {
    console.warn = originalWarn;
  }
});

function createSafetySyncService({
  statusStdout,
  callerSession = "caller",
  lockSession = "foreign",
  currentTicketId = null,
  staleLock = false,
  liveTicket = "OTHER-1",
  provenance = { drift: [] },
} = {}) {
  let runBoardSyncCalled = false;
  const gitCalls = [];
  const board = {
    sections: [
      {
        rows: [
          { ID: liveTicket, Repo: "X", Status: "doing", Owner: "codexb00" },
        ],
      },
    ],
  };
  const svc = createSyncProvenance({
    withGovernanceMutation: (_metadata, fn) => fn(),
    detectGovernanceProvenanceDrift: () => provenance,
    splitGovernanceProvenanceDrift: (drift) => ({blocking: drift, warnings: []}),
    state: {QUESTIONS_PATH: "/repo/coord/QUESTIONS.md"},
    runBoardSync: () => {
      runBoardSyncCalled = true;
    },
    canonicalSyncablePaths: () => ["rendered/TASKS.md"],
    computeSyncDelta: () => ["rendered/TASKS.md"],
    isInsideGitWorkTree: () => true,
    relativeCoordPath: (p) => p,
    readBoard: () => board,
    getRows: (b) => b.sections.flatMap((section) => section.rows || []),
    isDoingStatus: (status) => status === "doing",
    findLockForTicket: (ticket) => (
      ticket === liveTicket
        ? {
            ticket,
            owner: "codexb00",
            path: `/repo/coord/.runtime/locks/${ticket}.lock`,
            worktree: `/repo/coord/.worktrees/codexb00/${ticket}`,
            session_id: lockSession,
          }
        : null
    ),
    isStaleTicketLock: () => staleLock,
    resolveCurrentAgentId: () => ({ identity: { session: { session_id: callerSession } } }),
    advanceGovernanceProvenanceBaseline: () => true,
    gitTry: (repoRoot, args) => {
      gitCalls.push({ repoRoot, args });
      if (args[0] === "status") {
        return { status: 0, stdout: statusStdout || "" };
      }
      return { status: 0, stdout: "" };
    },
    fail: (message) => {
      throw new Error(message);
    },
    COORD_DIR: "/repo/coord",
    DEFAULT_PATHS: { boardPath: "/repo/coord/board/tasks.json" },
  });
  return {
    svc,
    currentTicketId,
    get runBoardSyncCalled() {
      return runBoardSyncCalled;
    },
    gitCalls,
  };
}

test("COORD-654: sync distinguishes same-handle own and foreign sessions before any write", () => {
  for (const [lockSession, label] of [["caller", "own-session"], ["other", "foreign-session"], [null, "unknown-session"]]) {
    const harness = createSafetySyncService({ statusStdout: " M coord/board/tasks.json\n", lockSession });
    assert.throws(() => harness.svc.runSyncCommand({ commit: "sync" }), new RegExp(label));
    assert.equal(harness.runBoardSyncCalled, false);
    assert.ok(harness.gitCalls.every((call) => call.args[0] === "status"));
  }
});

test("COORD-362: gov sync --commit refuses dirty non-derived work when a foreign doing lock is live", () => {
  const harness = createSafetySyncService({
    statusStdout: " M coord/scripts/worker.js\n M coord/rendered/TASKS.md\n",
  });

  assert.throws(
    () => harness.svc.runSyncCommand({ commit: "sync", currentTicketId: harness.currentTicketId }),
    /Refusing tree-wide governance mutation/
  );
  assert.equal(harness.runBoardSyncCalled, false, "sync must refuse before regenerating derived artifacts");
});

test("COORD-362: gov sync --commit allows derived-only drift even with a foreign doing lock", () => {
  const harness = createSafetySyncService({
    statusStdout: " M coord/rendered/TASKS.md\n",
  });

  const result = harness.svc.runSyncCommand({ commit: "sync" });

  assert.equal(result.committed, true);
  assert.equal(harness.runBoardSyncCalled, true);
});

test("COORD-362: gov sync exempts the current ticket and stale foreign locks from the tree-mutation latch", () => {
  const sameTicket = createSafetySyncService({
    statusStdout: " M coord/scripts/worker.js\n",
    currentTicketId: "OTHER-1",
  });
  assert.doesNotThrow(() => sameTicket.svc.runSyncCommand({ commit: "sync", currentTicketId: "OTHER-1" }));
  assert.equal(sameTicket.runBoardSyncCalled, true);

  const stale = createSafetySyncService({
    statusStdout: " M coord/scripts/worker.js\n",
    staleLock: true,
  });
  assert.doesNotThrow(() => stale.svc.runSyncCommand({ commit: "sync" }));
  assert.equal(stale.runBoardSyncCalled, true);
});

test("COORD-915: sync skips off-git workspaces and previews drift without a commit", (t) => {
  const offGit = createSyncProvenance({
    COORD_DIR: path.join(os.tmpdir(), "coord-off-git-sync"),
    isInsideGitWorkTree: () => false,
    relativeCoordPath: (value) => value,
  }).runSyncCommand({ quiet: true });
  assert.deepEqual([offGit.skipped, offGit.reason], [true, "coord root is not inside a git work tree"]);

  const notices = [];
  const originalLog = console.log;
  console.log = (message) => notices.push(message);
  try {
    const visibleOffGit = createSyncProvenance({
      COORD_DIR: path.join(os.tmpdir(), "coord-off-git-sync-visible"),
      isInsideGitWorkTree: () => false,
      relativeCoordPath: (value) => value,
    }).runSyncCommand();
    assert.deepEqual([visibleOffGit.skipped, visibleOffGit.reason], [true, "coord root is not inside a git work tree"]);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(notices, ["[gov sync] coord root is not inside a git work tree; skipping canonical sync (nothing to commit)."]);

  const preview = createSafetySyncService({ t, statusStdout: "" });
  const result = preview.svc.runSyncCommand({ quiet: true });
  assert.equal(result.committed, false);
  assert.match(result.note, /Re-run with `--commit/);
  assert.equal(preview.runBoardSyncCalled, true, "preview regenerates the derived view before reporting the scoped delta");
  assert.ok(preview.gitCalls.every((call) => call.args[0] !== "add" && call.args[0] !== "commit"), "preview has no Git publication side effects");
});

test("COORD-915: a provenance response without a drift list is treated as an empty list", (t) => {
  const service = createSafetySyncService({ t, statusStdout: "", provenance: {} });
  const result = service.svc.runSyncCommand({ quiet: true });
  assert.equal(result.committed, false);
  assert.equal(service.runBoardSyncCalled, true, "an omitted optional drift list does not block normal sync regeneration");
});

test("COORD-915: whitespace commit messages use the deterministic sync message", (t) => {
  const harness = createSafetySyncService({ t, statusStdout: "" });
  const result = harness.svc.runSyncCommand({ commit: "   ", quiet: true });
  const commitCall = harness.gitCalls.find((call) => call.args[0] === "commit");
  assert.equal(result.committed, true);
  assert.ok(commitCall, "the requested sync commit reaches the scoped Git commit");
  assert.equal(commitCall.args[2], "chore(coord): deterministic gov sync of canonical derived artifacts");
});

test("COORD-362: autoSyncAfterLifecycle passes currentTicketId into the guarded sync call", () => {
  let captured = null;
  syncSvc.autoSyncAfterLifecycle({
    verb: "mark-done",
    ticketId: "COORD-362",
    options: {},
    syncFn: (opts) => {
      captured = opts;
      return { committed: false };
    },
  });

  assert.equal(captured.currentTicketId, "COORD-362");
});

// COORD-911: `gov publish-board` regression tests. Each runs real git against a
// fixture repo with a local bare remote (never ROOT, never origin). Governance
// collaborators are injected: the journal drift list, the live locks and the
// regeneration (rendered view = board bytes, so a re-run is a stable no-op).
function makePublishWorld(t, { ignoreWorktrees = true, board = {}, boardSeed = null, decisionFenceForTicket, assertTicketFence, boardLanding = "push", gitTry = realGitTry, overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-911-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  const coord = path.join(repo, "coord");
  fs.mkdirSync(remote);
  fs.mkdirSync(repo);
  gitFixture(remote, ["init", "--bare", "--initial-branch=main"]);
  gitFixture(repo, ["init", "--initial-branch=main"]);
  git(repo, ["remote", "add", "origin", remote]);
  for (const [rel, body] of [
    ["coord/board/tasks.json", boardSeed ? `${JSON.stringify(boardSeed)}\n` : "{\"tasks\":[\"COORD-900\"]}\n"],
    ["coord/rendered/TASKS.md", "{\"tasks\":[\"COORD-900\"]}\n"],
    ["coord/QUESTIONS.md", "questions\n"],
    ["coord/scripts/worker.js", "module.exports = 1;\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  fs.writeFileSync(path.join(repo, ".gitignore"), ignoreWorktrees ? ".worktrees/\n" : "");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["push", "--set-upstream", "origin", "main:main"]);

  const worktree = path.join(coord, ".worktrees", "claudea1", "COORD-900");
  const state = {
    drift: [],
    snapshotFiles: [],
    rows: [{ ID: "COORD-900", Status: "doing", Owner: "claudea1" }],
    locks: {
      "COORD-900": { ticket: "COORD-900", owner: "claudea1", session_id: "a1-session", worktree, path: path.join(coord, ".runtime", "locks", "COORD-900.lock") },
    },
  };
  const readCoord = (rel) => fs.readFileSync(path.join(coord, rel), "utf8");
  const svc = createSyncProvenance({
    COORD_DIR: coord,
    state: { QUESTIONS_PATH: path.join(coord, "QUESTIONS.md") },
    DEFAULT_PATHS: { boardPath: path.join(coord, "board", "tasks.json"), boardBranch: "main", boardLanding },
    canonicalSyncablePaths: () => ["board/tasks.json", "rendered/TASKS.md"],
    isInsideGitWorkTree: () => true,
    relativeCoordPath: (value) => path.relative(coord, value).split(path.sep).join("/"),
    gitTry,
    withGovernanceMutation: (_metadata, fn) => fn(),
    detectGovernanceProvenanceDrift: () => ({ drift: [...state.drift], currentSnapshot: { files: state.snapshotFiles } }),
    splitGovernanceProvenanceDrift: (drift) => ({ blocking: [...drift], nonMaterial: [] }),
    // Regeneration: the rendered view is a pure function of the board bytes.
    runBoardSync: () => fs.writeFileSync(path.join(coord, "rendered", "TASKS.md"), readCoord("board/tasks.json")),
    // Delta: canonical paths git reports as changed, mapped back to coord-relative.
    computeSyncDelta: (repoRoot, paths) => {
      const out = git(repoRoot, ["status", "--porcelain", "--untracked-files=normal", "--", ...paths]);
      return [...new Set(out.split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/).pop().replace(/^coord\//, "")))];
    },
    readBoard: () => ({ ...board, ...JSON.parse(fs.readFileSync(path.join(coord, "board", "tasks.json"), "utf8")) }),
    getRows: (value) => Array.isArray(value?.sections)
      ? value.sections.flatMap((section) => section.rows || [])
      : state.rows,
    isDoingStatus: (status) => status === "doing",
    findLockForTicket: (id) => state.locks[id] || null,
    isStaleTicketLock: () => false,
    resolveCurrentAgentId: () => null,
    fail: (message) => { throw new Error(message); },
    withActiveCommandFence: (_command, run) => run(),
    decisionFenceForTicket: decisionFenceForTicket || (() => ({ status: "legacy-absent" })),
    assertTicketFence: assertTicketFence || (() => {}),
    ...overrides,
  });
  return { root, remote, repo, coord, worktree, state, svc, readCoord };
}

test("COORD-911: publish during an active ticket commits and pushes canonical state only, leaves the live lock unchanged, and is idempotent", (t) => {
  const world = makePublishWorld(t);
  const lockBefore = JSON.stringify(world.state.locks);
  // A governed verb files a ticket while COORD-900 is doing; its board write is journaled (no drift).
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-901\"]}\n");
  // The ticket worktree holds real work: it is gitignored and must never be published.
  fs.mkdirSync(world.worktree, { recursive: true });
  fs.writeFileSync(path.join(world.worktree, "wip.js"), "in-flight\n");

  const first = world.svc.publishBoardState({ commit: "board: file COORD-901", quiet: true });
  assert.equal(first.committed, true);
  assert.equal(first.push.pushed, true);
  const head = git(world.repo, ["rev-parse", "HEAD"]);
  assert.equal(git(world.remote, ["rev-parse", "main"]), head, "the publish reaches the bare remote");
  const files = git(world.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(files, ["coord/board/tasks.json", "coord/rendered/TASKS.md"], "only canonical board and rendered paths are committed");
  assert.equal(JSON.stringify(world.state.locks), lockBefore, "live lock state is unchanged");
  assert.equal(fs.readFileSync(path.join(world.worktree, "wip.js"), "utf8"), "in-flight\n", "ticket worktree content is untouched");

  const second = world.svc.publishBoardState({ commit: "board: file COORD-901", quiet: true });
  assert.equal(second.committed, false, "a re-run with nothing to commit creates no commit");
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), head, "idempotent: HEAD does not move");
  assert.equal(git(world.remote, ["rev-parse", "main"]), head);
});

test("COORD-1053: board publication reads a valid remote board blob larger than 1 MiB", (t) => {
  const world = makePublishWorld(t);
  const boardPath = path.join(world.coord, "board", "tasks.json");
  const largeBoard = {
    sections: [{ rows: [{
      ID: "COORD-900", Status: "doing", Owner: "claudea1", Repo: "X",
      Description: "bounded board baseline ".repeat(110_000),
    }] }],
  };
  const baseline = `${JSON.stringify(largeBoard)}\n`;
  assert.ok(Buffer.byteLength(baseline) > 1024 * 1024, "fixture must exceed spawnSync's default 1 MiB buffer");
  fs.writeFileSync(boardPath, baseline);
  git(world.repo, ["add", "coord/board/tasks.json"]);
  git(world.repo, ["commit", "-m", "large valid board publication baseline"]);
  git(world.repo, ["push", "origin", "main:main"]);

  largeBoard.sections[0].rows[0].Status = "review";
  fs.writeFileSync(boardPath, `${JSON.stringify(largeBoard)}\n`);
  const published = world.svc.publishBoardState({ commit: "board: publish large valid baseline", quiet: true });
  assert.equal(published.committed, true);
  assert.equal(published.push.pushed, true);
  assert.equal(git(world.remote, ["rev-parse", "main"]), git(world.repo, ["rev-parse", "HEAD"]));
});

test("COORD-1053: malformed fetched board JSON still refuses publication", (t) => {
  const world = makePublishWorld(t);
  const boardPath = path.join(world.coord, "board", "tasks.json");
  fs.writeFileSync(boardPath, "{malformed board\n");
  git(world.repo, ["add", "coord/board/tasks.json"]);
  git(world.repo, ["commit", "-m", "malformed board baseline"]);
  git(world.repo, ["push", "origin", "main:main"]);

  fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ rows: [{ ID: "COORD-900", Status: "review", Owner: "claudea1" }] }] }));
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  assert.throws(() => world.svc.publishBoardState({ commit: "board: malformed base", quiet: true }),
    /is unreadable; refusing an unfenced board push/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "malformed baseline refuses before creating a board commit");
  assert.equal(git(world.remote, ["rev-parse", "main"]), headBefore, "malformed baseline publishes nothing");
});

test("COORD-1053: an unreadable fetched board still refuses publication with a bounded Git read", (t) => {
  let boardReadMaxBuffer = null;
  const gitTry = (repo, args, options) => {
    if (args[0] === "show" && String(args[1] || "").startsWith("FETCH_HEAD:coord/board/tasks.json")) {
      boardReadMaxBuffer = options?.maxBuffer;
      return { status: null, stdout: "", stderr: "spawnSync git ENOBUFS" };
    }
    return realGitTry(repo, args, options);
  };
  const world = makePublishWorld(t, { gitTry });
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), JSON.stringify({ sections: [{ rows: [{ ID: "COORD-900", Status: "review", Owner: "claudea1" }] }] }));
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  assert.throws(() => world.svc.publishBoardState({ commit: "board: unreadable base", quiet: true }),
    /Could not read fetched board publication base .* refusing an unfenced board push/);
  assert.equal(boardReadMaxBuffer, 16 * 1024 * 1024, "only the board blob reader gets the explicit bounded limit");
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "unreadable baseline refuses before creating a board commit");
  assert.equal(git(world.remote, ["rev-parse", "main"]), headBefore, "unreadable baseline publishes nothing");
});

test("COORD-1047: board publication captures changed ticket fences once and refuses a moved canonical ref before push", (t) => {
  const ticket = "COORD-900";
  const row = (Status, Owner) => ({ ID: ticket, Status, Owner, Repo: "X", Description: "fenced publication" });
  const boardSeed = { sections: [{ rows: [row("doing", "owner-a")] }] };
  let world;
  let moved = false;
  const decisionFenceForTicket = (id) => {
    const current = attemptCoordination.readCanonical(world.repo, { remote: "origin", ticket: id });
    const fence = {
      status: "captured", remote: "origin", ticket: id,
      token: attemptCoordination.tokenFor(id, current.record, current.oid),
      authority_epoch: current.record.authority_epoch,
      selected_attempt: current.record.selected_attempt || null,
    };
    if (!moved) {
      moved = true;
      const next = { ...current.record, generation: current.record.generation + 1, updated_at: new Date().toISOString() };
      attemptCoordination.publishCanonicalTransition(world.repo, { remote: "origin", ticket: id, expected: current, next });
    }
    return fence;
  };
  const assertTicketFence = (id, fence) => {
    const current = attemptCoordination.verifyFence(world.repo, {
      remote: fence.remote, ticket: id, token: fence.token, authorityEpoch: fence.authority_epoch,
    });
    if (!current.ok || current.selected_attempt !== fence.selected_attempt) {
      throw new Error(`canonical attempt fence is ${current.reason || "selected-attempt"}`);
    }
  };
  world = makePublishWorld(t, {
    boardSeed,
    decisionFenceForTicket,
    assertTicketFence,
  });
  attemptCoordination.bootstrapCanonical(world.repo, {
    remote: "origin", ticket, owner: "owner-a", status: "doing", authorityEpoch: 2,
  });
  const remoteHeadBefore = git(world.remote, ["rev-parse", "main"]);
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), `${JSON.stringify({ sections: [{ rows: [row("review", "owner-b")] }] })}\n`);
  assert.throws(() => world.svc.publishBoardState({
    commit: "board: publish fenced ticket", quiet: true,
    pushFn: () => ({ status: 0, stdout: "", stderr: "" }),
  }), /canonical attempt fence is stale/);
  assert.equal(moved, true, "the canonical ref moved after the publication snapshot was captured");
  assert.equal(git(world.remote, ["rev-parse", "main"]), remoteHeadBefore,
    "a stale canonical fence prevents the board branch from being pushed");
});

for (const boardLanding of ["push", "pr"]) {
  for (const missingBase of ["no-upstream", "detached-head"]) {
    test(`COORD-1047: default ${boardLanding} board publication refuses when its upstream fence base is ${missingBase}`, (t) => {
    const world = makePublishWorld(t, { boardLanding });
    if (missingBase === "no-upstream") git(world.repo, ["branch", "--unset-upstream"]);
    else git(world.repo, ["checkout", "--detach", "HEAD"]);
    const row = { ID: "COORD-900", Status: "review", Owner: "claudea1", Repo: "X", Description: "changed row" };
    fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), `${JSON.stringify({ sections: [{ rows: [row] }] })}\n`);
    const localHeadBefore = git(world.repo, ["rev-parse", "HEAD"]);
    const remoteHeadBefore = git(world.remote, ["rev-parse", "main"]);
    const externalCalls = [];
    const expectedReason = missingBase === "no-upstream" ? "no-upstream" : "detached-head";
    assert.throws(() => world.svc.publishBoardState({
      commit: `board: unavailable ${boardLanding} fence`, quiet: true,
      pr: { boardLanding, gh: (args) => { externalCalls.push(args); return { status: 0, stdout: "[]", stderr: "" }; } },
    }), new RegExp(`Cannot establish a board publication base \\(${expectedReason}\\); refusing an unfenced board push`));
    assert.equal(git(world.repo, ["rev-parse", "HEAD"]), localHeadBefore, "refusal happens before creating the board commit");
    assert.equal(git(world.remote, ["rev-parse", "main"]), remoteHeadBefore, "no branch is published");
    assert.deepEqual(externalCalls, [], "no PR/provider operation runs without a captured ticket fence set");
    });
  }
}

test("COORD-911: publish refuses a dirty path that belongs to another live session, and publishes nothing", (t) => {
  const world = makePublishWorld(t, { ignoreWorktrees: false });
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-901\"]}\n");
  fs.mkdirSync(world.worktree, { recursive: true });
  fs.writeFileSync(path.join(world.worktree, "wip.js"), "foreign in-flight edit\n");
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);

  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    (error) => {
      assert.match(error.message, /another live session's uncommitted work/);
      assert.match(error.message, /COORD-900\(claudea1\)/);
      assert.match(error.message, /\.worktrees\/claudea1\/COORD-900\/wip\.js/);
      return true;
    }
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "no commit was made");
  assert.equal(git(world.remote, ["rev-parse", "main"]), headBefore, "nothing was pushed");
});

test("COORD-911: publish refuses an unaccounted dirty path and an out-of-band canonical edit, listing each one precisely", (t) => {
  const world = makePublishWorld(t);
  // A hand-edit to a non-canonical source file with no owning lock.
  fs.writeFileSync(path.join(world.coord, "scripts", "worker.js"), "hand edit\n");
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    (error) => {
      assert.match(error.message, /unaccounted path\(s\)/);
      assert.match(error.message, /coord\/scripts\/worker\.js/);
      assert.doesNotMatch(error.message, /another live session/);
      return true;
    }
  );
  fs.writeFileSync(path.join(world.coord, "scripts", "worker.js"), "module.exports = 1;\n");
  git(world.repo, ["checkout", "--", "coord/scripts/worker.js"]);

  // A canonical rendered view edited outside any governed verb: the journal does not account for it.
  fs.writeFileSync(path.join(world.coord, "rendered", "TASKS.md"), "hand edit\n");
  world.state.drift = ["rendered/TASKS.md"];
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    /unaccounted path\(s\)[^]*rendered\/TASKS\.md/
  );
  assert.equal(git(world.remote, ["rev-parse", "main"]), git(world.repo, ["rev-parse", "HEAD"]), "nothing was published");
});

test("COORD-911: a refused publish fails loudly, keeps the commit local, and a retry publishes the same HEAD", (t) => {
  const world = makePublishWorld(t);
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-902\"]}\n");
  const refused = { calls: 0 };
  assert.throws(
    () => world.svc.publishBoardState({
      commit: "board: file COORD-902",
      quiet: true,
      pushFn: () => { refused.calls += 1; return { status: 1, stdout: "", stderr: "! [rejected] main -> main (fetch first)" }; },
    }),
    /commit is local but was not published/
  );
  const localHead = git(world.repo, ["rev-parse", "HEAD"]);
  assert.notEqual(localHead, git(world.remote, ["rev-parse", "main"]), "the remote is untouched");
  assert.equal(refused.calls, 1);

  const retried = world.svc.publishBoardState({ commit: "board: file COORD-902", quiet: true });
  assert.equal(retried.committed, false, "the retry creates no second commit");
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), localHead);
  assert.equal(git(world.remote, ["rev-parse", "main"]), localHead, "the retry publishes the same HEAD");
});

test("COORD-911: a following finalize commits only the remaining delta, with no duplicate of the published state", (t) => {
  const world = makePublishWorld(t);
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-901\"]}\n");
  const published = world.svc.publishBoardState({ commit: "board: file COORD-901", quiet: true });
  assert.equal(published.committed, true);
  const publishedHead = git(world.repo, ["rev-parse", "HEAD"]);
  const commitsBefore = Number(git(world.repo, ["rev-list", "--count", "HEAD"]));

  // Ticket finalize after the publish: a new governed board change, then the terminal sync.
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-901\",\"DONE\"]}\n");
  const finalize = world.svc.runSyncCommand({ commit: "chore(coord): finalize COORD-900", quiet: true, includeBoardJson: true });
  assert.equal(finalize.committed, true);
  assert.equal(Number(git(world.repo, ["rev-list", "--count", "HEAD"])), commitsBefore + 1, "exactly one new commit");
  const finalFiles = git(world.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(finalFiles, ["coord/board/tasks.json", "coord/rendered/TASKS.md"], "the finalize commit holds only the new delta");
  assert.notEqual(git(world.repo, ["rev-parse", "HEAD"]), publishedHead);
  assert.equal(world.svc.runSyncCommand({ commit: "noop", quiet: true, includeBoardJson: true }).committed, false, "a second finalize sync is a no-op");
});

// COORD-928: a board publication must not reference a prompt file that is not in the
// commit being published (the COORD-887/913 shape). The refusal publishes nothing.
test("COORD-928: publish-board refuses a prompt_index entry whose prompt file is absent, and publishes nothing", (t) => {
  const world = makePublishWorld(t, {
    board: { prompt_index: { "COORD-887": "coord/prompts/tickets/COORD-887.md" } },
  });
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-887\"]}\n");
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: file COORD-887", quiet: true }),
    /Refusing to publish.*COORD-887 -> coord\/prompts\/tickets\/COORD-887\.md/s,
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "no commit was made");
  assert.equal(git(world.remote, ["rev-parse", "main"]), headBefore, "nothing reached the remote");
});

test("COORD-928: publish-board with the prompt file committed at HEAD publishes the board", (t) => {
  const world = makePublishWorld(t, {
    board: { prompt_index: { "COORD-913": "coord/prompts/tickets/COORD-913.md" } },
  });
  fs.mkdirSync(path.join(world.coord, "prompts", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(world.coord, "prompts", "tickets", "COORD-913.md"), "# COORD-913\n\n## Acceptance\n\n- specific\n");
  git(world.repo, ["add", "coord/prompts/tickets/COORD-913.md"]);
  git(world.repo, ["commit", "-m", "prompt COORD-913"]);
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-913\"]}\n");
  const result = world.svc.publishBoardState({ commit: "board: file COORD-913", quiet: true });
  assert.equal(result.committed, true);
  assert.equal(result.push.pushed, true);
});

// COORD-928 option A (human-admin 2026-11-13): an untracked file under coord/prompts/ or
// coord/docs/decisions/ that the journal accounts for (in the current snapshot, not drift)
// is published in the SAME commit as the board rows, before the prompt_index check runs.
function writeWorldPrompt(world, rel, body = "# prompt\n\n## Acceptance\n\n- specific\n") {
  fs.mkdirSync(path.dirname(path.join(world.repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(world.repo, rel), body);
}

test("COORD-928: publish-board commits a journal-accounted untracked prompt with the board row that references it", (t) => {
  const world = makePublishWorld(t, {
    board: { prompt_index: { "COORD-971": "coord/prompts/tickets/COORD-971.md" } },
  });
  writeWorldPrompt(world, "coord/prompts/tickets/COORD-971.md");
  world.state.snapshotFiles = [{ path: "prompts/tickets/COORD-971.md", exists: true, digest: "d971" }];
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-971\"]}\n");
  const result = world.svc.publishBoardState({ commit: "board: file COORD-971", quiet: true });
  assert.equal(result.committed, true);
  assert.equal(result.push.pushed, true);
  const files = git(world.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(files, [
    "coord/board/tasks.json",
    "coord/prompts/tickets/COORD-971.md",
    "coord/rendered/TASKS.md",
  ], "the prompt and the board row land in one commit");
  assert.equal(git(world.remote, ["rev-parse", "main"]), git(world.repo, ["rev-parse", "HEAD"]));
});

test("COORD-928: an untracked prompt the journal does not account for is still refused as unaccounted", (t) => {
  const world = makePublishWorld(t, {
    board: { prompt_index: { "COORD-971": "coord/prompts/tickets/COORD-971.md" } },
  });
  writeWorldPrompt(world, "coord/prompts/tickets/COORD-971.md");
  world.state.snapshotFiles = [];
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-971\"]}\n");
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: file COORD-971", quiet: true }),
    /unaccounted path\(s\).*coord\/prompts\/tickets\/COORD-971\.md/s,
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "nothing was committed");
});

test("COORD-928: with option A, an accounted prompt is published and a still-missing one is named by the refusal", (t) => {
  const world = makePublishWorld(t, {
    board: { prompt_index: {
      "COORD-971": "coord/prompts/tickets/COORD-971.md",
      "COORD-887": "coord/prompts/tickets/COORD-887.md",
    } },
  });
  writeWorldPrompt(world, "coord/prompts/tickets/COORD-971.md");
  world.state.snapshotFiles = [{ path: "prompts/tickets/COORD-971.md", exists: true, digest: "d971" }];
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-887\"]}\n");
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    /Refusing to publish.*COORD-887 -> coord\/prompts\/tickets\/COORD-887\.md.*absent/s,
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "nothing was committed when any entry is unpublishable");
});

// COORD-1007: `gov register-prompt --body-file` overwrites a TRACKED prompt (a stub committed
// earlier) and journals the new bytes in the same mutation. Option A must publish that
// modification with the board row, but only when the journal accounts for it (not drift).
// The fixture models the journaled write: bytes on disk, and a journal snapshot whose digest
// equals them, so the path is not in the drift list.
function sha1Text(text) {
  return require("node:crypto").createHash("sha1").update(text).digest("hex");
}

function commitTrackedPrompt(world, rel, stubBody) {
  fs.mkdirSync(path.dirname(path.join(world.repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(world.repo, rel), stubBody);
  git(world.repo, ["add", rel]);
  git(world.repo, ["commit", "-m", `stub ${rel}`]);
}

test("COORD-1007 RED: publish-board publishes a journal-accounted register-prompt body over a tracked stub prompt", (t) => {
  const rel = "coord/prompts/tickets/COORD-904.md";
  const world = makePublishWorld(t, {
    board: { prompt_index: { "COORD-904": rel } },
  });
  commitTrackedPrompt(world, rel, "# COORD-904\n\nstub\n");
  // register-prompt --body-file: the body bytes are written and journaled (snapshot == bytes, no drift).
  const body = "# COORD-904\n\n## Acceptance\n\n- full body\n";
  writeWorldPrompt(world, rel, body);
  world.state.snapshotFiles = [{ path: "prompts/tickets/COORD-904.md", exists: true, digest: sha1Text(body) }];
  world.state.drift = [];
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-904\"]}\n");

  const result = world.svc.publishBoardState({ commit: "board: register COORD-904", quiet: true });
  assert.equal(result.committed, true);
  assert.equal(result.push.pushed, true);
  const files = git(world.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(files, [
    "coord/board/tasks.json",
    "coord/prompts/tickets/COORD-904.md",
    "coord/rendered/TASKS.md",
  ], "the tracked prompt body and the board row land in one commit");
  assert.equal(git(world.remote, ["rev-parse", "main"]), git(world.repo, ["rev-parse", "HEAD"]));
  assert.equal(git(world.repo, ["show", `HEAD:${rel}`]), body.trimEnd(), "the committed prompt is the journaled body");
});

test("COORD-1007 RED: an accounted tracked docs/decisions modification rides with the board publication", (t) => {
  const rel = "coord/docs/decisions/0099-example.md";
  const world = makePublishWorld(t);
  commitTrackedPrompt(world, rel, "# ADR stub\n");
  const body = "# ADR 0099\n\nAccepted.\n";
  writeWorldPrompt(world, rel, body);
  world.state.snapshotFiles = [{ path: "docs/decisions/0099-example.md", exists: true, digest: sha1Text(body) }];
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), "{\"tasks\":[\"COORD-900\",\"COORD-1007\"]}\n");

  const result = world.svc.publishBoardState({ commit: "board: adr", quiet: true });
  assert.equal(result.committed, true);
  const files = git(world.repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort();
  assert.ok(files.includes("coord/docs/decisions/0099-example.md"), "the accounted ADR edit is committed");
});

test("COORD-1007: an out-of-band hand edit to a tracked prompt still refuses, and nothing is published", (t) => {
  const rel = "coord/prompts/tickets/COORD-905.md";
  const world = makePublishWorld(t);
  const stub = "# COORD-905\n\nstub\n";
  commitTrackedPrompt(world, rel, stub);
  // Hand edit: bytes changed on disk, the journal still holds the stub's digest, so drift lists it.
  writeWorldPrompt(world, rel, "# COORD-905\n\nhand edited outside any governed verb\n");
  world.state.snapshotFiles = [{ path: "prompts/tickets/COORD-905.md", exists: true, digest: sha1Text(stub) }];
  world.state.drift = ["prompts/tickets/COORD-905.md"];
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  const remoteBefore = git(world.remote, ["rev-parse", "main"]);

  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    /unaccounted path\(s\)[^]*coord\/prompts\/tickets\/COORD-905\.md/,
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "no commit was made");
  assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore, "nothing was published");
});

test("COORD-1007: an accounted tracked file outside the authored classes is still refused", (t) => {
  const world = makePublishWorld(t);
  const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
  // A non-authored source file edited and recorded in the snapshot: the class filter still refuses it.
  const body = "module.exports = 2;\n";
  fs.writeFileSync(path.join(world.coord, "scripts", "worker.js"), body);
  world.state.snapshotFiles = [{ path: "scripts/worker.js", exists: true, digest: sha1Text(body) }];
  assert.throws(
    () => world.svc.publishBoardState({ commit: "board: x", quiet: true }),
    /unaccounted path\(s\)[^]*coord\/scripts\/worker\.js/,
  );
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore, "no commit was made");
});

test("COORD-1052: canonical commit reports staging and commit failures without publishing or sweeping unrelated files", async (t) => {
  for (const failedCommand of ["add", "commit"]) await t.test(failedCommand, (t) => {
    let injectFailure = true;
    const calls = [];
    const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
      calls.push([...args]);
      if (injectFailure && args[0] === failedCommand) return { status: 1, stdout: "", stderr: "fixture disk write refused" };
      return realGitTry(cwd, args, options);
    } });
    const before = git(world.repo, ["rev-parse", "HEAD"]);
    const remoteBefore = git(world.remote, ["rev-parse", "main"]);
    const unrelated = path.join(world.coord, "scripts", "worker.js");
    fs.writeFileSync(unrelated, "module.exports = 2;\n");
    git(world.repo, ["add", "coord/scripts/worker.js"]);
    fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "updated question\n");
    assert.throws(() => world.svc.commitCanonicalDelta(world.coord, "fixture scoped sync", ["QUESTIONS.md"]), /fixture disk write refused/);
    assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
    assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore);
    if (failedCommand === "add") assert.equal(calls.some((args) => args[0] === "commit"), false);
    injectFailure = false;
    world.svc.commitCanonicalDelta(world.coord, "fixture scoped sync", ["QUESTIONS.md"]);
    assert.equal(git(world.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim(), "coord/QUESTIONS.md");
    assert.equal(git(world.repo, ["diff", "--cached", "--name-only"]).trim(), "coord/scripts/worker.js");
    assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore, "commit recovery must never publish implicitly");
  });
});

test("COORD-1052: canonical commit keeps actionable fallback text when Git omits stderr", async (t) => {
  for (const failedCommand of ["add", "commit"]) await t.test(failedCommand, (t) => {
    const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
      if (args[0] === failedCommand) return { status: 1, stdout: "", stderr: "" };
      return realGitTry(cwd, args, options);
    } });
    const headBefore = git(world.repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "unpublished fallback case\n");
    assert.throws(() => world.svc.commitCanonicalDelta(world.coord, "fallback diagnostic", ["QUESTIONS.md"]),
      new RegExp(`git ${failedCommand} failed in ${world.coord}:\\s*$`));
    assert.equal(git(world.repo, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(world.readCoord("QUESTIONS.md"), "unpublished fallback case\n");
  });
});

test("COORD-1052: board publication refuses unavailable remote evidence before commit or push", async (t) => {
  for (const [command, expected] of [["ls-remote", /Could not inspect board publication base/], ["fetch", /Could not refresh board publication base/]]) {
    await t.test(command, (t) => {
      const calls = [];
      const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
        calls.push([...args]);
        if (args[0] === command) return { status: 1, stdout: "", stderr: "fixture remote unavailable" };
        return realGitTry(cwd, args, options);
      } });
      const before = git(world.repo, ["rev-parse", "HEAD"]);
      const remoteBefore = git(world.remote, ["rev-parse", "main"]);
      fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "unpublished question\n");
      assert.throws(() => world.svc.publishBoardState({ quiet: true }), expected);
      assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
      assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore);
      assert.equal(calls.some((args) => ["commit", "push"].includes(args[0])), false);
      assert.equal(world.readCoord("QUESTIONS.md"), "unpublished question\n");
    });
  }
});

test("COORD-1052: changed board tickets require a usable decision fence before publication", (t) => {
  const initial = { sections: [{ rows: [{ ID: "COORD-900", Status: "doing", Owner: "claudea1" }] }] };
  const world = makePublishWorld(t, { boardSeed: initial, decisionFenceForTicket: () => ({ reason: "attempt-remote-unconfigured" }) });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const changed = structuredClone(initial);
  changed.sections[0].rows[0].Status = "review";
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), JSON.stringify(changed) + "\n");
  assert.throws(() => world.svc.publishBoardState({ quiet: true }), /Cannot establish the attempt coordination remote.*COORD-900/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
});

test("COORD-1052: off-git board publication skips all mutation and push collaborators", () => {
  const svc = createSyncProvenance({
    COORD_DIR: "/fixture/off-git/coord", isInsideGitWorkTree: () => false,
    relativeCoordPath: () => ".",
    withGovernanceMutation: () => assert.fail("off-git publication must not mutate"),
    gitTry: () => assert.fail("off-git publication must not run Git"),
  });
  assert.deepEqual(svc.publishBoardState({ quiet: true, pushFn: () => assert.fail("must not push") }), {
    command: "publish-board", repo_root: ".", skipped: true, reason: "coord root is not inside a git work tree",
  });
});

test("COORD-1052: board publication refuses unavailable status before regenerating or committing", (t) => {
  for (const failAt of [1, 2]) {
    for (const unavailable of [null, { status: 128, stderr: "fixture index unreadable" }]) {
      let statusReads = 0;
      const world = makePublishWorld(t, { gitTry: (cwd, args) => {
        if (args[0] === "status" && args.includes("--untracked-files=all")) {
          statusReads += 1;
          if (statusReads === failAt) return unavailable;
        }
        return realGitTry(cwd, args);
      } });
      const beforeHead = git(world.repo, ["rev-parse", "HEAD"]);
      const beforeRemote = git(world.remote, ["rev-parse", "main"]);
      const beforeRendered = world.readCoord("rendered/TASKS.md");
      const board = '{"tasks":["COORD-900","COORD-901"]}\n';
      fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), board);
      assert.throws(() => world.svc.publishBoardState({ quiet: true }), (error) => {
        assert.match(error.message, /git status failed/);
        if (unavailable) assert.match(error.message, /fixture index unreadable/);
        return true;
      });
      assert.equal(statusReads, failAt, "stop at the unavailable inventory rather than infer a clean tree");
      assert.equal(git(world.repo, ["rev-parse", "HEAD"]), beforeHead);
      assert.equal(git(world.remote, ["rev-parse", "main"]), beforeRemote);
      assert.equal(world.readCoord("rendered/TASKS.md"), beforeRendered);
      assert.equal(world.readCoord("board/tasks.json"), board, "keep the pending governed board edit available for retry");
    }
  }
});

test("COORD-1052: terminal push with detached HEAD refuses to guess a destination", (t) => {
  const calls = [];
  const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
    calls.push([...args]);
    return realGitTry(cwd, args, options);
  } });
  git(world.repo, ["checkout", "--detach", "HEAD"]);
  const before = git(world.remote, ["rev-parse", "main"]);
  calls.length = 0;
  const result = world.svc.pushAfterLifecycleSync({ verb: "finalize" });
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "no-upstream-or-remote");
  assert.match(result.detail, /HEAD is detached/);
  assert.equal(calls.some((args) => args[0] === "push"), false);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
});

test("direct sync publication uses the sync command fence when the verb is omitted", (t) => {
  const commands = [];
  let omitGitOutput = null;
  const world = makePublishWorld(t, {
    gitTry: (cwd, args, options) => {
      if (args[0] === "symbolic-ref" && omitGitOutput === "branch") return { status: 128, stderr: "cannot read the current branch" };
      if (args[1] === "--abbrev-ref" && omitGitOutput === "upstream") return { status: 0, stderr: "" };
      if (args[1] === "--abbrev-ref" && omitGitOutput === "upstream-slash") return { status: 0, stdout: "origin/\n" };
      return realGitTry(cwd, args, options);
    },
    overrides: { withActiveCommandFence: (command, run) => { commands.push(command); return run(); } },
  });
  const before = git(world.remote, ["rev-parse", "main"]);
  assert.deepEqual(world.svc.pushAfterLifecycleSync(), { pushed: true });
  assert.deepEqual(world.svc.pushAfterLifecycleSync({
    pushFn: () => ({ status: 0, stdout: "", stderr: "" }),
  }), { pushed: true });
  for (const [omitted, detail] of [
    ["branch", /there is no branch to push/],
    ["upstream", /no upstream configured.*refusing to guess/],
    ["upstream-slash", /no upstream branch resolved.*origin\//],
  ]) {
    omitGitOutput = omitted;
    const failed = world.svc.pushAfterLifecycleSync();
    assert.equal(failed.pushed, false);
    assert.equal(failed.reason, "no-upstream-or-remote");
    assert.match(failed.detail, detail);
  }
  assert.deepEqual(commands, ["sync", "sync"]);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
});

test("board publication stops on absent branch, upstream or Git root output", async (t) => {
  for (const [label, match, refusal] of [
    ["branch", ([command]) => command === "symbolic-ref", /detached-head/],
    ["upstream", ([command, flag]) => command === "rev-parse" && flag === "--abbrev-ref", /no-upstream/],
    ["Git root", ([command, flag]) => command === "rev-parse" && flag === "--show-toplevel", /Cannot resolve the Git top-level/],
  ]) {
    await t.test(label, (entry) => {
      const calls = [];
      const world = makePublishWorld(entry, { gitTry: (cwd, args, options) => {
        calls.push(args);
        return match(args) ? { status: 0, stderr: "" } : realGitTry(cwd, args, options);
      } });
      const before = git(world.repo, ["rev-parse", "HEAD"]);
      const pending = "pending canonical change\n";
      fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), pending);
      assert.throws(() => world.svc.publishBoardState({
        quiet: true,
        pushFn: () => assert.fail("publication without a verified base must not push"),
      }), refusal);
      assert.ok(calls.some(match));
      assert.equal(calls.some(([command]) => command === "show" || command === "commit"), false);
      assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
      assert.equal(git(world.remote, ["rev-parse", "main"]), before);
      assert.equal(world.readCoord("QUESTIONS.md"), pending);
    });
  }
});

test("COORD-1052: unavailable Git top-level cannot establish a board publication base", async (t) => {
  for (const unavailable of [null, { status: 128, stderr: "fixture Git root unavailable" }]) {
    await t.test(unavailable ? "failed lookup" : "missing result", (t) => {
      const calls = [];
      const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
        calls.push([...args]);
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return unavailable;
        return realGitTry(cwd, args, options);
      } });
      const before = git(world.repo, ["rev-parse", "HEAD"]);
      const remoteBefore = git(world.remote, ["rev-parse", "main"]);
      fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "pending governed question\n");
      assert.throws(() => world.svc.publishBoardState({ quiet: true }), /Cannot resolve the Git top-level for board publication/);
      assert.equal(calls.some((args) => ["add", "commit", "push"].includes(args[0])), false);
      assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
      assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore);
      assert.equal(world.readCoord("QUESTIONS.md"), "pending governed question\n");
    });
  }
});

test("COORD-1052: an absent changed-ticket fence refuses before board commit or publication", (t) => {
  const initial = { sections: [{ rows: [{ ID: "COORD-900", Status: "doing", Owner: "claudea1" }] }] };
  const requested = [];
  const world = makePublishWorld(t, { boardSeed: initial, decisionFenceForTicket: (ticket) => {
    requested.push(ticket);
    return null;
  } });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const remoteBefore = git(world.remote, ["rev-parse", "main"]);
  const changed = structuredClone(initial);
  changed.sections[0].rows[0].Status = "review";
  const bytes = JSON.stringify(changed) + "\n";
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), bytes);
  assert.throws(() => world.svc.publishBoardState({ quiet: true }), /Cannot establish the attempt coordination remote for changed board ticket COORD-900/);
  assert.deepEqual(requested, ["COORD-900"]);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore);
  assert.equal(world.readCoord("board/tasks.json"), bytes);
});


test("COORD-1052: an unclassified opt-in push failure stays failed and reports a bounded fallback", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    let calls = 0;
    const result = syncSvc.pushAfterLifecycleSync({
      verb: "finalize",
      repoRoot: "/private/coord",
      pushFn: () => { calls += 1; return { status: 1, stdout: "", stderr: "" }; },
    });
    assert.deepEqual(result, { pushed: false, failed: true, detail: "" });
    assert.equal(calls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /push failed: unknown error/);
    assert.match(warnings[0], /local sync commit succeeded/);
  } finally {
    console.warn = originalWarn;
  }
});


test("COORD-1052: sync preview tolerates the legacy injected shape without a board reader", () => {
  let regenerationCalls = 0;
  const svc = createSyncProvenance({
    withGovernanceMutation: (_metadata, operation) => operation(),
    detectGovernanceProvenanceDrift: () => ({ drift: [] }),
    splitGovernanceProvenanceDrift: (drift) => ({ blocking: drift, warnings: [] }),
    state: { QUESTIONS_PATH: "/private/coord/QUESTIONS.md" },
    runBoardSync: () => { regenerationCalls += 1; },
    canonicalSyncablePaths: () => ["rendered/TASKS.md"],
    computeSyncDelta: () => ["rendered/TASKS.md"],
    isInsideGitWorkTree: () => true,
    relativeCoordPath: (value) => value,
    getRows: (board) => board?.sections?.flatMap((section) => section.rows || []) || [],
    isDoingStatus: (status) => status === "doing",
    findLockForTicket: () => null,
    isStaleTicketLock: () => false,
    resolveCurrentAgentId: () => null,
    gitTry: () => ({ status: 0, stdout: "", stderr: "" }),
    advanceGovernanceProvenanceBaseline: () => true,
    fail: (message) => { throw new Error(message); },
    COORD_DIR: "/private/coord",
    DEFAULT_PATHS: { boardPath: "/private/coord/board/tasks.json" },
  });
  const preview = svc.runSyncCommand({ quiet: true });
  assert.equal(preview.committed, false);
  assert.deepEqual(preview.delta, ["rendered/TASKS.md"]);
  assert.equal(regenerationCalls, 1, "the injected safety path may treat an unavailable board reader as no board");
});

test("COORD-1052: a first board on an existing upstream captures every new ticket before publication", (t) => {
  const captured = [], checked = [];
  const world = makePublishWorld(t, {
    decisionFenceForTicket: (ticket) => { captured.push(ticket); return { status: "legacy-absent", ticket }; },
    assertTicketFence: (ticket, fence) => { checked.push(ticket); assert.equal(fence.ticket, ticket); },
  });
  // The upstream exists but predates adoption of the canonical board layout.
  git(world.repo, ["rm", "coord/board/tasks.json"]);
  git(world.repo, ["commit", "-m", "fixture upstream without a canonical board"]);
  git(world.repo, ["push", "origin", "main:main"]);
  const before = git(world.remote, ["rev-parse", "main"]);
  const board = { sections: [{ rows: [
    { ID: "COORD-901", Status: "todo", Owner: "" },
    { ID: "COORD-900", Status: "doing", Owner: "claudea1" },
  ] }] };
  const bytes = JSON.stringify(board) + "\n";
  fs.mkdirSync(path.join(world.coord, "board"), { recursive: true });
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), bytes);
  const result = world.svc.publishBoardState({ quiet: true });
  assert.equal(result.committed, true);
  assert.equal(result.push.pushed, true);
  assert.equal(result.ticket_fence_count, 2);
  assert.deepEqual(captured, ["COORD-900", "COORD-901"]);
  assert.deepEqual(checked, captured);
  assert.notEqual(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(git(world.remote, ["show", "main:coord/board/tasks.json"]).trim(), bytes.trim());
});

test("COORD-1052: a missing fetched-board result refuses without mistaking it for a nonexistent board", (t) => {
  const calls = [];
  const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
    calls.push([...args]);
    if (args[0] === "show" && args[1].startsWith("FETCH_HEAD:")) return null;
    return realGitTry(cwd, args, options);
  } });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const bytes = "pending question retained after unreadable base\n";
  fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), bytes);
  assert.throws(() => world.svc.publishBoardState({ quiet: true }), /Could not read fetched board publication base/);
  assert.equal(calls.some((args) => ["add", "commit", "push"].includes(args[0])), false);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(world.readCoord("QUESTIONS.md"), bytes);
});

test("COORD-1052: detached or untracked board publication leaves commits and remote refs unchanged", (t) => {
  const world = makePublishWorld(t);
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const remoteBefore = git(world.remote, ["rev-parse", "main"]);
  fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "unpublished board change\n");

  git(world.repo, ["checkout", "--detach", "HEAD"]);
  assert.throws(() => world.svc.publishBoardState({ quiet: true }), /publication base \(detached-head\)/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);

  git(world.repo, ["checkout", "main"]);
  git(world.repo, ["branch", "--unset-upstream"]);
  assert.throws(() => world.svc.publishBoardState({ quiet: true }), /publication base \(no-upstream\)/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), remoteBefore);
  assert.equal(world.readCoord("QUESTIONS.md"), "unpublished board change\n");
});

test("COORD-1052: an off-Git terminal sync recognizes a plain-text adapter error", () => {
  const result = syncSvc.autoSyncAfterLifecycle({
    verb: "finalize",
    options: {},
    syncFn(options) {
      assert.equal(options.currentTicketId, null);
      // Some adapters report the original subprocess error as a string.
      throw "fatal: not a git repository";
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "coord-root-not-a-git-repo");
});

test("board publication reports the exact fenced delta for a legacy board adapter", (t) => {
  const before = { sections: [
    { rows: [{ ID: "COORD-900", Status: "todo" }, { ID: "COORD-901", Status: "todo" }] },
    { heading: "Notes" },
  ] };
  const captured = [];
  const checked = [];
  const world = makePublishWorld(t, {
    boardSeed: before,
    overrides: {
      getRows: undefined,
      detectGovernanceProvenanceDrift: () => ({ currentSnapshot: { files: [] } }),
    },
    decisionFenceForTicket: (ticket) => {
      captured.push(ticket);
      return { status: "legacy-absent", ticket };
    },
    assertTicketFence: (ticket, fence) => {
      assert.equal(fence.ticket, ticket);
      checked.push(ticket);
    },
  });
  const after = { sections: [
    { heading: "Notes" },
    { rows: [{ ID: "COORD-902", Status: "todo" }, { ID: "COORD-900", Status: "deferred" }] },
  ] };
  const bytes = JSON.stringify(after) + "\n";
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), bytes);
  const logs = [];
  t.mock.method(console, "log", (message) => logs.push(message));
  const result = world.svc.publishBoardState();
  assert.equal(result.committed, true);
  assert.equal(result.push.pushed, true);
  assert.equal(result.ticket_fence_count, 3);
  assert.deepEqual(captured, ["COORD-900", "COORD-901", "COORD-902"]);
  assert.deepEqual(checked, captured);
  assert.deepEqual(logs.map(JSON.parse), [result]);
  assert.deepEqual(JSON.parse(git(world.remote, ["show", "main:coord/board/tasks.json"])), after);
});

test("legacy publication fences each new row when the fetched board has no sections", (t) => {
  const fenced = [];
  const world = makePublishWorld(t, {
    boardSeed: { tasks: [] },
    overrides: { getRows: undefined },
    decisionFenceForTicket: (ticket) => { fenced.push(ticket); return { status: "legacy-absent" }; },
  });
  const current = { sections: [{ rows: [{ ID: "COORD-900", Status: "todo" }] }] };
  fs.writeFileSync(path.join(world.coord, "board", "tasks.json"), JSON.stringify(current));
  const summary = world.svc.publishBoardState({ quiet: true });
  assert.deepEqual(fenced, ["COORD-900"]);
  assert.equal(summary.ticket_fence_count, 1);
  assert.equal(summary.push.pushed, true);
  assert.deepEqual(JSON.parse(git(world.remote, ["show", "main:coord/board/tasks.json"])), current);
});

test("board publication refuses unaccounted work even if a legacy adapter has no board reader", (t) => {
  const world = makePublishWorld(t, { overrides: { readBoard: undefined } });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const dirty = path.join(world.coord, "unaccounted.txt");
  fs.writeFileSync(dirty, "workspace-only data\n");
  assert.throws(() => world.svc.publishBoardState({
    quiet: true,
    pushFn: () => assert.fail("unaccounted work must not lead to a push"),
  }), /unaccounted path.*unaccounted\.txt/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(fs.readFileSync(dirty, "utf8"), "workspace-only data\n");
});

test("board publication requires a configured canonical board path before making a commit", (t) => {
  const world = makePublishWorld(t, { overrides: { DEFAULT_PATHS: { boardBranch: "main", boardLanding: "push" } } });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const pending = "pending canonical change\n";
  fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), pending);
  assert.throws(() => world.svc.publishBoardState({
    quiet: true,
    pushFn: () => assert.fail("a board with no canonical path must not be pushed"),
  }), /Cannot resolve the canonical board path for publication/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(world.readCoord("QUESTIONS.md"), pending);
});

test("board publication preserves an unrelated dirty file above the coord directory", (t) => {
  const world = makePublishWorld(t);
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const unrelated = path.join(world.repo, "local-notes.txt");
  fs.writeFileSync(unrelated, "unrelated local data\n");
  assert.throws(() => world.svc.publishBoardState({
    quiet: true,
    pushFn: () => assert.fail("an unrelated dirty file must block publication"),
  }), /unaccounted path\(s\).*local-notes\.txt/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated local data\n");
});

test("an undiagnosed board push failure retains one local commit for retry", (t) => {
  const world = makePublishWorld(t);
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), "pending publication\n");
  assert.throws(() => world.svc.publishBoardState({ quiet: true, pushFn: () => ({ status: 1 }) }),
    /commit is local but was not published \(push refused\)/);
  assert.match(warnings.join("\n"), /push failed: unknown error/);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  const candidate = git(world.repo, ["rev-parse", "HEAD"]);
  assert.equal(git(world.repo, ["rev-list", "--count", `${before}..${candidate}`]), "1");
  const retry = world.svc.publishBoardState({ quiet: true });
  assert.equal(retry.committed, false);
  assert.equal(retry.push.pushed, true);
  assert.equal(git(world.remote, ["rev-parse", "main"]), candidate);
});

test("an absent upstream branch requires a new decision fence for each local board row", (t) => {
  const board = { sections: [{ rows: [{ ID: "COORD-900", Status: "todo" }] }] };
  const captured = [];
  const world = makePublishWorld(t, {
    boardSeed: board,
    decisionFenceForTicket: (ticket) => { captured.push(ticket); return null; },
  });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  // Removing the branch on the fixture remote leaves its local tracking ref
  // present, so the empty ls-remote response determines the publication base.
  git(world.remote, ["update-ref", "-d", "refs/heads/main"]);
  assert.equal(git(world.repo, ["rev-parse", "main@{upstream}"]), before);
  assert.throws(() => world.svc.publishBoardState({
    quiet: true,
    pushFn: () => assert.fail("an unfenced local row must not be published"),
  }), /Cannot establish the attempt coordination remote.*COORD-900/);
  assert.deepEqual(captured, ["COORD-900"]);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(realGitTry(world.remote, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).status, 1);
});

test("a terminal branch tracking only a local ref stays unpublished when origin is absent", (t) => {
  const world = makePublishWorld(t);
  const before = git(world.remote, ["rev-parse", "main"]);
  git(world.repo, ["branch", "local-base", "HEAD"]);
  git(world.repo, ["branch", "--set-upstream-to=local-base", "main"]);
  git(world.repo, ["remote", "remove", "origin"]);
  assert.equal(git(world.repo, ["rev-parse", "--abbrev-ref", "main@{upstream}"]), "local-base");
  const result = world.svc.pushAfterLifecycleSync({ verb: "finalize" });
  assert.equal(result.pushed, false);
  assert.equal(result.reason, "no-upstream-or-remote");
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
});

test("a successful board lookup without content still refuses publication", (t) => {
  const world = makePublishWorld(t, { gitTry: (cwd, args, options) => {
    const result = realGitTry(cwd, args, options);
    if (args[0] === "show" && args[1].startsWith("FETCH_HEAD:")) {
      assert.equal(result.status, 0);
      assert.ok(result.stdout.length > 0);
      return { ...result, stdout: "" };
    }
    return result;
  } });
  const before = git(world.repo, ["rev-parse", "HEAD"]);
  const pending = "pending canonical change\n";
  fs.writeFileSync(path.join(world.coord, "QUESTIONS.md"), pending);
  assert.throws(() => world.svc.publishBoardState({
    quiet: true,
    pushFn: () => assert.fail("an empty board lookup must not lead to a push"),
  }), /Board publication base .* is unreadable/);
  assert.equal(git(world.repo, ["rev-parse", "HEAD"]), before);
  assert.equal(git(world.remote, ["rev-parse", "main"]), before);
  assert.equal(world.readCoord("QUESTIONS.md"), pending);
});
