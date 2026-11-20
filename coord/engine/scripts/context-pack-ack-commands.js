"use strict";
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

// COORD-723: operator surface for acknowledgements that an older writer sealed
// in a shape the canonical contract (context-pack-ack-contract.js) rejects.
//
//   scan-context-pack-acks        read-only; never writes, normalizes or coerces
//   repair-context-pack-ack       dry-run unless --confirm; the replacement is
//                                 ALWAYS operator-authored
//
// There is no "fix it for me" mode on purpose. Turning a legacy string into a
// one-element array would satisfy the schema while recording an acknowledgement
// nobody made, so the only repair is a whole replacement object supplied by the
// operator and validated by the same contract every other consumer uses.

const fs = require("node:fs");
const path = require("node:path");
const { COORD_DIR, defaultFail, state } = require("./governance-context.js");
const { STATUS } = require("./governance-constants.js");
const { createBusinessContextGate } = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/gates/business-context.js"));
const {
  contextPackAckViolation,
  planRecordsDirs,
  readStoredContextPackAck,
  repairCommand,
  scanContextPackAcks,
} = require("./context-pack-ack-contract.js");

function scanContextPackAcksCommand(options = {}) {
  const report = scanContextPackAcks(options.recordsDirs || planRecordsDirs(state));
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Scanned ${report.records_scanned} plan record(s); ${report.acknowledgements} carry a context_pack_ack; ${report.malformed_count} malformed.`);
    for (const entry of report.malformed) {
      console.log(`- ${entry.ticket}: ${entry.violation}`);
      console.log(`  Record: ${entry.path}`);
      console.log(`  Repair: ${entry.repair}`);
    }
  }
  // A malformed record is a failed verdict, so the scan can gate an upgrade.
  if (report.malformed_count > 0) process.exitCode = 1;
  return report;
}

function parseReplacement(raw, fail) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  if (typeof text === "string" && text.toLowerCase() === "none") return { clear: true, value: undefined };
  let value = text;
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch (error) {
      fail(`--context-pack-ack expects a JSON object (or "none"): ${error.message}`);
    }
  }
  const violation = contextPackAckViolation(value);
  if (violation) fail(`repair-context-pack-ack replacement is itself invalid: ${violation}`);
  return { clear: false, value };
}

function repairContextPackAckCommand(ticketId, options = {}, dependencies = {}) {
  const fail = dependencies.fail || defaultFail;
  if (!ticketId) fail("repair-context-pack-ack requires <ticket-id>.");
  if (options.contextPackAck === undefined) {
    fail(`repair-context-pack-ack requires --context-pack-ack '<schema-valid JSON>' (or "none" to remove the acknowledgement). Nothing is derived from the stored value.`);
  }
  const stored = readStoredContextPackAck(ticketId, options.recordsDirs || planRecordsDirs(state));
  if (!stored.filePath) fail(`No plan record found for ${ticketId}.`);
  if (!stored.violation) {
    fail(`Plan record for ${ticketId} has no malformed context_pack_ack to repair. Use coord/scripts/gov update-plan ${ticketId} --context-pack-ack '<json>' for an ordinary rewrite.`);
  }
  const replacement = parseReplacement(options.contextPackAck, fail);
  const report = {
    kind: "concord.context_pack_ack_repair",
    schema_version: 1,
    ticket: ticketId,
    path: stored.filePath,
    mode: options.confirm ? "apply" : "dry-run",
    violation: stored.violation,
    stored: stored.ack,
    replacement: replacement.clear ? null : replacement.value,
    written: false,
  };
  if (!options.confirm) {
    report.apply = `${repairCommand(ticketId)} --confirm`;
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const { updatePlanBlock } = dependencies;
  updatePlanBlock(ticketId, {
    contextPackAck: replacement.clear ? "none" : replacement.value,
    ...(options.humanAdminOverride ? { humanAdminOverride: options.humanAdminOverride } : {}),
  }, () => {
    report.written = true;
    console.log(JSON.stringify(report, null, 2));
  });
  return report;
}

// ---------------------------------------------------------------------------
// COORD-557: dedicated authoring verb.
//
//   set-context-pack-ack <id>                       read-only: shows what must be acknowledged
//   set-context-pack-ack <id> --considered <section>=<text> ... --learning <decision>
//   set-context-pack-ack <id> --not-applicable --reason "<why>"
//
// DESIGN CONSTRAINT (do not relax): refs are machine-filled and every non-empty
// pack section is DISPLAYED with its item ids, but the text of every considered
// section comes from the operator. A mode that copied pack items into
// considered.* would satisfy the gate while recording an acknowledgement nobody
// made, and the board would look clean. So there is no --from-pack, and a
// missing section is a refusal, never a default.

const CONSIDERED_SECTIONS = ["active_constraints", "adrs", "business_rules", "conflicts", "stale_warnings", "open_questions"];
const LEARNING_DECISIONS = ["promote", "demote", "scratch-only", "mixed", "none"];
// Display hint only: which pack section an acknowledgement field answers. The
// review gate stays the authority on what is mandatory.
const PACK_SECTION_ANSWERED_BY = { conflicts: "conflicts", stale_sources: "stale_warnings", open_questions: "open_questions" };
// One of the literals the gate's own none-pattern recognizes, so a
// not-applicable acknowledgement over a pack that DOES contain conflicts, stale
// sources or open questions is refused by the gate's mandatory-section check
// rather than by a second rule here.
const NOT_APPLICABLE_VALUE = "n/a";

// The canonical ref/pack readers, taken from the business-context gate module
// itself. Only its two pure readers are used; nothing here evaluates the gate.
const { readBusinessContextEvidence, readBusinessContextPack } = createBusinessContextGate({
  COORD_DIR, STATUS, fs, path,
});

function toList(value) {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((entry) => String(entry || "").trim()).filter(Boolean);
}

function readStoredPlan(ticketId, recordsDirs) {
  for (const recordsDir of recordsDirs.filter(Boolean)) {
    const filePath = path.join(recordsDir, `${ticketId}.json`);
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return null;
}

// Refs come from the plan evidence (invariants, summary, closure ...), never
// from the acknowledgement being replaced.
function machineFilledRefs(plan) {
  return readBusinessContextEvidence({ ...plan, context_pack_ack: undefined }).refs;
}

function describePacks(refs) {
  return refs.map((ref) => {
    const pack = readBusinessContextPack(ref);
    if (!pack.ok) return { ref, readable: false, error: pack.error, sections: [] };
    const sections = Object.entries(pack.value?.sections || {})
      .map(([name, section]) => ({ name, items: Array.isArray(section?.items) ? section.items : [] }))
      .filter((section) => section.items.length > 0)
      .map((section) => ({
        section: section.name,
        acknowledged_by: PACK_SECTION_ANSWERED_BY[section.name] ? `considered.${PACK_SECTION_ANSWERED_BY[section.name]}` : null,
        item_ids: section.items.map((item) => String(item?.id || item?.record_id || item?.source_record_id || "<no id>")),
      }));
    return { ref, readable: true, sections };
  });
}

function authoringTemplate(ticketId) {
  return `coord/scripts/gov set-context-pack-ack ${ticketId} ${CONSIDERED_SECTIONS.map((section) => `--considered ${section}="<your text>"`).join(" ")} --authority "<authority relied on>" --advisory-only "<advisory item>" --learning <${LEARNING_DECISIONS.join("|")}> --rationale "<why>"`;
}

function parseConsidered(entries, fail) {
  const considered = {};
  for (const entry of toList(entries)) {
    const separator = entry.indexOf("=");
    const section = separator > 0 ? entry.slice(0, separator).trim() : "";
    const text = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!CONSIDERED_SECTIONS.includes(section)) {
      fail(`--considered expects <section>=<text> with section one of: ${CONSIDERED_SECTIONS.join(", ")}. Received "${entry}".`);
    }
    if (!text) fail(`--considered ${section}= requires operator text.`);
    (considered[section] = considered[section] || []).push(text);
  }
  return considered;
}

function setContextPackAckCommand(ticketId, options = {}, dependencies = {}) {
  const fail = dependencies.fail || defaultFail;
  if (!ticketId) fail("set-context-pack-ack requires <ticket-id>.");
  const plan = readStoredPlan(ticketId, options.recordsDirs || planRecordsDirs(state));
  if (!plan) fail(`No plan record found for ${ticketId}. Seed one first: coord/scripts/gov plan ${ticketId} --seed`);
  const refs = machineFilledRefs(plan);
  const authoring = ["considered", "authority", "advisoryOnly", "learning", "rationale"].filter((key) => options[key] !== undefined);

  if (!options.notApplicable && authoring.length === 0) {
    const report = {
      kind: "concord.context_pack_ack_authoring",
      schema_version: 1,
      ticket: ticketId,
      written: false,
      refs,
      packs: describePacks(refs),
      stored: plan.context_pack_ack === undefined ? null : plan.context_pack_ack,
      operator_text_required_for: CONSIDERED_SECTIONS.map((section) => `considered.${section}`),
      author: authoringTemplate(ticketId),
      not_applicable: `coord/scripts/gov set-context-pack-ack ${ticketId} --not-applicable --reason "<why no context applies>"`,
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  let ack;
  let disposition;
  if (options.notApplicable) {
    if (authoring.length > 0) fail("set-context-pack-ack --not-applicable cannot be combined with --considered, --authority, --advisory-only, --learning or --rationale.");
    const reason = String(options.reason || "").trim();
    if (!reason) fail('set-context-pack-ack --not-applicable requires --reason "<why no context applies>".');
    disposition = { disposition: "not-applicable", reason };
    ack = {
      ...(refs.length > 0 ? { refs } : {}),
      considered: Object.fromEntries(CONSIDERED_SECTIONS.map((section) => [section, [NOT_APPLICABLE_VALUE]])),
      authority: { constraints: [], advisory_only: [] },
      closeout_learning: { decision: "none", rationale: `not-applicable: ${reason}` },
    };
  } else {
    const considered = parseConsidered(options.considered, fail);
    const missing = CONSIDERED_SECTIONS.filter((section) => !considered[section]);
    if (missing.length > 0) {
      fail(`set-context-pack-ack requires operator text for every section; missing: ${missing.join(", ")}. Nothing is filled from the pack. Run "coord/scripts/gov set-context-pack-ack ${ticketId}" to see what each section must answer.`);
    }
    if (!LEARNING_DECISIONS.includes(options.learning)) {
      fail(`set-context-pack-ack requires --learning <${LEARNING_DECISIONS.join("|")}>.`);
    }
    const rationale = String(options.rationale || "").trim();
    ack = {
      ...(refs.length > 0 ? { refs } : {}),
      considered: Object.fromEntries(CONSIDERED_SECTIONS.map((section) => [section, considered[section]])),
      authority: { constraints: toList(options.authority), advisory_only: toList(options.advisoryOnly) },
      closeout_learning: { decision: options.learning, ...(rationale ? { rationale } : {}) },
    };
  }

  const { updatePlanBlock } = dependencies;
  const report = { kind: "concord.context_pack_ack_authoring", schema_version: 1, ticket: ticketId, written: false, ...(disposition || {}), context_pack_ack: ack };
  updatePlanBlock(ticketId, {
    contextPackAck: ack,
    ...(disposition ? { contextPackAckDisposition: disposition } : {}),
    ...(options.humanAdminOverride ? { humanAdminOverride: options.humanAdminOverride } : {}),
  }, () => {
    report.written = true;
    console.log(JSON.stringify(report, null, 2));
  });
  return report;
}

module.exports = {
  setContextPackAckCommand,
  repairContextPackAckCommand,
  scanContextPackAcksCommand,
};
