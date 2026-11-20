"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  isPlanScaffoldValue,
  isUnfilledPlaceholderText,
} = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/plan-scaffold-text.js"));
const { STATUS } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-constants.js"));
const { resolveEngineModule } = require("../../paths.js");
const { resolvePlanEvidence } = require(resolveEngineModule(__dirname + "/../..", "scripts/plan-evidence-supersession.js"));
const { readJson } = require("./lifecycle-utils.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const COORD_DIR = path.join(ROOT, "coord");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function meaningful(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text) && !/^not[- ]?required$/i.test(text);
}

function recordedDisposition(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text);
}

function findTicket(board, ticketId) {
  for (const section of board.sections || []) {
    for (const row of section.rows || []) {
      if (row.ID === ticketId) return row;
    }
  }
  return null;
}

function planPath(ticketId, root = ROOT) {
  return path.join(root, "coord", ".runtime", "plans", `${ticketId}.json`);
}

function readPlan(ticketId, root = ROOT) {
  return readJson(planPath(ticketId, root), {});
}

// COORD-690: a requirement_closure line that is still the engine's own scaffold
// contributes NOTHING to this gate.
//
// The bug this closes: the split below strips a leading "TODO: " so a scaffold
// line parses into a key and a value, and `meaningful()` — which rejects a value
// STARTING with "todo" — then saw "<what the ticket said to deliver>" and passed
// it. The verdict scaffold "complete | incomplete" satisfied a bare
// /complete|incomplete/ test for the same reason. An untouched closure block
// therefore reported PASS. Placeholder-ness is now decided BEFORE the marker is
// discarded, and on the value's shape as well, so removing the marker by hand
// does not launder a placeholder into evidence.
//
// A dropped line is skipped rather than recorded empty: requirement_closure is
// append-only and read by recency, so a scaffold line must not overwrite a real
// value recorded before it.
function isScaffoldClosureLine(rawLine, value, scaffoldSeed) {
  // The caller passes the non-empty, already-trimmed text that matched the
  // closure field parser, so this value is always a string here.
  const text = rawLine;
  return scaffoldSeed.has(text) ||
    isPlanScaffoldValue("requirement_closure", text) ||
    isUnfilledPlaceholderText(text) ||
    isUnfilledPlaceholderText(value);
}

function splitRequirementClosure(plan) {
  const scaffoldSeed = new Set(
    toArray(plan?.scaffold_placeholders?.requirement_closure).map((entry) => String(entry || "").trim())
  );
  const fields = {};
  for (const line of toArray(plan.requirement_closure)) {
    const text = String(line || "").trim();
    const match = text.match(/^(?:TODO:\s*)?([^:]+):\s*(.*)$/i);
    if (!match) continue;
    const value = match[2].trim();
    if (isScaffoldClosureLine(text, value, scaffoldSeed)) continue;
    fields[match[1].trim().toLowerCase()] = value;
  }
  return fields;
}

function cycleIsComplete(cycle) {
  const risks = toArray(cycle?.risks).filter(meaningful);
  return meaningful(cycle?.lens) &&
    meaningful(cycle?.diff) &&
    risks.length >= 2 &&
    meaningful(cycle?.findings) &&
    meaningful(cycle?.verification) &&
    meaningful(cycle?.verdict);
}

function gatePlanPresent(plan) {
  return Boolean(plan.gate_plan || plan.gatePlan || plan.gate_plan_receipt);
}

function businessContextDispositionPresent(plan) {
  const text = [
    ...toArray(plan.change_summary),
    ...toArray(plan.critical_invariants),
    ...toArray(plan.requirement_closure),
    JSON.stringify(plan.context_pack_ack || {}),
  ].join("\n");
  return Boolean(
    plan.business_context_disposition ||
    plan.context_pack_ack?.business_context ||
    plan.context_pack_ack?.decision ||
    /\bbusiness-context\s+(?:investigation|status|approval|approved|waiver|waived)\s*:/i.test(text) ||
    /\bdecision\s+(?:status|investigation)\s*:/i.test(text)
  );
}

