#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STRICT_TRACKS = new Set(["enterprise", "regulated", "gxp", "audit"]);
const VALID_AUTHORITIES = new Set(["authoritative", "supporting", "legacy", "donor", "candidate"]);
const STABLE_ID_RE = /\b(?:REQ|URS|PRD|SRS|SEC|NFR|DONOR-REQ)-\d+[A-Z]?\b/g;

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function hasSourceDeclaration(content) {
  return /(?:imported source documents|authoritative source|source documents|source declaration|external requirements source|private:\/\/|https?:\/\/)/i.test(content || "");
}

function hasStubSignals(content) {
  const text = String(content || "").toLowerCase();
  return [
    "replace this stub",
    "todo:",
    "tbd",
    "placeholder requirement",
    "placeholder requirements",
    "sample-only requirements status",
    "example requirement",
    "lorem ipsum",
  ].some((signal) => text.includes(signal));
}

function findStableIds(content) {
  return uniqueSorted(String(content || "").match(STABLE_ID_RE) || []);
}

function normalizeSources(manifest) {
  if (!manifest) return [];
  if (Array.isArray(manifest.sources)) return manifest.sources;
  if (Array.isArray(manifest.authoritative_sources)) return manifest.authoritative_sources;
  if (Array.isArray(manifest.external_sources)) return manifest.external_sources;
  return [];
}

function validateExternalSources(manifest) {
  const sources = normalizeSources(manifest);
  const findings = [];
  const normalized = sources.map((source, index) => {
    const authority = String(source.authority || source.role || "").toLowerCase();
    const ref = source.ref || source.path || source.url || source.private_ref || null;
    const contentHash = source.content_hash || source.block_hash || source.hash || null;
    const stableIdPolicy = source.stable_id_policy || source.requirement_id_pattern || source.id_pattern || null;
    const row = {
      id: source.id || `source-${index + 1}`,
      authority,
      ref,
      content_hash: contentHash,
      version: source.version || null,
      stable_id_policy: stableIdPolicy,
      fetched: false,
    };
    if (!ref) {
      findings.push({
        severity: "fail",
        code: "external-source-missing-ref",
        source_id: row.id,
        message: "External requirements source declaration must include ref/path/url/private_ref.",
      });
    }
    if (!VALID_AUTHORITIES.has(authority)) {
      findings.push({
        severity: "fail",
        code: "external-source-unsupported-authority",
        source_id: row.id,
        message: "External source authority must be authoritative, supporting, legacy, donor, or candidate.",
      });
    }
    if (authority === "authoritative" && !contentHash && !row.version) {
      findings.push({
        severity: "fail",
        code: "authoritative-source-missing-hash-or-version",
        source_id: row.id,
        message: "Authoritative external requirements sources need a content hash or immutable version.",
      });
    }
    if (authority === "authoritative" && !stableIdPolicy) {
      findings.push({
        severity: "fail",
        code: "authoritative-source-missing-stable-id-policy",
        source_id: row.id,
        message: "Authoritative external requirements sources must declare the stable requirement ID policy.",
      });
    }
    return row;
  });
  return { sources: normalized, findings };
}

function trackPolicy(track, sampleOnly) {
  const normalized = String(track || "product-engineering").toLowerCase();
  if (sampleOnly) {
    return {
      track: normalized,
      strict: false,
      missing: "warning",
      stub: "warning",
      weak: "warning",
      externalInvalid: "warning",
      reason: "sample-only repos must be explicit but are not blocked by requirements assurance gates",
    };
  }
  const strict = STRICT_TRACKS.has(normalized);
  return {
    track: normalized,
    strict,
    missing: strict ? "fail" : "warning",
    stub: strict ? "fail" : "warning",
    weak: strict ? "fail" : "warning",
    externalInvalid: strict ? "fail" : "warning",
    reason: strict ? "enterprise/regulated tracks fail closed on weak baselines" : "pilot/product tracks warn so adoption can start",
  };
}

function buildFinding(policy, code, message, extra = {}) {
  const severity = policy[extra.policyKey || "weak"] || "warning";
  const { policyKey, ...rest } = extra;
  return { severity, code, message, ...rest };
}

