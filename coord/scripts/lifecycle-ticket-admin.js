"use strict";

// COORD-673: the --depends-on list parser is a dependency-free pure helper, so it
// is required directly here rather than threaded through the lifecycle.js
// composition root (COORD-396/397: the root stays un-growable).
const { parseDependsOnList } = require("./followups.js");

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
      // COORD-673: every accepted --depends-on shape resolves to a LIST — a bare
      // id, the comma form "A,B" (previously rejected as one nonexistent id), and
      // the repeated-flag form (previously last-wins, silently dropping the rest).
      const dependsOnList = parseDependsOnList(
        options.dependsOnAll === undefined ? options.dependsOn : options.dependsOnAll
      );
      if (relation !== "independent" && dependsOnList.length === 0) {
        fail(`set-followup-relation ${ticketId} requires --depends-on <ticket-id> unless --relation independent is used.`);
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      // Validate EVERY requested id before mutating anything, so a bad entry in a
      // multi-id call refuses whole rather than partially rewriting the row.
      for (const dependsOnId of dependsOnList) {
        if (dependsOnId === ticketId) {
          fail(`Ticket ${ticketId} cannot depend on itself.`);
        }
        if (!getTicketRef(board, dependsOnId)) {
          fail(`Depends-on ticket ${dependsOnId} does not exist.`);
        }
      }

      const before = String(ref.row["Depends On"] || "");
      ref.row["Depends On"] = applyFollowupRelation(board, ticketId, dependsOnList[0] || null, relation, {
        existingDependsOn: before,
        dependsOnList,
        replace: Boolean(options.replace),
      });
      const after = String(ref.row["Depends On"] || "");

      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      // Always print the resulting edge SET: the filed defect was invisible
      // precisely because the output echoed only the id just passed in.
      const dependsOnSummary = after || "(none)";
      console.log(
        relation === "independent"
          ? (dependsOnList.length === 0
            ? `Cleared follow-up dependency metadata for ${ticketId}. Depends On: ${dependsOnSummary}.`
            : `Removed follow-up dependency ${dependsOnList.join(", ")} from ${ticketId}. Depends On: ${dependsOnSummary}.`)
          : `Set follow-up relation for ${ticketId}: ${relation} -> ${dependsOnList.join(", ")}. Depends On: ${dependsOnSummary}.`
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

  // COORD-649: the round a ticket is CURRENTLY in, read from the governed plan
  // record (the only artifact the round-advancing transition writes), falling
  // back to the recorded findings when no plan record exists yet.
  function ticketCurrentReviewRound(ticketId, findings) {
    const planRecord = deps.readPlanRecord
      ? deps.readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true })
      : null;
    return deps.currentReviewRound(planRecord, findings);
  }

  // COORD-649 (requirement 3): an explicit --round that disagrees with lifecycle
  // state FAILS CLOSED. Silently accepting it is what manufactures a required
  // plan round no governed writer can produce.
  function resolveAddFindingRound(ticketId, findings, options) {
    const current = ticketCurrentReviewRound(ticketId, findings);
    if (options.round === undefined || options.round === null || options.round === "") {
      return current;
    }
    const requested = deps.integerOrDefault(options.round, null);
    if (!Number.isInteger(requested) || requested < 1) {
      fail(`add-finding --round must be a positive integer; got "${options.round}".`);
    }
    if (requested !== current) {
      fail(
        `add-finding --round ${requested} disagrees with lifecycle state: ${ticketId} is currently in review round ${current}. ` +
        `A finding recorded now belongs to round ${current}. ` +
        `Rounds advance ONLY through \`coord/scripts/gov return-doing ${ticketId} ...\`, which records the finding and the ` +
        `plan round together; recording a higher round here would require a plan review_round no governed writer can produce. ` +
        `To repair a finding that is already filed under the wrong round, use ` +
        `\`coord/scripts/gov correct-finding-round ${ticketId} --id <finding-id> --round <n> --human-admin-override "<reason>"\`.`
      );
    }
    return requested;
  }

  // COORD-649 (requirement 4): the governed, human-admin repair path for a
  // finding already filed under the wrong round. Hand-editing the board or the
  // plan record is never the remedy — this records the correction as one
  // journaled mutation carrying BOTH the before and after round.
  function correctFindingRound(ticketId, options) {
    const mutation = {
      command: "correct-finding-round",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("correct-finding-round requires <ticket-id>.");
      }
      if (!options.id) {
        fail("correct-finding-round requires --id <finding-id>.");
      }
      const overrideReason = String(options.humanAdminOverride || "").trim();
      if (!overrideReason) {
        fail(
          `correct-finding-round requires --human-admin-override "<reason>". ` +
          `Reclassifying recorded review evidence is a human-admin authority act, not routine agent bookkeeping.`
        );
      }
      const requested = deps.integerOrDefault(options.round, null);
      if (!Number.isInteger(requested) || requested < 1) {
        fail(`correct-finding-round requires --round <positive integer>; got "${options.round ?? ""}".`);
      }

      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      const findings = ensureReviewFindings(board, ticketId);
      const finding = findings.find((candidate) => candidate.id === options.id);
      if (!finding) {
        fail(`Finding ${options.id} does not exist under ${ticketId}.`);
      }
      const beforeRound = deps.integerOrDefault(finding.round, 1);
      if (beforeRound === requested) {
        fail(`Finding ${options.id} is already recorded under round ${requested}; nothing to correct.`);
      }
      // Fail closed on a correction that would re-manufacture the wedge: the
      // review-readiness check requires the plan's review_round to equal
      // max(finding rounds), and only `return-doing` can raise the plan round.
      const ceiling = ticketCurrentReviewRound(
        ticketId,
        findings.filter((candidate) => candidate.id !== options.id)
      );
      if (requested > ceiling) {
        fail(
          `correct-finding-round would file ${options.id} under round ${requested}, but ${ticketId} has only reached ` +
          `review round ${ceiling}. That would require a plan review_round of ${requested}, which only a genuine ` +
          `\`coord/scripts/gov return-doing ${ticketId} ...\` transition can write — and claiming ${requested} review ` +
          `rounds occurred when ${ceiling} did is exactly the false evidence this path exists to prevent.`
        );
      }

      finding.round = requested;
      mutation.details = {
        ...(mutation.details || {}),
        finding_id: options.id,
        before_round: beforeRound,
        after_round: requested,
        human_admin_override_reason: overrideReason,
      };
      withCoordStateLock(() => {
        writeBoard(board);
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(
        `Corrected ${options.id} on ${ticketId}: review round ${beforeRound} -> ${requested} ` +
        `(human-admin override: ${overrideReason}).`
      );
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
      // COORD-649: a finding recorded now belongs to the round the ticket is
      // CURRENTLY in, not to a new one. `add-finding` used inferNextRound, so
      // three findings from ONE review landed on rounds 1, 2 and 3 — and the
      // required plan review_round (max over findings) became a number only the
      // review -> doing transition can write, which the same check blocks.
      const round = resolveAddFindingRound(ticketId, findings, options);
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
        round,
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

  // COORD-663 (requirement 5): the governed repair for a lock transferred
  // BEFORE workspace_owner existed. Such a lock names the new owner while its
  // worktree and branch still occupy the previous owner's namespace, and every
  // mutation fails the canonical-location checks — including the mutations
  // needed to record the defect. Hand-editing the lock is never the remedy, so
  // this reconstructs the namespace and the provenance FROM THE JOURNAL and
  // refuses when the journal does not support it.
  function normalizeLock(ticketId, options = {}) {
    const mutation = {
      command: "normalize-lock",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
    };
    return withGovernanceMutation(mutation, () => {
      if (!ticketId) {
        fail("normalize-lock requires <ticket-id>.");
      }
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      const located = findLockForTicket(ticketId);
      const lockPath = located && located.path;
      if (!lockPath || !deps.fs.existsSync(lockPath)) {
        fail(`Ticket ${ticketId} has no governed lock to normalize.`);
      }
      let lock;
      try {
        lock = JSON.parse(deps.fs.readFileSync(lockPath, "utf8"));
      } catch (error) {
        fail(`Lock file for ${ticketId} is not readable JSON: ${error.message}`);
      }

      const existingNamespace =
        typeof lock.workspace_owner === "string" && lock.workspace_owner.trim() ? lock.workspace_owner.trim() : null;
      if (existingNamespace && Array.isArray(lock.transfer_provenance) && lock.transfer_provenance.length > 0) {
        console.log(
          `Lock for ${ticketId} already records workspace_owner="${existingNamespace}" with ` +
            `${lock.transfer_provenance.length} transfer provenance entr(ies); nothing to normalize.`
        );
        return;
      }

      // Journal evidence only. The on-disk path is corroboration, never the
      // source: a lock that merely SITS in the wrong directory has no transfer
      // behind it and must keep failing closed.
      const journalPath = path.join(path.dirname(path.dirname(lockPath)), "governance-events.ndjson");
      const transfers = [];
      if (deps.fs.existsSync(journalPath)) {
        for (const line of String(deps.fs.readFileSync(journalPath, "utf8")).split("\n")) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.ticket !== ticketId) continue;
          if (event.command !== "claim-ticket" || event.result !== "succeeded") continue;
          const details = event.details && typeof event.details === "object" ? event.details : null;
          if (!details || !details.transfer_to || !details.previous_owner) continue;
          transfers.push({
            from: String(details.previous_owner),
            to: String(details.transfer_to),
            at: String(event.ts || ""),
            reason: details.override_reason ? String(details.override_reason) : null,
            previous_session_id: details.previous_session_id ? String(details.previous_session_id) : null,
          });
        }
      }
      if (transfers.length === 0) {
        fail(
          `normalize-lock found no recorded ownership transfer for ${ticketId} in the governance journal. ` +
            `A lock whose namespace does not match its owner WITHOUT a transfer behind it is not a normalization ` +
            `case — it is an unexplained mismatch, and it must keep failing closed.`
        );
      }

      const namespaceOwner = transfers[0].from;
      const lastTransfer = transfers[transfers.length - 1];
      if (lastTransfer.to !== lock.owner) {
        fail(
          `normalize-lock refuses: the journal's last transfer for ${ticketId} ends at owner "${lastTransfer.to}", ` +
            `but the lock is owned by "${lock.owner}".`
        );
      }
      // Corroborate against the physical reality the namespace is supposed to
      // describe. If these disagree, the reconstruction is wrong and writing it
      // would manufacture false provenance.
      const expectedSegment = `${path.sep}.worktrees${path.sep}${namespaceOwner}${path.sep}`;
      if (typeof lock.worktree !== "string" || !lock.worktree.includes(expectedSegment)) {
        fail(
          `normalize-lock refuses: the journal says the namespace belongs to "${namespaceOwner}", but the lock's ` +
            `worktree ${lock.worktree} is not inside that namespace.`
        );
      }
      const expectedBranchPrefix = `agent/${String(namespaceOwner).toLowerCase()}-${String(ticketId).toLowerCase()}-`;
      if (typeof lock.branch === "string" && lock.branch && !lock.branch.startsWith(expectedBranchPrefix)) {
        fail(
          `normalize-lock refuses: the journal says the namespace belongs to "${namespaceOwner}", but the lock's ` +
            `branch ${lock.branch} does not use the prefix ${expectedBranchPrefix}.`
        );
      }

      const provenance = transfers.map((entry) => ({ ...entry, workspace_owner: namespaceOwner }));
      const next = { ...lock, workspace_owner: namespaceOwner, transfer_provenance: provenance };
      mutation.details = {
        ...(mutation.details || {}),
        workspace_owner: namespaceOwner,
        owner: lock.owner,
        transfer_count: provenance.length,
        reconstructed_from: "governance journal claim-ticket transfer events",
      };
      withCoordStateLock(() => {
        deps.fs.writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        runBoardSync({ ignoreActiveTicketLockErrors: true });
      });
      console.log(
        `Normalized the lock for ${ticketId}: owner="${lock.owner}", workspace_owner="${namespaceOwner}", ` +
          `${provenance.length} transfer provenance entr(ies) reconstructed from the journal. ` +
          `The worktree and branch are unchanged.`
      );
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
    correctFindingRound,
    clearTicketLockForAbandon,
    normalizeLock,
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
