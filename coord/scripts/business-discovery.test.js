"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const discovery = require("./business-discovery.js");
const staticConfigDeclaration = require("./static-config-declaration.js");
const paths = require("../paths.js");
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

// ---------------------------------------------------------------------------
// COORD-657 — the adopter `project.config.js` trust boundary.
//
// Discovery runs against repositories Concord has never seen, so an adopter's
// coord/project.config.js is UNTRUSTED INPUT (ADR-0010's class, applied to
// ADR-0007's no-adopter-execution rule). Before this ticket, readProjectConfig
// called `require(configPath)` on it — and a bare `catch {}` swallowed the
// error, so a config that ran side effects and then threw left no trace in
// EITHER path. These five proofs pin the boundary.
// ---------------------------------------------------------------------------

function treeDigest(dir) {
  const entries = [];
  (function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) entries.push(`${path.relative(dir, full)} ${fs.readFileSync(full, "utf8")}`);
    }
  })(dir);
  return entries.join("");
}

// A config whose MODULE BODY has observable side effects: it writes a sentinel
// file, sets an env var, and spawns a process — then throws, which is the case
// the old bare `catch {}` erased entirely.
function sideEffectConfigRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-sideeffect-"));
  const sentinel = path.join(dir, "SIDE-EFFECT-EXECUTED.txt");
  const spawnSentinel = path.join(dir, "SPAWN-EXECUTED.txt");
  write(path.join(dir, "coord/project.config.js"), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed');`,
    "process.env.COORD_657_SIDE_EFFECT = 'executed';",
    `require('node:child_process').execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], 'spawned')", ${JSON.stringify(spawnSentinel)}]);`,
    "module.exports = { repos: { B: { path: 'backend' } } };",
    "throw new Error('config exploded after its side effects');",
    "",
  ].join("\n"));
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  return { dir, sentinel, spawnSentinel };
}

test("PROOF 1 (COORD-657): discovery never executes an adopter project.config.js", () => {
  const { dir, sentinel, spawnSentinel } = sideEffectConfigRepo();
  delete process.env.COORD_657_SIDE_EFFECT;
  const before = treeDigest(dir);

  // Called twice: the old code deleted the require cache on every call, so
  // repeated discovery re-ran the adopter's module body each time.
  const first = discovery.analyze(dir, { maxFiles: 100 });
  const second = discovery.analyze(dir, { maxFiles: 100 });

  // The side effect must NOT have occurred — not merely "no value was returned".
  assert.equal(fs.existsSync(sentinel), false, "adopter config wrote its sentinel file: it was executed");
  assert.equal(fs.existsSync(spawnSentinel), false, "adopter config spawned a process: it was executed");
  assert.equal(process.env.COORD_657_SIDE_EFFECT, undefined, "adopter config set a process env var: it was executed");
  // State is byte-identical, not merely un-thrown.
  assert.equal(treeDigest(dir), before, "the scanned tree was mutated by reading the configuration");

  assert.equal(first.configuration_declaration.executed, false);
  assert.equal(first.configuration_declaration.status, "refused");
  assert.deepEqual(second.configuration_declaration, first.configuration_declaration);
});

// A legitimate, fully STATIC configuration. The expected values are stated
// here in the fixture, never computed from the code under test.
const STATIC_EXPECTATIONS = Object.freeze({
  repos: Object.freeze({
    B: Object.freeze({ path: "backend", integrationBranch: "release/backend" }),
    F: Object.freeze({ path: "frontend", integrationBranch: "trunk" }),
  }),
  tracks: Object.freeze(["data-analytics", "development", "marketing"]),
  coordTicketPrefix: "ACME",
});

