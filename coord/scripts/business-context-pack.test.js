"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const discovery = require("./business-discovery.js");
const synth = require("./business-discovery-synthesize.js");
const contextPack = require("./business-context-pack.js");
const { dispatch } = require("./coord-cli.js");

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-"));
  write(path.join(dir, "coord/project.config.js"), "module.exports = { repos: { B: { path: 'backend' }, F: { path: 'frontend' } } };\n");
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  write(path.join(dir, "backend/migrations/001_create_orders.sql"), "create table orders(id text);\n");
  write(path.join(dir, "frontend/src/pages/orders.tsx"), "export default function Orders() { return null; }\n");
  const run = discovery.analyze(dir, { maxFiles: 100 });
  return { dir, synthesis: synth.synthesize(run) };
}

function publicSafePilotRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-pilot-"));
  write(path.join(dir, "coord/project.config.js"), [
    "module.exports = {",
    "  repos: {",
    "    POS: { path: 'generic-pos', integrationBranch: 'main' },",
    "    ERP: { path: 'generic-erp', integrationBranch: 'main' }",
    "  }",
    "};",
    "",
  ].join("\n"));
  write(path.join(dir, "generic-pos/src/api/menuAdapter.ts"), "export function publishMenuContract() {}\n");
  write(path.join(dir, "generic-pos/src/api/itemModifierTaxRules.ts"), "export function validateTaxContract() {}\n");
  write(path.join(dir, "generic-pos/fixtures/menu-adapter-contract.json"), "{\"items\":[],\"modifiers\":[],\"taxRules\":[]}\n");
  write(path.join(dir, "generic-erp/config/tenant-approval-workflow.yaml"), "approval: required\n");
  write(path.join(dir, "generic-erp/src/workflows/approvalSettings.ts"), "export const approvalSettings = {};\n");
  write(path.join(dir, "generic-erp/docs/configuration-surface.md"), "# Generic ERP configuration\n");

  const run = discovery.analyze(dir, { maxFiles: 100 });
  const source = run.sources.find((candidate) => /tenant-approval-workflow/.test(candidate.path)) || run.sources[0];
  run.records.push({
    id: "BD-REC-PILOT-CONFLICT",
    kind: "contradiction",
    subject: "generic-approval-policy",
    predicate: "approval_before_menu_publish",
    object: null,
    statement: "Generic POS fixture says menu tax changes can publish immediately, while generic ERP fixture requires approval before publish.",
    scope: { repos: ["POS", "ERP"], bounded_context: "public-safe-pilot", tenants: [], applies_when: "menu tax configuration changes" },
    confidence: "contradicted",
    status: "candidate",
    classification: "internal",
    evidence: [{ source_id: source.id, note: "synthetic public-safe contradiction for pilot fixture" }],
    history: { effective_from: null, effective_to: null, supersedes: [], superseded_by: null, source_hashes: [] },
    review: { owner: "business-domain-owner", review_required: true, reason: "resolve generic fixture contradiction before behavior-changing work" },
  });
  return { dir, run, synthesis: synth.synthesize(run) };
}

function policySynthesis() {
  return {
    kind: "concord.business_discovery.synthesis",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    context_graph: {
      nodes: [
        { id: "BD-EV-1", type: "evidence", label: "coord/docs/policy.md", authority: "approved_policy", visibility: "internal" },
        { id: "BD-EV-2", type: "evidence", label: "coord/docs/legacy-policy.md", authority: "accepted_decision", visibility: "internal" },
        { id: "BD-EV-3", type: "evidence", label: "coord/docs/conflict.md", authority: "human_review_comment", visibility: "internal" },
        { id: "BD-REC-ACTIVE", type: "field_rule", label: "Invoice approval threshold applies before posting.", status: "accepted", bucket: "accepted" },
        { id: "BD-REC-SUPERSEDED", type: "field_rule", label: "Legacy invoice approval threshold was tenant-global.", status: "superseded", bucket: "superseded", superseded_by: "BD-REC-ACTIVE" },
        { id: "BD-REC-CONFLICT", type: "field_rule", label: "Imported invoices can skip approval.", status: "conflicted", bucket: "contradicted", conflicts_with: ["BD-REC-ACTIVE"] },
        { id: "BD-REC-STALE", type: "field_rule", label: "Stale invoice approval source changed.", status: "stale", bucket: "stale" },
      ],
      edges: [
        { from: "BD-REC-ACTIVE", type: "proven_by", to: "BD-EV-1" },
        { from: "BD-REC-SUPERSEDED", type: "proven_by", to: "BD-EV-2" },
        { from: "BD-REC-CONFLICT", type: "proven_by", to: "BD-EV-3" },
        { from: "BD-REC-STALE", type: "proven_by", to: "BD-EV-1" },
      ],
    },
    promoted_docs: [
      { file: "coord/docs/policy.md", record_ids: ["BD-REC-ACTIVE", "BD-REC-STALE"] },
      { file: "coord/docs/legacy-policy.md", record_ids: ["BD-REC-SUPERSEDED"] },
      { file: "coord/docs/conflict.md", record_ids: ["BD-REC-CONFLICT"] },
    ],
    unknowns: [],
    promotion_candidates: [],
  };
}

