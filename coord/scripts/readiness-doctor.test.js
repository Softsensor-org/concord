"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createReadinessDoctor = require("./readiness-doctor.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coord-readiness-test-"));
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

test("readiness doctor reports a governed repo shape without mutating files", () => {
  const root = tmpRoot();
  write(root, "package.json", JSON.stringify({
    scripts: { test: "node --test", build: "vite build" },
  }, null, 2));
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');
  write(root, "coord/project.config.js", "module.exports = {};\n");
  write(root, "coord/product/REQUIREMENTS.md", "# Requirements\n\nREQ-001: Do the thing.\n");
  write(root, "AGENTS.md", "Canonical policy: `coord/GOVERNANCE.md`\nRule precedence.\n");
  write(root, "CODEX.md", "See `coord/GOVERNANCE.md`.\n");
  write(root, "CLAUDE.md", "See `coord/GOVERNANCE.md`.\n");
  write(root, "GEMINI.md", "See `coord/GOVERNANCE.md`.\n");

  const before = Array.from(fs.readdirSync(root)).sort();
  const doctor = createReadinessDoctor({ log: () => {}, cwd: () => root });
  const report = doctor.scan(root);
  const after = Array.from(fs.readdirSync(root)).sort();

  assert.deepEqual(after, before, "scan must not create files");
  assert.equal(report.read_only, true);
  assert.equal(report.coord_setup.governance, true);
  assert.equal(report.coord_setup.board, true);
  assert.ok(report.package_managers.includes("npm"));
  assert.deepEqual(report.commands.test.map((c) => c.command), ["npm test"]);
  assert.equal(report.recommended_profile, "product-engineering");
  assert.equal(report.recommended_profile_details.id, "product-engineering");
  assert.ok(report.recommended_profile_details.required_evidence.includes("landing_evidence"));
  assert.equal(report.recommended_phase, "pilot");
  assert.equal(report.recommended_phase_details.id, "pilot");
  assert.ok(report.recommended_phase_details.required_evidence.includes("runtime_or_user_evidence"));
  assert.equal(report.pilot_blockers.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor consumes setup decisions from init wizard output", () => {
  const root = tmpRoot();
  write(root, "package.json", JSON.stringify({
    scripts: { test: "node --test" },
  }, null, 2));
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');
  write(root, "coord/project.config.js", "module.exports = {};\n");
  write(root, "coord/setup.decisions.json", JSON.stringify({
    kind: "concord.setup_decisions",
    schema_version: 1,
    generated_by: "coord init --wizard",
    decisions: {
      adoption_profile: { id: "enterprise", label: "Enterprise", default_lane: "full" },
      governance_phase: { id: "production", label: "Production" },
      tracks: ["development", "devops"],
      gates: ["B: npm test", "release/deploy receipt"],
    },
    detected_shape: { shape: "multi-repo", signals: ["node"] },
    next_steps: ["run coord doctor --dir ."],
  }, null, 2));

  const report = createReadinessDoctor({ log: () => {}, cwd: () => root }).scan(root);
  assert.equal(report.setup_decisions.present, true);
  assert.equal(report.setup_decisions.valid, true);
  assert.equal(report.recommended_profile, "enterprise");
  assert.equal(report.recommended_phase, "production");
  assert.deepEqual(report.setup_decisions.decisions.tracks, ["development", "devops"]);

  const md = createReadinessDoctor({ log: () => {}, cwd: () => root }).renderMarkdown(report);
  assert.match(md, /## Setup Decisions/);
  assert.match(md, /profile: enterprise/);
  assert.match(md, /phase: production/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor reports invalid setup decision artifacts", () => {
  const root = tmpRoot();
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');
  write(root, "coord/setup.decisions.json", "{not json");

  const report = createReadinessDoctor({ log: () => {}, cwd: () => root }).scan(root);
  assert.equal(report.setup_decisions.present, true);
  assert.equal(report.setup_decisions.valid, false);
  assert.ok(report.findings.some((finding) => finding.code === "invalid-setup-decisions"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor surfaces missing governance and shim findings", () => {
  const root = tmpRoot();
  write(root, "package.json", JSON.stringify({ scripts: { build: "vite build" } }, null, 2));
  write(root, "AGENTS.md", "local notes only\n");

  const report = createReadinessDoctor({ log: () => {}, cwd: () => root }).scan(root);
  const codes = report.findings.map((f) => f.code);

  assert.ok(codes.includes("missing-governance"));
  assert.ok(codes.includes("missing-board"));
  assert.ok(codes.includes("missing-requirements"));
  assert.ok(codes.includes("missing-agent-shims"));
  assert.ok(codes.includes("shim-canonical-pointer-missing"));
  assert.ok(codes.includes("missing-test-command"));
  assert.ok(report.pilot_blockers.includes("missing-governance"));
  assert.ok(report.suggested_tickets.includes("COORD-255"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor run emits markdown by default and json with --json", () => {
  const root = tmpRoot();
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');

  const md = capture();
  const mdResult = createReadinessDoctor({ log: md.log, cwd: () => root }).run([]);
  assert.equal(mdResult.code, 0);
  assert.match(md.text(), /# Concord Readiness Report/);
  assert.match(md.text(), /Recommended profile:/);
  assert.match(md.text(), /Recommended phase:/);

  const json = capture();
  const jsonResult = createReadinessDoctor({ log: json.log, cwd: () => root }).run(["--json"]);
  assert.equal(jsonResult.code, 0);
  const parsed = JSON.parse(json.text());
  assert.equal(parsed.kind, "coord-readiness-report");
  assert.equal(parsed.read_only, true);
  assert.ok(parsed.recommended_phase);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor writes an artifact with --output", () => {
  const root = tmpRoot();
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');

  const cap = capture();
  const result = createReadinessDoctor({ log: cap.log, cwd: () => root }).run([
    "--json",
    "--output",
    "coord/.runtime/readiness-report.json",
  ]);
  assert.equal(result.code, 0);
  assert.match(cap.text(), /wrote coord\/\.runtime\/readiness-report\.json/);
  const reportPath = path.join(root, "coord/.runtime/readiness-report.json");
  assert.ok(fs.existsSync(reportPath));
  const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(parsed.kind, "coord-readiness-report");
  assert.equal(parsed.read_only, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("product coord CLI registers and dispatches doctor", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry.doctor);
  assert.equal(typeof registry.doctor.run, "function");

  const root = tmpRoot();
  write(root, "coord/GOVERNANCE.md", "# Governance\n");
  write(root, "coord/board/tasks.json", '{"version":1,"sections":[]}\n');
  const cap = capture();
  const result = dispatch(["doctor", "--dir", root], { log: cap.log });
  assert.equal(result.code, 0);
  assert.match(cap.text(), /Concord Readiness Report/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readiness doctor rejects unexpected args without writing", () => {
  const root = tmpRoot();
  const cap = capture();
  const result = createReadinessDoctor({ log: cap.log, cwd: () => root }).run(["--bad"]);
  assert.equal(result.code, 1);
  assert.match(cap.text(), /unexpected argument/);
  assert.deepEqual(fs.readdirSync(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