function classifyBaseline({ content, manifest, requirementsPath }, options = {}) {
  const stableIds = findStableIds(content || "");
  const sourceDeclared = content ? hasSourceDeclaration(content) : false;
  const stub = content ? hasStubSignals(content) : false;
  const sampleOnly = Boolean(options.sampleOnly || (manifest && manifest.sample_only));
  const external = validateExternalSources(manifest);
  const authoritativeSources = external.sources.filter((source) => source.authority === "authoritative");
  const policy = trackPolicy(options.track, sampleOnly);
  const findings = [];

  let baselineState = "missing";
  if (authoritativeSources.length > 0) baselineState = "external_declared";
  if (content) {
    if (stub) baselineState = "stub";
    else if (stableIds.length === 0 || !sourceDeclared) baselineState = "weak";
    else baselineState = "present";
  }
  if (sampleOnly && baselineState === "missing") baselineState = "sample_only";

  if (!content && authoritativeSources.length === 0) {
    findings.push(buildFinding(policy, "missing-requirements-baseline", "No canonical requirements file or authoritative external source declaration was found.", { policyKey: "missing" }));
  }
  if (stub && content) {
    findings.push(buildFinding(policy, "stub-requirements-baseline", "Requirements baseline looks like a stub, placeholder, TODO, or sample-only document.", { policyKey: "stub", path: requirementsPath }));
  }
  if (content && stableIds.length === 0) {
    findings.push(buildFinding(policy, "missing-stable-requirement-ids", "Requirements baseline has no stable REQ/URS/PRD/SRS/SEC/NFR identifiers.", { policyKey: "weak", path: requirementsPath }));
  }
  if (content && !sourceDeclared) {
    findings.push(buildFinding(policy, "missing-source-declaration", "Requirements baseline does not declare canonical/imported/external source documents.", { policyKey: "weak", path: requirementsPath }));
  }
  for (const finding of external.findings) {
    findings.push({ ...finding, severity: policy.externalInvalid });
  }
  if (!content && authoritativeSources.length > 0 && external.findings.length === 0) {
    findings.push({
      severity: "info",
      code: "external-baseline-declared",
      message: "Authoritative requirements are declared by pointer/hash; Concord will not fetch or copy private bodies.",
    });
  }
  if (sampleOnly) {
    findings.push({
      severity: "info",
      code: "sample-only-requirements-status",
      message: "Repo explicitly declares sample-only requirements status; do not claim full requirements assurance.",
    });
  }

  const ok = !findings.some((finding) => finding.severity === "fail");
  return {
    kind: "concord.requirements.baseline_presence_gate",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      requirements_path: requirementsPath,
      external_manifest: options.manifestPath || null,
      external_fetching: false,
    },
    track_policy: policy,
    baseline_state: baselineState,
    requirements_file: {
      exists: Boolean(content),
      path: requirementsPath,
      stable_requirement_ids: stableIds,
      stable_requirement_id_count: stableIds.length,
      source_declaration_present: sourceDeclared,
      stub_signals_present: Boolean(content && stub),
    },
    external_sources: external.sources,
    findings,
    summary: {
      ok,
      baseline_state: baselineState,
      findings: findings.length,
      fail: findings.filter((finding) => finding.severity === "fail").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      stable_requirement_ids: stableIds.length,
      authoritative_external_sources: authoritativeSources.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Baseline Presence Gate");
  lines.push("");
  lines.push(`Track: ${report.track_policy.track}`);
  lines.push(`Baseline state: ${report.baseline_state}`);
  lines.push(`Stable requirement IDs: ${report.summary.stable_requirement_ids}`);
  lines.push(`Authoritative external sources: ${report.summary.authoritative_external_sources}`);
  lines.push(`Verdict: ${report.summary.ok ? "ok" : "fail"}`);
  lines.push("");
  lines.push("## Findings");
  if (report.findings.length === 0) lines.push("None.");
  for (const finding of report.findings) {
    lines.push(`- ${finding.severity}: ${finding.code} - ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: ".",
    requirements: "coord/product/REQUIREMENTS.md",
    manifest: "coord/.runtime/requirements/baseline-sources.json",
    track: "product-engineering",
    output: null,
    json: false,
    sampleOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--sample-only") {
      options.sampleOnly = true;
      continue;
    }
    if (["--dir", "--requirements", "--manifest", "--track", "--output"].includes(arg)) {
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
    log(`requirements-baseline-gate: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-baseline-gate [--requirements <path>] [--manifest <json>] [--track <product-engineering|enterprise|regulated|community>] [--sample-only] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);
  const requirementsPath = path.resolve(root, parsed.options.requirements);
  const manifestPath = path.resolve(root, parsed.options.manifest);
  const manifest = readJsonIfExists(manifestPath);
  const report = classifyBaseline(
    {
      content: readTextIfExists(requirementsPath),
      manifest,
      requirementsPath: parsed.options.requirements,
    },
    {
      track: parsed.options.track,
      sampleOnly: parsed.options.sampleOnly,
      manifestPath: fs.existsSync(manifestPath) ? parsed.options.manifest : null,
    }
  );
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: report.summary.ok ? 0 : 2, report };
}

module.exports = {
  classifyBaseline,
  findStableIds,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