function buildGuidedCloseoutReport(input = {}) {
  const root = input.root || ROOT;
  const ticketId = input.ticketId;
  if (!ticketId) throw new Error("guided-closeout requires a ticket id");
  const board = input.board || readJson(path.join(root, "coord", "board", "tasks.json"), {});
  const row = input.row || findTicket(board, ticketId) || {};
  const planInput = input.plan || readPlan(ticketId, root);
  const rawPlan = planInput ? {
    ...planInput,
    repo_gates: toArray(planInput.repo_gates).filter((entry) => typeof entry === "string"),
    verification_commands: toArray(planInput.verification_commands).filter((entry) => typeof entry === "string"),
  } : planInput;
  const plan = rawPlan ? { ...rawPlan, ...resolvePlanEvidence(rawPlan) } : rawPlan;
  const reviewReadiness = input.collectReviewPlanReadinessIssues;
  const closure = splitRequirementClosure(plan);
  const checks = [];

  function add(id, ok, message, command, severity = "blocker") {
    checks.push({
      id,
      ok: Boolean(ok),
      severity: ok ? "ok" : severity,
      message,
      command: ok ? null : command,
    });
  }

  add(
    "plan_record",
    Boolean(plan && Object.keys(plan).length),
    "canonical plan record exists",
    `coord/scripts/gov plan ${ticketId} --seed`
  );
  add(
    "review_cycles",
    toArray(plan.self_review_cycles).length >= 3 && toArray(plan.self_review_cycles).every(cycleIsComplete),
    "three structured review cycles with concrete risks are recorded",
    `coord/scripts/gov set-review-cycles ${ticketId} --replace --review-cycle "lens=contract; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass" --review-cycle "lens=security; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass" --review-cycle "lens=tests; diff=<files>; risks=<risk one>, <risk two>; findings=none; verification=<command>; verdict=pass"`
  );
  add(
    "repo_gates",
    toArray(plan.repo_gates).some(recordedDisposition),
    "repo gate evidence is recorded",
    `coord/scripts/gov update-plan ${ticketId} --repo-gate "<command and outcome>"`
  );
  add(
    "requirement_closure",
    meaningful(closure["ticket ask"]) && meaningful(closure.implemented) && /complete|incomplete/i.test(closure["closeout verdict"] || ""),
    "ticket ask, implemented work, and closeout verdict are recorded",
    `coord/scripts/gov set-requirement-closure ${ticketId} --ticket-ask "<ask>" --implemented "<implemented>" --not-implemented "none" --deferred-to "none" --closeout-verdict complete`
  );
  add(
    "feature_proof",
    toArray(plan.feature_proof).some((entry) => {
      // COORD-690: a proof must name a real path or symbol, not the scaffold's
      // "path:<repo-relative-file-that-must-exist-on-canonical-branch>" template.
      const text = String(entry || "").trim();
      return /^path:|^symbol:/i.test(text) &&
        meaningful(text) &&
        !isPlanScaffoldValue("feature_proof", text) &&
        !/<[^<>]*>/.test(text);
    }),
    "feature proof cites a path or symbol that must exist at closeout",
    `coord/scripts/gov add-feature-proof ${ticketId} --proof-path <path>`
  );
  // COORD-690: a proof that resolved only in the ticket's DIRTY WORKTREE is not
  // closeout evidence. Recording it there is legitimate — an agent writes code
  // before committing it, and refusing that would push proof-recording ahead of
  // the work — but by closeout the same proof must exist at a committed ref, or
  // what review inherits is a citation to bytes that live in one uncommitted
  // directory and nowhere else. The same holds for a proof recorded while no ref
  // was searchable at all: "unverified here" must not silently become "verified".
  //
  // This reads the ref the resolver already recorded rather than re-running git,
  // so the check is deterministic and the remediation is explicit: commit the
  // work, then re-record the proof, which re-resolves it against the branch tip.
  // Records written before feature_proof_refs existed carry no refs at all and
  // are left alone — the field's absence is not evidence of an uncommitted proof.
  const uncommittedProofs = Object.entries(plan.feature_proof_refs || {})
    .filter(([, ref]) => ref && (ref.ref_kind === "worktree" || ref.ref_kind === "unverifiable"))
    .map(([proof, ref]) => `${proof} (${ref.ref_kind})`);
  add(
    "feature_proof_committed",
    uncommittedProofs.length === 0,
    "every recorded feature proof resolves at a committed ref, not only in the working tree",
    `commit the work, then re-record: coord/scripts/gov add-feature-proof ${ticketId} --proof-path <path>  # unresolved at a committed ref: ${uncommittedProofs.join("; ")}`
  );
  add(
    "gate_plan",
    gatePlanPresent(plan),
    "gate-plan receipt has been generated after evidence changes",
    `coord/scripts/gov gate-plan ${ticketId} --write`
  );
  add(
    "business_context_disposition",
    businessContextDispositionPresent(plan),
    "business-context or decision disposition is recorded when relevant",
    `coord/scripts/gov update-plan ${ticketId} --summary "<business context/decision disposition>"`,
    "advisory"
  );

  const knownTicket = row.ID === ticketId;
  add(
    "ticket_exists",
    knownTicket,
    knownTicket ? "ticket exists on the canonical board" : "ticket is not present on the canonical board",
    `coord/scripts/gov explain ${ticketId}`
  );

  const recoveryOnly = knownTicket && row.Status === STATUS.DONE;
  const finalizeStatusEligible = knownTicket && (row.Status === STATUS.DOING || row.Status === STATUS.REVIEW);
  add(
    "finalize_status",
    finalizeStatusEligible,
    recoveryOnly
      ? "done status is not an ordinary finalize state; only idempotent recovery of a stranded finalized-plan write is available"
      : finalizeStatusEligible
        ? `status ${row.Status} is eligible for the ordinary finalize path`
        : `status ${row.Status || "unknown"} is not eligible for finalize`,
    finalizeStatusEligible ? null : `coord/scripts/gov explain ${ticketId}`
  );
  checks[checks.length - 1].recovery_only = recoveryOnly;

  if (recoveryOnly) {
    add(
      "review_plan",
      true,
      "review-plan readiness is not assessed for the done-status recovery-only path",
      null
    );
    checks[checks.length - 1].assessed = false;
  } else if (!knownTicket || typeof reviewReadiness !== "function") {
    add(
      "review_plan",
      false,
      !knownTicket
        ? "canonical review-plan readiness was not assessed because the ticket is absent from the canonical board"
        : "canonical review-plan readiness was not assessed; finalize readiness cannot be established without the production review collector",
      `coord/scripts/gov explain ${ticketId}`
    );
    checks[checks.length - 1].assessed = false;
  } else {
    const reviewIssues = reviewReadiness(ticketId, row);
    const validReviewIssues = Array.isArray(reviewIssues);
    add(
      "review_plan",
      validReviewIssues && reviewIssues.length === 0,
      !validReviewIssues
        ? "canonical review-plan collector returned an invalid result; readiness was not assessed"
        : reviewIssues.length === 0
        ? "canonical review-plan gates pass for this ticket"
        : `${reviewIssues.length} canonical review-plan gate(s) block closeout`,
      null
    );
    checks[checks.length - 1].assessed = validReviewIssues;
    checks[checks.length - 1].issues = validReviewIssues
      ? reviewIssues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        next_steps: issue.next_steps || [],
      }))
      : [];
  }

  const blockers = checks.filter((check) => !check.ok && check.severity === "blocker");
  const advisories = checks.filter((check) => !check.ok && check.severity !== "blocker");
  // Review issues are normalized to a next_steps array above before checks are
  // flattened into next_commands.
  return {
    kind: "concord.guided_closeout",
    schema_version: 1,
    ticket_id: ticketId,
    status: row.Status || "unknown",
    readiness_scope: "Reports canonical plan, status, and review-gate checks only; it does not establish overall finalize success. Finalize independently validates additional Git, remote, ownership, lock, PR, and landing conditions.",
    mode: recoveryOnly ? "idempotent_plan_recovery_only" : "ordinary_finalize_precheck",
    ready: blockers.length === 0,
    blockers,
    advisories,
    checks,
    next_commands: [...blockers, ...advisories]
      .flatMap((check) => [check.command, ...(check.issues || []).flatMap((issue) => issue.next_steps)])
      .filter(Boolean),
  };
}

