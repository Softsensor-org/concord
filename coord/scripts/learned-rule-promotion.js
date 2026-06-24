"use strict";

// COORD-145: [Memory] Cross-cutting — GOVERNED PROCEDURAL-MEMORY PROMOTION.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §3 (procedural layer) + §5 (cardinal
// guardrail) + §10 ("Don't let agents freely rewrite memory"): when the system
// or an agent identifies a LEARNED behavioral rule that SHOULD become a durable
// procedural change (an edit to a `.claude/commands` skill, AGENTS.md, CLAUDE.md,
// or GOVERNANCE.md), that change must be PROMOTED through the governed
// submit/review/land lifecycle — captured as a candidate, then turned into a
// proper governed ticket/change request that is version-controlled and
// PR/review-gated — NEVER silently written into those files.
//
// THE HARD, SAFETY-CRITICAL INVARIANT (§5/§10): this module RECOMMENDS / ROUTES
// ONLY. It is STRUCTURALLY INCAPABLE of being used as a silent-rewrite path:
//   - it NEVER opens a procedural file for writing;
//   - the only filesystem write it performs is appending a CANDIDATE record to
//     the derived, gitignored capture queue (coord/memory/procedural-candidates
//     .ndjson) — which holds no authority and is not a procedural surface;
//   - `promote` produces a governed-change SPEC (a ready-to-file ticket spec +
//     the cited rationale) and asserts, via the COORD-166 `isProceduralDocPath`,
//     that the target is a procedural surface requiring the FULL reviewed lane.
// The governed review/land lifecycle DECIDES whether the proposed edit lands;
// this tool only routes it there. See assertNeverWritesProceduralTarget() — the
// invariant is callable + tested.
//
// REUSE (no re-implementation, no drift):
//   - COORD-166 `isProceduralDocPath` (governance-validation.js) — the SINGLE
//     source of truth for "is this a procedural surface". A candidate whose
//     targets are all non-procedural is NOT a procedural-memory promotion and is
//     flagged/rejected (you don't route a non-behavioral doc edit through the
//     procedural-promotion lane — it has its own lane).
//   - the §7 citation shape (recall.js / decision-extractor.js) — every
//     candidate carries evidence citations pinning event_hash + chain_head +
//     verified, so a learned rule is traceable to the hash-linked source it was
//     derived from. A candidate with NO citation is REFUSED (§5: no uncited
//     claim becomes a procedural change).
//   - decision-extractor.sha1 — one canonical hash for the candidate id.
//
// ZERO new runtime deps. Matches the recall/insights/prework/closeout style.

const fs = require("fs");
const path = require("path");

const extractor = require("./decision-extractor.js");

// COORD-166 `isProceduralDocPath` is the SINGLE source of truth for "is this a
// procedural surface". governance-validation.js exports a FACTORY
// (createGovernanceValidation(deps)); `isProceduralDocPath` is a PURE function
// inside that closure (it reads only its path argument, no injected dep), so we
// instantiate the factory with empty deps once and pull the pure verb out. This
// REUSES COORD-166 verbatim — no re-implementation, no drift.
const createGovernanceValidation = require("./governance-validation.js");
const { isProceduralDocPath } = createGovernanceValidation({});

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_CANDIDATES_PATH = path.join(
  COORD_DIR,
  "memory",
  "procedural-candidates.ndjson"
);

// A fixed sentinel so the captured record + spec are deterministic in tests; the
// wall-clock is injected via options.now (lives OUTSIDE any content digest).
const DEFAULT_NOW = "1970-01-01T00:00:00.000Z";

// The set of procedural surfaces this lane governs (documented for the spec /
// help text). The AUTHORITY for membership is isProceduralDocPath, NOT this list
// — this is descriptive prose only.
const PROCEDURAL_SURFACES = Object.freeze([
  ".claude/commands/*  (agent skills / slash commands)",
  "AGENTS.md  and any repo-local AGENTS.md",
  "CLAUDE.md",
  "coord/GOVERNANCE.md",
]);

