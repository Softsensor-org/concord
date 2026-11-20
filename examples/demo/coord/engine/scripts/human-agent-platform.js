"use strict";

const { governedActorFromSso } = require("./identity-v2.js");

const HUMAN_ROLES = Object.freeze([
  "viewer",
  "business-analyst",
  "approver",
  "admin",
]);

const HUMAN_ACTIONS = Object.freeze([
  "board.view",
  "requirements.draft",
  "requirements.feedback",
  "requirements.approve",
  "ticket.propose",
  "loop.trigger",
]);

const ROLE_GRANTS = Object.freeze({
  viewer: ["board.view"],
  "business-analyst": [
    "board.view",
    "requirements.draft",
    "requirements.feedback",
    "ticket.propose",
  ],
  approver: [
    "board.view",
    "requirements.approve",
    "loop.trigger",
  ],
  admin: HUMAN_ACTIONS,
});

const ROUTES = Object.freeze({
  "GET /v1/boards/:boardId": {
    action: "board.view",
    verb: "board.view",
    mutating: false,
  },
  "POST /v1/boards/:boardId/requirements/drafts": {
    action: "requirements.draft",
    verb: "requirements.propose",
    mutating: true,
  },
  "POST /v1/boards/:boardId/feedback": {
    action: "requirements.feedback",
    verb: "feedback.propose",
    mutating: true,
  },
  "POST /v1/boards/:boardId/requirements/:requirementId/approve": {
    action: "requirements.approve",
    verb: "requirements.approve",
    mutating: true,
  },
  "POST /v1/boards/:boardId/tickets/proposals": {
    action: "ticket.propose",
    verb: "ticket.propose",
    mutating: true,
  },
  "POST /v1/boards/:boardId/loops": {
    action: "loop.trigger",
    verb: "loop.request",
    mutating: true,
  },
});

const CANONICAL_COORD_ARTIFACTS = Object.freeze(["board", "journal", "plans", "requirements"]);
const CONTROL_PLANE_ALLOWED_STORES = Object.freeze([
  "tenant_config",
  "derived_read_cache",
  "transient_queues",
  "transient_sessions",
  "scratch_checkouts",
]);