function renderGuidedCloseout(report) {
  const lines = [
    "# Guided Closeout",
    "",
    `Ticket: ${report.ticket_id}`,
    `Mode: ${report.mode === "idempotent_plan_recovery_only" ? "idempotent plan recovery only" : "ordinary finalize pre-check"}`,
    `Scope: ${report.readiness_scope}`,
    `Ready: ${report.ready ? "yes" : "no"}`,
    "",
    "## Checks",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.ok ? "PASS" : check.severity.toUpperCase()}: ${check.id} - ${check.message}`);
    if (!check.ok && check.command) lines.push(`  Fix: \`${check.command}\``);
    for (const issue of check.issues || []) {
      lines.push(`  Gate ${issue.code}: ${issue.message}`);
      for (const step of issue.next_steps || []) lines.push(`    Next: \`${step}\``);
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeRuntimeReceipt(report, root = ROOT) {
  const dir = path.join(root, "coord", ".runtime", "closeout-guides");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${report.ticket_id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
}

function guidedCloseoutCommand(ticketId, options = {}, dependencies = {}) {
  const report = buildGuidedCloseoutReport({
    ticketId,
    root: options.root,
    collectReviewPlanReadinessIssues: dependencies.collectReviewPlanReadinessIssues,
  });
  if (options.write) {
    report.receipt_path = path.relative(options.root || ROOT, writeRuntimeReceipt(report, options.root)).replace(/\\/g, "/");
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderGuidedCloseout(report));
  }
  return report;
}

module.exports = {
  buildGuidedCloseoutReport,
  splitRequirementClosure,
  businessContextDispositionPresent,
  guidedCloseoutCommand,
  renderGuidedCloseout,
  writeRuntimeReceipt,
};