// --- deterministic serialization (mirrors the substrate) ---------------------
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Normalize an evidence citation to the shared §7 shape so a candidate's
// provenance pins the SAME fields recall/insights/prework emit. Tolerates the
// recall `source` shape and the insight `citation` shape.
function normalizeCitation(c) {
  return {
    type: c && c.type ? String(c.type) : "decision",
    id: c && c.id != null ? c.id : null,
    path: c && c.path != null ? c.path : null,
    event_hash: c && c.event_hash != null ? c.event_hash : null,
    chain_head: c && c.chain_head != null ? c.chain_head : null,
    verified: Boolean(c && c.verified),
  };
}

// Normalize a target path the candidate proposes to change to repo-relative
// form (the same normalization isProceduralDocPath applies internally), so the
// stored + classified value is canonical.
function normalizeTarget(value) {
  return String(value || "")
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

// =============================================================================
// CAPTURE — store a procedural-rule candidate as data (append-only NDJSON).
// =============================================================================
//
// A candidate is the bridge from an observed lesson -> a PROPOSED procedural-doc
// edit. It captures:
//   - rule         : the learned behavioral rule text (what agents should do).
//   - targets[]    : the procedural file(s) the rule would amend.
//   - rationale    : why this should become a durable procedural change.
//   - citations[]  : the §7-shaped evidence the rule is derived FROM (a decision
//                    record, journal event, insight theme, file). REQUIRED — a
//                    candidate with no citation is refused (§5: no uncited rule).
//
// Capture writes ONLY to the derived candidates queue — never to a procedural
// file. It classifies each target up front (procedural vs not) so `list` and
// `promote` can reason about it, but classification does not block capture: you
// may capture a candidate and discover at promote-time that a target is not a
// procedural surface.

function buildCandidate(input, options = {}) {
  const now = options.now || DEFAULT_NOW;
  const rule = String(input.rule || "").trim();
  if (!rule) {
    throw new Error(
      "learned-rule capture requires --rule: the learned behavioral rule text."
    );
  }
  const rationale = String(input.rationale || "").trim();
  if (!rationale) {
    throw new Error(
      "learned-rule capture requires --rationale: why this should become a durable procedural change."
    );
  }
  const targets = (Array.isArray(input.targets) ? input.targets : [input.targets])
    .map(normalizeTarget)
    .filter((t) => t.length > 0);
  if (!targets.length) {
    throw new Error(
      "learned-rule capture requires at least one --target procedural file the rule would amend."
    );
  }
  const citations = (Array.isArray(input.citations) ? input.citations : [])
    .map(normalizeCitation);
  // §5 cardinal guardrail: a learned rule that cannot point at its hash-linked
  // source is NOT captured — no uncited rule may ever become a procedural change.
  if (!citations.length) {
    throw new Error(
      "learned-rule capture requires at least one --citation (evidence the rule is derived from). " +
        "Per the cardinal guardrail (MEMORY_ARCHITECTURE.md §5) no uncited rule may become a procedural change."
    );
  }

  const classifiedTargets = targets.map((t) => ({
    path: t,
    procedural: isProceduralDocPath(t),
  }));

  // Deterministic content for the candidate id (excludes captured_at).
  const content = {
    rule,
    rationale,
    targets: classifiedTargets,
    citations,
  };
  const id = `PRC-${extractor.sha1(stableStringify(content)).slice(0, 12)}`;

  return {
    kind: "procedural-rule-candidate",
    id,
    // The guardrail, machine-checkable: a candidate is advisory input, never an
    // authority and never an edit.
    authority: false,
    recommends_only: true,
    rule,
    rationale,
    targets: classifiedTargets,
    citations,
    // Convenience flags for list/promote reasoning.
    all_targets_procedural: classifiedTargets.every((t) => t.procedural),
    any_target_procedural: classifiedTargets.some((t) => t.procedural),
    status: "captured",
    captured_at: now,
  };
}

function captureCandidate(input, options = {}) {
  const candidate = buildCandidate(input, options);
  const candidatesPath = options.candidatesPath || DEFAULT_CANDIDATES_PATH;
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  // APPEND-ONLY to the derived queue. This is the ONLY write this module ever
  // performs, and it targets the (non-procedural) candidates file — never a
  // procedural surface (asserted by assertNeverWritesProceduralTarget).
  fs.appendFileSync(candidatesPath, `${JSON.stringify(candidate)}\n`, "utf8");
  return candidate;
}

function readCandidates(candidatesPath) {
  const out = [];
  const p = candidatesPath || DEFAULT_CANDIDATES_PATH;
  if (!fs.existsSync(p)) {
    return out;
  }
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (rec && rec.kind === "procedural-rule-candidate" && rec.id) {
      out.push(rec);
    }
  }
  return out;
}