function staticConfigRepo(extraConfigLines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-static-"));
  write(path.join(dir, "coord/project.config.js"), [
    "// A perfectly ordinary declarative adopter config.",
    '"use strict";',
    "module.exports = {",
    "  coordTicketPrefix: 'ACME',",
    "  repos: {",
    "    B: { path: 'backend', integrationBranch: 'release/backend', legacyAliases: [], testCommand: 'npm run test:ci' },",
    "    F: { path: 'frontend', integrationBranch: 'trunk', ticketPrefixes: ['FE'] }",
    "  },",
    "  tracks: {",
    "    marketing: { gateProc: 'content', defaultLane: 'default', prefixes: ['WEB'], reviewPolicy: { approvers: 1 } },",
    "    development: { gateProc: 'test', defaultLane: 'default', prefixes: ['DEV', 'FE'], reviewPolicy: { approvers: 1 } },",
    "    'data-analytics': { gateProc: 'data-contract', defaultLane: 'default', prefixes: ['DATA'] }",
    "  },",
    "  requirements: { path: 'product/REQUIREMENTS.md' },",
    ...extraConfigLines,
    "};",
    "",
  ].join("\n"));
  write(path.join(dir, "backend/package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  write(path.join(dir, "frontend/src/pages/orders.tsx"), "export default function Orders() { return null; }\n");
  return dir;
}

test("PROOF 3 (COORD-657): static declared metadata is still discoverable by value", () => {
  const dir = staticConfigRepo();
  const report = discovery.analyze(dir, { maxFiles: 100 });
  const declaration = report.configuration_declaration;

  assert.equal(declaration.status, "declared");
  assert.equal(declaration.path, "coord/project.config.js");
  assert.equal(declaration.code, null);

  // Repo layout and integration branches — asserted BY VALUE against the
  // fixture's stated expectations, not against anything the reader computed.
  assert.deepEqual(Object.keys(declaration.surface.repos).sort(), Object.keys(STATIC_EXPECTATIONS.repos).sort());
  for (const [code, expected] of Object.entries(STATIC_EXPECTATIONS.repos)) {
    assert.equal(declaration.surface.repos[code].path, expected.path);
    assert.equal(declaration.surface.repos[code].integrationBranch, expected.integrationBranch);
  }
  assert.deepEqual(declaration.surface.tracks, STATIC_EXPECTATIONS.tracks);
  assert.equal(declaration.surface.coord_ticket_prefix, STATIC_EXPECTATIONS.coordTicketPrefix);

  // The same values reach the artifact's records and its repo list.
  assert.deepEqual(report.project.repos, ["B", "F"]);
  for (const [code, expected] of Object.entries(STATIC_EXPECTATIONS.repos)) {
    assert.ok(
      report.records.some((record) => record.predicate === "repo_path" && record.subject === code && record.object === expected.path),
      `no repo_path record for ${code}`
    );
    assert.ok(
      report.records.some((record) => record.predicate === "integration_branch" && record.subject === code && record.object === expected.integrationBranch),
      `no integration_branch record for ${code}`
    );
  }
  for (const track of STATIC_EXPECTATIONS.tracks) {
    assert.ok(report.records.some((record) => record.predicate === "governance_track" && record.object === track), `no governance_track record for ${track}`);
  }
  assert.ok(report.records.some((record) => record.predicate === "coord_ticket_prefix" && record.object === STATIC_EXPECTATIONS.coordTicketPrefix));
  assert.ok(report.records.some((record) => record.predicate === "declares" && record.confidence !== "unknown"));
});

test("PROOF 2 (COORD-657): environment, on-disk and off-surface canaries cannot reach the artifact", () => {
  const envCanary = "CANARY-ENV-4f1c9a2b";
  const fileCanary = "CANARY-FILE-7d3e8b05";
  const configCanary = "CANARY-CONFIG-90ab12cd";
  process.env.COORD_657_CANARY = envCanary;
  try {
    // A canary declared inside the config under a key discovery does not
    // project, plus a canary in a file the config could have read.
    const dir = staticConfigRepo([`  adopterSecret: '${configCanary}',`]);
    write(path.join(dir, "backend/.notes"), `${fileCanary}\n`);

    const output = "coord/.runtime/discovery/run.json";
    const result = discovery.run(["--dir", dir, "--json", "--output", output], { cwd: dir, log: () => {} });
    assert.equal(result.code, 0);
    const runJson = fs.readFileSync(path.join(dir, output), "utf8");

    for (const canary of [envCanary, fileCanary, configCanary]) {
      assert.equal(runJson.includes(canary), false, `canary ${canary} reached run.json`);
      assert.equal(JSON.stringify(result.report).includes(canary), false, `canary ${canary} reached the in-memory report`);
      assert.equal(JSON.stringify(result.report.decision_ledger).includes(canary), false, `canary ${canary} reached a decision record`);
      assert.equal(JSON.stringify(result.report.promotion_candidates).includes(canary), false, `canary ${canary} reached a promotion`);
      assert.equal(result.report.sources.some((source) => String(source.path).includes(canary)), false, `canary ${canary} reached an emitted path`);
    }
    // The declared surface carries only the projected fields.
    assert.deepEqual(Object.keys(result.report.configuration_declaration.surface).sort(), ["coord_ticket_prefix", "repos", "tracks"]);
    for (const repo of Object.values(result.report.configuration_declaration.surface.repos)) {
      assert.deepEqual(Object.keys(repo).sort(), ["integrationBranch", "path"]);
    }
  } finally {
    delete process.env.COORD_657_CANARY;
  }
});

test("PROOF 4 (COORD-657): a dynamic or unreadable configuration fails closed and loudly", () => {
  const { dir } = sideEffectConfigRepo();
  const before = treeDigest(dir);
  const lines = [];
  const result = discovery.run(["--dir", dir, "--json", "--max-files", "100"], { cwd: dir, log: () => {}, logError: (line) => lines.push(String(line)) });

  // Fails CLOSED: non-zero, never a silent clean run.
  assert.equal(result.code, 1);
  const declaration = result.report.configuration_declaration;
  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_unsupported_module_shape");
  // Names the file, the construct, its position, and the operator's next step.
  assert.equal(
    declaration.message,
    "Refused to read coord/project.config.js without executing it: found no top-level `module.exports = { ... }` assignment at line 1, column 1."
  );
  assert.match(declaration.remediation, /Rewrite coord\/project\.config\.js as a single top-level `module\.exports = \{ \.\.\. \}` object literal/);
  assert.match(declaration.remediation, /re-run `coord business-discovery`/);
  assert.ok(lines.some((line) => line.startsWith("business-discovery: config_unsupported_module_shape:")), "the refusal was not reported to the operator on stderr");

  // A config that IS shaped correctly but computes a value dynamically is
  // classified as a dynamic declaration and named precisely.
  const dynamicDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-dynamic-"));
  write(path.join(dynamicDir, "coord/project.config.js"), "module.exports = { repos: { B: { path: require('node:os').tmpdir() } } };\n");
  const dynamic = discovery.analyze(dynamicDir, { maxFiles: 20 }).configuration_declaration;
  assert.equal(dynamic.code, "config_not_declarative");
  assert.equal(
    dynamic.message,
    "Refused to read coord/project.config.js without executing it: found a module load expression at line 1, column 40."
  );
  assert.match(dynamic.remediation, /Replace the dynamic expression in coord\/project\.config\.js with literal values/);
  assert.match(dynamic.remediation, /Discovery will not run adopter code to learn the repo map/);

  // Loud in the artifact too: a classified record, and a decision-required question.
  const record = result.report.records.find((item) => item.predicate === "declaration_refused");
  assert.ok(record, "no declaration_refused record was emitted");
  assert.equal(record.object, "config_unsupported_module_shape");
  assert.match(record.statement, /Refused to read coord\/project\.config\.js without executing it/);
  const question = result.report.question_ledger.find((item) => /refused to read coord\/project\.config\.js/i.test(item.question));
  assert.ok(question, "no operator question was raised for the refusal");
  assert.equal(question.decision_required, true);
  assert.equal(question.priority, "high");
  assert.ok(result.report.decision_ledger.some((item) => item.subject === "discovery_scope.configuration_declaration"));

  // Nothing about the refusal echoes file CONTENT, and nothing was mutated.
  assert.equal(JSON.stringify(result.report).includes("config exploded"), false);
  assert.equal(treeDigest(dir), before);

  // An unreadable config is classified separately from a dynamic one.
  const dirDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-unreadable-"));
  fs.mkdirSync(path.join(dirDir, "coord/project.config.js"), { recursive: true });
  const unreadable = discovery.analyze(dirDir, { maxFiles: 20 }).configuration_declaration;
  assert.equal(unreadable.status, "refused");
  assert.equal(unreadable.code, "config_unreadable");
  assert.match(unreadable.message, /Refused to read coord\/project\.config\.js: (the path could not be opened \(EISDIR\)|the path is not a regular file)\./);
  assert.match(unreadable.remediation, /Make coord\/project\.config\.js readable as a regular file/);

  // A config with no `module.exports = { ... }` is classified separately again.
  const shapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-shape-"));
  write(path.join(shapeDir, "coord/project.config.js"), "export default { repos: {} };\n");
  const shape = discovery.analyze(shapeDir, { maxFiles: 20 }).configuration_declaration;
  assert.equal(shape.code, "config_unsupported_module_shape");
  assert.match(shape.remediation, /Rewrite coord\/project\.config\.js as a single top-level `module\.exports = \{ \.\.\. \}` object literal/);

  // An absent config is "absent", not a refusal.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-absent-"));
  write(path.join(emptyDir, "readme.md"), "# empty\n");
  assert.equal(discovery.analyze(emptyDir, { maxFiles: 20 }).configuration_declaration.status, "absent");
});

test("PROOF 5 (COORD-657): the engine's own trusted config load is unchanged", () => {
  // The DISCOVERY boundary is the untrusted one. coord/paths.js loadProjectConfig
  // is the trusted loader every engine caller (cli.js, coord-init.js,
  // coord-init-wizard.js, contract-policy.js, agent-shim-validator.js) reaches
  // through for the engine's OWN workspace, and it must still work.
  const coordDir = path.resolve(__dirname, "..");
  const loaded = paths.loadProjectConfig(coordDir, { forceDefault: true });
  assert.ok(loaded && typeof loaded === "object", "the engine's own project.config.js no longer loads");
  assert.ok(loaded.repos && Object.keys(loaded.repos).length > 0);
  for (const [code, repo] of Object.entries(loaded.repos)) {
    assert.equal(typeof repo.path, "string", `repos.${code}.path is not a string`);
  }
  // The trusted validator still accepts the engine's own config unchanged.
  assert.doesNotThrow(() => paths.validateProjectConfig(loaded));

  // And the engine's OWN config is a valid static declaration too, so the
  // discovery reader agrees with the trusted loader rather than diverging.
  const declared = staticConfigDeclaration.readDeclaredConfig(path.join(coordDir, "project.config.js"));
  assert.equal(declared.status, "declared");
  assert.deepEqual(Object.keys(declared.declared.repos).sort(), Object.keys(loaded.repos).sort());
  for (const [code, repo] of Object.entries(loaded.repos)) {
    assert.equal(declared.declared.repos[code].path, repo.path);
    assert.equal(declared.declared.repos[code].integrationBranch, repo.integrationBranch);
  }
});

test("CLASS CHECK (COORD-657): the discovery path has no adopter-controlled dynamic load", () => {
  const source = fs.readFileSync(path.join(__dirname, "business-discovery.js"), "utf8");
  const specifiers = Array.from(source.matchAll(/\brequire\(([^)]*)\)/g)).map((match) => match[1].trim());
  assert.deepEqual(specifiers, [
    '"node:fs"',
    '"node:path"',
    '"./domain-discovery-adapters.js"',
    '"./evidence-authority.js"',
    '"./static-config-declaration.js"',
  ]);
  assert.equal(/require\.cache/.test(source), false, "discovery still manipulates the require cache");
  assert.equal(/require\.resolve/.test(source), false, "discovery still resolves a module path at runtime");

  // The static reader itself must never gain an execution escape hatch.
  const readerSource = fs.readFileSync(path.join(__dirname, "static-config-declaration.js"), "utf8");
  const readerBody = readerSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["node:vm", "eval(", "new Function", "child_process", "require.resolve"]) {
    assert.equal(readerBody.includes(forbidden), false, `static-config-declaration.js references ${forbidden}`);
  }
  assert.deepEqual(
    Array.from(readerBody.matchAll(/\brequire\(([^)]*)\)/g)).map((match) => match[1].trim()),
    ['"node:fs"', '"node:path"']
  );
});

