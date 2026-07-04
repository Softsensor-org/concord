"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const artifacts = require("./requirements-artifact-model.js");

test("artifactManifest defines the required rebuildable artifacts", () => {
  const manifest = artifacts.artifactManifest();
  assert.equal(manifest.kind, "concord.requirements.artifact_model");
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.id), [
    "requirement_registry",
    "baseline_presence_gate",
    "traceability_matrix",
    "generated_conformance_audit",
    "workflow_alignment_audit",
    "workflow_urs_alignment_audit",
    "multi_agent_review_pack",
    "requirements_cockpit_model",
    "domain_boundary_report",
    "generalization_audit",
    "surface_conformance",
    "donor_reuse_matrix",
    "donor_to_product_analysis",
    "sequencing_plan",
    "stale_impact_report",
  ]);
  assert.ok(manifest.public_cut_rules.some((rule) => /No customer/.test(rule)));
});

test("validateArtifactEnvelope fails unknown kinds and missing required hashes", () => {
  const unknown = artifacts.validateArtifactEnvelope({ kind: "unknown" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.findings[0].code, "unknown-artifact-kind");

  const registry = artifacts.validateArtifactEnvelope({
    kind: "concord.requirements.registry",
    source: { path: "coord/product/REQUIREMENTS.md" },
  });
  assert.equal(registry.ok, false);
  assert.equal(registry.findings[0].code, "missing-content-hash");
});

test("validateArtifactEnvelope accepts source-cited hashed registry", () => {
  const result = artifacts.validateArtifactEnvelope({
    kind: "concord.requirements.registry",
    source: { path: "coord/product/REQUIREMENTS.md", block_hash: "sha256:abc" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test("validateArtifactEnvelope flags public-cut sensitive markers", () => {
  const result = artifacts.validateArtifactEnvelope({
    kind: "concord.requirements.traceability_matrix",
    source: { board: "coord/board/tasks.json" },
    notes: "contains secret_key marker",
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].code, "public-cut-sensitive-marker");
});

test("run emits manifest json and validates artifact files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-artifacts-"));
  const artifactPath = path.join(dir, "registry.json");
  fs.writeFileSync(artifactPath, JSON.stringify({
    kind: "concord.requirements.registry",
    source: { path: "coord/product/REQUIREMENTS.md", block_hash: "sha256:abc" },
  }));
  const out = [];
  const manifestResult = artifacts.run(["--json"], { cwd: dir, log: (line) => out.push(line) });
  assert.equal(manifestResult.code, 0);
  assert.equal(JSON.parse(out.join("\n")).artifacts.length, 15);

  const validateResult = artifacts.run(["--validate", "registry.json", "--json"], { cwd: dir, log: () => {} });
  assert.equal(validateResult.code, 0);
});
