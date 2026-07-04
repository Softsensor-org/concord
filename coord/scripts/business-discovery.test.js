"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const discovery = require("./business-discovery.js");
const { dispatch } = require("./coord-cli.js");

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-"));
  write(path.join(dir, "coord/project.config.js"), [
    "module.exports = {",
    "  repos: {",
    "    B: { path: 'backend', integrationBranch: 'main' },",
    "    F: { path: 'frontend', integrationBranch: 'main' }",
    "  }",
    "};",
    "",
  ].join("\n"));
  write(path.join(dir, "backend/package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  write(path.join(dir, "backend/src/api/menuItems.ts"), "export function menuItems() {}\n");
  write(path.join(dir, "backend/src/api/taxRules.ts"), "export function taxRules() {}\n");
  write(path.join(dir, "backend/migrations/001_create_orders.sql"), "create table orders(id text);\n");
  write(path.join(dir, "frontend/src/pages/orders.tsx"), "export default function Orders() { return null; }\n");
  write(path.join(dir, "docs/process.md"), "# Process\n");
  return dir;
}

function publicSafePilotRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-pilot-"));
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

test("analyze emits source-backed business discovery run", () => {
  const dir = fixtureRepo();
  const report = discovery.analyze(dir, { maxFiles: 100 });
  assert.equal(report.kind, "concord.business_discovery.run");
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.project.repos, ["B", "F"]);
  assert.ok(report.records.some((record) => /package manager/.test(record.statement)));
  assert.ok(report.records.some((record) => record.kind === "data_dependency"));
  assert.ok(report.records.some((record) => record.kind === "integration_contract"));
  assert.ok(report.records.some((record) => record.kind === "ux_behavior"));
  assert.ok(report.adapter_signals.some((signal) => signal.id === "pos-menu"));
  assert.ok(report.records.some((record) => record.predicate === "domain_adapter_signal"));
  assert.ok(report.records.every((record) => Array.isArray(record.evidence) && record.evidence.length > 0));
  assert.ok(report.sources.every((source) => source.freshness && source.sensitivity));
  assert.ok(report.records.every((record) => record.authority && record.authority.approval_required === true));
  assert.ok(report.records.every((record) => record.authority.can_guide_implementation === false));
  assert.ok(report.questions.length >= 1);
  assert.equal(report.question_ledger.length, report.questions.length);
  assert.ok(report.question_ledger.some((question) => question.priority === "high" && question.decision_required === true));
  assert.ok(report.question_ledger.some((question) => question.generated_from === "adapter"));
  assert.ok(report.question_ledger.every((question) => Array.isArray(question.evidence) && question.evidence.length > 0));
  assert.ok(report.decision_ledger.some((decision) => decision.status === "pending" && decision.owner === "business-domain-owner"));
  assert.ok(report.decision_ledger.every((decision) => Array.isArray(decision.evidence) && decision.evidence.length > 0));
  assert.ok(report.reflection_ledger.some((reflection) => reflection.category === "pattern_confirmed"));
  assert.ok(report.reflection_ledger.some((reflection) => reflection.category === "adapter_improvement" && reflection.adapter_id === "pos-menu"));
  assert.ok(report.reflection_ledger.every((reflection) => Array.isArray(reflection.evidence) && reflection.evidence.length > 0));
  assert.equal(report.summary.decisions, report.decision_ledger.length);
  assert.equal(report.summary.reflections, report.reflection_ledger.length);
});

test("business-discovery command writes explicit derived output only when requested", () => {
  const dir = fixtureRepo();
  const output = "coord/.runtime/discovery/run.json";
  const result = discovery.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, output), "utf8"));
  assert.equal(written.kind, "concord.business_discovery.run");
  assert.equal(written.summary.records, written.records.length);
  assert.equal(written.summary.questions, written.question_ledger.length);
  assert.equal(written.summary.decisions, written.decision_ledger.length);
  assert.equal(written.summary.reflections, written.reflection_ledger.length);
  assert.equal(written.summary.adapter_signals, written.adapter_signals.length);
});

