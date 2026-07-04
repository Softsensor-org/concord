"use strict";

// COORD-282: the ticket state-mutation command surface, extracted from
// lifecycle.js (lifecycle refactor #2, after COORD-281) to keep the composition
// root under its arch monolith/size LOC budget. ONE cohesive boundary: the verbs
// that MUTATE the board's ticket state — create (file-ticket / open-followup) and
// guarded same-owner/foreign-owner reverts (unstart / lock-abandon) — plus the
// worktree commit verb and the read-only evidence guard both reverts share.
//
// CRITICAL — single-writer protocol is preserved, NOT reimplemented: every board
// mutation here keeps riding the COORD-220 `withBoardTransaction` /
// `withGovernanceMutation` / `withCoordStateLock` path EXACTLY as before. This
// module reserves NO ticket ids of its own — `reserveTicketId` arrives from
// `withBoardTransaction({ board, reserveTicketId })` at call time, just like in
// the pre-extraction code. Everything external is INJECTED via the
// createTicketCommands factory (NO `require()` of governance internals here):
//   - transaction primitives : withBoardTransaction, withGovernanceMutation,
//     withCoordStateLock, runBoardSync, readBoard, writeBoard
//   - board/ticket helpers    : getTicketRef, ensurePromptIndex,
//     allBoardRepoCodes, applyTicketStatus, clearTicketOwner,
//     canonicalizeOwnerOrFail, recordGovernanceCollision, stableIdempotencyKey,
//     normalizeFollowupRelation, applyFollowupRelation, resolveFollowupPromptPath
//   - identity/ownership      : resolveOwnerIdentity, ensureCurrentAgentIdentity,
//     assertTicketMutationOwnership, findLockForTicket, resolveTicketLockPath,
//     inferTicketStatus, isDoingStatus, cleanupClosedTicketWorkspace
//   - commit/git              : isRepoBackedCode, toArray, runGit, gitOutput,
//     gitTry, refreshLockHead
//   - evidence guard          : readPlanRecord, integerOrDefault,
//     planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
//     resolveTicketGitContext, resolveTicketBaseRef, resolveWorktreeBaseCompareRef
//   - GovernanceError `fail`, and the value constants STATUS /
//     ALLOWED_TICKET_TYPES / ALLOWED_PRIORITIES (injected by reference).
// `fs` is a node builtin required directly by the module.
//
// lifecycle.js wires this factory (deferred `(...a)=>fn(...a)` wrappers for the
// function deps, by-reference for the value constants) and re-destructures the
// six returned functions back into its scope so the `commands` dispatch table,
// the `__testing` facade, and `splitTicket` (which calls `openFollowup`) all
// resolve exactly as before the move.

