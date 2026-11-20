"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const discovery = require("./business-discovery.js");
const synth = require("./business-discovery-synthesize.js");
const { dispatch } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));

function write(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
}

test("COORD-521: question aliases count once and retain ledger metadata", () => {
  const questions = [1, 2, 3].map((n) => ({ id: `Q-${n}`, question: `Question ${n}?` }));
  const run = {
    kind: "concord.business_discovery.run", sources: [], records: [], questions,
    question_ledger: questions.map((q) => ({ ...q, owner: "domain-owner", priority: "P1", decision_required: true })),
  };
  const before = structuredClone(run);
  const result = synth.synthesize(run);
  assert.equal(result.summary.unknowns, 3);
  assert.equal(result.cockpit_readout.open_questions.length, result.summary.unknowns);
  assert.deepEqual(result.cockpit_readout.open_questions.map((q) => q.id), ["Q-1", "Q-2", "Q-3"]);
  assert.equal(result.cockpit_readout.open_questions[0].owner, "domain-owner");
  assert.equal(result.cockpit_readout.open_questions[0].decision_required, true);
  assert.deepEqual(run, before, "read-only synthesis must not change the input");
  assert.deepEqual(synth.synthesize(run), result);
});

test("COORD-521: ledger-only questions and distinct IDs survive the shared count", () => {
  const result = synth.synthesize({
    kind: "concord.business_discovery.run", sources: [], records: [],
    questions: [{ id: "Q-A", question: "Same wording?" }],
    question_ledger: [{ id: "Q-B", question: "Same wording?" }, { id: "Q-B", question: "Same wording?" }],
  });
  assert.equal(result.summary.unknowns, 2);
  assert.deepEqual(result.cockpit_readout.open_questions.map((q) => q.id), ["Q-A", "Q-B"]);
});

test("COORD-521: unidentified questions are not collapsed into one undefined ID", () => {
  const result = synth.synthesize({
    kind: "concord.business_discovery.run", sources: [], records: [],
    question_ledger: [{ question: "First?" }, { question: "Second?" }],
  });
  assert.equal(result.summary.unknowns, 2);
  assert.deepEqual(result.cockpit_readout.open_questions.map((q) => q.statement), ["First?", "Second?"]);
});

test("empty rule documents report emitter coverage instead of a negative repository finding", () => {
  const synthesis = synth.synthesize({ kind: "concord.business_discovery.run", sources: [], records: [] });
  const doc = synthesis.promoted_docs.find((item) => item.file === "BUSINESS_RULES.md");
  assert.match(doc.content, /NOT-IMPLEMENTED: no source emitter/);
  assert.doesNotMatch(doc.content, /No candidate records found in the discovery run/);
});

