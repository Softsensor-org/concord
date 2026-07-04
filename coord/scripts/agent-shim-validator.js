"use strict";

// COORD-256: read-only validator for agent shim drift.

const nodeFs = require("node:fs");
const nodePath = require("node:path");

const DEFAULT_SHIMS = Object.freeze([
  "AGENTS.md",
  "coord/AGENTS.md",
  "CODEX.md",
  "CLAUDE.md",
  "GEMINI.md",
  "backend/AGENTS.md",
  "frontend/AGENTS.md",
]);

const TOOL_SHIMS = new Set(["CODEX.md", "CLAUDE.md", "GEMINI.md"]);
const CANONICAL_POINTER = /coord\/GOVERNANCE\.md/;
const PRECEDENCE_POINTER = /Rule precedence|precedence/i;
const CONFLICT_PATTERNS = Object.freeze([
  { id: "bypass-gov", pattern: /\b(skip|bypass|ignore)\b.{0,40}\bgov(ernance)?\b/i },
  { id: "direct-board-edit", pattern: /\b(directly|manually)\s+edit\b.{0,80}\b(coord\/)?board\/tasks\.json\b/i },
  { id: "override-canonical", pattern: /\boverride\b.{0,80}\bcoord\/GOVERNANCE\.md\b/i },
  { id: "disable-gates", pattern: /\b(disable|skip)\b.{0,40}\b(gates?|tests?)\b/i },
]);

function createAgentShimValidator(deps = {}) {
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());

  function parseArgs(args = []) {
    const opts = { dir: null, json: false, help: false, unknown: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--json") opts.json = true;
      else if (arg === "-h" || arg === "--help") opts.help = true;
      else if (arg === "--dir") {
        opts.dir = args[i + 1] || null;
        i += 1;
      } else if (arg.startsWith("--dir=")) {
        opts.dir = arg.slice("--dir=".length);
      } else {
        opts.unknown.push(arg);
      }
    }
    return opts;
  }

  function read(root, rel) {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  }

  function discoverShims(root) {
    const found = new Set(DEFAULT_SHIMS);
    function walk(dir, depth) {
      if (depth > 4) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".runtime") continue;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (entry.isFile() && entry.name === "AGENTS.md") found.add(rel);
        if (entry.isDirectory()) walk(abs, depth + 1);
      }
    }
    walk(root, 0);
    return Array.from(found).sort();
  }

  function validateShim(root, rel) {
    const raw = read(root, rel);
    const present = raw != null;
    const lines = present ? raw.split(/\r?\n/).length : 0;
    const findings = [];
    const add = (severity, code, message) => findings.push({ severity, code, message });
    const isToolShim = TOOL_SHIMS.has(rel);

    if (!present) {
      add("warning", "missing", "Shim file is missing.");
      return { path: rel, present, lines, canonical_pointer: false, precedence_pointer: false, tool_shim: isToolShim, findings };
    }

    const canonical = CANONICAL_POINTER.test(raw);
    const precedence = PRECEDENCE_POINTER.test(raw);
    if (!canonical) {
      add("warning", "missing-canonical-pointer", "Shim does not point to coord/GOVERNANCE.md.");
    }
    if ((rel === "AGENTS.md" || isToolShim) && !precedence) {
      add("warning", "missing-precedence", "Shim does not mention rule precedence.");
    }
    if (isToolShim && lines > 80) {
      add("warning", "tool-shim-too-large", "Tool-specific shim is no longer thin; move durable policy to coord/GOVERNANCE.md or AGENTS.md.");
    }
    for (const { id, pattern } of CONFLICT_PATTERNS) {
      if (pattern.test(raw) && !/Never directly edit|Do not directly edit|must NOT mutate/i.test(raw)) {
        add("blocker", `conflict-${id}`, "Shim appears to contain governance-conflicting instructions.");
      }
    }
    return {
      path: rel,
      present,
      lines,
      canonical_pointer: canonical,
      precedence_pointer: precedence,
      tool_shim: isToolShim,
      findings,
    };
  }

  function validate(rootArg) {
    const root = path.resolve(rootArg);
    const shims = discoverShims(root).map((rel) => validateShim(root, rel));
    const findings = shims.flatMap((shim) =>
      shim.findings.map((finding) => Object.assign({ path: shim.path }, finding))
    );
    return {
      kind: "agent-shim-validation",
      schema_version: 1,
      target_root: root,
      read_only: true,
      shims,
      findings,
      ok: findings.every((f) => f.severity !== "blocker"),
      summary: {
        files_checked: shims.length,
        blockers: findings.filter((f) => f.severity === "blocker").length,
        warnings: findings.filter((f) => f.severity === "warning").length,
      },
    };
  }

  function render(report) {
    const lines = [];
    lines.push("# Agent Shim Validation");
    lines.push("");
    lines.push(`Target: ${report.target_root}`);
    lines.push(`Read-only: ${report.read_only ? "yes" : "no"}`);
    lines.push(`Status: ${report.ok ? "ok" : "blocked"}`);
    lines.push(`Files checked: ${report.summary.files_checked}`);
    lines.push(`Blockers: ${report.summary.blockers}`);
    lines.push(`Warnings: ${report.summary.warnings}`);
    lines.push("");
    for (const shim of report.shims) {
      lines.push(`- ${shim.path}: ${shim.present ? "present" : "missing"}, canonical=${shim.canonical_pointer ? "yes" : "no"}, precedence=${shim.precedence_pointer ? "yes" : "no"}`);
      for (const finding of shim.findings) {
        lines.push(`  - [${finding.severity}] ${finding.code}: ${finding.message}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  function run(args = []) {
    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { code: 0, ok: true };
    }
    if (opts.unknown.length > 0) {
      log(`shim-validator: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run with --help for usage.");
      return { code: 1, ok: false };
    }
    const root = opts.dir ? path.resolve(cwd(), opts.dir) : path.resolve(cwd());
    const report = validate(root);
    log(opts.json ? JSON.stringify(report, null, 2) : render(report).trimEnd());
    return { code: report.ok ? 0 : 2, ok: report.ok, report };
  }

  function printUsage() {
    log("Usage: node coord/scripts/agent-shim-validator.js [--dir <path>] [--json]");
    log("");
    log("Read-only validation for AGENTS.md / CODEX.md / CLAUDE.md / GEMINI.md drift.");
  }

  return { parseArgs, validate, render, run };
}

module.exports = createAgentShimValidator;

if (require.main === module) {
  const result = createAgentShimValidator().run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