function emptySynthesis() {
  return {
    kind: "concord.business_discovery.synthesis",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    context_graph: { nodes: [], edges: [] },
    promoted_docs: [],
    unknowns: [],
    promotion_candidates: [],
  };
}

function writeAdr(root, file, body) {
  write(path.join(root, "coord/docs/decisions", file), body);
}

function rankingSynthesis() {
  return {
    kind: "concord.business_discovery.synthesis",
    generated_at_utc: "2026-06-27T00:00:00.000Z",
    context_graph: {
      nodes: [
        { id: "BD-EV-POLICY", type: "evidence", label: "coord/docs/billing-policy.md", authority: "approved_policy", visibility: "internal" },
        { id: "BD-EV-CONFLICT", type: "evidence", label: "coord/docs/billing-conflict.md", authority: "human_review_comment", visibility: "internal" },
        { id: "BD-EV-OBSERVED", type: "evidence", label: "coord/docs/billing-observation.md", authority: "runtime_observation", visibility: "internal" },
        { id: "BD-REC-CONFIRMED", type: "field_rule", label: "Billing adjustments require approval.", status: "accepted", bucket: "accepted", confidence: "confirmed" },
        { id: "BD-REC-CONFLICT", type: "contradiction", label: "Billing adjustments may bypass approval in imports.", status: "conflicted", bucket: "contradicted", confidence: "contradicted", conflicts_with: ["BD-REC-CONFIRMED"] },
        {
          id: "BD-REC-INFERRED",
          type: "hypothesis",
          label: "Billing adjustments approval import bypass customer override settlement exception manual review queue exact subject source match.",
          status: "candidate",
          bucket: "inferred",
          confidence: "inferred",
        },
      ],
      edges: [
        { from: "BD-REC-CONFIRMED", type: "proven_by", to: "BD-EV-POLICY" },
        { from: "BD-REC-CONFLICT", type: "proven_by", to: "BD-EV-CONFLICT" },
        { from: "BD-REC-INFERRED", type: "proven_by", to: "BD-EV-OBSERVED" },
      ],
    },
    promoted_docs: [
      { file: "coord/docs/billing-policy.md", record_ids: ["BD-REC-CONFIRMED"] },
      { file: "coord/docs/billing-conflict.md", record_ids: ["BD-REC-CONFLICT"] },
      { file: "coord/docs/billing-observation.md", record_ids: ["BD-REC-INFERRED"] },
    ],
    unknowns: [
      { id: "BD-UNK-1", kind: "open_question", statement: "Who approves import exceptions?", reason: "missing owner" },
    ],
    promotion_candidates: [
      { id: "BD-PROMO-1", record_id: "BD-REC-CONFIRMED", target: "requirements", status: "accepted" },
    ],
  };
}