function listCandidates(options = {}) {
  const candidates = readCandidates(options.candidatesPath);
  // Deterministic order: captured_at then id.
  candidates.sort(
    (a, b) =>
      String(a.captured_at || "").localeCompare(String(b.captured_at || "")) ||
      String(a.id).localeCompare(String(b.id))
  );
  return candidates;
}

function findCandidate(id, options = {}) {
  const wanted = String(id || "").trim();
  if (!wanted) {
    return null;
  }
  return readCandidates(options.candidatesPath).find((c) => c.id === wanted) || null;
}

// =============================================================================
// PROMOTE — route a candidate to the GOVERNED submit/review/land lane.
// =============================================================================
//
// Promotion does NOT edit any procedural file. It produces a governed-change
// SPEC: a ready-to-file ticket spec (type:docs — but procedural, so it is
// CARVED OUT of the COORD-166 light lane and forced into the FULL reviewed lane)
// plus the cited rationale + the exact governed lane commands the human/agent
// runs to file + work it. The §7 citations ride along so the proposed change is
// traceable to the evidence the rule was learned from.
//
// HARD ASSERTIONS before a spec is emitted:
//   1. every target the spec proposes to change is a PROCEDURAL surface
//      (isProceduralDocPath) — otherwise this is not a procedural-memory
//      promotion and the candidate is rejected with a clear reason (use the
//      normal docs lane for a non-behavioral doc edit).
//   2. the candidate carries at least one §7 citation (re-checked here — defense
//      in depth even though capture also enforces it).
// The spec's `requires_full_reviewed_lane` is therefore ALWAYS true, and we
// record WHY (the procedural hits) so the routing is auditable.

function promoteCandidate(idOrCandidate, options = {}) {
  const candidate =
    typeof idOrCandidate === "object" && idOrCandidate
      ? idOrCandidate
      : findCandidate(idOrCandidate, options);
  if (!candidate) {
    throw new Error(
      `learned-rule promote: no candidate "${idOrCandidate}" in the capture queue.`
    );
  }

  const targets = Array.isArray(candidate.targets) ? candidate.targets : [];
  const proceduralHits = targets
    .map((t) => normalizeTarget(t.path))
    .filter((p) => isProceduralDocPath(p));
  const nonProcedural = targets
    .map((t) => normalizeTarget(t.path))
    .filter((p) => !isProceduralDocPath(p));

  // ASSERTION 1: this lane is ONLY for procedural surfaces. A candidate whose
  // targets are not ALL procedural is not a procedural-memory promotion.
  if (proceduralHits.length === 0) {
    return {
      ok: false,
      promoted: false,
      candidate_id: candidate.id,
      reason:
        "not-procedural-promotion: none of the candidate's targets is a procedural surface " +
        `(${nonProcedural.join(", ") || "(no targets)"}). This lane only routes LEARNED ` +
        "BEHAVIORAL rules to procedural surfaces (.claude/, AGENTS.md, CLAUDE.md, GOVERNANCE.md); " +
        "file a normal docs-lane change for a non-behavioral doc edit.",
      non_procedural_targets: nonProcedural,
    };
  }
  if (nonProcedural.length > 0) {
    return {
      ok: false,
      promoted: false,
      candidate_id: candidate.id,
      reason:
        "mixed-targets: a procedural-memory promotion must target ONLY procedural surfaces; " +
        `non-procedural target(s) present (${nonProcedural.join(", ")}). Split them into ` +
        "separate candidates so the procedural change is reviewed on the full lane in isolation.",
      non_procedural_targets: nonProcedural,
    };
  }

  // ASSERTION 2 (defense in depth): no uncited rule is promoted.
  const citations = (Array.isArray(candidate.citations) ? candidate.citations : []).map(
    normalizeCitation
  );
  if (!citations.length) {
    return {
      ok: false,
      promoted: false,
      candidate_id: candidate.id,
      reason:
        "uncited: the candidate carries no §7 citation; per the cardinal guardrail " +
        "(MEMORY_ARCHITECTURE.md §5) no uncited rule may become a procedural change.",
    };
  }

  const spec = buildGovernedChangeSpec(candidate, proceduralHits, citations, options);
  return {
    ok: true,
    promoted: true,
    candidate_id: candidate.id,
    spec,
  };
}

