"use strict";

// COORD-294: the ticket QUEUE / ranking / recommendation service, extracted from
// lifecycle.js (lifecycle decomposition epic COORD-291..297, slice #3 — the third
// behavior-preserving extraction after the COORD-291 boundary contract). ONE
// cohesive boundary: ticket listing, the pick/recommend candidate ranking, the
// scoring model (scoreTicket + mode bias), the downstream/dependency-unblocks
// counts, the idle/busy active-agent summaries, the multi-agent pick assignment,
// and the agent-release-candidate planning.
//
// CRITICAL INVARIANTS — preserved, NOT reimplemented:
//   - Output PARITY for `gov counts` / `list` / `pick` / `recommend`: ordering and
//     content are byte-identical to the pre-move inline implementation (same
//     console formats, same sort: score desc then ID localeCompare).
//   - COORD-285 (proposed quarantine): a `proposed` ticket stays EXCLUDED from the
//     downstream/dependency unblocks count (`buildDownstreamCounts` skips DONE /
//     SUPERSEDED / PROPOSED), and is never a recommendation candidate
//     (`buildRecommendationSet` only considers STATUS.TODO). The open-count
//     exclusion itself lives in `printCounts` (stays in lifecycle.js) — this
//     service preserves the downstream-scoring and candidate exclusions.
//   - Ranking unchanged: `scoreTicket` (ready/priority/repo/downstream/prompt/
//     dependency/mode bonuses) and `modeBiasScore` are moved VERBATIM.
//
// Everything external is INJECTED via the createTicketQueueService factory (NO
// `require()` of governance internals here). The governance-context primitive —
// the mutable `state` object holding `BOARD_PATH` — is injected BY REFERENCE so
// the agent-summary readers see the live board path at call time (tests swap it
// through `__testing.paths`). The `STATUS` constant map is injected BY REFERENCE.
// Every collaborator function is injected as a deferred `(...a)=>fn(...a)` wrapper
// that resolves at call time, so factory wiring order never constrains call-time
// resolution:
//   - board readers      : readBoard, getRows
//   - identity / owner    : resolveOwnerIdentity, ensureCurrentAgentIdentity,
//     maybeCanonicalOwner, findDoingTicketForOwner
//   - agent-session readers : readAgentsRegistry, readAgentSessions,
//     resolveAgentIdentifier, compareSessionsMostRecentFirst, resolveEffectiveThreadId
//   - readiness / scoring deps : evaluateReadiness, splitDependsOn, isRepoBackedCode
//   - blocker formatting : formatTransitiveBlockerDetails, formatDependencyCycleList
//   - misc               : integerOrDefault, GovernanceError thrower `fail`
//
// lifecycle.js wires this factory and re-destructures the nine returned functions
// (listTickets, pickTickets, recommendTickets, recommendationModeForAgent,
// summarizeBusyActiveAgents, listIdleActiveAgentSessions, buildReleaseCandidates,
// scoreTicket, buildDownstreamCounts) back into its scope so the `commands`
// dispatch table, the `__testing` facade, and the deferred wrappers other factories
// inject all resolve exactly as before the move. The private helpers
// (pick*/buildRecommendationSet/printRankedTicketList/formatRankedTicket/
// assignTicketsToAgents/compareAssignedCandidates/inferModeFromRepo/modeBiasScore)
// stay internal to this module.