test("business context pack selects relevant cited records without loading full graph", () => {
  const { synthesis } = fixtureRepo();
  const pack = contextPack.buildPack(synthesis, {
    ticket: "ORDER-001",
    scope: "orders API export",
    touchedFiles: ["backend/src/api/orders.ts"],
    requirements: ["Preserve order route contract."],
  });
  assert.equal(pack.kind, "concord.business_context_pack");
  assert.equal(pack.ticket, "ORDER-001");
  assert.equal(pack.read_only_contract.ui_tier, "read_only");
  assert.equal(pack.read_only_contract.discovery_execution_allowed, false);
  assert.equal(pack.read_only_contract.file_mutation_allowed, false);
  assert.ok(pack.refs.json.endsWith("ORDER-001.json"));
  assert.ok(pack.sections.contracts.items.some((item) => /orders\.ts/.test(item.statement)));
  assert.ok(pack.sections.contracts.items.every((item) => Array.isArray(item.evidence) && item.evidence.length > 0));
  assert.ok(Array.isArray(pack.query.tokens));
  assert.equal(pack.ticket_context.ticket, "ORDER-001");
  assert.equal(pack.ticket_context.read_only_contract.file_mutation_allowed, false);
  assert.ok(Array.isArray(pack.ticket_context.adapter_signals));
  assert.ok(pack.ticket_context.fact_confidence.by_confidence.observed >= 1);
  assert.ok(Array.isArray(pack.ticket_context.section_record_refs.contracts));
});

test("business context pack excludes superseded/conflicted/stale claims from active sections and surfaces them separately", () => {
  const pack = contextPack.buildPack(policySynthesis(), {
    ticket: "INV-001",
    scope: "invoice approval posting",
    requirements: ["Preserve invoice approval threshold."],
  });
  assert.ok(pack.sections.fields.items.some((item) => item.id === "BD-REC-ACTIVE"));
  assert.ok(pack.sections.fields.items.every((item) => !["BD-REC-SUPERSEDED", "BD-REC-CONFLICT", "BD-REC-STALE"].includes(item.id)));
  assert.deepEqual(pack.sections.history.items.map((item) => item.id), ["BD-REC-SUPERSEDED"]);
  assert.deepEqual(pack.sections.conflicts.items.map((item) => item.id), ["BD-REC-CONFLICT"]);
  assert.deepEqual(pack.sections.stale_sources.items.map((item) => item.id), ["BD-REC-STALE"]);
  assert.match(pack.sections.history.items[0].why_included, /history-only/);
  assert.equal(pack.gate.behavior_change_gate.status, "investigation_required");
  assert.equal(pack.gate.behavior_change_gate.has_business_context_refs, true);
  assert.equal(pack.gate.behavior_change_gate.has_investigation_status, true);
  assert.deepEqual(pack.ticket_context.contradictions.map((item) => item.id), ["BD-REC-CONFLICT"]);
  assert.deepEqual(pack.ticket_context.open_questions, []);
  assert.equal(pack.ticket_context.proposed_ticket_recommendations.length, 2);
  assert.deepEqual(pack.proposed_ticket_recommendations.map((item) => item.source_record_id), [
    "BD-REC-CONFLICT",
    "BD-REC-STALE",
  ]);
  assert.ok(pack.proposed_ticket_recommendations.every((item) => item.proposed_status === "proposed"));
});

test("COORD-366: recommendations scope to the change surface (touched files), not the repo-wide corpus", () => {
  // A maintenance change touching files unrelated to the uncertain findings must
  // NOT drag those findings in as proposed-ticket blockers (the COORD-363 friction).
  const scoped = contextPack.buildPack(policySynthesis(), {
    ticket: "COORD-999",
    touchedFiles: ["coord/engine-pin.json", "coord/TEMPLATE_SYNC_MANIFEST.json"],
  });
  assert.equal(
    scoped.proposed_ticket_recommendations.length,
    0,
    "uncertain invoice findings are irrelevant to an engine-pin/manifest change and must not block it"
  );

  // A change WHOSE surface matches still surfaces the relevant uncertain finding.
  const relevant = contextPack.buildPack(policySynthesis(), {
    ticket: "INV-002",
    scope: "invoice approval",
  });
  assert.ok(
    relevant.proposed_ticket_recommendations.some((item) => item.source_record_id === "BD-REC-CONFLICT"),
    "a genuinely-relevant uncertain finding still blocks behavior-changing work"
  );

  // An UNDECLARED ticket (no touched files, no scope, no requirements) falls back
  // to the prior behavior so it cannot silently dodge the gate.
  const undeclared = contextPack.buildPack(policySynthesis(), { ticket: "COORD-998" });
  assert.ok(
    undeclared.proposed_ticket_recommendations.length > 0,
    "an undeclared ticket must not dodge the gate — fall back to surfacing uncertain findings"
  );
});