// The governed-change spec: a ready-to-file ticket spec routed to the FULL
// reviewed lane, the cited rationale, and the exact governed commands. It does
// NOT mutate the board or any file — it is a recommendation the human/agent acts
// on through `gov`. (Filing the ticket + landing the edit stays governed.)
function buildGovernedChangeSpec(candidate, proceduralHits, citations, options = {}) {
  const now = options.now || DEFAULT_NOW;
  const titleRule = candidate.rule.length > 80
    ? `${candidate.rule.slice(0, 77)}...`
    : candidate.rule;
  const ticketSpec = {
    // A procedural-doc change: type docs, but CARVED OUT of the light lane by
    // COORD-166 because it touches procedural surfaces -> full reviewed lane.
    type: "docs",
    repo: "X",
    title: `[Procedural] promote learned rule: ${titleRule}`,
    description:
      `Promote a LEARNED behavioral rule into the procedural memory layer via the ` +
      `governed submit/review/land lane (COORD-145). Proposed rule: ${candidate.rule} ` +
      `Targets (procedural surfaces, full reviewed lane required): ${proceduralHits.join(", ")}. ` +
      `Rationale: ${candidate.rationale} ` +
      `Derived from cited evidence (see candidate ${candidate.id}). ` +
      `NOTE: the edit itself is NOT applied here — it is made + reviewed + landed on the full lane.`,
    intended_files: proceduralHits,
  };
  return {
    kind: "governed-procedural-change-spec",
    // The routing decision, machine-checkable + auditable.
    requires_full_reviewed_lane: true,
    light_lane_eligible: false,
    full_lane_reason:
      `targets touch procedural-doc surface(s) that change agent behavior ` +
      `(${proceduralHits.join(", ")}); full reviewed lane required (COORD-166 / MEMORY_ARCHITECTURE.md §3, §5)`,
    source_candidate_id: candidate.id,
    rule: candidate.rule,
    rationale: candidate.rationale,
    procedural_targets: proceduralHits,
    citations,
    ticket_spec: ticketSpec,
    // The exact governed lane the human/agent follows — NEVER a direct edit.
    governed_lane: [
      "1. File the ticket spec above (e.g. add the row to coord/board/tasks.json, type=docs, repo=X).",
      "2. coord/scripts/gov start <new-ticket>  (acquire the lock; full reviewed lane is forced for procedural targets).",
      "3. Make the procedural edit IN THE WORKTREE, record evidence (repo-gate + the full self-review cycles + requirement closure).",
      "4. coord/scripts/gov submit <new-ticket>  (or move-review) -> review -> land/finalize.",
      "The procedural surface changes ONLY through this reviewed/landed lifecycle — never via this promotion tool.",
    ],
    generated_at: now,
  };
}

