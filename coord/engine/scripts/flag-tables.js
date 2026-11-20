"use strict";

// COORD-984 (ARCH-AUDIT F-04): the single definition of the CLI flag data tables
// that cli.js and lifecycle-flags.js share. Each entry maps a flag token to the
// parsed option key it produces. An entry lives here only when BOTH parsers
// define it identically, so every verb keeps accepting exactly the same flags.
// A flag only one parser accepts stays in that parser's own table. Both parsers
// share the table walk and flag handlers, keeping their accepted flags and
// unknown-flag diagnostics local.
//
// A flag added to the CLI surface must be added here (or to the owning
// consumer's local table) exactly once. Duplicating it in cli.js or
// lifecycle-flags.js fails flag-tables.test.js.

const { buildInvalidStatusMessage, buildInvalidFindingSeverityMessage, findingSeveritySet } = require("./governance-constants.js");

const FINDING_SEVERITIES = findingSeveritySet();

const SHARED_VALUE_FLAGS = Object.freeze({
  "--repo": "repo", "--mode": "mode", "--owner": "owner", "--handle": "handle",
  "--provider": "provider", "--lane": "lane", "--default-repo": "defaultRepo", "--notes": "notes",
  "--session-label": "sessionLabel", "--host": "host", "--cwd": "cwd", "--id": "id",
  "--ticket": "ticket", "--pri": "pri", "--limit": "limit", "--why": "why",
  "--ids": "ids", "--branch": "branch", "--title": "title", "--body": "body",
  "--method": "method", "--worktree": "worktree", "--source": "source", "--topic": "topic",
  "--relation": "relation", "--type": "type", "--prefix": "prefix", "--into": "into",
  "--description": "description", "--description-file": "descriptionFile", "--body-file": "bodyFile", "--reason-file": "reasonFile",
  "--summary-file": "summaryFile", "--human-admin-override-file": "humanAdminOverrideFile", "--expect-paths-file": "expectPathsFile", "--summary": "summary",
  "--message": "message", "-m": "message", "--severity": "severity", "--qref": "qref",
  "--round": "round", "--resolved": "resolved", "--from": "from", "--to": "to",
  "--question": "question", "--lens": "lens", "--diff": "diff", "--findings": "findings",
  "--verification": "verification", "--verdict": "verdict", "--ticket-ask": "ticketAsk", "--implemented": "implemented",
  "--not-implemented": "notImplemented", "--deferred-to": "deferredTo", "--closeout-verdict": "closeoutVerdict", "--proof-path": "proofPath",
  "--proof-symbol": "proofSymbol", "--proof-text": "proofText", "--proof-route": "proofRoute", "--command": "commandText",
  "--audit": "audit", "--coverage": "coverage", "--kind": "kind", "--entry": "entry",
  "--replacement": "replacement", "--answer": "answer", "--security": "security", "--live-mcp": "liveMcp",
  "--decision-context": "decisionContext", "--decision-context-file": "decisionContext",
  "--startup": "startup", "--expected-row-digest": "expectedRowDigest", "--traceability": "traceability", "--closeout-method": "closeoutMethod",
  "--closeout-base-ref": "closeoutBaseRef", "--provenance-note": "provenanceNote", "--review-profile": "reviewProfile", "--context-pack-ack": "contextPackAck",
  "--learning": "learning", "--rationale": "rationale", "--gate-plan": "gatePlan", "--bootstrap-risk": "bootstrapRisk",
  "--decision-required": "decisionRequired", "--source-commit": "sourceCommit", "--correct-merge": "correctMerge", "--correction-ticket": "correctionTicket",
  "--fulfilled-by-ticket": "fulfilledByTicket", "--fulfilled-by-commit": "fulfilledByCommit", "--prompt": "prompt", "--section-heading": "sectionHeading",
  "--consolidated-into": "consolidatedInto", "--transfer-to": "transferTo", "--human-admin-override": "humanAdminOverride", "--commit": "commit",
  "--path": "path", "--agent": "agent", "--model": "model", "--input-tokens": "inputTokens",
  "--output-tokens": "outputTokens", "--expected-prefix-hash": "expectedPrefixHash", "--used-prefix-hash": "usedPrefixHash", "--usd": "usd",
  "--phase": "phase", "--by": "by", "--wave": "wave", "--dispatch-execution-id": "dispatchExecutionId",
  "--attempt-id": "attemptId", "--measurement-source": "measurementSource", "--usage-scope": "usageScope", "--unknown-reason": "unknownReason",
});

const SHARED_APPEND_FLAGS = Object.freeze({
  "--ack-outside-scope": "ackOutsideScope", "--risk": "risk", "--verify": "verify", "--files": "files",
  "--baseline": "baseline", "--invariant": "invariant", "--closure": "closure", "--closure-file": "closure",
  "--feature-proof": "featureProof", "--drop-feature-proof": "dropFeatureProof", "--repo-gate": "repoGate", "--rollback": "rollback",
  "--adr-ref": "adrRef", "--review-cycle": "reviewCycle", "--review-cycle-file": "reviewCycle", "--drop-file": "dropFile",
  "--pr": "pr", "--landed": "landed", "--landed-file": "landed", "--evidence": "evidence",
  "--considered": "considered", "--authority": "authority", "--advisory-only": "advisoryOnly",
});

const SHARED_SCALAR_TEXT_FILE_FIELDS = Object.freeze({
  "--reason-file": "reason", "--summary-file": "summary", "--human-admin-override-file": "humanAdminOverride", "--expect-paths-file": "expectPaths",
  "--decision-context-file": "decisionContext",
});

