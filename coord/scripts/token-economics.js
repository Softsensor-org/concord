"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { COORD_DIR, ROOT_DIR, state } = require("./governance-context.js");
const { readCanonicalJsonFile, readCanonicalTextFile } = require("./state-io.js");
const { STATUS } = require("./governance-constants.js");

function createTokenEconomics(deps = {}) {
  const {
    fail,
    relativeCoordPath,
    ensureCurrentAgentIdentity,
    withGovernanceMutation,
    readBoard,
    getRows,
    getTicketRef,
    readGovernanceEventLog,
    readPlanRecord,
    isRepoBackedCode,
  } = deps;

const COST_EVENT_TYPE = "cost.observed";
const LEGAL_COST_PHASES = new Set(["start", "implement", "review", "land"]);

function readModelPrices() {
  // Data-driven table; never hardcode prices in JS. Falls back to a conservative
  // built-in default ONLY when the table file is absent/unreadable, so cost
  // estimation degrades safely rather than throwing.
  const builtinDefault = { input: 15.0, output: 75.0 };
  let table = null;
  try {
    table = readCanonicalJsonFile(state.MODEL_PRICES_PATH, { allowMissing: true });
  } catch {
    table = null;
  }
  const models = table && typeof table.models === "object" && table.models ? table.models : {};
  const fallback =
    table && typeof table.default === "object" && table.default
      ? { input: Number(table.default.input), output: Number(table.default.output) }
      : { ...builtinDefault };
  return { models, fallback, source: table ? relativeCoordPath(state.MODEL_PRICES_PATH) : "builtin-default" };
}

function resolveModelPrice(model, prices) {
  // Exact (case-insensitive) key wins; else the longest matching key prefix;
  // else the documented default fallback. Returns { rate, matched }.
  const want = String(model || "").trim().toLowerCase();
  const entries = Object.entries(prices.models || {});
  let exact = null;
  let bestPrefix = null;
  for (const [key, rate] of entries) {
    const lowered = String(key).toLowerCase();
    if (lowered === want) {
      exact = { rate, matched: key };
      break;
    }
    if (want && (want.startsWith(lowered) || lowered.startsWith(want))) {
      if (!bestPrefix || lowered.length > String(bestPrefix.matched).length) {
        bestPrefix = { rate, matched: key };
      }
    }
  }
  const hit = exact || bestPrefix;
  if (hit) {
    return {
      rate: { input: Number(hit.rate.input), output: Number(hit.rate.output) },
      matched: hit.matched,
    };
  }
  return { rate: prices.fallback, matched: "default" };
}

function estimateCostUsd(model, inputTokens, outputTokens, prices) {
  const { rate, matched } = resolveModelPrice(model, prices);
  const usd =
    (Number(inputTokens) / 1_000_000) * Number(rate.input) +
    (Number(outputTokens) / 1_000_000) * Number(rate.output);
  // Round to 6 decimal places for deterministic, hash-stable reporting.
  return { usd: Math.round(usd * 1e6) / 1e6, priced_by: matched };
}

function parseNonNegativeInteger(flag, value) {
  if (value === undefined || value === null || value === "") {
    fail(`${flag} requires a non-negative integer value.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${flag} must be a non-negative integer (got "${value}").`);
  }
  return n;
}

function recordCost(ticketId, options = {}) {
  if (!ticketId) {
    fail("record-cost requires <ticket-id>.");
  }
  if (!options.model) {
    fail("record-cost requires --model <model>.");
  }
  const inputTokens = parseNonNegativeInteger("--input-tokens", options.inputTokens);
  const outputTokens = parseNonNegativeInteger("--output-tokens", options.outputTokens);
  let usd = null;
  let estimated = false;
  let pricedBy = null;
  if (options.usd !== undefined && options.usd !== null && options.usd !== "") {
    usd = Number(options.usd);
    if (!Number.isFinite(usd) || usd < 0) {
      fail(`--usd must be a non-negative number (got "${options.usd}").`);
    }
  } else {
    const prices = readModelPrices();
    const est = estimateCostUsd(options.model, inputTokens, outputTokens, prices);
    usd = est.usd;
    estimated = true;
    pricedBy = est.priced_by;
  }
  let phase = null;
  if (options.phase !== undefined && options.phase !== null && options.phase !== "") {
    if (!LEGAL_COST_PHASES.has(options.phase)) {
      fail(`--phase must be one of ${[...LEGAL_COST_PHASES].join("|")} (got "${options.phase}").`);
    }
    phase = options.phase;
  }
  // The agent attribution: explicit --agent, else the claimed session owner.
  let identity = null;
  try {
    identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
  } catch {
    identity = null;
  }
  const agent = options.agent || identity?.agent?.handle || null;

  const mutation = {
    command: "record-cost",
    ticket: ticketId,
    allowProvenanceDrift: true,
    forceLog: true,
    identity,
    details: {
      event_type: COST_EVENT_TYPE,
      cost: {
        ticket: ticketId,
        agent,
        model: options.model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        usd,
        usd_estimated: estimated,
        priced_by: pricedBy,
        phase,
      },
    },
  };
  return withGovernanceMutation(mutation, () => {
    const board = readBoard();
    if (!getTicketRef(board, ticketId)) {
      // The ledger is evidence, not a gate; an unknown ticket is a user error
      // worth surfacing, but it never mutates board/lifecycle state.
      fail(`Unknown ticket "${ticketId}".`);
    }
    console.log(JSON.stringify({
      status: "recorded",
      event_type: COST_EVENT_TYPE,
      ticket: ticketId,
      agent,
      model: options.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      usd,
      usd_estimated: estimated,
      priced_by: pricedBy,
      phase,
    }, null, 2));
  });
}

function collectCostObservations(filterTicket = null) {
  const journal = readGovernanceEventLog();
  const observations = [];
  for (const event of journal) {
    if (!event || event.result !== "succeeded") {
      continue;
    }
    const cost = event.details && event.details.event_type === COST_EVENT_TYPE
      ? event.details.cost
      : null;
    if (!cost) {
      continue;
    }
    if (filterTicket && cost.ticket !== filterTicket) {
      continue;
    }
    observations.push(cost);
  }
  return observations;
}

function aggregateCost(observations, dimension) {
  // dimension: "ticket" | "agent" | "model". Returns a deterministic,
  // key-sorted array of buckets so the JSON output is hash-stable.
  const buckets = new Map();
  for (const obs of observations) {
    let key;
    if (dimension === "agent") {
      key = obs.agent || "(unattributed)";
    } else if (dimension === "model") {
      key = obs.model || "(unknown)";
    } else {
      key = obs.ticket || "(none)";
    }
    if (!buckets.has(key)) {
      buckets.set(key, { key, observations: 0, input_tokens: 0, output_tokens: 0, usd: 0 });
    }
    const b = buckets.get(key);
    b.observations += 1;
    b.input_tokens += Number(obs.input_tokens) || 0;
    b.output_tokens += Number(obs.output_tokens) || 0;
    b.usd += Number(obs.usd) || 0;
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, usd: Math.round(b.usd * 1e6) / 1e6 }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function costReport(options = {}) {
  const dimension = options.by || "ticket";
  if (!["ticket", "agent", "model"].includes(dimension)) {
    fail('cost --by must be one of ticket|agent|model.');
  }
  const observations = collectCostObservations(options.ticket || null);
  const totals = observations.reduce(
    (acc, obs) => {
      acc.observations += 1;
      acc.input_tokens += Number(obs.input_tokens) || 0;
      acc.output_tokens += Number(obs.output_tokens) || 0;
      acc.usd += Number(obs.usd) || 0;
      return acc;
    },
    { observations: 0, input_tokens: 0, output_tokens: 0, usd: 0 }
  );
  totals.usd = Math.round(totals.usd * 1e6) / 1e6;
  const breakdown = aggregateCost(observations, dimension);
  const payload = {
    by: dimension,
    ticket_filter: options.ticket || null,
    totals,
    breakdown,
  };
  if (options.json) {
    // Deterministic, hash-stable: sorted breakdown, fixed key order, no timestamps.
    console.log(JSON.stringify(payload));
    return payload;
  }
  console.log(`Cost ledger (by ${dimension}${options.ticket ? `, ticket=${options.ticket}` : ""})`);
  console.log(
    `Totals: ${totals.observations} observation(s), ` +
    `${totals.input_tokens} in + ${totals.output_tokens} out tokens, ` +
    `$${totals.usd.toFixed(6)}`
  );
  if (breakdown.length === 0) {
    console.log("  (empty ledger)");
  } else {
    console.log("");
    for (const b of breakdown) {
      console.log(
        `  ${b.key}: ${b.observations} obs, ${b.input_tokens} in / ${b.output_tokens} out, $${b.usd.toFixed(6)}`
      );
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// COORD-027: gov precheck (TOKEN_ECONOMICS.md lever #2).
// Cheap, declarative, read-only probes classify a ticket as
// already-satisfied | partial | not-started | unknown BEFORE an agent is
// dispatched, avoiding whole (expensive) runs on already-done work. No LLM
// call is ever required: probes are grep / test / file-exists checks declared
// per-ticket. Verdict maps to a process exit code so dispatcher scripts branch
// on it. Probes never throw - failures are reported.
// ---------------------------------------------------------------------------

const PRECHECK_EXIT_CODES = {
  "already-satisfied": 0,
  partial: 10,
  "not-started": 20,
  unknown: 30,
};
const PRECHECK_PROBE_TIMEOUT_MS = 30 * 1000;

function loadTicketPrecheckProbes(ticketId) {
  // Probes are declared without code changes via a sibling
  // coord/prompts/tickets/<ID>.precheck.json, or a ```precheck fenced JSON
  // block in the ticket prompt front-matter. Sidecar wins when both exist.
  // COORD-290: resolve via the overridable PROMPTS_DIR registry (defaults to
  // COORD_DIR/prompts) so tests can sandbox these reads/writes instead of
  // touching the live coord/prompts/tickets tree.
  const sidecar = path.join(state.PROMPTS_DIR, "tickets", `${ticketId}.precheck.json`);
  if (fs.existsSync(sidecar)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      const probes = Array.isArray(parsed) ? parsed : Array.isArray(parsed.probes) ? parsed.probes : [];
      return { probes, source: relativeCoordPath(sidecar) };
    } catch (error) {
      return { probes: [], source: relativeCoordPath(sidecar), parse_error: error.message };
    }
  }
  const promptPath = path.join(state.PROMPTS_DIR, "tickets", `${ticketId}.md`);
  if (fs.existsSync(promptPath)) {
    const text = fs.readFileSync(promptPath, "utf8");
    const match = text.match(/```precheck\s*\n([\s\S]*?)\n```/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const probes = Array.isArray(parsed) ? parsed : Array.isArray(parsed.probes) ? parsed.probes : [];
        return { probes, source: `${relativeCoordPath(promptPath)} (precheck block)` };
      } catch (error) {
        return { probes: [], source: relativeCoordPath(promptPath), parse_error: error.message };
      }
    }
  }
  return { probes: [], source: null };
}

function runPrecheckProbe(probe) {
  // Returns { passed: bool, detail, error? }. Never throws; bounded by a
  // per-probe timeout. Read-only against the current working tree.
  const expect = probe && probe.expect ? String(probe.expect) : null;
  try {
    if (!probe || typeof probe !== "object" || !probe.type) {
      return { passed: false, detail: "invalid probe (missing type)", error: "schema" };
    }
    if (probe.type === "file-exists") {
      const target = path.isAbsolute(probe.path || "") ? probe.path : path.join(ROOT_DIR, probe.path || "");
      const exists = !!(probe.path && fs.existsSync(target));
      const want = expect === "absent" ? !exists : exists;
      return { passed: want, detail: `file-exists ${probe.path}: ${exists ? "present" : "absent"}` };
    }
    if (probe.type === "grep") {
      if (!probe.pattern || !probe.path) {
        return { passed: false, detail: "grep probe requires pattern and path", error: "schema" };
      }
      const target = path.isAbsolute(probe.path) ? probe.path : path.join(ROOT_DIR, probe.path);
      if (!fs.existsSync(target)) {
        const want = expect === "absent";
        return { passed: want, detail: `grep ${probe.pattern} @ ${probe.path}: file missing` };
      }
      const content = fs.readFileSync(target, "utf8");
      let found;
      try {
        found = new RegExp(probe.pattern).test(content);
      } catch {
        found = content.includes(probe.pattern);
      }
      const want = expect === "absent" ? !found : found;
      return { passed: want, detail: `grep ${probe.pattern} @ ${probe.path}: ${found ? "match" : "no-match"}` };
    }
    if (probe.type === "test") {
      if (!probe.command) {
        return { passed: false, detail: "test probe requires command", error: "schema" };
      }
      const result = spawnSync(probe.command, {
        cwd: ROOT_DIR,
        shell: true,
        encoding: "utf8",
        timeout: probe.timeout_ms || PRECHECK_PROBE_TIMEOUT_MS,
      });
      if (result.error && result.error.code === "ETIMEDOUT") {
        return { passed: false, detail: `test timed out: ${probe.command}`, error: "timeout" };
      }
      const exit = typeof result.status === "number" ? result.status : 1;
      const passed = expect === "fail" ? exit !== 0 : exit === 0;
      return { passed, detail: `test "${probe.command}" exit=${exit}` };
    }
    return { passed: false, detail: `unknown probe type "${probe.type}"`, error: "schema" };
  } catch (error) {
    // Defensive: a probe failure is reported, never fatal.
    return { passed: false, detail: `probe error: ${error.message}`, error: "exception" };
  }
}

function classifyPrecheckVerdict(probeResults) {
  if (probeResults.length === 0) {
    return "unknown";
  }
  const passed = probeResults.filter((r) => r.passed).length;
  if (passed === probeResults.length) {
    return "already-satisfied";
  }
  if (passed === 0) {
    return "not-started";
  }
  return "partial";
}

function precheck(ticketId, options = {}) {
  if (!ticketId) {
    fail("precheck requires <ticket-id>.");
  }
  const board = readBoard();
  if (!getTicketRef(board, ticketId)) {
    fail(`Unknown ticket "${ticketId}".`);
  }
  const loaded = loadTicketPrecheckProbes(ticketId);
  const probeResults = loaded.probes.map((probe) => {
    const result = runPrecheckProbe(probe);
    return {
      type: probe && probe.type ? probe.type : "(invalid)",
      expect: probe && probe.expect ? probe.expect : "present",
      passed: result.passed,
      detail: result.detail,
      error: result.error || null,
    };
  });
  // A declared-but-unparseable probe file is treated as no usable probes:
  // verdict stays unknown so we never emit a false "already-satisfied".
  const verdict = loaded.parse_error ? "unknown" : classifyPrecheckVerdict(probeResults);
  const payload = {
    ticket: ticketId,
    verdict,
    exit_code: PRECHECK_EXIT_CODES[verdict],
    probe_source: loaded.source,
    parse_error: loaded.parse_error || null,
    probes: probeResults,
  };

  if (options.record) {
    // Auditable advisory note via the journal (no board mutation).
    const mutation = {
      command: "precheck",
      ticket: ticketId,
      allowProvenanceDrift: true,
      forceLog: true,
      details: { event_type: "precheck.observed", precheck: { ticket: ticketId, verdict, probe_count: probeResults.length } },
    };
    withGovernanceMutation(mutation, () => {
      emitPrecheck(payload, options);
    });
  } else {
    emitPrecheck(payload, options);
  }
  // Exit code reflects verdict so a dispatcher can branch on it. Set on the
  // process (honored by the real CLI) and returned (read by executeCommand).
  process.exitCode = payload.exit_code;
  return payload;
}

function emitPrecheck(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`Precheck ${payload.ticket}: ${payload.verdict} (exit ${payload.exit_code})`);
  if (payload.probe_source) {
    console.log(`  probes from: ${payload.probe_source}`);
  } else {
    console.log("  no probes declared -> unknown (never a false satisfied)");
  }
  if (payload.parse_error) {
    console.log(`  probe file parse error: ${payload.parse_error}`);
  }
  for (const p of payload.probes) {
    console.log(`  [${p.passed ? "PASS" : "FAIL"}] ${p.type}: ${p.detail}${p.error ? ` (${p.error})` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// COORD-028: gov context-pack (TOKEN_ECONOMICS.md lever #3).
// Assembles a deterministic, cache-friendly per-ticket context pack so N agents
// in a wave do not each re-pay discovery. Output is split into a STABLE section
// (shared/identical across tickets - suitable for a cached prompt prefix) and a
// TICKET-SPECIFIC section. Hash-stable: sorted, no timestamps/random ordering.
// ---------------------------------------------------------------------------

// The stable shared preamble is referenced by pointer, never inlined, so it can
// live in a single cached prompt prefix shared by every ticket in a wave.
const CONTEXT_PACK_STABLE_REFERENCES = [
  "coord/docs/MULTI_AGENT_BURNIN_RUNBOOK.md",
  "coord/docs/MULTI_AGENT_TOPOLOGIES.md",
  "coord/product/TOKEN_ECONOMICS.md",
  "coord/scripts/README.md",
];

function parseTicketPromptSections(ticketId) {
  // Mines the ticket prompt for declared files (## Likely Files backtick paths),
  // acceptance criteria bullets, and linked spec section names. Degrades to
  // empty arrays when the prompt or a section is absent.
  const promptPath = path.join(state.PROMPTS_DIR, "tickets", `${ticketId}.md`);
  const result = { files: [], acceptance_criteria: [], spec_sections: [] };
  if (!fs.existsSync(promptPath)) {
    return result;
  }
  const text = fs.readFileSync(promptPath, "utf8");
  const sectionBody = (heading) => {
    const re = new RegExp(`(^|\\n)##+\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(\\n##\\s|$)`, "i");
    const m = text.match(re);
    return m ? m[2] : "";
  };
  // Files: backtick-wrapped paths on BULLET lines in the "Likely Files" /
  // "Files" section. Restricting to bullets avoids picking up incidental
  // backtick refs (e.g. a trailing "Spec of record: `X.md`" prose line).
  const filesBody = sectionBody("Likely Files") || sectionBody("Files");
  const fileSet = new Set();
  for (const line of filesBody.split("\n")) {
    if (!/^\s*-\s+/.test(line)) {
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const candidate = m[1].trim();
      // Only treat path-like tokens as files (contain a slash or a dot suffix).
      if (/[\/.]/.test(candidate) && !candidate.includes(" ")) {
        fileSet.add(candidate);
      }
    }
  }
  result.files = [...fileSet].sort();
  // Acceptance criteria: top-level bullets under the AC heading.
  const acBody = sectionBody("Acceptance Criteria");
  result.acceptance_criteria = acBody
    .split("\n")
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .filter(Boolean);
  // Linked spec section names: spec file references + "lever #N" markers.
  const specSet = new Set();
  for (const m of text.matchAll(/`?([A-Z0-9_]+\.md)`?/g)) {
    specSet.add(m[1]);
  }
  for (const m of text.matchAll(/lever\s*#\d+/gi)) {
    specSet.add(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  result.spec_sections = [...specSet].sort();
  return result;
}

const DECLARED_FILES_BOARD_FIELDS = [
  "Declared Files",
  "Declared files",
  "declared_files",
  "declaredFiles",
];

function parseDeclaredFilesValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const fileSet = new Set();
  for (const entry of values) {
    const text = String(entry || "").trim();
    if (!text) {
      continue;
    }
    for (const m of text.matchAll(/`([^`]+)`/g)) {
      const candidate = normalizePlanWaveFile(m[1]);
      if (candidate && /[\/.]/.test(candidate) && !candidate.includes(" ")) {
        fileSet.add(candidate);
      }
    }
    for (const token of text.split(/[\n,;]+/)) {
      const candidate = normalizePlanWaveFile(token.replace(/^\s*-\s*/, "").replace(/^`|`$/g, ""));
      if (candidate && /[\/.]/.test(candidate) && !candidate.includes(" ")) {
        fileSet.add(candidate);
      }
    }
  }
  return [...fileSet].sort();
}

function parseBoardDeclaredFiles(row) {
  const fileSet = new Set();
  for (const field of DECLARED_FILES_BOARD_FIELDS) {
    for (const file of parseDeclaredFilesValue(row?.[field])) {
      fileSet.add(file);
    }
  }
  return [...fileSet].sort();
}

function collectTicketDeclaredFiles(row, ticketId) {
  return [...new Set([
    ...parseTicketPromptSections(ticketId).files,
    ...parseBoardDeclaredFiles(row),
  ])].sort();
}

function normalizeProofPathForMatch(proofEntry) {
  // feature_proof entries look like "path:foo/bar.js" or "symbol:foo/bar.js#sym".
  const value = String(proofEntry || "");
  const m = value.match(/^(?:path|symbol):([^#]+)/);
  if (!m) {
    return null;
  }
  return m[1].trim();
}

function ticketFilesIntersect(ticketFiles, proofPath) {
  if (!proofPath) {
    return false;
  }
  const normalizedProof = proofPath.replace(/^\.\//, "");
  return ticketFiles.some((f) => {
    const nf = String(f).replace(/^\.\//, "");
    return nf === normalizedProof || nf.endsWith(`/${normalizedProof}`) || normalizedProof.endsWith(`/${nf}`) || normalizedProof.includes(nf) || nf.includes(normalizedProof);
  });
}

function minePriorProofsAndInvariants(ticketId, ticketFiles) {
  // Reads every landed plan record and collects feature-proofs whose file path
  // intersects this ticket's files, plus the invariants from those same tickets.
  // Deterministic: sorted by source ticket then by value.
  const proofs = [];
  const invariants = [];
  let recordFiles = [];
  try {
    recordFiles = fs.existsSync(state.PLAN_RECORDS_DIR)
      ? fs.readdirSync(state.PLAN_RECORDS_DIR).filter((f) => f.endsWith(".json")).sort()
      : [];
  } catch {
    recordFiles = [];
  }
  for (const file of recordFiles) {
    const sourceTicket = file.replace(/\.json$/, "");
    if (sourceTicket === ticketId) {
      continue; // do not mine the ticket's own record
    }
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(path.join(state.PLAN_RECORDS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const featureProofs = Array.isArray(record.feature_proof) ? record.feature_proof : [];
    let matchedThisTicket = false;
    for (const proof of featureProofs) {
      const proofPath = normalizeProofPathForMatch(proof);
      if (ticketFilesIntersect(ticketFiles, proofPath)) {
        proofs.push({ ticket: sourceTicket, proof: String(proof) });
        matchedThisTicket = true;
      }
    }
    if (matchedThisTicket) {
      const inv = Array.isArray(record.critical_invariants) ? record.critical_invariants : [];
      for (const item of inv) {
        if (item && String(item).trim()) {
          invariants.push({ ticket: sourceTicket, invariant: String(item).trim() });
        }
      }
    }
  }
  proofs.sort((a, b) => (a.ticket + a.proof < b.ticket + b.proof ? -1 : 1));
  invariants.sort((a, b) => (a.ticket + a.invariant < b.ticket + b.invariant ? -1 : 1));
  return { proofs, invariants };
}

function buildContextPack(ticketId) {
  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) {
    fail(`Unknown ticket "${ticketId}".`);
  }
  const prompt = parseTicketPromptSections(ticketId);
  const mined = minePriorProofsAndInvariants(ticketId, prompt.files);
  // STABLE section: identical across tickets in a wave (cacheable prefix).
  const stable = {
    schema_version: 1,
    description: "Shared, cache-friendly preamble. Identical across tickets in a wave; place this in a prompt-cache prefix so N agents share one cached preamble instead of each re-paying discovery.",
    shared_references: [...CONTEXT_PACK_STABLE_REFERENCES].sort(),
  };
  // TICKET-SPECIFIC section: varies per ticket.
  // file_symbols: compact API surface of declared files from code-context.js.
  // When the index exists, agents read signatures (~200 tokens) instead of
  // full source (~3 000 tokens). Silently omitted when no index is present so
  // existing context-pack callers are unaffected.
  let fileSymbols = [];
  if (prompt.files.length > 0) {
    try {
      const codeCtx = require("./code-context.js");
      fileSymbols = codeCtx.getCompactViews(prompt.files);
    } catch {
      // code-context module absent or index not built — degrade gracefully.
    }
  }
  const ticketSpecific = {
    ticket: ticketId,
    description: ref.row.Description || "",
    files: prompt.files,
    file_symbols: fileSymbols,
    acceptance_criteria: prompt.acceptance_criteria,
    spec_sections: prompt.spec_sections,
    prior_feature_proofs: mined.proofs,
    prior_invariants: mined.invariants,
  };
  return { stable, ticket_specific: ticketSpecific };
}

function contextPack(ticketId, options = {}) {
  if (!ticketId) {
    fail("context-pack requires <ticket-id>.");
  }
  const pack = buildContextPack(ticketId);
  if (options.json) {
    // Deterministic, hash-stable: fixed key order, sorted arrays, no timestamps.
    console.log(JSON.stringify(pack));
    return pack;
  }
  // Markdown (default and --md): the STABLE block first, then TICKET-SPECIFIC.
  const lines = [];
  lines.push("<!-- STABLE: shared cache-prefix; identical across tickets in a wave -->");
  lines.push("## Shared context (cacheable prefix)");
  lines.push(pack.stable.description);
  lines.push("");
  lines.push("Shared references (read these once per wave; do not inline):");
  for (const r of pack.stable.shared_references) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push("<!-- TICKET-SPECIFIC: varies per ticket -->");
  lines.push(`## Ticket context: ${pack.ticket_specific.ticket}`);
  lines.push(pack.ticket_specific.description);
  lines.push("");
  lines.push("Files:");
  if (pack.ticket_specific.files.length === 0) {
    lines.push("- (none declared)");
  } else {
    for (const f of pack.ticket_specific.files) {
      lines.push(`- ${f}`);
    }
  }
  lines.push("");
  // File symbols: compact API surface from the code index (token-saving).
  // Only rendered when the index has at least one match for the declared files.
  const syms = pack.ticket_specific.file_symbols || [];
  if (syms.length > 0) {
    lines.push("File symbols (compact; read full source only when needed):");
    for (const s of syms) {
      lines.push(`### ${s.path}  [${s.locs} lines]`);
      if (s.purpose) lines.push(`  ${s.purpose}`);
      for (const e of s.exports) {
        lines.push(`  [${e.kind}:${e.line}] ${e.sig}`);
      }
    }
    lines.push("");
  }
  lines.push("Acceptance criteria:");
  for (const ac of pack.ticket_specific.acceptance_criteria) {
    lines.push(`- ${ac}`);
  }
  lines.push("");
  lines.push("Linked spec sections:");
  for (const s of pack.ticket_specific.spec_sections) {
    lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push("Prior feature-proofs touching these files:");
  if (pack.ticket_specific.prior_feature_proofs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of pack.ticket_specific.prior_feature_proofs) {
      lines.push(`- [${p.ticket}] ${p.proof}`);
    }
  }
  lines.push("");
  lines.push("Prior invariants from those tickets:");
  if (pack.ticket_specific.prior_invariants.length === 0) {
    lines.push("- (none)");
  } else {
    for (const inv of pack.ticket_specific.prior_invariants) {
      lines.push(`- [${inv.ticket}] ${inv.invariant}`);
    }
  }
  console.log(lines.join("\n"));
  return pack;
}

// ---------------------------------------------------------------------------
// COORD-029: tier policy (TOKEN_ECONOMICS.md lever #4).
// A ticket's resolved tier routes (a) a suggested model class and (b) the
// tier-appropriate evidence-depth minimums enforced by doctor/move-review.
// SAFETY CONTRACT: a tier may only RELAX evidence depth BELOW the flat minimum.
// `standard` (and absent) keep TODAY's behavior byte-identical; `critical` is
// never weakened. Policy is data-driven in coord/product/tier-policy.json.
// ---------------------------------------------------------------------------

const TIER_POLICY_PATH = (() => path.join(COORD_DIR, "product", "tier-policy.json"));

const BUILTIN_TIER_POLICY = {
  default_tier: "standard",
  derivation: { by_pri: { P0: "critical", P1: "critical", P2: "standard", P3: "standard" } },
  tiers: {
    standard: { model_class: "standard", min_review_cycles: "today", min_feature_proofs: "today", min_critical_invariants: "today" },
    critical: { model_class: "frontier", min_review_cycles: "today", min_feature_proofs: "today", min_critical_invariants: "today" },
  },
};

function readTierPolicy() {
  // Data-driven; never hardcode policy in JS. Falls back to a conservative
  // builtin (standard==today, critical==today) ONLY if the file is unreadable,
  // so an absent policy can never silently weaken enforcement.
  const target = state.TIER_POLICY_PATH_OVERRIDE || TIER_POLICY_PATH();
  try {
    const parsed = readCanonicalJsonFile(target, { allowMissing: true });
    if (parsed && parsed.tiers && typeof parsed.tiers === "object") {
      return parsed;
    }
  } catch {
    // fall through to builtin
  }
  return BUILTIN_TIER_POLICY;
}

function resolveTicketTier(row, policy = readTierPolicy()) {
  // Explicit board `Tier` column wins when present; else derive from Pri via the
  // documented map; else the policy default (safe `standard`). Returns
  // { tier, source }.
  const defaultTier = policy.default_tier || "standard";
  const explicit = row && (row.Tier || row.tier);
  if (explicit && policy.tiers && policy.tiers[String(explicit).trim()]) {
    return { tier: String(explicit).trim(), source: "explicit" };
  }
  const pri = row && row.Pri ? String(row.Pri).trim() : null;
  const byPri = policy.derivation && policy.derivation.by_pri ? policy.derivation.by_pri : {};
  if (pri && byPri[pri] && policy.tiers && policy.tiers[byPri[pri]]) {
    return { tier: byPri[pri], source: "derived-from-pri" };
  }
  return { tier: defaultTier, source: "default" };
}

function tierEvidenceMinimums(tier, row, policy = readTierPolicy()) {
  // Resolves the tier's evidence-depth minimums, honoring the "today" sentinel
  // (= the existing flat minimum, kept byte-identical). Returns the resolved
  // tier config plus the flat ("today") baselines for reference.
  const productRepo = isRepoBackedCode(row.Repo);
  const flatReviewCycles = productRepo ? 4 : 3;
  const flatFeatureProofs = productRepo ? 1 : 0;
  const flatCriticalInvariants = productRepo ? 2 : 0;
  const config = (policy.tiers && policy.tiers[tier]) || {};
  const resolveField = (value, flat) => (value === "today" || value === undefined || value === null ? flat : Number(value));
  return {
    model_class: config.model_class || "standard",
    flat_review_cycles: flatReviewCycles,
    flat_feature_proofs: flatFeatureProofs,
    flat_critical_invariants: flatCriticalInvariants,
    min_review_cycles: resolveField(config.min_review_cycles, flatReviewCycles),
    min_feature_proofs: resolveField(config.min_feature_proofs, flatFeatureProofs),
    min_critical_invariants: resolveField(config.min_critical_invariants, flatCriticalInvariants),
  };
}

function effectiveTierMinimum(tier, fieldKey, flatValue, row, policy = readTierPolicy()) {
  // The doctor minimum for `fieldKey`. SAFETY: a tier may only LOWER the value;
  // `critical` and `standard` are pinned to the flat (today) value so they are
  // never weakened. Only a strictly-lower tier minimum (e.g. `mechanical`) takes
  // effect, and only when it is BELOW the flat value.
  if (tier === "critical" || tier === "standard") {
    return flatValue;
  }
  const mins = tierEvidenceMinimums(tier, row, policy);
  const proposed = mins[fieldKey];
  if (!Number.isFinite(proposed)) {
    return flatValue;
  }
  // Relax-only: never allow a tier to RAISE above today's flat minimum here, and
  // never below 0.
  return Math.max(0, Math.min(flatValue, proposed));
}

function tierCommand(ticketId) {
  if (!ticketId) {
    fail("tier requires <ticket-id>.");
  }
  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) {
    fail(`Unknown ticket "${ticketId}".`);
  }
  const policy = readTierPolicy();
  const resolved = resolveTicketTier(ref.row, policy);
  const mins = tierEvidenceMinimums(resolved.tier, ref.row, policy);
  const payload = {
    ticket: ticketId,
    pri: ref.row.Pri || null,
    repo: ref.row.Repo || null,
    tier: resolved.tier,
    tier_source: resolved.source,
    suggested_model_class: mins.model_class,
    required_evidence_depth: {
      review_cycles: effectiveTierMinimum(resolved.tier, "min_review_cycles", mins.flat_review_cycles, ref.row, policy),
      feature_proofs: effectiveTierMinimum(resolved.tier, "min_feature_proofs", mins.flat_feature_proofs, ref.row, policy),
      critical_invariants: effectiveTierMinimum(resolved.tier, "min_critical_invariants", mins.flat_critical_invariants, ref.row, policy),
    },
    flat_today_minimum: {
      review_cycles: mins.flat_review_cycles,
      feature_proofs: mins.flat_feature_proofs,
      critical_invariants: mins.flat_critical_invariants,
    },
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

// ---------------------------------------------------------------------------
// COORD-030: gov plan-waves (TOKEN_ECONOMICS.md lever #5).
// Computes a conflict-free parallel schedule from each ticket's declared files
// (file-overlap) and its dependsOn graph: wave N contains tickets that share no
// file with each other and whose deps are satisfied by earlier waves / done
// tickets. Repo-X tickets can parallelize only when they declare safe coord
// code/doc surfaces; global coordination state remains single-writer.
// Deterministic (stable sort by ID); no silent drops.
// ---------------------------------------------------------------------------

const REPO_X_GLOBAL_STATE_PATHS = [
  "coord/.runtime/",
  "coord/.worktrees/",
  "coord/board/",
  "coord/locks/",
  "coord/prompts/",
  "coord/rendered/",
  "coord/PLAN.md",
  "coord/QUESTIONS.md",
];

const REPO_X_SAFE_SURFACE_PREFIXES = [
  "coord/docs/",
  "coord/product/",
  "coord/scripts/",
  "coord/ui/",
];

const REPO_X_SAFE_SURFACE_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CODEX.md",
  "GEMINI.md",
  "README.md",
  "QUICKSTART.md",
  "coord/AGENTS.md",
  "coord/GOVERNANCE.md",
]);

function parseTicketDependsOn(row) {
  const raw = row && (row["Depends On"] || row.dependsOn || row.depends_on);
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z]+-\d+$/.test(s));
}

function normalizePlanWaveFile(file) {
  return String(file || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function repoXIsolationDecision(files) {
  const normalized = files.map(normalizePlanWaveFile).filter(Boolean);
  if (normalized.length === 0) {
    return {
      parallelizable: false,
      note: "repo-X: no declared files - treated as global coord-state risk, scheduled alone",
    };
  }
  const globalStatePath = normalized.find((file) =>
    REPO_X_GLOBAL_STATE_PATHS.some((entry) => file === entry.replace(/\/$/, "") || file.startsWith(entry))
  );
  if (globalStatePath) {
    return {
      parallelizable: false,
      note: `repo-X: touches global coordination state (${globalStatePath}) - scheduled alone`,
    };
  }
  const unsafePath = normalized.find((file) =>
    !REPO_X_SAFE_SURFACE_FILES.has(file) &&
    !REPO_X_SAFE_SURFACE_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  if (unsafePath) {
    return {
      parallelizable: false,
      note: `repo-X: undeclared isolation surface (${unsafePath}) - scheduled alone`,
    };
  }
  return {
    parallelizable: true,
    note: "repo-X: safe declared coord code/doc surfaces - worktree-isolated when file-disjoint",
  };
}

function planWaves(options = {}) {
  const board = readBoard();
  const allRows = getRows(board);
  const statusFilter = options.status || STATUS.TODO;
  const repoFilter = options.repo || null;

  // Candidate set: tickets matching the status (and optional repo) filter.
  const candidates = allRows
    .filter((row) => row.Status === statusFilter)
    .filter((row) => (repoFilter ? row.Repo === repoFilter : true))
    .sort((a, b) => (a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0));

  // Done tickets satisfy deps "for free" (already landed).
  const doneIds = new Set(allRows.filter((row) => row.Status === STATUS.DONE).map((row) => row.ID));

  // Resolve each candidate's files and deps once.
  const meta = new Map();
  for (const row of candidates) {
    const files = collectTicketDeclaredFiles(row, row.ID);
    meta.set(row.ID, {
      id: row.ID,
      repo: row.Repo,
      files,
      hasFiles: files.length > 0,
      deps: parseTicketDependsOn(row),
      isRepoX: row.Repo === "X",
    });
  }
  const candidateIds = new Set(candidates.map((r) => r.ID));

  const excluded = [];
  const waves = [];
  const scheduled = new Set();

  // A ticket's deps are satisfiable only if every dep is done, already
  // scheduled in an earlier wave, or a candidate still to be scheduled. A dep
  // outside the universe (not done, not a candidate) is unsatisfiable.
  const depUnsatisfiable = (m) =>
    m.deps.filter((d) => !doneIds.has(d) && !candidateIds.has(d));

  let remaining = candidates.map((r) => r.ID);
  let guard = 0;
  while (remaining.length > 0 && guard <= candidates.length + 1) {
    guard += 1;
    const wave = [];
    const waveFiles = new Set();
    const deferred = [];
    for (const id of remaining) {
      const m = meta.get(id);
      // Permanently exclude tickets whose deps can never be satisfied.
      const unsat = depUnsatisfiable(m);
      if (unsat.length > 0) {
        excluded.push({ ticket: id, reason: `unsatisfiable deps: ${unsat.join(", ")}` });
        continue;
      }
      // Deps must be satisfied by done tickets or already-scheduled earlier waves.
      const pendingDeps = m.deps.filter((d) => !doneIds.has(d) && !scheduled.has(d));
      if (pendingDeps.length > 0) {
        deferred.push(id);
        continue;
      }
      if (m.isRepoX) {
        const isolation = repoXIsolationDecision(m.files);
        if (!isolation.parallelizable) {
          if (wave.length > 0) {
            deferred.push(id);
            continue;
          }
          wave.push({ ticket: id, repo: m.repo, files: m.files, parallelizable: false, satisfied_deps: depSatisfactionMap(m, doneIds, waves), note: isolation.note });
          waveFiles.add("__repo_x_wave_lock__");
          continue;
        }
      }
      // No declared files -> potentially-conflicting: never silently assumed
      // independent. Schedule alone in its own wave (defer if wave non-empty).
      if (!m.hasFiles) {
        if (wave.length > 0) {
          deferred.push(id);
          continue;
        }
        wave.push({ ticket: id, repo: m.repo, files: [], parallelizable: false, satisfied_deps: depSatisfactionMap(m, doneIds, waves), note: "no declared files - treated as potentially-conflicting, scheduled alone" });
        waveFiles.add("__no_files_wave_lock__");
        continue;
      }
      // File-overlap check against tickets already in this wave.
      const conflicts = m.files.some((f) => waveFiles.has(f));
      if (conflicts || waveFiles.has("__repo_x_wave_lock__") || waveFiles.has("__no_files_wave_lock__")) {
        deferred.push(id);
        continue;
      }
      for (const f of m.files) {
        waveFiles.add(f);
      }
      const isolation = m.isRepoX ? repoXIsolationDecision(m.files) : null;
      wave.push({
        ticket: id,
        repo: m.repo,
        files: m.files,
        parallelizable: true,
        satisfied_deps: depSatisfactionMap(m, doneIds, waves),
        ...(isolation?.note ? { note: isolation.note } : {}),
      });
    }
    if (wave.length === 0) {
      // No progress possible (e.g. a dependency cycle among remaining tickets):
      // exclude the rest rather than loop forever - no silent drop.
      for (const id of deferred) {
        excluded.push({ ticket: id, reason: "could not be scheduled (unsatisfied/cyclic dependency among remaining tickets)" });
      }
      break;
    }
    for (const entry of wave) {
      scheduled.add(entry.ticket);
    }
    waves.push({ wave: waves.length + 1, tickets: wave });
    remaining = deferred;
  }

  const payload = {
    status_filter: statusFilter,
    repo_filter: repoFilter,
    wave_count: waves.length,
    waves,
    excluded: excluded.sort((a, b) => (a.ticket < b.ticket ? -1 : 1)),
  };
  // `silent` lets in-process composers (gov dispatch-plan) reuse the schedule
  // without emitting anything; the payload is identical to what --json prints.
  if (options.silent) {
    return payload;
  }
  if (options.json) {
    console.log(JSON.stringify(payload));
    return payload;
  }
  emitPlanWaves(payload);
  return payload;
}

function depSatisfactionMap(m, doneIds, waves) {
  // For each dep, name where it was satisfied: a done ticket or a prior wave.
  const out = {};
  for (const dep of m.deps) {
    if (doneIds.has(dep)) {
      out[dep] = STATUS.DONE;
      continue;
    }
    let where = null;
    for (const w of waves) {
      if (w.tickets.some((t) => t.ticket === dep)) {
        where = `wave ${w.wave}`;
        break;
      }
    }
    out[dep] = where || "pending";
  }
  return out;
}

function emitPlanWaves(payload) {
  console.log(`plan-waves (status=${payload.status_filter}${payload.repo_filter ? `, repo=${payload.repo_filter}` : ""}): ${payload.wave_count} wave(s)`);
  for (const w of payload.waves) {
    console.log("");
    console.log(`Wave ${w.wave}:`);
    for (const t of w.tickets) {
      const depStr = Object.keys(t.satisfied_deps).length > 0
        ? ` [deps: ${Object.entries(t.satisfied_deps).map(([d, where]) => `${d}@${where}`).join(", ")}]`
        : "";
      const noteStr = t.note ? ` (${t.note})` : "";
      console.log(`  ${t.ticket} ${t.parallelizable ? "[parallel]" : "[sequential]"}${depStr}${noteStr}`);
    }
  }
  if (payload.excluded.length > 0) {
    console.log("");
    console.log("Excluded (no silent drops):");
    for (const e of payload.excluded) {
      console.log(`  ${e.ticket}: ${e.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// COORD-357: gov sequencer-plan.
// Read-only contention-triggered integration planner. It does NOT mutate queue
// state or run gates; it identifies tickets whose final land must be sequenced
// because their declared files, dependencies, or risk class make optimistic
// independent promotion unsafe.
// ---------------------------------------------------------------------------

const SEQUENCER_DEFAULT_STATUSES = [STATUS.REVIEW, STATUS.DOING];
const MERGE_QUEUE_STATE_PATH = () => path.join(state.RUNTIME_DIR, "merge-queue.json");

function parseSequencerStatuses(rawStatus) {
  if (!rawStatus) {
    return SEQUENCER_DEFAULT_STATUSES;
  }
  return String(rawStatus)
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function sequencerRiskForTicket(meta) {
  const risks = [];
  if (meta.files.length === 0) {
    risks.push({ code: "missing_declared_files", gate_mode: "full", reason: "missing declared file surface" });
  }
  if (meta.isRepoX) {
    const isolation = repoXIsolationDecision(meta.files);
    if (!isolation.parallelizable) {
      risks.push({ code: "repo_x_sequential_surface", gate_mode: "full", reason: isolation.note });
    }
  }
  return risks;
}

function makeUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let p = parent.get(id);
    while (p !== parent.get(p)) {
      p = parent.get(p);
    }
    let current = id;
    while (parent.get(current) !== p) {
      const next = parent.get(current);
      parent.set(current, p);
      current = next;
    }
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  };
  return { find, union };
}

function sequencerGroupId(tickets) {
  const material = tickets
    .map((item) => `${item.ticket}:${item.files.join(",")}:${item.reasons.map((r) => r.code).join(",")}`)
    .sort()
    .join("|");
  return `sha256:${crypto.createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

function gateModeForReasons(reasons) {
  return reasons.some((reason) => reason.gate_mode === "full") ? "full" : "slice";
}

function buildSequencerPlan(options = {}) {
  const board = readBoard();
  const allRows = getRows(board);
  const statuses = parseSequencerStatuses(options.status);
  const repoFilter = options.repo || null;
  const candidateRows = allRows
    .filter((row) => statuses.includes(row.Status))
    .filter((row) => (repoFilter ? row.Repo === repoFilter : true))
    .sort((a, b) => (a.ID < b.ID ? -1 : a.ID > b.ID ? 1 : 0));
  const metas = new Map();
  for (const row of candidateRows) {
    const files = collectTicketDeclaredFiles(row, row.ID);
    const deps = parseTicketDependsOn(row);
    const meta = {
      ticket: row.ID,
      repo: row.Repo,
      status: row.Status,
      priority: row.Pri || "",
      owner: row.Owner || "",
      files,
      deps,
      isRepoX: row.Repo === "X",
    };
    meta.risks = sequencerRiskForTicket(meta);
    metas.set(row.ID, meta);
  }

  const ids = [...metas.keys()];
  const uf = makeUnionFind(ids);
  const reasonsByTicket = new Map(ids.map((id) => [id, []]));
  const fileOwners = new Map();
  for (const meta of metas.values()) {
    for (const file of meta.files) {
      const owner = fileOwners.get(file);
      if (owner) {
        uf.union(owner, meta.ticket);
        reasonsByTicket.get(owner).push({ code: "declared_file_overlap", gate_mode: "slice", reason: `shares ${file} with ${meta.ticket}` });
        reasonsByTicket.get(meta.ticket).push({ code: "declared_file_overlap", gate_mode: "slice", reason: `shares ${file} with ${owner}` });
      } else {
        fileOwners.set(file, meta.ticket);
      }
    }
    for (const dep of meta.deps) {
      if (metas.has(dep)) {
        uf.union(meta.ticket, dep);
        reasonsByTicket.get(meta.ticket).push({ code: "dependency_edge", gate_mode: "slice", reason: `depends on active ticket ${dep}` });
        reasonsByTicket.get(dep).push({ code: "dependency_edge", gate_mode: "slice", reason: `blocks active ticket ${meta.ticket}` });
      }
    }
    reasonsByTicket.get(meta.ticket).push(...meta.risks);
  }

  const buckets = new Map();
  for (const id of ids) {
    const root = uf.find(id);
    if (!buckets.has(root)) {
      buckets.set(root, []);
    }
    buckets.get(root).push(id);
  }

  const groups = [];
  for (const ticketIds of buckets.values()) {
    const shouldSequence = ticketIds.length > 1 || ticketIds.some((id) => reasonsByTicket.get(id).length > 0);
    if (!shouldSequence) {
      continue;
    }
    const tickets = ticketIds
      .map((id) => {
        const meta = metas.get(id);
        const reasons = reasonsByTicket.get(id)
          .sort((a, b) => (a.code + a.reason).localeCompare(b.code + b.reason));
        return {
          ticket: id,
          repo: meta.repo,
          status: meta.status,
          priority: meta.priority,
          owner: meta.owner,
          declared_files: meta.files,
          depends_on: meta.deps,
          gate_mode: gateModeForReasons(reasons),
          reasons,
        };
      })
      .sort((a, b) => {
        const depAOnB = a.depends_on.includes(b.ticket);
        const depBOnA = b.depends_on.includes(a.ticket);
        if (depAOnB !== depBOnA) {
          return depAOnB ? 1 : -1;
        }
        if (a.priority !== b.priority) {
          return a.priority < b.priority ? -1 : 1;
        }
        return a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0;
      });
    const groupGateMode = tickets.some((ticket) => ticket.gate_mode === "full") ? "full" : "slice";
    groups.push({
      overlap_group: sequencerGroupId(tickets.map((ticket) => ({
        ticket: ticket.ticket,
        files: ticket.declared_files,
        reasons: ticket.reasons,
      }))),
      gate_mode: groupGateMode,
      ticket_count: tickets.length,
      tickets,
    });
  }
  groups.sort((a, b) => {
    const aFirst = a.tickets[0]?.ticket || "";
    const bFirst = b.tickets[0]?.ticket || "";
    return aFirst < bFirst ? -1 : aFirst > bFirst ? 1 : 0;
  });
  return {
    status_filter: statuses,
    repo_filter: repoFilter,
    group_count: groups.length,
    groups,
  };
}

function sequencerPlan(options = {}) {
  const payload = buildSequencerPlan(options);
  if (options.json) {
    console.log(JSON.stringify(payload));
    return payload;
  }
  console.log(`sequencer-plan (status=${payload.status_filter.join(",")}${payload.repo_filter ? `, repo=${payload.repo_filter}` : ""}): ${payload.group_count} group(s)`);
  for (const group of payload.groups) {
    console.log("");
    console.log(`${group.overlap_group} [${group.gate_mode}]`);
    for (const ticket of group.tickets) {
      const reasons = ticket.reasons.map((entry) => entry.code).join(", ");
      console.log(`  ${ticket.ticket} ${ticket.status} ${ticket.gate_mode}${reasons ? ` (${reasons})` : ""}`);
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// COORD-388: gov merge-queue.
// Operationalizes the read-only sequencer plan into an inspectable queue state.
// It deliberately does NOT perform git merges or bypass finalize/land evidence:
// it records the deterministic integration order that land/finalize runners must
// honor when tickets contend. Disjoint/single-agent paths produce an empty queue.
// ---------------------------------------------------------------------------

function detectMergeQueueAmbiguities(group) {
  const tickets = new Set((group.tickets || []).map((ticket) => ticket.ticket));
  const ambiguous = [];
  for (const ticket of group.tickets || []) {
    for (const dep of ticket.depends_on || []) {
      if (!tickets.has(dep)) continue;
      const depTicket = (group.tickets || []).find((item) => item.ticket === dep);
      if (depTicket && (depTicket.depends_on || []).includes(ticket.ticket)) {
        const pair = [ticket.ticket, dep].sort().join("<->");
        if (!ambiguous.includes(pair)) ambiguous.push(pair);
      }
    }
  }
  return ambiguous.map((pair) => ({
    code: "ambiguous_dependency_cycle",
    reason: `active tickets have a cyclic dependency edge (${pair})`,
    next_steps: "Resolve the dependency cycle before recording or draining the merge queue.",
  }));
}

function loadExistingMergeQueue() {
  try {
    const parsed = readCanonicalJsonFile(MERGE_QUEUE_STATE_PATH(), { allowMissing: true });
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function priorEnqueuedAt(existing, ticketId) {
  for (const group of existing?.groups || []) {
    for (const ticket of group.tickets || []) {
      if (ticket.ticket === ticketId && ticket.enqueued_at) {
        return ticket.enqueued_at;
      }
    }
  }
  return null;
}

function buildMergeQueueState(options = {}) {
  const now = options.now || new Date().toISOString();
  const plan = buildSequencerPlan(options);
  const existing = options.existing || loadExistingMergeQueue();
  const groups = (plan.groups || []).map((group, groupIndex) => {
    const ambiguities = detectMergeQueueAmbiguities(group);
    const blocked = ambiguities.length > 0;
    return {
      queue_id: `mq-${String(groupIndex + 1).padStart(3, "0")}-${group.overlap_group.replace(/^sha256:/, "")}`,
      overlap_group: group.overlap_group,
      state: blocked ? "blocked" : "queued",
      gate_mode: group.gate_mode,
      ambiguous_ordering: blocked,
      ambiguities,
      contention_reason: group.tickets
        .flatMap((ticket) => ticket.reasons || [])
        .map((reason) => reason.code)
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort(),
      tickets: (group.tickets || []).map((ticket, index) => ({
        position: index + 1,
        ticket: ticket.ticket,
        repo: ticket.repo,
        status: ticket.status,
        owner: ticket.owner,
        gate_mode: ticket.gate_mode,
        declared_files: ticket.declared_files || [],
        depends_on: ticket.depends_on || [],
        reason_codes: (ticket.reasons || []).map((reason) => reason.code).sort(),
        enqueued_at: priorEnqueuedAt(existing, ticket.ticket) || now,
      })),
    };
  });
  const depth = groups.reduce((total, group) => total + group.tickets.length, 0);
  const blockedCount = groups.filter((group) => group.state === "blocked").length;
  return {
    schema_version: 1,
    queue_version: "merge-queue-v1",
    generated_at: now,
    updated_at: now,
    status_filter: plan.status_filter,
    repo_filter: plan.repo_filter,
    depth,
    group_count: groups.length,
    blocked_group_count: blockedCount,
    mode: groups.length === 0 ? "single_agent_or_disjoint_bypass" : "contention_queue",
    backpressure: depth > 0,
    groups,
  };
}

function emitMergeQueueState(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`merge-queue: ${payload.group_count} group(s), depth=${payload.depth}, blocked=${payload.blocked_group_count}`);
  if (payload.mode === "single_agent_or_disjoint_bypass") {
    console.log("  no contending tickets; single-agent/disjoint land path remains unchanged");
  }
  for (const group of payload.groups) {
    console.log(`  ${group.queue_id} ${group.state} ${group.gate_mode}`);
    for (const ticket of group.tickets) {
      console.log(`    ${ticket.position}. ${ticket.ticket} ${ticket.status} ${ticket.gate_mode} (${ticket.reason_codes.join(", ") || "contention"})`);
    }
    for (const ambiguity of group.ambiguities) {
      console.log(`    BLOCKED ${ambiguity.code}: ${ambiguity.reason}`);
    }
  }
}

function mergeQueue(options = {}) {
  const payload = buildMergeQueueState(options);
  if (options.record) {
    const mutation = {
      command: "merge-queue",
      ticket: null,
      allowProvenanceDrift: true,
      forceLog: true,
      details: {
        event_type: "merge_queue.recorded",
        merge_queue: {
          depth: payload.depth,
          group_count: payload.group_count,
          blocked_group_count: payload.blocked_group_count,
          mode: payload.mode,
        },
      },
    };
    return withGovernanceMutation(mutation, () => {
      fs.mkdirSync(path.dirname(MERGE_QUEUE_STATE_PATH()), { recursive: true });
      fs.writeFileSync(MERGE_QUEUE_STATE_PATH(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      emitMergeQueueState(payload, options);
      return payload;
    });
  }
  emitMergeQueueState(payload, options);
  return payload;
}

// ---------------------------------------------------------------------------
// COORD-031: gov dispatch-plan (TOKEN_ECONOMICS.md - wires levers #2/#3/#4/#5).
// Composes the existing levers into ONE deterministic dispatch manifest so any
// orchestrator (Claude/Codex/Gemini) consumes a single artifact and the savings
// happen automatically:
//   - waves            <- planWaves (silent reuse; conflict-free schedule + repo-X
//                         sequential rule + excluded[])
//   - precheck verdict <- the precheck probe primitives (loadTicketPrecheckProbes
//                         / runPrecheckProbe / classifyPrecheckVerdict) - NOT the
//                         precheck() CLI fn, so we never touch process.exitCode and
//                         never emit a false skip (unknown -> spawn)
//   - tier routing     <- resolveTicketTier + tierEvidenceMinimums (model class +
//                         tier-appropriate evidence depth)
//   - context-pack     <- buildContextPack (STABLE-vs-ticket-specific split kept so
//                         the orchestrator can cache the stable prefix across a wave)
// Read-only and additive: no board/lifecycle mutation, no gov-sync surface change.
// Deterministic + hash-stable: stable ID sort (inherited from planWaves), fixed key
// order, no timestamps/random - identical board -> byte-identical manifest.
// ---------------------------------------------------------------------------

// The stable, content-addressed marker an orchestrator keys its prompt cache on.
// It enumerates the shared cacheable prefix (the context-pack STABLE references),
// so the marker only changes when the shared preamble does - never per ticket.
const DISPATCH_CACHE_PREFIX_VERSION = 1;

function dispatchCachePrefixMarker() {
  const refs = [...CONTEXT_PACK_STABLE_REFERENCES].sort();
  return {
    version: DISPATCH_CACHE_PREFIX_VERSION,
    id: `coord-dispatch-stable-v${DISPATCH_CACHE_PREFIX_VERSION}`,
    description:
      "Stable cacheable prompt prefix shared by every ticket in a wave. " +
      "Place these references once in a cached prompt prefix; the per-ticket body is appended after it.",
    shared_references: refs,
  };
}

function dispatchPrecheckVerdict(ticketId) {
  // Reuse the precheck primitives WITHOUT the CLI side effects (no journal note,
  // no process.exitCode). A declared-but-unparseable probe file stays `unknown`
  // (never a false satisfied), exactly like precheck().
  const loaded = loadTicketPrecheckProbes(ticketId);
  const probeResults = loaded.probes.map((probe) => {
    const result = runPrecheckProbe(probe);
    return { passed: result.passed };
  });
  const verdict = loaded.parse_error ? "unknown" : classifyPrecheckVerdict(probeResults);
  return {
    verdict,
    probe_count: probeResults.length,
    probe_source: loaded.source,
    parse_error: loaded.parse_error || null,
  };
}

function dispatchActionForTicket(ticketId, options = {}) {
  // Maps a ticket to its dispatch action. SKIP ONLY on an explicit
  // already-satisfied verdict; every other verdict (partial / not-started /
  // unknown / no probes) is SPAWN - a missing/ambiguous signal NEVER yields a
  // false skip.
  const board = readBoard();
  const ref = getTicketRef(board, ticketId);
  if (!ref) {
    fail(`Unknown ticket "${ticketId}".`);
  }
  const pc = dispatchPrecheckVerdict(ticketId);

  // Tier -> suggested model class + tier-appropriate evidence depth (reuse).
  const policy = readTierPolicy();
  const resolvedTier = resolveTicketTier(ref.row, policy);
  const mins = tierEvidenceMinimums(resolvedTier.tier, ref.row, policy);
  const evidenceDepth = {
    review_cycles: effectiveTierMinimum(resolvedTier.tier, "min_review_cycles", mins.flat_review_cycles, ref.row, policy),
    feature_proofs: effectiveTierMinimum(resolvedTier.tier, "min_feature_proofs", mins.flat_feature_proofs, ref.row, policy),
    critical_invariants: effectiveTierMinimum(resolvedTier.tier, "min_critical_invariants", mins.flat_critical_invariants, ref.row, policy),
  };

  const entry = {
    ticket: ticketId,
    precheck: { verdict: pc.verdict, probe_count: pc.probe_count, probe_source: pc.probe_source, parse_error: pc.parse_error },
    tier: resolvedTier.tier,
    tier_source: resolvedTier.source,
    suggested_model_class: mins.model_class,
    evidence_depth: evidenceDepth,
  };

  if (pc.verdict === "already-satisfied") {
    entry.action = "skip";
    entry.reason = `precheck verdict already-satisfied (${pc.probe_count} probe(s) from ${pc.probe_source})`;
    // The exact governed follow-up so skipping is auditable, not silent.
    entry.finalize_command =
      `coord/scripts/gov finalize ${ticketId} --no-pr --already-landed ` +
      `--landed "precheck already-satisfied (${pc.probe_count} probe(s)); see ${pc.probe_source}"`;
  } else {
    entry.action = "spawn";
    if (pc.verdict === "unknown") {
      entry.reason = pc.parse_error
        ? `unparseable precheck probes -> verdict unknown; spawn (never a false skip)`
        : (pc.probe_count === 0
          ? "no probes; verdict unknown -> spawn (never a false skip)"
          : "verdict unknown -> spawn (never a false skip)");
    } else {
      entry.reason = `precheck verdict ${pc.verdict} -> spawn`;
    }
  }

  if (options.includeContextPack) {
    const pack = buildContextPack(ticketId);
    if (options.md) {
      // In --md mode the stable section lives in the shared cache prefix; the
      // per-ticket body is referenced by pointer to keep the manifest compact.
      entry.context_pack_ref = `coord/scripts/gov context-pack ${ticketId} --md`;
    } else {
      entry.context_pack = pack;
    }
  }
  return entry;
}

function dispatchPlan(options = {}) {
  // Wave schedule (reuse planWaves silently). Honors --status/--repo/--wave.
  const schedule = planWaves({ status: options.status, repo: options.repo, silent: true });

  const wantWave = options.wave !== undefined && options.wave !== null && options.wave !== ""
    ? Number(options.wave)
    : null;
  if (wantWave !== null && (!Number.isInteger(wantWave) || wantWave < 1)) {
    fail(`--wave must be a positive integer (got "${options.wave}").`);
  }

  const md = !!options.md && !options.json; // --json wins for byte-stable machine output
  const waves = [];
  for (const w of schedule.waves) {
    if (wantWave !== null && w.wave !== wantWave) {
      continue;
    }
    const tickets = w.tickets.map((t) => {
      const action = dispatchActionForTicket(t.ticket, { includeContextPack: true, md });
      return {
        ...action,
        parallelizable: t.parallelizable,
        repo: t.repo,
        files: t.files,
        satisfied_deps: t.satisfied_deps,
        wave_note: t.note || null,
      };
    });
    waves.push({ wave: w.wave, tickets });
  }

  const payload = {
    schema_version: 1,
    status_filter: schedule.status_filter,
    repo_filter: schedule.repo_filter,
    wave_filter: wantWave,
    render: md ? "md" : "json",
    cache_prefix: dispatchCachePrefixMarker(),
    wave_count: waves.length,
    waves,
    excluded: schedule.excluded,
  };

  if (options.json || (!options.md)) {
    // JSON is the default machine surface: deterministic + hash-stable.
    console.log(JSON.stringify(payload));
    return payload;
  }
  emitDispatchPlanMarkdown(payload);
  return payload;
}

function emitDispatchPlanMarkdown(payload) {
  const lines = [];
  lines.push(`# Dispatch plan (status=${payload.status_filter}${payload.repo_filter ? `, repo=${payload.repo_filter}` : ""}${payload.wave_filter ? `, wave=${payload.wave_filter}` : ""})`);
  lines.push("");
  lines.push(`Cache prefix: \`${payload.cache_prefix.id}\` (stable across the wave - cache once):`);
  for (const r of payload.cache_prefix.shared_references) {
    lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push(`${payload.wave_count} wave(s).`);
  for (const w of payload.waves) {
    lines.push("");
    lines.push(`## Wave ${w.wave}`);
    for (const t of w.tickets) {
      lines.push("");
      lines.push(`### ${t.ticket} - ${t.action.toUpperCase()} (${t.parallelizable ? "parallel" : "sequential"})`);
      lines.push(`- reason: ${t.reason}`);
      lines.push(`- tier: ${t.tier} (${t.tier_source}) -> model class \`${t.suggested_model_class}\``);
      lines.push(`- evidence depth: ${t.evidence_depth.review_cycles} review cycle(s), ${t.evidence_depth.feature_proofs} feature-proof(s), ${t.evidence_depth.critical_invariants} invariant(s)`);
      if (t.action === "skip") {
        lines.push(`- finalize: \`${t.finalize_command}\``);
      } else if (t.context_pack_ref) {
        lines.push(`- context pack: \`${t.context_pack_ref}\``);
      }
    }
  }
  if (payload.excluded.length > 0) {
    lines.push("");
    lines.push("## Excluded (no silent drops)");
    for (const e of payload.excluded) {
      lines.push(`- ${e.ticket}: ${e.reason}`);
    }
  }
  console.log(lines.join("\n"));
}



  return {
    readModelPrices,
    resolveModelPrice,
    estimateCostUsd,
    recordCost,
    collectCostObservations,
    aggregateCost,
    costReport,
    loadTicketPrecheckProbes,
    runPrecheckProbe,
    classifyPrecheckVerdict,
    precheck,
    parseTicketPromptSections,
    parseDeclaredFilesValue,
    parseBoardDeclaredFiles,
    collectTicketDeclaredFiles,
    minePriorProofsAndInvariants,
    ticketFilesIntersect,
    buildContextPack,
    contextPack,
    readTierPolicy,
    resolveTicketTier,
    tierEvidenceMinimums,
    effectiveTierMinimum,
    tierCommand,
    parseTicketDependsOn,
    repoXIsolationDecision,
    planWaves,
    buildSequencerPlan,
    sequencerPlan,
    detectMergeQueueAmbiguities,
    buildMergeQueueState,
    mergeQueue,
    dispatchCachePrefixMarker,
    dispatchPrecheckVerdict,
    dispatchActionForTicket,
    dispatchPlan,
  };
}

module.exports = createTokenEconomics;