test("COORD-583: a scanned Mongoose and Prisma repo yields a populated BUSINESS_RULES.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-synth-rules-"));
  write(path.join(dir, "backend/src/models/order.js"), [
    "const { Schema, model } = require('mongoose');",
    "const orderSchema = new Schema({",
    "  reference: { type: String, validate: isOrderReference },",
    "  total: { type: Number, min: 0, max: 50000, validate: { validator: withinCreditLimit, message: 'Order exceeds the credit limit' } },",
    "  channel: { type: String, enum: ['web', 'store'] },",
    "  notes: String,",
    "});",
    "module.exports = model('Order', orderSchema);",
    "",
  ].join("\n"));
  write(path.join(dir, "backend/prisma/schema.prisma"), [
    "enum Tier {",
    "  BASIC",
    "  GOLD",
    "}",
    "model Customer {",
    "  id    String @id",
    "  phone String?",
    "  tier  Tier",
    "}",
    "",
  ].join("\n"));

  // The run goes through the scanner and the synthesizer; no record is hand-built.
  const run = discovery.analyze(dir, { maxFiles: 100 });
  const doc = synth.synthesize(run).promoted_docs.find((item) => item.file === "BUSINESS_RULES.md");

  assert.doesNotMatch(doc.content, /NOT-IMPLEMENTED/);
  assert.match(doc.content, /- Kind: field_rule\n- Confidence: observed\n- Status: candidate\n- Subject: total\n- Predicate: field_constraint\n- Object: type: Number, min: 0, max: 50000\n/);
  assert.match(doc.content, /- Subject: channel\n- Predicate: field_constraint\n- Object: type: String, enum: \['web', 'store'\]\n/);
  assert.match(doc.content, /- Subject: notes\n- Predicate: field_constraint\n- Object: type: String\n/);
  assert.match(doc.content, /- Subject: phone\n- Predicate: field_constraint\n- Object: type: String, optional\n/);
  assert.match(doc.content, /- Subject: tier\n- Predicate: field_constraint\n- Object: type: Tier, enum: \[BASIC, GOLD\]\n/);
  assert.match(doc.content, /Discovered named validator isOrderReference for Order\.reference at backend\/src\/models\/order\.js\.\n\n- Kind: business_rule\n/);
  assert.match(doc.content, /Discovered named validator withinCreditLimit for Order\.total at backend\/src\/models\/order\.js: Order exceeds the credit limit\.\n\n- Kind: business_rule\n- Confidence: observed\n- Status: candidate\n- Subject: withinCreditLimit\n- Predicate: named_validator\n- Object: Order\.total\n- Evidence:\n {2}- SRC-\d{4} implementation backend\/src\/models\/order\.js\n/);

  // Every rendered record is one the scanner emitted for a rule kind.
  const emitted = run.records.filter((record) => ["business_rule", "field_rule"].includes(record.kind)).map((record) => record.id);
  assert.deepEqual(doc.record_ids, emitted);
  assert.equal(run.records.filter((record) => record.kind === "business_rule").length, 2);
});

