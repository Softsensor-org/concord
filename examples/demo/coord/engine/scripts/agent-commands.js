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
const { appendSessionBinding } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/session-binding-order.js"));
const approvalVerifier = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/approval-verifier.js"));
const { createClaimApprovalAuthority } = require("./claim-transfer-approval-state.js");
// COORD-725 (upstream CUST-013): rebuilding a missing lock is safety-critical and
// self-contained, so it lives in its own module rather than inline here.
const { restoreMissingTicketLock } = require("./missing-ticket-lock.js");
const { assertReviewWorkspaceTransferable, transferDetailsForPreservedWorkspace } = require("./review-workspace-evidence.js");
const { previewClaimTransfer } = require("./claim-transfer-preview.js");
const { assertStoredContextPackAckValid } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/context-pack-ack-contract.js"));
const { assertFactoryDependencies } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/factory-deps.js"));
// COORD-680 round 5: GovernanceError is IMPORTED, never injected. It was a
// classified "callable" dependency, but `typeof === "function"` does not mean
// usable as an `instanceof` right-hand side: an arrow function passes that
// check and has `prototype === undefined`, so construction succeeded and the
// instanceof site then threw
//   TypeError: Function has non-object prototype 'undefined' in instanceof check
// Tightening the classification to "constructor" would work, but removing the
// INJECTION POINT removes the whole class -- there is no wiring left to get
// wrong. (The test had also masked this by filling every callable with arrow
// noops.)
const { GovernanceError } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-context.js"));

// COORD-680: a required helper that is omitted from the deps object (or passed
// as a bare shorthand that resolved to `undefined`) used to survive wiring and
// only explode later, at the call site of whichever verb reached it first --
// `gov resume` threw `TypeError: ensureGovernedWorkspaceForTicket is not a
// function` AFTER it had already rebound the ticket lock. Validate at
// construction instead, so a wiring defect can never present as a partially
// applied governed mutation.
const REQUIRED_AGENT_COMMAND_DEPS = {
  callable: [
    "fail",
    "withGovernanceMutation",
    "withAgentStateLock",
    "withCoordStateLock",
    "appendGovernanceEvent",
    "readBoard",
    "writeBoard",
    "getTicketRef",
    "inferTicketStatus",
    "runBoardSync",
    "findLockForTicket",
    "isDoingStatus",
    "resolveTicketGitContext",
    "writeLock",
    "ensureGovernedWorkspaceForTicket",
    "getLockFiles",
    "rebindTicketLock",
    "detectActiveSameOwnerOtherThread",
    "buildActiveSameOwnerOtherThreadMessage",
    "detectColocatedForeignSessions",
    "buildColocatedForeignSessionMessage",
    "recordGovernanceCollision",
    "normalizeLockIdentityReferences",
    "readAgentsRegistry",
    "readAgentSessions",
    "writeAgentRegistryFile",
    "writeJsonFile",
    "resolveAgentIdentifier",
    "allocateAgentSimpleId",
    "buildDefaultAgentHandle",
    "buildSessionId",
    "ensureCurrentAgentIdentity",
    "canonicalizeOwnerOrFail",
    "detectRuntimeProvider",
    "providerConfig",
    "assertRuntimeProviderMatchesAgent",
    "runtimeHasStableSessionIdentity",
    "findActiveProviderSessions",
    "defaultHostLabel",
    "currentRuntimeThreadId",
    "resolveEffectiveThreadId",
    "resolveOrCreateEffectiveThreadId",
    "summarizeBusyActiveAgents",
    "listIdleActiveAgentSessions",
    "buildReleaseCandidates",
    "safeReadJson",
    "parseLifecycleFlags",
  ],
  value: [
    "state",
    "COORD_DIR",
    "identityV2",
    "PROVIDER_REGISTRY",
    "STATUS",
  ],
};


function approvalJournalDetails(approval) {
  return {
    approval_record: approval?.record_id || null,
    approval_verified: approval?.key_id ? `key_id=${approval.key_id}` : null,
    approval_subject_sha256: approval?.subject_sha256 || null,
    human_admin_session: approval?.session_id || null,
  };
}

