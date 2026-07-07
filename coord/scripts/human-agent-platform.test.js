"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  governedActorFromSso,
  normalizeSsoClaims,
} = require("./identity-v2.js");
const {
  authorizeHumanAction,
  buildGroomingProposal,
  buildHostedControlPlaneTopology,
  buildHumanAgentPlatformModel,
  buildLoopOrchestrationPlan,
  buildRequirementDraftIntent,
  buildRequirementFeedbackIntent,
  buildScreenFeedbackIntent,
  buildScreenRequirementBridge,
  buildHumanWriteEnvelope,
  handleHumanWriteRequest,
} = require("./human-agent-platform.js");

const trustedClaims = {
  iss: "https://login.microsoftonline.com/tenant/v2.0",
  tid: "tenant",
  oid: "user-123",
  preferred_username: "BA@example.com",
  name: "Business Analyst",
  roles: ["business-analyst"],
};

const writerRegistry = {
  fleet: { writer_id: "writer-1", coord_data_repo: "Org/coord-fleet" },
};

test("normalizes SSO claims into a stable governed human actor", () => {
  const identity = normalizeSsoClaims(trustedClaims);
  assert.equal(identity.present, true);
  assert.equal(identity.email, "ba@example.com");
  assert.equal(identity.stable_id, "sso:tenant:user-123");

  const actor = governedActorFromSso(trustedClaims);
  assert.equal(actor.present, true);
  assert.equal(actor.actor.kind, "human");
  assert.equal(actor.actor.attribution.actor_type, "human-sso");
  assert.equal(actor.actor.owner, "ba@example.com");
});

test("denies roles by default and grants only declared actions", () => {
  assert.equal(authorizeHumanAction(["viewer"], "requirements.draft").allowed, false);
  assert.equal(authorizeHumanAction(["business-analyst"], "requirements.draft").allowed, true);
  assert.equal(authorizeHumanAction(["approver"], "requirements.approve").allowed, true);
  assert.equal(authorizeHumanAction(["business-analyst"], "requirements.approve").allowed, false);
});

test("builds a governed human-write envelope through the sole writer seam", () => {
  const result = buildHumanWriteEnvelope(
    {
      method: "POST",
      path: "/v1/boards/fleet/requirements/drafts",
      body: {
        actor: { owner: "spoofed@example.com" },
        payload: { title: "Driver handoff rules", body: "Capture exception handling." },
      },
    },
    { trustedClaims, writerRegistry }
  );

  assert.equal(result.allowed, true);
  assert.equal(result.status, 202);
  assert.equal(result.envelope.actor.owner, "ba@example.com");
  assert.equal(result.envelope.payload.title, "Driver handoff rules");
  assert.equal(result.envelope.writer.queue_key, "coord-writer:Org/coord-fleet");
  assert.equal(result.envelope.verb, "requirements.propose");
});

test("rejects mutating requests without a trusted identity or registered writer", () => {
  const noIdentity = buildHumanWriteEnvelope(
    { method: "POST", path: "/v1/boards/fleet/feedback", body: { text: "Needs review" } },
    { writerRegistry }
  );
  assert.equal(noIdentity.allowed, false);
  assert.equal(noIdentity.code, "missing_trusted_identity");

  const noWriter = buildHumanWriteEnvelope(
    { method: "POST", path: "/v1/boards/unknown/feedback", body: { text: "Needs review" } },
    { trustedClaims, writerRegistry }
  );
  assert.equal(noWriter.allowed, false);
  assert.equal(noWriter.code, "writer_unavailable");
});

test("dispatch is explicit and transport remains dry-run without an executor", async () => {
  const dryRun = await handleHumanWriteRequest(
    { method: "POST", path: "/v1/boards/fleet/tickets/proposals", body: { payload: { title: "Fix gap" } } },
    { trustedClaims, writerRegistry }
  );
  assert.equal(dryRun.allowed, true);
  assert.deepEqual(dryRun.receipt, { dispatched: false, reason: "dry-run" });

  const dispatched = await handleHumanWriteRequest(
    { method: "POST", path: "/v1/boards/fleet/tickets/proposals", body: { payload: { title: "Fix gap" } } },
    {
      trustedClaims,
      writerRegistry,
      dispatch: async (envelope) => ({ dispatched: true, verb: envelope.verb, writer: envelope.writer.writer_id }),
    }
  );
  assert.equal(dispatched.receipt.dispatched, true);
  assert.equal(dispatched.receipt.verb, "ticket.propose");
  assert.equal(dispatched.receipt.writer, "writer-1");
});

