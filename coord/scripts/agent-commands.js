"use strict";

// Wave 4 slice 3 (COORD-087): the AGENT-COMMAND / claim-orchestration surface
// extracted from lifecycle.js. This module is the COMMAND LAYER that sits ABOVE
// the lower-level session engine in governance-session.js: the `agents`
// list/register/enable/disable verbs, the `agentid` resolver + payload
// formatting, the claim/claim-ticket/claim-agent/claim-agent-session cluster,
// resume, release, rebind, the human-admin override resolver, the cwd-claim
// hazard detector, and the agent-status report builder.
//
// BOUNDARY: governance-session.js REMAINS the session engine — it owns the
// registry/session readers+writers, identity resolution, owner-lease semantics
// and lock rebinding. agent-commands.js never re-implements those; it INJECTS
// them (and the board-state readers, the mutation/lock wrappers, the journal
// event appender, and the ticket-status helpers). The claim/resume seam that
// reaches into ticket-transitions-adjacent flows (findLockForTicket,
// detectActiveSameOwnerOtherThread) is likewise injected as deferred
// `(...args) => fn(...args)` wrappers so wiring order / hoisting never matters
// at call time. identityV2 (the env-channel owner-lease registry) and the
// PROVIDER_REGISTRY metadata are passed through as-is.
//
// Every command-layer behavior assertion (claim flows, rebind, release, agentid
// payloads, registry status, cwd-claim-hazard, human-admin override) moved to
// agent-commands.test.js. The session-engine behavior tests (identity-v2,
// owner-lease, two-thread isolation) deliberately stay with governance-session.

const path = require("path");

