#!/usr/bin/env node

/**
 * Governance MCP Server — typed adapter over governance.js.
 *
 * Exposes governed ticket lifecycle as typed MCP tools so any MCP-capable
 * agent gets structured inputs/outputs without forking a subprocess per call.
 *
 * Usage:
 *   node coord/scripts/governance-mcp.js          # stdio transport
 *
 * MCP config (.mcp.json):
 *   "governance": {
 *     "command": "node",
 *     "args": ["coord/scripts/governance-mcp.js"]
 *   }
 */

const fs = require("fs");
const path = require("path");
const { allBoardRepoCodes } = require("../paths.js");
const governance = require("./governance.js");
const { STATUS, GATE_LANES } = require("./governance-constants.js");

const FOLLOWUP_OPEN_RELATIONS = ["blocking", "related", "closeout-blocker"];
const FOLLOWUP_RELATIONS = [...FOLLOWUP_OPEN_RELATIONS, "independent"];

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const HEADER_TERMINATOR = "\r\n\r\n";

const COORD_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.dirname(COORD_DIR);
const HEARTBEAT_LOOP_STATE = {
  timer: null,
  inFlight: false,
};

// ---------------------------------------------------------------------------
// CLI bridge — runs governance.js as a subprocess, captures JSON output
// ---------------------------------------------------------------------------

// MCP clients (Claude Code, Codex, Gemini) can declare the calling
// conversation's thread id via GOVERNANCE_MCP_THREAD_ID when they spawn the
// server. The CLI's `currentRuntimeThreadId()` already accepts the generic
// AGENT_THREAD_ID fallback, so promoting GOVERNANCE_MCP_THREAD_ID into that
// slot stamps lock files, event log entries, and audit events with correct
// per-conversation attribution without touching the provider registry or
// CLI identity resolution. Provider-native env vars (CODEX_THREAD_ID,
// CLAUDE_SESSION_ID, GEMINI_THREAD_ID, GROK_THREAD_ID) still win per the
// resolution order in `coord/docs/provider-thread-id-sources.md`.
function buildRunGovEnv(baseEnv = process.env, callerThreadId = baseEnv.GOVERNANCE_MCP_THREAD_ID) {
  const env = { ...baseEnv, GOVERNANCE_MCP_CALLER: "true" };
  if (callerThreadId) {
    env.AGENT_THREAD_ID = callerThreadId;
  }
  return env;
}

function logHeartbeatIssue(message, logger = (line) => process.stderr.write(`${line}\n`)) {
  if (!message) {
    return;
  }
  logger(`[governance-mcp heartbeat] ${message}`);
}

function resolveHeartbeatTicket(identityPayload = {}) {
  const currentTicket = identityPayload?.current_ticket;
  if (currentTicket?.id && currentTicket.status === STATUS.DOING) {
    return currentTicket.id;
  }
  const activeTickets = Array.isArray(identityPayload?.active_tickets)
    ? identityPayload.active_tickets.filter((ticket) => ticket?.id && ticket.status === STATUS.DOING)
    : [];
  if (activeTickets.length === 1) {
    return activeTickets[0].id;
  }
  return null;
}

