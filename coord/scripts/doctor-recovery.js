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

const fs = require("fs");
const {
  defaultFail,
  COORD_DIR,
  state,
  GOVERNANCE_EVENT_LOCK_STALE_MS,
} = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");
const treeMutationSafety = require("./tree-mutation-safety.js");

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
    repoNameForCode,
    isRepoBackedCode,
    isDoingStatus,
    gitTry,
    canonicalSyncablePaths,
    slugify,
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
      fail,
    });
  }

  function printRepairAllDryRun(options = {}) {
    const scope = options.ticket ? `ticket ${options.ticket}` : "board-wide";
    const steps = [
      "Run read-only doctor diagnostics first.",
      "Apply existing deterministic doctor --fix repairs for drift, stale locks, malformed locks, orphan coord worktrees, missing governed plan stubs, gate-proc orphans, and stale drift-note retirement.",
      "Refuse unsafe tree-wide mutation if non-derived working-tree changes or foreign live ticket locks make repair ambiguous.",
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

  function repairSessionMirrorFromCanonicalLock({ row, lock, canonicalOwner, agent, sessionRepair, sessions }) {
    if (!lock?.session_id || !sessionRepair || !canonicalOwner) {
      return null;
    }
    const now = new Date().toISOString();
    const claimedAt = lock.started_at_utc || now;
    const lastSeenAt = lock.heartbeat_utc || claimedAt;
    const threadId = typeof lock.thread_id === "string" && lock.thread_id.trim() ? lock.thread_id.trim() : null;

    if (sessionRepair.mode === "normalize" && sessionRepair.existing) {
      const existing = sessionRepair.existing;
      const previousHandle = existing.handle || null;
      const previousStatus = existing.status || null;
      const previousThreadId = typeof existing.thread_id === "string" && existing.thread_id.trim()
        ? existing.thread_id.trim()
        : null;
      existing.agent_id = agent?.id || null;
      existing.handle = canonicalOwner;
      existing.session_label = existing.session_label || `rebuild:${String(row.ID || lock.ticket || "ticket").toLowerCase()}`;
      existing.host = existing.host || defaultHostLabel();
      existing.cwd = existing.cwd || lock.worktree || COORD_DIR;
      existing.board_path = state.BOARD_PATH;
      existing.board_root = COORD_DIR;
      if (threadId) {
        existing.thread_id = threadId;
      } else if (!existing.thread_id) {
        existing.thread_id = null;
      }
      existing.claimed_at = existing.claimed_at || claimedAt;
      existing.last_seen_at = lastSeenAt;
      existing.released_at = null;
      existing.status = "active";
      existing.auto_claimed = existing.auto_claimed === true;
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

    sessions.push({
      session_id: lock.session_id,
      agent_id: agent?.id || null,
      handle: canonicalOwner,
      session_label: `rebuild:${String(row.ID || lock.ticket || "ticket").toLowerCase()}`,
      host: defaultHostLabel(),
      cwd: lock.worktree || COORD_DIR,
      board_path: state.BOARD_PATH,
      board_root: COORD_DIR,
      thread_id: threadId,
      claimed_at: claimedAt,
      last_seen_at: lastSeenAt,
      released_at: null,
      status: "active",
      auto_claimed: false,
    });
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
          const repairedLock = {
            ...lock,
            owner: lock.owner || row.Owner || "unknown",
            ticket: lock.ticket,
            status: STATUS.DOING,
            repo: lock.repo || repoNameForCode(row.Repo),
            branch: lock.branch || `agent/${(lock.owner || row.Owner || "unknown").toLowerCase()}-${lock.ticket.toLowerCase()}`,
            worktree: lock.worktree || defaultWorktreePath(row.Repo, lock.owner || row.Owner || "unknown", lock.ticket),
            started_at_utc: lock.started_at_utc || new Date().toISOString(),
            heartbeat_utc: lock.heartbeat_utc || new Date().toISOString(),
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
        if (!row || stale || (row && !isDoingStatus(row.Status))) {
          fs.unlinkSync(lockPath);
          repairs.push({
            type: stale ? "released_stale_lock" : "released_non_doing_lock",
            ticket: lock.ticket,
            path: relativeCoordPath(lockPath),
          });
        }
      }

      if (fs.existsSync(state.GOVERNANCE_EVENT_LOCK_DIR)) {
        const lockStat = fs.statSync(state.GOVERNANCE_EVENT_LOCK_DIR);
        const lockAge = Date.now() - lockStat.mtimeMs;
        if (lockAge > GOVERNANCE_EVENT_LOCK_STALE_MS) {
          const metadata = readDirectoryLockMetadata(state.GOVERNANCE_EVENT_LOCK_DIR);
          const deadOwner = Number.isInteger(metadata?.pid) && !isProcessAlive(metadata.pid);
          if (deadOwner || lockAge > GOVERNANCE_EVENT_LOCK_STALE_MS * 2) {
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

  function reconcileGovernance(ticketId = null, options = {}) {
    const reason = String(options.reason || "").trim();
    if (!reason) {
      fail('reconcile requires --reason "<text>".');
    }

    const provenance = detectGovernanceProvenanceDrift();
    if (!provenance.uninitialized && provenance.drift.length === 0) {
      console.log(JSON.stringify({
        status: "noop",
        ticket: ticketId,
        reason,
        drift: [],
      }, null, 2));
      return;
    }

    if (options.dryRun) {
      console.log(JSON.stringify({
        status: "dry_run",
        ticket: ticketId,
        reason,
        drift: provenance.drift,
        would_reconcile: provenance.drift.length,
        uninitialized: provenance.uninitialized,
      }, null, 2));
      return;
    }

    const mutation = {
      command: "manual-reconcile",
      ticket: ticketId,
      allowProvenanceDrift: true,
      forceLog: true,
      details: {
        reason,
        reconciled_drift: provenance.drift,
      },
    };

    return withGovernanceMutation(mutation, () => {
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
      const owner = ref.row.Owner && ref.row.Owner !== "unassigned"
        ? canonicalizeOwnerOrFail(ref.row.Owner)
        : null;
      const ownerAgent = owner ? resolveAgentIdentifier(owner, readAgentsRegistry())?.agent || null : null;
      const activeOwnerSession = owner ? findActiveSessionForHandle(owner) : null;
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

      if (ref.row.Status === STATUS.DOING) {
        mutation.identity = assertTicketRepairOwnership(ticketId, ref.row, options);
        if (!owner) {
          fail(`Ticket ${ticketId} is doing but has no assigned owner; recover cannot invent ownership.`);
        }

        if (!lock) {
          let branch = null;
          let worktree = null;
          if (isRepoBackedCode(ref.row.Repo)) {
            const context = resolveTicketGitContext(ref.row, ticketId);
            branch = context.branch;
            worktree = context.worktree;
            if (!worktree || worktree === context.repoRoot || !fs.existsSync(worktree)) {
              fail(`Ticket ${ticketId} is doing but no canonical worktree could be found to recreate its lock.`);
            }
            if (!branch) {
              fail(`Ticket ${ticketId} worktree ${worktree} has no governed branch association; recreate the worktree before recovery.`);
            }
          } else if (ref.row.Repo === "X") {
            branch = `agent/${owner.toLowerCase()}-${ticketId.toLowerCase()}-${slugify(ref.row.Description).slice(0, 40)}`;
            worktree = defaultWorktreePath(ref.row.Repo, owner, ticketId);
            if (!fs.existsSync(worktree)) {
              fail(`Ticket ${ticketId} is Repo X and missing both lock and canonical worktree ${worktree}.`);
            }
          } else {
            fail(`Unsupported repo code "${ref.row.Repo}" for ${ticketId}.`);
          }
          writeLock({
            ticketId,
            owner,
            repoCode: ref.row.Repo,
            branch,
            worktree,
            session: activeOwnerSession,
          });
          repairs.push({
            type: lockCorrupted ? "recreated_corrupt_lock" : "recreated_lock",
            branch,
            worktree,
            session_id: activeOwnerSession?.session_id || null,
          });
          lock = findLockForTicket(ticketId);
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

          if (isRepoBackedCode(ref.row.Repo)) {
            if (!nextLock.worktree || !fs.existsSync(nextLock.worktree)) {
              warnings.push(`Lock worktree is missing at ${nextLock.worktree || "(unset)"}; recover did not invent a replacement.`);
            } else {
              const liveHead = resolveLockHead(ref.row.Repo, nextLock.worktree);
              if (nextLock.head !== liveHead) {
                nextLock.head = liveHead;
                repairs.push({ type: "refreshed_lock_head", head: liveHead });
              }
            }
          } else if (nextLock.head !== "coord-no-git-head") {
            nextLock.head = "coord-no-git-head";
            repairs.push({ type: "normalized_coord_lock_head", head: "coord-no-git-head" });
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
        next_commands: buildTicketNextCommands({
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
