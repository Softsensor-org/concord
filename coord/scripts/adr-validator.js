#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ARTIFACT_KIND = "concord.adr_registry.validation";
const COCKPIT_ARTIFACT_KIND = "concord.adr_cockpit.readout";
const VALID_STATUSES = new Set(["Proposed", "Accepted", "Deferred", "Rejected", "Superseded"]);
const REQUIRED_SECTIONS = ["Context", "Linked Scope", "Decision Criteria", "Options Evaluated", "Decision", "Alternatives Rejected", "Consequences"];
const DEFAULT_DECISIONS_DIR = "coord/docs/decisions";
const DEFAULT_BOARD_PATH = "coord/board/tasks.json";
const DEFAULT_PLANS_DIR = "coord/.runtime/plans";
const ADR_REQUIRED_RISK_PATTERN =
  /\b(architecture|deployment topology|security boundary|security|auth|rbac|permission|data model|schema semantics|public api|cross-repo|cross repo|contract|business behavior|trust|memory authority|knowledge authority|agent operating protocol|governance policy|deliberate deferral|adr process|waiver)\b/i;
const ADR_DISCOVERY_STATUS_PATTERN = /\b(investigat(?:e|ing|ion)|discovery|spike|not required|not-required)\b/i;

function parseArgs(argv = []) {
  const options = {
    dir: DEFAULT_DECISIONS_DIR,
    json: false,
    output: null,
    cockpit: false,
    demo: false,
    board: DEFAULT_BOARD_PATH,
    plans: DEFAULT_PLANS_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--cockpit") {
      options.cockpit = true;
      continue;
    }
    if (arg === "--demo") {
      options.demo = true;
      continue;
    }
    if (["--dir", "--output", "--board", "--plans"].includes(arg)) {
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[arg.slice(2)] = value;
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseStatus(raw) {
  const match = String(raw || "").match(/^\s*-\s+\*\*Status:\*\*\s+([A-Za-z]+)/m);
  return match ? match[1] : null;
}

function parseTicket(raw) {
  const match = String(raw || "").match(/^\s*-\s+\*\*Ticket:\*\*\s+([A-Z]+-\d+)/m);
  return match ? match[1] : null;
}

function parseTickets(raw) {
  const match = String(raw || "").match(/^\s*-\s+\*\*Ticket:\*\*\s+(.+)$/m);
  return match ? Array.from(new Set(match[1].match(/\b[A-Z]+-\d+\b/g) || [])).sort() : [];
}

function parseRequirementIds(raw) {
  return Array.from(new Set(String(raw || "").match(/\b(?:REQ|URS|PRD|SRS|SEC|NFR)-\d+[A-Z]?\b/g) || [])).sort();
}

function parseSections(raw) {
  return Array.from(String(raw || "").matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());
}

function parseSectionBodies(raw) {
  const bodies = {};
  const matches = Array.from(String(raw || "").matchAll(/^##\s+(.+)$/gm));
  for (let i = 0; i < matches.length; i += 1) {
    const title = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : String(raw || "").length;
    bodies[title] = String(raw || "").slice(start, end).trim();
  }
  return bodies;
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function parseIndex(readme) {
  const rows = [];
  for (const match of String(readme || "").matchAll(/\|\s+\[([0-9]{4})\]\(\.\/([^)]+)\)\s+\|\s+([^|]+)\|\s+([^|]+)\|/g)) {
    rows.push({
      id: match[1],
      file: match[2],
      title: match[3].trim(),
      status: match[4].trim(),
    });
  }
  return rows;
}

function parseAdr(filePath, root) {
  const raw = read(filePath);
  const file = path.basename(filePath);
  const id = (file.match(/^([0-9]{4})-/) || [])[1] || null;
  const titleMatch = raw.match(/^#\s+ADR\s+([0-9]{4}):\s+(.+)$/m);
  const section_bodies = parseSectionBodies(raw);
  return {
    id,
    file,
    path: path.relative(root, filePath).split(path.sep).join("/"),
    content_hash: sha1(raw),
    heading_id: titleMatch ? titleMatch[1] : null,
    title: titleMatch ? titleMatch[2].trim() : null,
    status: parseStatus(raw),
    ticket: parseTicket(raw),
    tickets: parseTickets(raw),
    requirement_ids: parseRequirementIds(raw),
    sections: parseSections(raw),
    linked_scope: section_bodies["Linked Scope"] || null,
    decision: section_bodies.Decision || null,
    alternatives_rejected: section_bodies["Alternatives Rejected"] || null,
    consequences: section_bodies.Consequences || null,
    revisit_trigger: section_bodies["Revisit Trigger"] || null,
    section_bodies,
    supersedes: Array.from(new Set(Array.from(raw.matchAll(/\bsupersedes\s+ADR\s+([0-9]{4})/gi)).map((m) => m[1]))).sort(),
    superseded_by: (raw.match(/\bSuperseded\s+\(by\s+([0-9]{4})\)/i) || [])[1] || null,
    raw,
  };
}

function parseAffectedScope(adr) {
  const text = [adr.linked_scope, adr.section_bodies["Linked Scope"], adr.raw].filter(Boolean).join("\n");
  const affectedLines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim().replace(/^-\s+/, ""))
    .filter((line) => /\b(affected|scope|repo|module|surface|workflow|api|schema)\b/i.test(line));
  const repos = new Set();
  const modules = new Set();
  for (const line of affectedLines) {
    for (const match of line.matchAll(/\b(coord|backend|frontend|mobile|worker|api|ui|admin|web)(?:\/[A-Za-z0-9._/-]+)?\b/gi)) {
      const value = match[0].replace(/[.,;:)]+$/g, "");
      if (value.includes("/")) {
        repos.add(value.split("/")[0]);
        modules.add(value);
      } else {
        repos.add(value);
      }
    }
    const payload = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    for (const part of payload.split(/,|\band\b/i)) {
      const value = part.trim().replace(/[.;]+$/g, "");
      if (value && !/^Governing ticket$/i.test(value) && /\b[A-Za-z][A-Za-z0-9 _/-]{2,}\b/.test(value)) {
        modules.add(value);
      }
    }
  }
  return {
    repos: Array.from(repos).sort(),
    modules: Array.from(modules).sort(),
  };
}

function normalizeAdrRef(value) {
  const match = String(value || "").match(/(?:ADR[-\s:]?)?([0-9]{4})\b/i);
  return match ? match[1] : null;
}

function readJsonIfPresent(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(read(filePath));
}

function collectBoardRows(board) {
  const rows = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node.ID && node.Description) rows.push(node);
    for (const value of Object.values(node)) visit(value);
  }
  visit(board);
  return rows;
}

function readPlanState(plansDir, ticketId) {
  if (!plansDir || !ticketId) return null;
  const filePath = path.join(plansDir, `${ticketId}.json`);
  return readJsonIfPresent(filePath, null);
}

function buildAdrRiskText(row, planState) {
  return [
    row?.Description,
    row?.Type,
    planState?.security_surface,
    ...(planState?.intended_files || []),
    ...(planState?.change_summary || []),
    ...(planState?.critical_invariants || []),
    ...(planState?.requirement_closure || []),
  ].join("\n");
}

function ticketRequiresAdrDecision(row, planState) {
  const declared = planState?.decision_required;
  if (declared && typeof declared === "object") {
    if (declared.required === true) return true;
    if (["required", "deferred"].includes(String(declared.status || ""))) return true;
    if (declared.required === false || ["not-required", "waived", "investigating"].includes(String(declared.status || ""))) return false;
  }
  const type = String(row?.Type || "").trim().toLowerCase();
  if (["bug", "docs", "test", "chore"].includes(type) && !ADR_REQUIRED_RISK_PATTERN.test(buildAdrRiskText(row, planState))) {
    return false;
  }
  return ADR_REQUIRED_RISK_PATTERN.test(buildAdrRiskText(row, planState));
}

function resolveAdrRequiredReason(row, planState) {
  const declared = planState?.decision_required;
  if (declared?.reason) return String(declared.reason);
  const text = buildAdrRiskText(row, planState);
  const match = text.match(ADR_REQUIRED_RISK_PATTERN);
  return match ? `touches high-impact decision surface "${match[0]}"` : "marked decision_required";
}

function readAdrDecisionEvidence(planState) {
  const declared = planState?.decision_required && typeof planState.decision_required === "object"
    ? planState.decision_required
    : {};
  const text = [
    ...(planState?.adr_refs || []),
    ...(Array.isArray(declared.adr_refs) ? declared.adr_refs : []),
    declared.waiver,
    declared.status,
    declared.reason,
    ...(planState?.critical_invariants || []),
    ...(planState?.requirement_closure || []),
  ].join("\n");
  const inlineRefs = Array.from(text.matchAll(/\bADR[-\s:]?([0-9]{4})\b/gi)).map((match) => match[1]);
  const adrRefs = Array.from(new Set([
    ...(planState?.adr_refs || []),
    ...(Array.isArray(declared.adr_refs) ? declared.adr_refs : []),
    ...inlineRefs,
  ].map((value) => String(value || "").trim()).filter(Boolean)));
  return {
    adr_refs: adrRefs,
    hasWaiver: Boolean(declared.waiver) || /\b(?:adr|decision)\s+waiv(?:er|ed)\s*:/i.test(text),
    hasInvestigationStatus: ["investigating", "not-required"].includes(String(declared.status || "")) || ADR_DISCOVERY_STATUS_PATTERN.test(text),
  };
}

function buildSupersessionChains(adrs) {
  const byId = new Map(adrs.map((adr) => [adr.id, adr]));
  const replaced = new Set(adrs.flatMap((adr) => adr.supersedes || []));
  const chains = [];
  for (const adr of adrs) {
    if (!adr.id || adr.superseded_by || replaced.has(adr.id)) continue;
    const chain = [adr.id];
    let cursor = adr;
    while (cursor && cursor.supersedes && cursor.supersedes.length === 1 && byId.has(cursor.supersedes[0])) {
      const nextId = cursor.supersedes[0];
      if (chain.includes(nextId)) break;
      chain.push(nextId);
      cursor = byId.get(nextId);
    }
    if (chain.length > 1) chains.push(chain);
  }
  for (const adr of adrs) {
    if (adr.superseded_by) {
      const chain = [adr.id];
      let cursor = adr;
      while (cursor?.superseded_by && byId.has(cursor.superseded_by)) {
        const nextId = cursor.superseded_by;
        if (chain.includes(nextId)) break;
        chain.push(nextId);
        cursor = byId.get(nextId);
      }
      if (chain.length > 1 && !chains.some((existing) => existing.join(">") === chain.join(">"))) chains.push(chain);
    }
  }
  return chains.map((ids) => ({ ids, current: ids[ids.length - 1], history: ids.slice(0, -1) }));
}

function buildMissingAdrTickets(boardPath, plansDir, acceptedAdrIds, acceptedAdrIdsByTicket = new Map()) {
  const board = readJsonIfPresent(boardPath, null);
  if (!board) return [];
  return collectBoardRows(board)
    .map((row) => {
      const status = String(row.Status || "").toLowerCase();
      if (["done", "deferred", "superseded"].includes(status)) return null;
      const planState = readPlanState(plansDir, row.ID);
      if (!ticketRequiresAdrDecision(row, planState)) return null;
      const evidence = readAdrDecisionEvidence(planState);
      const accepted = evidence.adr_refs.map(normalizeAdrRef).filter((id) => id && acceptedAdrIds.has(id));
      const directlyLinkedAccepted = acceptedAdrIdsByTicket.get(row.ID) || [];
      const satisfied = accepted.length > 0 || directlyLinkedAccepted.length > 0 || evidence.hasWaiver || evidence.hasInvestigationStatus;
      if (satisfied) return null;
      return {
        ticket: row.ID,
        repo: row.Repo || null,
        type: row.Type || null,
        status: row.Status || null,
        reason: resolveAdrRequiredReason(row, planState),
        adr_refs: evidence.adr_refs,
        missing_adr_refs: evidence.adr_refs.filter((ref) => !acceptedAdrIds.has(normalizeAdrRef(ref))),
        commands: [
          `coord/scripts/gov adr new --title "${row.ID} decision" --ticket ${row.ID}`,
          `coord/scripts/gov adr link ${row.ID} ADR-<id>`,
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ticket.localeCompare(b.ticket));
}

function demoAdrCockpitModel() {
  return {
    accepted: {
      id: "ADR-0101",
      status: "Accepted",
      title: "Use exact-commit gate evidence",
      affected_repos: ["coord", "frontend"],
      affected_modules: ["coord/scripts/gate-runner.js", "frontend/scripts/gate.sh"],
      linked_tickets: ["DEMO-101"],
      linked_requirements: ["REQ-101"],
    },
    deferred: {
      id: "ADR-0102",
      status: "Deferred",
      title: "Do not build shared gate scheduler yet",
      revisit_trigger: "Revisit when duplicate heavy-gate cost is measured and evidence-reuse rules are property-tested.",
      linked_tickets: ["DEMO-102"],
    },
    superseded: {
      chain: ["ADR-0103", "ADR-0104"],
      history_status: "Superseded",
      current_status: "Accepted",
    },
    missing_adr: {
      ticket: "DEMO-105",
      reason: "touches high-impact decision surface \"security boundary\"",
      rendered_commands: [
        "coord/scripts/gov adr new --title \"DEMO-105 decision\" --ticket DEMO-105",
        "coord/scripts/gov adr link DEMO-105 ADR-<id>",
      ],
    },
  };
}

function buildAdrCockpitModel({ rootDir, boardPath, plansDir, demo = false }) {
  const report = validate(rootDir);
  const acceptedAdrIds = new Set(report.adrs.filter((adr) => adr.status === "Accepted").map((adr) => adr.id));
  const acceptedAdrIdsByTicket = new Map();
  for (const adr of report.adrs.filter((entry) => entry.status === "Accepted")) {
    for (const ticket of adr.tickets || []) {
      const list = acceptedAdrIdsByTicket.get(ticket) || [];
      list.push(adr.id);
      acceptedAdrIdsByTicket.set(ticket, list);
    }
  }
  const adrs = report.adrs.map((adr) => {
    const affected = parseAffectedScope(adr);
    return {
      id: `ADR-${adr.id}`,
      numeric_id: adr.id,
      title: adr.title,
      status: adr.status,
      file: adr.file,
      path: adr.path,
      affected_repos: affected.repos,
      affected_modules: affected.modules,
      linked_tickets: adr.tickets,
      linked_requirements: adr.requirement_ids,
      supersedes: (adr.supersedes || []).map((id) => `ADR-${id}`),
      superseded_by: adr.superseded_by ? `ADR-${adr.superseded_by}` : null,
      revisit_trigger: adr.revisit_trigger,
      commands: {
        show: `coord/scripts/gov adr show ${adr.id}`,
        link_ticket: `coord/scripts/gov adr link <ticket-id> ${adr.id}`,
        supersede: `coord/scripts/gov adr supersede ${adr.id} --by <new-adr-id>`,
      },
    };
  });
  const missingAdrTickets = buildMissingAdrTickets(boardPath, plansDir, acceptedAdrIds, acceptedAdrIdsByTicket);
  return {
    kind: COCKPIT_ARTIFACT_KIND,
    schema_version: 1,
    generated_at_utc: "1970-01-01T00:00:00.000Z",
    mode: "read-only",
    source: {
      decisions_dir: rootDir,
      board: boardPath,
      plans_dir: plansDir,
    },
    summary: {
      adrs: adrs.length,
      accepted: adrs.filter((adr) => adr.status === "Accepted").length,
      deferred: adrs.filter((adr) => adr.status === "Deferred").length,
      superseded: adrs.filter((adr) => adr.status === "Superseded").length,
      missing_adr_tickets: missingAdrTickets.length,
      findings: report.summary.findings,
    },
    adrs,
    supersession_chains: buildSupersessionChains(report.adrs).map((chain) => ({
      ids: chain.ids.map((id) => `ADR-${id}`),
      current: `ADR-${chain.current}`,
      history: chain.history.map((id) => `ADR-${id}`),
    })),
    revisit_triggers: adrs
      .filter((adr) => adr.revisit_trigger)
      .map((adr) => ({ id: adr.id, title: adr.title, trigger: adr.revisit_trigger })),
    decision_required_missing_adrs: missingAdrTickets,
    commands: {
      validate: "coord/scripts/coord adr-validate --json",
      generate_readout: "coord/scripts/coord adr-validate --cockpit --json",
      create_adr: "coord/scripts/gov adr new --title \"Decision title\" --ticket <ticket-id>",
      link_adr: "coord/scripts/gov adr link <ticket-id> <adr-id>",
      supersede_adr: "coord/scripts/gov adr supersede <old-adr-id> --by <new-adr-id>",
    },
    demo: demo ? demoAdrCockpitModel() : null,
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "decision";
}

function normalizeAdrId(value) {
  const match = String(value || "").match(/(?:^|\/)([0-9]{4})(?:-|\.md$|$)/);
  return match ? match[1] : null;
}

function adrPathById(root, id) {
  const normalized = normalizeAdrId(id);
  if (!normalized) return null;
  const file = fs.readdirSync(root).find((name) => name.startsWith(`${normalized}-`) && name.endsWith(".md"));
  return file ? path.join(root, file) : null;
}

function nextAdrId(adrs) {
  const max = adrs.reduce((acc, adr) => Math.max(acc, Number.parseInt(adr.id || "0", 10) || 0), 0);
  return String(max + 1).padStart(4, "0");
}

function renderIndex(adrs) {
  const rows = adrs
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((adr) => `| [${adr.id}](./${adr.file}) | ${adr.title || "(untitled)"} | ${adr.status || "Proposed"} |`);
  return ["## Index", "", "| ADR | Title | Status |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

function updateReadmeIndex(root) {
  const readmePath = path.join(root, "README.md");
  const readme = fs.existsSync(readmePath) ? read(readmePath) : "# Decision Records (ADRs)\n\n";
  const files = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => /^[0-9]{4}-.+\.md$/.test(name)).sort()
    : [];
  const adrs = files.map((file) => parseAdr(path.join(root, file), root));
  const index = renderIndex(adrs);
  const next = readme.match(/^## Index$/m)
    ? readme.replace(/^## Index[\s\S]*$/m, index)
    : `${readme.replace(/\s+$/g, "")}\n\n${index}`;
  fs.writeFileSync(readmePath, `${next.replace(/\s+$/g, "")}\n`, "utf8");
}

function buildAdrDraft({ id, title, ticket, status = "Proposed" }) {
  return [
    `# ADR ${id}: ${title}`,
    "",
    `- **Status:** ${status}`,
    `- **Ticket:** ${ticket || "TBD"}`,
    `- **Date:** ${new Date().toISOString().slice(0, 7)}`,
    "- **Linked scope:** TBD",
    "",
    "## Context",
    "",
    "TBD.",
    "",
    "## Linked Scope",
    "",
    ticket ? `- Governing ticket: ${ticket}.` : "- Governing ticket: TBD.",
    "",
    "## Decision Criteria",
    "",
    "- TBD.",
    "",
    "## Options Evaluated",
    "",
    "- TBD.",
    "",
    "## Decision",
    "",
    "TBD.",
    "",
    "## Alternatives Rejected",
    "",
    "- TBD.",
    "",
    "## Consequences",
    "",
    "- TBD.",
    "",
  ].join("\n");
}

function parseAdrCommandArgs(argv = []) {
  const positional = [];
  const options = { dir: DEFAULT_DECISIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (["--dir", "--title", "--ticket", "--status", "--by"].includes(arg)) {
      const value = argv[++i];
      if (!value) return { error: `${arg} requires a value` };
      options[arg.slice(2)] = value;
    } else if (String(arg).startsWith("--")) {
      return { error: `Unexpected argument: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function adrSummary(root) {
  const report = validate(root);
  return report.adrs.map((adr) => ({
    id: adr.id,
    title: adr.title,
    status: adr.status,
    tickets: adr.tickets,
    file: adr.file,
    path: adr.path,
    supersedes: adr.supersedes,
    superseded_by: adr.superseded_by,
  }));
}

function printAdrPayload(payload, options = {}, log = console.log) {
  if (options.json) {
    log(JSON.stringify(payload, null, 2));
    return;
  }
  if (Array.isArray(payload)) {
    for (const adr of payload) {
      log(`${adr.id} ${adr.status} ${adr.title} (${adr.file})`);
    }
    return;
  }
  if (payload && payload.raw) {
    log(payload.raw.trimEnd());
    return;
  }
  log(JSON.stringify(payload, null, 2));
}

function requireMutation(deps, fail = (message) => { throw new Error(message); }) {
  if (typeof deps.withGovernanceMutation !== "function") {
    fail("gov adr mutation requires withGovernanceMutation.");
  }
  return deps.withGovernanceMutation;
}

function assertValidAfterMutation(root) {
  const report = validate(root);
  if (!report.summary.ok) {
    const failures = report.findings.filter((item) => item.severity === "fail");
    throw new Error(`ADR mutation produced invalid registry: ${failures.map((item) => item.code).join(", ")}`);
  }
  return report;
}

function addTicketToAdr(root, adrId, ticket) {
  const filePath = adrPathById(root, adrId);
  if (!filePath) throw new Error(`Unknown ADR "${adrId}".`);
  let raw = read(filePath);
  const tickets = parseTickets(raw);
  if (!tickets.includes(ticket)) tickets.push(ticket);
  const line = `- **Ticket:** ${tickets.sort().join(", ")}`;
  if (/^\s*-\s+\*\*Ticket:\*\*.+$/m.test(raw)) {
    raw = raw.replace(/^\s*-\s+\*\*Ticket:\*\*.+$/m, line);
  } else {
    raw = raw.replace(/^(- \*\*Status:\*\* .+)$/m, `$1\n${line}`);
  }
  if (!new RegExp(`\\b${ticket}\\b`).test(raw.match(/^## Linked Scope[\s\S]*?(?=^## |\s*$)/m)?.[0] || "")) {
    raw = raw.replace(/^## Linked Scope\s*$/m, `## Linked Scope\n\n- Linked ticket: ${ticket}.`);
  }
  fs.writeFileSync(filePath, raw, "utf8");
  return parseAdr(filePath, root);
}

function markSuperseded(root, oldId, newId) {
  const oldPath = adrPathById(root, oldId);
  const newPath = adrPathById(root, newId);
  if (!oldPath) throw new Error(`Unknown ADR "${oldId}".`);
  if (!newPath) throw new Error(`Unknown ADR "${newId}".`);
  let oldRaw = read(oldPath);
  oldRaw = oldRaw.replace(/^\s*-\s+\*\*Status:\*\*.+$/m, `- **Status:** Superseded (by ${normalizeAdrId(newId)})`);
  fs.writeFileSync(oldPath, oldRaw, "utf8");

  let newRaw = read(newPath);
  const oldNorm = normalizeAdrId(oldId);
  if (!new RegExp(`\\bsupersedes\\s+ADR\\s+${oldNorm}\\b`, "i").test(newRaw)) {
    newRaw = newRaw.replace(/^## Linked Scope\s*$/m, `## Linked Scope\n\n- Supersedes ADR ${oldNorm}.`);
    fs.writeFileSync(newPath, newRaw, "utf8");
  }
  updateReadmeIndex(root);
  return { old: parseAdr(oldPath, root), replacement: parseAdr(newPath, root) };
}

function govAdr(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  const fail = deps.fail || ((message) => { throw new Error(message); });
  const subcommand = argv[0];
  const parsed = parseAdrCommandArgs(argv.slice(1));
  if (!subcommand || subcommand === "help" || parsed.error) {
    if (parsed.error) log(`adr: ${parsed.error}`);
    log("Usage: gov adr list|show|check|new|link|supersede [options]");
    return { code: parsed.error ? 1 : 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const root = path.resolve(cwd, parsed.options.dir);

  if (subcommand === "list") {
    const list = adrSummary(root);
    printAdrPayload(list, parsed.options, log);
    return { code: 0, list };
  }
  if (subcommand === "show") {
    const id = parsed.positional[0];
    if (!id) fail("gov adr show requires <adr-id>.");
    const filePath = adrPathById(root, id);
    if (!filePath) fail(`Unknown ADR "${id}".`);
    const parsedAdr = parseAdr(filePath, root);
    printAdrPayload(parsed.options.json ? parsedAdr : { ...parsedAdr, raw: parsedAdr.raw }, parsed.options, log);
    return { code: 0, adr: parsedAdr };
  }
  if (subcommand === "check") {
    const report = validate(root);
    const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
    log(body);
    return { code: report.summary.ok ? 0 : 1, report };
  }

  const withGovernanceMutation = requireMutation(deps, fail);
  if (subcommand === "new") {
    if (!parsed.options.title) fail("gov adr new requires --title.");
    const mutation = { command: "adr-new", ticket: parsed.options.ticket || null };
    return withGovernanceMutation(mutation, () => {
      fs.mkdirSync(root, { recursive: true });
      const report = validate(root);
      const status = parsed.options.status || "Proposed";
      if (!VALID_STATUSES.has(status)) fail(`Invalid ADR status "${status}".`);
      const id = nextAdrId(report.adrs);
      const file = `${id}-${slugify(parsed.options.title)}.md`;
      const filePath = path.join(root, file);
      if (fs.existsSync(filePath)) fail(`ADR file already exists: ${file}`);
      fs.writeFileSync(filePath, `${buildAdrDraft({ id, title: parsed.options.title, ticket: parsed.options.ticket, status })}\n`, "utf8");
      updateReadmeIndex(root);
      const after = assertValidAfterMutation(root);
      const created = after.adrs.find((adr) => adr.id === id);
      printAdrPayload({ status: "created", adr: created }, parsed.options, log);
      return { code: 0, adr: created };
    });
  }
  if (subcommand === "link") {
    const [ticket, adrId] = parsed.positional;
    if (!ticket || !adrId) fail("gov adr link requires <ticket-id> <adr-id>.");
    const mutation = { command: "adr-link", ticket };
    return withGovernanceMutation(mutation, () => {
      const linked = addTicketToAdr(root, adrId, ticket);
      updateReadmeIndex(root);
      assertValidAfterMutation(root);
      printAdrPayload({ status: "linked", ticket, adr: linked }, parsed.options, log);
      return { code: 0, adr: linked };
    });
  }
  if (subcommand === "supersede") {
    const oldId = parsed.positional[0];
    const newId = parsed.options.by || parsed.positional[1];
    if (!oldId || !newId) fail("gov adr supersede requires <old-adr-id> --by <new-adr-id>.");
    const mutation = { command: "adr-supersede", ticket: parsed.options.ticket || null };
    return withGovernanceMutation(mutation, () => {
      const result = markSuperseded(root, oldId, newId);
      assertValidAfterMutation(root);
      printAdrPayload({ status: "superseded", ...result }, parsed.options, log);
      return { code: 0, ...result };
    });
  }
  fail(`Unknown adr subcommand "${subcommand}".`);
}

function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

function validate(rootDir) {
  const root = path.resolve(rootDir);
  const readmePath = path.join(root, "README.md");
  const findings = [];
  const readme = fs.existsSync(readmePath) ? read(readmePath) : "";
  if (!readme) findings.push(finding("fail", "missing-readme", "coord/docs/decisions/README.md is required."));
  const index = parseIndex(readme);
  const files = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => /^[0-9]{4}-.+\.md$/.test(name)).sort()
    : [];
  const adrs = files.map((file) => parseAdr(path.join(root, file), root));
  const ids = new Set();
  const byId = new Map(adrs.map((adr) => [adr.id, adr]));

  for (const adr of adrs) {
    if (!adr.id) findings.push(finding("fail", "adr-file-number-missing", "ADR filename must start with NNNN.", { file: adr.file }));
    if (ids.has(adr.id)) findings.push(finding("fail", "adr-id-duplicate", "ADR ids must be unique.", { id: adr.id, file: adr.file }));
    ids.add(adr.id);
    if (adr.heading_id !== adr.id) findings.push(finding("fail", "adr-heading-id-mismatch", "ADR heading id must match filename id.", { id: adr.id, heading_id: adr.heading_id, file: adr.file }));
    if (!VALID_STATUSES.has(adr.status)) findings.push(finding("fail", "adr-invalid-status", "ADR status must be Proposed, Accepted, Deferred, Rejected, or Superseded.", { id: adr.id, status: adr.status }));
    if (!adr.ticket) findings.push(finding("warning", "adr-missing-ticket-link", "ADR should link the governing ticket.", { id: adr.id }));
    for (const section of REQUIRED_SECTIONS) {
      if (!adr.sections.includes(section)) findings.push(finding("fail", "adr-missing-required-section", `ADR is missing required section: ${section}.`, { id: adr.id, section }));
    }
    if (adr.status === "Deferred" && !adr.sections.includes("Revisit Trigger")) {
      findings.push(finding("fail", "deferred-adr-missing-revisit-trigger", "Deferred ADRs require a Revisit Trigger section.", { id: adr.id }));
    }
    if (adr.status === "Superseded" && !adr.superseded_by) {
      findings.push(finding("fail", "superseded-adr-missing-target", "Superseded ADRs must name the replacing ADR.", { id: adr.id }));
    }
    if (adr.superseded_by && !byId.has(adr.superseded_by)) {
      findings.push(finding("fail", "superseded-by-missing-target", "Superseded-by target does not exist.", { id: adr.id, target: adr.superseded_by }));
    }
    for (const target of adr.supersedes) {
      if (!byId.has(target)) findings.push(finding("fail", "supersedes-missing-target", "Supersedes target does not exist.", { id: adr.id, target }));
    }
  }

  const indexedFiles = new Set(index.map((row) => row.file));
  for (const file of files) {
    if (!indexedFiles.has(file)) findings.push(finding("fail", "adr-missing-from-index", "ADR file is missing from README index.", { file }));
  }
  for (const row of index) {
    if (!files.includes(row.file)) findings.push(finding("fail", "adr-index-broken-link", "README index points at a missing ADR file.", { file: row.file, id: row.id }));
    const adr = byId.get(row.id);
    if (adr && row.file !== adr.file) findings.push(finding("fail", "adr-index-id-file-mismatch", "README index id/file mapping is inconsistent.", { id: row.id, file: row.file, actual: adr.file }));
    if (adr && row.status !== adr.status) findings.push(finding("warning", "adr-index-status-drift", "README index status differs from ADR status block.", { id: row.id, index_status: row.status, adr_status: adr.status }));
  }

  return {
    kind: ARTIFACT_KIND,
    schema_version: 1,
    generated_at_utc: "1970-01-01T00:00:00.000Z",
    source: { decisions_dir: rootDir, readme: path.join(rootDir, "README.md") },
    adrs: adrs.map(({ raw, ...adr }) => adr),
    index,
    findings,
    summary: {
      ok: !findings.some((item) => item.severity === "fail"),
      adrs: adrs.length,
      indexed: index.length,
      findings: findings.length,
      fail: findings.filter((item) => item.severity === "fail").length,
      warning: findings.filter((item) => item.severity === "warning").length,
    },
  };
}

function renderMarkdown(report) {
  const lines = ["# ADR Registry Validation", "", `ADRs: ${report.summary.adrs}`, `Findings: ${report.summary.findings}`, `OK: ${report.summary.ok}`, ""];
  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const item of report.findings) lines.push(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  }
  return lines.join("\n");
}

function renderCockpitMarkdown(model) {
  const lines = [
    "# ADR Cockpit Readout",
    "",
    "Mode: read-only. Run the rendered governed commands outside the UI to make changes.",
    "",
    "## Coverage",
    "",
    `- ADRs: ${model.summary.adrs}`,
    `- Accepted: ${model.summary.accepted}`,
    `- Deferred: ${model.summary.deferred}`,
    `- Superseded: ${model.summary.superseded}`,
    `- Decision-required tickets missing accepted ADRs: ${model.summary.missing_adr_tickets}`,
    "",
    "## ADR Index",
    "",
    "| ADR | Status | Tickets | Requirements | Affected repos | Affected modules |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const adr of model.adrs) {
    lines.push(`| ${adr.id} | ${adr.status || ""} | ${adr.linked_tickets.join(", ") || "-"} | ${adr.linked_requirements.join(", ") || "-"} | ${adr.affected_repos.join(", ") || "-"} | ${adr.affected_modules.join(", ") || "-"} |`);
  }
  lines.push("", "## Supersession Chains", "");
  if (model.supersession_chains.length === 0) {
    lines.push("- None.");
  } else {
    for (const chain of model.supersession_chains) lines.push(`- ${chain.ids.join(" -> ")} (current: ${chain.current})`);
  }
  lines.push("", "## Revisit Triggers", "");
  if (model.revisit_triggers.length === 0) {
    lines.push("- None.");
  } else {
    for (const item of model.revisit_triggers) lines.push(`- ${item.id}: ${item.trigger.replace(/\s+/g, " ")}`);
  }
  lines.push("", "## Decision-Required Tickets Missing ADRs", "");
  if (model.decision_required_missing_adrs.length === 0) {
    lines.push("- None.");
  } else {
    for (const ticket of model.decision_required_missing_adrs) {
      lines.push(`- ${ticket.ticket}: ${ticket.reason}`);
      for (const command of ticket.commands) lines.push(`  - ${command}`);
    }
  }
  lines.push("", "## Governed Commands", "");
  for (const [name, command] of Object.entries(model.commands)) lines.push(`- ${name}: ${command}`);
  if (model.demo) {
    lines.push(
      "",
      "## Demo Fixture",
      "",
      `- Accepted case: ${model.demo.accepted.id} (${model.demo.accepted.status})`,
      `- Deferred case: ${model.demo.deferred.id} (${model.demo.deferred.status})`,
      `- Superseded case: ${model.demo.superseded.chain.join(" -> ")}`,
      `- Missing-ADR case: ${model.demo.missing_adr.ticket}`,
    );
  }
  return lines.join("\n");
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`adr-validate: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: adr-validate [--dir coord/docs/decisions] [--json] [--output <path>] [--cockpit] [--demo]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const dir = path.resolve(cwd, parsed.options.dir);
  const boardPath = path.resolve(cwd, parsed.options.board);
  const plansDir = path.resolve(cwd, parsed.options.plans);
  const report = parsed.options.cockpit
    ? buildAdrCockpitModel({ rootDir: dir, boardPath, plansDir, demo: parsed.options.demo })
    : validate(dir);
  const body = parsed.options.json || parsed.options.output
    ? JSON.stringify(report, null, 2)
    : parsed.options.cockpit
      ? renderCockpitMarkdown(report)
      : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(cwd, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: parsed.options.cockpit || report.summary.ok ? 0 : 1, report };
}

module.exports = {
  ARTIFACT_KIND,
  COCKPIT_ARTIFACT_KIND,
  VALID_STATUSES,
  REQUIRED_SECTIONS,
  parseIndex,
  parseAdr,
  parseTickets,
  parseSectionBodies,
  validate,
  renderMarkdown,
  buildAdrCockpitModel,
  renderCockpitMarkdown,
  govAdr,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