module.exports = function createTicketCommands(deps = {}) {
  const fs = require("fs");
  const path = require("path");
  const {
    // transaction primitives + board IO
    withBoardTransaction,
    withGovernanceMutation,
    withCoordStateLock,
    runBoardSync,
    readBoard,
    writeBoard,
    // board / ticket helpers
    getTicketRef,
    ensurePromptIndex,
    allBoardRepoCodes,
    applyTicketStatus,
    clearTicketOwner,
    canonicalizeOwnerOrFail,
    recordGovernanceCollision,
    stableIdempotencyKey,
    normalizeFollowupRelation,
    applyFollowupRelation,
    resolveFollowupPromptPath,
    // identity / ownership
    resolveOwnerIdentity,
    ensureCurrentAgentIdentity,
    assertTicketMutationOwnership,
    findLockForTicket,
    resolveTicketLockPath,
    inferTicketStatus,
    isDoingStatus,
    cleanupClosedTicketWorkspace,
    // commit / git
    isRepoBackedCode,
    toArray,
    runGit,
    gitOutput,
    gitTry,
    refreshLockHead,
    // unstart-evidence guard
    readPlanRecord,
    integerOrDefault,
    planRecordHasImplicitIntendedFilesScaffoldPlaceholder,
    resolveTicketGitContext,
    resolveTicketBaseRef,
    resolveWorktreeBaseCompareRef,
    // GovernanceError thrower
    fail,
    // value constants (injected by reference)
    STATUS,
    CREATABLE_STATUSES,
    ALLOWED_TICKET_TYPES,
    ALLOWED_PRIORITIES,
  } = deps;

// COORD-003: guarded wrong-start exception (`doing -> todo`). GOVERNANCE.md §4
// allows `gov unstart` ONLY when the ticket carries no auditable evidence — any
// review, landing, plan, or workspace evidence must keep the ticket on the
// board for an explicit, recorded transition (move-review / supersede) instead.
function collectUnstartEvidenceBlockers(ticketId, row, board) {
  const blockers = [];

  // Review evidence: recorded findings, PR refs, or a plan past its first round.
  const findings = board.review_findings?.[ticketId];
  if (Array.isArray(findings) && findings.length > 0) {
    blockers.push(`review findings recorded (${findings.length})`);
  }
  const prRefs = board.pr_index?.[ticketId];
  if (Array.isArray(prRefs) && prRefs.length > 0) {
    blockers.push(`pr_index evidence recorded (${prRefs.join(", ")})`);
  }

  // Landing evidence: any landing_index record at all.
  if (board.landing_index && Object.prototype.hasOwnProperty.call(board.landing_index, ticketId)) {
    blockers.push("landing_index evidence recorded");
  }

  // Plan evidence: a plan record that is more than the start-time scaffold.
  const planRecord = readPlanRecord(ticketId, { allowMissing: true, skipRepairWrite: true });
  if (planRecord) {
    const reviewRound = integerOrDefault(planRecord.review_round, 0);
    if (reviewRound > 1) {
      blockers.push(`plan record advanced to review round ${reviewRound}`);
    } else if (!planRecordHasImplicitIntendedFilesScaffoldPlaceholder(planRecord)) {
      blockers.push("plan record has authored content beyond the start scaffold");
    }
  }

  // Workspace evidence: the ticket worktree exists with commits ahead of base
  // or uncommitted changes.
  const context = resolveTicketGitContext(row, ticketId);
  if (context.worktree && fs.existsSync(context.worktree)) {
    if (isRepoBackedCode(row.Repo)) {
      const statusResult = gitTry(context.worktree, ["status", "--porcelain"]);
      if (statusResult.status === 0 && String(statusResult.stdout || "").trim()) {
        blockers.push(`worktree ${context.worktree} has uncommitted changes`);
      }
      const base = resolveTicketBaseRef(ticketId, row, {});
      if (base) {
        // COORD-005: governed worktrees are created from origin/<base> (GCV-2);
        // measure commits-ahead against the remote-tracking ref so a stale
        // local <base> branch cannot false-positive the guard.
        const compareRef = resolveWorktreeBaseCompareRef(context.worktree, base);
        const aheadResult = gitTry(context.worktree, ["rev-list", "--count", `${compareRef}..HEAD`]);
        const ahead = aheadResult.status === 0
          ? Number.parseInt(String(aheadResult.stdout || "").trim(), 10)
          : 0;
        if (Number.isInteger(ahead) && ahead > 0) {
          blockers.push(`worktree ${context.worktree} has ${ahead} commit(s) ahead of ${compareRef}`);
        }
      }
    } else if (row.Repo === "X") {
      // Repo X worktrees are plain scratch directories with no git history;
      // treat any non-empty residue as workspace evidence.
      let entries = [];
      try {
        entries = fs.readdirSync(context.worktree);
      } catch {
        entries = [];
      }
      if (entries.length > 0) {
        blockers.push(`coord worktree ${context.worktree} is not empty`);
      }
    }
  }

  return blockers;
}

function unstartTicket(ticketId, options = {}) {
  const mutation = {
    command: "unstart",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("unstart requires <ticket-id>.");
    }
    const identity = resolveOwnerIdentity(options.owner);
    mutation.identity = identity;

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (!isDoingStatus(ref.row.Status)) {
      fail(
        `Ticket ${ticketId} must be doing or doing (blocked: ...) to unstart; current status is "${ref.row.Status}". ` +
        `unstart only reverts a wrong start; it is not a general status-revert path.`
      );
    }

    // SAME-OWNER ONLY: the wrong-start exception belongs to the agent that
    // started the ticket. Foreign stale-state cleanup stays an explicit admin
    // path (GOVERNANCE.md §4).
    const lock = findLockForTicket(ticketId);
    const expectedOwner = canonicalizeOwnerOrFail(ref.row.Owner);
    if (identity.agent.handle !== expectedOwner) {
      fail(
        `Ticket ${ticketId} is owned by ${expectedOwner}; ${identity.agent.handle} cannot unstart it. ` +
        `unstart is same-owner only. For foreign stale-state cleanup use an admin path: ` +
        `\`coord/scripts/gov release-lock ${ticketId} --force\` to abandon the lock, ` +
        `or \`coord/scripts/gov claim ${ticketId} --human-admin-override "<reason>"\` to take over.`
      );
    }
    mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);

    // FAIL CLOSED on any auditable evidence — that work belongs on the board.
    const blockers = collectUnstartEvidenceBlockers(ticketId, ref.row, board);
    if (blockers.length > 0) {
      fail(
        `Ticket ${ticketId} cannot be unstarted; it has accrued auditable evidence: ${blockers.join("; ")}. ` +
        `unstart is only for an unworked wrong start. Use \`coord/scripts/gov move-review ${ticketId}\` ` +
        `to keep the work on the board, or \`coord/scripts/gov supersede ${ticketId} --reason "<why>"\` ` +
        `to retire it while preserving its history.`
      );
    }

    const previousStatus = ref.row.Status;
    const cleaned = cleanupClosedTicketWorkspace(ticketId, ref.row, {});
    const lockPath = lock?.path || resolveTicketLockPath(ticketId, { promoteLegacy: true });

    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.TODO);
      clearTicketOwner(ref);
      writeBoard(board);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });

    mutation.afterStatus = STATUS.TODO;
    mutation.details = {
      previous_status: previousStatus,
      cleaned_workspace: cleaned || null,
    };
    console.log(
      `Unstarted ${ticketId}: ${previousStatus} -> todo, cleared owner ${expectedOwner}, ` +
      `removed lock and clean workspace residue.`
    );
  });
}

