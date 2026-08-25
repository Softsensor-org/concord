"use strict";

// COORD-256: read-only validator for agent shim drift.
// COORD-476: also validates generated Claude hook surfaces
// (.claude/settings.json hook commands and .claude/commands/*.md) for
// nonportable or config-bypassing patterns: GNU-only `grep -P`/`-oP`,
// running the Bash shim through Node (`node coord/scripts/gov`), hardcoded
// `origin/dev`, and Bash-4-only `declare -A`.

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

// COORD-476: portability/config bans for generated hook commands and Claude
// command docs. These are blockers: each one is a field-reported breakage on
// stock macOS (Bash 3.2 + BSD grep) or a config bypass.
const HOOK_COMMAND_BANS = Object.freeze([
  {
    id: "gnu-grep-p",
    pattern: /\bgrep\s+-[a-zA-Z]*P/,
    message: "GNU-only `grep -P`/`grep -oP` breaks BSD grep on stock macOS; parse in a tested Node helper instead.",
  },
  {
    id: "node-gov-shim",
    pattern: /\bnode\s+(?:\.\/)?coord\/scripts\/gov(?![A-Za-z0-9_.-])/,
    message: "`coord/scripts/gov` is a Bash shim; invoke it directly or run `node coord/scripts/governance.js`.",
  },
  {
    id: "hardcoded-origin-dev",
    pattern: /\borigin\/dev\b/,
    message: "Hardcoded `origin/dev`; resolve the configured `integrationBranch` from coord/project.config.js.",
  },
  {
    id: "bash4-declare-a",
    pattern: /\bdeclare\s+-[a-zA-Z]*A/,
    message: "`declare -A` requires Bash 4; stock macOS ships Bash 3.2.",
  },
  // COORD-663: the runtime authority barrier was inert for its whole life
  // because its hook command was `printf '%s' "$TOOL_INPUT" | node …`. The
  // variable is unset in the Claude Code harness, so the pipe replaced the real
  // PreToolUse envelope on fd 0 with an empty string and the barrier permitted
  // every call while reading like a check that passed. A hook must receive the
  // harness's own payload, never a document synthesized in front of it.
  {
    id: "payload-from-env",
    pattern: /\$\{?TOOL_INPUT/,
    message:
      "Hook command reconstructs its payload from `$TOOL_INPUT`; the harness delivers the hook envelope on stdin, and the variable is unset (COORD-663). Invoke the hook bare and let it read fd 0.",
  },
  {
    id: "payload-overwritten",
    // Deliberately narrow, and keyed on the HOOK being the pipe's destination.
    // These bans are also applied to `.claude/commands/*.md`, where piping data
    // between ordinary programs is legitimate and common (`echo "$X" | python3
    // -c …` in review.md). What is never legitimate is feeding a hook script
    // anything other than the payload its harness sent it.
    // A SINGLE pipe (never `||`, which is a fallback, not a channel) whose
    // destination is a node invocation of a hook script.
    pattern: /(?<!\|)\|(?!\|)\s*(?:\S+=\S+\s+)*(?:\S*\/)?node\s+[^|\n]*\b(?:runtime-authority-hook\.js|coord\/scripts\/hooks\/[\w.-]+\.js)/,
    message:
      "Hook command pipes a synthesized document into the hook, replacing the harness payload on fd 0 (COORD-663). Invoke the hook bare.",
  },
]);

const NETWORK_PACKAGE_COMMANDS = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "uvx"]);
const NUMERIC_TOOL_COUNT = /\b\d+\s+(?:typed\s+)?(?:MCP\s+)?tools?\b/i;

function validateMcpConfig(raw) {
  const findings = [];
  const add = (code, message) => findings.push({ severity: "blocker", code, message });
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    add("mcp-unparseable", `Cannot parse .mcp.json: ${error.message}`);
    return findings;
  }

  const servers = config && config.mcpServers && typeof config.mcpServers === "object"
    ? config.mcpServers
    : {};
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== "governance") {
    add(
      "mcp-default-not-local-only",
      `Default .mcp.json must contain exactly the local governance server; found: ${names.join(", ") || "none"}.`
    );
  }

  for (const [name, server] of Object.entries(servers)) {
    const command = String(server && server.command || "").trim();
    const commandBase = nodePath.basename(command).toLowerCase();
    if (NETWORK_PACKAGE_COMMANDS.has(commandBase)) {
      add("mcp-network-package-command", `Default MCP server ${name} invokes package manager ${commandBase}.`);
    }
    const args = Array.isArray(server && server.args) ? server.args.map(String) : [];
    if (args.some((arg) => /(?:^|@)latest(?:$|\b)/i.test(arg))) {
      add("mcp-mutable-latest", `Default MCP server ${name} uses a mutable latest reference.`);
    }
    for (const [key, value] of Object.entries(server && server.env || {})) {
      if (!String(value || "").trim()) {
        add("mcp-blank-credential", `Default MCP server ${name} contains blank environment value ${key}.`);
      }
    }
    if (NUMERIC_TOOL_COUNT.test(String(server && server.description || ""))) {
      add("mcp-hardcoded-tool-count", `Default MCP server ${name} description hardcodes a tool count.`);
    }
  }

  const governance = servers.governance;
  if (
    governance &&
    (governance.command !== "node" ||
      !Array.isArray(governance.args) ||
      governance.args.length !== 1 ||
      governance.args[0] !== "coord/scripts/governance-mcp.js")
  ) {
    add(
      "mcp-governance-not-local",
      "The governance server must invoke node coord/scripts/governance-mcp.js directly."
    );
  }
  return findings;
}

