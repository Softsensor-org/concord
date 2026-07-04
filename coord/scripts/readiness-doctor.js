"use strict";

// COORD-253: product-facing repo adoption/readiness doctor.
//
// This is intentionally separate from `gov doctor`. `gov doctor` diagnoses the
// health of the live governance state. This module answers the adoption question:
// what kind of repo is this, what governance artifacts are present, what is
// missing before pilot / enterprise use, and which Concord tickets should guide
// the next step?
//
// Safety model: READ-ONLY. No writes, no board mutation, no journal mutation, no
// subprocess execution. The result is advisory evidence.

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const createAdoptionProfileRegistry = require("./adoption-profile-registry.js");
const phaseModel = require("./governance-phase-model.js");

const DEFAULT_SUGGESTED_TICKETS = Object.freeze({
  readinessDoctor: "COORD-253",
  profiles: "COORD-254",
  existingRepoQuickstart: "COORD-255",
  shimDrift: "COORD-256",
  commandRegistry: "COORD-257",
  phaseAware: "COORD-258",
  explorationPromotion: "COORD-259",
});

const SETUP_DECISIONS_REL = "coord/setup.decisions.json";

function createReadinessDoctor(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());
  const profileRegistry =
    deps.profileRegistry || createAdoptionProfileRegistry({ strict: deps.strictProfiles !== false });

  function exists(root, rel) {
    return fs.existsSync(path.join(root, rel));
  }

  function readText(root, rel) {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  }

  function parseJson(root, rel) {
    const raw = readText(root, rel);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function detectSetupDecisions(root) {
    const raw = readText(root, SETUP_DECISIONS_REL);
    if (!raw) {
      return {
        path: SETUP_DECISIONS_REL,
        present: false,
        valid: false,
        decisions: null,
        errors: [],
      };
    }
    try {
      const parsed = JSON.parse(raw);
      const errors = [];
      if (parsed.kind !== "concord.setup_decisions") errors.push("kind must be concord.setup_decisions");
      if (parsed.schema_version !== 1) errors.push("schema_version must be 1");
      if (!parsed.decisions || typeof parsed.decisions !== "object") errors.push("decisions object is required");
      return {
        path: SETUP_DECISIONS_REL,
        present: true,
        valid: errors.length === 0,
        decisions: parsed.decisions || null,
        detected_shape: parsed.detected_shape || null,
        next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : [],
        errors,
      };
    } catch (err) {
      return {
        path: SETUP_DECISIONS_REL,
        present: true,
        valid: false,
        decisions: null,
        errors: [`invalid JSON: ${err.message}`],
      };
    }
  }

  function parseArgs(args = []) {
    const opts = { dir: null, json: false, output: null, help: false, unknown: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--json") opts.json = true;
      else if (arg === "-h" || arg === "--help") opts.help = true;
      else if (arg === "--dir") {
        opts.dir = args[i + 1] || null;
        i += 1;
      } else if (arg === "--output") {
        opts.output = args[i + 1] || null;
        i += 1;
      } else if (arg.startsWith("--dir=")) {
        opts.dir = arg.slice("--dir=".length);
      } else if (arg.startsWith("--output=")) {
        opts.output = arg.slice("--output=".length);
      } else {
        opts.unknown.push(arg);
      }
    }
    return opts;
  }

  function detectPackageManagers(root) {
    const managers = [];
    if (exists(root, "package.json")) managers.push("npm");
    if (exists(root, "pnpm-lock.yaml")) managers.push("pnpm");
    if (exists(root, "yarn.lock")) managers.push("yarn");
    if (exists(root, "package-lock.json")) managers.push("npm-lock");
    if (exists(root, "pyproject.toml")) managers.push("python");
    if (exists(root, "requirements.txt")) managers.push("pip");
    if (exists(root, "Cargo.toml")) managers.push("cargo");
    if (exists(root, "go.mod")) managers.push("go");
    return managers;
  }

  function detectPackageScripts(root) {
    const pkg = parseJson(root, "package.json");
    const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object"
      ? pkg.scripts
      : {};
    const pick = (names) => names.filter((name) => scripts[name]).map((name) => ({
      name,
      command: `npm run ${name}`,
    }));
    return {
      test: scripts.test ? [{ name: "test", command: "npm test" }] : pick(["test:unit", "test:e2e", "test:ci"]),
      build: pick(["build", "typecheck", "lint"]),
      deploy: pick(["deploy", "release"]),
      all: Object.keys(scripts).sort(),
    };
  }

  function detectAppSignals(root) {
    const signals = [];
    const checks = [
      ["frontend", "frontend"],
      ["backend", "backend"],
      ["coord", "coord"],
      ["src", "src"],
      ["app", "app"],
      ["pages", "next-pages"],
      ["public", "static-public"],
      ["api", "api"],
      [".github/workflows", "github-actions"],
      ["Dockerfile", "docker"],
      ["docker-compose.yml", "compose"],
      ["helm", "helm"],
      ["k8s", "kubernetes"],
      ["terraform", "terraform"],
    ];
    for (const [rel, label] of checks) {
      if (exists(root, rel)) signals.push(label);
    }
    return signals.sort();
  }

  function detectRequirements(root) {
    const candidates = [
      "coord/product/REQUIREMENTS.md",
      "product/REQUIREMENTS.md",
      "REQUIREMENTS.md",
      "docs/REQUIREMENTS.md",
      "PRD.md",
      "URS.md",
      "docs/PRD.md",
      "docs/URS.md",
    ];
    return candidates
      .filter((rel) => exists(root, rel))
      .map((rel) => {
        const raw = readText(root, rel) || "";
        const stableIds = (raw.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []).length;
        const stub = /Replace this stub|TODO|TBD/i.test(raw) && raw.length < 1500;
        return { path: rel, bytes: raw.length, stable_id_mentions: stableIds, likely_stub: stub };
      });
  }

  function detectCoordSetup(root) {
    return {
      governance: exists(root, "coord/GOVERNANCE.md"),
      board: exists(root, "coord/board/tasks.json"),
      projectConfig: exists(root, "coord/project.config.js"),
      productRequirements: exists(root, "coord/product/REQUIREMENTS.md"),
      productArchitecture: exists(root, "coord/product/ARCHITECTURE.md"),
      promptsDir: exists(root, "coord/prompts/tickets"),
    };
  }

  function detectShims(root) {
    const files = ["AGENTS.md", "coord/AGENTS.md", "CODEX.md", "CLAUDE.md", "GEMINI.md"];
    return files.map((rel) => {
      const raw = readText(root, rel);
      return {
        path: rel,
        present: raw != null,
        canonical_pointer: raw ? /coord\/GOVERNANCE\.md/.test(raw) : false,
        precedence_mentions: raw ? /Rule precedence|precedence/i.test(raw) : false,
      };
    });
  }

  function buildFindings(report) {
    const findings = [];
    const add = (severity, code, message, evidence, suggestedTicket) => {
      findings.push({ severity, code, message, evidence, suggested_ticket: suggestedTicket || null });
    };

    if (!report.coord_setup.governance) {
      add("blocker", "missing-governance", "Missing coord/GOVERNANCE.md.", ["coord/GOVERNANCE.md"], DEFAULT_SUGGESTED_TICKETS.existingRepoQuickstart);
    }
    if (!report.coord_setup.board) {
      add("blocker", "missing-board", "Missing coord/board/tasks.json.", ["coord/board/tasks.json"], DEFAULT_SUGGESTED_TICKETS.existingRepoQuickstart);
    }
    if (!report.coord_setup.projectConfig) {
      add("warning", "missing-project-config", "Missing coord/project.config.js; repo mapping may be implicit or incomplete.", ["coord/project.config.js"], DEFAULT_SUGGESTED_TICKETS.existingRepoQuickstart);
    }
    if (report.requirements.length === 0) {
      add("warning", "missing-requirements", "No PRD/URS/requirements source detected.", ["coord/product/REQUIREMENTS.md", "PRD.md", "URS.md"], "COORD-242");
    } else if (report.requirements.some((r) => r.likely_stub)) {
      add("warning", "stub-requirements", "A detected requirements source looks like a stub.", report.requirements.map((r) => r.path), "COORD-242");
    }
    const missingShims = report.agent_shims.filter((s) => !s.present).map((s) => s.path);
    if (missingShims.length > 0) {
      add("warning", "missing-agent-shims", "Some agent instruction shims are missing.", missingShims, DEFAULT_SUGGESTED_TICKETS.shimDrift);
    }
    const driftRisk = report.agent_shims.filter((s) => s.present && !s.canonical_pointer).map((s) => s.path);
    if (driftRisk.length > 0) {
      add("warning", "shim-canonical-pointer-missing", "Some shims do not point to coord/GOVERNANCE.md.", driftRisk, DEFAULT_SUGGESTED_TICKETS.shimDrift);
    }
    if (report.commands.test.length === 0) {
      add("warning", "missing-test-command", "No package test command detected.", ["package.json scripts.test"], DEFAULT_SUGGESTED_TICKETS.readinessDoctor);
    }
    if (report.app_signals.includes("github-actions")) {
      add("info", "github-actions-present", "GitHub Actions workflows detected; verify whether local gates or CI are the intended authority.", [".github/workflows"], DEFAULT_SUGGESTED_TICKETS.existingRepoQuickstart);
    }
    if (report.setup_decisions.present && !report.setup_decisions.valid) {
      add("warning", "invalid-setup-decisions", "coord/setup.decisions.json exists but is not a valid setup decision artifact.", [SETUP_DECISIONS_REL].concat(report.setup_decisions.errors || []), "COORD-260");
    }
    return findings;
  }

  function recommendProfileId(report) {
    const setupProfile = report.setup_decisions &&
      report.setup_decisions.valid &&
      report.setup_decisions.decisions &&
      report.setup_decisions.decisions.adoption_profile &&
      report.setup_decisions.decisions.adoption_profile.id;
    if (setupProfile && profileRegistry.hasProfile(setupProfile)) return setupProfile;
    if (report.app_signals.includes("kubernetes") || report.app_signals.includes("terraform")) {
      return "enterprise";
    }
    if (report.requirements.some((r) => /URS/i.test(r.path) || r.stable_id_mentions > 5)) {
      return "regulated";
    }
    if (report.coord_setup.board && report.coord_setup.governance) {
      return "product-engineering";
    }
    if (report.package_managers.length > 0) {
      return "solo-dev";
    }
    return "exploration";
  }

  function recommendProfile(report) {
    const requested = recommendProfileId(report);
    return profileRegistry.resolveProfile(requested);
  }

  function recommendPhase(report) {
    const setupPhase = report.setup_decisions &&
      report.setup_decisions.valid &&
      report.setup_decisions.decisions &&
      report.setup_decisions.decisions.governance_phase &&
      report.setup_decisions.decisions.governance_phase.id;
    if (setupPhase && phaseModel.phaseDetails(setupPhase).id === setupPhase) return setupPhase;
    return phaseModel.recommendPhase(report);
  }

  function summarizeBlockers(findings, severity) {
    return findings.filter((f) => f.severity === severity).map((f) => f.code);
  }

  function scan(targetRoot) {
    const root = path.resolve(targetRoot);
    const report = {
      kind: "coord-readiness-report",
      schema_version: 1,
      target_root: root,
      read_only: true,
      package_managers: detectPackageManagers(root),
      app_signals: detectAppSignals(root),
      commands: detectPackageScripts(root),
      requirements: detectRequirements(root),
      coord_setup: detectCoordSetup(root),
      agent_shims: detectShims(root),
      setup_decisions: detectSetupDecisions(root),
      findings: [],
      recommended_profile: "unknown",
      recommended_profile_details: null,
      recommended_phase: "unknown",
      recommended_phase_details: null,
      pilot_blockers: [],
      enterprise_blockers: [],
      suggested_tickets: [],
    };
    report.findings = buildFindings(report);
    const profile = recommendProfile(report);
    report.recommended_profile = profile ? profile.id : "unknown";
    report.recommended_profile_details = profile
      ? {
          id: profile.id,
          label: profile.label,
          default_lane: profile.default_lane,
          recommended_tracks: profile.recommended_tracks,
          required_evidence: profile.required_evidence,
          closeout_expectations: profile.closeout_expectations,
          ui_labels: profile.ui_labels,
        }
      : null;
    report.recommended_phase = recommendPhase(report);
    const phase = phaseModel.phaseDetails(report.recommended_phase);
    report.recommended_phase_details = {
      id: phase.id,
      label: phase.label,
      intent: phase.intent,
      required_evidence: phase.required_evidence,
      closeout_expectations: phase.closeout_expectations,
      minimum_profile: phase.minimum_profile,
    };
    report.pilot_blockers = summarizeBlockers(report.findings, "blocker");
    report.enterprise_blockers = report.findings
      .filter((f) => f.severity === "blocker" || f.severity === "warning")
      .map((f) => f.code);
    report.suggested_tickets = Array.from(new Set(
      report.findings.map((f) => f.suggested_ticket).filter(Boolean)
    )).sort();
    return report;
  }

  function renderMarkdown(report) {
    const lines = [];
    lines.push("# Concord Readiness Report");
    lines.push("");
    lines.push(`Target: ${report.target_root}`);
    lines.push(`Read-only: ${report.read_only ? "yes" : "no"}`);
    lines.push(`Recommended profile: ${report.recommended_profile}`);
    lines.push(`Recommended phase: ${report.recommended_phase}`);
    if (report.recommended_profile_details) {
      lines.push(`Default lane: ${report.recommended_profile_details.default_lane}`);
      lines.push(`Recommended tracks: ${report.recommended_profile_details.recommended_tracks.join(", ")}`);
    }
    lines.push("");
    lines.push("## Detected Shape");
    lines.push(`- Package managers: ${report.package_managers.join(", ") || "none detected"}`);
    lines.push(`- App signals: ${report.app_signals.join(", ") || "none detected"}`);
    lines.push(`- Test commands: ${report.commands.test.map((c) => c.command).join(", ") || "none detected"}`);
    lines.push(`- Build commands: ${report.commands.build.map((c) => c.command).join(", ") || "none detected"}`);
    lines.push("");
    lines.push("## Governance Setup");
    for (const [key, value] of Object.entries(report.coord_setup)) {
      lines.push(`- ${key}: ${value ? "present" : "missing"}`);
    }
    lines.push("");
    lines.push("## Setup Decisions");
    if (!report.setup_decisions.present) {
      lines.push(`- ${report.setup_decisions.path}: missing`);
    } else if (!report.setup_decisions.valid) {
      lines.push(`- ${report.setup_decisions.path}: invalid (${report.setup_decisions.errors.join("; ")})`);
    } else {
      const decisions = report.setup_decisions.decisions || {};
      const profile = decisions.adoption_profile || {};
      const phase = decisions.governance_phase || {};
      lines.push(`- ${report.setup_decisions.path}: present`);
      lines.push(`- profile: ${profile.id || "unknown"}`);
      lines.push(`- phase: ${phase.id || "unknown"}`);
      lines.push(`- tracks: ${(decisions.tracks || []).join(", ") || "none"}`);
      lines.push(`- gates: ${(decisions.gates || []).join(", ") || "none"}`);
    }
    lines.push("");
    lines.push("## Requirements Sources");
    if (report.requirements.length === 0) {
      lines.push("- none detected");
    } else {
      for (const req of report.requirements) {
        lines.push(`- ${req.path} (${req.bytes} bytes, stable ids: ${req.stable_id_mentions}, stub: ${req.likely_stub ? "yes" : "no"})`);
      }
    }
    lines.push("");
    lines.push("## Agent Shims");
    for (const shim of report.agent_shims) {
      lines.push(`- ${shim.path}: ${shim.present ? "present" : "missing"}${shim.present ? `, canonical pointer: ${shim.canonical_pointer ? "yes" : "no"}` : ""}`);
    }
    lines.push("");
    lines.push("## Findings");
    if (report.findings.length === 0) {
      lines.push("- No findings.");
    } else {
      for (const finding of report.findings) {
        lines.push(`- [${finding.severity}] ${finding.code}: ${finding.message}${finding.suggested_ticket ? ` (${finding.suggested_ticket})` : ""}`);
      }
    }
    lines.push("");
    lines.push(`Pilot blockers: ${report.pilot_blockers.join(", ") || "none"}`);
    lines.push(`Enterprise blockers: ${report.enterprise_blockers.join(", ") || "none"}`);
    lines.push(`Suggested tickets: ${report.suggested_tickets.join(", ") || "none"}`);
    return `${lines.join("\n")}\n`;
  }

  function run(args = []) {
    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { ok: true, code: 0 };
    }
    if (opts.unknown.length > 0) {
      log(`coord doctor: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run `coord doctor --help` for usage.");
      return { ok: false, code: 1 };
    }
    const targetRoot = opts.dir ? path.resolve(cwd(), opts.dir) : path.resolve(cwd());
    const report = scan(targetRoot);
    const body = opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report).trimEnd();
    if (opts.output) {
      const outputPath = path.resolve(targetRoot, opts.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${body}\n`);
      log(`coord doctor: wrote ${opts.output}`);
    } else {
      log(body);
    }
    return { ok: true, code: 0, report };
  }

  function printUsage() {
    log("Usage: coord doctor [--dir <path>] [--json] [--output <path>]");
    log("");
    log("Read-only adoption/readiness scanner for a repo using Concord.");
    log("");
    log("Options:");
    log("  --dir <path>   Target repo root. Defaults to the current directory.");
    log("  --json         Emit deterministic JSON instead of markdown.");
    log("  --output <path> Write the report under the target root instead of stdout.");
    log("  -h, --help     Show this help text.");
  }

  return {
    run,
    scan,
    renderMarkdown,
    parseArgs,
  };
}

module.exports = createReadinessDoctor;