// GOVERNANCE.md §10.3 foreign-owner recovery: lock-abandon is the FOREIGN/admin
// counterpart of `unstart`. It returns a doing ticket the current session does
// NOT own back to `todo` after a stale foreign lock. The `--human-admin-override`
// flag authorizes touching foreign-owned ticket state; it does NOT authorize
// silent destruction of accrued auditable evidence — that still fails closed.
function lockAbandonTicket(ticketId, options = {}) {
  const mutation = {
    command: "lock-abandon",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("lock-abandon requires <ticket-id>.");
    }

    // The override flag is the authorization gate for touching a ticket the
    // current session does not own. Require an explicit, non-empty reason.
    const overrideReason = String(options.humanAdminOverride || "").trim();
    if (!overrideReason) {
      fail(
        `lock-abandon requires --human-admin-override "<reason>". ` +
        `This admin verb returns a stale foreign-locked doing ticket to todo; ` +
        `the override authorizes touching a ticket the current session does not own.`
      );
    }

    // Identify the current session (NOT --owner): lock-abandon is specifically
    // for a ticket owned by some OTHER session.
    const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false });
    mutation.identity = identity;

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (!isDoingStatus(ref.row.Status)) {
      fail(
        `Ticket ${ticketId} must be doing or doing (blocked: ...) to lock-abandon; current status is "${ref.row.Status}". ` +
        `lock-abandon only clears a stale doing lock; it is not a general status-revert path.`
      );
    }

    // FOREIGN-OWNER ONLY: if the current session owns the ticket, this is the
    // lighter same-owner wrong-start path and needs no override.
    const lock = findLockForTicket(ticketId);
    const expectedOwner = canonicalizeOwnerOrFail(ref.row.Owner);
    if (identity.agent.handle === expectedOwner) {
      fail(
        `Ticket ${ticketId} is owned by the current session (${expectedOwner}); ` +
        `lock-abandon is the foreign-owner admin path. ` +
        `Use \`coord/scripts/gov unstart ${ticketId}\` — the same-owner wrong-start revert needs no override.`
      );
    }

    // FAIL CLOSED on any auditable evidence — abandoning accrued review/landing/
    // plan/workspace evidence to todo would orphan auditable work. The override
    // authorizes the foreign-ownership aspect, NOT silent evidence destruction.
    const blockers = collectUnstartEvidenceBlockers(ticketId, ref.row, board);
    if (blockers.length > 0) {
      fail(
        `Ticket ${ticketId} cannot be lock-abandoned; it has accrued auditable evidence: ${blockers.join("; ")}. ` +
        `--human-admin-override authorizes touching foreign ticket state, not destroying auditable work. ` +
        `Use \`coord/scripts/gov supersede ${ticketId} --reason "<why>"\` to retire it while preserving its history, ` +
        `or \`coord/scripts/gov reconcile ${ticketId} --reason "<why>"\` to record the accepted drift.`
      );
    }

    const previousStatus = ref.row.Status;
    const cleaned = cleanupClosedTicketWorkspace(ticketId, ref.row, {});
    const lockPath = lock?.path || resolveTicketLockPath(ticketId, { promoteLegacy: true });

    withCoordStateLock(() => {
      applyTicketStatus(ref, STATUS.TODO);
      clearTicketOwner(ref);
      writeBoard(board);
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });

    mutation.afterStatus = STATUS.TODO;
    mutation.details = {
      previous_status: previousStatus,
      previous_owner: expectedOwner,
      previous_session_id: lock?.session_id || null,
      human_admin_override_reason: overrideReason,
      cleaned_workspace: cleaned || null,
    };
    console.log(
      `Lock-abandoned ${ticketId}: ${previousStatus} -> todo, cleared stale foreign owner ${expectedOwner}, ` +
      `removed lock and clean workspace residue. Human-admin override reason: ${overrideReason}`
    );
  });
}

