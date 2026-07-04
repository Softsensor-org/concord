"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const baselineGate = require("./requirements-baseline-gate.js");
const { buildRegistry, dispatch } = require("./coord-cli.js");

function capture() {
  const lines = [];
  return { log: (line) => lines.push(String(line)), text: () => lines.join("\n") };
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-baseline-"));
  fs.mkdirSync(path.join(dir, "coord/product"), { recursive: true });
  fs.mkdirSync(path.join(dir, "coord/.runtime/requirements"), { recursive: true });
  return dir;
}

test("classifyBaseline accepts a present baseline with stable IDs and source declaration", () => {
  const report = baselineGate.classifyBaseline({
    requirementsPath: "coord/product/REQUIREMENTS.md",
    content: [
      "# Requirements",
      "",
      "Imported source documents:",
      "- private://prd/product-v1 sha256:abc",
      "",
      "### REQ-001: Repo-local governance",
      "Acceptance criteria:",
      "- Keep governance in the repo.",
    ].join("\n"),
  }, { track: "enterprise" });
  assert.equal(report.baseline_state, "present");
  assert.equal(report.summary.ok, true);
  assert.deepEqual(report.requirements_file.stable_requirement_ids, ["REQ-001"]);
});

test("classifyBaseline fails closed for enterprise stub baselines", () => {
  const report = baselineGate.classifyBaseline({
    requirementsPath: "coord/product/REQUIREMENTS.md",
    content: "# Requirements\n\nReplace this stub with your product requirements.\n",
  }, { track: "enterprise" });
  assert.equal(report.baseline_state, "stub");
  assert.equal(report.summary.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "stub-requirements-baseline" && finding.severity === "fail"));
});

test("classifyBaseline warns for weak pilot baselines without failing adoption", () => {
  const report = baselineGate.classifyBaseline({
    requirementsPath: "coord/product/REQUIREMENTS.md",
    content: [
      "# Requirements",
      "",
      "This product has requirements prose but no authoritative source declaration or stable IDs yet.",
      "The team is still importing the original PRD.",
    ].join("\n"),
  }, { track: "pilot" });
  assert.equal(report.baseline_state, "weak");
  assert.equal(report.summary.ok, true);
  assert.ok(report.findings.every((finding) => finding.severity !== "fail"));
});

test("classifyBaseline supports authoritative external baselines by pointer without fetching", () => {
  const report = baselineGate.classifyBaseline({
    requirementsPath: "coord/product/REQUIREMENTS.md",
    content: null,
    manifest: {
      sources: [
        {
          id: "URS-V1",
          authority: "authoritative",
          private_ref: "private://eqms/urs-v1",
          content_hash: "sha256:abc",
          stable_id_policy: "URS-*",
        },
      ],
    },
  }, { track: "regulated", manifestPath: "coord/.runtime/requirements/baseline-sources.json" });
  assert.equal(report.baseline_state, "external_declared");
  assert.equal(report.summary.ok, true);
  assert.equal(report.external_sources[0].fetched, false);
  assert.ok(report.findings.some((finding) => finding.code === "external-baseline-declared"));
});

test("classifyBaseline rejects unsupported authoritative external references on strict tracks", () => {
  const report = baselineGate.classifyBaseline({
    requirementsPath: "coord/product/REQUIREMENTS.md",
    content: null,
    manifest: {
      sources: [
        { id: "JIRA", authority: "authoritative", url: "https://example.invalid/jira/epic" },
      ],
    },
  }, { track: "regulated", manifestPath: "coord/.runtime/requirements/baseline-sources.json" });
  assert.equal(report.summary.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "authoritative-source-missing-hash-or-version"));
  assert.ok(report.findings.some((finding) => finding.code === "authoritative-source-missing-stable-id-policy"));
});

test("requirements-baseline-gate command writes explicit derived output", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "coord/product/REQUIREMENTS.md"), [
    "# Requirements",
    "",
    "Imported source documents:",
    "- coord/product/PRD.md",
    "",
    "### REQ-001: Governed execution",
    "Acceptance criteria: tickets cite proof.",
  ].join("\n"));
  const result = baselineGate.run(["--dir", dir, "--track", "enterprise", "--json", "--output", "coord/.runtime/requirements/baseline-presence.json"], { cwd: dir, log: () => {} });
  assert.equal(result.code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "coord/.runtime/requirements/baseline-presence.json"), "utf8"));
  assert.equal(written.kind, "concord.requirements.baseline_presence_gate");
  assert.equal(written.summary.ok, true);
});

test("product CLI routes requirements-baseline-gate and umbrella baseline verb", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.equal(typeof registry["requirements-baseline-gate"].run, "function");

  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "coord/.runtime/requirements/baseline-sources.json"), JSON.stringify({
    sources: [
      {
        id: "PRD",
        authority: "authoritative",
        ref: "private://prd/current",
        content_hash: "sha256:def",
        stable_id_policy: "PRD-*",
      },
    ],
  }));
  const cap = capture();
  const result = dispatch(["requirements", "baseline", "--dir", dir, "--track", "enterprise", "--json"], { cwd: dir, log: cap.log });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(cap.text());
  assert.equal(parsed.kind, "concord.requirements.baseline_presence_gate");
  assert.equal(parsed.baseline_state, "external_declared");
});