// ---------------------------------------------------------------------------
// COORD-657 round 2 — repairs for the six reproduced review findings.
// ---------------------------------------------------------------------------

// F5 — the ticket requires a NETWORK/socket side effect in the no-execution
// proof, not only a file, an env var and a spawn. The listener below is the
// observation point: if the adopter config ran, it would connect.
test("PROOF 1b (COORD-657): an adopter config never opens a network socket", async () => {
  const net = require("node:net");
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push("connected");
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-socket-"));
    write(path.join(dir, "coord/project.config.js"), [
      "const net = require('node:net');",
      `const socket = net.connect(${port}, '127.0.0.1', () => { socket.write('exfiltrated'); });`,
      "module.exports = { repos: { B: { path: 'backend' } } };",
      "",
    ].join("\n"));
    write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");

    const report = discovery.analyze(dir, { maxFiles: 50 });
    // Give any connection the adopter config would have opened time to land.
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.deepEqual(connections, [], "the adopter config opened a network socket: it was executed");
    assert.equal(report.configuration_declaration.executed, false);
    assert.equal(report.configuration_declaration.status, "refused");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// F1 + F2 — a stat error is not evidence of absence, and the reader must not
// follow a path the adopter controls out of the workspace.
test("PROOF 6 (COORD-657): unreadable, symlinked and escaping configs are refused, never absent", () => {
  // F1 (as corrected): ONLY ENOENT from a no-follow open may mean "no config
  // here". ENOTDIR is an anomaly about the workspace, not benign absence.
  // Injected so the assertion does not depend on the runner's uid.
  for (const code of ["EACCES", "EIO", "ENOTDIR", "ENAMETOOLONG", "EPERM"]) {
    const failing = {
      openSync() {
        const error = new Error(`injected ${code}`);
        error.code = code;
        throw error;
      },
      statSync() { throw new Error("must not be reached"); },
      readFileSync() { throw new Error("must not be reached"); },
    };
    const result = staticConfigDeclaration.readDeclaredConfig("/nowhere/coord/project.config.js", {
      fs: failing,
      displayPath: "coord/project.config.js",
    });
    assert.equal(result.status, "refused", `${code} was classified as absent`);
    assert.equal(result.code, "config_unreadable");
    assert.match(result.message, new RegExp(`Refused to read coord/project\\.config\\.js: .*${code}`));
    assert.match(result.remediation, /Make coord\/project\.config\.js readable as a regular file/);
  }
  // ELOOP from a no-follow open is a symlink, classified as an untrusted path.
  const looping = {
    openSync() {
      const error = new Error("injected ELOOP");
      error.code = "ELOOP";
      throw error;
    },
  };
  const loopResult = staticConfigDeclaration.readDeclaredConfig("/nowhere/coord/project.config.js", { fs: looping, displayPath: "coord/project.config.js" });
  assert.equal(loopResult.code, "config_untrusted_path");
  // ONLY ENOENT from the no-follow open is honest absence.
  const missing = {
    openSync() {
      const error = new Error("injected ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  };
  assert.equal(staticConfigDeclaration.readDeclaredConfig("/nowhere/coord/project.config.js", { fs: missing }).status, "absent");

  // F2: a symlinked config pointing at an EXTERNAL declaration is refused, and
  // neither the workspace nor the symlink target is touched.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-outside-"));
  const externalCanary = "CANARY-EXTERNAL-2b71f0ae";
  const externalConfig = path.join(outside, "external.config.js");
  fs.writeFileSync(externalConfig, `module.exports = { repos: { X: { path: '${externalCanary}' } } };\n`);
  const externalBefore = fs.readFileSync(externalConfig, "utf8");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-symlink-"));
  fs.mkdirSync(path.join(dir, "coord"), { recursive: true });
  fs.symlinkSync(externalConfig, path.join(dir, "coord/project.config.js"));
  write(path.join(dir, "backend/src/api/orders.ts"), "export function route() {}\n");
  const before = treeDigest(dir);

  const report = discovery.analyze(dir, { maxFiles: 50 });
  const declaration = report.configuration_declaration;
  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_untrusted_path");
  assert.equal(declaration.message, "Refused to read coord/project.config.js: the path is a symbolic link.");
  assert.match(declaration.remediation, /Replace coord\/project\.config\.js with a regular file inside the scanned workspace/);
  // The external declaration never reached the artifact.
  assert.equal(JSON.stringify(report).includes(externalCanary), false, "an external declaration's value reached the artifact");
  assert.equal(declaration.surface, null);
  // Byte-identical afterwards — both the workspace and the symlink target.
  assert.equal(treeDigest(dir), before);
  assert.equal(fs.readFileSync(externalConfig, "utf8"), externalBefore);
  assert.equal(fs.lstatSync(path.join(dir, "coord/project.config.js")).isSymbolicLink(), true, "the symlink itself was altered");

  // A DANGLING symlink is a symlink, not an absent config.
  const dangling = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-dangling-"));
  fs.mkdirSync(path.join(dangling, "coord"), { recursive: true });
  fs.symlinkSync(path.join(outside, "does-not-exist.js"), path.join(dangling, "coord/project.config.js"));
  const danglingResult = discovery.analyze(dangling, { maxFiles: 20 }).configuration_declaration;
  assert.equal(danglingResult.status, "refused");
  assert.equal(danglingResult.code, "config_untrusted_path");

  // A config reached through a symlinked PARENT that escapes the workspace is
  // contained too. Since H5, the symlink is caught LEXICALLY — the parent chain
  // is inspected no-follow before anything is canonicalized — so this reports
  // the symlink directly rather than the weaker "resolves outside" message the
  // post-canonicalization cross-check would have produced.
  const escapeOutside = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-escape-src-"));
  fs.writeFileSync(path.join(escapeOutside, "project.config.js"), `module.exports = { repos: { Y: { path: '${externalCanary}' } } };\n`);
  const escape = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-escape-"));
  fs.symlinkSync(escapeOutside, path.join(escape, "coord"));
  const escapeResult = discovery.analyze(escape, { maxFiles: 20 }).configuration_declaration;
  assert.equal(escapeResult.status, "refused");
  assert.equal(escapeResult.code, "config_untrusted_path");
  assert.equal(escapeResult.message, "Refused to read coord/project.config.js: a parent directory of the path is a symbolic link.");
  assert.equal(JSON.stringify(escapeResult).includes(externalCanary), false);
});

// F3 (as corrected) — validation and content must be bound to the SAME
// no-follow handle. A check on a PATH and a read on the same PATH are two
// different objects when a concurrent writer can swap the entry.
function handleIo({ content, entryIno = 7, handleIno = 7, swappedContent = null }) {
  // Directory components of /workspace/coord are served as directories with
  // stable identities; the final component is the file under test.
  const dirs = new Map([
    ["/workspace", { dev: 1, ino: 100 }],
    ["/workspace/coord", { dev: 1, ino: 101 }],
  ]);
  const fds = new Map();
  let nextFd = 10;
  const io = {
    opened: 0,
    readFileSyncCalls: 0,
    realpathSync(target) {
      return target;
    },
    openSync(target) {
      const fd = nextFd;
      nextFd += 1;
      if (dirs.has(target)) {
        fds.set(fd, { kind: "dir", target });
      } else {
        io.opened += 1;
        fds.set(fd, { kind: "file", target });
      }
      return fd;
    },
    fstatSync(fd) {
      const entry = fds.get(fd);
      if (entry && entry.kind === "dir") {
        const identity = dirs.get(entry.target);
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ...identity };
      }
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 12, ino: handleIno, dev: 1 };
    },
    lstatSync(target) {
      if (dirs.has(target)) {
        const identity = dirs.get(target);
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, ...identity };
      }
      return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: 12, ino: entryIno, dev: 1 };
    },
    readSync(fd, buffer, offset, length) {
      const remaining = content.length - offset;
      if (remaining <= 0) return 0;
      const count = Math.min(length, remaining);
      buffer.write(content.slice(offset, offset + count), offset, count, "utf8");
      return count;
    },
    closeSync() {},
    readFileSync() {
      io.readFileSyncCalls += 1;
      // A path-based read resolves the path a SECOND time and therefore sees
      // the swapped entry. Reaching this at all is the defect.
      return swappedContent === null ? content : swappedContent;
    },
    statSync() {
      return { isFile: () => true, size: 12 };
    },
  };
  return io;
}

test("PROOF 7a (COORD-657): the size bound is enforced against the bytes actually read", () => {
  // The handle reports a tiny size but yields oversized content — the shape a
  // file growing after the fstat produces.
  const io = handleIo({ content: "x".repeat(staticConfigDeclaration.MAX_CONFIG_BYTES + 4096) });
  const result = staticConfigDeclaration.readDeclaredConfig("/workspace/coord/project.config.js", {
    fs: io,
    displayPath: "coord/project.config.js",
    containmentRoot: "/workspace",
  });
  assert.equal(io.opened, 1, "the file was not opened exactly once");
  assert.equal(io.readFileSyncCalls, 0, "a path-based read was used: the bound is not on the handle");
  assert.equal(result.status, "refused");
  assert.equal(result.code, "config_too_large");
  assert.match(result.message, /more than 524288 bytes/);
  assert.match(result.remediation, /Reduce coord\/project\.config\.js/);
});

test("PROOF 7b (COORD-657): an entry swapped after validation cannot be read", () => {
  const swapCanary = "CANARY-SWAPPED-6c40de11";
  // The validated entry declares B/backend; the SWAPPED entry a path-based read
  // would pick up declares the canary.
  const io = handleIo({
    content: "module.exports = { repos: { B: { path: 'backend' } } };\n",
    swappedContent: `module.exports = { repos: { B: { path: '${swapCanary}' } } };\n`,
  });
  const result = staticConfigDeclaration.readDeclaredConfig("/workspace/coord/project.config.js", {
    fs: io,
    displayPath: "coord/project.config.js",
    containmentRoot: "/workspace",
  });
  assert.equal(io.readFileSyncCalls, 0, "the swapped entry was read through the path");
  assert.equal(result.status, "declared");
  assert.equal(result.declared.repos.B.path, "backend");
  assert.equal(JSON.stringify(result).includes(swapCanary), false, "the swapped declaration reached the result");

  // And when the swap changes the object identity, the read is refused rather
  // than trusted: the handle is no longer the contained entry.
  const swapped = handleIo({
    content: "module.exports = { repos: { B: { path: 'backend' } } };\n",
    entryIno: 99,
    handleIno: 7,
  });
  const refused = staticConfigDeclaration.readDeclaredConfig("/workspace/coord/project.config.js", {
    fs: swapped,
    displayPath: "coord/project.config.js",
    containmentRoot: "/workspace",
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "config_untrusted_path");
  assert.equal(refused.message, "Refused to read coord/project.config.js: the path changed while it was being read.");
  assert.match(refused.remediation, /make sure nothing rewrites it while discovery runs/);
});

// F4 — a refusal under --json must leave stdout a single parseable document.
test("PROOF 8 (COORD-657): a refused --json run emits exactly one parseable JSON document on stdout", () => {
  const { dir } = sideEffectConfigRepo();
  const out = [];
  const err = [];
  const result = discovery.run(["--dir", dir, "--json", "--max-files", "100"], {
    cwd: dir,
    log: (line) => out.push(String(line)),
    logError: (line) => err.push(String(line)),
  });

  assert.equal(result.code, 1, "a refused run must still fail closed");
  const parsed = JSON.parse(out.join("\n"));
  assert.equal(parsed.kind, "concord.business_discovery.run");
  assert.equal(parsed.configuration_declaration.status, "refused");
  assert.equal(parsed.configuration_declaration.code, "config_unsupported_module_shape");
  // The operator-facing remediation is a FIELD, not interleaved prose.
  assert.match(parsed.configuration_declaration.remediation, /Rewrite coord\/project\.config\.js/);
  assert.ok(err.some((line) => line.startsWith("business-discovery: config_unsupported_module_shape:")), "the refusal was not reported on stderr");
  assert.equal(out.some((line) => line.startsWith("business-discovery:")), false, "prose was interleaved into the JSON stream");

  // --output mode writes only the document to the file, and nothing to stdout.
  const fileOut = [];
  const fileErr = [];
  const written = discovery.run(["--dir", dir, "--json", "--output", "coord/.runtime/discovery/run.json"], {
    cwd: dir,
    log: (line) => fileOut.push(String(line)),
    logError: (line) => fileErr.push(String(line)),
  });
  assert.equal(written.code, 1);
  assert.deepEqual(fileOut, []);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/discovery/run.json"), "utf8"));
  assert.equal(doc.configuration_declaration.status, "refused");
  assert.ok(fileErr.some((line) => line.startsWith("business-discovery: config_unsupported_module_shape:")));

  // The human-readable (non-JSON) lane still SHOWS the refusal in the body.
  const proseOut = [];
  const prose = discovery.run(["--dir", dir, "--max-files", "100"], {
    cwd: dir,
    log: (line) => proseOut.push(String(line)),
    logError: () => {},
  });
  assert.equal(prose.code, 1);
  assert.match(proseOut.join("\n"), /## Configuration Declaration/);
  assert.match(proseOut.join("\n"), /config_unsupported_module_shape/);
});

// ---------------------------------------------------------------------------
// COORD-657 round 3 — repairs for the three HIGH blockers found in be817d80.
// ---------------------------------------------------------------------------

// H1 — O_NOFOLLOW guards only the FINAL component. Canonicalizing the parent
// and then opening the ORIGINAL path string lets the kernel re-resolve the
// parent at open time, which is the check-then-act shape of F3 moved up one
// directory level. See ADR-0011 "Residual risk": Node exposes no openat, so the
// discipline is canonicalize -> record component identity -> open -> RE-VERIFY
// the chain BEFORE any byte is read.
test("PROOF 9 (COORD-657): a parent-directory swap between canonicalization and open is refused", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-parentswap-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-parentswap-out-"));
  fs.mkdirSync(path.join(workspace, "coord"));
  fs.writeFileSync(path.join(workspace, "coord/project.config.js"), "module.exports = { repos: { B: { path: 'backend' } } };\n");
  const externalConfig = path.join(outside, "project.config.js");
  fs.writeFileSync(externalConfig, "module.exports = { repos: { B: { path: 'PARENT-SWAP-CANARY' } } };\n");
  const externalBefore = fs.readFileSync(externalConfig, "utf8");

  // Swap `coord/` for a symlink to an external directory at the moment the
  // FILE is opened — after the parent has already been canonicalized.
  let swapped = false;
  const racingIo = new Proxy(fs, {
    get(target, key) {
      if (key === "openSync") {
        return (...args) => {
          const isFileOpen = String(args[0]).endsWith("project.config.js");
          if (isFileOpen && !swapped) {
            swapped = true;
            fs.renameSync(path.join(workspace, "coord"), path.join(workspace, "coord.original"));
            fs.symlinkSync(outside, path.join(workspace, "coord"));
          }
          return fs.openSync(...args);
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = staticConfigDeclaration.readDeclaredConfig(path.join(workspace, "coord/project.config.js"), {
    fs: racingIo,
    containmentRoot: workspace,
    displayPath: "coord/project.config.js",
  });

  assert.equal(swapped, true, "the parent swap never happened: the proof did not exercise the race");
  assert.equal(result.status, "refused");
  assert.equal(result.code, "config_untrusted_path");
  assert.equal(JSON.stringify(result).includes("PARENT-SWAP-CANARY"), false, "the external declaration reached the result");
  assert.match(result.remediation, /Replace coord\/project\.config\.js with a regular file inside the scanned workspace/);

  // The external target is byte-identical and untouched.
  assert.equal(fs.readFileSync(externalConfig, "utf8"), externalBefore);
  assert.equal(fs.readdirSync(outside).sort().join(","), "project.config.js");
  // The original workspace content survives unaltered under its moved parent.
  assert.equal(
    fs.readFileSync(path.join(workspace, "coord.original/project.config.js"), "utf8"),
    "module.exports = { repos: { B: { path: 'backend' } } };\n"
  );

  // A symlinked parent present BEFORE the read is refused for the same reason.
  const staticEscape = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-parentlink-"));
  fs.symlinkSync(outside, path.join(staticEscape, "coord"));
  const staticResult = staticConfigDeclaration.readDeclaredConfig(path.join(staticEscape, "coord/project.config.js"), {
    containmentRoot: staticEscape,
    displayPath: "coord/project.config.js",
  });
  assert.equal(staticResult.status, "refused");
  assert.equal(staticResult.code, "config_untrusted_path");
  assert.equal(JSON.stringify(staticResult).includes("PARENT-SWAP-CANARY"), false);
  assert.equal(fs.readFileSync(externalConfig, "utf8"), externalBefore);
});

// H2 — open() on a FIFO blocks until a writer appears. Discovery must never
// hang on an entry an adopter controls.
test("PROOF 10 (COORD-657): a FIFO or device node is refused without blocking and without being altered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-fifo-"));
  fs.mkdirSync(path.join(dir, "coord"));
  const fifoPath = path.join(dir, "coord/project.config.js");
  const made = require("node:child_process").spawnSync("mkfifo", [fifoPath]);
  assert.equal(made.status, 0, "mkfifo is unavailable: this proof cannot run");
  assert.equal(fs.lstatSync(fifoPath).isFIFO(), true);

  // No writer will ever appear. A blocking open would hang here forever; the
  // test itself is the timeout.
  const started = Date.now();
  const report = discovery.analyze(dir, { maxFiles: 20 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `discovery blocked on the FIFO for ${elapsed}ms`);
  const declaration = report.configuration_declaration;
  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_unreadable");
  assert.equal(declaration.message, "Refused to read coord/project.config.js: the path is not a regular file.");
  assert.equal(declaration.surface, null);

  // The FIFO is still a FIFO and nothing was written into it.
  assert.equal(fs.lstatSync(fifoPath).isFIFO(), true, "the FIFO entry was altered");
  assert.deepEqual(fs.readdirSync(path.join(dir, "coord")), ["project.config.js"]);

  // A device node is classified the same way, before any read. Injected
  // because creating a real device node requires root.
  const deviceIo = {
    realpathSync(target) {
      return target;
    },
    openSync() {
      return 9;
    },
    fstatSync(fd) {
      if (fd === 9) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 3 };
      return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, dev: 1, ino: 4 };
    },
    lstatSync() {
      return { isSymbolicLink: () => false, isDirectory: () => true, dev: 1, ino: 3 };
    },
    closeSync() {},
    readSync() {
      throw new Error("a device node must never be read");
    },
  };
  // The directory-chain opens return fd 9 (a directory); the file open returns
  // a character device, which must be refused before any read.
  let call = 0;
  deviceIo.openSync = () => {
    call += 1;
    return call <= 2 ? 9 : 10;
  };
  const deviceResult = staticConfigDeclaration.readDeclaredConfig("/workspace/coord/project.config.js", {
    fs: deviceIo,
    containmentRoot: "/workspace",
    displayPath: "coord/project.config.js",
  });
  assert.equal(deviceResult.status, "refused");
  assert.equal(deviceResult.code, "config_unreadable");
  assert.equal(deviceResult.message, "Refused to read coord/project.config.js: the path is not a regular file.");
});

// H3 — a platform that cannot express O_NOFOLLOW must FAIL CLOSED, not fall
// back to a following open. Admin authorized fail-closed.
test("PROOF 11 (COORD-657): a platform without O_NOFOLLOW fails closed instead of following links", () => {
  // The capability probe reports "cannot honour the constraint" when EITHER
  // required flag is missing. Both are required; neither is advisory.
  assert.equal(staticConfigDeclaration.openFlags({ constants: { O_RDONLY: 0 } }), null);
  assert.equal(staticConfigDeclaration.openFlags({ constants: {} }), null);
  assert.equal(staticConfigDeclaration.openFlags({ constants: { O_RDONLY: 0, O_NONBLOCK: 2048 } }), null, "missing O_NOFOLLOW must fail closed");
  assert.equal(staticConfigDeclaration.openFlags({ constants: { O_RDONLY: 0, O_NOFOLLOW: 131072 } }), null, "missing O_NONBLOCK must fail closed");
  assert.equal(typeof staticConfigDeclaration.openFlags(), "number");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-noflag-"));
  fs.mkdirSync(path.join(dir, "coord"));
  fs.writeFileSync(path.join(dir, "coord/project.config.js"), "module.exports = { repos: { B: { path: 'backend' } } };\n");
  const before = treeDigest(dir);

  const opened = [];
  const watchfulIo = new Proxy(fs, {
    get(target, key) {
      if (key === "openSync") {
        return (...args) => {
          opened.push(args[0]);
          return fs.openSync(...args);
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = staticConfigDeclaration.readDeclaredConfig(path.join(dir, "coord/project.config.js"), {
    fs: watchfulIo,
    containmentRoot: dir,
    displayPath: "coord/project.config.js",
    constants: { O_RDONLY: 0 }, // a platform with no O_NOFOLLOW
  });

  assert.equal(result.status, "refused");
  assert.equal(result.code, "config_platform_unsupported");
  assert.equal(result.message, "Refused to read coord/project.config.js: this platform cannot open a file both without following symbolic links and without blocking.");
  assert.match(result.remediation, /Concord fails closed rather than reading coord\/project\.config\.js through a link it cannot refuse or blocking forever on an entry it cannot decline/);
  // Fail CLOSED means nothing was opened at all, and the declaration is not read.
  assert.deepEqual(opened, [], "the reader opened a path on a platform it cannot guard");
  assert.equal(result.declared, undefined);
  assert.equal(treeDigest(dir), before);
});

// F10 — `undefined` is an identifier reference. The code and ADR-0011 must agree.
test("PROOF 12 (COORD-657): `undefined` is refused as an identifier, not silently dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-undefined-"));
  write(path.join(dir, "coord/project.config.js"), "module.exports = { coordTicketPrefix: undefined, repos: {} };\n");
  const declaration = discovery.analyze(dir, { maxFiles: 20 }).configuration_declaration;
  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_not_declarative");
  assert.equal(
    declaration.message,
    "Refused to read coord/project.config.js without executing it: found an identifier reference `undefined` at line 1, column 39."
  );

  // And a nested/array position is refused identically — no path drops it.
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-undefined2-"));
  write(path.join(nested, "coord/project.config.js"), "module.exports = { repos: { B: { path: 'backend', origin: undefined } } };\n");
  assert.equal(discovery.analyze(nested, { maxFiles: 20 }).configuration_declaration.code, "config_not_declarative");
});

// C2 (round 4) — O_NONBLOCK is REQUIRED, not advisory. ADR-0011 claims every
// open uses it, so a platform that cannot express it must fail closed exactly
// as one that cannot express O_NOFOLLOW. The earlier revision OR-ed it in only
// when present, which meant a platform without it silently got a BLOCKING open
// while the ADR still promised otherwise.
test("PROOF 11b (COORD-657): a platform without O_NONBLOCK fails closed and opens nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-noblock-"));
  fs.mkdirSync(path.join(dir, "coord"));
  fs.writeFileSync(path.join(dir, "coord/project.config.js"), "module.exports = { repos: { B: { path: 'backend' } } };\n");
  const before = treeDigest(dir);

  const opened = [];
  const watchfulIo = new Proxy(fs, {
    get(target, key) {
      if (key === "openSync") {
        return (...args) => {
          opened.push(args[0]);
          return fs.openSync(...args);
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // O_NOFOLLOW is present; O_NONBLOCK is not. That must still fail closed.
  const result = staticConfigDeclaration.readDeclaredConfig(path.join(dir, "coord/project.config.js"), {
    fs: watchfulIo,
    containmentRoot: dir,
    displayPath: "coord/project.config.js",
    constants: { O_RDONLY: 0, O_NOFOLLOW: fs.constants.O_NOFOLLOW, O_DIRECTORY: fs.constants.O_DIRECTORY },
  });

  assert.equal(result.status, "refused");
  assert.equal(result.code, "config_platform_unsupported");
  assert.equal(
    result.message,
    "Refused to read coord/project.config.js: this platform cannot open a file both without following symbolic links and without blocking."
  );
  assert.match(result.remediation, /blocking forever on an entry it cannot decline/);

  // ZERO opens — not "it refused after opening". Nothing was opened at all,
  // including the directory-chain walk.
  assert.deepEqual(opened, [], "the reader opened a path on a platform it cannot guard");
  assert.equal(result.declared, undefined);
  assert.equal(result.surface, undefined);
  assert.equal(treeDigest(dir), before);

  // And the real platform (which has both flags) is unaffected: the same
  // workspace reads normally.
  const healthy = staticConfigDeclaration.readDeclaredConfig(path.join(dir, "coord/project.config.js"), {
    containmentRoot: dir,
    displayPath: "coord/project.config.js",
  });
  assert.equal(healthy.status, "declared");
  assert.equal(healthy.declared.repos.B.path, "backend");
});

// ---------------------------------------------------------------------------
// COORD-657 round 5 — the parent chain is inspected LEXICALLY, no-follow.
//
// ONE root cause behind H4, H5 and M6: the reader canonicalized before it
// inspected. `realpathSync` FOLLOWS symlinks, so the adopter-controlled parent
// was resolved away before any check saw it — the symlink guard could not fire
// by construction, and a dangling parent surfaced as ENOENT (i.e. "absent").
// 21/21 passed throughout, which is the evidence these cases were UNCOVERED.
//
// Required classification, asserted below:
//   component missing entirely      -> absent
//   component present but a symlink -> config_untrusted_path (dangling or not)
//   component present, not a dir    -> config_unreadable
//   component unreadable otherwise  -> config_unreadable
// ---------------------------------------------------------------------------

// Snapshot of an entry AS IT IS ON DISK, following nothing: type, link target,
// content and identity. Used to prove nothing was altered by a refusal.
function entrySnapshot(target) {
  const stat = fs.lstatSync(target);
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  return JSON.stringify({
    kind,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    link: kind === "symlink" ? fs.readlinkSync(target) : null,
    content: kind === "file" ? fs.readFileSync(target, "utf8") : null,
  });
}

const PARENT_CANARY = "PARENT-CHAIN-CANARY-51ab7d3e";

test("PROOF 13 (COORD-657 H4): a DANGLING parent symlink is refused, never reported absent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-h4-"));
  const missingTarget = path.join(workspace, "missing-dir");
  const parent = path.join(workspace, "coord");
  fs.symlinkSync(missingTarget, parent);
  write(path.join(workspace, "backend/src/api/orders.ts"), "export function route() {}\n");

  const parentBefore = entrySnapshot(parent);
  const treeBefore = treeDigest(workspace);

  const declaration = discovery.analyze(workspace, { maxFiles: 20 }).configuration_declaration;

  // `coord` EXISTS — it is a symlink that does not resolve. Absence would be a
  // fail-open, and the ENOENT-only rule was always "ENOENT from a NO-FOLLOW
  // check", which an lstat answers immediately.
  assert.notEqual(declaration.status, "absent", "a dangling parent symlink was reported as absent");
  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_untrusted_path");
  assert.equal(declaration.message, "Refused to read coord/project.config.js: a parent directory of the path is a symbolic link.");
  assert.equal(declaration.surface, null);

  // Byte-for-byte unchanged: the symlink itself, its (still missing) target,
  // and the workspace tree.
  assert.equal(entrySnapshot(parent), parentBefore, "the parent symlink was altered");
  assert.equal(fs.existsSync(missingTarget), false, "the dangling target was created");
  assert.equal(treeDigest(workspace), treeBefore);
});

test("PROOF 14 (COORD-657 H5): an IN-WORKSPACE symlinked parent is refused, not followed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-h5-"));
  // The target is INSIDE the workspace and the declaration under it is
  // perfectly valid, so containment-by-realpath cannot catch this: only
  // inspecting the lexical component does.
  const realParent = path.join(workspace, "real-coord");
  fs.mkdirSync(realParent);
  const realConfig = path.join(realParent, "project.config.js");
  fs.writeFileSync(realConfig, `module.exports = { repos: { B: { path: '${PARENT_CANARY}' } } };\n`);
  const parent = path.join(workspace, "coord");
  fs.symlinkSync(realParent, parent);
  write(path.join(workspace, "backend/src/api/orders.ts"), "export function route() {}\n");

  const parentBefore = entrySnapshot(parent);
  const realParentBefore = entrySnapshot(realParent);
  const realConfigBefore = entrySnapshot(realConfig);
  const treeBefore = treeDigest(workspace);

  const report = discovery.analyze(workspace, { maxFiles: 20 });
  const declaration = report.configuration_declaration;

  assert.equal(declaration.status, "refused");
  assert.equal(declaration.code, "config_untrusted_path");
  assert.equal(declaration.message, "Refused to read coord/project.config.js: a parent directory of the path is a symbolic link.");
  assert.equal(declaration.surface, null);
  // Nothing behind the symlink was read or emitted.
  assert.equal(JSON.stringify(report).includes(PARENT_CANARY), false, "a declaration behind a symlinked parent reached the artifact");
  assert.deepEqual(report.project.repos, ["root"]);

  // Byte-for-byte unchanged: the symlink, its target directory, the declaration
  // under it, and the workspace tree.
  assert.equal(entrySnapshot(parent), parentBefore, "the parent symlink was altered");
  assert.equal(entrySnapshot(realParent), realParentBefore, "the symlink target directory was altered");
  assert.equal(entrySnapshot(realConfig), realConfigBefore, "the declaration behind the symlink was altered");
  assert.equal(fs.readlinkSync(parent), realParent);
  assert.equal(treeDigest(workspace), treeBefore);
});

test("PROOF 15 (COORD-657 M6): a non-directory parent is config_unreadable, not a symlink claim", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-m6-"));
  const parent = path.join(workspace, "coord");
  fs.writeFileSync(parent, "not a directory\n");
  write(path.join(workspace, "backend/src/api/orders.ts"), "export function route() {}\n");

  const parentBefore = entrySnapshot(parent);
  const treeBefore = treeDigest(workspace);

  const declaration = discovery.analyze(workspace, { maxFiles: 20 }).configuration_declaration;

  assert.equal(declaration.status, "refused");
  // NOT config_untrusted_path, and the message must not claim a symlink.
  assert.equal(declaration.code, "config_unreadable");
  assert.equal(declaration.message, "Refused to read coord/project.config.js: a parent component of the path is not a directory.");
  assert.equal(/symbolic link/.test(declaration.message), false, "a regular file was misreported as a symbolic link");
  assert.match(declaration.remediation, /Make coord\/project\.config\.js readable as a regular file/);

  assert.equal(entrySnapshot(parent), parentBefore, "the regular file at the parent path was altered");
  assert.equal(fs.readFileSync(parent, "utf8"), "not a directory\n");
  assert.equal(treeDigest(workspace), treeBefore);
});