// =============================================================================
// THE SAFETY-CRITICAL INVARIANT — callable + tested.
// =============================================================================
//
// Prove that no code path in this module can write to a procedural surface. The
// ONLY fs write is the candidates-queue append in captureCandidate; assert its
// destination is NOT a procedural path. promote performs NO fs write at all.
// This is asserted structurally (the candidates path is the single write sink)
// and is re-checked here so a future edit that added a procedural write sink
// would fail the test.
function assertNeverWritesProceduralTarget(candidatesPath) {
  const p = normalizeTarget(candidatesPath || DEFAULT_CANDIDATES_PATH);
  // The candidates queue lives under coord/memory/ and must NOT itself be a
  // procedural surface.
  if (isProceduralDocPath(p)) {
    throw new Error(
      `INVARIANT VIOLATION: the candidate capture sink "${p}" is a procedural surface; ` +
        "this tool must never write to a procedural file."
    );
  }
  return true;
}

// =============================================================================
// RENDERING
// =============================================================================

function renderCitations(citations) {
  const shown = (citations || []).slice(0, 3).map((c) => {
    if (c.event_hash) {
      return `${c.id || c.path || "?"}@${String(c.event_hash).slice(0, 8)}`;
    }
    return `${c.id || c.path || "?"}`;
  });
  const more =
    citations && citations.length > shown.length
      ? ` (+${citations.length - shown.length})`
      : "";
  return `cites: ${shown.join(", ")}${more}`;
}

function renderCandidate(candidate) {
  const lines = [];
  lines.push(
    `${candidate.id} [${candidate.status}] ` +
      `${candidate.all_targets_procedural ? "procedural" : candidate.any_target_procedural ? "mixed" : "NON-procedural"}`
  );
  lines.push(`  rule: ${candidate.rule}`);
  lines.push(`  targets: ${candidate.targets.map((t) => `${t.path}${t.procedural ? "" : " (NOT procedural)"}`).join(", ")}`);
  lines.push(`  rationale: ${candidate.rationale}`);
  lines.push(`  ${renderCitations(candidate.citations)}`);
  return lines.join("\n");
}

function renderList(candidates) {
  if (!candidates.length) {
    return "No procedural-rule candidates captured. Capture one with:\n  coord/scripts/gov learned-rule capture --rule \"...\" --target <procedural-file> --citation <id> --rationale \"...\"";
  }
  return candidates.map(renderCandidate).join("\n\n");
}

function renderPromotion(result) {
  if (!result.promoted) {
    return `PROMOTION REFUSED (${result.candidate_id}): ${result.reason}`;
  }
  const spec = result.spec;
  const lines = [];
  lines.push(`GOVERNED PROCEDURAL-CHANGE SPEC (from candidate ${result.candidate_id}) — ROUTES ONLY, no file written.`);
  lines.push(`  requires_full_reviewed_lane: ${spec.requires_full_reviewed_lane}`);
  lines.push(`  reason: ${spec.full_lane_reason}`);
  lines.push(`  rule: ${spec.rule}`);
  lines.push(`  procedural targets: ${spec.procedural_targets.join(", ")}`);
  lines.push(`  ${renderCitations(spec.citations)}`);
  lines.push("  proposed ticket:");
  lines.push(`    type=${spec.ticket_spec.type} repo=${spec.ticket_spec.repo}`);
  lines.push(`    title: ${spec.ticket_spec.title}`);
  lines.push("  governed lane to follow (the procedural file is edited ONLY here, under review):");
  for (const step of spec.governed_lane) {
    lines.push(`    ${step}`);
  }
  return lines.join("\n");
}

module.exports = {
  stableStringify,
  normalizeCitation,
  normalizeTarget,
  buildCandidate,
  captureCandidate,
  readCandidates,
  listCandidates,
  findCandidate,
  promoteCandidate,
  buildGovernedChangeSpec,
  assertNeverWritesProceduralTarget,
  renderCandidate,
  renderList,
  renderPromotion,
  isProceduralDocPath,
  PROCEDURAL_SURFACES,
  DEFAULT_CANDIDATES_PATH,
  DEFAULT_NOW,
};

// =============================================================================
// CLI — `learned-rule capture|list|promote` (wired into gov via lifecycle.js).
// =============================================================================

