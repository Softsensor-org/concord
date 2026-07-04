"use strict";

module.exports = function createLifecycleTicketAdmin(deps = {}) {
  const {
    ALLOWED_PRIORITIES,
    ALLOWED_TICKET_TYPES,
    STATUS,
    applyFollowupRelation,
    applyTicketStatus,
    canonicalizeOwnerOrFail,
    clearTicketOwner,
    cleanupClosedTicketWorkspace,
    ensureReviewFindings,
    ensureWaiverIndex,
    fail,
    findLockForTicket,
    getTicketRef,
    inferNextRound,
    inferTicketStatus,
    isDoingStatus,
    normalizeFollowupRelation,
    openFollowup,
    path,
    readBoard,
    resolveOwnerIdentity,
    runBoardSync,
    stableIdempotencyKey,
    toArray,
    verifyPrEvidence,
    withCoordStateLock,
    withGovernanceMutation,
    writeBoard,
  } = deps;

  function reopenTicket(ticketId) {
    if (!ticketId) {
      fail("reopen-ticket requires <ticket-id>.");
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }

    fail(
      `reopen-ticket no longer reopens closed or review tickets. ` +
      `Use "open-followup" for post-close findings and "return-doing" for review -> doing with recorded findings.`
    );
  }

  function resolveWorktreeBaseCompareRef(worktree, base) {
    const resolves = (ref) => {
      const r = deps.gitTry(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return r.status === 0 && Boolean(String(r.stdout || "").trim());
    };
    if (resolves(`origin/${base}`)) return `origin/${base}`;
    return base;
  }

  function splitTicket(parentId, options) {
    if (!parentId) fail("split-ticket requires <parent-ticket-id>.");
    if (!options.into) fail('split-ticket requires --into <repo-codes>, e.g. --into B,F.');
    const board = readBoard();
    const parentRef = getTicketRef(board, parentId);
    if (!parentRef) fail(`Parent ticket ${parentId} does not exist.`);
    const repos = String(options.into).split(/[,\s]+/).filter(Boolean);
    const prefix = (options.prefix || (parentId.match(/^([A-Z]+)-/) || [])[1] || "").toUpperCase();
    if (!prefix) fail("Could not derive a prefix from the parent id; pass --prefix <PREFIX>.");
    const pri = options.pri || parentRef.row.Pri || "P2";
    const type = options.type || "feature";
    const roleFor = (r) => ({ B: "Backend", F: "Frontend", C: "Legacy" }[r] || `repo ${r}`);
    const parentDesc = String(parentRef.row.Description || "").replace(/\s+/g, " ").slice(0, 500);
    for (const repo of repos) {
      const desc = options.description
        ? `${roleFor(repo)} half of ${parentId}: ${options.description}`
        : `${roleFor(repo)} half of cross-repo ${parentId}. Parent intent: ${parentDesc} — implement the ${roleFor(repo)} portion only; the other half(s) are sibling splits. FILL IN repo-specific acceptance criteria + tests.`;
      openFollowup(null, { prefix, dependsOn: parentId, repo, type, pri, description: desc, relation: "related" });
    }
    console.log(`Split ${parentId} -> ${repos.length} ${prefix}-* halves (${repos.join(", ")}), each related to ${parentId} (ready now). After both land, close the umbrella: gov finalize ${parentId} --no-pr --fulfilled-by-ticket <a-half> --landed "<both PRs>".`);
  }

  function withBoardTransaction(mutation, fn) {
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const reserveTicketId = (prefix) => deps.nextTicketId(board, prefix);
      return fn({ board, reserveTicketId });
    });
  }

  function setFollowupRelation(ticketId, options) {
    const mutation = { command: "set-followup-relation", ticket: ticketId };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("set-followup-relation requires <ticket-id>.");
      }
      const relation = normalizeFollowupRelation(options, "blocking");
      if (relation !== "independent" && !options.dependsOn) {
        fail(`set-followup-relation ${ticketId} requires --depends-on <ticket-id> unless --relation independent is used.`);
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (relation !== "independent") {
        const parentRef = getTicketRef(board, options.dependsOn);
        if (!parentRef) {
          fail(`Depends-on ticket ${options.dependsOn} does not exist.`);
        }
        if (parentRef.row.ID === ticketId) {
          fail(`Ticket ${ticketId} cannot depend on itself.`);
        }
      }

      ref.row["Depends On"] = applyFollowupRelation(board, ticketId, options.dependsOn, relation);

      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(
        relation === "independent"
          ? `Cleared follow-up dependency metadata for ${ticketId}.`
          : `Set follow-up relation for ${ticketId}: ${relation} -> ${options.dependsOn}.`
      );
    });
  }

  function setTicketPriority(ticketId, options) {
    const mutation = {
      command: "set-priority",
      ticket: ticketId,
      idempotencyKey: stableIdempotencyKey("set-priority", ticketId, { pri: options.pri || null }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) fail("set-priority requires <ticket-id>.");
      const pri = String(options.pri || "").toUpperCase().trim();
      if (!ALLOWED_PRIORITIES.includes(pri)) fail(`set-priority requires --pri <${ALLOWED_PRIORITIES.join("|")}>.`);
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const status = String(ref.row.Status || "").toLowerCase();
      if (status === STATUS.DONE || status === STATUS.SUPERSEDED) fail(`Refusing to reprioritize ${ticketId} in terminal status "${status}".`);
      const prev = ref.row.Pri;
      if (prev === pri) { console.log(`${ticketId} already ${pri}.`); return; }
      ref.row.Pri = pri;
      withCoordStateLock(() => { writeBoard(board); runBoardSync({ ignoreActiveTicketLockErrors: true }); });
      console.log(`Set priority for ${ticketId}: ${prev} -> ${pri}.`);
    });
  }

  function setTicketType(ticketId, options) {
    const mutation = {
      command: "set-type",
      ticket: ticketId,
      idempotencyKey: stableIdempotencyKey("set-type", ticketId, { type: options.type || null }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) fail("set-type requires <ticket-id>.");
      const type = String(options.type || "").toLowerCase().trim();
      if (!ALLOWED_TICKET_TYPES.includes(type)) fail(`set-type requires --type <${ALLOWED_TICKET_TYPES.join("|")}>.`);
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const status = String(ref.row.Status || "").toLowerCase();
      if (status === STATUS.DONE || status === STATUS.SUPERSEDED) fail(`Refusing to retype ${ticketId} in terminal status "${status}".`);
      const prev = ref.row.Type;
      if (prev === type) { console.log(`${ticketId} already type ${type}.`); return; }
      ref.row.Type = type;
      withCoordStateLock(() => { writeBoard(board); runBoardSync({ ignoreActiveTicketLockErrors: true }); });
      console.log(`Set type for ${ticketId}: ${prev} -> ${type}.`);
    });
  }

  function setWaiver(ticketId, options) {
    const mutation = {
      command: "set-waiver",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("set-waiver", ticketId, {
        clear: Boolean(options.clear),
        reason: options.reason || null,
        owner: options.owner || null,
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("set-waiver requires <ticket-id>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }

      const waiverIndex = ensureWaiverIndex(board);
      if (options.clear) {
        delete waiverIndex[ticketId];
        withCoordStateLock(() => {
          writeBoard(board);
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        });
        console.log(`Cleared waiver for ${ticketId}.`);
        return;
      }

      if (!options.reason) {
        fail("set-waiver requires --reason <text> unless --clear is used.");
      }

      const identity = options.owner
        ? resolveOwnerIdentity(options.owner, { allowAutoClaim: false, touchSession: false })
        : deps.ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });

      waiverIndex[ticketId] = {
        code: "prompt_coverage",
        reason: options.reason,
        recorded_at: new Date().toISOString(),
        recorded_by: identity.agent?.handle || deps.maybeCanonicalOwner(options.owner) || options.owner || "unknown",
      };

      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Recorded prompt-coverage waiver for ${ticketId}.`);
    });
  }

  function setPrRefs(ticketId, options) {
    const mutation = {
      command: "set-pr",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      idempotencyKey: stableIdempotencyKey("set-pr", ticketId, {
        pr: toArray(options.pr),
        skipSync: Boolean(options.skipSync),
      }),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("set-pr requires <ticket-id>.");
      }
      const refs = toArray(options.pr);
      if (refs.length === 0) {
        fail("set-pr requires at least one --pr <ref>.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      verifyPrEvidence(ticketId, refs, {
        requireMerged: ref.row.Status === STATUS.DONE,
        allowNoPr: true,
      });
      withCoordStateLock(() => {
        deps.setTicketPrRefs(board, ticketId, refs);
        writeBoard(board);
        if (!options.skipSync) {
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        }
      });
      console.log(`Updated pr_index for ${ticketId}.`);
    });
  }

  function addFinding(ticketId, options) {
    const mutation = {
      command: "add-finding",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("add-finding requires <ticket-id>.");
      }
      if (!options.severity || !options.summary || !options.qref) {
        fail("add-finding requires --severity, --summary, and --qref.");
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      const findings = ensureReviewFindings(board, ticketId);
      const nextFindingNumber = findings.reduce((maxValue, finding) => {
        const match = String(finding.id || "").match(/-F(\d+)$/);
        if (!match) {
          return maxValue;
        }
        const value = Number(match[1]);
        return Number.isFinite(value) ? Math.max(maxValue, value) : maxValue;
      }, 0) + 1;
      const finding = {
        id: `${ticketId}-F${nextFindingNumber}`,
        severity: options.severity,
        summary: options.summary,
        status: options.status || "open",
        round: deps.integerOrDefault(options.round, inferNextRound(findings)),
        qref: options.qref,
      };
      if (options.deferredTo) {
        finding.deferred_to = options.deferredTo;
      }
      if (options.consolidatedInto) {
        finding.consolidated_into = options.consolidatedInto;
      }
      findings.push(finding);
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Added finding ${finding.id} to ${ticketId}.`);
    });
  }

  function updateFinding(ticketId, options) {
    const mutation = {
      command: "update-finding",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("update-finding requires <ticket-id>.");
      }
      if (!options.id || !options.status) {
        fail("update-finding requires --id <finding-id> and --status <status>.");
      }

      const board = readBoard();
      const findings = ensureReviewFindings(board, ticketId);
      const finding = findings.find((candidate) => candidate.id === options.id);
      if (!finding) {
        fail(`Finding ${options.id} does not exist under ${ticketId}.`);
      }

      finding.status = options.status;
      if (options.deferredTo) {
        finding.deferred_to = options.deferredTo;
      }
      if (options.consolidatedInto) {
        finding.consolidated_into = options.consolidatedInto;
      }
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(`Updated ${options.id} on ${ticketId} to status=${options.status}.`);
    });
  }

  function clearTicketLockForAbandon(ticketId, ref, lockPath, previousStatus) {
    if (!isDoingStatus(ref.row.Status)) {
      fail(`Ticket ${ticketId} must be doing or doing (blocked: ...) to lock-abandon; current status is "${ref.row.Status}".`);
    }
    applyTicketStatus(ref, STATUS.TODO);
    clearTicketOwner(ref);
    cleanupClosedTicketWorkspace(ticketId, ref.row, { previousStatus });
    if (deps.fs.existsSync(lockPath)) {
      deps.fs.unlinkSync(lockPath);
    }
  }

  return {
    addFinding,
    clearTicketLockForAbandon,
    reopenTicket,
    resolveWorktreeBaseCompareRef,
    setFollowupRelation,
    setPrRefs,
    setTicketPriority,
    setTicketType,
    setWaiver,
    splitTicket,
    updateFinding,
    withBoardTransaction,
  };
};