test("decision and reflection ledger documents preserve native fields and evidence without promoting entries", () => {
  const run = {
    kind: "concord.business_discovery.run",
    sources: [
      { id: "SRC-1", authority: "requirement", path: "docs/approval.md" },
      { id: "SRC-URI", uri: "https://example.test/approval-contract" },
    ],
    records: [
      {
        id: "BD-REC-LEGACY-DECISION",
        kind: "decision",
        subject: "legacy decision record",
        statement: "Record-shaped decisions remain visible.",
        confidence: "observed",
        status: "candidate",
        evidence: [],
      },
      {
        id: "BD-REC-LEGACY-REFLECTION",
        kind: "reflection",
        statement: "Record-shaped reflections remain visible.",
        confidence: "observed",
        status: "candidate",
        evidence: [],
      },
    ],
    decision_ledger: [
      {
        id: "BD-DEC-PENDING",
        question_id: "BD-Q-1",
        subject: "approval threshold",
        owner: null,
        status: "pending",
        decision: null,
        options: ["Keep current threshold", "Raise threshold"],
        rationale: "Owner confirmation is still needed.",
        evidence: [{ source_id: "SRC-1", note: "Approval discussion, paragraph 4." }],
        consequences: ["Dependent claims remain non-governing."],
        waiver: null,
      },
      {
        id: "BD-DEC-ACCEPTED",
        question_id: null,
        subject: "reporting period",
        owner: "reporting-owner",
        status: "accepted",
        decision: "Use calendar month.",
        options: [],
        rationale: "Matches the approved reporting requirement.",
        evidence: [
          { source_id: "MISSING-SOURCE", note: "Legacy source reference." },
          { source_id: "SRC-URI" },
        ],
        consequences: [],
        waiver: {
          owner: "reporting-owner",
          scope: "Monthly reports",
          reason: "Existing contract requires calendar months.",
          revisit_condition: "When the contract changes.",
        },
      },
    ],
    reflection_ledger: [
      {
        id: "BD-REFL-REJECTED",
        category: "pattern_rejected",
        statement: "The inferred approval pattern did not hold across the cited workflow.",
        evidence: [{ source_id: "SRC-1", note: "Counterexample in paragraph 9." }],
        related_records: ["BD-REC-LEGACY-REFLECTION"],
        adapter_id: null,
        recommendation: null,
        status: "rejected",
      },
      {
        id: "BD-REFL-CANDIDATE",
        category: "adapter_improvement",
        statement: "A reusable adapter note remains a candidate.",
        evidence: [{ source_id: "SRC-URI" }],
        related_records: [],
        adapter_id: "adapter-orders",
        recommendation: "Add a contract probe.",
        status: "candidate",
      },
    ],
  };
  const before = structuredClone(run);
  const synthesis = synth.synthesize(run);
  assert.deepEqual(run, before, "synthesis must not mutate native ledger input");
  assert.deepEqual(synth.synthesize(run), synthesis, "the same run should produce the same synthesis");

  const decisionDoc = synthesis.promoted_docs.find((item) => item.file === "DECISION_LOG.md");
  assert.deepEqual(decisionDoc.record_ids, ["BD-REC-LEGACY-DECISION"]);
  assert.deepEqual(decisionDoc.ledger_ids, ["BD-DEC-PENDING", "BD-DEC-ACCEPTED"]);
  assert.match(decisionDoc.content, /Record-shaped decisions remain visible\./);
  assert.match(decisionDoc.content, /BD-DEC-PENDING/);
  assert.match(decisionDoc.content, /Question ID: BD-Q-1/);
  assert.match(decisionDoc.content, /Owner: unassigned/);
  assert.match(decisionDoc.content, /Status: pending/);
  assert.match(decisionDoc.content, /Decision: none recorded/);
  assert.match(decisionDoc.content, /Keep current threshold/);
  assert.match(decisionDoc.content, /Owner confirmation is still needed/);
  assert.match(decisionDoc.content, /Dependent claims remain non-governing/);
  assert.match(decisionDoc.content, /SRC-1 requirement docs\/approval\.md — Approval discussion, paragraph 4\./);
  assert.match(decisionDoc.content, /Status: accepted/);
  assert.match(decisionDoc.content, /Decision: Use calendar month\./);
  assert.match(decisionDoc.content, /Revisit condition: When the contract changes\./);
  assert.match(decisionDoc.content, /MISSING-SOURCE — Legacy source reference\./);
  assert.match(decisionDoc.content, /SRC-URI unknown https:\/\/example\.test\/approval-contract/);
  assert.doesNotMatch(decisionDoc.content.slice(decisionDoc.content.indexOf("## BD-DEC-PENDING")), /Confidence:/);
  assert.doesNotMatch(decisionDoc.content, /NOT-IMPLEMENTED/);

  const workaroundsDoc = synthesis.promoted_docs.find((item) => item.file === "KNOWN_WORKAROUNDS.md");
  assert.deepEqual(workaroundsDoc.record_ids, ["BD-REC-LEGACY-REFLECTION"]);
  assert.deepEqual(workaroundsDoc.ledger_ids, ["BD-REFL-REJECTED", "BD-REFL-CANDIDATE"]);
  assert.match(workaroundsDoc.content, /Record-shaped reflections remain visible\./);
  assert.match(workaroundsDoc.content, /pattern_rejected/);
  assert.match(workaroundsDoc.content, /Status: rejected/);
  assert.match(workaroundsDoc.content, /Related records:[\s\S]*BD-REC-LEGACY-REFLECTION/);
  assert.match(workaroundsDoc.content, /Adapter: none recorded/);
  assert.match(workaroundsDoc.content, /Recommendation: none recorded/);
  assert.match(workaroundsDoc.content, /Counterexample in paragraph 9\./);
  assert.match(workaroundsDoc.content, /Adapter: adapter-orders/);
  assert.match(workaroundsDoc.content, /Recommendation: Add a contract probe\./);
  assert.doesNotMatch(workaroundsDoc.content, /NOT-IMPLEMENTED/);
  assert.doesNotMatch(workaroundsDoc.content.slice(workaroundsDoc.content.indexOf("## BD-REFL-REJECTED")), /Confidence:/);

  assert.equal(synthesis.summary.records, 2);
  assert.deepEqual(synthesis.context_graph.nodes.map((node) => node.id), [
    "SRC-1", "SRC-URI", "BD-REC-LEGACY-DECISION", "BD-REC-LEGACY-REFLECTION",
  ]);
  assert.deepEqual(synthesis.unknowns, []);
  assert.deepEqual(synthesis.preservation_harness_candidates, []);
  assert.deepEqual(synthesis.evidence_classification.cited_sources, []);

  const ledgerOnly = synth.synthesize({ ...run, records: [] });
  const ledgerOnlyDecisionDoc = ledgerOnly.promoted_docs.find((item) => item.file === "DECISION_LOG.md");
  assert.deepEqual(ledgerOnlyDecisionDoc.record_ids, []);
  assert.deepEqual(ledgerOnlyDecisionDoc.ledger_ids, ["BD-DEC-PENDING", "BD-DEC-ACCEPTED"]);
  assert.match(synth.renderMarkdown(ledgerOnly), /DECISION_LOG\.md: 0 record\(s\), 2 ledger entries/);
});