test("builds requirement draft and feedback intents as proposal-only governed writes", () => {
  const draft = buildRequirementDraftIntent(
    { board_id: "fleet", title: "Exception routing", body: "Capture manager approval exceptions." },
    { trustedClaims, writerRegistry }
  );
  assert.equal(draft.allowed, true);
  assert.equal(draft.envelope.verb, "requirements.propose");
  assert.equal(draft.envelope.payload.status, "draft");

  const feedback = buildRequirementFeedbackIntent(
    { board_id: "fleet", requirement_id: "REQ-1", feedback: "The approval screen misses the override reason." },
    { trustedClaims, writerRegistry }
  );
  assert.equal(feedback.allowed, true);
  assert.equal(feedback.envelope.verb, "feedback.propose");
  assert.equal(feedback.envelope.payload.status, "proposed");
});

test("grooming proposal links context and blocks underspecified human input", () => {
  const blocked = buildGroomingProposal({ title: "Route exception" }, { adr_refs: ["ADR-0003"] });
  assert.equal(blocked.status, "needs_clarification");
  assert.ok(blocked.open_questions.includes("requirement body/feedback text is missing"));
  assert.equal(blocked.proposed_tickets.length, 0);

  const proposed = buildGroomingProposal(
    {
      title: "Route exception",
      body: "Managers need approval override reasons.",
      acceptance_criteria: ["Override reason is required."],
      personas: ["manager"],
    },
    { existing_requirements: ["REQ-1"], adr_refs: ["ADR-0003"] }
  );
  assert.equal(proposed.status, "proposed");
  assert.deepEqual(proposed.links.adrs, ["ADR-0003"]);
  assert.equal(proposed.proposed_tickets.length, 1);
});

test("human-agent platform model exposes T2 without making coord-ui a writer", () => {
  const model = buildHumanAgentPlatformModel({ board_id: "fleet", trustedClaims, writerRegistry });
  assert.equal(model.read_only_policy.coord_ui_may_write, false);
  assert.equal(model.tranches.find((entry) => entry.id === "T2").status, "implemented-model");
  assert.equal(model.authoring.draft_intent.verb, "requirements.propose");
  assert.equal(model.authoring.feedback_intent.verb, "feedback.propose");
});

test("screen bridge maps requirements and surfaces unmapped screens as gaps", () => {
  const bridge = buildScreenRequirementBridge(
    {
      apps: [{
        app: "web",
        screens: [
          {
            id: "driver-workbench",
            route: "/driver",
            title: "Driver workbench",
            source: "frontend/app/driver/page.tsx",
            persona_hints: ["driver"],
            requirement_refs: [{ doc: "REQ.md", anchor: "driver-workflow", text: "Driver workflow", confidence: "explicit" }],
          },
          {
            id: "settings",
            route: "/settings",
            title: "Settings",
            source: "frontend/app/settings/page.tsx",
            requirement_refs: [],
          },
        ],
      }],
    },
    { board_id: "fleet", trustedClaims, writerRegistry }
  );
  assert.equal(bridge.status, "gaps");
  assert.deepEqual(bridge.summary, { screens: 2, mapped: 1, unmapped: 1 });
  assert.equal(bridge.screens[0].feedback_intent.verb, "feedback.propose");
  assert.equal(bridge.gaps[0].screen_id, "settings");
});

test("screen feedback intent targets a screen and requirement through the governed feedback path", () => {
  const intent = buildScreenFeedbackIntent(
    {
      board_id: "fleet",
      screen_id: "driver-workbench",
      route: "/driver",
      requirement_id: "driver-workflow",
      feedback: "The handoff step needs a required reason.",
    },
    { trustedClaims, writerRegistry }
  );
  assert.equal(intent.allowed, true);
  assert.equal(intent.envelope.verb, "feedback.propose");
  assert.equal(intent.envelope.payload.target.kind, "screen");
  assert.equal(intent.envelope.payload.requirement_id, "driver-workflow");
});