test("COORD-370 HIGH-1: scaffold worktree placeholders are NOT a change surface (no gate bypass)", () => {
  // A freshly-seeded plan's only intended_file is the scaffold placeholder.
  assert.equal(
    contextPack.isScaffoldWorktreePlaceholder("coord/.worktrees/claudea196/COORD-366/*"),
    true
  );
  assert.equal(
    contextPack.isScaffoldWorktreePlaceholder("backend/.worktrees/unassigned/API-001/*"),
    true
  );
  // Real source files are NOT placeholders.
  assert.equal(contextPack.isScaffoldWorktreePlaceholder("backend/src/invoices/post.ts"), false);
  assert.equal(contextPack.isScaffoldWorktreePlaceholder("coord/scripts/business-context-pack.js"), false);

  // End-to-end: a plan whose intended_files are ONLY placeholders must resolve to
  // an empty change surface -> the gate falls back to surfacing findings (NOT a bypass).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord370-"));
  fs.mkdirSync(path.join(dir, "coord", ".runtime", "plans"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coord", ".runtime", "plans", "COORD-999.json"),
    JSON.stringify({ ticket_id: "COORD-999", intended_files: ["coord/.worktrees/claudea196/COORD-999/*"] })
  );
  assert.deepEqual(contextPack.readTicketIntendedFiles(dir, "COORD-999"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("COORD-370 HIGH-2: open questions scope to the change surface (no inherited repo-wide ceremony)", () => {
  const synth = () => ({
    kind: "concord.business_discovery.synthesis",
    generated_at_utc: "2026-06-28T00:00:00.000Z",
    context_graph: { nodes: [], edges: [] },
    unknowns: [
      { id: "BD-Q-1", kind: "open_question", statement: "How should invoice approval thresholds work?", reason: "x" },
      { id: "BD-Q-2", kind: "open_question", statement: "What is the menu tax rounding policy?", reason: "y" },
    ],
    promoted_docs: [],
    promotion_candidates: [],
  });
  // Scoped to an unrelated file -> NO open questions inherited.
  const unrelated = contextPack.buildPack(synth(), { ticket: "COORD-997", touchedFiles: ["coord/engine-pin.json"] });
  assert.equal(unrelated.sections.open_questions.items.length, 0);
  // Scoped to a matching topic -> the relevant open question surfaces.
  const relevant = contextPack.buildPack(synth(), { ticket: "INV-003", scope: "invoice approval" });
  assert.deepEqual(relevant.sections.open_questions.items.map((i) => i.id), ["BD-Q-1"]);
  // Undeclared (no scope) -> full set (fallback, cannot dodge).
  const undeclared = contextPack.buildPack(synth(), { ticket: "COORD-996" });
  assert.equal(undeclared.sections.open_questions.items.length, 2);
});

test("COORD-368: a missing discovery synthesis emits a graduated next-step (not a dead-end)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord368-cold-")); // empty repo, no synthesis
  const lines = [];
  const res = contextPack.run(["--ticket", "COORD-999", "--write-default"], { cwd: dir, log: (l) => lines.push(l) });
  assert.equal(res.code, 1);
  assert.equal(res.reason, "missing_synthesis");
  const out = lines.join("\n");
  assert.match(out, /business-discovery/, "guides the user to run discovery first");
  assert.match(out, /business-context investigation: not-required/, "offers the disposition escape");
  // A genuinely corrupt synthesis keeps the original error (not the cold-repo path).
  fs.mkdirSync(path.join(dir, "coord", ".runtime", "discovery"), { recursive: true });
  fs.writeFileSync(path.join(dir, "coord", ".runtime", "discovery", "synthesis.json"), "{ not json", "utf8");
  const lines2 = [];
  const res2 = contextPack.run(["--ticket", "COORD-999"], { cwd: dir, log: (l) => lines2.push(l) });
  assert.equal(res2.code, 1);
  assert.notEqual(res2.reason, "missing_synthesis");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("COORD-338: context pack exposes a warm-start handoff without becoming authority", () => {
  const pack = contextPack.buildPack(policySynthesis(), {
    ticket: "INV-001",
    scope: "invoice approval posting",
    requirements: ["Preserve invoice approval threshold."],
  });
  const handoff = contextPack.buildWarmStartContextFromPack(pack);
  assert.equal(handoff.kind, "concord.continuity_warm_start_context_pack_ref");
  assert.equal(handoff.ticket, "INV-001");
  assert.equal(handoff.source_kind, "concord.business_context_pack");
  assert.equal(handoff.active_context.fields.some((item) => item.id === "BD-REC-ACTIVE"), true);
  assert.equal(handoff.uncertain_context.some((item) => item.id === "BD-REC-CONFLICT"), true);
  assert.equal(handoff.uncertain_context.some((item) => item.id === "BD-REC-STALE"), true);
  assert.ok(handoff.verification_needed.length >= 2);
  assert.equal(handoff.gate.status, "investigation_required");
});

test("business context pack includes relevant ADR guidance with citations and keeps superseded ADRs historical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-context-pack-adr-"));
  writeAdr(dir, "0001-orders-api-contract.md", [
    "# ADR 0001: Orders API Contract",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** ORDER-ADR",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "",
    "Orders API context.",
    "",
    "## Linked Scope",
    "",
    "- Affected file: backend/src/api/orders.ts.",
    "- Requirement: REQ-ADR-1.",
    "",
    "## Decision Criteria",
    "",
    "- Preserve stable order route semantics.",
    "",
    "## Options Evaluated",
    "",
    "- Keep explicit route contract.",
    "- Infer route contract from handlers.",
    "",
    "## Decision",
    "",
    "Orders API work must preserve the explicit route contract.",
    "",
    "## Alternatives Rejected",
    "",
    "Inferring route contracts from handlers was rejected because it hides breaking changes.",
    "",
    "## Consequences",
    "",
    "Context packs must surface this settled route-contract decision before planning.",
    "",
    "## Revisit Trigger",
    "",
    "Revisit if orders routes move out of backend/src/api/orders.ts.",
    "",
  ].join("\n"));
  writeAdr(dir, "0002-legacy-orders-routing.md", [
    "# ADR 0002: Legacy Orders Routing",
    "",
    "- **Status:** Superseded (by 0001)",
    "- **Ticket:** ORDER-ADR",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "",
    "Legacy orders routing context.",
    "",
    "## Linked Scope",
    "",
    "- Affected file: backend/src/api/orders.ts.",
    "",
    "## Decision Criteria",
    "",
    "- Legacy routing.",
    "",
    "## Options Evaluated",
    "",
    "- Legacy routing.",
    "",
    "## Decision",
    "",
    "Legacy orders routing was used before ADR 0001.",
    "",
    "## Alternatives Rejected",
    "",
    "- None.",
    "",
    "## Consequences",
    "",
    "- Historical only.",
    "",
  ].join("\n"));
  writeAdr(dir, "0003-unrelated-mobile-sync.md", [
    "# ADR 0003: Unrelated Mobile Sync",
    "",
    "- **Status:** Accepted",
    "- **Ticket:** MOB-ADR",
    "- **Date:** 2026-06",
    "",
    "## Context",
    "",
    "Mobile sync context.",
    "",
    "## Linked Scope",
    "",
    "- Affected file: mobile/src/sync.ts.",
    "",
    "## Decision Criteria",
    "",
    "- Sync safely.",
    "",
    "## Options Evaluated",
    "",
    "- Offline sync.",
    "",
    "## Decision",
    "",
    "Use mobile sync.",
    "",
    "## Alternatives Rejected",
    "",
    "- Server polling.",
    "",
    "## Consequences",
    "",
    "- Mobile only.",
    "",
  ].join("\n"));

  const pack = contextPack.buildPack(emptySynthesis(), {
    ticket: "ORDER-ADR",
    scope: "orders API route contract",
    touchedFiles: ["backend/src/api/orders.ts"],
    requirements: ["REQ-ADR-1"],
    rootDir: dir,
    limit: 10,
  });

  assert.deepEqual(pack.sections.adrs.items.map((item) => item.id), ["ADR-0001"]);
  assert.deepEqual(pack.sections.adr_history.items.map((item) => item.id), ["ADR-0002"]);
  assert.ok(!JSON.stringify(pack.sections).includes("ADR-0003"));
  const active = pack.sections.adrs.items[0];
  assert.match(active.rejected_alternatives, /Inferring route contracts/);
  assert.match(active.consequences, /settled route-contract decision/);
  assert.match(active.revisit_trigger, /orders routes move/);
  assert.equal(active.can_govern_implementation, true);
  assert.equal(active.evidence[0].path, "coord/docs/decisions/0001-orders-api-contract.md");
  assert.equal(typeof active.evidence[0].event_hash, "string");
  assert.equal(pack.ticket_context.adrs[0].id, "ADR-0001");
  assert.equal(pack.ticket_context.adr_history[0].id, "ADR-0002");
  assert.equal(pack.gate.behavior_change_gate.active_context_count, 1);
});

test("business context pack ranks confirmed rules and conflicts above inferred advisory context with metadata", () => {
  const pack = contextPack.buildPack(rankingSynthesis(), {
    ticket: "BILL-001",
    scope: "billing adjustments approval import bypass customer override settlement exception",
    requirements: ["Preserve billing approval rules."],
    limit: 10,
  });

  const rankedIds = pack.ranking.items.map((item) => item.id);
  assert.ok(rankedIds.indexOf("BD-REC-CONFIRMED") < rankedIds.indexOf("BD-REC-INFERRED"));
  assert.ok(rankedIds.indexOf("BD-REC-CONFLICT") < rankedIds.indexOf("BD-REC-INFERRED"));

  const confirmed = pack.sections.fields.items.find((item) => item.id === "BD-REC-CONFIRMED");
  const conflict = pack.sections.conflicts.items.find((item) => item.id === "BD-REC-CONFLICT");
  const inferred = pack.sections.workarounds.items.find((item) => item.id === "BD-REC-INFERRED");
  assert.equal(confirmed.rank_category, "exact_subject_or_source_match");
  assert.equal(confirmed.computed_confidence, "high");
  assert.equal(confirmed.source_authority, "approved_policy");
  assert.equal(confirmed.can_govern_implementation, true);
  assert.equal(conflict.rank_category, "active_contradiction");
  assert.equal(conflict.conflict_state, "active_conflict");
  assert.equal(conflict.can_govern_implementation, false);
  assert.equal(inferred.rank_category, "inferred_context");
  assert.equal(inferred.computed_confidence, "low");
  assert.equal(inferred.source_authority, "runtime_observation");
  assert.equal(inferred.can_govern_implementation, false);

  const includedItems = Object.values(pack.sections).flatMap((section) => section.items);
  for (const item of includedItems) {
    assert.equal(typeof item.why_included, "string", `${item.id} has why_included`);
    assert.equal(typeof item.status, "string", `${item.id} has status`);
    assert.equal(typeof item.computed_confidence, "string", `${item.id} has computed_confidence`);
    assert.equal(typeof item.conflict_state, "string", `${item.id} has conflict_state`);
    assert.equal(typeof item.staleness, "string", `${item.id} has staleness`);
    assert.equal(typeof item.source_authority, "string", `${item.id} has source_authority`);
    assert.equal(typeof item.can_govern_implementation, "boolean", `${item.id} has can_govern_implementation`);
  }
});

test("business context pack writes explicit json and markdown artifacts", () => {
  const { dir, synthesis } = fixtureRepo();
  write(path.join(dir, "coord/.runtime/discovery/synthesis.json"), `${JSON.stringify(synthesis, null, 2)}\n`);
  const result = contextPack.run([
    "--ticket",
    "ORDER-002",
    "--input",
    "coord/.runtime/discovery/synthesis.json",
    "--scope",
    "orders migration",
    "--touched-file",
    "backend/migrations/001_create_orders.sql",
    "--json",
    "--output",
    "coord/.runtime/context-packs/ORDER-002.json",
    "--output-md",
    "coord/.runtime/context-packs/ORDER-002.md",
  ], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/context-packs/ORDER-002.json"), "utf8"));
  assert.equal(parsed.kind, "concord.business_context_pack");
  const markdown = fs.readFileSync(path.join(dir, "coord/.runtime/context-packs/ORDER-002.md"), "utf8");
  assert.match(markdown, /Business Context Pack: ORDER-002/);
  assert.match(markdown, /behavior change gate/);
});

test("product CLI routes business-context-pack", () => {
  const { dir, synthesis } = fixtureRepo();
  write(path.join(dir, "coord/.runtime/discovery/synthesis.json"), `${JSON.stringify(synthesis, null, 2)}\n`);
  const lines = [];
  const result = dispatch(["business-context-pack", "--ticket", "ORDER-003", "--input", "coord/.runtime/discovery/synthesis.json", "--scope", "orders", "--json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.kind, "concord.business_context_pack");
});

test("business context pack gates public-safe POS and ERP pilot scenario with proposed tickets", () => {
  const { synthesis } = publicSafePilotRun();
  const pack = contextPack.buildPack(synthesis, {
    ticket: "PILOT-001",
    scope: "menu tax publish approval configuration",
    touchedFiles: [
      "generic-pos/src/api/menuAdapter.ts",
      "generic-erp/config/tenant-approval-workflow.yaml",
    ],
    requirements: [
      "Resolve whether menu tax changes can publish immediately or require ERP approval.",
    ],
    limit: 10,
  });

  assert.equal(pack.kind, "concord.business_context_pack");
  assert.equal(pack.read_only_contract.file_mutation_allowed, false);
  assert.ok(pack.ticket_context.adapter_signals.some((signal) => signal.id === "pos-menu"));
  assert.ok(pack.ticket_context.adapter_signals.some((signal) => signal.id === "erp-configuration"));
  assert.ok(pack.sections.contracts.items.some((item) => /menuAdapter/.test(item.statement)));
  assert.ok(pack.sections.facts.items.some((item) => /configuration-surface/.test(item.statement)));
  assert.ok(pack.sections.conflicts.items.some((item) => item.id === "BD-REC-PILOT-CONFLICT"));
  assert.ok(pack.proposed_ticket_recommendations.some((item) => (
    item.source_record_id === "BD-REC-PILOT-CONFLICT" &&
    item.suggested_type === "spike" &&
    item.proposed_status === "proposed"
  )));
  assert.equal(pack.gate.behavior_change_gate.status, "investigation_required");
  assert.equal(pack.gate.behavior_change_gate.has_business_context_refs, true);
  assert.equal(pack.gate.behavior_change_gate.has_investigation_status, true);
  assert.ok(pack.ticket_context.preservation_candidates.some((candidate) => candidate.source_record_id === "BD-REC-PILOT-CONFLICT"));
  assert.equal(JSON.stringify(pack).includes("customer"), false);
});

test("business context pack labels sparse cold-start synthesis without claiming confirmed memory", () => {
  const { synthesis } = fixtureRepo();
  const pack = contextPack.buildPack(synthesis, {
    ticket: "COLD-001",
    scope: "orders API workflow baseline",
    touchedFiles: ["backend/src/api/orders.ts", "frontend/src/pages/orders.tsx"],
    requirements: ["Preserve observed order workflow while confirming authority."],
    limit: 10,
  });

  assert.equal(pack.cold_start_baseline.status, "sparse_memory_baseline");
  assert.equal(pack.cold_start_baseline.sparse_memory, true);
  assert.equal(pack.cold_start_baseline.confirmed_authority.accepted_confirmed_records, 0);
  assert.equal(pack.cold_start_baseline.confirmed_authority.may_claim_confirmed_memory, false);
  assert.ok(pack.cold_start_baseline.coverage_gaps.includes("confirmed_memory"));
  assert.match(pack.sparse_memory_warning, /No accepted confirmed business-memory claims/);
  assert.deepEqual(pack.ticket_context.cold_start_baseline, pack.cold_start_baseline);
  assert.ok(pack.ticket_context.coverage_gaps.includes("confirmed_memory"));
  assert.ok(pack.sections.contracts.items.some((item) => item.confidence === "observed" && item.can_govern_implementation === false));
  assert.ok(pack.sections.open_questions.items.length >= 1);

  const markdown = contextPack.renderMarkdown(pack);
  assert.match(markdown, /sparse memory warning/);
  assert.match(markdown, /Coverage gaps: confirmed_memory/);
});