function readHeartbeatLock(ticketId, readText = (filePath) => fs.readFileSync(filePath, "utf8")) {
  if (!ticketId) {
    return null;
  }
  const lockPath = path.join(COORD_DIR, ".runtime", "locks", `${ticketId}.lock`);
  try {
    const raw = readText(lockPath);
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function shouldHeartbeatLock(lock, expectedSessionId, existsSync = fs.existsSync) {
  if (!lock || lock.status !== STATUS.DOING) {
    return false;
  }
  if (expectedSessionId && lock.session_id && lock.session_id !== expectedSessionId) {
    return false;
  }
  if (!lock.worktree || !existsSync(lock.worktree)) {
    return false;
  }
  return true;
}

function runHeartbeatCycle(options = {}) {
  const loopState = options.loopState || HEARTBEAT_LOOP_STATE;
  const runGovFn = options.runGov || runGov;
  const logger = options.logger || logHeartbeatIssue;
  const readLock = options.readLock || readHeartbeatLock;
  const existsSync = options.existsSync || fs.existsSync;

  if (loopState.inFlight) {
    return { ok: true, skipped: "in_flight" };
  }

  loopState.inFlight = true;
  try {
    const identityResult = runGovFn(["whoami"]);
    if (!identityResult.ok) {
      logger(`could not inspect current session: ${identityResult.error}`);
      return { ok: false, skipped: "whoami_failed", error: identityResult.error };
    }
    const identityPayload = identityResult.data || {};
    const ticketId = resolveHeartbeatTicket(identityPayload);
    const sessionId = identityPayload.session_id || null;
    if (!ticketId || !sessionId) {
      return { ok: true, skipped: "no_active_ticket" };
    }

    const lock = readLock(ticketId);
    if (!shouldHeartbeatLock(lock, sessionId, existsSync)) {
      return { ok: true, skipped: "lock_not_heartbeatable", ticket: ticketId };
    }

    const heartbeatResult = runGovFn(["heartbeat", ticketId], { captureJson: false });
    if (!heartbeatResult.ok) {
      logger(`heartbeat failed for ${ticketId}: ${heartbeatResult.error}`);
      return { ok: false, skipped: "heartbeat_failed", ticket: ticketId, error: heartbeatResult.error };
    }
    return { ok: true, ticket: ticketId, heartbeatText: heartbeatResult.text || "" };
  } finally {
    loopState.inFlight = false;
  }
}

function ensureHeartbeatLoop(options = {}) {
  const loopState = options.loopState || HEARTBEAT_LOOP_STATE;
  if (loopState.timer) {
    return loopState.timer;
  }
  const intervalMs = options.intervalMs || HEARTBEAT_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const logger = options.logger || logHeartbeatIssue;
  const tick = () => {
    try {
      runHeartbeatCycle({ ...options, loopState, logger });
    } catch (error) {
      logger(`unexpected heartbeat loop failure: ${error?.message || String(error)}`);
    }
  };
  loopState.timer = setIntervalFn(tick, intervalMs);
  if (typeof loopState.timer?.unref === "function") {
    loopState.timer.unref();
  }
  return loopState.timer;
}

function stopHeartbeatLoop(options = {}) {
  const loopState = options.loopState || HEARTBEAT_LOOP_STATE;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  if (!loopState.timer) {
    return false;
  }
  clearIntervalFn(loopState.timer);
  loopState.timer = null;
  loopState.inFlight = false;
  return true;
}

function defaultExecuteGovCommand(args, options) {
  return governance.executeCommand(args, options);
}

let executeGovCommandImpl = defaultExecuteGovCommand;

function defaultRunGov(args, { captureJson = true } = {}) {
  try {
    const result = executeGovCommandImpl(args, {
      cwd: ROOT_DIR,
      env: buildRunGovEnv(),
    });
    if (!result?.ok) {
      const message = String(result?.stderr || result?.stdout || result?.error || "governance command failed").trim();
      return { ok: false, error: message };
    }

    const stdout = String(result.stdout || "").trim();

    if (captureJson) {
      // governance.js prints JSON to stdout for most commands
      const trimmed = stdout;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return { ok: true, data: JSON.parse(trimmed) };
      }
      return { ok: true, data: null, text: trimmed };
    }

    return { ok: true, text: stdout };
  } catch (error) {
    const stderr = error.capturedStderr ? String(error.capturedStderr).trim() : "";
    const stdout = error.capturedStdout ? String(error.capturedStdout).trim() : "";
    const message = stderr || stdout || error.message || "governance command failed";
    return { ok: false, error: message };
  }
}

let runGovImpl = defaultRunGov;

function runGov(args, options) {
  return runGovImpl(args, options);
}

function setRunGovImplForTesting(impl) {
  runGovImpl = impl || defaultRunGov;
}

function resetRunGovImplForTesting() {
  runGovImpl = defaultRunGov;
}

function setExecuteGovCommandImplForTesting(impl) {
  executeGovCommandImpl = impl || defaultExecuteGovCommand;
}

function resetExecuteGovCommandImplForTesting() {
  executeGovCommandImpl = defaultExecuteGovCommand;
}

const TICKET_ID_PATTERN = /^[A-Z]+-\d+$/;

function validateTicketId(ticket) {
  if (!ticket || !TICKET_ID_PATTERN.test(ticket)) {
    return { ok: false, error: `Invalid ticket ID "${ticket}". Expected format: PREFIX-123` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool definitions — each tool maps to a governance.js CLI command
// ---------------------------------------------------------------------------

const TOOLS = {
  // --- Read-only / inspection ---

  gov_initiate: {
    description: "Cold-start governance session. Shows primer, current session, rules, and common commands.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => runGov(["initiate"], { captureJson: false }),
  },

  gov_counts: {
    description: "Board summary: ticket counts by status, active work, doing locks.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => runGov(["counts"], { captureJson: false }),
  },

  gov_ticket: {
    description: "Read a single ticket's details from the board.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string", description: "Ticket ID (e.g., FE-142)" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => runGov(["ticket", ticket]),
  },

  gov_explain: {
    description: "Full diagnostic for a ticket: status, readiness, governance state, blockers, next commands.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => {
      const v = validateTicketId(ticket);
      if (v) return v;
      return runGov(["explain", ticket]);
    },
  },

  gov_doctor: {
    description: "Run governance health diagnostics. Optionally scoped to one ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "Optional ticket ID to scope the check" },
        fix: { type: "boolean", description: "Apply deterministic repairs" },
      },
    },
    handler: ({ ticket, fix }) => {
      const args = ["doctor"];
      if (fix) args.push("--fix");
      if (ticket) args.push("--ticket", ticket);
      return runGov(args, { captureJson: false });
    },
  },

  gov_orch: {
    description: "Run the orchestrator cycle: doctor + question triage + exception SLO check.",
    inputSchema: {
      type: "object",
      properties: { fix: { type: "boolean" } },
    },
    handler: ({ fix }) => runGov(fix ? ["orch", "--fix"] : ["orch"], { captureJson: false }),
  },

  gov_pick: {
    description: "Recommend next tickets for the current agent.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["backend", "frontend", "design", "general"], description: "Work mode filter" },
        limit: { type: "number", description: "Max tickets to return" },
        all: { type: "boolean", description: "Pick for all idle agents" },
      },
    },
    handler: ({ mode, limit, all }) => {
      const args = all ? ["pick", "all"] : ["pick"];
      if (mode) args.push("--mode", mode);
      if (limit) args.push("--limit", String(limit));
      return runGov(args, { captureJson: false });
    },
  },

  gov_recent: {
    description: "Read recent governance journal events for a ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        limit: { type: "number" },
        full: { type: "boolean", description: "Include full snapshot payloads" },
      },
    },
    handler: ({ ticket, limit, full }) => {
      const args = ["recent"];
      if (ticket) args.push(ticket);
      if (limit) args.push("--limit", String(limit));
      if (full) args.push("--full");
      return runGov(args, { captureJson: false });
    },
  },

  gov_agent_status: {
    description: "Show all registered agents, active sessions, busy/idle state.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => runGov(["agent-status"]),
  },

  // --- Session management ---

  gov_claim: {
    description: "Claim an agent identity for this session.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Agent handle or simple ID (e.g., claudea11)" },
        force: { type: "boolean", description: "Force-claim even if another session owns the ticket" },
      },
      required: ["owner"],
    },
    handler: ({ owner, force }) => {
      const args = ["claim", "--owner", owner];
      if (force) args.push("--force");
      return runGov(args);
    },
  },

  gov_agent_rebind: {
    description: "Release the caller's current handle binding (if any) and atomically claim a new unclaimed handle from the caller's provider pool. Canonical escape hatch for session-handle collisions. Does not touch foreign tickets.",
    inputSchema: {
      type: "object",
      properties: {
        fresh: { type: "boolean", description: "Must be true; guards against accidental invocation" },
      },
      required: ["fresh"],
    },
    handler: ({ fresh }) => {
      const args = ["agent-rebind"];
      if (fresh) args.push("--fresh");
      return runGov(args);
    },
  },

  gov_rebuild_board: {
    description: "Replay governance journal events to reconstruct board/tasks.json rows. Repairs regressed status (row exists, status stale). For missing rows, fails with a clear error — the journal alone does not carry the original repo/type/pri/description metadata.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "Ticket id to rebuild; omit when using all=true" },
        all: { type: "boolean", description: "Replay every ticket with journal drift (best-effort; individual failures are reported but do not abort)" },
      },
    },
    handler: ({ ticket, all }) => {
      const args = ["rebuild-board"];
      if (ticket) args.push(ticket);
      if (all) args.push("--all");
      return runGov(args);
    },
  },

  gov_resume: {
    description: "Resume ownership of an already-started ticket in the current session.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => runGov(["resume", ticket]),
  },

  // --- Ticket lifecycle ---

  gov_start: {
    description: "Move a ticket from todo to doing. Creates lock and worktree.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => {
      const v = validateTicketId(ticket);
      if (v) return v;
      return runGov(["start", ticket], { captureJson: false });
    },
  },

  gov_commit: {
    description: "Stage and commit changes in the governed worktree for a doing ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        message: { type: "string", description: "Full commit message; must already include the ticket ID prefix" },
        all: { type: "boolean", description: "Stage all tracked and untracked changes before commit" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional repo-relative paths to stage explicitly before commit",
        },
      },
      required: ["ticket", "message"],
    },
    handler: ({ ticket, message, all, files }) => {
      const v = validateTicketId(ticket);
      if (v) return v;
      const args = ["commit", ticket, "--message", message];
      if (all) {
        args.push("--all");
      }
      for (const file of files || []) {
        args.push("--files", file);
      }
      return runGov(args, { captureJson: false });
    },
  },

  gov_heartbeat: {
    description: "Sync the lock HEAD to the current worktree HEAD. Run after every commit.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => runGov(["heartbeat", ticket], { captureJson: false }),
  },

  gov_submit: {
    description: "Push branch, create PR, move ticket to review. Validates all plan evidence.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        fill: { type: "boolean", description: "Auto-fill PR title/body from plan" },
      },
      required: ["ticket"],
    },
    handler: ({ ticket, fill }) => {
      const args = ["submit", ticket];
      if (fill) args.push("--fill");
      return runGov(args);
    },
  },

  gov_land: {
    description: "Merge the PR, record landing evidence, close the ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        method: { type: "string", enum: ["merge", "squash", "rebase"] },
        deleteBranch: { type: "boolean" },
      },
      required: ["ticket"],
    },
    handler: ({ ticket, method, deleteBranch }) => {
      const args = ["land", ticket];
      if (method) args.push("--method", method);
      if (deleteBranch) args.push("--delete-branch");
      return runGov(args);
    },
  },

  gov_finalize: {
    description: "No-PR closeout for local-only changes. Moves to review and marks done.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        landed: { type: "string", description: "Landing evidence text" },
        alreadyLanded: { type: "boolean" },
        sourceCommit: { type: "string" },
      },
      required: ["ticket", "landed"],
    },
    handler: ({ ticket, landed, alreadyLanded, sourceCommit }) => {
      const args = ["finalize", ticket, "--no-pr", "--landed", landed];
      if (alreadyLanded) args.push("--already-landed");
      if (sourceCommit) args.push("--source-commit", sourceCommit);
      return runGov(args);
    },
  },

  gov_supersede: {
    description: "Mark a ticket as superseded (obsolete work that was NOT already landed).",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        reason: { type: "string" },
      },
      required: ["ticket"],
    },
    handler: ({ ticket, reason }) => {
      const args = ["supersede", ticket];
      if (reason) args.push("--reason", reason);
      return runGov(args, { captureJson: false });
    },
  },

  // --- Plan management ---

  gov_update_plan: {
    description: "Update plan state: startup, traceability, baseline, invariants.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        startup: { type: "string", description: "Startup attestation (e.g., 'completed')" },
        traceability: { type: "string", description: "Traceability status (e.g., 'closing-gap', 'exempt')" },
        baselines: { type: "array", items: { type: "string" }, description: "Baseline reproduction entries" },
        invariants: { type: "array", items: { type: "string" }, description: "Critical invariant entries" },
      },
      required: ["ticket"],
    },
    handler: ({ ticket, startup, traceability, baselines, invariants }) => {
      const args = ["update-plan", ticket];
      if (startup) args.push("--startup", startup);
      if (traceability) args.push("--traceability", traceability);
      for (const b of baselines || []) args.push("--baseline", b);
      for (const i of invariants || []) args.push("--invariant", i);
      return runGov(args, { captureJson: false });
    },
  },

  gov_set_review_cycles: {
    description: "Set all self-review cycles at once (atomic replacement). Preferred over individual add-review-cycle.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        cycles: {
          type: "array",
          items: { type: "string" },
          description: 'Each cycle as "lens=...; diff=...; risks=...; findings=...; verification=...; verdict=pass|fail"',
        },
      },
      required: ["ticket", "cycles"],
    },
    handler: ({ ticket, cycles }) => {
      const args = ["set-review-cycles", ticket];
      for (const c of cycles) args.push("--review-cycle", c);
      return runGov(args, { captureJson: false });
    },
  },

  gov_set_requirement_closure: {
    description: "Record requirement closure evidence for a ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        ticketAsk: { type: "string" },
        implemented: { type: "string" },
        notImplemented: { type: "string" },
        deferredTo: { type: "string" },
        closeoutVerdict: { type: "string", enum: ["complete", "incomplete"] },
      },
      required: ["ticket", "ticketAsk", "implemented", "closeoutVerdict"],
    },
    handler: ({ ticket, ticketAsk, implemented, notImplemented, deferredTo, closeoutVerdict }) => {
      const args = ["set-requirement-closure", ticket, "--ticket-ask", ticketAsk, "--implemented", implemented, "--closeout-verdict", closeoutVerdict];
      if (notImplemented) args.push("--not-implemented", notImplemented);
      if (deferredTo) args.push("--deferred-to", deferredTo);
      return runGov(args, { captureJson: false });
    },
  },

  gov_add_feature_proof: {
    description: "Add a feature proof entry (path, symbol, text, or route).",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        proofPath: { type: "string", description: "Repo-relative file path" },
        proofSymbol: { type: "string", description: "file#symbol format" },
        proofText: { type: "string" },
        proofRoute: { type: "string" },
      },
      required: ["ticket"],
    },
    handler: ({ ticket, proofPath, proofSymbol, proofText, proofRoute }) => {
      const args = ["add-feature-proof", ticket];
      if (proofPath) args.push("--proof-path", proofPath);
      if (proofSymbol) args.push("--proof-symbol", proofSymbol);
      if (proofText) args.push("--proof-text", proofText);
      if (proofRoute) args.push("--proof-route", proofRoute);
      return runGov(args, { captureJson: false });
    },
  },

  gov_add_repo_gate: {
    description: "Record an executed repo gate command and its result.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        command: { type: "string", description: "The gate command that was executed" },
        note: { type: "string", description: "Result summary" },
      },
      required: ["ticket", "command"],
    },
    handler: ({ ticket, command, note }) => {
      const args = ["add-repo-gate", ticket, "--command", command];
      if (note) args.push("--note", note);
      return runGov(args, { captureJson: false });
    },
  },

  // --- Repair ---

  gov_recover: {
    description: "Rebuild governance state for a ticket from the event journal.",
    inputSchema: {
      type: "object",
      properties: { ticket: { type: "string" } },
      required: ["ticket"],
    },
    handler: ({ ticket }) => runGov(["recover", ticket]),
  },

  gov_reconcile: {
    description: "Accept governance drift for a ticket with a recorded reason.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string" },
        reason: { type: "string", description: "Why the drift is being accepted" },
      },
      required: ["reason"],
    },
    handler: ({ ticket, reason }) => {
      const args = ["reconcile"];
      if (ticket) args.push(ticket);
      args.push("--reason", reason);
      return runGov(args);
    },
  },

  // --- Quality gates ---

  gov_gate: {
    description: "Run a clean-checkout quality gate for a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name (e.g., backend, frontend, msrv)" },
        lane: { type: "string", enum: [...GATE_LANES] },
        branch: { type: "string" },
      },
      required: ["repo"],
    },
    handler: ({ repo, lane, branch }) => {
      const args = ["gate", repo];
      if (lane) args.push("--lane", lane);
      if (branch) args.push("--branch", branch);
      return runGov(args, { captureJson: false });
    },
  },

  // --- Ticket creation ---

  gov_open_followup: {
    description: "Create a follow-up ticket linked to an existing ticket.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "New ticket ID" },
        dependsOn: { type: "string", description: "Parent ticket ID" },
        repo: { type: "string", enum: allBoardRepoCodes() },
        type: { type: "string" },
        pri: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        description: { type: "string" },
        relation: { type: "string", enum: FOLLOWUP_OPEN_RELATIONS },
      },
      required: ["ticket", "dependsOn", "repo", "type", "pri", "description"],
    },
    handler: ({ ticket, dependsOn, repo, type, pri, description, relation }) => {
      const args = ["open-followup", ticket, "--depends-on", dependsOn, "--repo", repo, "--type", type, "--pri", pri, "--description", description];
      if (relation) args.push("--relation", relation);
      return runGov(args, { captureJson: false });
    },
  },

  gov_set_followup_relation: {
    description: "Change the follow-up relation on an existing ticket (blocking, related, closeout-blocker, or independent).",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "Ticket ID whose follow-up relation is being updated" },
        dependsOn: { type: "string", description: "Parent ticket ID; required unless relation is 'independent'" },
        relation: { type: "string", enum: FOLLOWUP_RELATIONS },
      },
      required: ["ticket", "relation"],
    },
    handler: ({ ticket, dependsOn, relation }) => {
      const args = ["set-followup-relation", ticket, "--relation", relation];
      if (dependsOn) args.push("--depends-on", dependsOn);
      return runGov(args, { captureJson: false });
    },
  },
};