test("PROOF 16 (COORD-657): only a genuinely MISSING component is absent", () => {
  // Nothing at `coord` at all — the one honest absence.
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-missing-"));
  write(path.join(missing, "backend/src/api/orders.ts"), "export function route() {}\n");
  const missingDeclaration = discovery.analyze(missing, { maxFiles: 20 }).configuration_declaration;
  assert.equal(missingDeclaration.status, "absent");
  assert.equal(missingDeclaration.code, null);

  // `coord` exists as a real directory but the config itself is missing: also
  // absent, via the FINAL-component ENOENT discrimination that must not regress.
  const noConfig = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-noconfig-"));
  fs.mkdirSync(path.join(noConfig, "coord"));
  assert.equal(discovery.analyze(noConfig, { maxFiles: 20 }).configuration_declaration.status, "absent");

  // A deeper missing component is absent too, and does not become a refusal.
  const deep = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-deep-"));
  const deepResult = staticConfigDeclaration.readDeclaredConfig(path.join(deep, "a/b/c/project.config.js"), {
    containmentRoot: deep,
    displayPath: "coord/project.config.js",
  });
  assert.equal(deepResult.status, "absent");

  // And a component that is unreadable for some OTHER reason is a refusal, not
  // absence. Injected so the assertion does not depend on the runner's uid.
  const failing = {
    lstatSync() {
      const error = new Error("injected EACCES");
      error.code = "EACCES";
      throw error;
    },
  };
  const unreadable = staticConfigDeclaration.readDeclaredConfig("/workspace/coord/project.config.js", {
    fs: failing,
    containmentRoot: "/workspace",
    displayPath: "coord/project.config.js",
  });
  assert.equal(unreadable.status, "refused");
  assert.equal(unreadable.code, "config_unreadable");
  assert.match(unreadable.message, /a parent directory could not be inspected \(EACCES\)/);
});

