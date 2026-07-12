"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "concord.runtime-authority/v1";
const DESTRUCTIVE_SHELL = [
  /(?:^|[;&|]\s*|\b)(?:sudo\s+)?(?:rm|unlink|rmdir|shred)\b/i,
  /\bfind\b[^\n;&|]*\s-delete\b/i,
  /\brsync\b[^\n;&|]*\s--delete(?:\s|$)/i,
  /\bgit\s+(?:clean\b|reset\s+--hard\b|checkout\s+--\s+\.\s*$|restore\s+--source\b)/i,
  /\b(?:fs\.)?(?:rmSync|rmdirSync|unlinkSync)\s*\(/,
  /\b(?:os\.)?remove\s*\(|\bshutil\.rmtree\s*\(/,
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function unique(values) { return Array.from(new Set((values || []).map(String))).sort(); }

function probeRuntimeCoverage({ provider, preToolHook = false, subagentHooks = false, sandboxMode = "unknown" } = {}) {
  const name = String(provider || "unknown").toLowerCase();
  if (name === "claude") {
    const coverage = preToolHook && subagentHooks ? "complete" : preToolHook ? "partial" : "unmanaged";
    return { provider: name, coverage, enforced: { pre_tool: preToolHook, subagents: subagentHooks, sandbox: sandboxMode }, limitations: coverage === "complete" ? [] : ["provider hook coverage is incomplete"] };
  }
  if (name === "codex") {
    const sandboxed = sandboxMode === "workspace-write" || sandboxMode === "read-only";
    return { provider: name, coverage: sandboxed ? "partial" : "unmanaged", enforced: { pre_tool: false, subagents: false, sandbox: sandboxMode }, limitations: ["no verified Concord pre-tool mediation", "no verified subagent lifecycle hook"] };
  }
  return { provider: name, coverage: "unmanaged", enforced: {}, limitations: ["provider adapter unavailable"] };
}

function assertAutoModeAllowed(probe, risk = "normal") {
  if (!probe || probe.coverage === "unmanaged") throw new Error("auto mode denied: runtime authority is unmanaged");
  if (risk === "high" && probe.coverage !== "complete") throw new Error("auto mode denied: high-risk ticket requires complete runtime authority coverage");
  return true;
}

function createEnvelope(input) {
  if (!input?.ticket || !input?.worktree || !input?.session) throw new Error("ticket, worktree, and session are required");
  const body = {
    schema: SCHEMA,
    ticket: String(input.ticket),
    session: String(input.session),
    provider: String(input.provider || "unknown"),
    parent_session: input.parent_session ? String(input.parent_session) : null,
    worktree: path.resolve(input.worktree),
    write_roots: unique(input.write_roots?.length ? input.write_roots.map((entry) => path.resolve(entry)) : [path.resolve(input.worktree)]),
    commands: unique(input.commands || []),
    network: unique(input.network || []),
    secrets: unique(input.secrets || []),
    destructive: false,
    coverage: input.coverage || "partial",
  };
  return { ...body, digest: digest(body) };
}

function deriveSubagentEnvelope(parent, request) {
  verifyEnvelope(parent);
  const requestedRoots = request.write_roots?.length ? request.write_roots.map((entry) => path.resolve(entry)) : parent.write_roots;
  const outside = requestedRoots.find((root) => !parent.write_roots.some((allowed) => inside(allowed, root)));
  if (outside) throw new Error(`subagent authority expansion: write root ${outside}`);
  for (const field of ["commands", "network", "secrets"]) {
    const requested = unique(request[field] || []);
    const denied = requested.find((value) => !parent[field].includes(value));
    if (denied) throw new Error(`subagent authority expansion: ${field} ${denied}`);
  }
  return createEnvelope({
    ...request,
    ticket: parent.ticket,
    provider: parent.provider,
    parent_session: parent.session,
    worktree: parent.worktree,
    write_roots: requestedRoots,
    commands: request.commands || [],
    network: request.network || [],
    secrets: request.secrets || [],
    coverage: parent.coverage,
  });
}

function verifyEnvelope(envelope) {
  const body = { ...envelope }; delete body.digest;
  if (envelope?.schema !== SCHEMA || envelope.digest !== digest(body)) throw new Error("runtime authority envelope digest mismatch");
  if (envelope.destructive !== false) throw new Error("destructive authority is prohibited");
  return true;
}

function commandFrom(input) { return String(input?.command || input?.cmd || input?.script || ""); }
function targetPaths(input) {
  return unique([input?.file_path, input?.path, input?.target, ...(Array.isArray(input?.paths) ? input.paths : [])].filter(Boolean));
}
function evaluateToolCall(envelope, call) {
  verifyEnvelope(envelope);
  const tool = String(call?.tool || call?.tool_name || "unknown");
  const input = call?.input || call?.tool_input || {};
  const command = commandFrom(input);
  if (command && DESTRUCTIVE_SHELL.some((pattern) => pattern.test(command))) {
    return { decision: "deny", reason: "permanent deletion or destructive Git operation", coverage: envelope.coverage };
  }
  if (/apply_patch/i.test(tool) && /\*\*\*\s+Delete File:/i.test(String(input?.patch || input?.input || ""))) {
    return { decision: "deny", reason: "file deletion through patch", coverage: envelope.coverage };
  }
  for (const target of targetPaths(input)) {
    const absolute = path.resolve(envelope.worktree, target);
    if (!envelope.write_roots.some((root) => inside(root, absolute))) {
      return { decision: "deny", reason: "write outside ticket authority", coverage: envelope.coverage };
    }
  }
  if (/delete|remove|unlink|rmdir/i.test(tool)) return { decision: "deny", reason: "delete-like tool is not permitted", coverage: envelope.coverage };
  return { decision: "allow", reason: null, coverage: envelope.coverage };
}

function readSupervisor(file) {
  if (!fs.existsSync(file)) return { schema: SCHEMA, subagents: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeSupervisor(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function registerSubagent(file, parent, child) {
  verifyEnvelope(parent); verifyEnvelope(child);
  if (child.parent_session !== parent.session || child.ticket !== parent.ticket) throw new Error("subagent parent or ticket mismatch");
  const state = readSupervisor(file);
  state.subagents[child.session] = { parent_session: parent.session, ticket: parent.ticket, envelope_digest: child.digest, status: "active", explained: false };
  writeSupervisor(file, state);
  return state.subagents[child.session];
}
function finishSubagent(file, session, { explained = false, action_digest = null } = {}) {
  const state = readSupervisor(file);
  if (!state.subagents[session]) throw new Error(`unknown subagent session ${session}`);
  state.subagents[session] = { ...state.subagents[session], status: "finished", explained: Boolean(explained), action_digest };
  writeSupervisor(file, state);
  return state.subagents[session];
}
function supervisionReport(file, ticket) {
  const entries = Object.entries(readSupervisor(file).subagents).filter(([, value]) => value.ticket === ticket);
  const active = entries.filter(([, value]) => value.status === "active").map(([session]) => session);
  const unexplained = entries.filter(([, value]) => value.status === "finished" && (!value.explained || !value.action_digest)).map(([session]) => session);
  return { ticket, ok: active.length === 0 && unexplained.length === 0, active, unexplained, sessions: entries.length };
}

module.exports = { DESTRUCTIVE_SHELL, SCHEMA, assertAutoModeAllowed, createEnvelope, deriveSubagentEnvelope, evaluateToolCall, finishSubagent, probeRuntimeCoverage, registerSubagent, supervisionReport, verifyEnvelope };