module.exports = function createAgentCommands(deps = {}) {
  const {
    // process/runtime constants + objects
    fail,
    state,
    COORD_DIR,
    identityV2,
    PROVIDER_REGISTRY,
    GovernanceError,
    STATUS,
    // mutation + lock wrappers
    withGovernanceMutation,
    withAgentStateLock,
    // journal
    appendGovernanceEvent,
    // board-state readers/writers
    readBoard,
    writeBoard,
    getTicketRef,
    inferTicketStatus,
    runBoardSync,
    // lock helpers (defined later in lifecycle; injected deferred)
    findLockForTicket,
    getLockFiles,
    rebindTicketLock,
    detectActiveSameOwnerOtherThread,
    buildActiveSameOwnerOtherThreadMessage,
    normalizeLockIdentityReferences,
    // session-engine: registry + session readers/writers
    readAgentsRegistry,
    readAgentSessions,
    writeAgentRegistryFile,
    writeJsonFile,
    resolveAgentIdentifier,
    allocateAgentSimpleId,
    buildDefaultAgentHandle,
    buildSessionId,
    // session-engine: identity + provider resolution
    ensureCurrentAgentIdentity,
    canonicalizeOwnerOrFail,
    detectRuntimeProvider,
    providerConfig,
    assertRuntimeProviderMatchesAgent,
    runtimeHasStableSessionIdentity,
    findActiveProviderSessions,
    defaultHostLabel,
    currentRuntimeThreadId,
    resolveEffectiveThreadId,
    resolveOrCreateEffectiveThreadId,
    // agent-status report builders
    summarizeBusyActiveAgents,
    listIdleActiveAgentSessions,
    buildReleaseCandidates,
    // misc helpers
    safeReadJson,
    parseLifecycleFlags,
  } = deps;

  function agentsCommand(args) {
    const [subcommand, ...rest] = args;
    switch (subcommand) {
      case "list":
        return listAgents();
      case "register":
        return registerAgent(parseLifecycleFlags(rest));
      case "disable":
        return setAgentRegistryStatus(rest[0], "disabled");
      case "enable":
        return setAgentRegistryStatus(rest[0], "active");
      default:
        fail('agents requires one of: list, register, disable, enable.');
    }
  }
  
  function listAgents() {
    const agents = readAgentsRegistry();
    const sessions = readAgentSessions();
    if (agents.length === 0) {
      console.log("No registered agents.");
      return;
    }
  
    for (const agent of agents) {
      const activeSessions = sessions.filter((session) =>
        session.handle === agent.handle && session.board_path === state.BOARD_PATH && session.status === "active"
      );
      console.log(
        `${agent.id}\t${agent.handle}\t${agent.status}\t${agent.lane || "-"}\t${agent.provider || "-"}\tactive_sessions:${activeSessions.length}`
      );
    }
  }
  
  function printCurrentAgentId(options = {}) {
    const allowed = new Set(["assign", "owner"]);
    const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      fail(
        `agentid only accepts --assign or --owner <handle|simple-id>; unsupported option(s): ${unexpected.join(", ")}.`
      );
    }
    if (options.assign && options.owner) {
      fail("agentid accepts either --assign or --owner <handle|simple-id>, not both.");
    }
  
    if (options.assign || options.owner) {
      const mutation = {
        command: "agentid",
        details: {
          mode: options.owner ? "owner" : "assign",
          owner: options.owner || null,
        },
      };
      return withGovernanceMutation(mutation, () => {
        const resolved = resolveCurrentAgentId(options);
        mutation.identity = resolved.identity;
        console.log(JSON.stringify(resolved.payload, null, 2));
      });
    }
  
    const resolved = resolveCurrentAgentId(options);
    console.log(JSON.stringify(resolved.payload, null, 2));
  }
  
  function resolveCurrentAgentId(options = {}) {
    if (options.owner) {
      const claimed = claimAgentSession(options.owner, options);
      const identity = {
        agent: claimed.agent,
        session: claimed.session,
        autoClaimed: false,
        autoRegistered: false,
      };
      return {
        identity,
        payload: formatCurrentAgentIdPayload(identity, {
          requested_owner: canonicalizeOwnerOrFail(options.owner),
        }),
      };
    }
  
    try {
      const identity = ensureCurrentAgentIdentity({
        allowAutoClaim: options.assign === true,
        touchSession: false,
      });
      return {
        identity,
        payload: formatCurrentAgentIdPayload(identity),
      };
    } catch (error) {
      if (options.assign || !isNoActiveClaimedSessionError(error)) {
        throw error;
      }
      return {
        identity: null,
        payload: buildUnclaimedAgentIdPayload(),
      };
    }
  }
  
  function formatCurrentAgentIdPayload(identity, extra = {}) {
    return {
      id: identity?.agent?.id || null,
      handle: identity?.agent?.handle || null,
      session_id: identity?.session?.session_id || null,
      auto_claimed: identity?.autoClaimed === true,
      auto_registered: identity?.autoRegistered === true,
      needs_assignment: false,
      ...extra,
    };
  }
  
  function buildUnclaimedAgentIdPayload() {
    return {
      id: null,
      handle: null,
      session_id: null,
      auto_claimed: false,
      auto_registered: false,
      needs_assignment: true,
      message: "No active claimed agent session is bound to the current thread.",
      next_commands: [
        "coord/scripts/gov agentid --assign",
        "coord/scripts/gov agentid --owner <handle|simple-id>",
        "coord/scripts/gov claim --owner <handle|simple-id>",
        "coord/scripts/gov resume <ticket-id>",
      ],
    };
  }
  
  function isNoActiveClaimedSessionError(error) {
    return (
      error instanceof GovernanceError &&
      /^No active claimed agent session\b/.test(String(error.message || ""))
    );
  }
  
  function registerAgent(options) {
    const mutation = { command: "agents-register" };
    return withGovernanceMutation(mutation, () => {
      withAgentStateLock(() => {
        const agents = readAgentsRegistry();
        const explicitId = options.id ? String(options.id).trim().toLowerCase() : null;
        if (explicitId && agents.some((agent) => agent.id.toLowerCase() === explicitId)) {
          fail(`Agent simple-id ${explicitId} is already registered.`);
        }
  
        const provider = options.provider || detectRuntimeProvider() || "unknown";
        const nextId = explicitId || allocateAgentSimpleId(agents);
        const handle = String(options.handle || buildDefaultAgentHandle(provider, nextId)).trim();
        const existingHandle = agents.find((agent) => agent.handle.toLowerCase() === handle.toLowerCase());
        if (existingHandle) {
          fail(`Agent handle ${handle} is already registered as ${existingHandle.id}.`);
        }
  
        const next = {
          id: nextId,
          handle,
          provider,
          lane: options.lane || "general",
          status: "active",
          default_repo: options.defaultRepo || "X",
          notes: options.notes || "",
          created_at: new Date().toISOString(),
        };
        agents.push(next);
        writeAgentRegistryFile(agents);
        console.log(JSON.stringify(next, null, 2));
      });
    });
  }
  
  function claim(ticketId, options = {}) {
    if (ticketId) {
      return claimTicket(ticketId, options);
    }
  
    if (options.owner) {
      return claimAgent(options.owner, options);
    }
  
    const mutation = { command: "claim", allowRecoverableProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      const identity = ensureCurrentAgentIdentity();
      mutation.identity = identity;
      console.log(JSON.stringify({
        agent: identity.agent,
        session: identity.session,
        autoClaimed: identity.autoClaimed,
        autoRegistered: identity.autoRegistered,
      }, null, 2));
    });
  }
  
  // COORD-011: owner-lease authority for "fresh same-owner other-thread"
  // contention. This works for ALL providers (including legacy Codex, whose
  // thread identity is CODEX_THREAD_ID in the session registry) rather than only
  // the identity-v2 env channel. It surfaces the true live owner/session picture
  // so a non-holder thread cannot silently rebind a live session's ticket lock.
  function resumeTicket(ticketId, options = {}) {
    if (!ticketId) {
      fail("resume requires <ticket-id>.");
    }
  
    const board = readBoard();
    const ref = getTicketRef(board, ticketId);
    if (!ref) {
      fail(`Unknown ticket "${ticketId}".`);
    }
    if (ref.row.Status !== STATUS.DOING && ref.row.Status !== STATUS.REVIEW) {
      fail(
        `Ticket ${ticketId} must be doing or review to resume; current status is "${ref.row.Status}". ` +
        `Use \`coord/scripts/gov claim ${ticketId}\` for passive inspection or \`coord/scripts/gov start ${ticketId}\` for new work.`
      );
    }
  
    return claimTicket(ticketId, {
      ...options,
      force: true,
    });
  }
  
  function resolveHumanAdminOverride(commandName, options = {}, config = {}) {
    const allowLegacyForce = config.allowLegacyForce !== false;
    const explicitReason = String(options.humanAdminOverride || "").trim();
    if (explicitReason) {
      return {
        reason: explicitReason,
        legacyForceAlias: false,
      };
    }
    if (allowLegacyForce && options.force === true) {
      return {
        reason: "<legacy --force migration>",
        legacyForceAlias: true,
      };
    }
    fail(
      `${commandName} requires --human-admin-override "<reason>"` +
      (allowLegacyForce ? " (bare --force is accepted only as a temporary legacy alias)." : ".")
    );
  }
  
  function claimPayloadFromCurrentIdentity(identity) {
    return {
      agent: identity.agent,
      session: identity.session,
      owner_arg: identity.agent.id,
      canonical_owner: identity.agent.handle,
      reused: true,
    };
  }
  
  function claimTicket(ticketId, options = {}) {
    const mutation = {
      command: "claim-ticket",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      allowRecoverableProvenanceDrift: true,
    };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      if (!ref.row.Owner || ref.row.Owner === "unassigned") {
        fail(`Ticket ${ticketId} has no assigned owner to claim. Use start/repair first, or pass --owner without a ticket-id.`);
      }
      if (ref.row.Status === STATUS.TODO || ref.row.Status === STATUS.DEFERRED) {
        fail(
          `Ticket ${ticketId} is still ${ref.row.Status} under owner ${ref.row.Owner}. ` +
          `Use \`coord/scripts/gov start ${ticketId}\` to claim work through the lifecycle instead of \`claim ${ticketId}\`.`
        );
      }
  
      const previousOwner = canonicalizeOwnerOrFail(ref.row.Owner);
      const targetOwner = options.transferTo || previousOwner;
      const isOwnerTransfer = Boolean(options.transferTo && targetOwner !== previousOwner);
      const override = isOwnerTransfer
        ? resolveHumanAdminOverride("claim --transfer-to", options)
        : null;
      let payload;
      if (isOwnerTransfer) {
        payload = claimAgentSession(targetOwner, {
          ...options,
          force: options.force === true,
        });
      } else {
        if (options.owner) {
          const requestedOwner = canonicalizeOwnerOrFail(options.owner);
          if (requestedOwner !== previousOwner) {
            fail(`Ticket ${ticketId} is owned by ${previousOwner}; received --owner ${requestedOwner}.`);
          }
        }
        const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false });
        if (identity.agent.handle !== previousOwner) {
          fail(
            `Ticket ${ticketId} is owned by ${previousOwner}. ` +
            `Current session is ${identity.agent.handle} (${identity.agent.id}) and cannot resume or claim it. ` +
            "Use an explicit human-admin transfer path if this is an intentional takeover."
          );
        }
        payload = claimPayloadFromCurrentIdentity(identity);
      }
      mutation.identity = { agent: payload.agent, session: payload.session, autoClaimed: false };
      const lock = findLockForTicket(ticketId);
  
      // COORD-011: same-owner owner-lease gate. resume/claim (and --handoff/--force)
      // must NOT displace a live same-owner session running on a different thread.
      // Only an explicit human-admin override may take over a fresh other-thread
      // holder. Owner transfers run through their own override path above.
      if (!isOwnerTransfer && !String(options.humanAdminOverride || "").trim()) {
        const currentThreadId = payload.session?.thread_id || currentRuntimeThreadId();
        const otherThread = detectActiveSameOwnerOtherThread(ticketId, lock, { currentThreadId });
        if (otherThread.present) {
          fail(buildActiveSameOwnerOtherThreadMessage(ticketId, otherThread, options));
        }
      }
  
      let reboundLock = null;
      const previousSessionId = lock?.session_id || null;
  
      if (override) {
        mutation.details = {
          previous_owner: previousOwner,
          previous_session_id: previousSessionId,
          transfer_to: payload.canonical_owner,
          override_reason: override.reason,
          legacy_force_alias: override.legacyForceAlias,
        };
      }
  
      if (isOwnerTransfer) {
        const nextBoard = readBoard();
        const nextRef = getTicketRef(nextBoard, ticketId);
        if (nextRef) {
          nextRef.row.Owner = payload.canonical_owner;
          writeBoard(nextBoard);
          if (lock) {
            reboundLock = rebindTicketLock(lock, payload.agent, payload.session);
          }
          runBoardSync({
            ignoreActiveTicketLockErrors: true,
            skipCanonicalLockLocationForTicket: ticketId,
          });
        }
      }
  
      if (lock && !reboundLock) {
        reboundLock = rebindTicketLock(lock, payload.agent, payload.session);
      }
  
      console.log(JSON.stringify({
        ticket: ticketId,
        owner: payload.canonical_owner,
        status: ref.row.Status,
        transferred: isOwnerTransfer,
        previousOwner,
        previous_session_id: previousSessionId,
        agent: payload.agent,
        session: payload.session,
        override_reason: override?.reason || null,
        legacy_force_alias: override?.legacyForceAlias || false,
        lock: reboundLock,
      }, null, 2));
    });
  }
  
  function setAgentRegistryStatus(subject, status) {
    const mutation = { command: status === "active" ? "agents-enable" : "agents-disable" };
    return withGovernanceMutation(mutation, () => {
      withAgentStateLock(() => {
        if (!subject) {
          fail(`agents ${status === "active" ? "enable" : "disable"} requires <handle|simple-id>.`);
        }
        const agents = readAgentsRegistry();
        const resolved = resolveAgentIdentifier(subject, agents);
        if (!resolved) {
          fail(`Unknown registered agent "${subject}".`);
        }
        resolved.agent.status = status;
        writeAgentRegistryFile(agents);
        console.log(`Agent ${resolved.agent.handle} (${resolved.agent.id}) status=${status}.`);
      });
    });
  }
  
  function claimAgent(subject, options) {
    const mutation = { command: "agent-claim", allowRecoverableProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      const payload = claimAgentSession(subject, options);
      mutation.identity = { agent: payload.agent, session: payload.session, autoClaimed: false };
      // GCV-1 Phase-5: bind the live instance to the owner lease in the v2
      // registry (Design 2 — one explicit claim). --handoff (Design 5a)
      // displaces a live same-owner holder; without it a live conflict
      // fails closed telling the operator to use --handoff (no silent steal).
      let v2HandoffNote = null;
      const v2Ident = identityV2.readEnvIdentity();
      if (v2Ident.present) {
        let reg;
        try {
          reg = identityV2.readRegistry(state.RUNTIME_DIR);
        } catch {
          reg = identityV2.emptyRegistry();
        }
        const owner = payload.canonical_owner || payload.agent.handle;
        const acq = identityV2.registerAndAcquire(reg, v2Ident, owner, {
          handoff: Boolean(options.handoff),
          reason: options.reason,
        });
        if (!acq.decision.allowed) {
          fail(acq.decision.message);
        }
        try {
          identityV2.writeRegistry(state.RUNTIME_DIR, acq.registry);
        } catch {
          /* best-effort registry persist; never wedge a valid claim */
        }
        if (acq.decision.action === "handoff" && acq.decision.handoff) {
          v2HandoffNote = acq.decision.handoff;
          try {
            appendGovernanceEvent({
              ts: new Date().toISOString(),
              command: "owner-lease-handoff",
              owner,
              from_instance: v2HandoffNote.from_instance,
              to_instance: v2HandoffNote.to_instance,
              reason: v2HandoffNote.reason,
            });
          } catch {
            /* audit append is best-effort */
          }
        }
      }
      const cwdTicketHint = detectCwdTicketClaimHazard(payload.session, options.cwd);
      console.log(JSON.stringify({
        ...payload,
        ...(cwdTicketHint ? { warning: cwdTicketHint } : {}),
        ...(v2HandoffNote ? { owner_lease_handoff: v2HandoffNote } : {}),
      }, null, 2));
    });
  }
  
  function detectCwdTicketClaimHazard(session, cwdOverride = null) {
    const cwd = path.resolve(cwdOverride || process.cwd());
    let bestMatch = null;
    for (const lockPath of getLockFiles()) {
      const lock = normalizeLockIdentityReferences(safeReadJson(lockPath));
      if (!lock?.ticket || !lock.worktree) {
        continue;
      }
      const worktree = path.resolve(lock.worktree);
      if (cwd !== worktree && !cwd.startsWith(`${worktree}${path.sep}`)) {
        continue;
      }
      if (!bestMatch || worktree.length > bestMatch.worktree.length) {
        bestMatch = {
          ticketId: lock.ticket,
          worktree,
          sessionId: lock.session_id || null,
        };
      }
    }
    if (!bestMatch) {
      return null;
    }
    if (bestMatch.sessionId && bestMatch.sessionId === session?.session_id) {
      return null;
    }
    return (
      `Current cwd is inside governed worktree for ${bestMatch.ticketId}. ` +
      "This claim only bound the agent session; it did not rebind the ticket lock. " +
      `Run \`coord/scripts/gov resume ${bestMatch.ticketId}\` (or \`coord/scripts/gov claim ${bestMatch.ticketId} --force\`) to take over the active ticket.`
    );
  }
  
  function claimAgentSession(subject, options = {}) {
    return withAgentStateLock(() => {
      if (!subject) {
        fail("agent-claim requires <handle|simple-id>.");
      }
  
      const agents = readAgentsRegistry();
      const resolved = resolveAgentIdentifier(subject, agents);
      if (!resolved) {
        fail(`Unknown registered agent "${subject}".`);
      }
      if (resolved.agent.status !== "active") {
        fail(`Agent ${resolved.agent.handle} (${resolved.agent.id}) is not active.`);
      }
  
      const sessions = readAgentSessions();
      const provider = detectRuntimeProvider();
      assertRuntimeProviderMatchesAgent(resolved.agent, options);
      const stableRuntimeIdentity = runtimeHasStableSessionIdentity(provider);
      const currentThreadId = resolveOrCreateEffectiveThreadId();
      if (!currentThreadId) {
        const threadVars = PROVIDER_REGISTRY.map((entry) => entry.envThread).filter(Boolean).join(", ");
        fail(
          "No stable runtime thread id is available for claim. " +
          `Set one of: ${threadVars}, or AGENT_THREAD_ID in the environment.`
        );
      }
      const existingThreadSession = currentThreadId
        ? sessions.find((session) =>
          session.thread_id === currentThreadId &&
          session.board_path === state.BOARD_PATH &&
          session.status === "active"
        )
        : null;
      if (!stableRuntimeIdentity && existingThreadSession && existingThreadSession.handle !== resolved.agent.handle) {
        fail(
          `Current runtime is using an unstable ${provider} fallback and is already bound to ${existingThreadSession.handle} (${existingThreadSession.agent_id}). ` +
          `Release that session or provide ${providerConfig(provider)?.envThread || "AGENT_THREAD_ID"} before claiming a different owner.`
        );
      }
      if (existingThreadSession && existingThreadSession.handle === resolved.agent.handle) {
        existingThreadSession.last_seen_at = new Date().toISOString();
        if (options.cwd) {
          existingThreadSession.cwd = options.cwd;
        }
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
        const payload = {
          agent: resolved.agent,
          session: existingThreadSession,
          owner_arg: resolved.agent.id,
          canonical_owner: resolved.agent.handle,
          reused: true,
        };
        return payload;
      }
      if (existingThreadSession && existingThreadSession.handle !== resolved.agent.handle && !options.force) {
        fail(
          `Current thread already owns ${existingThreadSession.handle} (${existingThreadSession.agent_id}) via session ${existingThreadSession.session_id}. Release it first or use --force.`
        );
      }
      if (existingThreadSession && options.force) {
        existingThreadSession.status = "released";
        existingThreadSession.released_at = new Date().toISOString();
      }
      const existingActive = sessions.find((session) =>
        session.handle === resolved.agent.handle &&
        session.board_path === state.BOARD_PATH &&
        session.status === "active"
      );
      // GCV-1 Design 5a: --handoff is same-owner recovery (the crash /
      // fast-restart escape). The existing-active session here is the SAME
      // owner by construction, so --handoff authorizes releasing it exactly
      // as --force does — otherwise the legacy "already has an active
      // session" gate blocks before the v2 owner-lease handoff can run,
      // re-creating the self-lockout this verb exists to remove.
      const sameOwnerRelease = options.force || options.handoff;
      if (existingActive && !sameOwnerRelease) {
        fail(
          `Agent ${resolved.agent.handle} (${resolved.agent.id}) already has an active session ${existingActive.session_id}. ` +
          `For same-owner recovery use --handoff; otherwise release it first.`
        );
      }
      if (!stableRuntimeIdentity) {
        const competingProviderSession = findActiveProviderSessions(provider, sessions, agents).find((session) =>
          session.thread_id !== currentThreadId
        );
        if (competingProviderSession) {
          fail(
            `Provider ${provider} already has active session ${competingProviderSession.session_id} for ${competingProviderSession.handle} and this runtime has no stable session identity. ` +
            `Release the competing ${provider} session or provide ${providerConfig(provider)?.envThread || "AGENT_THREAD_ID"} before claiming another one.`
          );
        }
      }
      if (existingActive && (options.force || options.handoff)) {
        existingActive.status = "released";
        existingActive.released_at = new Date().toISOString();
      }
  
      const now = new Date().toISOString();
      const session = {
        session_id: buildSessionId(resolved.agent),
        agent_id: resolved.agent.id,
        handle: resolved.agent.handle,
        session_label: options.sessionLabel || `${defaultHostLabel()}:${process.pid}`,
        host: options.host || defaultHostLabel(),
        cwd: options.cwd || process.cwd(),
        board_path: state.BOARD_PATH,
        board_root: COORD_DIR,
        thread_id: currentThreadId,
        claimed_at: now,
        last_seen_at: now,
        released_at: null,
        status: "active",
        auto_claimed: false,
      };
      sessions.push(session);
      writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
      const payload = {
        agent: resolved.agent,
        session,
        owner_arg: resolved.agent.id,
        canonical_owner: resolved.agent.handle,
      };
      return payload;
    });
  }

  function releaseAgent(subject, options) {
    const mutation = { command: "agent-release", allowRecoverableProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      withAgentStateLock(() => {
        if (!subject) {
          fail("agent-release requires <handle|simple-id|session-id>.");
        }

        const agents = readAgentsRegistry();
        const sessions = readAgentSessions();
        const resolved = resolveAgentIdentifier(subject, agents);
        let targets = [];
        if (resolved) {
          targets = sessions.filter((session) =>
            session.handle === resolved.agent.handle &&
            session.board_path === state.BOARD_PATH &&
            session.status === "active"
          );
        } else {
          targets = sessions.filter((session) =>
            session.session_id === subject &&
            session.board_path === state.BOARD_PATH &&
            session.status === "active"
          );
        }

        if (targets.length === 0) {
          fail(`No active session found for "${subject}".`);
        }
        if (targets.length > 1 && !options.force) {
          fail(`Multiple active sessions matched "${subject}". Use --force to release them all.`);
        }

        const now = new Date().toISOString();
        for (const session of targets) {
          session.status = "released";
          session.released_at = now;
          session.last_seen_at = now;
        }
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
        console.log(`Released ${targets.length} session(s) for ${subject}.`);
      });
    });
  }

  function rebindAgent(options = {}) {
    if (!options.fresh) {
      fail(
        "agent-rebind requires --fresh. This is the canonical escape hatch for " +
        "session-handle collisions: releases the current binding (if any) and " +
        "atomically claims a currently-unclaimed handle from the caller's provider pool. " +
        "Does not touch foreign tickets."
      );
    }
  
    const mutation = { command: "agent-rebind", allowRecoverableProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      return withAgentStateLock(() => {
        const provider = detectRuntimeProvider();
        if (provider === "unknown") {
          const threadVars = PROVIDER_REGISTRY.map((entry) => entry.envThread).filter(Boolean).join(", ");
          fail(
            "Cannot determine provider for agent-rebind. " +
            `Set one of: ${threadVars}, or CLAUDECODE / GEMINI_AGENT / GROK_AGENT in the environment.`
          );
        }
  
        const agents = readAgentsRegistry();
        const sessions = readAgentSessions();
        const now = new Date().toISOString();
  
        // Locate the caller's currently-bound session, if any, so we can release it.
        const effectiveThread = resolveEffectiveThreadId();
        const currentSession = effectiveThread
          ? sessions.find((session) =>
              session.thread_id === effectiveThread &&
              session.board_path === state.BOARD_PATH &&
              session.status === "active")
          : null;
  
        const previous = currentSession
          ? { handle: currentSession.handle, session_id: currentSession.session_id, agent_id: currentSession.agent_id }
          : null;
  
        if (currentSession) {
          currentSession.status = "released";
          currentSession.released_at = now;
          currentSession.last_seen_at = now;
        }
  
        // Find a fresh unclaimed handle for this provider. Never reuse the handle we just
        // released (even though it's now free, reusing it defeats the point of rebind).
        const activeHandlesAfterRelease = new Set(
          sessions
            .filter((session) =>
              session.board_path === state.BOARD_PATH &&
              session.status === "active" &&
              (!currentSession || session.session_id !== currentSession.session_id))
            .map((session) => session.handle)
        );
        const freshAgent = agents.find((agent) =>
          agent.provider === provider &&
          agent.status === "active" &&
          (!previous || agent.handle !== previous.handle) &&
          !activeHandlesAfterRelease.has(agent.handle)
        );
  
        if (!freshAgent) {
          fail(
            `No unclaimed ${provider} handle available in the registered pool. ` +
            `Run "coord/scripts/gov agents register --provider ${provider} --handle <name>" first, ` +
            "then retry agent-rebind --fresh."
          );
        }
  
        // Bind the fresh handle to the caller's current runtime thread. Reusing the same
        // thread_id is intentional: subsequent gov commands in this process will resolve
        // to the new handle via ensureCurrentAgentIdentity's thread_id match.
        const newThreadId = resolveOrCreateEffectiveThreadId();
        const newSession = {
          session_id: buildSessionId(freshAgent),
          agent_id: freshAgent.id,
          handle: freshAgent.handle,
          session_label: options.sessionLabel || `${defaultHostLabel()}:${process.pid}`,
          host: options.host || defaultHostLabel(),
          cwd: options.cwd || process.cwd(),
          board_path: state.BOARD_PATH,
          board_root: COORD_DIR,
          thread_id: newThreadId,
          claimed_at: now,
          last_seen_at: now,
          released_at: null,
          status: "active",
          auto_claimed: false,
        };
        sessions.push(newSession);
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
  
        mutation.identity = { agent: freshAgent, session: newSession, autoClaimed: false };
  
        console.log(JSON.stringify({
          previous,
          current: {
            agent_id: freshAgent.id,
            handle: freshAgent.handle,
            session_id: newSession.session_id,
            thread_id: newSession.thread_id,
          },
          note: previous
            ? `Released ${previous.handle} (${previous.session_id}); claimed ${freshAgent.handle} (${newSession.session_id}).`
            : `No prior binding to release; claimed ${freshAgent.handle} (${newSession.session_id}).`,
        }, null, 2));
      });
    });
  }
  
  function showAgentStatus(subject) {
    const payload = buildAgentStatusPayload(subject);
    console.log(JSON.stringify(payload, null, 2));
  }
  
  function buildAgentStatusPayload(subject) {
    const agents = readAgentsRegistry();
    const sessions = readAgentSessions();
    if (!subject) {
      const effectiveThread = resolveEffectiveThreadId();
      const current = effectiveThread
        ? sessions.find((session) =>
          session.thread_id === effectiveThread &&
          session.board_path === state.BOARD_PATH &&
          session.status === "active"
        ) || null
        : null;
      const activeSessions = sessions.filter((session) =>
        session.board_path === state.BOARD_PATH && session.status === "active"
      );
      const board = readBoard();
      return {
        agents,
        current_session: current,
        active_sessions: activeSessions,
        busy_active_agents: summarizeBusyActiveAgents(board, { agents, sessions }),
        idle_active_sessions: listIdleActiveAgentSessions(board, { agents, sessions }),
        release_candidates: buildReleaseCandidates(board, { agents, sessions, effectiveThread }),
      };
    }
  
    const resolved = resolveAgentIdentifier(subject, agents);
    if (!resolved) {
      const bySession = sessions.find((session) => session.session_id === subject);
      if (!bySession) {
        fail(`Unknown agent or session "${subject}".`);
      }
      return { session: bySession };
    }
  
    const activeSessions = sessions.filter((session) => session.handle === resolved.agent.handle);
    const board = readBoard();
    return {
      agent: resolved.agent,
      sessions: activeSessions,
      release_candidates: buildReleaseCandidates(board, { agents, sessions })
        .filter((entry) => entry.agent.handle === resolved.agent.handle),
    };
  }

  return {
    agentsCommand,
    listAgents,
    printCurrentAgentId,
    resolveCurrentAgentId,
    formatCurrentAgentIdPayload,
    buildUnclaimedAgentIdPayload,
    isNoActiveClaimedSessionError,
    registerAgent,
    claim,
    resumeTicket,
    resolveHumanAdminOverride,
    claimPayloadFromCurrentIdentity,
    claimTicket,
    setAgentRegistryStatus,
    claimAgent,
    detectCwdTicketClaimHazard,
    claimAgentSession,
    releaseAgent,
    rebindAgent,
    showAgentStatus,
    buildAgentStatusPayload,
  };
};