function normalizePath(pathname) {
  return String(pathname || "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "") || "/";
}

function matchRoute(method, pathname) {
  const cleanMethod = String(method || "").toUpperCase();
  const path = normalizePath(pathname);
  const parts = path.split("/").filter(Boolean);
  for (const [pattern, route] of Object.entries(ROUTES)) {
    const [routeMethod, routePath] = pattern.split(" ");
    if (routeMethod !== cleanMethod) continue;
    const routeParts = routePath.split("/").filter(Boolean);
    if (routeParts.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      const routePart = routeParts[i];
      if (routePart.startsWith(":")) {
        params[routePart.slice(1)] = parts[i];
      } else if (routePart !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { ...route, params, pattern };
  }
  return null;
}

function rolesFromClaims(claims = {}, roleMap = {}) {
  const direct = Array.isArray(claims.roles) ? claims.roles : [];
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  const mapped = groups.flatMap((group) => roleMap[group] || []);
  const roles = [...direct, ...mapped].map((role) => String(role).trim()).filter(Boolean);
  return [...new Set(roles)];
}

function authorizeHumanAction(roles, action) {
  if (!HUMAN_ACTIONS.includes(action)) {
    return { allowed: false, reason: `unknown action '${action}'` };
  }
  for (const role of roles || []) {
    const grants = ROLE_GRANTS[role];
    if (grants && grants.includes(action)) {
      return { allowed: true, role, reason: `granted via ${role}` };
    }
  }
  return {
    allowed: false,
    reason: `none of [${(roles || []).join(", ") || "no roles"}] can ${action}`,
  };
}

function writerKeyForBoard(boardId, writerRegistry = {}) {
  const board = writerRegistry[boardId];
  if (!board) {
    return {
      ok: false,
      reason: `board '${boardId}' has no registered sole writer`,
    };
  }
  if (!board.writer_id || !board.coord_data_repo) {
    return {
      ok: false,
      reason: `board '${boardId}' writer registration is incomplete`,
    };
  }
  return {
    ok: true,
    board_id: boardId,
    writer_id: board.writer_id,
    coord_data_repo: board.coord_data_repo,
    queue_key: `coord-writer:${board.coord_data_repo}`,
  };
}

function buildHumanWriteEnvelope(request, options = {}) {
  const route = matchRoute(request && request.method, request && request.path);
  if (!route) {
    return { allowed: false, status: 404, code: "unknown_route", reason: "No governed human-write route matched." };
  }

  const actorResult = governedActorFromSso(options.trustedClaims || {}, {
    provider: options.provider || "oidc",
    issuer: options.issuer,
    tenantId: options.tenantId,
    ownerPrefix: options.ownerPrefix,
  });
  if (!actorResult.present) {
    return { allowed: false, status: 401, code: "missing_trusted_identity", reason: actorResult.reason };
  }

  const roles = rolesFromClaims(options.trustedClaims || {}, options.roleMap || {});
  const authz = authorizeHumanAction(roles, route.action);
  if (!authz.allowed) {
    return { allowed: false, status: 403, code: "forbidden", reason: authz.reason, action: route.action };
  }

  const boardId = route.params.boardId;
  const writer = writerKeyForBoard(boardId, options.writerRegistry || {});
  if (route.mutating && !writer.ok) {
    return { allowed: false, status: 409, code: "writer_unavailable", reason: writer.reason, action: route.action };
  }

  const body = request && request.body && typeof request.body === "object" ? request.body : {};
  const envelope = {
    version: 1,
    transport: "http+oidc",
    route: route.pattern,
    board_id: boardId,
    action: route.action,
    verb: route.verb,
    mutating: route.mutating,
    actor: actorResult.actor,
    roles,
    authorized_by: authz.role,
    writer: route.mutating ? writer : null,
    params: route.params,
    payload: body.payload && typeof body.payload === "object" ? body.payload : body,
    invariants: [
      "identity comes from trusted OIDC claims supplied by the edge, never request body",
      "web transport emits governed verb envelopes; it does not edit coord files",
      "mutating requests require one registered writer per coord data repo",
    ],
  };
  return { allowed: true, status: route.mutating ? 202 : 200, envelope };
}

async function handleHumanWriteRequest(request, options = {}) {
  const result = buildHumanWriteEnvelope(request, options);
  if (!result.allowed) return result;
  if (!result.envelope.mutating) {
    return { ...result, receipt: { dispatched: false, reason: "read route" } };
  }
  if (typeof options.dispatch !== "function") {
    return { ...result, receipt: { dispatched: false, reason: "dry-run" } };
  }
  const receipt = await options.dispatch(result.envelope);
  return { ...result, receipt };
}

function buildRequirementDraftIntent(input = {}, options = {}) {
  const boardId = String(input.board_id || input.boardId || "").trim();
  const title = String(input.title || "").trim();
  const body = String(input.body || input.text || "").trim();
  return buildHumanWriteEnvelope(
    {
      method: "POST",
      path: `/v1/boards/${boardId}/requirements/drafts`,
      body: {
        payload: {
          title,
          body,
          source: input.source || "human-authored",
          target: input.target || null,
          status: "draft",
        },
      },
    },
    options
  );
}

function buildRequirementFeedbackIntent(input = {}, options = {}) {
  const boardId = String(input.board_id || input.boardId || "").trim();
  return buildHumanWriteEnvelope(
    {
      method: "POST",
      path: `/v1/boards/${boardId}/feedback`,
      body: {
        payload: {
          feedback: String(input.feedback || input.text || "").trim(),
          target: input.target || null,
          requirement_id: input.requirement_id || input.requirementId || null,
          screen_id: input.screen_id || input.screenId || null,
          status: "proposed",
        },
      },
    },
    options
  );
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value).trim()).filter(Boolean)
    : [];
}

function buildGroomingProposal(input = {}, context = {}) {
  const title = String(input.title || input.summary || "").trim();
  const body = String(input.body || input.feedback || input.text || "").trim();
  const personas = normalizeStringArray(input.personas || context.personas);
  const existingRequirements = normalizeStringArray(context.existing_requirements || context.existingRequirements);
  const adrRefs = normalizeStringArray(context.adr_refs || context.adrRefs);
  const openQuestions = [];
  if (!title) openQuestions.push("requirement title is missing");
  if (!body) openQuestions.push("requirement body/feedback text is missing");
  if (personas.length === 0) openQuestions.push("affected persona is unknown");
  if (!input.acceptance_criteria && !input.acceptanceCriteria) {
    openQuestions.push("acceptance criteria are not yet stated");
  }

  const links = {
    personas,
    existing_requirements: existingRequirements,
    adrs: adrRefs,
    source_target: input.target || null,
  };

  const proposedTickets = openQuestions.length === 0
    ? [{
        type: "feature",
        priority: input.priority || "P2",
        title: `Implement requirement: ${title}`,
        rationale: "Human-authored requirement is groomed enough to propose a governed ticket.",
      }]
    : [];

  return {
    kind: "concord.human_agent.requirement_grooming_proposal",
    schema_version: 1,
    status: openQuestions.length === 0 ? "proposed" : "needs_clarification",
    authority: "proposal_only",
    draft_requirement: {
      title,
      body,
      acceptance_criteria: normalizeStringArray(input.acceptance_criteria || input.acceptanceCriteria),
      status: "draft",
    },
    links,
    open_questions: openQuestions,
    proposed_tickets: proposedTickets,
    invariants: [
      "human input is a draft/proposal until promoted by governance",
      "grooming links to existing requirements, ADRs, personas, and open questions",
      "agents propose tickets; humans/governance decide acceptance",
    ],
  };
}

function buildHumanAgentPlatformModel(options = {}) {
  const boardId = options.board_id || options.boardId || "example-board";
  const writerRegistry = options.writerRegistry || {
    [boardId]: { writer_id: "coord-writer-1", coord_data_repo: "Org/coord-example" },
  };
  const sampleClaims = options.trustedClaims || {
    iss: "https://idp.example/tenant",
    tid: "tenant",
    oid: "human-1",
    preferred_username: "analyst@example.com",
    roles: ["business-analyst"],
  };
  const draftIntent = buildRequirementDraftIntent(
    {
      board_id: boardId,
      title: "Capture business rule",
      body: "Business user authored requirement text.",
      personas: ["business-user"],
    },
    { trustedClaims: sampleClaims, writerRegistry }
  );
  const feedbackIntent = buildRequirementFeedbackIntent(
    {
      board_id: boardId,
      feedback: "Screen behavior does not match the intended workflow.",
      requirement_id: "REQ-001",
    },
    { trustedClaims: sampleClaims, writerRegistry }
  );
  return {
    kind: "concord.human_agent.platform_model",
    schema_version: 1,
    read_only_policy: {
      coord_ui_may_write: false,
      mutation_path: "hosted write service -> governed verb envelope -> sole coord-data-repo writer",
    },
    tranches: [
      {
        id: "T1",
        name: "Governed human-write path",
        status: "implemented-contract",
        capabilities: ["trusted SSO actor mapping", "deny-by-default human RBAC", "sole-writer verb envelopes"],
      },
      {
        id: "T2",
        name: "Requirements authoring and feedback",
        status: "implemented-model",
        capabilities: ["draft requirement intent", "targeted feedback intent", "proposal-only grooming output"],
      },
      {
        id: "T3",
        name: "Product-screen bridge",
        status: options.screenIndex ? "implemented-model" : "implemented-model-no-index",
        capabilities: ["screen to requirement mapping", "unmapped screen gap surfacing", "screen-targeted feedback intents"],
      },
      {
        id: "T4",
        name: "Loop orchestration",
        status: "implemented-model",
        capabilities: ["receive-to-return stage plan", "approval/open-question blocking", "evidence-return contract"],
      },
      {
        id: "T5",
        name: "Hosted control plane",
        status: "implemented-model",
        capabilities: ["data-light org-cloud topology", "per-team isolation", "per-tenant conformance attestation"],
      },
    ],
    authoring: {
      statuses: ["draft", "proposed", "accepted"],
      draft_intent: draftIntent.allowed ? draftIntent.envelope : null,
      feedback_intent: feedbackIntent.allowed ? feedbackIntent.envelope : null,
      grooming_pipeline: [
        "receive human-authored draft or targeted feedback",
        "link to personas, existing requirements, ADRs, and surfaces",
        "flag missing acceptance criteria or persona/scope as open questions",
        "propose tickets only when the draft is sufficiently structured",
      ],
    },
    screen_bridge: buildScreenRequirementBridge(options.screenIndex || { apps: [] }, {
      board_id: boardId,
      trustedClaims: sampleClaims,
      writerRegistry,
    }),
    loop: buildLoopOrchestrationPlan({
      board_id: boardId,
      title: "Capture business feedback",
      body: "Human input is groomed, approved, run by agents, verified, and returned.",
      personas: ["business-user"],
      acceptance_criteria: ["Returned output includes evidence and traceability."],
      approval: options.approval || "pending",
    }, {
      trustedClaims: sampleClaims,
      writerRegistry,
      board_id: boardId,
    }),
    deployment: buildHostedControlPlaneTopology(options.deployment || {}),
  };
}

function normalizeScreen(screen = {}, app = {}) {
  const requirementRefs = Array.isArray(screen.requirement_refs)
    ? screen.requirement_refs
    : Array.isArray(screen.requirements)
      ? screen.requirements
      : [];
  return {
    app: String(app.app || app.name || "").trim(),
    id: String(screen.id || screen.route || screen.source || "").trim(),
    title: String(screen.title || screen.route || screen.id || "").trim(),
    route: screen.route || null,
    source: screen.source || null,
    persona_hints: normalizeStringArray(screen.persona_hints || screen.personas),
    requirement_refs: requirementRefs.map((ref) => ({
      doc: String(ref.doc || ref.source || "").trim(),
      anchor: String(ref.anchor || ref.id || "").trim(),
      text: String(ref.text || ref.title || "").trim(),
      confidence: String(ref.confidence || "explicit").trim(),
    })).filter((ref) => ref.anchor || ref.text),
  };
}

function buildScreenFeedbackIntent(input = {}, options = {}) {
  const boardId = String(input.board_id || input.boardId || "").trim();
  return buildRequirementFeedbackIntent({
    board_id: boardId,
    feedback: input.feedback || input.text || "",
    target: {
      kind: "screen",
      screen_id: input.screen_id || input.screenId || null,
      route: input.route || null,
      source: input.source || null,
    },
    screen_id: input.screen_id || input.screenId || null,
    requirement_id: input.requirement_id || input.requirementId || null,
  }, options);
}

function buildScreenRequirementBridge(screenIndex = {}, options = {}) {
  const apps = Array.isArray(screenIndex.apps) ? screenIndex.apps : [];
  const screens = [];
  for (const app of apps) {
    for (const screen of Array.isArray(app.screens) ? app.screens : []) {
      const normalized = normalizeScreen(screen, app);
      const primaryRequirement = normalized.requirement_refs[0] || null;
      const intent = buildScreenFeedbackIntent({
        board_id: options.board_id || options.boardId || "example-board",
        screen_id: normalized.id,
        route: normalized.route,
        source: normalized.source,
        requirement_id: primaryRequirement?.anchor || null,
        feedback: "Business-user screen feedback draft",
      }, options);
      screens.push({
        ...normalized,
        mapped: normalized.requirement_refs.length > 0,
        feedback_intent: intent.allowed ? intent.envelope : null,
        gap: normalized.requirement_refs.length > 0
          ? null
          : "screen has no requirement mapping",
      });
    }
  }
  const mapped = screens.filter((screen) => screen.mapped).length;
  const unmapped = screens.length - mapped;
  return {
    kind: "concord.human_agent.screen_requirement_bridge",
    schema_version: 1,
    status: screens.length === 0 ? "missing_screen_index" : (unmapped > 0 ? "gaps" : "mapped"),
    summary: {
      screens: screens.length,
      mapped,
      unmapped,
    },
    screens,
    gaps: screens.filter((screen) => !screen.mapped).map((screen) => ({
      screen_id: screen.id,
      route: screen.route,
      source: screen.source,
      reason: screen.gap,
    })),
    invariants: [
      "missing screen mappings are gaps, not success",
      "screen feedback uses the governed feedback intent path",
      "inferred screen requirements remain labeled by confidence",
    ],
  };
}

function stage(id, name, actor, mode, input, output, governance) {
  return { id, name, actor, mode, input, output, governance };
}

function buildLoopOrchestrationPlan(input = {}, options = {}) {
  const boardId = String(input.board_id || input.boardId || options.board_id || options.boardId || "").trim();
  const grooming = input.grooming_proposal || buildGroomingProposal(input, {
    existing_requirements: options.existing_requirements || options.existingRequirements || [],
    adr_refs: options.adr_refs || options.adrRefs || ["ADR-0003"],
    personas: input.personas || options.personas || [],
  });
  const approval = String(input.approval || options.approval || "").trim();
  const approved = ["approved", "accepted"].includes(approval.toLowerCase());
  const trigger = buildHumanWriteEnvelope(
    {
      method: "POST",
      path: `/v1/boards/${boardId}/loops`,
      body: {
        payload: {
          source: input.source || "human-input",
          grooming_status: grooming.status,
          approval,
          requested_output: ["updated screens", "requirements traceability", "evidence return"],
        },
      },
    },
    options
  );
  const blockers = [];
  if (grooming.open_questions.length > 0) {
    blockers.push({ code: "open_questions", questions: grooming.open_questions });
  }
  if (!approved) {
    blockers.push({ code: "approval_required", required_role: "approver" });
  }

  const stages = [
    stage(
      "receive",
      "Receive human input",
      "human",
      "human-authored",
      "URS/requirement/feedback draft",
      "governed human-write envelope",
      trigger.allowed ? { verb: trigger.envelope.verb, action: trigger.envelope.action } : { blocked: trigger.reason }
    ),
    stage(
      "groom",
      "Agent grooming",
      "agent:business-analyst",
      "agent-mediated",
      "human-write envelope",
      "proposal with links, open questions, and proposed tickets",
      { artifact: "requirement_grooming_proposal", status: grooming.status }
    ),
    stage(
      "approve",
      "Human approval",
      "human:approver",
      "human-approved",
      "grooming proposal",
      approved ? "approved run request" : "approval blocker",
      { verb: "requirements.approve", required: true, status: approved ? "satisfied" : "pending" }
    ),
    stage(
      "dispatch",
      "Dispatch governed run",
      "orchestrator",
      "automatic-after-approval",
      "approved run request",
      "ticket or agent dispatch manifest",
      { verb: "dispatch-plan", bypasses_lifecycle: false }
    ),
    stage(
      "run",
      "Agent fleet implementation",
      "agent fleet",
      "governed-run",
      "dispatch manifest",
      "commits, tests, evidence, traceability",
      { verbs: ["start", "gate-plan", "submit/finalize"], bypasses_lifecycle: false }
    ),
    stage(
      "verify",
      "Verify output",
      "agent:reviewer",
      "evidence-gated",
      "landed output",
      "verification receipts and traceability",
      { artifacts: ["repo_gates", "feature_proof", "requirement_closure"] }
    ),
    stage(
      "return",
      "Return to human",
      "coord-ui",
      "read-only-return",
      "verification receipts and traceability",
      "updated screens, requirement links, and evidence summary",
      { route: "/human-agent", ui_may_write: false }
    ),
  ];

  return {
    kind: "concord.human_agent.loop_orchestration_plan",
    schema_version: 1,
    status: blockers.length > 0 ? "blocked" : "ready_to_dispatch",
    board_id: boardId,
    blockers,
    stages,
    evidence_return: {
      required: ["updated screens", "requirements traceability", "gate evidence", "feature proof"],
      returned_to: "human reviewer",
      route: "/human-agent",
    },
    invariants: [
      "human-triggered work still uses the proven governed lifecycle",
      "open questions and missing approval block dispatch",
      "coord-ui returns evidence and traceability without mutating state",
    ],
  };
}

function normalizeStores(value) {
  return normalizeStringArray(value).map((entry) => entry.toLowerCase());
}

function defaultHostedTopology() {
  return {
    provider: "org-cloud",
    control_plane: {
      stores: ["tenant_config", "derived_read_cache", "transient_queues", "transient_sessions"],
      canonical_artifacts_at_rest: [],
    },
    tenants: [{
      id: "tenant-1",
      name: "Example org",
      cloud: "azure-or-aws",
      identity_provider: { kind: "oidc", provider: "entra-or-iam-identity-center", issuer: "https://idp.example/tenant" },
      git_app: { provider: "github-app", installation_id: "example-install", allowed_repos: ["Org/coord-team-a"] },
      conformance: { scope: "per-tenant", signer: "tenant-kms-key" },
      teams: [{
        id: "team-a",
        name: "Team A",
        coord_data_repo: "Org/coord-team-a",
        writer: { id: "writer-team-a", singleton: true },
        read_cache: { kind: "derived", canonical: false },
        queues: { kind: "transient" },
        sessions: { kind: "transient" },
      }],
    }],
  };
}

function normalizeHostedControlPlaneInput(input = {}) {
  const seed = input && Object.keys(input).length > 0 ? input : defaultHostedTopology();
  const tenants = Array.isArray(seed.tenants) ? seed.tenants : [];
  const controlPlane = seed.control_plane || seed.controlPlane || {};
  return {
    provider: String(seed.provider || "org-cloud").trim(),
    control_plane: {
      stores: normalizeStores(controlPlane.stores || controlPlane.storage || []),
      canonical_artifacts_at_rest: normalizeStores(
        controlPlane.canonical_artifacts_at_rest || controlPlane.canonicalArtifactsAtRest || []
      ),
    },
    tenants: tenants.map((tenant) => ({
      id: String(tenant.id || tenant.tenant_id || "").trim(),
      name: String(tenant.name || tenant.id || tenant.tenant_id || "").trim(),
      cloud: String(tenant.cloud || tenant.provider || "").trim(),
      identity_provider: tenant.identity_provider || tenant.identityProvider || null,
      git_app: tenant.git_app || tenant.gitApp || null,
      conformance: tenant.conformance || {},
      teams: (Array.isArray(tenant.teams) ? tenant.teams : []).map((team) => ({
        id: String(team.id || team.team_id || "").trim(),
        name: String(team.name || team.id || team.team_id || "").trim(),
        coord_data_repo: String(team.coord_data_repo || team.coordDataRepo || "").trim(),
        writer: team.writer || {},
        read_cache: team.read_cache || team.readCache || {},
        queues: team.queues || {},
        sessions: team.sessions || {},
      })),
    })),
  };
}

function gap(code, severity, message, scope) {
  return { code, severity, message, scope };
}

function buildHostedControlPlaneTopology(input = {}) {
  const topology = normalizeHostedControlPlaneInput(input);
  const gaps = [];
  const canonicalInPlane = [
    ...topology.control_plane.stores,
    ...topology.control_plane.canonical_artifacts_at_rest,
  ].filter((entry) => CANONICAL_COORD_ARTIFACTS.includes(entry));
  if (canonicalInPlane.length > 0) {
    gaps.push(gap(
      "data_light_violation",
      "blocker",
      `control plane stores canonical coord artifact(s): ${[...new Set(canonicalInPlane)].join(", ")}`,
      "control_plane"
    ));
  }
  const unknownStores = topology.control_plane.stores.filter((entry) => !CONTROL_PLANE_ALLOWED_STORES.includes(entry));
  if (unknownStores.length > 0) {
    gaps.push(gap(
      "unknown_control_plane_store",
      "warning",
      `control plane store(s) are not in the data-light allowlist: ${[...new Set(unknownStores)].join(", ")}`,
      "control_plane"
    ));
  }
  if (topology.tenants.length === 0) {
    gaps.push(gap("tenant_missing", "blocker", "no tenant is configured", "control_plane"));
  }

  const writersByRepo = new Map();
  for (const tenant of topology.tenants) {
    if (!tenant.id) {
      gaps.push(gap("tenant_id_missing", "blocker", "tenant id is required", tenant.name || "tenant"));
    }
    if (!tenant.identity_provider) {
      gaps.push(gap("identity_provider_missing", "blocker", "tenant SSO/OIDC provider is required", tenant.id || "tenant"));
    }
    if (!tenant.git_app) {
      gaps.push(gap("git_app_missing", "blocker", "tenant Git app/install is required for coord data repo access", tenant.id || "tenant"));
    }
    if (String(tenant.conformance?.scope || "").trim() !== "per-tenant" || !String(tenant.conformance?.signer || "").trim()) {
      gaps.push(gap("conformance_attestation_missing", "blocker", "per-tenant conformance attestation signer is required", tenant.id || "tenant"));
    }
    if (tenant.teams.length === 0) {
      gaps.push(gap("team_missing", "blocker", "tenant has no team/data-repo mapping", tenant.id || "tenant"));
    }
    for (const team of tenant.teams) {
      if (!team.coord_data_repo) {
        gaps.push(gap("coord_data_repo_missing", "blocker", "team must point at a coord data repo", `${tenant.id}:${team.id || "team"}`));
        continue;
      }
      const writerId = String(team.writer?.id || team.writer_id || "").trim();
      if (!writerId || team.writer?.singleton !== true) {
        gaps.push(gap("sole_writer_missing", "blocker", "team coord data repo must have exactly one singleton writer", team.coord_data_repo));
      }
      const writerSet = writersByRepo.get(team.coord_data_repo) || new Set();
      if (writerId) writerSet.add(writerId);
      writersByRepo.set(team.coord_data_repo, writerSet);
      if (team.read_cache?.canonical === true || String(team.read_cache?.kind || "").toLowerCase() === "canonical") {
        gaps.push(gap("read_cache_canonical", "blocker", "read cache must be derived/rebuildable, never canonical", team.coord_data_repo));
      }
    }
  }
  for (const [repo, writerIds] of writersByRepo.entries()) {
    if (writerIds.size > 1) {
      gaps.push(gap("writer_isolation_violation", "blocker", `coord data repo has multiple writers: ${[...writerIds].join(", ")}`, repo));
    }
  }

  const blockerCount = gaps.filter((entry) => entry.severity === "blocker").length;
  const teamCount = topology.tenants.reduce((total, tenant) => total + tenant.teams.length, 0);
  return {
    kind: "concord.human_agent.hosted_control_plane_topology",
    schema_version: 1,
    status: blockerCount === 0 ? "ready" : "not_ready",
    provider: topology.provider,
    data_light_contract: {
      valid: !gaps.some((entry) => entry.code === "data_light_violation" || entry.code === "read_cache_canonical"),
      canonical_authority: "customer coord data repos",
      control_plane_allowed_stores: [...CONTROL_PLANE_ALLOWED_STORES],
      canonical_artifacts: [...CANONICAL_COORD_ARTIFACTS],
    },
    isolation: {
      tenants: topology.tenants.length,
      teams: teamCount,
      coord_data_repos: writersByRepo.size,
      sole_writer_per_repo: [...writersByRepo.values()].every((writers) => writers.size === 1),
      tenant_boundary: "no cross-tenant data view or shared signing key",
    },
    readiness: {
      ready: blockerCount === 0,
      blockers: blockerCount,
      warnings: gaps.filter((entry) => entry.severity !== "blocker").length,
      gaps,
    },
    tenants: topology.tenants.map((tenant) => ({
      id: tenant.id,
      name: tenant.name,
      cloud: tenant.cloud,
      identity_provider_configured: Boolean(tenant.identity_provider),
      git_app_configured: Boolean(tenant.git_app),
      conformance_attestation: String(tenant.conformance?.scope || "") === "per-tenant" && Boolean(tenant.conformance?.signer),
      teams: tenant.teams.map((team) => ({
        id: team.id,
        name: team.name,
        coord_data_repo: team.coord_data_repo,
        writer_id: String(team.writer?.id || team.writer_id || "").trim(),
        read_cache: String(team.read_cache?.kind || "derived"),
      })),
    })),
    invariants: [
      "canonical board, journal, requirements, and plans remain in customer git",
      "control plane stores only config, derived read cache, and transient queues/sessions",
      "each coord data repo has one singleton writer",
      "conformance attestation is scoped per tenant",
      "coord-ui renders readiness only and does not execute deployment actions",
    ],
  };
}

module.exports = {
  HUMAN_ROLES,
  HUMAN_ACTIONS,
  ROLE_GRANTS,
  ROUTES,
  matchRoute,
  rolesFromClaims,
  authorizeHumanAction,
  writerKeyForBoard,
  buildHumanWriteEnvelope,
  handleHumanWriteRequest,
  buildRequirementDraftIntent,
  buildRequirementFeedbackIntent,
  buildGroomingProposal,
  buildScreenFeedbackIntent,
  buildScreenRequirementBridge,
  buildLoopOrchestrationPlan,
  buildHostedControlPlaneTopology,
  buildHumanAgentPlatformModel,
};