function commitTicket(ticketId, options) {
  const mutation = {
    command: "commit",
    ticket: ticketId,
    beforeStatus: inferTicketStatus(ticketId),
  };
  return withGovernanceMutation(mutation, () => {
    if (!ticketId) {
      fail("commit-ticket requires <ticket-id>.");
    }
    if (!options.message) {
      fail('commit-ticket requires --message "<text>".');
    }

    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (ref.row.Status !== STATUS.DOING) {
      fail(`Ticket ${ticketId} must be doing before commit; current status is "${ref.row.Status}".`);
    }
    if (!isRepoBackedCode(ref.row.Repo)) {
      fail(`Ticket ${ticketId} is repo ${ref.row.Repo}; commit-ticket is only supported for repo-backed git worktrees.`);
    }

    const lock = findLockForTicket(ticketId);
    if (!lock) {
      fail(`Ticket ${ticketId} is doing but has no active lock.`);
    }
    mutation.identity = assertTicketMutationOwnership(ticketId, ref.row, lock);
    if (!lock.worktree || !fs.existsSync(lock.worktree)) {
      fail(`Ticket ${ticketId} lock points to missing worktree ${lock.worktree}.`);
    }

    const files = toArray(options.files);
    if (files.length === 0 || options.all) {
      runGit(lock.worktree, ["add", "-A"]);
    } else {
      runGit(lock.worktree, ["add", "--", ...files]);
    }

    const staged = gitOutput(lock.worktree, ["diff", "--cached", "--name-only"]).trim();
    if (!staged) {
      fail(`Ticket ${ticketId} has no staged changes to commit in ${lock.worktree}.`);
    }

    runGit(lock.worktree, ["commit", "-m", options.message]);
    const head = gitOutput(lock.worktree, ["rev-parse", "HEAD"]).trim();
    refreshLockHead(ticketId, head);
    console.log(JSON.stringify({
      ticket: ticketId,
      worktree: lock.worktree,
      branch: lock.branch || null,
      head,
      staged_files: staged.split("\n").filter(Boolean),
      committed: true,
    }, null, 2));
  });
}