test("loop orchestration blocks on open questions and missing approval", () => {
  const plan = buildLoopOrchestrationPlan(
    { board_id: "fleet", title: "Route exception" },
    { trustedClaims: { ...trustedClaims, roles: ["approver"] }, writerRegistry }
  );
  assert.equal(plan.status, "blocked");
  assert.ok(plan.blockers.some((blocker) => blocker.code === "open_questions"));
  assert.ok(plan.blockers.some((blocker) => blocker.code === "approval_required"));
  assert.equal(plan.stages.find((entry) => entry.id === "dispatch").governance.bypasses_lifecycle, false);
});

test("loop orchestration is ready when grooming is complete and approval exists", () => {
  const plan = buildLoopOrchestrationPlan(
    {
      board_id: "fleet",
      title: "Route exception",
      body: "Managers need approval override reasons.",
      personas: ["manager"],
      acceptance_criteria: ["Override reason is required."],
      approval: "approved",
    },
    { trustedClaims: { ...trustedClaims, roles: ["admin"] }, writerRegistry }
  );
  assert.equal(plan.status, "ready_to_dispatch");
  assert.equal(plan.blockers.length, 0);
  assert.deepEqual(plan.evidence_return.required, [
    "updated screens",
    "requirements traceability",
    "gate evidence",
    "feature proof",
  ]);
  assert.equal(plan.stages.find((entry) => entry.id === "run").governance.verbs.includes("start"), true);
});

test("hosted control plane topology is ready when data-light tenant controls are configured", () => {
  const topology = buildHostedControlPlaneTopology();
  assert.equal(topology.status, "ready");
  assert.equal(topology.data_light_contract.valid, true);
  assert.equal(topology.isolation.sole_writer_per_repo, true);
  assert.equal(topology.tenants[0].identity_provider_configured, true);
  assert.equal(topology.tenants[0].git_app_configured, true);
  assert.equal(topology.tenants[0].conformance_attestation, true);
});

test("hosted control plane reports missing IdP, Git app, and writer isolation gaps", () => {
  const topology = buildHostedControlPlaneTopology({
    control_plane: { stores: ["tenant_config", "derived_read_cache"] },
    tenants: [{
      id: "tenant-a",
      conformance: { scope: "per-tenant", signer: "kms-a" },
      teams: [
        { id: "team-a", coord_data_repo: "Org/coord-a", writer: { id: "writer-a", singleton: true } },
        { id: "team-b", coord_data_repo: "Org/coord-a", writer: { id: "writer-b", singleton: true } },
      ],
    }],
  });
  assert.equal(topology.status, "not_ready");
  assert.ok(topology.readiness.gaps.some((entry) => entry.code === "identity_provider_missing"));
  assert.ok(topology.readiness.gaps.some((entry) => entry.code === "git_app_missing"));
  assert.ok(topology.readiness.gaps.some((entry) => entry.code === "writer_isolation_violation"));
});

test("hosted control plane blocks canonical data in the control plane", () => {
  const topology = buildHostedControlPlaneTopology({
    control_plane: { stores: ["tenant_config", "board"], canonical_artifacts_at_rest: ["journal"] },
    tenants: [{
      id: "tenant-a",
      identity_provider: { kind: "oidc", issuer: "https://idp.example" },
      git_app: { provider: "github-app", installation_id: "install-a" },
      conformance: { scope: "per-tenant", signer: "kms-a" },
      teams: [{
        id: "team-a",
        coord_data_repo: "Org/coord-a",
        writer: { id: "writer-a", singleton: true },
        read_cache: { kind: "canonical", canonical: true },
      }],
    }],
  });
  assert.equal(topology.status, "not_ready");
  assert.equal(topology.data_light_contract.valid, false);
  assert.ok(topology.readiness.gaps.some((entry) => entry.code === "data_light_violation"));
  assert.ok(topology.readiness.gaps.some((entry) => entry.code === "read_cache_canonical"));
});

test("human-agent platform model exposes T5 hosted control plane readiness", () => {
  const model = buildHumanAgentPlatformModel({ board_id: "fleet", trustedClaims, writerRegistry });
  assert.equal(model.tranches.find((entry) => entry.id === "T5").status, "implemented-model");
  assert.equal(model.deployment.kind, "concord.human_agent.hosted_control_plane_topology");
  assert.equal(model.deployment.readiness.ready, true);
});