// ---------------------------------------------------------------------------
// MCP protocol implementation (JSON-RPC over Content-Length framed stdio)
// ---------------------------------------------------------------------------

function validateToolArgs(schema, args) {
  if (!schema || schema.type !== "object") return null;
  const props = schema.properties || {};
  const required = schema.required || [];

  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      return `Missing required argument: "${key}"`;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const propSchema = props[key];
    if (!propSchema) continue;

    if (propSchema.type === "string" && typeof value !== "string") {
      return `Argument "${key}" must be a string, got ${typeof value}`;
    }
    if (propSchema.type === "number" && typeof value !== "number") {
      return `Argument "${key}" must be a number, got ${typeof value}`;
    }
    if (propSchema.type === "boolean" && typeof value !== "boolean") {
      return `Argument "${key}" must be a boolean, got ${typeof value}`;
    }
    if (propSchema.type === "array" && !Array.isArray(value)) {
      return `Argument "${key}" must be an array, got ${typeof value}`;
    }
    if (propSchema.enum && !propSchema.enum.includes(value)) {
      return `Argument "${key}" must be one of: ${propSchema.enum.join(", ")}. Got "${value}"`;
    }
  }

  return null;
}

const SERVER_INFO = {
  name: "governance",
  version: "0.4.0",
  description: "Governed ticket lifecycle for multi-agent coordination",
};