module.exports = function createTicketQueueService(deps = {}) {
  const {
    // governance-context primitive (injected BY REFERENCE)
    state,
    // status constant map (injected BY REFERENCE)
    STATUS,
    // board readers
    readBoard,
    getRows,
    // identity / owner
    resolveOwnerIdentity,
    ensureCurrentAgentIdentity,
    maybeCanonicalOwner,
    findDoingTicketForOwner,
    // agent-session readers
    readAgentsRegistry,
    readAgentSessions,
    resolveAgentIdentifier,
    compareSessionsMostRecentFirst,
    resolveEffectiveThreadId,
    // readiness / scoring deps
    evaluateReadiness,
    splitDependsOn,
    isRepoBackedCode,
    // blocker formatting
    formatTransitiveBlockerDetails,
    formatDependencyCycleList,
    // misc
    integerOrDefault,
    // GovernanceError thrower
    fail,
  } = deps;

  function listTickets(filters) {
    const board = readBoard();
    let rows = getRows(board);
    const ownerFilter = filters.owner ? maybeCanonicalOwner(filters.owner) : null;

    if (filters.status) {
      rows = rows.filter((row) => row.Status === filters.status);
    }
    if (filters.repo) {
      rows = rows.filter((row) => row.Repo === filters.repo);
    }
    if (ownerFilter) {
      rows = rows.filter((row) => row.Owner === ownerFilter);
    } else if (filters.owner) {
      rows = rows.filter((row) => row.Owner === filters.owner);
    }
    if (filters.pri) {
      rows = rows.filter((row) => row.Pri === filters.pri);
    }

    if (rows.length === 0) {
      console.log("No matching tickets.");
      return;
    }

    for (const row of rows) {
      console.log(`${row.ID}\t${row.Status}\t${row.Repo}\t${row.Pri}\t${row.Owner}\t${row.Description}`);
    }
  }

  function pickTickets(scope, filters) {
    if (scope && scope !== "all") {
      fail(`Unknown pick scope "${scope}". Use "pick" or "pick all".`);
    }
    if (scope === "all") {
      return pickAllTickets(filters);
    }
    return pickCurrentAgentTickets(filters);
  }

  function pickCurrentAgentTickets(filters) {
    const identity = filters.owner
      ? resolveOwnerIdentity(filters.owner, { allowAutoClaim: false, touchSession: false })
      : ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    const owner = identity.agent.handle;
    const board = readBoard();
    const ownerDoing = findDoingTicketForOwner(board, owner);
    if (ownerDoing) {
      console.log(`Current agent ${identity.agent.id} (${owner}) already owns active doing ticket ${ownerDoing.ID}.`);
      return;
    }

    const scored = buildRecommendationSet(filters, {
      board,
      mode: recommendationModeForAgent(identity.agent, filters),
    });
    if (filters.why) {
      const match = scored.scored.find((item) => item.row.ID === filters.why);
      if (!match) {
        fail(`Ticket ${filters.why} was not found in the current pick candidate set for ${owner}.`);
      }
      console.log(JSON.stringify({
        agent: {
          id: identity.agent.id,
          handle: identity.agent.handle,
          lane: identity.agent.lane || null,
          default_repo: identity.agent.default_repo || null,
        },
        ticket: match.row,
        readiness: match.readiness,
        score: match.breakdown,
        has_prompt: match.hasPrompt,
        downstream_open_dependents: match.downstreamOpen,
      }, null, 2));
      return;
    }

    const limit = integerOrDefault(filters.limit, 5);
    const top = scored.visible.slice(0, limit);
    if (top.length === 0) {
      console.log(`No matching recommended tickets for ${owner}.`);
      return;
    }

    console.log(
      `Current agent: ${identity.agent.id}\t${owner}\tlane:${identity.agent.lane || "general"}\tdefault-repo:${identity.agent.default_repo || "X"}`
    );
    printRankedTicketList(`Ordered ticket list for ${owner}`, top, scored.visible.length);
  }

  function pickAllTickets(filters) {
    if (filters.owner) {
      fail('"pick all" does not accept --owner. Use plain "pick" for one agent or "recommend" for raw board scoring.');
    }
    if (filters.why) {
      fail('"pick all" does not support --why. Use plain "pick --why <ticket-id>" or "recommend --why <ticket-id>".');
    }

    const board = readBoard();
    const idleAgents = listIdleActiveAgentSessions(board);
    if (idleAgents.length === 0) {
      let currentIdentity = null;
      try {
        currentIdentity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      } catch {
        currentIdentity = null;
      }
      const busyAgents = summarizeBusyActiveAgents(board);
      if (!currentIdentity) {
        console.log("No idle active agents are available for pick all, and the current thread is not claimed.");
        console.log("Next: coord/scripts/gov claim --owner <handle|simple-id>");
      } else {
        console.log(`No idle active agents are available for pick all. Current thread is claimed as ${currentIdentity.agent.handle} (${currentIdentity.agent.id}).`);
      }
      if (busyAgents.length > 0) {
        console.log("Active agents already holding doing tickets:");
        for (const entry of busyAgents) {
          console.log(`- ${entry.agent.id}/${entry.agent.handle}\t${entry.ticket.ID}\t${entry.ticket.Repo}\t${entry.ticket.Pri}\t${entry.ticket.Description}`);
        }
      }
      return;
    }

    const recommendationPools = idleAgents.map((entry) => ({
      ...entry,
      mode: recommendationModeForAgent(entry.agent, filters),
      scored: buildRecommendationSet(filters, {
        board,
        mode: recommendationModeForAgent(entry.agent, filters),
      }).visible,
    }));
    const limit = Math.max(1, integerOrDefault(filters.limit, 5));
    const assignments = assignTicketsToAgents(recommendationPools, limit);
    if (assignments.length === 0) {
      console.log("No matching recommended tickets are available for the current idle active agents.");
      return;
    }

    console.log(`Idle active agents (${idleAgents.length}): ${idleAgents.map((entry) => `${entry.agent.id}/${entry.agent.handle}`).join(", ")}`);
    console.log(`Ordered multi-agent picks (${assignments.length}/${Math.min(limit, idleAgents.length)} shown):`);
    for (const [index, assignment] of assignments.entries()) {
      console.log(
        `${index + 1}. ${assignment.agent.id}\t${assignment.agent.handle}\tmode:${assignment.mode}\t-> ${formatRankedTicket(assignment.item)}`
      );
    }
  }

  function recommendTickets(filters) {
    const scored = buildRecommendationSet(filters);

    if (filters.why) {
      const match = scored.scored.find((item) => item.row.ID === filters.why);
      if (!match) {
        fail(`Ticket ${filters.why} was not found in the current recommendation candidate set.`);
      }
      console.log(JSON.stringify({
        ticket: match.row,
        readiness: match.readiness,
        score: match.breakdown,
        has_prompt: match.hasPrompt,
        downstream_open_dependents: match.downstreamOpen,
      }, null, 2));
      return;
    }

    const limit = integerOrDefault(filters.limit, 5);
    const top = scored.visible.slice(0, limit);
    if (top.length === 0) {
      console.log("No matching recommended tickets.");
      return;
    }

    printRankedTicketList("Ordered ticket list", top, scored.visible.length);
  }

  function buildRecommendationSet(filters, options = {}) {
    const board = options.board || readBoard();
    const rows = options.rows || getRows(board);
    const byId = options.byId || new Map(rows.map((row) => [row.ID, row]));
    const downstreamCounts = options.downstreamCounts || buildDownstreamCounts(rows);
    const mode = options.mode || filters.mode || inferModeFromRepo(filters.repo);

    let candidates = rows.filter((row) => row.Status === STATUS.TODO);
    if (filters.repo) {
      candidates = candidates.filter((row) => row.Repo === filters.repo);
    }
    if (filters.pri) {
      candidates = candidates.filter((row) => row.Pri === filters.pri);
    }

    const scored = candidates.map((row) => {
      const readiness = evaluateReadiness(row, byId, board);
      const downstreamOpen = downstreamCounts.get(row.ID) || 0;
      const hasPrompt = Boolean(board.prompt_index?.[row.ID]);
      const breakdown = scoreTicket(row, readiness, {
        downstreamOpen,
        hasPrompt,
        mode,
      });
      return {
        row,
        readiness,
        downstreamOpen,
        hasPrompt,
        breakdown,
        score: breakdown.total,
      };
    });

    const visible = filters.includeBlocked
      ? scored
      : scored.filter((item) => item.readiness.ready);

    visible.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.row.ID.localeCompare(b.row.ID);
    });

    return { board, rows, byId, mode, scored, visible };
  }

  function printRankedTicketList(title, items, totalVisible) {
    console.log(`${title} (${items.length}/${totalVisible} shown):`);
    for (const [index, item] of items.entries()) {
      console.log(`${index + 1}. ${formatRankedTicket(item)}`);
    }
  }

  function formatRankedTicket(item) {
    const transitiveDetails = formatTransitiveBlockerDetails(item.readiness.blockerChains);
    const blockedNote = item.readiness.ready
      ? "ready"
      : item.readiness.cycles.length > 0
        ? `blocked by cycle ${formatDependencyCycleList(item.readiness.cycles)}`
        : transitiveDetails
          ? `blocked by ${item.readiness.blockedBy.join(", ") || "dependency state"} via ${transitiveDetails}`
          : `blocked by ${item.readiness.blockedBy.join(", ") || "dependency state"}`;
    const promptNote = item.hasPrompt ? "prompt" : "no-prompt";
    return `${item.row.ID}\t${item.row.Repo}\t${item.row.Pri}\t${blockedNote}\tunblocks:${item.downstreamOpen}\t${promptNote}\tscore:${item.score}\t${item.row.Description}`;
  }

  function recommendationModeForAgent(agent, filters) {
    if (filters.mode) {
      return filters.mode;
    }
    if (agent?.lane && agent.lane !== "general") {
      return agent.lane;
    }
    if (filters.repo) {
      return inferModeFromRepo(filters.repo);
    }
    if (agent?.default_repo) {
      return inferModeFromRepo(agent.default_repo);
    }
    return "general";
  }

  function summarizeBusyActiveAgents(board, options = {}) {
    const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
    const sessions = Array.isArray(options.sessions) ? options.sessions : readAgentSessions();
    return sessions
      .filter((session) => session.status === "active" && session.board_path === state.BOARD_PATH)
      .sort(compareSessionsMostRecentFirst)
      .map((session) => {
        const resolved = resolveAgentIdentifier(session.handle, agents);
        if (!resolved || resolved.agent.status !== "active") {
          return null;
        }
        const doing = findDoingTicketForOwner(board, resolved.agent.handle);
        if (!doing) {
          return null;
        }
        return {
          agent: resolved.agent,
          session,
          ticket: doing,
        };
      })
      .filter(Boolean);
  }

  function listIdleActiveAgentSessions(board, options = {}) {
    const agents = Array.isArray(options.agents) ? options.agents : readAgentsRegistry();
    const sessions = (Array.isArray(options.sessions) ? options.sessions : readAgentSessions())
      .filter((session) => session.status === "active" && session.board_path === state.BOARD_PATH)
      .sort(compareSessionsMostRecentFirst);
    const deduped = [];
    const seenHandles = new Set();
    for (const session of sessions) {
      if (!session.handle || seenHandles.has(session.handle)) {
        continue;
      }
      seenHandles.add(session.handle);
      const resolved = resolveAgentIdentifier(session.handle, agents);
      if (!resolved || resolved.agent.status !== "active") {
        continue;
      }
      if (findDoingTicketForOwner(board, resolved.agent.handle)) {
        continue;
      }
      deduped.push({ agent: resolved.agent, session });
    }
    deduped.sort((left, right) => left.agent.id.localeCompare(right.agent.id));
    return deduped;
  }

  function buildReleaseCandidates(board, options = {}) {
    const effectiveThread = Object.prototype.hasOwnProperty.call(options, "effectiveThread")
      ? options.effectiveThread
      : resolveEffectiveThreadId();
    return listIdleActiveAgentSessions(board, options).map(({ agent, session }) => ({
      agent,
      session,
      is_current_thread: Boolean(effectiveThread && session.thread_id === effectiveThread),
      reason: "active session has no doing ticket",
      release_commands: [
        `coord/scripts/gov agent-release ${session.session_id}`,
        `coord/scripts/gov agent-release ${agent.id}`,
      ],
    }));
  }

  function assignTicketsToAgents(recommendationPools, limit) {
    const usedTickets = new Set();
    const usedAgents = new Set();
    const assignments = [];
    const cap = Math.min(limit, recommendationPools.length);

    while (assignments.length < cap) {
      let best = null;
      for (const pool of recommendationPools) {
        if (usedAgents.has(pool.agent.handle)) {
          continue;
        }
        const nextItem = pool.scored.find((item) => !usedTickets.has(item.row.ID));
        if (!nextItem) {
          continue;
        }
        const candidate = {
          agent: pool.agent,
          session: pool.session,
          mode: pool.mode,
          item: nextItem,
        };
        if (!best || compareAssignedCandidates(candidate, best) < 0) {
          best = candidate;
        }
      }
      if (!best) {
        break;
      }
      assignments.push(best);
      usedAgents.add(best.agent.handle);
      usedTickets.add(best.item.row.ID);
    }

    return assignments;
  }

  function compareAssignedCandidates(left, right) {
    if (right.item.score !== left.item.score) {
      return right.item.score - left.item.score;
    }
    const ticketCmp = left.item.row.ID.localeCompare(right.item.row.ID);
    if (ticketCmp !== 0) {
      return ticketCmp;
    }
    return left.agent.id.localeCompare(right.agent.id);
  }

  function scoreTicket(row, readiness, context) {
    const parts = {
      ready_bonus: readiness.ready ? 1000 : 0,
      priority_bonus: row.Pri === "P0" ? 300 : row.Pri === "P1" ? 200 : row.Pri === "P2" ? 100 : 0,
      repo_bonus: isRepoBackedCode(row.Repo) ? 30 : row.Repo === "X" ? 10 : 0,
      downstream_bonus: Math.min(200, (context.downstreamOpen || 0) * 25),
      prompt_bonus: context.hasPrompt ? 25 : -60,
      dependency_bonus: readiness.deps.length === 0 ? 20 : Math.max(0, 20 - readiness.deps.length * 5),
      mode_bonus: modeBiasScore(row, context.mode),
      mode: context.mode,
    };
    const total =
      parts.ready_bonus +
      parts.priority_bonus +
      parts.repo_bonus +
      parts.downstream_bonus +
      parts.prompt_bonus +
      parts.dependency_bonus +
      parts.mode_bonus;
    return {
      ...parts,
      total,
    };
  }

  function buildDownstreamCounts(rows) {
    const counts = new Map();
    for (const row of rows) {
      // COORD-285: a `proposed` (quarantined) dependent is not yet accepted work,
      // so it must not inflate a ticket's "unblocks N" downstream-open count — only
      // real, non-terminal work counts as a downstream that a ticket unblocks.
      if (
        row.Status === STATUS.DONE ||
        row.Status === STATUS.SUPERSEDED ||
        row.Status === STATUS.PROPOSED
      ) {
        continue;
      }
      for (const dep of splitDependsOn(row["Depends On"])) {
        counts.set(dep, (counts.get(dep) || 0) + 1);
      }
    }
    return counts;
  }

  function inferModeFromRepo(repo) {
    if (repo === "B") {
      return "backend";
    }
    if (repo === "F") {
      return "frontend";
    }
    if (repo === "X") {
      return "design";
    }
    return "general";
  }

  function modeBiasScore(row, mode) {
    switch (mode) {
      case "backend":
        if (row.Repo === "B") {
          return 180;
        }
        if (row.Repo === "X") {
          return 15;
        }
        return -120;
      case "frontend":
        if (row.Repo === "F") {
          return 180;
        }
        if (row.Repo === "X") {
          return 15;
        }
        return -120;
      case "design":
        if (row.Repo === "X") {
          return 200;
        }
        return -80;
      case "general":
      default:
        return 0;
    }
  }

  return {
    listTickets,
    pickTickets,
    recommendTickets,
    recommendationModeForAgent,
    summarizeBusyActiveAgents,
    listIdleActiveAgentSessions,
    buildReleaseCandidates,
    scoreTicket,
    buildDownstreamCounts,
  };
};