// ---------------------------------------------------------------------------
// COORD-657 round 6 — the scanned-root exemption, pinned by test.
//
// The scanned root is the operator-supplied trust anchor, so unlike every
// component beneath it, the root alias is NOT refused for being a symlink
// (human admin accepted this: refusing it would break legitimate aliased
// checkouts without strengthening protection below that boundary). A
// security-relevant exemption must not remain an untested claim, so it is
// pinned here in two parts.
//
// The exemption says the root alias itself is not inspected for symlink-ness.
// It does NOT say the root may CHANGE IDENTITY mid-read — Part B proves the
// dev/ino re-verification actually fires on that, rather than asserting it
// would.
// ---------------------------------------------------------------------------

// Expectations are stated HERE, in the fixture, not computed by the code under
// test — same discipline as PROOF 3.
const ROOT_ALIAS_EXPECTATIONS = Object.freeze({
  repos: Object.freeze({
    B: Object.freeze({ path: "backend", integrationBranch: "release/aliased" }),
  }),
  tracks: Object.freeze(["development", "devops"]),
  coordTicketPrefix: "ALIAS",
});
const ROOT_RETARGET_CANARY = "ROOT-RETARGET-CANARY-9e14c7b2";

function aliasedRootFixture() {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "business-discovery-rootalias-"));
  // The alias's real target: an ordinary, legitimate checkout.
  const original = path.join(container, "real-checkout");
  write(path.join(original, "coord/project.config.js"), [
    "module.exports = {",
    "  coordTicketPrefix: 'ALIAS',",
    "  repos: {",
    "    B: { path: 'backend', integrationBranch: 'release/aliased' }",
    "  },",
    "  tracks: {",
    "    development: { gateProc: 'test', defaultLane: 'default' },",
    "    devops: { gateProc: 'infra', defaultLane: 'full' }",
    "  }",
    "};",
    "",
  ].join("\n"));
  write(path.join(original, "backend/package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  write(path.join(original, "backend/src/api/orders.ts"), "export function route() {}\n");

  // A SECOND checkout the alias could be retargeted at, holding a canary.
  const retarget = path.join(container, "hostile-checkout");
  write(path.join(retarget, "coord/project.config.js"), `module.exports = { repos: { B: { path: '${ROOT_RETARGET_CANARY}' } } };\n`);
  write(path.join(retarget, "backend/src/api/orders.ts"), "export function route() {}\n");

  const alias = path.join(container, "scan-root");
  fs.symlinkSync(original, alias);
  return { container, original, retarget, alias };
}

test("PROOF 17A (COORD-657): a STABLE symlinked scan root still discovers its metadata by value", () => {
  const { alias } = aliasedRootFixture();

  // The scan root IS a symlink, and that is allowed by the accepted exemption.
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true, "the fixture root is not actually a symlink");

  const report = discovery.analyze(alias, { maxFiles: 100 });
  const declaration = report.configuration_declaration;

  assert.equal(declaration.status, "declared", "a legitimately aliased checkout was refused");
  assert.equal(declaration.path, "coord/project.config.js");
  assert.equal(declaration.code, null);

  // BY VALUE, against the expectations stated in the fixture above.
  assert.deepEqual(Object.keys(declaration.surface.repos).sort(), Object.keys(ROOT_ALIAS_EXPECTATIONS.repos).sort());
  for (const [code, expected] of Object.entries(ROOT_ALIAS_EXPECTATIONS.repos)) {
    assert.equal(declaration.surface.repos[code].path, expected.path);
    assert.equal(declaration.surface.repos[code].integrationBranch, expected.integrationBranch);
  }
  assert.deepEqual(declaration.surface.tracks, ROOT_ALIAS_EXPECTATIONS.tracks);
  assert.equal(declaration.surface.coord_ticket_prefix, ROOT_ALIAS_EXPECTATIONS.coordTicketPrefix);

  // And the same values reach the artifact's records.
  assert.deepEqual(report.project.repos, ["B"]);
  assert.ok(report.records.some((record) => record.predicate === "repo_path" && record.subject === "B" && record.object === "backend"));
  assert.ok(report.records.some((record) => record.predicate === "integration_branch" && record.object === "release/aliased"));
  for (const track of ROOT_ALIAS_EXPECTATIONS.tracks) {
    assert.ok(report.records.some((record) => record.predicate === "governance_track" && record.object === track), `no governance_track record for ${track}`);
  }
  assert.ok(report.records.some((record) => record.predicate === "coord_ticket_prefix" && record.object === "ALIAS"));
});