const DEFAULT_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  description:
    "Machine-readable governance tool result. Tools that return structured data from governance.js expose it here; tools that emit CLI text expose it under `text`.",
  properties: {
    text: {
      type: "string",
      description:
        "Raw CLI text output when the tool does not emit JSON. Omitted when the tool returns structured data.",
    },
  },
  additionalProperties: true,
};

const ERROR_CODES = {
  UNKNOWN_TOOL: "unknown_tool",
  INVALID_ARGUMENTS: "invalid_arguments",
  HANDLER_ERROR: "handler_error",
};

// GCV-1 O3: governed-state mutators that the long-lived MCP server must
// refuse under identity v2 (interim read-only write surface). Pure
// read/inspection tools (gov_initiate/counts/ticket/explain/doctor/orch/
// pick/recent/agent_status) and the verification-only gov_gate are NOT
// listed and remain available.
const MUTATING_TOOLS = new Set([
  "gov_claim",
  "gov_agent_rebind",
  "gov_rebuild_board",
  "gov_resume",
  "gov_start",
  "gov_commit",
  "gov_heartbeat",
  "gov_submit",
  "gov_land",
  "gov_finalize",
  "gov_supersede",
  "gov_update_plan",
  "gov_set_review_cycles",
  "gov_set_requirement_closure",
  "gov_add_feature_proof",
  "gov_add_repo_gate",
  "gov_recover",
  "gov_reconcile",
  "gov_open_followup",
  "gov_set_followup_relation",
]);