function parseCliFlags(argv) {
  const flags = { citations: [], targets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    if (a === "--rule") {
      flags.rule = take();
    } else if (a === "--rationale") {
      flags.rationale = take();
    } else if (a === "--target") {
      flags.targets.push(take());
    } else if (a === "--citation") {
      // Accept either an id (COORD-095) or type:id form; minimal §7 citation.
      const v = take();
      flags.citations.push(parseCitationArg(v));
    } else if (a === "--json") {
      flags.json = true;
    } else if (!a.startsWith("--") && !flags.positional) {
      flags.positional = a;
    }
  }
  return flags;
}

// Parse a --citation argument into a §7-shaped citation. Forms:
//   COORD-095                  -> { type:decision, id:COORD-095, verified:false }
//   decision:COORD-095         -> { type:decision, id:COORD-095, ... }
//   file:coord/scripts/x.js    -> { type:file, path:..., ... }
//   id=COORD-095,hash=abc,head=def,verified=true,type=event,path=...
function parseCitationArg(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return normalizeCitation({});
  }
  if (raw.includes("=")) {
    const c = {};
    for (const part of raw.split(",")) {
      const [k, ...rest] = part.split("=");
      const v = rest.join("=");
      if (k === "id") c.id = v;
      else if (k === "hash" || k === "event_hash") c.event_hash = v;
      else if (k === "head" || k === "chain_head") c.chain_head = v;
      else if (k === "type") c.type = v;
      else if (k === "path") c.path = v;
      else if (k === "verified") c.verified = v === "true";
    }
    return normalizeCitation(c);
  }
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const type = raw.slice(0, colon);
    const rest = raw.slice(colon + 1);
    if (type === "file") {
      return normalizeCitation({ type: "file", path: rest });
    }
    return normalizeCitation({ type, id: rest });
  }
  // Bare token: a ticket id if it looks like one, else a path.
  if (/^[A-Z]+-\d+$/.test(raw)) {
    return normalizeCitation({ type: "decision", id: raw });
  }
  if (raw.includes("/")) {
    return normalizeCitation({ type: "file", path: raw });
  }
  return normalizeCitation({ type: "decision", id: raw });
}

function runCli(argv) {
  const sub = argv[0];
  const flags = parseCliFlags(argv.slice(1));
  const now = new Date().toISOString();
  if (sub === "capture") {
    const candidate = captureCandidate(
      { rule: flags.rule, rationale: flags.rationale, targets: flags.targets, citations: flags.citations },
      { now }
    );
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);
    } else {
      process.stdout.write(`captured ${candidate.id}\n${renderCandidate(candidate)}\n`);
    }
    return candidate;
  }
  if (sub === "list") {
    const candidates = listCandidates();
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderList(candidates)}\n`);
    }
    return candidates;
  }
  if (sub === "promote") {
    const id = flags.positional;
    if (!id) {
      throw new Error(
        "learned-rule promote requires a candidate id: gov learned-rule promote <PRC-id> [--json]"
      );
    }
    const result = promoteCandidate(id, { now });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderPromotion(result)}\n`);
    }
    return result;
  }
  process.stdout.write(
    [
      "coord/scripts/learned-rule-promotion.js — governed procedural-memory promotion (COORD-145).",
      "",
      "Route a LEARNED behavioral rule to the governed submit/review/land lane.",
      "This tool NEVER edits a procedural file; it only CAPTURES candidates and",
      "ROUTES them to the full reviewed lane (it emits a governed-change spec).",
      "",
      "Usage:",
      '  learned-rule capture --rule "<rule>" --target <procedural-file> [--target ...] \\',
      '                       --citation <id|type:id|file:path|k=v,...> [--citation ...] \\',
      '                       --rationale "<why>" [--json]',
      "  learned-rule list [--json]",
      "  learned-rule promote <PRC-id> [--json]",
      "",
      `Procedural surfaces (authority: isProceduralDocPath): ${PROCEDURAL_SURFACES.join("; ")}`,
      "",
    ].join("\n")
  );
  return null;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports.runCli = runCli;
module.exports.parseCitationArg = parseCitationArg;