function collectHookCommandStrings(settings) {
  const commands = [];
  const hooks = settings && settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const entry of entries) {
        if (entry && typeof entry.command === "string") commands.push(entry.command);
      }
    }
  }
  return commands;
}

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

  // COORD-476: scan generated Claude hook surfaces for nonportable or
  // config-bypassing command patterns.
  function validateHookSurfaces(root) {
    const surfaces = [];

    const settingsRel = ".claude/settings.json";
    const settingsRaw = read(root, settingsRel);
    if (settingsRaw != null) {
      const surface = { path: settingsRel, present: true, findings: [] };
      let commands = null;
      try {
        commands = collectHookCommandStrings(JSON.parse(settingsRaw));
      } catch {
        surface.findings.push({
          severity: "blocker",
          code: "hook-settings-unparseable",
          message: "Cannot parse .claude/settings.json; generated hook commands are unverifiable.",
        });
      }
      for (const command of commands || []) {
        for (const { id, pattern, message } of HOOK_COMMAND_BANS) {
          if (pattern.test(command)) {
            surface.findings.push({ severity: "blocker", code: `hook-${id}`, message });
          }
        }
      }
      surfaces.push(surface);
    }

    let commandDocs = [];
    try {
      commandDocs = fs
        .readdirSync(path.join(root, ".claude", "commands"))
        .filter((name) => name.endsWith(".md"))
        .sort();
    } catch {
      commandDocs = [];
    }
    for (const name of commandDocs) {
      const rel = `.claude/commands/${name}`;
      const raw = read(root, rel);
      if (raw == null) continue;
      const surface = { path: rel, present: true, findings: [] };
      for (const { id, pattern, message } of HOOK_COMMAND_BANS) {
        if (pattern.test(raw)) {
          surface.findings.push({ severity: "blocker", code: `hook-${id}`, message });
        }
      }
      surfaces.push(surface);
    }

    return surfaces;
  }

  function validate(rootArg) {
    const root = path.resolve(rootArg);
    const shims = discoverShims(root).map((rel) => validateShim(root, rel));
    const hookSurfaces = validateHookSurfaces(root);
    const mcpRaw = read(root, ".mcp.json");
    const mcpSurface = {
      path: ".mcp.json",
      present: mcpRaw != null,
      findings: mcpRaw == null
        ? [{ severity: "blocker", code: "mcp-missing", message: "Default .mcp.json is missing." }]
        : validateMcpConfig(mcpRaw),
    };
    const findings = shims
      .flatMap((shim) => shim.findings.map((finding) => Object.assign({ path: shim.path }, finding)))
      .concat(
        hookSurfaces.flatMap((surface) =>
          surface.findings.map((finding) => Object.assign({ path: surface.path }, finding))
        )
      )
      .concat(mcpSurface.findings.map((finding) => Object.assign({ path: mcpSurface.path }, finding)));
    return {
      kind: "agent-shim-validation",
      schema_version: 1,
      target_root: root,
      read_only: true,
      shims,
      hook_surfaces: hookSurfaces,
      mcp_surface: mcpSurface,
      findings,
      ok: findings.every((f) => f.severity !== "blocker"),
      summary: {
        files_checked: shims.length + hookSurfaces.length + 1,
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
    for (const surface of report.hook_surfaces || []) {
      lines.push(`- ${surface.path}: hook surface, ${surface.findings.length === 0 ? "portable" : "nonportable"}`);
      for (const finding of surface.findings) {
        lines.push(`  - [${finding.severity}] ${finding.code}: ${finding.message}`);
      }
    }
    const mcpSurface = report.mcp_surface;
    if (mcpSurface) {
      lines.push(`- ${mcpSurface.path}: MCP default, ${mcpSurface.findings.length === 0 ? "local-only" : "unsafe"}`);
      for (const finding of mcpSurface.findings) {
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
module.exports.validateMcpConfig = validateMcpConfig;

if (require.main === module) {
  const result = createAgentShimValidator().run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