// Tools that mutate ONLY when a specific argument enables it (read-only
// otherwise). Name-only gating would let `{name:"gov_doctor", arguments:
// {fix:true}}` bypass O3; the predicate below closes that back-door.
const CONDITIONALLY_MUTATING_TOOLS = {
  gov_doctor: (args) => Boolean(args && args.fix === true),
  gov_orch: (args) => Boolean(args && args.fix === true),
};

function isMutatingCall(toolName, toolArgs) {
  if (MUTATING_TOOLS.has(toolName)) return true;
  const conditional = CONDITIONALLY_MUTATING_TOOLS[toolName];
  return Boolean(conditional && conditional(toolArgs));
}

function buildStructuredError({ code, message, details }) {
  const error = { code, message };
  if (details !== undefined && details !== null) {
    error.details = details;
  }
  return { error };
}

function buildErrorResponse({ code, message, details }) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: buildStructuredError({ code, message, details }),
  };
}

function buildSuccessResponse(result) {
  if (result.data !== undefined && result.data !== null) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data,
    };
  }
  const text = typeof result.text === "string" ? result.text : "OK";
  return {
    content: [{ type: "text", text }],
    structuredContent: { text },
  };
}

function handleRequest(request) {
  const { method, params } = request;

  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };

    case "tools/list":
      return {
        tools: Object.entries(TOOLS).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
          outputSchema: def.outputSchema || DEFAULT_TOOL_OUTPUT_SCHEMA,
        })),
      };

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const tool = TOOLS[toolName];

      if (!tool) {
        return buildErrorResponse({
          code: ERROR_CODES.UNKNOWN_TOOL,
          message: `Unknown tool: ${toolName}`,
          details: { tool: toolName || null },
        });
      }

      const validationError = validateToolArgs(tool.inputSchema, toolArgs);
      if (validationError) {
        return buildErrorResponse({
          code: ERROR_CODES.INVALID_ARGUMENTS,
          message: validationError,
          details: { tool: toolName },
        });
      }

      // GCV-1 O3 (SETTLED): the MCP server is long-lived and captures env
      // at spawn, so it cannot prove the calling conversation's live
      // COORD_INSTANCE_ID per call. Interim decision: the MCP WRITE
      // SURFACE IS READ-ONLY under identity v2 — mutating tools fail
      // closed (never ambient-identity authority). Read-only/inspection
      // tools are unaffected. The target (per-tool-call identity injected
      // + validated against the registry) is a later, separately gated
      // build, not this interim.
      if (isMutatingCall(toolName, toolArgs)) {
        return buildErrorResponse({
          code: ERROR_CODES.HANDLER_ERROR,
          message:
            `MCP write surface is read-only under identity v2 (GCV-1 O3). ` +
            `"${toolName}" mutates governed state but the long-lived MCP ` +
            `server cannot prove this conversation's live identity per ` +
            `call. Run the mutation from the CLI (\`gov ...\`) in a ` +
            `session where the SessionStart hook is active. See ` +
            `the session-identity model.`,
          details: { tool: toolName, reason: "v2_mcp_read_only" },
        });
      }

      const result = tool.handler(toolArgs);

      if (!result.ok) {
        return buildErrorResponse({
          code: ERROR_CODES.HANDLER_ERROR,
          message: result.error,
          details: { tool: toolName },
        });
      }

      return buildSuccessResponse(result);
    }

    case "notifications/initialized":
      return null; // acknowledged, no response

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function parseContentLength(headersText) {
  let contentLength = null;
  for (const line of headersText.split("\r\n")) {
    if (!line.trim()) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      throw { code: -32700, message: `Malformed MCP header: ${line}` };
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (name !== "content-length") {
      continue;
    }
    if (!/^\d+$/.test(value)) {
      throw { code: -32700, message: `Invalid Content-Length header: ${value}` };
    }
    contentLength = Number(value);
  }
  if (contentLength === null) {
    throw { code: -32700, message: "Missing Content-Length header" };
  }
  return contentLength;
}