test("product CLI routes business-discovery", () => {
  const dir = fixtureRepo();
  const lines = [];
  const result = dispatch(["business-discovery", "--dir", dir, "--json", "--max-files", "100"], {
    cwd: dir,
    log: (line) => lines.push(String(line)),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.kind, "concord.business_discovery.run");
  assert.ok(Array.isArray(parsed.question_ledger));
  assert.ok(Array.isArray(parsed.decision_ledger));
  assert.ok(Array.isArray(parsed.reflection_ledger));
});

test("analyze public-safe POS and ERP pilot scenario activates adaptive discovery ledgers", () => {
  const dir = publicSafePilotRepo();
  const report = discovery.analyze(dir, { maxFiles: 100 });
  const signalIds = report.adapter_signals.map((signal) => signal.id);

  assert.deepEqual(report.project.repos, ["POS", "ERP"]);
  assert.ok(signalIds.includes("pos-menu"));
  assert.ok(signalIds.includes("erp-configuration"));
  assert.ok(report.adapter_signals.find((signal) => signal.id === "pos-menu").matched_paths.some((file) => file.includes("menu-adapter-contract")));
  assert.ok(report.adapter_signals.find((signal) => signal.id === "erp-configuration").matched_paths.some((file) => file.includes("tenant-approval-workflow")));
  assert.ok(report.records.some((record) => record.predicate === "domain_adapter_signal" && record.subject === "pos-menu"));
  assert.ok(report.records.some((record) => record.predicate === "domain_adapter_signal" && record.subject === "erp-configuration"));
  assert.ok(report.records.some((record) => record.kind === "integration_contract" && /menuAdapter/.test(record.statement)));
  assert.ok(report.records.some((record) => record.kind === "configuration_surface" && /tenant-approval-workflow/.test(record.statement)));
  assert.ok(report.question_ledger.some((question) => question.generated_from === "adapter" && /downstream POS or menu format/.test(question.question)));
  assert.ok(report.question_ledger.some((question) => question.generated_from === "adapter" && /configured variants/.test(question.question)));
  assert.ok(report.decision_ledger.some((decision) => decision.subject === "business_authority.surface_precedence"));
  assert.ok(report.reflection_ledger.some((reflection) => reflection.adapter_id === "pos-menu"));
  assert.ok(report.reflection_ledger.some((reflection) => reflection.adapter_id === "erp-configuration"));
  assert.equal(JSON.stringify(report).includes("customer"), false);
});

test("analyze emits honest sparse-memory cold-start baseline for new repo fixture", () => {
  const dir = fixtureRepo();
  const report = discovery.analyze(dir, { maxFiles: 100 });
  const baseline = report.cold_start_baseline;

  assert.equal(baseline.status, "sparse_memory_baseline");
  assert.equal(baseline.sparse_memory, true);
  assert.equal(baseline.confirmed_authority.accepted_confirmed_records, 0);
  assert.equal(baseline.confirmed_authority.may_claim_confirmed_memory, false);
  assert.match(baseline.authority_warning, /No accepted confirmed business-memory claims/);
  assert.ok(baseline.inventory_coverage.files_scanned > 0);
  assert.deepEqual(baseline.inventory_coverage.repos_seen, ["B", "F"]);
  assert.ok(baseline.inventory_coverage.high_signal_records > 0);
  assert.ok(baseline.inventory_coverage.gaps.includes("No accepted confirmed memory or owner-approved business rules were found."));
  assert.ok(baseline.observed_workflows.some((item) => item.kind === "ux_behavior"));
  assert.ok(baseline.inferred_rules.some((item) => ["integration_contract", "data_dependency", "configuration_surface", "hypothesis"].includes(item.kind)));
  assert.ok(baseline.known_unknowns.length >= 1);
  assert.ok(baseline.required_human_questions.some((question) => question.decision_required === true));
  assert.ok(baseline.risky_workaround_candidates.some((item) => item.adapter_id === "pos-menu"));
  assert.ok(baseline.initial_preservation_test_candidates.some((item) => item.approval_required === true));
  assert.equal(report.summary.sparse_memory_baseline, true);
});
