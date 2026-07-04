"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const discovery = require("./business-discovery.js");
const synth = require("./business-discovery-synthesize.js");
const { dispatch } = require("./coord-cli.js");

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-synth-"));
  write(path.join(dir, "coord/project.config.js"), [
    "module.exports = {",
    "  repos: {",
    "    B: { path: 'backend', integrationBranch: 'main' },",
    "    F: { path: 'frontend', integrationBranch: 'main' }",
    "  }",
    "};",
    "",
  ].join("\n"));
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  write(path.join(dir, "backend/migrations/001_create_orders.sql"), "create table orders(id text);\n");
  write(path.join(dir, "frontend/src/pages/orders.tsx"), "export default function Orders() { return null; }\n");
  return dir;
}

function publicSafePilotRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-synth-pilot-"));
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
  return dir;
}

function addGenericContradiction(run) {
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
}

test("synthesize builds context graph, evidence classes, doc drafts, and unknowns", () => {
  const dir = fixtureRepo();
  const run = discovery.analyze(dir, { maxFiles: 100 });
  run.records.push({
    id: "BD-REC-HYP",
    kind: "hypothesis",
    subject: "Order",
    predicate: "approval_policy",
    object: null,
    statement: "Orders may require approval before export.",
    scope: { repos: ["B"], bounded_context: null, tenants: [], applies_when: null },
    confidence: "hypothesis",
    status: "candidate",
    classification: "internal",
    evidence: [{ source_id: run.sources[0].id, note: "synthetic hypothesis for test" }],
    history: { effective_from: null, effective_to: null, supersedes: [], superseded_by: null, source_hashes: [] },
    review: { owner: null, review_required: true, reason: "test" },
  });

  const synthesis = synth.synthesize(run);
  assert.equal(synthesis.kind, "concord.business_discovery.synthesis");
  assert.ok(synthesis.context_graph.nodes.some((node) => node.id === "BD-REC-HYP" && node.bucket === "unknown"));
  assert.ok(synthesis.context_graph.edges.some((edge) => edge.type === "proven_by"));
  assert.ok(synthesis.evidence_classification.by_authority.implementation >= 1);
  assert.ok(synthesis.promoted_docs.some((doc) => doc.file === "BUSINESS_CONTEXT.md"));
  assert.ok(synthesis.promoted_docs.some((doc) => doc.file === "OPEN_BUSINESS_QUESTIONS.md"));
  assert.ok(synthesis.promoted_docs.some((doc) => doc.file === "PRESERVATION_HARNESS_CANDIDATES.md"));
  assert.ok(synthesis.unknowns.some((unknown) => unknown.id === "BD-REC-HYP"));
  assert.ok(synthesis.preservation_harness_candidates.some((candidate) => candidate.source_record_id === "BD-REC-HYP"));
  assert.equal(synthesis.read_only_contract.ui_tier, "read_only");
  assert.equal(synthesis.read_only_contract.discovery_execution_allowed, false);
  assert.equal(synthesis.read_only_contract.file_mutation_allowed, false);
  assert.equal(synthesis.cockpit_readout.kind, "concord.business_discovery.cockpit_readout");
  assert.equal(synthesis.cockpit_readout.read_only_contract.file_mutation_allowed, false);
  assert.equal(synthesis.cockpit_readout.discovery_runs.length, 1);
  assert.ok(synthesis.cockpit_readout.adapter_signals.length >= 1);
  assert.ok(synthesis.cockpit_readout.fact_confidence.by_confidence.hypothesis >= 1);
  assert.ok(synthesis.cockpit_readout.open_questions.some((question) => question.id === "BD-REC-HYP"));
  assert.ok(synthesis.cockpit_readout.preservation_candidates.some((candidate) => candidate.source_record_id === "BD-REC-HYP"));
  assert.match(synthesis.cockpit_readout.ticket_context_packs.command, /business-context-pack/);
  assert.equal(
    synthesis.preservation_harness_candidates.find((candidate) => candidate.source_record_id === "BD-REC-HYP").approval_required,
    true
  );
});