test("PROOF 17B (COORD-657): RETARGETING the root alias during the open is refused before any content read", () => {
  const { container, original, retarget, alias } = aliasedRootFixture();
  const originalConfig = path.join(original, "coord/project.config.js");
  const retargetConfig = path.join(retarget, "coord/project.config.js");

  const originalConfigBefore = entrySnapshot(originalConfig);
  const retargetConfigBefore = entrySnapshot(retargetConfig);
  const originalDirBefore = entrySnapshot(path.join(original, "coord"));
  const retargetDirBefore = entrySnapshot(path.join(retarget, "coord"));
  // treeDigest walks with dirent types, so the alias itself is skipped and the
  // two real checkouts are captured.
  const treeBefore = treeDigest(container);

  let retargeted = false;
  let readSyncCalls = 0;
  const racingIo = new Proxy(fs, {
    get(target, key) {
      if (key === "openSync") {
        return (...args) => {
          // Swing the ROOT ALIAS at the moment the config file is opened —
          // after the chain identities were recorded through the old target.
          if (!retargeted && String(args[0]).endsWith("project.config.js")) {
            retargeted = true;
            fs.unlinkSync(alias);
            fs.symlinkSync(retarget, alias);
          }
          return fs.openSync(...args);
        };
      }
      if (key === "readSync") {
        return (...args) => {
          readSyncCalls += 1;
          return fs.readSync(...args);
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = staticConfigDeclaration.readDeclaredConfig(path.join(alias, "coord/project.config.js"), {
    fs: racingIo,
    containmentRoot: alias,
    displayPath: "coord/project.config.js",
  });

  assert.equal(retargeted, true, "the root alias was never retargeted: the proof did not exercise the race");
  assert.equal(fs.readlinkSync(alias), retarget, "the retarget did not stick");

  // The dev/ino re-verification must FIRE — proven, not assumed.
  assert.equal(result.status, "refused");
  assert.equal(result.code, "config_untrusted_path");
  // Named exactly, so this pins WHICH mechanism fired rather than accepting any
  // refusal: the recorded chain identity no longer matches after the open.
  assert.equal(result.message, "Refused to read coord/project.config.js: a parent directory changed while the path was being opened.");
  assert.match(result.remediation, /make sure nothing rewrites it while discovery runs/);

  // Refused BEFORE any content read. Zero reads, not merely a refusal.
  assert.equal(readSyncCalls, 0, `content was read from the retargeted root (${readSyncCalls} readSync calls)`);
  assert.equal(result.declared, undefined);
  assert.equal(JSON.stringify(result).includes(ROOT_RETARGET_CANARY), false, "the canary behind the retargeted root reached the result");

  // BOTH targets byte-for-byte unchanged, no-follow snapshotted, plus the tree.
  assert.equal(entrySnapshot(originalConfig), originalConfigBefore, "the original target's declaration was altered");
  assert.equal(entrySnapshot(retargetConfig), retargetConfigBefore, "the retarget's declaration was altered");
  assert.equal(entrySnapshot(path.join(original, "coord")), originalDirBefore, "the original target's coord directory was altered");
  assert.equal(entrySnapshot(path.join(retarget, "coord")), retargetDirBefore, "the retarget's coord directory was altered");
  assert.equal(treeDigest(container), treeBefore, "the workspace tree was altered");
});
