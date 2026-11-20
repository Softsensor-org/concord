"use strict";

// Wave 2 (COORD-063): the MUTATING governance repair / recovery surface
// extracted from lifecycle.js — doctorFix (the `doctor --fix` repair pass),
// reconcileGovernance (manual provenance-drift reconcile) and recoverTicket
// (per-ticket lock / ownership / drift repair), plus doctorFix's private
// session-mirror rebuild helper repairSessionMirrorFromCanonicalLock.
//
// This is the safety net an operator (or an agent) uses to fix a broken
// governance state, so the module is a thin, dependency-injected wrapper:
// every cross-module primitive (board-state readers/mutators, lock / worktree
// helpers, agent-session + identity helpers, journal withGovernanceMutation /
// inferTicketStatus, provenance-drift detection, plan-stub / drift-note repair,
// and the read-only doctor-scope + next-command builders) is injected rather
// than re-implemented here. The READ-ONLY diagnostic `doctor` report stays in
// lifecycle.js and delegates to the injected-back doctorFix only on `--fix`.
//
// `state`, COORD_DIR and GOVERNANCE_EVENT_LOCK_STALE_MS are required directly
// from governance-context so this module shares the SAME live `state`
// singleton lifecycle uses (the __testing facade mutates
// state.GOVERNANCE_EVENT_LOCK_DIR, and the repair pass must observe that).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { appendSessionBinding, stampSessionBinding } = require("./session-binding-order.js");
const approvalVerifier = require("./approval-verifier.js");
// COORD-725 (upstream CUST-013): shared with the transfer path so both rebuild a
// missing lock through one verified resolution instead of two similar ones.
const { restoreMissingTicketLock, verifyTicketWorktree } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/missing-ticket-lock.js"));
const {
  defaultFail,
  COORD_DIR,
  state,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
} = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");
const { inspectMaterializedViews } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/canonical-derived-authority.js"));
const { parseReconcilePacket, assertReconcileSnapshotMatchesPacket } = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/reconcile-packet.js"));
const treeMutationSafety = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/tree-mutation-safety.js"));
const { resolveEngineModule } = require("../../paths.js");
// COORD-1003: the one owner-liveness verdict (process-identity.js), start-time aware.
const { ownerLiveness } = require("./process-identity.js");
// COORD-862 (COORD-516a): per-scope reconcile.
const driftScope = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/drift-scope.js"));
const createJournalDriftScope = require(resolveEngineModule(path.join(__dirname, "..", ".."), "scripts/journal-drift-scope.js"));
const RECONCILE_SCOPES = [driftScope.DRIFT_SCOPES.GOVERNED, driftScope.DRIFT_SCOPES.DERIVED, driftScope.DRIFT_SCOPES.RUNTIME];