function createContentLengthMessageParser({ onMessage, onError } = {}) {
  let buffer = Buffer.alloc(0);
  let expectedLength = null;

  function emitError(error) {
    if (typeof onError === "function") {
      onError(error);
    }
  }

  return {
    push(chunk) {
      const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!nextChunk.length) {
        return;
      }
      buffer = buffer.length ? Buffer.concat([buffer, nextChunk]) : nextChunk;

      while (buffer.length) {
        if (expectedLength === null) {
          const headerEndIndex = buffer.indexOf(HEADER_TERMINATOR);
          if (headerEndIndex === -1) {
            return;
          }
          const headerText = buffer.slice(0, headerEndIndex).toString("ascii");
          try {
            expectedLength = parseContentLength(headerText);
          } catch (error) {
            buffer = Buffer.alloc(0);
            expectedLength = null;
            emitError(error);
            return;
          }
          buffer = buffer.slice(headerEndIndex + HEADER_TERMINATOR.length);
        }

        if (buffer.length < expectedLength) {
          return;
        }

        const payloadBuffer = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = null;

        try {
          const message = JSON.parse(payloadBuffer.toString("utf8"));
          if (typeof onMessage === "function") {
            onMessage(message);
          }
        } catch (error) {
          emitError({
            code: -32700,
            message: error?.message || "Invalid JSON payload",
          });
        }
      }
    },
  };
}

function encodeStdioMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}${HEADER_TERMINATOR}`, "ascii");
  return Buffer.concat([header, payload]);
}

function writeFramedMessage(output, message) {
  output.write(encodeStdioMessage(message));
}

function startStdioTransport(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const ensureHeartbeatLoopFn = options.ensureHeartbeatLoopFn || ensureHeartbeatLoop;
  const stopHeartbeatLoopFn = options.stopHeartbeatLoopFn || stopHeartbeatLoop;
  const handleRequestFn = options.handleRequestFn || handleRequest;
  const exitFn = options.exitFn || null;
  // A ref'ed timer keeps the process alive for generic stdio MCP clients that
  // spawn the server first and send the initial frame afterward.
  const transportKeepAlive = options.transportKeepAlive || setInterval(() => {}, 60_000);
  let closed = false;

  function cleanup() {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(transportKeepAlive);
    stopHeartbeatLoopFn();
    if (typeof exitFn === "function") {
      exitFn(0);
    }
  }

  ensureHeartbeatLoopFn();

  const parser = createContentLengthMessageParser({
    onMessage(request) {
      try {
        const result = handleRequestFn(request);
        if (result === null) {
          return;
        }
        writeFramedMessage(output, {
          jsonrpc: "2.0",
          id: request?.id ?? null,
          result,
        });
      } catch (error) {
        writeFramedMessage(output, {
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: {
            code: error.code || -32603,
            message: error.message || "Internal error",
          },
        });
      }
    },
    onError(error) {
      writeFramedMessage(output, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: error.code || -32700,
          message: error.message || "Parse error",
        },
      });
    },
  });

  input.on("data", (chunk) => parser.push(chunk));
  input.on("close", cleanup);
  input.on("end", cleanup);
  if (typeof input.resume === "function") {
    input.resume();
  }

  return { cleanup, parser };
}

module.exports = {
  MUTATING_TOOLS,
  CONDITIONALLY_MUTATING_TOOLS,
  isMutatingCall,
  __testing: {
    buildRunGovEnv,
    defaultRunGov,
    createContentLengthMessageParser,
    encodeStdioMessage,
    resolveHeartbeatTicket,
    readHeartbeatLock,
    shouldHeartbeatLock,
    startStdioTransport,
    runHeartbeatCycle,
    ensureHeartbeatLoop,
    stopHeartbeatLoop,
    HEARTBEAT_INTERVAL_MS,
    TOOLS,
    handleRequest,
    buildSuccessResponse,
    buildErrorResponse,
    buildStructuredError,
    ERROR_CODES,
    DEFAULT_TOOL_OUTPUT_SCHEMA,
    FOLLOWUP_OPEN_RELATIONS,
    FOLLOWUP_RELATIONS,
    setExecuteGovCommandImplForTesting,
    resetExecuteGovCommandImplForTesting,
    setRunGovImplForTesting,
    resetRunGovImplForTesting,
  },
};

if (require.main === module) {
  startStdioTransport();
}