test("legacy runs without ledger arrays still render existing reflection records", () => {
  const synthesis = synth.synthesize({
    kind: "concord.business_discovery.run",
    sources: [],
    records: [{
      id: "BD-REC-REFLECTION",
      kind: "reflection",
      statement: "Existing record-shaped reflection remains visible.",
      confidence: "observed",
      status: "candidate",
      evidence: [],
    }],
  });

  const workaroundsDoc = synthesis.promoted_docs.find((item) => item.file === "KNOWN_WORKAROUNDS.md");
  assert.deepEqual(workaroundsDoc.record_ids, ["BD-REC-REFLECTION"]);
  assert.equal(Object.hasOwn(workaroundsDoc, "ledger_ids"), false);
  assert.match(workaroundsDoc.content, /Existing record-shaped reflection remains visible\./);
  assert.match(workaroundsDoc.content, /Confidence: observed/);
  assert.match(workaroundsDoc.content, /Status: candidate/);

  const decisionDoc = synthesis.promoted_docs.find((item) => item.file === "DECISION_LOG.md");
  assert.deepEqual(decisionDoc.record_ids, []);
  assert.equal(Object.hasOwn(decisionDoc, "ledger_ids"), false);
  assert.match(decisionDoc.content, /NOT-IMPLEMENTED: no source emitter/);
  assert.equal(synthesis.cockpit_readout.discovery_runs[0].summary.decisions, 0);
  assert.equal(synthesis.cockpit_readout.discovery_runs[0].summary.reflections, 0);
});

test("partial decision records keep the existing API defaults", () => {
  const synthesis = synth.synthesize({
    kind: "concord.business_discovery.run",
    records: [{
      id: "BD-REC-LEGACY-DECISION-BARE",
      kind: "decision",
      statement: "Older record omitted confidence and status fields.",
    }],
  });

  const decision = synthesis.cockpit_readout.decisions.find((item) => item.id === "BD-REC-LEGACY-DECISION-BARE");
  assert.equal(decision.confidence, "unknown");
  assert.equal(decision.status, "candidate");
  assert.equal(synthesis.cockpit_readout.fact_confidence.by_confidence.unknown, 1);
  assert.equal(synthesis.cockpit_readout.fact_confidence.by_status.unknown, 1);
  assert.deepEqual(synthesis.cockpit_readout.discovery_runs[0].summary, {
    records: 1, sources: 0, questions: 0, decisions: 0, reflections: 0, adapter_signals: 0,
  });
});