module.exports = function createAgentCommands(deps = {}) {
  assertFactoryDependencies("createAgentCommands", deps, REQUIRED_AGENT_COMMAND_DEPS);
  const {
    // process/runtime constants + objects
    fail,
    state,
    COORD_DIR,
    identityV2,
    PROVIDER_REGISTRY,
    STATUS,
    // mutation + lock wrappers
    withGovernanceMutation,
    withAgentStateLock,
    withCoordStateLock,
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
    isDoingStatus,
    resolveTicketGitContext,
    writeLock,
    ensureGovernedWorkspaceForTicket,
    getLockFiles,
    rebindTicketLock,
    detectActiveSameOwnerOtherThread,
    buildActiveSameOwnerOtherThreadMessage,
    detectColocatedForeignSessions,
    buildColocatedForeignSessionMessage,
    recordGovernanceCollision,
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
  const claimApproval = createClaimApprovalAuthority(deps, resolveHumanAdminOverride);

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
      case "recover-lease-registry":
        return recoverOwnerLeaseRegistry(parseLeaseRecoveryFlags(rest));
      default:
        fail('agents requires one of: list, register, disable, enable, recover-lease-registry.');
    }
  }

  // COORD-824: the governed recovery for the corrupt v2 owner-lease registry
  // that COORD-812 refuses. Its own strict flag set: nothing here is shared
  // with the lifecycle verbs, and an unknown flag must never be ignored.
  const LEASE_RECOVERY_FLAGS = Object.freeze({
    "--registry": "registry",
    "--expect-sha256": "expectSha256",
    "--restore-from": "restoreFrom",
    "--human-admin-override": "humanAdminOverride",
  });

  // Only this verb's own flags are refused as a value; any other text, even
  // text that starts with "--", is a value (a reason may begin "-- see ticket").
  function isLeaseRecoveryFlag(arg) {
    return arg === "--approve-empty" || Object.hasOwn(LEASE_RECOVERY_FLAGS, arg);
  }

  function parseLeaseRecoveryFlags(args) {
    const options = {};
    const seen = new Set();
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index];
      const value = args[index + 1];
      if (!isLeaseRecoveryFlag(flag)) {
        fail(`agents recover-lease-registry: unknown argument "${flag}".`);
      } else if (seen.has(flag)) {
        fail(`agents recover-lease-registry: ${flag} was given more than once; name each flag once.`);
      }
      seen.add(flag);
      if (flag === "--approve-empty") {
        options.approveEmpty = true;
      } else if (value === undefined || isLeaseRecoveryFlag(value)) {
        fail(`${flag} requires a value` + (value === undefined ? "." : `, not the flag "${value}".`));
      } else {
        index += 1;
        options[LEASE_RECOVERY_FLAGS[flag]] = value;
      }
    }
    return options;
  }

  function recoverOwnerLeaseRegistry(options) {
    const mutation = { command: "agents-recover-lease-registry" };
    return withGovernanceMutation(mutation, () => {
      const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
      mutation.identity = identity;
      const request = {
        ...options,
        reason: options.humanAdminOverride,
        actor: { handle: identity.agent.handle, session_id: identity.session.session_id },
      };
      let event;
      try {
        // The agent-state lock serializes this against claim/handoff writers.
        event = withAgentStateLock(() => identityV2.recoverRegistry(state.RUNTIME_DIR, request, {
          journal: (details) => appendGovernanceEvent({ ts: new Date().toISOString(), ...details }),
          knownHandles: readAgentsRegistry().map((agent) => agent.handle),
          authorize: (record) => {
            // The record timestamp is intentionally excluded from the signed state so an admin
            // can inspect a refusal digest and approve the same exact recovery on retry. All
            // authority-relevant inputs are included: corrupt bytes, replacement, actor and mode.
            const stableRecord = { ...record };
            delete stableRecord.recorded_at;
            delete stableRecord.human_admin_override_reason;
            const approval = approvalVerifier.requireSignedOverride({
              commandName: "agents recover-lease-registry", ticketId: "owner-lease-registry",
              row: { ...stableRecord, request: {
                registry: options.registry, expect_sha256: options.expectSha256,
                restore_from: options.restoreFrom || null, approve_empty: options.approveEmpty === true,
              } },
              options, deps: { ...deps, runtimeDir: state.RUNTIME_DIR, resolveHumanAdminOverride },
            }).approval;
            mutation.details = {
              approval_record: approval.record_id,
              approval_verified: `key_id=${approval.key_id}`,
              approval_subject_sha256: approval.subject_sha256,
              human_admin_session: approval.session_id,
            };
            return {
              record_id: approval.record_id,
              key_id: approval.key_id,
              subject_sha256: approval.subject_sha256,
              human_admin_session: approval.session_id,
            };
          },
        }));
      } catch (error) {
        return fail(error.message);
      }
      console.log(JSON.stringify(event, null, 2));
    });
  }
  
  function listAgents() {
    const agents = readAgentsRegistry();
    const sessions = readAgentSessions();
    if (agents.length === 0) {
      console.log("No registered agents.");
      return;
    }
  
    for (const agent of agents) {
      const activeSessions = sessions.filter((session) => activeSessionMatches(session, "handle", agent.handle));
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
      if (options.assign === true) assertAssignmentPreservesHeldOwnerLease();
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

  // COORD-812: every v2 consumer in this module reads the lease registry here.
  // An unreadable/corrupt registry (or any reader failure) is a refusal — never
  // an empty registry, which would authorize a fresh acquisition.
  function readOwnerLeaseRegistryOrFail() {
    try {
      return identityV2.readRegistry(state.RUNTIME_DIR);
    } catch (error) {
      return fail(error.message);
    }
  }

  // guard:owner-lease
  function assertAssignmentPreservesHeldOwnerLease() {
    const envIdent = identityV2.readEnvIdentity();
    if (!envIdent.present) return; // Preserve ordinary legacy assignment.

    const registry = readOwnerLeaseRegistryOrFail();
    const heldOwners = Object.entries(registry.leases)
      .filter(([, lease]) => lease?.instance_id === envIdent.instanceId)
      .map(([owner]) => owner)
      .filter((owner) => {
        const check = identityV2.assertCanMutate(registry, envIdent, {
          owner,
          requireTicketOwner: false,
        });
        return check.decision.allowed && check.decision.action === "held";
      });
    if (heldOwners.length === 0) return;

    const threadId = resolveEffectiveThreadId();
    const sessions = readAgentSessions({ readOnly: true });
    const active = sessions.find((session) => activeSessionMatches(session, "thread_id", threadId)) || null;
    if (active && heldOwners.includes(active.handle)) return;

    const owners = [...new Set(heldOwners)].sort();
    const ownerHint = owners.length === 1 ? owners[0] : owners.join(", ");
    fail(
      `This trusted instance already holds the ${ownerHint} owner lease; ` +
      "--assign cannot mint or bind a different owner. Bind the intended owner explicitly with " +
      `\`coord/scripts/gov claim --owner ${owners[0]}\` first.`
    );
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
      ...formatCurrentAgentIdPayload(null, { needs_assignment: true }),
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
  
        const provider = options.provider || detectRuntimeProvider();
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
  
    const mutation = { command: "claim", allowProvenanceDrift: true };
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
    // COORD-725: a blocked ticket's status is "doing (blocked: <reason>)", so an
    // exact comparison refused to resume the owner's OWN in-flight work and told
    // them to `start` it again — the third site where a blocked ticket was second
    // class. isDoingStatus is the status-family test used elsewhere in this file.
    if (!isDoingStatus(ref.row.Status) && ref.row.Status !== STATUS.REVIEW) {
      fail(
        `Ticket ${ticketId} must be doing or review to resume; current status is "${ref.row.Status}". ` +
        `Use \`coord/scripts/gov claim ${ticketId}\` for passive inspection or \`coord/scripts/gov start ${ticketId}\` for new work.`
      );
    }
  
    // COORD-680: resume must have ONE commit boundary across BOTH steps.
    //
    // The rebind (`claimTicket`) and the workspace post-condition
    // (`ensureGovernedWorkspaceForTicket`) were separate transactions, so a
    // workspace failure could only be COMPENSATED: the rebind was already
    // journalled successful, and rewriting the lock bytes afterwards left the
    // journal asserting a rebind the filesystem no longer showed -- trading a
    // partial mutation for governance drift.
    //
    // TWO ORDERINGS WERE TRIED. Hoisting the workspace check ABOVE the claim
    // (so nothing is mutated when it fails) is REFUTED: the same-owner
    // other-thread ownership guard lives INSIDE `claimTicket`, so hoisting
    // inverts guard precedence -- a resume that must fail closed on a fresh
    // same-owner lock instead performs workspace reconstruction first and
    // throws a workspace error. See the regression at
    // `agent-commands.test.js` ("resume must refuse to displace a fresh
    // same-owner other-thread lock"), which fails with a GovernanceError from
    // `ensureGovernedWorkspaceForTicket` instead of
    // `active_same_owner_other_thread`. Ownership refusal must precede any
    // workspace side effect.
    //
    // So the ORDER is unchanged -- claim first, guards first -- and the
    // TRANSACTION BOUNDARY moves outward instead. `withGovernanceMutation` is
    // re-entrant: a nested call joins the active context by depth rather than
    // opening its own (coord/engine/scripts/journal.js), so `claimTicket`'s inner mutation becomes
    // part of THIS one and no longer commits independently.
    //
    // That yields real atomicity from existing machinery rather than
    // compensation. On any throw, `withGovernanceMutation` restores its
    // captured restore point -- which covers the lock files
    // (`existingLockDirs()`, `*.lock`), the board, the agent + session
    // registries, plan records and rendered views -- and raises a rollback
    // failure as a typed compound GovernanceError instead of swallowing it. No
    // hand-rolled lock snapshot is needed or wanted.
    //
    // On the journal: a clean rollback writes NO event at all -- not a failure
    // event. `withGovernanceMutation` appends `result: "failed"` ONLY when the
    // rolled-back mutation had already produced EXTERNAL side effects that
    // rollback cannot undo. With governed state fully restored and nothing
    // external done, the transaction did not happen, so there is nothing to
    // record. That is the observable difference from the compensating model
    // this replaced: compensation left a SUCCESSFUL rebind event plus a
    // correction; atomicity leaves nothing.
    //
    // COORD-635 still holds: resume never returns while the isolation
    // post-condition is unmet.
    const mutation = {
      command: "resume",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      // Resume is a recovery/handoff path, exactly like the `claim-ticket`
      // mutation it now encloses -- which has always carried this intent. Now
      // that the OUTER mutation owns the commit boundary, it is the one the
      // COORD-273 journal-lost seal evaluates, so the recovery intent must be
      // declared here or resume would refuse on precisely the stale-journal
      // state it exists to repair.
      allowProvenanceDrift: true,
    };
    return withGovernanceMutation(mutation, () => {
      const claimed = claimTicket(ticketId, {
        ...options,
        force: true,
      });

      const lock = findLockForTicket(ticketId);
      if (lock && lock.worktree) {
        ensureGovernedWorkspaceForTicket({
          ticketId,
          row: ref.row,
          worktree: lock.worktree,
          branch: lock.branch,
          stage: "resume",
        });
      }
      return claimed;
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
    // COORD-922: --dry-run is a read-only transfer preview; it never enters the mutation below.
    if (options.dryRun) return previewClaimTransfer(ticketId, options, { ...deps, resolveHumanAdminOverride });
    const mutation = {
      command: "claim-ticket",
      ticket: ticketId,
      beforeStatus: inferTicketStatus(ticketId),
      allowProvenanceDrift: true,
    };
    return withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) {
        fail(`Unknown ticket "${ticketId}".`);
      }
      // COORD-723: claim and claim --transfer-to are not review-gated, so they
      // never saw the acknowledgement at all; a malformed one surfaced only as a
      // post-mutation board-validation rollback. Refuse here, before the session
      // claim, lock rebind and owner write below.
      assertStoredContextPackAckValid(ticketId, { state, fail, verb: options.transferTo ? "claim --transfer-to" : "claim" });
      if ([STATUS.TODO, STATUS.DEFERRED].includes(ref.row.Status)) {
        if (!options.optimistic) {
          fail(
            `Ticket ${ticketId} is still ${ref.row.Status} under owner ${ref.row.Owner}. ` +
            `Use \`coord/scripts/gov start ${ticketId}\` to claim work through the lifecycle instead of \`claim ${ticketId}\`, ` +
            `or use \`coord/scripts/gov claim ${ticketId} --optimistic\` to reserve owner intent without creating a lock.`
          );
        }
        const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false });
        mutation.identity = identity;
        const owner = identity.agent.handle;
        let claimedRow = null;
        withCoordStateLock(() => {
          const nextBoard = readBoard();
          const nextRef = getTicketRef(nextBoard, ticketId);
          if (!nextRef) {
            fail(`Unknown ticket "${ticketId}".`);
          }
          if (![STATUS.TODO, STATUS.DEFERRED].includes(nextRef.row.Status)) {
            fail(
              `Optimistic claim conflict for ${ticketId}: status changed to "${nextRef.row.Status}" before claim commit. ` +
              "Re-read the ticket and use resume/start as appropriate."
            );
          }
          const currentOwner = String(nextRef.row.Owner || "").trim();
          const unassigned = !currentOwner || currentOwner === "unassigned";
          if (!unassigned && currentOwner !== owner) {
            fail(
              `Optimistic claim conflict for ${ticketId}: already owned by ${currentOwner}; current owner is ${owner}.`
            );
          }
          nextRef.row.Owner = owner;
          claimedRow = { ...nextRef.row };
          writeBoard(nextBoard);
          runBoardSync({ ignoreActiveTicketLockErrors: true });
        });
        mutation.details = {
          optimistic: true,
          owner,
          status: claimedRow.Status,
          lock_created: false,
        };
        console.log(JSON.stringify({
          ticket: ticketId,
          owner,
          status: claimedRow.Status,
          optimistic: true,
          lock_created: false,
          agent: identity.agent,
          session: identity.session,
        }, null, 2));
        return;
      }
      if (!ref.row.Owner || ref.row.Owner === "unassigned") {
        fail(`Ticket ${ticketId} has no assigned owner to claim. Use start/repair first, or pass --owner without a ticket-id.`);
      }
  
      const previousOwner = canonicalizeOwnerOrFail(ref.row.Owner);
      const targetOwner = options.transferTo || previousOwner;
      const isOwnerTransfer = Boolean(options.transferTo && targetOwner !== previousOwner);
      // COORD-920: a review ticket holds no lock; its PR workspace is checked BEFORE any write.
      const preservedWorkspace = assertReviewWorkspaceTransferable({ isOwnerTransfer, ticketId, row: ref.row, currentOwner: previousOwner, prRefs: board.pr_index?.[ticketId], fail });
      let lock = findLockForTicket(ticketId);
      const targetAgent = isOwnerTransfer ? resolveAgentIdentifier(targetOwner, readAgentsRegistry()) : null;
      if (isOwnerTransfer && (!targetAgent || targetAgent.agent.status !== "active")) {
        fail(`Unknown or inactive transfer target "${targetOwner}".`);
      }
      const { override, transferAuthorization } = claimApproval.authorizeClaim({ isOwnerTransfer, ticketId,
        row: ref.row, lock, previousOwner, targetOwner, targetAgent: targetAgent?.agent, options, preservedWorkspace });
      let payload;
      if (isOwnerTransfer) {
        payload = claimAgentSession(targetOwner, {
          ...options,
          force: options.force === true,
        }, transferAuthorization);
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
            // COORD-572 (instance 3): this refusal used to say "use an explicit
            // human-admin transfer path" and NAME NOTHING, while resolving that
            // very path from --transfer-to twenty lines above. An unnamed
            // mechanism reads as a missing mechanism, which is how the same
            // class of gap produced four other wrongly-filed tickets. Name it.
            "If this is an intentional takeover, the explicit human-admin transfer path is: " +
            `coord/scripts/gov claim ${ticketId} --transfer-to ${identity.agent.handle} ` +
            '--human-admin-override "<why the transfer is authorized>"'
          );
        }
        payload = claimPayloadFromCurrentIdentity(identity);
      }
      mutation.identity = { agent: payload.agent, session: payload.session, autoClaimed: false };

      // COORD-011: same-owner owner-lease gate. resume/claim (and --handoff/--force)
      // must NOT displace a live same-owner session running on a different thread.
      // Only an explicit human-admin override may take over a fresh other-thread
      // holder. Owner transfers run through their own override path above. This
      // runs BEFORE the broader co-located guard so a same-owner other-thread
      // resume keeps its specific owner-lease remediation.
      if (!isOwnerTransfer && !String(options.humanAdminOverride || "").trim()) {
        const currentThreadId = payload.session?.thread_id || currentRuntimeThreadId();
        const otherThread = detectActiveSameOwnerOtherThread(ticketId, lock, { currentThreadId });
        if (otherThread.present) {
          fail(buildActiveSameOwnerOtherThreadMessage(ticketId, otherThread, options));
        }
      }

      // COORD-222: enforce "one governed writer per checkout/runtime". If another
      // heartbeat-fresh governed session is already bound to this runtime on a
      // different thread, refuse — unless the operator explicitly opts into the
      // documented shared-worktree topology (or has already asserted a human-admin
      // override, which signals an operator who knows what they are doing). The
      // current session's own thread never trips this (lone/resume are safe).
      if (options.allowSharedWorktree !== true && !String(options.humanAdminOverride || "").trim()) {
        const currentThreadId = payload.session?.thread_id || currentRuntimeThreadId();
        const colocated = detectColocatedForeignSessions({ currentThreadId });
        if (colocated.present) {
          // COORD-223: journal the co-located refusal as an auditable collision.
          recordGovernanceCollision({
            ticket: ticketId,
            conflictType: "co-located-session",
            verb: "claim",
            contenders: colocated.foreign_sessions,
            extra: { current_thread_id: colocated.current_thread_id },
          });
          // guard:co-located-writer
          fail(buildColocatedForeignSessionMessage("claim", colocated));
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
          forced_rebind: payload.forced_rebind || null,
          ...approvalJournalDetails(override.approval),
        };
      }

      if (preservedWorkspace) mutation.details = { ...mutation.details, ...transferDetailsForPreservedWorkspace(preservedWorkspace, { from: previousOwner, to: payload.canonical_owner, reason: override.reason, previousSessionId }) };
  
      if (isOwnerTransfer) {
        const nextBoard = readBoard();
        const nextRef = getTicketRef(nextBoard, ticketId);
        if (nextRef) {
          // COORD-725: a doing ticket whose lock has gone missing was a DEADLOCK —
          // transfer refused because there was no lock to rebind, and the only
          // offered escape (`claim --force`) rebinds the owner, i.e. destroys the
          // thing being repaired. Rebuild it first, from the ticket's OWN registered
          // worktree, and only after ownership has already been authorized above.
          if (!lock && isDoingStatus(nextRef.row.Status)) {
            // COORD-729: an owner transfer normally skips the same-owner
            // live-session guard, on the grounds that the human-admin override
            // authorized it. But a MISSING lock is where we hold the least
            // evidence, and handing a live agent's workspace to a second agent is
            // exactly the snatching identity exists to prevent. The override
            // authorizes acting on a foreign ticket; it does not authorize
            // displacing a live holder — `takeover` is the named, auditable path
            // for that. The lock is gone, so ownership is probed from the board
            // row, which is the authoritative source in its absence.
            const liveOwner = detectActiveSameOwnerOtherThread(
              ticketId,
              { owner: previousOwner, status: STATUS.DOING, session_id: null },
              { currentThreadId: payload.session?.thread_id || currentRuntimeThreadId() }
            );
            if (liveOwner.present) {
              fail(buildActiveSameOwnerOtherThreadMessage(ticketId, liveOwner, options));
            }
            // Rebuild in the PREVIOUS owner's name, then let the ordinary
            // transfer rebind below pin workspace_owner and append provenance.
            // Reusing COORD-663's mechanism keeps ONE definition of "a
            // transferred lock may keep its implementation location" — upstream
            // added a second, journal-reading one, which the donor does not need.
            lock = restoreMissingTicketLock({
              ticketId,
              row: nextRef.row,
              owner: previousOwner,
              session: payload.session,
              resolveTicketGitContext,
              writeLock,
              findLockForTicket,
            });
            mutation.details.recreated_lock = true;
          }
          nextRef.row.Owner = payload.canonical_owner;
          writeBoard(nextBoard);
          if (lock) {
            // COORD-663: record the transfer on the lock so the preserved
            // worktree/branch namespace is ATTESTED rather than merely
            // tolerated for the duration of this one mutation.
            reboundLock = rebindTicketLock(lock, payload.agent, payload.session, {
              transfer: {
                from: previousOwner,
                reason: override.reason,
                previousSessionId,
              },
            });
          }
          // COORD-663: no longer suppresses the canonical-location checks. The
          // transferred lock is now VALID under them, because they resolve the
          // namespace from workspace_owner. Suppressing them here is what let
          // the wedge ship: the mutation passed and every later one failed.
          if (reboundLock) {
            // Journaled provenance for the retained implementation location.
            mutation.details.preserved_workspace = {
              worktree: reboundLock.worktree,
              branch: reboundLock.branch,
            };
          }
          runBoardSync({ ignoreActiveTicketLockErrors: true });
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
    const mutation = { command: "agent-claim", allowProvenanceDrift: true };
    return withGovernanceMutation(mutation, () => {
      // COORD-812: read the lease registry BEFORE the legacy session binding is
      // written, so an untrustworthy registry refuses ahead of any state change.
      const v2Ident = identityV2.readEnvIdentity();
      const reg = v2Ident.present ? readOwnerLeaseRegistryOrFail() : null;
      // COORD-893: with v2 identity, --handoff liveness is the owner lease (TTL).
      const v2LeaseLive = reg ? (owner) => identityV2.leaseHeldByOtherLiveInstance(reg, owner, v2Ident.instanceId) : null;
      const payload = claimAgentSession(subject, { ...options, v2LeaseLive });
      mutation.identity = { agent: payload.agent, session: payload.session, autoClaimed: false };
      if (payload.forced_rebind) mutation.details = { forced_rebind: payload.forced_rebind };
      if (payload.takeover_approval) mutation.details = { ...mutation.details,
        ...approvalJournalDetails(payload.takeover_approval) };
      // GCV-1 Phase-5: bind the live instance to the owner lease in the v2
      // registry (Design 2 — one explicit claim). --handoff (Design 5a)
      // displaces a live same-owner holder; without it a live conflict
      // fails closed telling the operator to use --handoff (no silent steal).
      let v2HandoffNote = null;
      if (v2Ident.present) {
        const owner = payload.canonical_owner;
        const acq = identityV2.registerAndAcquire(reg, v2Ident, owner, {
          handoff: Boolean(options.handoff),
          reason: options.reason,
        });
        if (!acq.decision.allowed) {
          fail(acq.decision.message);
        }
        // COORD-811: the v2 lease is live mutation authority, so the claim is
        // only real once it is durable. A failed write fails the command; the
        // surrounding governed mutation then rolls back the legacy session
        // binding written above, and the atomic registry write has left the
        // previous holder in place.
        let leaseBefore;
        try {
          leaseBefore = identityV2.snapshotRegistry(state.RUNTIME_DIR);
          identityV2.writeRegistry(state.RUNTIME_DIR, acq.registry);
        } catch (error) {
          fail(
            `Owner lease for ${owner} was not persisted (${error.message}). ` +
            "The claim did not take effect: the previous durable lease holder is unchanged and no session was bound. " +
            `Fix the runtime registry write failure, then re-run \`coord/scripts/gov claim --owner ${owner}\`.`
          );
        }
        if (acq.decision.action === "handoff" && acq.decision.handoff) {
          const handoff = acq.decision.handoff;
          // GCV-1 5a: a handoff is the journaled event + lease transfer +
          // revocation together. If the event cannot be journaled, undo the
          // transfer rather than report (or leave behind) an unaudited one.
          try {
            appendGovernanceEvent({
              ts: new Date().toISOString(),
              command: "owner-lease-handoff",
              owner,
              from_instance: handoff.from_instance,
              to_instance: handoff.to_instance,
              reason: handoff.reason,
            });
          } catch (error) {
            let rollback = "The lease transfer was rolled back; the previous holder is unchanged and no session was bound.";
            try {
              identityV2.restoreRegistry(state.RUNTIME_DIR, leaseBefore);
            } catch (restoreError) {
              rollback =
                `Rolling the lease transfer back ALSO failed (${restoreError.message}): ` +
                `the registry may name ${handoff.to_instance} without a journaled handoff. Inspect ` +
                `${identityV2.registryPath(state.RUNTIME_DIR)} before any further ${owner} mutation.`;
            }
            fail(
              `Owner lease handoff for ${owner} (${handoff.from_instance} -> ${handoff.to_instance}) ` +
              `could not be journaled (${error.message}). ${rollback}`
            );
          }
          v2HandoffNote = handoff;
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
  
  function createExplicitSession(agent, options, threadId, now) {
    return {
      session_id: buildSessionId(agent),
      agent_id: agent.id,
      handle: agent.handle,
      session_label: options.sessionLabel || `${defaultHostLabel()}:${process.pid}`,
      host: options.host || defaultHostLabel(),
      cwd: options.cwd || process.cwd(),
      board_path: state.BOARD_PATH,
      board_root: COORD_DIR,
      thread_id: threadId,
      claimed_at: now,
      last_seen_at: now,
      released_at: null,
      status: "active",
      auto_claimed: false,
    };
  }

  function activeSessionMatches(session, field, value) {
    return session[field] === value &&
      session.board_path === state.BOARD_PATH &&
      session.status === "active";
  }

  function claimAgentSession(subject, options = {}, transferAuthorizationCandidate = null) {
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
      // The missing-thread case has already failed above, so this lookup always
      // has a concrete thread id and does not need a nullable fallback branch.
      const existingThreadSession = sessions.find((session) => activeSessionMatches(session, "thread_id", currentThreadId));
      const sessionState = claimApproval.sessionState({ existingThreadSession, sessions, targetAgent: resolved.agent, currentThreadId, provider });
      const transferAuthorization = claimApproval.validateTransfer(transferAuthorizationCandidate,
        { ...sessionState, targetAgent: resolved.agent, currentThreadId, force: options.force, handoff: options.handoff });
      // An unstable runtime can only have a fallback thread for a registered provider.
      if (!stableRuntimeIdentity && existingThreadSession && existingThreadSession.handle !== resolved.agent.handle) {
        fail(
          `Current runtime is using an unstable ${provider} fallback and is already bound to ${existingThreadSession.handle} (${existingThreadSession.agent_id}). ` +
          `Release that session or provide ${providerConfig(provider).envThread} before claiming a different owner.`
        );
      }
      if (existingThreadSession && existingThreadSession.handle === resolved.agent.handle) {
        existingThreadSession.last_seen_at = new Date().toISOString();
        if (options.cwd) {
          existingThreadSession.cwd = options.cwd;
        }
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
        return claimPayloadFromCurrentIdentity({ agent: resolved.agent, session: existingThreadSession });
      }
      if (existingThreadSession && existingThreadSession.handle !== resolved.agent.handle && !options.force) {
        fail(
          `Current thread already owns ${existingThreadSession.handle} (${existingThreadSession.agent_id}) via session ${existingThreadSession.session_id}. ` +
          `For an intentional session rebind, run \`coord/scripts/gov claim --owner ${resolved.agent.handle} --force\`; ` +
          "a live v2 owner-lease conflict still requires an explicit same-owner --handoff."
        );
      }
      if (existingThreadSession && options.force) {
        existingThreadSession.status = "released";
        existingThreadSession.released_at = new Date().toISOString();
      }
      const existingActive = sessions.find((session) => activeSessionMatches(session, "handle", resolved.agent.handle));
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
          `Return to that session, release a stray that holds no work with \`coord/scripts/gov agent-release ${existingActive.session_id} --human-admin-override "<reason>"\`, ` +
          'or pass --handoff --human-admin-override "<reason>" for an authorized takeover (COORD-893).'
        );
      }
      if (!stableRuntimeIdentity) {
        const competingProviderSession = findActiveProviderSessions(provider, sessions, agents).find((session) =>
          session.thread_id !== currentThreadId
        );
        if (competingProviderSession) {
          fail(
            `Provider ${provider} already has active session ${competingProviderSession.session_id} for ${competingProviderSession.handle} and this runtime has no stable session identity. ` +
            `Release the competing ${provider} session or provide ${providerConfig(provider).envThread} before claiming another one.`
          );
        }
      }
      // COORD-893: --force/--handoff is not authority over ANOTHER session's
      // live binding (a sub-agent with an invented session id used it to take
      // a coordinator's handle). Only a human-admin override may do that.
      // Liveness: the legacy idle window (expired sessions never reach here),
      // or for a v2 --handoff the owner lease TTL, so crash recovery is free.
      const overrideReason = String(options.humanAdminOverride || "").trim();
      const flag = options.force ? "--force" : "--handoff";
      const live = options.force || !options.v2LeaseLive || options.v2LeaseLive(resolved.agent.handle);
      const takeoverApproval = claimApproval.authorizeTakeover({ existingActive, live, overrideReason, flag,
        resolved, currentThreadId, options, sessionState, transferAuthorization });
      if (existingActive) {
        existingActive.status = "released";
        existingActive.released_at = new Date().toISOString();
      }
  
      const now = new Date().toISOString();
      const session = createExplicitSession(resolved.agent, options, currentThreadId, now);
      // COORD-893: every forced rebind names the session(s) it displaced and
      // the one it bound. The caller journals it in its own mutation event, so
      // a rolled-back claim leaves no rebind record behind (COORD-811).
      const displaced = [options.force && existingThreadSession, existingActive].filter(Boolean);
      appendSessionBinding(sessions, session);
      writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
      const payload = {
        agent: resolved.agent,
        session,
        owner_arg: resolved.agent.id,
        canonical_owner: resolved.agent.handle,
        ...(displaced.length > 0 ? { forced_rebind: {
          kind: "agent-forced-rebind",
          flag,
          handle: resolved.agent.handle,
          from_session_ids: displaced.map((entry) => entry.session_id),
          from_thread_ids: displaced.map((entry) => entry.thread_id),
          to_session_id: session.session_id,
          to_thread_id: currentThreadId,
          override_reason: overrideReason || null,
        } } : {}),
        ...(takeoverApproval ? { takeover_approval: takeoverApproval } : {}),
      };
      return payload;
    });
  }

  function releaseAgent(subject, options) {
    const mutation = { command: "agent-release", allowProvenanceDrift: true };
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
          targets = sessions.filter((session) => activeSessionMatches(session, "handle", resolved.agent.handle));
        } else {
          targets = sessions.filter((session) => activeSessionMatches(session, "session_id", subject));
        }

        if (targets.length === 0) {
          // An exact session-id retry may acknowledge its own already-closed interval.
          targets = sessions.filter((session) => session.session_id === subject &&
            session.board_path === state.BOARD_PATH && session.status === "released");
          if (targets.length === 0) {
            const expired = sessions.filter((session) => session.board_path === state.BOARD_PATH &&
              session.status === "expired" && (resolved
                ? session.handle === resolved.agent.handle : session.session_id === subject));
            if (expired.length > 0) {
              // Acknowledge normalized inactivity so this successful mutation
              // retains expiry. No live release, parking or ownership change.
              mutation.details = { release_status: "already_expired", sessions: expired.map(session => session.session_id) };
              console.log(`Session ${subject} is already expired; no active session was released.`);
              return;
            }
            fail(`No active session found for "${subject}".`);
          }
        }
        if (targets.every((session) => session.status === "released")) {
          console.log(`Session ${subject} is already released.`);
          return;
        }
        if (targets.length > 1 && !options.force) {
          fail(`Multiple active sessions matched "${subject}". Select an exact session ID; --force selects all but does not authorize foreign release.`);
        }

        const threadId = currentRuntimeThreadId();
        const overrideReason = String(options.humanAdminOverride || "").trim();
        const foreignTargets = targets.filter((session) => !threadId || session.thread_id !== threadId);
        const heldWork = foreignTargets.map((session) => ({ session_id: session.session_id,
          ticket_locks: resolved ? [] : locksHeldBySession(session.session_id) }));
        let stray = false;
        // A human-authorized handoff may park a foreign session. A bare handle,
        // inactivity or --force is not authority to release another live agent,
        // and neither is the session holding no work (COORD-689).
        for (const session of targets) {
          if (!threadId || session.thread_id !== threadId) {
            const held = resolved ? [] : locksHeldBySession(session.session_id);
            if (!overrideReason) {
              if (held.length > 0) {
                fail(`Session ${session.session_id} holds work (${held.join(", ")}). Foreign release of a session ` +
                  "that holds locks requires --human-admin-override with an authorized handoff reason.");
              }
              fail("Foreign session release requires --human-admin-override with an authorized reason, " +
                "even for a stray session that holds no work: " +
                "`coord/scripts/gov agent-release <session-id> --human-admin-override \"<reason>\"`.");
            }
            if (!resolved && held.length === 0) {
              // COORD-893: an authorized stray release, named by exact session id,
              // parks no work; the caller may have lost its own binding.
              stray = true;
              mutation.identity = currentIdentityOrNull();
            } else {
              mutation.identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
            }
          } else {
            const agent = resolveAgentIdentifier(session.handle, agents)?.agent;
            if (!agent) fail("Session release requires a registered owner.");
            assertRuntimeProviderMatchesAgent(agent);
            mutation.identity = { agent, session, autoClaimed: false };
          }
        }
        const approval = overrideReason && foreignTargets.length > 0
          ? approvalVerifier.requireSignedOverride({ commandName: "agent-release", ticketId: resolved?.agent.handle || String(subject),
            row: { subject, targets, current_thread_id: threadId, foreign_work: heldWork }, options,
            deps: { ...deps, runtimeDir: deps.state.RUNTIME_DIR, resolveHumanAdminOverride } }).approval
          : null;
        mutation.details = { release_reason: stray ? "stray_no_work" : "explicit",
          sessions: targets.map((session) => session.session_id),
          ...approvalJournalDetails(approval),
          ...(stray ? { handle: targets[0].handle } : {}),
          // A stray release always carries the override reason, so only the
          // bound thread's own release can fall through to the default.
          reason: String(options.reason || overrideReason || "Explicit release by the bound thread") };
        const now = new Date().toISOString();
        // Active selection and acknowledgement of released history are mutually exclusive.
        for (const session of targets) {
          session.release_reason = "explicit";
          session.status = "released";
          session.released_at = now;
          session.last_seen_at = now;
        }
        writeJsonFile(state.AGENT_SESSIONS_PATH, sessions);
        if (stray) {
          console.log(`Session ${subject} (${targets[0].handle}) holds no work; released it.`);
          return;
        }
        console.log(`Released ${targets.length} session(s) for ${subject}.`);
      });
    });
  }

  // COORD-893: ticket locks bound to a session id, i.e. the work it holds.
  function locksHeldBySession(sessionId) {
    return getLockFiles()
      .map((lockPath) => normalizeLockIdentityReferences(safeReadJson(lockPath)))
      .filter((lock) => lock?.session_id === sessionId)
      .map((lock) => lock.ticket);
  }

  // The stray-release caller may itself hold no session (its own was displaced);
  // the release is then journaled with the caller's thread id instead.
  function currentIdentityOrNull() {
    try {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    } catch (error) {
      if (!isNoActiveClaimedSessionError(error)) throw error;
      return null;
    }
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
  
    const mutation = { command: "agent-rebind", allowProvenanceDrift: true };
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
          ? sessions.find((session) => activeSessionMatches(session, "thread_id", effectiveThread))
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
        const newSession = createExplicitSession(freshAgent, options, newThreadId, now);
        appendSessionBinding(sessions, newSession);
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
        ? sessions.find((session) => activeSessionMatches(session, "thread_id", effectiveThread)) || null
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

module.exports.DEP_CONTRACT = REQUIRED_AGENT_COMMAND_DEPS;
