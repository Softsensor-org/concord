"use strict";

module.exports = function createLifecycleLockCommands(deps = {}) {
  const {
    COORD_DIR,
    ROOT_DIR,
    STATUS,
    assertTicketMutationOwnership,
    canOwnerHoldConcurrentDoing,
    canonicalizeOwnerOrFail,
    fail,
    findActiveSessionForHandle,
    findDoingTicketForOwner,
    fs,
    gateProcRegistry,
    getRepoRoot,
    getTicketRef,
    isCompleteLockPayload,
    isDoingStatus,
    isRepoBackedCode,
    normalizeLockIdentityReferences,
    normalizeOwnerValue,
    ownerMatches,
    path,
    readAgentsRegistry,
    readBoard,
    readJsonFileState,
    relativeCoordPath,
    repoCodeForLockRepoName,
    resolveAgentIdentifier,
    resolveLockHead,
    resolveTicketLockPath,
    rowsById,
    safeResolveLockHead,
    state,
    touchActiveSession,
    withGovernanceMutation,
    inferTicketStatus,
  } = deps;

  function readLockFileState(lockPath) {
    const stateResult = readJsonFileState(lockPath);
    return {
      ...stateResult,
      value: normalizeLockIdentityReferences(stateResult.value),
    };
  }

  function describeLockFileIssue(ticketId, lockPath, stateResult) {
    const relativePath = relativeCoordPath(lockPath);
    if (!stateResult?.exists) {
      return `No lock file exists for ${ticketId}.`;
    }
    if (stateResult.error instanceof SyntaxError) {
      return `Lock file ${relativePath} for ${ticketId} is not valid JSON: ${stateResult.error.message}`;
    }
    if (stateResult.error) {
      return `Could not read lock file ${relativePath} for ${ticketId}: ${stateResult.error.message}`;
    }
    return `Lock file ${relativePath} for ${ticketId} must contain a JSON object.`;
  }

  function readLockFileOrFail(ticketId, lockPath, options = {}) {
    const stateResult = readLockFileState(lockPath);
    if (!stateResult.exists) {
      if (options.allowMissing === true) {
        return null;
      }
      fail(describeLockFileIssue(ticketId, lockPath, stateResult));
    }
    if (stateResult.error || !stateResult.value || typeof stateResult.value !== "object" || Array.isArray(stateResult.value)) {
      fail(describeLockFileIssue(ticketId, lockPath, stateResult));
    }
    return stateResult.value;
  }

  function buildStartOwnershipRaceMessage(ticketId, row) {
    const owner = row?.Owner && row.Owner !== "unassigned" ? canonicalizeOwnerOrFail(row.Owner) : null;
    const status = String(row?.Status || "").trim() || "unknown";
    if (!owner) {
      return `Ticket ${ticketId} must be todo or deferred to start; current status is "${status}".`;
    }
    const activeSession = findActiveSessionForHandle(owner);
    const sessionText = activeSession?.session_id ? ` active_session=${activeSession.session_id}.` : "";
    if (status === STATUS.DOING || status === STATUS.REVIEW) {
      return (
        `Ticket ${ticketId} is already ${status} under ${owner}.${sessionText} ` +
        `Another agent likely won the race to claim it. ` +
        `Run \`coord/scripts/gov explain ${ticketId}\` to inspect the live state, or pick another ticket.`
      );
    }
    return `Ticket ${ticketId} must be todo or deferred to start; current status is "${status}" under owner ${owner}.`;
  }

  function inspectCanonicalLockMirrorState({ board, row, lock, sessions = [] }) {
    const issues = [];
    const conflicts = [];
    if (!row || !lock || !isCompleteLockPayload(lock) || lock.status !== STATUS.DOING) {
      return {
        canonicalOwner: null,
        agent: null,
        issues,
        conflicts,
        boardRepairNeeded: false,
        sessionRepair: null,
        requiresRepair: false,
      };
    }

    const canonicalOwner = normalizeOwnerValue(lock.owner);
    const agent = canonicalOwner ? resolveAgentIdentifier(canonicalOwner, readAgentsRegistry())?.agent || null : null;
    let boardRepairNeeded = false;
    let sessionRepair = null;

    if (!canonicalOwner) {
      conflicts.push(`Ticket ${row.ID} canonical lock is missing owner metadata.`);
    } else {
      if (!isDoingStatus(row.Status)) {
        issues.push(`Ticket ${row.ID} has canonical doing lock but board status is "${row.Status}".`);
        boardRepairNeeded = true;
      }
      if (!ownerMatches(row.Owner, canonicalOwner)) {
        issues.push(`Ticket ${row.ID} board owner ${row.Owner} does not match canonical lock owner ${canonicalOwner}.`);
        boardRepairNeeded = true;
      }
      if (!agent) {
        conflicts.push(`Ticket ${row.ID} canonical lock owner ${canonicalOwner} is not a registered agent handle.`);
      }
      const doingConflict = board ? findDoingTicketForOwner(board, canonicalOwner, row.ID) : null;
      if (doingConflict && !canOwnerHoldConcurrentDoing(board, row.ID, doingConflict.ID)) {
        conflicts.push(`Ticket ${row.ID} canonical lock owner ${canonicalOwner} conflicts with active doing ticket ${doingConflict.ID}.`);
      }
    }

    if (lock.session_id) {
      const scopedSessions = (sessions || []).filter((session) => session.board_path === state.BOARD_PATH);
      const bySessionId = scopedSessions.filter((session) => session.session_id === lock.session_id);
      if (bySessionId.length > 1) {
        conflicts.push(`Ticket ${row.ID} canonical lock session ${lock.session_id} has multiple session mirror rows.`);
      }
      const activeOwnerSessions = canonicalOwner
        ? scopedSessions.filter((session) =>
          session.handle === canonicalOwner &&
          session.status === "active" &&
          session.session_id !== lock.session_id
        )
        : [];
      if (activeOwnerSessions.length > 0) {
        conflicts.push(
          `Ticket ${row.ID} canonical lock session ${lock.session_id} conflicts with active session binding(s) for ${canonicalOwner}: ` +
          `${activeOwnerSessions.map((session) => session.session_id).join(", ")}.`
        );
      }
      if (bySessionId.length === 1) {
        const existing = bySessionId[0];
        const expectedAgentId = agent?.id || null;
        const expectedThreadId = typeof lock.thread_id === "string" && lock.thread_id.trim() ? lock.thread_id.trim() : null;
        const sessionMatches =
          existing.handle === canonicalOwner &&
          existing.status === "active" &&
          existing.board_root === COORD_DIR &&
          existing.board_path === state.BOARD_PATH &&
          (expectedAgentId === null || existing.agent_id === expectedAgentId) &&
          (expectedThreadId === null || existing.thread_id === expectedThreadId);
        if (!sessionMatches) {
          issues.push(`Ticket ${row.ID} session binding for ${lock.session_id} does not match canonical lock metadata.`);
          sessionRepair = { mode: "normalize", existing };
        }
      } else if (bySessionId.length === 0) {
        issues.push(`Ticket ${row.ID} lock session ${lock.session_id} is missing from agent session state.`);
        sessionRepair = { mode: "create" };
      }
    }

    return {
      canonicalOwner,
      agent,
      issues,
      conflicts,
      boardRepairNeeded,
      sessionRepair,
      requiresRepair: issues.length > 0,
    };
  }

  function heartbeat(ticketId) {
    const mutation = {
      command: "heartbeat",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("heartbeat requires <ticket-id>.");
      }
      const lockPath = resolveTicketLockPath(ticketId);
      const lock = readLockFileOrFail(ticketId, lockPath);
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
      lock.heartbeat_utc = new Date().toISOString();
      const lockRepoCode = repoCodeForLockRepoName(lock.repo) || ref.row.Repo;
      if (isRepoBackedCode(lockRepoCode) && lock.worktree && fs.existsSync(lock.worktree)) {
        lock.head = resolveLockHead(lockRepoCode, lock.worktree);
      }
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      touchActiveSession(lock.owner, lock.session_id);
      console.log(`Updated heartbeat for ${ticketId}.`);
    });
  }

  function releaseLock(ticketId, options = {}) {
    const mutation = {
      command: "release-lock",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("release-lock requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      const lockPath = resolveTicketLockPath(ticketId);
      if (!fs.existsSync(lockPath)) {
        fail(`No lock file exists for ${ticketId}.`);
      }

      if (ref && ref.row.Status === STATUS.DOING && !options.force) {
        fail(`Ticket ${ticketId} is still doing. Use --force only for recovery/stale-lock cleanup.`);
      }

      fs.unlinkSync(lockPath);
      console.log(`Released lock ${path.relative(ROOT_DIR, lockPath)}.`);
    });
  }

  function reapGateProcs(options = {}) {
    const board = readBoard();
    const byId = rowsById(board);
    const isTicketDoing = (ticketId) => {
      const row = byId.get(ticketId);
      return Boolean(row && isDoingStatus(row.Status));
    };
    const result = gateProcRegistry.reapOrphans({
      isTicketDoing,
      dryRun: Boolean(options.dryRun),
    });
    console.log(JSON.stringify({
      status: result.reaped.length > 0 ? "reaped" : "noop",
      ...result,
    }, null, 2));
    return result;
  }

  function assertCurrentTicketLockIntegrity(ticketId, row, lock) {
    if (!lock || !isRepoBackedCode(row.Repo)) {
      return;
    }
    const expectedPrefix = `${getRepoRoot(row.Repo)}/.worktrees/`;
    if (!String(lock.worktree || "").startsWith(expectedPrefix)) {
      fail(`Ticket ${ticketId} lock points to non-canonical worktree path ${lock.worktree}.`);
    }
    const liveHead = safeResolveLockHead(row.Repo, lock.worktree);
    if (!liveHead) {
      fail(`Ticket ${ticketId} lock points to worktree without a readable git HEAD.`);
    }
    if (lock.head !== liveHead) {
      fail(`Ticket ${ticketId} lock head ${lock.head || "(missing)"} does not match worktree HEAD ${liveHead}.`);
    }
  }

  return {
    assertCurrentTicketLockIntegrity,
    buildStartOwnershipRaceMessage,
    describeLockFileIssue,
    heartbeat,
    inspectCanonicalLockMirrorState,
    readLockFileOrFail,
    readLockFileState,
    reapGateProcs,
    releaseLock,
  };
};