module.exports = function createDoctorRecovery(deps = {}) {
  const fail = deps.fail || defaultFail;

  const {
    // board-state readers / mutators
    readBoard,
    writeBoard,
    getTicketRef,
    runBoardSync,
    // journal (wired after createJournal)
    withGovernanceMutation,
    inferTicketStatus,
    // runtime locks
    withAgentStateLock,
    withCoordStateLock,
    // doctor scope / next-command builders (read-only, stay in lifecycle)
    resolveDoctorScope,
    buildTicketNextCommands,
    // agent sessions + identity
    readAgentSessions,
    normalizeAgentSessions,
    writeJsonFile,
    defaultHostLabel,
    resolveEffectiveThreadId,
    reapIdleAutoClaimedProviderStubs,
    // COORD-092: provenance-scoped gate process-orphan reaper. Kills ONLY
    // recorded PIDs whose owning gate-run/ticket is gone, guarded by the
    // recorded-PID start-time reuse check. Injected so doctorFix can reap during
    // the board-wide repair pass without owning the registry module.
    reapGateProcOrphans,
    readAgentsRegistry,
    resolveAgentIdentifier,
    findActiveSessionForHandle,
    canonicalizeOwnerOrFail,
    assertTicketRepairOwnership,
    // canonical-lock mirror state
    inspectCanonicalLockMirrorState,
    findLockForTicket,
    isStaleTicketLock,
    resolveCurrentAgentId,
    getLockFiles,
    resolveTicketLockPath,
    readLockFileState,
    isCompleteLockPayload,
    writeLock,
    resolveLockHead,
    // plan-stub + drift-note repair
    readPlanRecord,
    ensurePlanStub,
    applyRetireStaleDriftNotes,
    // worktree audit / cleanup
    auditCoordWorktrees,
    pruneEmptyParents,
    coordWorktreesRoot,
    defaultWorktreePath,
    resolveTicketGitContext,
    // provenance drift
    detectGovernanceProvenanceDrift,
    isRecoverableGovernanceDriftPath,
    formatGovernanceDriftMessage,
    // misc utilities
    safeReadJson,
    relativeCoordPath,
    readDirectoryLockMetadata,
    isProcessAlive,
    // COORD-1003: optional readers for the start-time and zombie checks; undefined reads the real /proc.
    readProcessStartTime,
    readProcessState,
    repoNameForCode,
    isRepoBackedCode,
    isDoingStatus,
    resolveHumanAdminOverride,
    appendGovernanceEvent,
    approvalClient,
    gitTry,
    canonicalSyncablePaths,
    identityV2,
  } = deps;

  function doctorFixAllowedPaths() {
    const paths = typeof canonicalSyncablePaths === "function"
      ? canonicalSyncablePaths().slice()
      : [];
    for (const entry of [
      "board/tasks.json",
      "QUESTIONS.md",
      ".runtime/locks",
      ".runtime/agent_sessions.json",
      ".runtime/agents.json",
      ".runtime/gate-procs",
    ]) {
      if (!paths.includes(entry)) {
        paths.push(entry);
      }
    }
    return paths;
  }

  function assertDoctorFixSafety(options = {}) {
    if (options.ticket) {
      return;
    }
    const board = readBoard();
    treeMutationSafety.assertNoUnsafeTreeMutation({
      gitTry,
      repoRoot: COORD_DIR,
      allowedPaths: doctorFixAllowedPaths(),
      board,
      getRows: (candidateBoard) => resolveDoctorScope(candidateBoard, null).rows,
      isDoingStatus,
      findLockForTicket,
      isStaleTicketLock,
      currentTicketId: options.ticket || null,
      resolveCurrentAgentId,
      fail,
    });
  }

  function printRepairAllDryRun(options = {}) {
    const scope = options.ticket ? `ticket ${options.ticket}` : "board-wide";
    const steps = [
      "Run read-only doctor diagnostics first.",
      "Apply existing deterministic doctor --fix repairs for drift, stale locks, malformed locks, orphan coord worktrees, missing governed plan stubs, gate-proc orphans, and stale drift-note retirement.",
      "Refuse unsafe tree-wide mutation when non-derived working-tree changes coexist with any live ticket lock, including the caller's own.",
      "Leave journal hash-chain repair explicit: run gov repair-chain --confirm --reason \"...\" only when conform reports a broken chain.",
      "Run gov recover <ticket> for ticket-specific lock/ownership repair when a scoped ticket remains unhealthy after the deterministic pass.",
    ];
    const payload = {
      command: "doctor --repair-all",
      mode: "dry-run",
      scope,
      status: "planned",
      planned_steps: steps,
      apply_command: options.ticket
        ? `coord/scripts/gov doctor --repair-all --confirm --ticket ${options.ticket}`
        : "coord/scripts/gov doctor --repair-all --confirm",
      destructive_actions: "none in dry-run",
      confirmation_required: true,
    };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  function canonicalSessionActivity(lock) {
    const claimedAt = lock.started_at_utc || lock.heartbeat_utc;
    const lastSeenAt = lock.heartbeat_utc || lock.started_at_utc;
    const now = Date.now();
    if ([claimedAt, lastSeenAt].some((value) => typeof value !== "string" ||
      !Number.isFinite(Date.parse(value)) || Date.parse(value) > now)) {
      fail(`Ticket ${lock.ticket} canonical lock lacks valid historical activity; use governed owner recovery.`);
    }
    return { claimedAt, lastSeenAt };
  }

  function repairSessionMirrorFromCanonicalLock({ row, lock, canonicalOwner, agent, sessionRepair, sessions }) {
    if (!lock?.session_id || !sessionRepair || !canonicalOwner) {
      return null;
    }
    // The canonical mirror inspection has accepted the ticket and complete lock.
    const { claimedAt, lastSeenAt } = canonicalSessionActivity(lock);
    const threadId = typeof lock.thread_id === "string" && lock.thread_id.trim() ? lock.thread_id.trim() : null;

    if (sessionRepair.mode === "normalize" && sessionRepair.existing) {
      const existing = sessionRepair.existing;
      // Conflicting handles and inactive bindings are refused before repair.
      const previousHandle = existing.handle;
      const previousStatus = existing.status;
      const previousThreadId = typeof existing.thread_id === "string" && existing.thread_id.trim()
        ? existing.thread_id.trim()
        : null;
      existing.agent_id = agent?.id || null;
      existing.handle = canonicalOwner;
      existing.session_label = existing.session_label || `rebuild:${row.ID.toLowerCase()}`;
      existing.host = existing.host || defaultHostLabel();
      existing.cwd = existing.cwd || lock.worktree;
      existing.board_path = state.BOARD_PATH;
      existing.board_root = COORD_DIR;
      if (threadId) {
        existing.thread_id = threadId;
      } else if (!existing.thread_id) {
        existing.thread_id = null;
      }
      existing.claimed_at = existing.claimed_at || claimedAt;
      if (existing.status === "active") {
        existing.last_seen_at = existing.last_seen_at || existing.claimed_at;
        existing.released_at = null;
      }
      Object.assign(existing, normalizeAgentSessions([existing]).sessions[0]);
      existing.auto_claimed = existing.auto_claimed === true;
      stampSessionBinding(sessions, existing);
      return {
        type: "normalized_session_binding_from_canonical_lock",
        ticket: row.ID,
        session_id: lock.session_id,
        owner: canonicalOwner,
        previous_handle: previousHandle,
        previous_status: previousStatus,
        previous_thread_id: previousThreadId,
        thread_id: existing.thread_id || null,
      };
    }

    const rebuiltSession = {
      session_id: lock.session_id,
      agent_id: agent?.id || null,
      handle: canonicalOwner,
      session_label: `rebuild:${row.ID.toLowerCase()}`,
      host: defaultHostLabel(),
      cwd: lock.worktree,
      board_path: state.BOARD_PATH,
      board_root: COORD_DIR,
      thread_id: threadId,
      claimed_at: claimedAt,
      last_seen_at: lastSeenAt,
      released_at: null,
      status: "active",
      auto_claimed: false,
    };
    appendSessionBinding(sessions, normalizeAgentSessions([rebuiltSession]).sessions[0]);
    return {
      type: "created_session_binding_from_canonical_lock",
      ticket: row.ID,
      session_id: lock.session_id,
      owner: canonicalOwner,
    };
  }

  function doctorFix(options = {}) {
    if (options.repairAll && !options.confirm && !options.yes) {
      return printRepairAllDryRun(options);
    }
    assertDoctorFixSafety(options);
    const mutation = {
      command: options.repairAll ? "doctor-repair-all" : "doctor-fix",
      ticket: options.ticket || null,
      allowProvenanceDrift: true,
    };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const { targetRef, rows: targetRows, byId: rowsById } = resolveDoctorScope(board, options.ticket || null);
      const repairs = [];
      let syncNeeded = false;
      let boardChanged = false;

      if (options.ticket) {
        withAgentStateLock(() => {
          const sessions = readAgentSessions();
          let sessionStateChanged = false;
          for (const row of targetRows) {
            const canonicalLock = findLockForTicket(row.ID);
            if (!canonicalLock || canonicalLock.status !== STATUS.DOING || isStaleTicketLock(canonicalLock)) {
              continue;
            }
            if (canonicalLock.session_id) canonicalSessionActivity(canonicalLock);
            const mirrorState = inspectCanonicalLockMirrorState({
              board,
              row,
              lock: canonicalLock,
              sessions,
            });
            if (mirrorState.conflicts.length > 0) {
              fail(
                `Ticket ${row.ID} canonical lock cannot rebuild mirrored state deterministically:\n` +
                `${mirrorState.conflicts.map((entry) => `- ${entry}`).join("\n")}`
              );
            }
            if (!mirrorState.requiresRepair) {
              continue;
            }
            if (mirrorState.boardRepairNeeded && mirrorState.canonicalOwner) {
              const previousStatus = row.Status;
              const previousOwner = row.Owner;
              row.Status = STATUS.DOING;
              row.Owner = mirrorState.canonicalOwner;
              boardChanged = true;
              syncNeeded = true;
              repairs.push({
                type: "rebuilt_board_from_canonical_lock",
                ticket: row.ID,
                previous_status: previousStatus,
                previous_owner: previousOwner,
                status: row.Status,
                owner: row.Owner,
              });
            }
            const sessionRepair = repairSessionMirrorFromCanonicalLock({
              row,
              lock: canonicalLock,
              canonicalOwner: mirrorState.canonicalOwner,
              agent: mirrorState.agent,
              sessionRepair: mirrorState.sessionRepair,
              sessions,
            });
            if (sessionRepair) {
              sessionStateChanged = true;
              repairs.push(sessionRepair);
            }
          }
          if (sessionStateChanged) {
            writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
          }
        });
      }

      for (const row of targetRows) {
        // COORD-371: this read is ONLY an existence check for shouldSeedPlanStub
        // below; the record contents are never used. readPlanRecord performs a
        // normalizing repair-WRITE by default (plan-records.js), so without
        // skipRepairWrite a board-wide `doctor --fix` rewrote every plan record
        // whose normalized form differed (observed: 229 records re-stamped,
        // current-schema fields stripped) — violating the §11.1 non-destructive
        // doctor-repair scope. Skip the repair-write: doctor --fix must never
        // rewrite an existing plan record it is not explicitly repairing.
        const planRecord = readPlanRecord(row.ID, { allowMissing: true, skipRepairWrite: true });
        const shouldSeedPlanStub =
          (!planRecord && (isDoingStatus(row.Status) || row.Status === STATUS.REVIEW)) ||
          (options.ticket === row.ID && !planRecord);
        if (!shouldSeedPlanStub) {
          continue;
        }
        const owner = row.Owner && row.Owner !== "unassigned" ? row.Owner : "unassigned";
        const preparation = ensurePlanStub(row.ID, row.Repo, owner);
        repairs.push({
          type: "ensured_plan_stub",
          ticket: row.ID,
          source: preparation.source,
          created_markdown_block: preparation.createdMarkdownBlock,
        });
        syncNeeded = true;
      }

      for (const lockPath of getLockFiles()) {
        const lock = safeReadJson(lockPath);
        if (!lock || !lock.ticket) {
          continue;
        }
        if (targetRef && lock.ticket !== targetRef.row.ID) {
          continue;
        }
        const row = rowsById.get(lock.ticket) || null;
        const heartbeatAt = Number.isFinite(Date.parse(lock.heartbeat_utc || ""))
          ? Date.parse(lock.heartbeat_utc)
          : null;
        const stale = heartbeatAt !== null && Date.now() - heartbeatAt > 24 * 60 * 60 * 1000;

        const requiredLockFields = ["owner", "ticket", "status", "repo", "branch", "worktree", "started_at_utc", "heartbeat_utc"];
        const missingFields = requiredLockFields.filter((field) => !lock[field]);
        if (missingFields.length > 0 && row && isDoingStatus(row.Status)) {
          const activity = lock.session_id ? canonicalSessionActivity(lock) : null;
          const repairedLock = {
            ...lock,
            owner: lock.owner || row.Owner || "unknown",
            ticket: lock.ticket,
            status: STATUS.DOING,
            repo: lock.repo || repoNameForCode(row.Repo),
            branch: lock.branch || `agent/${(lock.owner || row.Owner || "unknown").toLowerCase()}-${lock.ticket.toLowerCase()}`,
            worktree: lock.worktree || defaultWorktreePath(row.Repo, lock.owner || row.Owner || "unknown", lock.ticket),
            started_at_utc: activity?.claimedAt || lock.started_at_utc || new Date().toISOString(),
            heartbeat_utc: activity?.lastSeenAt || lock.heartbeat_utc || new Date().toISOString(),
          };
          fs.writeFileSync(lockPath, JSON.stringify(repairedLock, null, 2) + "\n");
          repairs.push({
            type: "repaired_malformed_lock",
            ticket: lock.ticket,
            path: relativeCoordPath(lockPath),
            missing_fields: missingFields,
          });
          continue;
        }

        if (row && isDoingStatus(row.Status) && !stale) {
          continue;
        }
        // Past the keep-check above the row is gone, not doing, or the lock is
        // stale, so the lock is always released here (no second condition).
        fs.unlinkSync(lockPath);
        repairs.push({
          type: stale ? "released_stale_lock" : "released_non_doing_lock",
          ticket: lock.ticket,
          path: relativeCoordPath(lockPath),
        });
      }

      // COORD-831: doctorFix runs INSIDE withGovernanceMutation, i.e. while
      // holding this very lock, and a held lock's mtime is never refreshed.
      // While this process holds the runtime lock, skip its staleness check
      // entirely: the decision must not depend on the owner metadata, which can
      // be torn or missing and would then make our own lock look ownerless.
      const holdingRuntimeLock = state.governanceEventLockDepth > 0;
      // COORD-931: lstat, not existsSync/statSync. A dangling link is reported by
      // doctor-report and recovered only by the checked break-runtime-lock verb.
      let lockStat = null;
      try { lockStat = fs.lstatSync(state.GOVERNANCE_EVENT_LOCK_DIR); } catch { lockStat = null; }
      if (!holdingRuntimeLock && lockStat && !lockStat.isSymbolicLink()) {
        const lockAge = Date.now() - lockStat.mtimeMs;
        if (lockAge > GOVERNANCE_EVENT_LOCK_STALE_MS) {
          const metadata = readDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR);
          // A foreign lock is judged by its owner, never by age alone: a live
          // owner is kept (COORD-270); age only releases an ownerless lock.
          const ownerKnown = Number.isInteger(metadata?.pid);
          // COORD-1003: a reused pid (different start time) or a zombie is dead; an unknown start time is never dead.
          const deadOwner = ownerKnown && ownerLiveness(metadata.pid, metadata?.pid_start_time, {
            isProcessAlive,
            readProcessStartTime,
            readProcessState,
          }) === "dead";
          const ownerlessAndAged = !ownerKnown && lockAge > GOVERNANCE_EVENT_LOCK_STALE_MS * 2;
          if (deadOwner || ownerlessAndAged) {
            try {
              fs.rmSync(state.GOVERNANCE_EVENT_LOCK_DIR, { recursive: true, force: true });
              repairs.push({
                type: "released_stale_governance_lock",
                path: relativeCoordPath(state.GOVERNANCE_EVENT_LOCK_DIR),
                age_ms: lockAge,
                dead_owner: deadOwner,
              });
            } catch {
              // best effort
            }
          }
        }
      }

      for (const orphan of auditCoordWorktrees(rowsById).stale_worktrees) {
        if (targetRef && orphan.ticket !== targetRef.row.ID) {
          continue;
        }
        fs.rmSync(orphan.path, { recursive: true, force: true });
        pruneEmptyParents(orphan.path, coordWorktreesRoot());
        repairs.push({
          type: "removed_orphan_coord_worktree",
          ticket: orphan.ticket,
          path: orphan.path,
        });
      }

      if (!options.ticket) {
        const retirement = applyRetireStaleDriftNotes({ dryRun: false });
        for (const entry of retirement.retired) {
          repairs.push({
            type: "retired_stale_drift_note",
            drift_row_date: entry.date,
            drift_since: entry.since,
            baseline_ts: entry.baseline_ts,
          });
        }

        // Release idle provider sessions (no doing ticket, not the current
        // thread). Auto-claimed stubs accumulate as orphans across CLI
        // invocations when the runtime fingerprint is unstable; manually-claimed
        // sessions accumulate when windows close without `gov agent-release`
        // and never get reaped on their own (COORD-003 / COORD-010).
        withAgentStateLock(() => {
          const protectedThread = resolveEffectiveThreadId();
          const reaped = reapIdleAutoClaimedProviderStubs({
            board,
            protectedThread,
            includeManualStaleAfterMs: 24 * 60 * 60 * 1000,
          });
          for (const entry of reaped.released) {
            repairs.push({
              type: "released_idle_stub_session",
              session_id: entry.session_id,
              handle: entry.handle,
              agent_id: entry.agent_id,
            });
          }
        });

        // COORD-092: reap orphaned gate-spawned process groups. Provenance-
        // scoped — kills ONLY recorded PIDs whose owning gate-run/ticket is gone
        // and whose live start-time still matches the recorded one (PID-reuse
        // guard); never a process-name scan. Best-effort: a registry/proc error
        // must not abort the wider repair pass.
        if (typeof reapGateProcOrphans === "function") {
          try {
            const isTicketDoing = (ticketId) => {
              const ref = getTicketRef(board, ticketId);
              return Boolean(ref && isDoingStatus(ref.row.Status));
            };
            const gateReap = reapGateProcOrphans({ isTicketDoing });
            for (const entry of gateReap.reaped || []) {
              repairs.push({
                type: "reaped_orphan_gate_procs",
                gate_run_id: entry.gate_run_id,
                ticket: entry.ticket,
                repo: entry.repo,
                lane: entry.lane,
                signaled_pids: entry.signaled_pids,
                reason: entry.reason,
              });
            }
          } catch {
            // best effort — orphan-gate-proc reaping never blocks repair.
          }
        }
      }

      if (boardChanged || syncNeeded) {
        withCoordStateLock(() => {
          if (boardChanged) {
            writeBoard(board);
          }
          runBoardSync({
            ignoreActiveTicketLockErrors: true,
            currentTicketId: options.ticket || null,
          });
        });
      }

      if (repairs.length > 0) {
        mutation.details = {
          ...(mutation.details || {}),
          repairs,
        };
      }

      console.log(JSON.stringify({
        ticket: options.ticket || null,
        status: repairs.length > 0 ? "repaired" : "noop",
        repairs,
      }, null, 2));
    });
  }

  // COORD-722: `--expect-paths-file` binds a reconcile to an approved packet so
  // the override authorizes THESE bytes, not whatever is on disk when it runs.
  // It is REQUIRED whenever the override is (semantic drift or a missing
  // baseline). Accepted shapes: coord/engine/scripts/reconcile-packet.js.
  function reconcileNeedsOverride(provenance) {
    return Boolean(provenance.uninitialized || (provenance.snapshotPruned && !provenance.snapshotMatchesCurrent) ||
      provenance.drift.some((p) => !isRecoverableGovernanceDriftPath(p)));
  }

  // guard:reconcile-approved-packet
  function assertReconcileAuthorized(provenance, approval, packet) {
    if (!reconcileNeedsOverride(provenance)) return;
    if (!approval) {
      fail("Reconcile requires --human-admin-override \"<approval for these exact changes>\" to accept semantic drift or establish a missing baseline. A reason alone is not authorization.");
    }
    if (!packet) {
      fail("Reconcile requires --expect-paths-file <approved packet> with --human-admin-override: the override authorizes exactly the paths and bytes the packet lists. Generate it with `gov reconcile --dry-run` (expect_paths_packet), have it approved, then pass that file.");
    }
  }

  function reconcileApprovalState(ticketId, reason, scope, provenance, packet) {
    const snapshotFiles = provenance.currentSnapshot?.files;
    if (!Array.isArray(snapshotFiles)) {
      fail("reconcile cannot bind a signed approval without the materialized current snapshot files.");
    }
    const snapshotPaths = new Set();
    for (const entry of snapshotFiles) {
      if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("\\") ||
          entry.path.startsWith("/") || entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
          path.posix.normalize(entry.path) !== entry.path || typeof entry.exists !== "boolean" ||
          typeof entry.digest !== "string" || !/^[0-9a-f]{40}$/i.test(entry.digest) || snapshotPaths.has(entry.path)) {
        fail("reconcile cannot bind a signed approval to a malformed or duplicate current snapshot entry.");
      }
      snapshotPaths.add(entry.path);
    }
    const approvedSnapshotFiles = snapshotFiles
      .filter((entry) => journalScope.journalDriftScope(entry.path) !== driftScope.DRIFT_SCOPES.RUNTIME)
      .map(({ path: filePath, exists, digest }) => ({ path: filePath, exists, digest }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return {
      ticket: ticketId || "control-plane",
      reason,
      scope,
      drift: provenance.drift,
      // A refusal without a snapshot changes uninitialized into snapshotPruned
      // bookkeeping. Both states require establishing a baseline from the same
      // approved packet, so bind the common decision instead of that churn.
      baseline_missing: Boolean(provenance.uninitialized || provenance.snapshotPruned),
      expected_snapshot_digest: provenance.expectedSnapshotDigest || null,
      // The full snapshot digest includes recoverable runtime state (sessions
      // and locks). Bind all configured non-runtime contents, including durable
      // .runtime/plans records; the packet separately binds each adopted path
      // and its exact SHA-256 bytes.
      current_snapshot_digest: crypto.createHash("sha256")
        .update(approvalVerifier.canonicalJson(approvedSnapshotFiles)).digest("hex"),
      packet: packet ? [...packet.entries()].sort(([a], [b]) => a.localeCompare(b)) : null,
    };
  }

  function currentPathSha256(relativePath) {
    const absolute = path.resolve(COORD_DIR, relativePath);
    return fs.existsSync(absolute) ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : "absent";
  }

  // A missing/pruned baseline adopts every governed file; otherwise exactly the
  // drift. Lock/session paths never need approval, so the packet never lists
  // them (a genesis reconcile writes them itself, after the --dry-run).
  function reconcileAdoptionSet(provenance, baselineMissing) {
    const adopted = baselineMissing
      ? provenance.currentSnapshot.files.filter((entry) => entry.exists &&
        journalScope.journalDriftScope(entry.path) !== driftScope.DRIFT_SCOPES.RUNTIME).map((entry) => entry.path)
      : provenance.drift;
    return adopted.filter((entry) => !isRecoverableGovernanceDriftPath(entry));
  }

  // guard:reconcile-approved-packet
  function assertReconcilePacket(packet, adopted) {
    const unapproved = adopted.filter((entry) => !packet.has(entry));
    const absent = [...packet.keys()].filter((entry) => !adopted.includes(entry));
    const changed = adopted.filter((entry) => packet.has(entry) && packet.get(entry) !== currentPathSha256(entry))
      .map((entry) => `${entry} (approved ${packet.get(entry)}, current ${currentPathSha256(entry)})`);
    const problems = [
      unapproved.length ? `would adopt paths not in the packet: ${unapproved.join(", ")}` : "",
      absent.length ? `packet paths not drifted: ${absent.join(", ")}` : "",
      changed.length ? `bytes differ from the packet: ${changed.join(", ")}` : "",
    ].filter(Boolean);
    if (problems.length) fail(`Reconcile refused: the drift does not match the approved packet; nothing was adopted. ${problems.join("; ")}.`);
  }

  // COORD-862: classify journal drift with the seal's own classifier, so the
  // reconcile report and the refusal it answers name the same scopes.
  const journalScope = createJournalDriftScope({
    state, relativeCoordPath: (file) => path.relative(COORD_DIR, file).split(path.sep).join("/"),
  });
  function partitionReconcileDrift(provenance) {
    return journalScope.partitionJournalDrift(provenance.drift);
  }

  // `--scope` narrows the drift a reconcile considers to one scope. Paths in
  // other scopes stay drift: the event keeps their last journaled entries.
  function scopeProvenance(provenance, scope) {
    if (!scope || provenance.uninitialized || provenance.snapshotPruned) return provenance;
    const partition = partitionReconcileDrift(provenance);
    const inScope = new Set(partition[scope]);
    return { ...provenance, drift: provenance.drift.filter((entry) => inScope.has(entry)) };
  }

  function reconcileGovernance(ticketId = null, options = {}) {
    const reason = String(options.reason || "").trim();
    if (!reason) {
      fail('reconcile requires --reason "<text>".');
    }
    const scope = options.scope == null ? null : String(options.scope).trim();
    if (scope !== null && !RECONCILE_SCOPES.includes(scope)) {
      fail(`reconcile --scope must be one of ${RECONCILE_SCOPES.join(", ")}; engine drift is repaired by restoring the file or re-pinning (gov verify-engine --pin), never by reconcile.`);
    }
    const packet = options.expectPaths == null ? null : parseReconcilePacket(options.expectPaths, { coordDir: COORD_DIR, fail });
    const approval = String(options.humanAdminOverride || "").trim();

    const viewIssues = inspectMaterializedViews({ coordDir: COORD_DIR, paths: state, board: readBoard() });
    if (viewIssues.length && !options.dryRun) {
      fail(viewIssues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
    }
    const fullProvenance = detectGovernanceProvenanceDrift();
    const baselineMissing = Boolean(fullProvenance.uninitialized || fullProvenance.snapshotPruned);
    if (scope && baselineMissing) {
      fail("reconcile --scope cannot establish a missing or pruned baseline; run an unscoped reconcile with an approved packet.");
    }
    const provenance = scopeProvenance(fullProvenance, scope);
    if (packet && !options.dryRun) assertReconcilePacket(packet, reconcileAdoptionSet(provenance, baselineMissing));
    if (!viewIssues.length && !provenance.uninitialized && !provenance.snapshotPruned && provenance.drift.length === 0) {
      console.log(JSON.stringify({
        status: "noop",
        ticket: ticketId,
        reason,
        scope,
        drift: [],
      }, null, 2));
      return;
    }

    if (options.dryRun) {
      console.log(JSON.stringify({
        status: "dry_run",
        ticket: ticketId,
        reason,
        scope,
        drift: provenance.drift,
        drift_by_scope: partitionReconcileDrift(fullProvenance),
        scope_summary: driftScope.summarizeDriftScopes(partitionReconcileDrift(fullProvenance), { verb: "unjournaled" }),
        scope_remedies: driftScope.formatScopeRemedies(partitionReconcileDrift(fullProvenance)),
        would_reconcile: viewIssues.length ? 0 : provenance.drift.length,
        derived_view_issues: viewIssues,
        uninitialized: provenance.uninitialized,
        snapshot_pruned: Boolean(provenance.snapshotPruned),
        expected_snapshot_digest: provenance.expectedSnapshotDigest || null,
        current_snapshot_digest: provenance.currentSnapshot?.digest || null,
        expect_paths_packet: reconcileAdoptionSet(provenance, baselineMissing).map((entry) => `${currentPathSha256(entry)} ${entry}`),
        requires_human_admin_override: reconcileNeedsOverride(provenance),
        requires_expect_paths_file: reconcileNeedsOverride(provenance),
      }, null, 2));
      return;
    }

    assertReconcileAuthorized(provenance, approval, packet);
    const signedState = approval ? reconcileApprovalState(ticketId, reason, scope, provenance, packet) : null;
    const signedApproval = approval ? approvalVerifier.requireSignedOverride({
      commandName: "reconcile", ticketId: ticketId || "control-plane", row: signedState, options,
      deps: { resolveHumanAdminOverride, fail, appendGovernanceEvent, runtimeDir: state.RUNTIME_DIR }, approvalClient,
    }).approval : null;
    const mutation = {
      command: "manual-reconcile",
      ticket: ticketId,
      allowProvenanceDrift: true,
      // COORD-722: the only drift-tolerant verb whose event snapshot ADOPTS
      // pre-existing semantic drift (override-gated below).
      adoptProvenanceDrift: true,
      ...(scope ? { adoptDriftPaths: provenance.drift } : {}),
      forceLog: true,
      snapshotRecovery: provenance.snapshotPruned ? {
        approval,
        approvedDigest: provenance.currentSnapshot.digest,
      } : null,
      details: {
        reason,
        reconciled_drift: provenance.drift,
      },
      validateAfterSnapshot: packet
        ? (beforeSnapshot, afterSnapshot) => assertReconcileSnapshotMatchesPacket(packet, beforeSnapshot, afterSnapshot, {
          coordDir: COORD_DIR, fail,
          isRuntimePath: (entry) => journalScope.journalDriftScope(entry) === driftScope.DRIFT_SCOPES.RUNTIME,
        })
        : null,
    };

    return withGovernanceMutation(mutation, () => {
      const currentViewIssues = inspectMaterializedViews({ coordDir: COORD_DIR, paths: state, board: readBoard() });
      if (currentViewIssues.length) fail(currentViewIssues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
      const current = scopeProvenance(detectGovernanceProvenanceDrift(), scope);
      if (packet) assertReconcilePacket(packet, reconcileAdoptionSet(current, baselineMissing));
      assertReconcileAuthorized({ ...current, uninitialized: current.uninitialized || provenance.uninitialized }, approval, packet);
      if (signedState && approvalVerifier.canonicalJson(reconcileApprovalState(ticketId, reason, scope,
          { ...current, uninitialized: current.uninitialized || provenance.uninitialized }, packet)) !== approvalVerifier.canonicalJson(signedState)) {
        fail("reconcile: approved provenance or packet state changed after human approval; regenerate the packet and retry.");
      }
      mutation.details.reconciled_drift = current.drift;
      if (scope) mutation.details.reconcile_scope = scope;
      if (approval) mutation.details.human_admin_override = approval;
      if (signedApproval) Object.assign(mutation.details, { approval_record: signedApproval.record_id,
        approval_verified: `key_id=${signedApproval.key_id}`, approval_subject_sha256: signedApproval.subject_sha256,
        human_admin_session: signedApproval.session_id });
      if (packet) mutation.details.approved_packet_paths = [...packet.keys()];
      if (ticketId) {
        const board = readBoard();
        if (!getTicketRef(board, ticketId)) {
          fail(`Unknown ticket "${ticketId}".`);
        }
      }

      console.log(JSON.stringify({
        status: "reconciled",
        ticket: ticketId,
        reason,
        drift: detectGovernanceProvenanceDrift().drift,
      }, null, 2));
    });
  }

  function recoverTicket(ticketId, options = {}) {
    const mutation = {
      command: "recover",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      allowProvenanceDrift: true,
      forceLog: true,
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("recover requires <ticket-id>.");
      }

      const provenance = detectGovernanceProvenanceDrift();
      const unsafeDrift = provenance.drift.filter((entry) => !isRecoverableGovernanceDriftPath(entry));
      if (unsafeDrift.length > 0) {
        fail(formatGovernanceDriftMessage(provenance.latestEvent, provenance.drift));
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }

      const repairs = [];
      const warnings = [];
      let lockHeadRepointed = null;
      const owner = ref.row.Owner && ref.row.Owner !== "unassigned"
        ? canonicalizeOwnerOrFail(ref.row.Owner)
        : null;
      const ownerAgent = owner ? resolveAgentIdentifier(owner, readAgentsRegistry())?.agent : null;
      let activeOwnerSession = owner ? findActiveSessionForHandle(owner) : null;
      const lockPath = resolveTicketLockPath(ticketId, { promoteLegacy: true });
      const lockState = readLockFileState(lockPath);
      const lockInvalid =
        lockState.exists &&
        (
          Boolean(lockState.error) ||
          !lockState.value ||
          typeof lockState.value !== "object" ||
          Array.isArray(lockState.value) ||
          !isCompleteLockPayload(lockState.value)
        );
      let lock =
        lockState.exists && !lockInvalid
          ? { path: lockPath, ...lockState.value }
          : null;
      const lockCorrupted = lockInvalid;

      // COORD-725: a blocked ticket's status is "doing (blocked: <reason>)", so an
      // exact STATUS.DOING comparison skipped this whole branch — recover silently
      // no-opped on a blocked ticket and never ran the ownership authorization
      // below. isDoingStatus is the status-family test the rest of the file uses.
      if (isDoingStatus(ref.row.Status)) {
        if (!owner) {
          fail(`Ticket ${ticketId} is doing but has no assigned owner; recover cannot invent ownership.`);
        }
        mutation.identity = assertTicketRepairOwnership(ticketId, ref.row, options, {
          lock,
          verifyWorkspace: () => {
            const context = resolveTicketGitContext(ref.row, ticketId);
            verifyTicketWorktree(ticketId, context);
            if (context.worktree !== lock.worktree || context.branch !== lock.branch) fail("Recovery lock conflicts with registered workspace.");
          },
        });
        activeOwnerSession = findActiveSessionForHandle(owner);
        if (mutation.identity.recoveredFromSession) mutation.details = { previous_session_id: mutation.identity.recoveredFromSession };
        // COORD-725: an authorized admin repair acts on a foreign ticket without
        // taking it. Record that the owner was PRESERVED, so the journal shows a
        // repair rather than a silent ownership change.
        if (mutation.identity.agent.handle !== owner) {
          mutation.details = {
            ...(mutation.details || {}),
            owner_preserved: owner,
            override_reason: String(options.humanAdminOverride).trim(),
          };
        }
        if (!lock) {
          // COORD-725/COORD-728: a lock is rebuilt ONLY from the ticket's own
          // registered, non-detached worktree — never by inventing a directory or
          // a branch, and never by turning a canonical checkout into a lock.
          //
          // COORD-728: repo X used to get a carve-out here that checked only that
          // a directory existed at the derived path and then DERIVED the branch
          // from a slug of the description, so recovery succeeded against an
          // ordinary unregistered directory and wrote a lock naming a branch that
          // need not exist. The justification ("X has no repo to resolve a
          // registration against") was false — COORD-635 resolves X against
          // coordRepoRoot — so X now takes the same verified path as every other
          // repo. Where no control-plane repository exists the context resolves
          // all-null and the rebuild refuses, which is the truthful answer.
          if (isRepoBackedCode(ref.row.Repo) || ref.row.Repo === "X") {
            lock = restoreMissingTicketLock({
              ticketId,
              row: ref.row,
              owner,
              session: activeOwnerSession,
              resolveTicketGitContext,
              writeLock,
              findLockForTicket,
            });
          } else {
            fail(`Unsupported repo code "${ref.row.Repo}" for ${ticketId}.`);
          }
          repairs.push({
            type: lockCorrupted ? "recreated_corrupt_lock" : "recreated_lock",
            branch: lock.branch,
            worktree: lock.worktree,
            session_id: lock.session_id || null,
          });
        } else {
          const nextLock = { ...lock };
          let changed = false;
          if (nextLock.owner !== owner) {
            nextLock.owner = owner;
            nextLock.agent_id = ownerAgent?.id || null;
            changed = true;
            repairs.push({ type: "normalized_lock_owner", owner });
          }
          // GCV-1 Phase-6: recover must not re-introduce legacy session
          // authority into a v2 owner-authoritative lock. Under the durable
          // channel (or an already-v2 lock), normalize to owner authority:
          // session_id stays null, identity_model:"v2" retained.
          const v2Lock = identityV2.readEnvIdentity().present || nextLock.identity_model === "v2";
          const expectedSessionId = v2Lock ? null : activeOwnerSession?.session_id || null;
          if (nextLock.session_id !== expectedSessionId) {
            nextLock.session_id = expectedSessionId;
            changed = true;
            repairs.push({ type: "normalized_lock_session", session_id: expectedSessionId });
          }
          if (v2Lock && nextLock.identity_model !== "v2") {
            nextLock.identity_model = "v2";
            changed = true;
            repairs.push({ type: "normalized_lock_identity_model", identity_model: "v2" });
          }
          nextLock.heartbeat_utc = new Date().toISOString();
          changed = true;

          let liveHead = null;
          if (nextLock.worktree && fs.existsSync(nextLock.worktree)) {
            liveHead = resolveLockHead(ref.row.Repo, nextLock.worktree);
          } else {
            try {
              // A no-Git control-plane topology has no HEAD to read, so its
              // sentinel remains repairable even when the old stub is absent.
              liveHead = resolveLockHead(ref.row.Repo, nextLock.worktree);
            } catch {
              warnings.push(`Lock worktree is missing at ${nextLock.worktree}; recover did not invent a replacement.`);
            }
          }
          if (liveHead && nextLock.head !== liveHead) {
            // COORD-923: a moved HEAD is re-pointed, not verified. recover does not
            // check that it contains the ticket's recorded PR head or open findings,
            // so its guidance must not steer the owner to submit it.
            if (liveHead !== "coord-no-git-head") {
              lockHeadRepointed = { from: nextLock.head, to: liveHead, verified: false };
            }
            nextLock.head = liveHead;
            repairs.push({
              type: liveHead === "coord-no-git-head" ? "normalized_coord_lock_head" : "refreshed_lock_head",
              head: liveHead,
            });
          }

          if (changed) {
            const lockPath = nextLock.path;
            delete nextLock.path;
            fs.writeFileSync(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`, "utf8");
            lock = findLockForTicket(ticketId);
          }
        }
      } else if (lockCorrupted) {
        fs.unlinkSync(lockPath);
        repairs.push({
          type: "removed_corrupt_lock",
          path: relativeCoordPath(lockPath),
        });
        lock = null;
      } else if (lock) {
        fs.unlinkSync(lock.path);
        repairs.push({
          type: "released_stale_lock",
          path: relativeCoordPath(lock.path),
        });
        lock = null;
      }

      const status = repairs.length > 0 ? "repaired" : "noop";
      console.log(JSON.stringify({
        ticket: ticketId,
        ticket_status: ref.row.Status,
        repairs,
        warnings,
        drift_before_repair: provenance.drift,
        lock: lock || findLockForTicket(ticketId),
        // COORD-923: the re-pointed head is named so the caller can verify it; until a
        // verified repair exists, the only safe next step is to inspect it.
        lock_head_repointed: lockHeadRepointed
          ? {
            ...lockHeadRepointed,
            // COORD-978: the governed repair verb is the only sanctioned way to realign the lock head.
            guidance: `Do not submit: the lock head was re-pointed from ${lockHeadRepointed.from} to ${lockHeadRepointed.to} without verification against the ticket's PR head or open findings. Repair it with coord/scripts/gov repair-lock-head ${ticketId} --dry-run, then apply the previewed --to and --expect.`,
          }
          : null,
        next_commands: lockHeadRepointed
          ? [`coord/scripts/gov explain ${ticketId}`, `coord/scripts/gov repair-lock-head ${ticketId} --dry-run`]
          : buildTicketNextCommands({
            board: readBoard(),
            row: ref.row,
            ticketId,
            lock: findLockForTicket(ticketId),
            provenanceDrift: [],
          }),
        status,
      }, null, 2));
    });
  }

  return {
    doctorFix,
    reconcileGovernance,
    recoverTicket,
    repairSessionMirrorFromCanonicalLock,
  };
};
