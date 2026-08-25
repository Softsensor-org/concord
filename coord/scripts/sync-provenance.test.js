"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const createSyncProvenance = require("./sync-provenance.js");
const lifecycleModule = require("./lifecycle.js");
const cliModule = require("./cli.js");
const { gitTry: realGitTry } = require("./git-ops.js");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "coord-test",
      GIT_AUTHOR_EMAIL: "coord-test@example.invalid",
      GIT_COMMITTER_NAME: "coord-test",
      GIT_COMMITTER_EMAIL: "coord-test@example.invalid",
    },
  }).trim();
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
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(local, ["init", "--initial-branch=main"]);
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

test("COORD-292/696 wiring: createSyncProvenance returns exactly the nine public functions", () => {
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

test("COORD-275: autoSyncAfterLifecycle forwards the EXACT scope set to the scope-checked advance — in-scope absorbed, out-of-scope refused (preserved)", () => {
  const canonical = ["rendered/TASKS.md"];
  // Stub the injected journal advance to mimic the COORD-275 scope check: it
  // ABSORBS (true) only when every drifting path is within the supplied scope,
  // and REFUSES (false) — preserving the drift — when an out-of-band path leaks.
  const driftingPaths = ["board/tasks.json", "prompts/tickets/COORD-999.md"];
  let forwardedScope = null;
  const svc = createSyncProvenance({
    canonicalSyncablePaths: () => canonical.slice(),
    COORD_DIR: "/repo/coord",
    DEFAULT_PATHS: { boardPath: "/repo/coord/board/tasks.json" },
    advanceGovernanceProvenanceBaseline: (label, opts) => {
      forwardedScope = (opts && opts.scopePaths) || null;
      const scoped = forwardedScope || [];
      const absorbed = driftingPaths.every((p) => scoped.includes(p));
      return absorbed;
    },
  });
  const result = svc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "COORD-292",
    options: {},
    syncFn: () => ({ committed: true, delta: ["board/tasks.json", "rendered/TASKS.md"] }),
  });
  assert.equal(result.skipped, false);
  // The wrapper forwarded ONLY the authorized scope (canonical + board json) —
  // the concurrent out-of-band prompt edit is NOT in that scope...
  assert.ok(forwardedScope.includes("board/tasks.json"));
  assert.ok(forwardedScope.includes("rendered/TASKS.md"));
  assert.ok(!forwardedScope.includes("prompts/tickets/COORD-999.md"),
    "out-of-band path must never be added to the forwarded scope");
  // ...so the scope-checked advance REFUSES (the out-of-scope drift is preserved
  // as detectable, never silently re-baselined).
  // (driftingPaths includes an out-of-scope path -> absorbed === false above.)
});

test("COORD-275/246: when the only drift is in-scope (the mutation's own board json), the scoped advance absorbs it (no spurious post-finalize drift)", () => {
  const canonical = ["rendered/TASKS.md"];
  const inScopeOnlyDrift = ["board/tasks.json", "rendered/TASKS.md"];
  let absorbed = null;
  const svc = createSyncProvenance({
    canonicalSyncablePaths: () => canonical.slice(),
    COORD_DIR: "/repo/coord",
    DEFAULT_PATHS: { boardPath: "/repo/coord/board/tasks.json" },
    advanceGovernanceProvenanceBaseline: (label, opts) => {
      const scoped = (opts && opts.scopePaths) || [];
      absorbed = inScopeOnlyDrift.every((p) => scoped.includes(p));
      return absorbed;
    },
  });
  svc.autoSyncAfterLifecycle({
    verb: "finalize",
    ticketId: "COORD-292",
    options: {},
    syncFn: () => ({ committed: true }),
  });
  assert.equal(absorbed, true, "the mutation's own in-scope derived drift must be absorbed (COORD-246)");
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
  currentTicketId = null,
  staleLock = false,
  liveTicket = "OTHER-1",
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
          }
        : null
    ),
    isStaleTicketLock: () => staleLock,
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