function openFollowup(newTicketId, options) {
  const mutation = {
    command: "open-followup",
    ticket: newTicketId || `(auto:${options.prefix || "?"})`,
    idempotencyKey: stableIdempotencyKey("open-followup", newTicketId || `(auto:${options.prefix || "?"})`, {
      prefix: options.prefix || null,
      dependsOn: options.dependsOn || null,
      repo: options.repo || null,
      type: options.type || null,
      pri: options.pri || null,
      description: options.description || null,
      relation: options.relation || null,
    }),
  };
  return withBoardTransaction(mutation, ({ board, reserveTicketId }) => {
    if (!options.dependsOn) {
      fail("open-followup requires --depends-on <ticket-id>.");
    }
    if (!options.repo || !options.type || !options.pri || !options.description) {
      fail("open-followup requires --repo, --type, --pri, and --description.");
    }

    if (!newTicketId && options.prefix) {
      newTicketId = reserveTicketId(options.prefix);
      mutation.ticket = newTicketId;
    }
    if (!newTicketId) {
      fail("open-followup requires <new-ticket-id> or --prefix <PREFIX> to auto-allocate.");
    }
    if (getTicketRef(board, newTicketId)) {
      // COORD-223: reserved-ID duplicate race — journal it as an auditable collision
      // before refusing, so the contended id is queryable via gov recent / gov explain.
      recordGovernanceCollision({
        ticket: newTicketId,
        conflictType: "reserved-id-duplicate",
        verb: "open-followup",
        contenders: [{ ticket_id: newTicketId, prefix: options.prefix || null }],
      });
      fail(`Ticket ${newTicketId} already exists.`);
    }

    const parentRef = getTicketRef(board, options.dependsOn);
    if (!parentRef) {
      fail(`Depends-on ticket ${options.dependsOn} does not exist.`);
    }

    const followupPrompt = resolveFollowupPromptPath({
      board,
      parentTicketId: options.dependsOn,
      explicitPrompt: options.prompt,
    });

    const supportedRepos = allBoardRepoCodes();
    if (!supportedRepos.includes(options.repo)) {
      fail(`Unsupported repo code "${options.repo}". Use ${supportedRepos.join(", ")}.`);
    }
    const relation = normalizeFollowupRelation(options, "blocking");
    if (relation === "independent") {
      fail('open-followup does not support --relation independent; use blocking, related, or closeout-blocker.');
    }

    const newRow = {
      ID: newTicketId,
      Repo: options.repo,
      Type: options.type,
      Pri: options.pri,
      Status: STATUS.TODO,
      Owner: options.owner ? canonicalizeOwnerOrFail(options.owner) : "unassigned",
      Description: options.description,
      "Depends On": applyFollowupRelation(board, newTicketId, options.dependsOn, relation),
    };

    const targetSection = options.sectionHeading
      ? board.sections.find((section) => section.heading === options.sectionHeading)
      : parentRef.section;

    if (!targetSection || !Array.isArray(targetSection.rows)) {
      fail("Could not find a target table section for the follow-up ticket.");
    }

    const insertIndex = options.sectionHeading
      ? targetSection.rows.length
      : parentRef.rowIndex + 1;

    targetSection.rows.splice(insertIndex, 0, newRow);
    ensurePromptIndex(board)[newTicketId] = followupPrompt;

    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Created ${relation} follow-up ticket ${newTicketId} after ${options.dependsOn}.`);
  });
}

// COORD-221: sanctioned LOW-CEREMONY ticket-create.
//
// `gov file-ticket` (alias `gov new`) is the documented one-liner for filing a
// plain backlog ticket through the SAME locked, journaled transaction primitive
// COORD-220 introduced (`withBoardTransaction` + `reserveTicketId`). It composes
// that primitive exactly like `openFollowup`, but deliberately drops the two
// frictions that pushed maintainers/agents to hand-edit tasks.json:
//   - NO mandatory prompt coverage (a `--prompt` link is optional), and
//   - NO forced parent dependency (`--depends-on` is optional).
// Required minimal set: --repo + --type + --pri + --description. Defaults are
// Status=todo, Owner=unassigned. The ID is reserved INSIDE the lock via
// `reserveTicketId(prefix)` so concurrent creates can never collide; an explicit
// `--id` is honored but a duplicate is rejected. On any invalid input the
// transaction fails closed and rolls back (no partial board state), and the new
// row must pass `board.js validate` (enforced by `runBoardSync`).
function findDefaultTicketSection(board) {
  for (const section of board.sections || []) {
    if (
      section.kind === "table" &&
      Array.isArray(section.rows) &&
      Array.isArray(section.columns) &&
      section.columns.includes("ID")
    ) {
      return section;
    }
  }
  return null;
}

function normalizePromptRelPath(ticketId, options = {}) {
  const rawPath = options.prompt || null;
  if (!rawPath) {
    return path.join("coord", "prompts", "tickets", `${ticketId}.md`).replace(/\\/g, "/");
  }
  const raw = String(rawPath).trim();
  if (!raw) {
    fail("prompt path cannot be blank.");
  }
  const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.relative(process.cwd(), abs).replace(/\\/g, "/");
}

function normalizePromptTemplateName(templateName) {
  const value = String(templateName || "ticket").trim().toLowerCase();
  if (!value || value === "default" || value === "ticket") {
    return "ticket";
  }
  fail(`Unsupported prompt template "${templateName}". Supported templates: ticket.`);
}

function buildTicketPromptText(ticketId, row, options = {}) {
  normalizePromptTemplateName(options.promptTemplate || options.template);
  const title = String(row.Description || `${ticketId} implementation prompt`).trim();
  return [
    `# ${ticketId}: ${title}`,
    "",
    "## Assignment",
    "",
    title,
    "",
    "## Context",
    "",
    `- Repo: ${row.Repo}`,
    `- Type: ${row.Type}`,
    `- Priority: ${row.Pri}`,
    "",
    "## Scope",
    "",
    "- Follow the ticket description and repo governance.",
    "- Keep edits limited to the files required for this ticket.",
    "",
    "## Non-goals",
    "",
    "- Do not broaden the ticket beyond the filed scope.",
    "",
    "## Acceptance Criteria",
    "",
    "- Ticket scope is implemented.",
    "- Focused verification is recorded in the governed plan.",
    "",
    "## Likely Files",
    "",
    "- TODO: add likely files before start when known.",
    "",
    "## Verification",
    "",
    "- TODO: add focused verification command.",
    "",
  ].join("\n");
}

function createPromptForFiledTicket(board, ticketId, row, options = {}) {
  const relPath = normalizePromptRelPath(ticketId, options);
  if (!board.prompt_index || typeof board.prompt_index !== "object") {
    board.prompt_index = {};
  }
  const existing = board.prompt_index[ticketId];
  if (existing && existing !== relPath && !options.force) {
    fail(
      `file-ticket --with-prompt: ${ticketId} is already registered to ${existing}. ` +
      `Pass --force to overwrite with ${relPath}.`
    );
  }
  const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(process.cwd(), relPath);
  const fileExists = fs.existsSync(absPath);
  if (fileExists && options.replace && !options.force) {
    fail(`file-ticket --with-prompt: ${relPath} already exists. Pass --force with --replace to overwrite it.`);
  }
  let created = false;
  let overwritten = false;
  if (!fileExists || options.replace) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, buildTicketPromptText(ticketId, row, options), "utf8");
    created = !fileExists;
    overwritten = fileExists && Boolean(options.replace);
  }
  board.prompt_index[ticketId] = relPath;
  return { ticket: ticketId, prompt: relPath, created, overwritten, registered: existing !== relPath };
}