test("pre-COORD-551 partial ledger inputs preserve the existing API readout and tolerate omitted arrays", () => {
  const synthesis = synth.synthesize({
    kind: "concord.business_discovery.run",
    decision_ledger: [{ id: "LEGACY-D", statement: "Await owner approval" }],
    reflection_ledger: [{ id: "LEGACY-R", statement: "Retry manually" }],
    adapter_signals: [{ id: "LEGACY-A", label: "Legacy adapter", confidence: "candidate" }],
    contradictions: [{ id: "LEGACY-C", statement: "Policies differ" }],
    question_ledger: [{ id: "LEGACY-Q", statement: "Who approves?" }],
  });

  assert.deepEqual(synthesis.cockpit_readout.decisions, [{
    id: "LEGACY-D", status: "pending", owner: null, question: "Await owner approval",
    options: [], consequence: null, evidence: [],
  }]);
  assert.deepEqual(synthesis.cockpit_readout.adapter_signals, [{
    id: "LEGACY-A", label: "Legacy adapter", confidence: "candidate",
    matched_paths: [], probes: [], risks: [], questions: [],
  }]);
  assert.deepEqual(synthesis.cockpit_readout.contradictions, [{
    id: "LEGACY-C", record_ids: [], status: "open", statement: "Policies differ", resolution: null,
  }]);
  assert.deepEqual(synthesis.cockpit_readout.open_questions, [{
    id: "LEGACY-Q", kind: "question", statement: "Who approves?", reason: "open_question",
    owner: null, priority: null, decision_required: false,
  }]);

  const decisionDoc = synthesis.promoted_docs.find((item) => item.file === "DECISION_LOG.md");
  assert.match(decisionDoc.content, /## LEGACY-D/);
  assert.match(decisionDoc.content, /Options:\n  - none recorded/);
  assert.match(decisionDoc.content, /Consequences:\n  - none recorded/);
  assert.match(decisionDoc.content, /Waiver: none recorded/);
  assert.match(decisionDoc.content, /Evidence:\n/);
  const workaroundDoc = synthesis.promoted_docs.find((item) => item.file === "KNOWN_WORKAROUNDS.md");
  assert.match(workaroundDoc.content, /## LEGACY-R/);
  assert.match(workaroundDoc.content, /Related records:\n  - none recorded/);
  assert.match(workaroundDoc.content, /Adapter: none recorded/);
  assert.match(workaroundDoc.content, /Recommendation: none recorded/);
});

test("schema-shaped relationship and source ID-only evidence render in the native ledger document", () => {
  const run = {
    kind: "concord.business_discovery.run",
    schema_version: 1,
    project: { name: "fixture", scope: "local test", repos: ["X"] },
    generator: { name: "fixture", version: "1", command: "test" },
    sources: [{
      id: "SRC-ID-ONLY", type: "human_note", authority: "accepted_decision", freshness: "current",
      sensitivity: "internal", visibility: "internal",
    }],
    records: [],
    relationships: [{ from: "BD-Q-1", type: "decided_by", to: "BD-DEC-1" }],
    contradictions: [],
    questions: [{ id: "BD-Q-1", question: "Which reporting period?", owner: null, status: "open" }],
    question_ledger: [],
    decision_ledger: [{
      id: "BD-DEC-1", question_id: "BD-Q-1", subject: "reporting period", owner: "reporting-owner",
      status: "accepted", decision: "Use calendar month.", options: [],
      rationale: "Matches the approved reporting requirement.", evidence: [{ source_id: "SRC-ID-ONLY" }],
      consequences: [], waiver: null,
    }],
    reflection_ledger: [],
    promotion_candidates: [],
    adapter_signals: [],
    summary: {
      files_scanned: 1, records: 0, sources: 1, questions: 1, decisions: 1, reflections: 0,
      promotion_candidates: 0, adapter_signals: 0, package_managers: [], languages: {}, truncated: false,
    },
  };

  const synthesis = synth.synthesize(run);
  assert.ok(synthesis.context_graph.edges.some((edge) => (
    edge.from === "BD-Q-1" && edge.type === "decided_by" && edge.to === "BD-DEC-1"
  )));
  const decisionDoc = synthesis.promoted_docs.find((item) => item.file === "DECISION_LOG.md");
  assert.match(decisionDoc.content, /SRC-ID-ONLY accepted_decision SRC-ID-ONLY/);
  assert.match(synth.renderMarkdown(synthesis), /DECISION_LOG\.md: 0 record\(s\), 1 ledger entry/);
});

test("public CLI reports help and input failures without writing outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-synth-cli-errors-"));
  try {
    const lines = [];
    assert.equal(synth.run(["--help"], { cwd: dir, log: (line) => lines.push(String(line)) }).code, 0);
    assert.match(lines.at(-1), /^Usage: business-discovery-synthesize/);

    lines.length = 0;
    assert.equal(synth.run(["--unknown"], { cwd: dir, log: (line) => lines.push(String(line)) }).code, 1);
    assert.match(lines.at(-1), /Unexpected argument: --unknown/);

    lines.length = 0;
    assert.equal(synth.run(["--input", "missing.json"], { cwd: dir, log: (line) => lines.push(String(line)) }).code, 1);
    assert.match(lines.at(-1), /unable to read missing\.json/);

    write(path.join(dir, "wrong-kind.json"), JSON.stringify({ kind: "not-a-discovery-run" }));
    lines.length = 0;
    assert.equal(synth.run(["--input", "wrong-kind.json"], { cwd: dir, log: (line) => lines.push(String(line)) }).code, 1);
    assert.match(lines.at(-1), /Input must be a concord\.business_discovery\.run artifact/);
    assert.equal(fs.readdirSync(dir).sort().join(","), "wrong-kind.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--write-default writes synthesis JSON for a kind-only legacy input accepted by the API", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-synth-write-default-"));
  try {
    const inputPath = path.join(dir, synth.DEFAULT_INPUT);
    write(inputPath, JSON.stringify({ kind: "concord.business_discovery.run" }));
    const result = synth.run(["--write-default"], { cwd: dir, log: () => {} });
    assert.equal(result.code, 0);
    const outputPath = path.join(dir, synth.DEFAULT_OUTPUT);
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(written.kind, "concord.business_discovery.synthesis");
    assert.equal(written.promoted_docs.find((item) => item.file === "DECISION_LOG.md").content.includes("NOT-IMPLEMENTED"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("executable CLI entrypoint exits zero for help and markdown, and one for invalid input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-synth-cli-entrypoint-"));
  try {
    write(path.join(dir, "run.json"), JSON.stringify({ kind: "concord.business_discovery.run" }));
    const executable = require.resolve("./business-discovery-synthesize.js");
    const help = spawnSync(process.execPath, [executable, "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(help.error, undefined);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: business-discovery-synthesize/);

    const markdown = spawnSync(process.execPath, [executable, "--input", "run.json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(markdown.error, undefined);
    assert.equal(markdown.status, 0);
    assert.match(markdown.stdout, /# Business Discovery Synthesis/);
    assert.match(markdown.stdout, /DECISION_LOG\.md: 0 record\(s\)/);

    write(path.join(dir, "wrong-kind.json"), JSON.stringify({ kind: "not-a-discovery-run" }));
    const invalid = spawnSync(process.execPath, [executable, "--input", "wrong-kind.json"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /Input must be a concord\.business_discovery\.run artifact/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-521: public synthesis dispatcher emits the same deduplicated count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c521-dispatch-"));
  try {
    const q = { id: "Q-CLI", question: "Who approves?" };
    write(path.join(dir, "run.json"), JSON.stringify({
      kind: "concord.business_discovery.run", sources: [], records: [], questions: [q], question_ledger: [q],
    }));
    const lines = [];
    const result = dispatch(["business-discovery-synthesize", "--input", "run.json", "--json"], {
      cwd: dir, log: (line) => lines.push(String(line)),
    });
    assert.equal(result.code, 0);
    const output = JSON.parse(lines.join("\n"));
    assert.equal(output.summary.unknowns, 1);
    assert.equal(output.cockpit_readout.open_questions.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  write(path.join(dir, "backend/src/api/orders.ts"), "const app = express(); app.get('/orders', handler);\n");
  write(path.join(dir, "backend/migrations/001_create_orders.sql"), "create table orders(id text);\n");
  write(path.join(dir, "frontend/src/pages/orders.tsx"), "export default function Orders() { return <OrderList />; }\n");
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
  write(path.join(dir, "generic-pos/src/api/menuAdapter.ts"), "const app = express(); app.post('/menu', publishMenuContract);\n");
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