test("synthesize proposes preservation harness candidates without creating implementation tests", () => {
  const dir = fixtureRepo();
  const run = discovery.analyze(dir, { maxFiles: 100 });
  run.records.push({
    id: "BD-REC-RULE",
    kind: "business_rule",
    subject: "Order",
    predicate: "requires_review",
    object: null,
    statement: "Orders over a threshold appear to require review before export.",
    scope: { repos: ["B"], bounded_context: null, tenants: [], applies_when: null },
    confidence: "observed",
    status: "candidate",
    classification: "internal",
    evidence: [{ source_id: run.sources[0].id, note: "synthetic business rule for test" }],
    history: { effective_from: null, effective_to: null, supersedes: [], superseded_by: null, source_hashes: [] },
    review: { owner: null, review_required: true, reason: "test" },
  });

  const synthesis = synth.synthesize(run);
  const ruleCandidate = synthesis.preservation_harness_candidates.find((candidate) => candidate.source_record_id === "BD-REC-RULE");
  assert.equal(ruleCandidate.harness_type, "validator");
  assert.equal(ruleCandidate.status, "candidate");
  assert.equal(ruleCandidate.approval_required, true);
  assert.match(ruleCandidate.rationale, /explicit validation/);

  const doc = synthesis.promoted_docs.find((item) => item.file === "PRESERVATION_HARNESS_CANDIDATES.md");
  assert.ok(doc.content.includes("Do not create implementation tests"));
  assert.ok(doc.content.includes("BD-REC-RULE"));
});

test("business-discovery-synthesize writes only explicit derived outputs", () => {
  const dir = fixtureRepo();
  const run = discovery.analyze(dir, { maxFiles: 100 });
  const input = path.join(dir, "coord/.runtime/discovery/run.json");
  write(input, `${JSON.stringify(run, null, 2)}\n`);

  const result = synth.run([
    "--input",
    "coord/.runtime/discovery/run.json",
    "--json",
    "--output",
    "coord/.runtime/discovery/synthesis.json",
    "--output-dir",
    "coord/.runtime/discovery/docs",
  ], { cwd: dir, log: () => {} });

  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/discovery/synthesis.json"), "utf8"));
  assert.equal(written.kind, "concord.business_discovery.synthesis");
  assert.equal(written.read_only_contract.file_mutation_allowed, false);
  assert.equal(written.cockpit_readout.read_only_contract.discovery_execution_allowed, false);
  assert.ok(fs.existsSync(path.join(dir, "coord/.runtime/discovery/docs/BUSINESS_CONTEXT.md")));
  assert.ok(fs.existsSync(path.join(dir, "coord/.runtime/discovery/docs/OPEN_BUSINESS_QUESTIONS.md")));
  assert.ok(fs.existsSync(path.join(dir, "coord/.runtime/discovery/docs/PRESERVATION_HARNESS_CANDIDATES.md")));
});

test("product CLI routes business-discovery-synthesize", () => {
  const dir = fixtureRepo();
  const run = discovery.analyze(dir, { maxFiles: 100 });
  write(path.join(dir, "coord/.runtime/discovery/run.json"), `${JSON.stringify(run, null, 2)}\n`);
  const lines = [];
  const result = dispatch(["business-discovery-synthesize", "--input", "coord/.runtime/discovery/run.json", "--json"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.kind, "concord.business_discovery.synthesis");
});

test("synthesize public-safe pilot scenario surfaces adapters, contradictions, and proposed harness candidates", () => {
  const dir = publicSafePilotRepo();
  const run = discovery.analyze(dir, { maxFiles: 100 });
  addGenericContradiction(run);

  const synthesis = synth.synthesize(run);
  const readout = synthesis.cockpit_readout;

  assert.ok(readout.adapter_signals.some((signal) => signal.id === "pos-menu"));
  assert.ok(readout.adapter_signals.some((signal) => signal.id === "erp-configuration"));
  assert.ok(synthesis.context_graph.nodes.some((node) => node.id === "BD-REC-PILOT-CONFLICT" && node.bucket === "contradicted"));
  assert.ok(synthesis.contradictions.some((item) => item.record_ids.includes("BD-REC-PILOT-CONFLICT")));
  assert.ok(readout.contradictions.some((item) => item.record_ids.includes("BD-REC-PILOT-CONFLICT")));
  assert.ok(synthesis.promoted_docs.some((doc) => doc.file === "DOWNSTREAM_CONTRACTS.md" && doc.record_ids.length >= 1));
  assert.ok(synthesis.promoted_docs.some((doc) => doc.file === "BUSINESS_CONTEXT.md" && doc.record_ids.length >= 1));
  assert.ok(synthesis.preservation_harness_candidates.some((candidate) => (
    candidate.source_record_id === "BD-REC-PILOT-CONFLICT" &&
    candidate.harness_type === "regression_reproduction"
  )));
  assert.ok(readout.open_questions.some((question) => /downstream POS or menu format/.test(question.statement)));
  assert.equal(JSON.stringify(synthesis).includes("customer"), false);
});