const SHARED_BOOL_FLAGS = Object.freeze({
  "--assign": "assign", "--no-pr": "noPr", "--not-required": "notRequired", "--not-applicable": "notApplicable",
  "--already-landed": "alreadyLanded", "--delete-branch": "deleteBranch", "--merge-workspace": "mergeWorkspace", "--draft": "draft",
  "--closeout-blocker": "closeoutBlocker", "--fill": "fill", "--push": "push", "--seed": "seed",
  "--all": "all", "--admin": "admin", "--handoff": "handoff", "--no-sync": "noSync",
  "--force": "force", "--fix": "fix", "--fresh": "fresh", "--clear": "clear",
  "--yes": "yes", "--include-blocked": "includeBlocked", "--full": "full", "--write": "write",
  "--dry-run": "dryRun", "--scope-self": "scopeSelf", "--json": "json", "--md": "md",
  "--record": "record", "--force-live": "forceLive", "--allow-shared-worktree": "allowSharedWorktree",
});

function appendValue(obj, key, value) {
  if (!obj[key]) {
    obj[key] = [];
  }
  obj[key].push(value);
}

function createSharedSpecialFlags({ fail, requireValue, isLegalStatus, LEGAL_FINDING_STATUSES }) {
  return {
    status: (parsed, arg, next) => {
      requireValue(arg, next);
      if (!isLegalStatus(next) && !LEGAL_FINDING_STATUSES.has(next)) {
        fail(buildInvalidStatusMessage(next, LEGAL_FINDING_STATUSES));
      }
      parsed.status = next;
    },
    base: (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.base = next;
      parsed.baseExplicit = true;
    },
    reason(parsed, arg, next) {
      requireValue(arg, next);
      parsed.reason = next;
    },
    note(parsed, arg, next) {
      requireValue(arg, next);
      parsed.note = next;
    },
    selectionManifest(parsed, arg, next) {
      requireValue(arg, next);
      parsed.selectionManifest = next;
    },
    result: (parsed, arg, next) => {
      requireValue(arg, next);
      if (next !== "pass" && next !== "fail") fail(`--result must be one of: pass | fail.`);
      parsed.gateResult = next;
    },
    baseResult: (parsed, arg, next) => {
      requireValue(arg, next);
      if (next !== "pass" && next !== "fail") fail(`--base-result must be one of: pass | fail.`);
      parsed.gateBaseResult = next;
    },
    replaceReviewCycle: (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.replaceReviewCycle = parseInt(next, 10);
    },
    dropReviewCycle: (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.dropReviewCycle = parseInt(next, 10);
    },
    // COORD-717: refuse an out-of-vocabulary finding severity at parse time,
    // before any governed mutation starts, and name the value received.
    severity: (parsed, arg, next) => {
      requireValue(arg, next);
      if (!FINDING_SEVERITIES.has(next)) fail(buildInvalidFindingSeverityMessage(next));
      parsed.severity = next;
    },
  };
}

function parseFlagTables(args, {
  valueFlags, appendFlags, boolFlags, scalarTextFields, specialFlags,
  fail, requireValue, readUtf8TextFile, unknownSuffix = () => "",
}) {
  const parsed = {};
  const scalarTextFileKeys = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--reason" && scalarTextFileKeys.has("reason")) {
      fail(`${arg} cannot be combined with its file flag.`);
    } else if (Object.prototype.hasOwnProperty.call(specialFlags, arg)) {
      specialFlags[arg](parsed, arg, next);
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(valueFlags, arg)) {
      requireValue(arg, next);
      const key = scalarTextFields[arg];
      if (key) {
        if (Object.prototype.hasOwnProperty.call(parsed, key) && !scalarTextFileKeys.has(key)) {
          fail(`${arg} cannot be combined with its inline flag.`);
        }
        parsed[key] = readUtf8TextFile(next, arg);
        scalarTextFileKeys.add(key);
      } else {
        const valueKey = valueFlags[arg];
        if (scalarTextFileKeys.has(valueKey)) fail(`${arg} cannot be combined with its file flag.`);
        parsed[valueKey] = next;
      }
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(appendFlags, arg)) {
      requireValue(arg, next);
      const value = arg === "--closure-file" || arg === "--review-cycle-file" || arg === "--landed-file"
        ? readUtf8TextFile(next, arg)
        : next;
      appendValue(parsed, appendFlags[arg], value);
      index += 1;
    } else if (Object.prototype.hasOwnProperty.call(boolFlags, arg)) {
      parsed[boolFlags[arg]] = true;
    } else if (arg === "--plan-update") {
      fail(
        'Unknown flag "--plan-update". ' +
        `Plan fields are updated separately: use \`coord/scripts/gov update-plan <ticket-id> --summary "..."\`, ` +
        `\`--invariant "..."\`, \`--feature-proof "..."\`, \`--repo-gate "..."\`, and \`--review-cycle "..."\` before commit/submit.`
      );
    } else {
      fail(`Unknown flag "${arg}".${unknownSuffix(arg)}`);
    }
  }
  return parsed;
}

module.exports = {
  appendValue,
  createSharedSpecialFlags,
  parseFlagTables,
  SHARED_VALUE_FLAGS,
  SHARED_APPEND_FLAGS,
  SHARED_SCALAR_TEXT_FILE_FIELDS,
  SHARED_BOOL_FLAGS,
};
