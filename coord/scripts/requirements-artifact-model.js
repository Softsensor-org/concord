#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ARTIFACTS = [
  {
    id: "requirement_registry",
    kind: "concord.requirements.registry",
    path: "coord/.runtime/requirements/registry.json",
    source_inputs: ["PRD/URS/SRS markdown", "external source pointers", "import manifest"],
    source_citation_required: true,
    content_hash_required: true,
    public_safe: "pointer_or_scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "baseline_presence_gate",
    kind: "concord.requirements.baseline_presence_gate",
    path: "coord/.runtime/requirements/baseline-presence.json",
    source_inputs: ["canonical requirements file", "external requirements source manifest", "track/profile"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "pointer_or_scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "traceability_matrix",
    kind: "concord.requirements.traceability_matrix",
    path: "coord/.runtime/requirements/traceability.json",
    source_inputs: ["registry", "board", "plan records"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "generated_conformance_audit",
    kind: "concord.requirements.conformance_audit",
    path: "coord/rendered/requirements-conformance.md",
    source_inputs: ["registry", "board", "plan records", "traceability matrix", "evidence policy report", "optional PRD/URS/SRS source hygiene"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "workflow_alignment_audit",
    kind: "concord.requirements.persona_workflow_audit",
    path: "coord/.runtime/requirements/workflow-alignment.json",
    source_inputs: ["persona/workflow matrix", "screen index", "board"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "workflow_urs_alignment_audit",
    kind: "concord.requirements.workflow_alignment_audit",
    path: "coord/.runtime/requirements/workflow-urs-alignment.json",
    source_inputs: ["workflow inventory", "registry"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "multi_agent_review_pack",
    kind: "concord.requirements.multi_agent_review_pack",
    path: "coord/.runtime/requirements/review-pack.json",
    source_inputs: ["requirements sources", "board", "screen index", "donor reuse matrix"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "requirements_cockpit_model",
    kind: "concord.requirements.cockpit_model",
    path: "coord/.runtime/requirements/cockpit-model.json",
    source_inputs: ["requirements protocol artifacts", "coord UI contract", "artifact presence"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "domain_boundary_report",
    kind: "concord.requirements.domain_boundary_report",
    path: "coord/.runtime/requirements/domain-boundary-report.json",
    source_inputs: ["domain boundary manifest", "glossary", "authority boundaries", "source evidence", "investigation workflows"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "generalization_audit",
    kind: "concord.requirements.generalization_audit",
    path: "coord/.runtime/requirements/generalization-audit-report.json",
    source_inputs: ["generalization audit findings", "donor provenance", "scrub status", "requirements", "follow-up tickets"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "surface_conformance",
    kind: "concord.requirements.surface_conformance",
    path: "coord/.runtime/requirements/surface-conformance.json",
    source_inputs: ["surface requirement matrix", "registry", "board", "plan records", "requirements conformance audit"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "donor_reuse_matrix",
    kind: "concord.requirements.donor_reuse_matrix_report",
    path: "coord/.runtime/requirements/donor-reuse-report.json",
    source_inputs: ["donor reuse matrix"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "private_pointer_only",
    generated_at_policy: "metadata_only",
  },
  {
    id: "donor_to_product_analysis",
    kind: "concord.requirements.donor_to_product_analysis",
    path: "coord/.runtime/requirements/donor-derived-analysis.json",
    source_inputs: ["donor source inventory"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "private_pointer_only",
    generated_at_policy: "metadata_only",
  },
  {
    id: "sequencing_plan",
    kind: "concord.requirements.sequencing_plan",
    path: "coord/.runtime/requirements/sequencing-plan.json",
    source_inputs: ["registry", "criticality", "dependencies", "inspection blockers"],
    source_citation_required: true,
    content_hash_required: false,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
  {
    id: "stale_impact_report",
    kind: "concord.requirements.stale_impact_report",
    path: "coord/.runtime/requirements/stale-impact.json",
    source_inputs: ["registry block hashes", "board", "plan records", "screen index"],
    source_citation_required: true,
    content_hash_required: true,
    public_safe: "scrubbed",
    generated_at_policy: "metadata_only",
  },
];

function artifactManifest() {
  return {
    kind: "concord.requirements.artifact_model",
    schema_version: 1,
    deterministic_rules: [
      "Sort arrays by stable ids before writing.",
      "Treat generated_at_utc as metadata only; tests should pin or ignore it for stable comparisons.",
      "Cite canonical source paths, anchors, hashes, board ids, and plan ids instead of copying private source bodies.",
      "Write generated artifacts only to explicit runtime/rendered paths.",
    ],
    public_cut_rules: [
      "No customer, donor, patient, secret, credential, or private document body in public/community cuts.",
      "Use private_pointer_only sources when an artifact must cite sensitive material.",
      "Candidate or inferred links remain visibly unconfirmed.",
    ],
    artifacts: ARTIFACTS,
  };
}

function validateArtifactEnvelope(artifact, options = {}) {
  const findings = [];
  const manifest = artifactManifest();
  const known = new Map(manifest.artifacts.map((item) => [item.kind, item]));
  const contract = known.get(String(artifact.kind || ""));
  if (!contract) {
    findings.push({
      severity: "fail",
      code: "unknown-artifact-kind",
      message: `Artifact kind ${artifact.kind || "<missing>"} is not in the requirements artifact model.`,
    });
    return { ok: false, findings };
  }
  const source = artifact.source || artifact.sources || null;
  if (contract.source_citation_required && !source) {
    findings.push({
      severity: "fail",
      code: "missing-source-citation",
      artifact_kind: artifact.kind,
      message: "Artifact is missing source/source citations.",
    });
  }
  if (contract.content_hash_required) {
    const serialized = JSON.stringify(artifact);
    if (!/sha256:/i.test(serialized)) {
      findings.push({
        severity: "fail",
        code: "missing-content-hash",
        artifact_kind: artifact.kind,
        message: "Artifact requires source/content hashes but no sha256: marker was found.",
      });
    }
  }
  const text = JSON.stringify(artifact).toLowerCase();
  for (const marker of ["password", "secret_key", "api_key", "patient_name", "customer_name"]) {
    if (text.includes(marker)) {
      findings.push({
        severity: "fail",
        code: "public-cut-sensitive-marker",
        artifact_kind: artifact.kind,
        marker,
        message: `Artifact contains sensitive marker ${marker}; public cuts must use pointers or scrubbed values.`,
      });
    }
  }
  if (options.requirePublicSafe && contract.public_safe === "private_pointer_only" && !text.includes("private://")) {
    findings.push({
      severity: "warning",
      code: "private-pointer-recommended",
      artifact_kind: artifact.kind,
      message: "This artifact type should use private:// pointers for donor or sensitive source material.",
    });
  }
  return { ok: findings.every((finding) => finding.severity !== "fail"), findings };
}

function renderMarkdown(manifest = artifactManifest()) {
  const lines = [];
  lines.push("# Requirements Artifact Model");
  lines.push("");
  lines.push("## Artifacts");
  for (const artifact of manifest.artifacts) {
    lines.push(`- ${artifact.id}: ${artifact.kind} -> ${artifact.path}`);
  }
  lines.push("");
  lines.push("## Deterministic Rules");
  for (const rule of manifest.deterministic_rules) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("## Public-Cut Rules");
  for (const rule of manifest.public_cut_rules) lines.push(`- ${rule}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, output: null, validate: null, public: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--public") {
      options.public = true;
      continue;
    }
    if (["--output", "--validate"].includes(arg)) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[key] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-artifacts: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-artifacts [--json] [--output <path>] [--validate <artifact.json>] [--public]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  let report = artifactManifest();
  let code = 0;
  if (parsed.options.validate) {
    const artifactPath = path.resolve(cwd, parsed.options.validate);
    if (!fsImpl.existsSync(artifactPath)) {
      log(`requirements-artifacts: artifact not found: ${parsed.options.validate}`);
      return { code: 1 };
    }
    let artifact;
    try {
      artifact = JSON.parse(fsImpl.readFileSync(artifactPath, "utf8"));
    } catch (err) {
      log(`requirements-artifacts: malformed JSON in artifact ${parsed.options.validate}: ${err.message}`);
      return { code: 1 };
    }
    const validation = validateArtifactEnvelope(artifact, { requirePublicSafe: parsed.options.public });
    report = { kind: "concord.requirements.artifact_validation", schema_version: 1, artifact: parsed.options.validate, ...validation };
    code = validation.ok ? 0 : 2;
  }
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code, report };
}

module.exports = {
  ARTIFACTS,
  artifactManifest,
  renderMarkdown,
  run,
  validateArtifactEnvelope,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