function fileTicket(explicitId, options = {}) {
  const mutation = {
    command: "file-ticket",
    ticket: explicitId || `(auto:${options.prefix || "COORD"})`,
    idempotencyKey: stableIdempotencyKey("file-ticket", explicitId || `(auto:${options.prefix || "COORD"})`, {
      prefix: options.prefix || null,
      repo: options.repo || null,
      type: options.type || null,
      pri: options.pri || null,
      status: options.status || null,
      description: options.description || null,
      dependsOn: options.dependsOn || null,
      prompt: options.prompt || null,
      withPrompt: Boolean(options.withPrompt),
      promptTemplate: options.promptTemplate || null,
      owner: options.owner || null,
    }),
  };
  return withBoardTransaction(mutation, ({ board, reserveTicketId }) => {
    if (!options.repo || !options.type || !options.pri || !options.description) {
      fail("file-ticket requires --repo, --type, --pri, and --description.");
    }

    const type = String(options.type).toLowerCase().trim();
    if (!ALLOWED_TICKET_TYPES.includes(type)) {
      fail(`file-ticket requires --type <${ALLOWED_TICKET_TYPES.join("|")}>.`);
    }
    const pri = String(options.pri).toUpperCase().trim();
    if (!ALLOWED_PRIORITIES.includes(pri)) {
      fail(`file-ticket requires --pri <${ALLOWED_PRIORITIES.join("|")}>.`);
    }

    // COORD-285: the single-writer create path may stamp only a CREATABLE status —
    // `todo` (normal backlog intake, the default) or `proposed` (quarantined
    // machine-proposed intake that a human must `gov approve` before it is work).
    // `--status proposed` is what COORD-286's generator uses to file deduped
    // proposals through this same locked, journaled transaction. Every other
    // status is reached only via a governed transition, never born here.
    const creatableStatuses = CREATABLE_STATUSES || [STATUS.TODO, STATUS.PROPOSED];
    const status = options.status
      ? String(options.status).toLowerCase().trim()
      : STATUS.TODO;
    if (!creatableStatuses.includes(status)) {
      fail(`file-ticket requires --status <${creatableStatuses.join("|")}> (default todo).`);
    }

    const supportedRepos = allBoardRepoCodes();
    if (!supportedRepos.includes(options.repo)) {
      fail(`Unsupported repo code "${options.repo}". Use ${supportedRepos.join(", ")}.`);
    }

    let newTicketId = explicitId;
    if (!newTicketId) {
      newTicketId = reserveTicketId(options.prefix || "COORD");
      mutation.ticket = newTicketId;
    }
    if (getTicketRef(board, newTicketId)) {
      // COORD-223: reserved-ID duplicate race — audit before refusing.
      recordGovernanceCollision({
        ticket: newTicketId,
        conflictType: "reserved-id-duplicate",
        verb: "file-ticket",
        contenders: [{ ticket_id: newTicketId, prefix: options.prefix || "COORD" }],
      });
      fail(`Ticket ${newTicketId} already exists.`);
    }

    // Optional parent dependency — validated only when supplied (the
    // differentiator from open-followup, which forces one).
    let dependsOn = "";
    if (options.dependsOn) {
      if (!getTicketRef(board, options.dependsOn)) {
        fail(`Depends-on ticket ${options.dependsOn} does not exist.`);
      }
      dependsOn = options.dependsOn;
    }

    const targetSection = findDefaultTicketSection(board);
    if (!targetSection) {
      fail("Could not find a backlog table section to file the ticket into.");
    }

    const newRow = {
      ID: newTicketId,
      Repo: options.repo,
      Type: type,
      Pri: pri,
      Status: status,
      Owner: options.owner ? canonicalizeOwnerOrFail(options.owner) : "unassigned",
      Description: options.description,
      "Depends On": dependsOn,
    };

    targetSection.rows.push(newRow);

    // Optional prompt linkage — only when supplied (never mandatory).
    if (options.withPrompt || options.promptTemplate) {
      const promptResult = createPromptForFiledTicket(board, newTicketId, newRow, {
        prompt: options.prompt,
        promptTemplate: options.promptTemplate,
        force: options.force,
        replace: options.replace,
      });
      mutation.details = { prompt: promptResult };
    } else if (options.prompt) {
      ensurePromptIndex(board)[newTicketId] = options.prompt;
    }

    withCoordStateLock(() => {
      writeBoard(board);
      runBoardSync({ ignoreActiveTicketLockErrors: true });
    });
    console.log(`Filed ticket ${newTicketId} (${options.repo}/${type}/${pri}, status=${status}).`);
    return newTicketId;
  });
}

  return {
    collectUnstartEvidenceBlockers,
    unstartTicket,
    lockAbandonTicket,
    commitTicket,
    openFollowup,
    fileTicket,
  };
};
