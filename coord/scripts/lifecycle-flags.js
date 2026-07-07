"use strict";

// B4 decomposition slice: CLI flag parsing for lifecycle subcommands,
// extracted from lifecycle.js. parseLifecycleFlags translates a verb's raw
// argv into a normalized options object; requireValue/appendValue are its
// internal helpers. Factory-injected (fail, isLegalStatus) so it stays free of
// lifecycle-module coupling.

const { defaultFail } = require("./governance-context.js");

// COORD-094: parseLifecycleFlags was a ~650-line / ~130-case switch identical
// in structure to cli.js's parseFlags — the largest single duplication cluster
// AND a top complexity hotspot. The flag spec is now DATA: three tables keyed
// by flag string, mirroring cli.js. Behavior is byte-for-byte preserved (same
// keys, same first-wins-on-duplicate, same special-case validation). These
// tables are intentionally a parallel copy of cli.js's: this module is
// DI-decoupled from cli.js (importing it would create a require cycle
// cli -> lifecycle -> lifecycle-flags -> cli), so the spec is duplicated as
// plain data, not the imperative parsing logic. The arch duplication scan no
// longer flags the two parsers because the repeated *logic* is gone.
const LIFECYCLE_VALUE_FLAGS = Object.freeze({
  "--repo": "repo", "--mode": "mode", "--owner": "owner", "--handle": "handle",
  "--provider": "provider", "--lane": "lane", "--default-repo": "defaultRepo",
  "--notes": "notes", "--session-label": "sessionLabel", "--host": "host",
  "--cwd": "cwd", "--id": "id", "--ticket": "ticket", "--pri": "pri",
  "--limit": "limit", "--why": "why", "--branch": "branch", "--title": "title",
  "--body": "body", "--method": "method", "--worktree": "worktree",
  "--source": "source", "--topic": "topic", "--depends-on": "dependsOn",
  "--parent": "dependsOn", "--relation": "relation", "--type": "type",
  "--prefix": "prefix", "--into": "into", "--description": "description",
  "--summary": "summary", "--message": "message", "-m": "message",
  "--severity": "severity", "--qref": "qref", "--round": "round",
  "--resolved": "resolved", "--from": "from", "--to": "to",
  "--question": "question", "--lens": "lens", "--diff": "diff",
  "--findings": "findings", "--verification": "verification",
  "--verdict": "verdict", "--ticket-ask": "ticketAsk",
  "--implemented": "implemented", "--not-implemented": "notImplemented",
  "--deferred-to": "deferredTo", "--closeout-verdict": "closeoutVerdict",
  "--proof-path": "proofPath", "--proof-symbol": "proofSymbol",
  "--proof-text": "proofText", "--proof-route": "proofRoute",
  "--command": "commandText", "--audit": "audit", "--coverage": "coverage",
  "--answer": "answer", "--security": "security", "--startup": "startup",
  "--traceability": "traceability", "--closeout-method": "closeoutMethod",
  "--closeout-base-ref": "closeoutBaseRef", "--provenance-note": "provenanceNote",
  "--review-profile": "reviewProfile", "--context-pack-ack": "contextPackAck",
  "--source-commit": "sourceCommit",
  "--fulfilled-by-ticket": "fulfilledByTicket",
  "--fulfilled-by-commit": "fulfilledByCommit", "--prompt": "prompt",
  "--section-heading": "sectionHeading", "--consolidated-into": "consolidatedInto",
  "--transfer-to": "transferTo", "--human-admin-override": "humanAdminOverride",
  "--commit": "commit", "--path": "path", "--agent": "agent", "--model": "model",
  "--input-tokens": "inputTokens", "--output-tokens": "outputTokens",
  "--usd": "usd", "--phase": "phase", "--by": "by", "--wave": "wave",
});

const LIFECYCLE_APPEND_FLAGS = Object.freeze({
  "--risk": "risk", "--verify": "verify", "--files": "files",
  "--baseline": "baseline", "--invariant": "invariant", "--closure": "closure",
  "--feature-proof": "featureProof", "--drop-feature-proof": "dropFeatureProof",
  "--repo-gate": "repoGate", "--rollback": "rollback",
  "--review-cycle": "reviewCycle", "--drop-file": "dropFile", "--pr": "pr",
  "--landed": "landed",
});

const LIFECYCLE_BOOL_FLAGS = Object.freeze({
  "--assign": "assign", "--no-pr": "noPr", "--not-required": "notRequired",
  "--already-landed": "alreadyLanded", "--delete-branch": "deleteBranch",
  "--draft": "draft", "--closeout-blocker": "closeoutBlocker", "--fill": "fill",
  "--push": "push", "--autofill-startup": "autofillStartup", "--seed": "seed",
  "--all": "all", "--admin": "admin", "--handoff": "handoff",
  "--no-sync": "noSync", "--force": "force", "--fix": "fix", "--fresh": "fresh",
  "--clear": "clear", "--yes": "yes", "--include-blocked": "includeBlocked",
  "--full": "full", "--write": "write", "--dry-run": "dryRun",
  "--scope-self": "scopeSelf", "--json": "json", "--md": "md",
  "--record": "record", "--force-live": "forceLive",
  // COORD-222: opt out of the fail-closed "one governed writer per
  // checkout/runtime" guard on `gov start` / `gov claim` (default fail-closed).
  "--allow-shared-worktree": "allowSharedWorktree",
});

module.exports = function createLifecycleFlags(deps = {}) {
  const fail = deps.fail || defaultFail;
  const { isLegalStatus, LEGAL_FINDING_STATUSES } = deps;

  // COORD-094: data-driven parser (see tables above). The handful of flags with
  // bespoke logic stay in this small SPECIAL map closed over fail/isLegalStatus.
  const SPECIAL = {
    "--status": (parsed, arg, next) => {
      requireValue(arg, next);
      if (!isLegalStatus(next) && !LEGAL_FINDING_STATUSES.has(next)) {
        fail(`Invalid status "${next}".`);
      }
      parsed.status = next;
      return true;
    },
    "--base": (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.base = next;
      parsed.baseExplicit = true;
      return true;
    },
    "--reason": (parsed, arg, next) => { requireValue(arg, next); parsed.reason = next; return true; },
    "--note": (parsed, arg, next) => { requireValue(arg, next); parsed.note = next; return true; },
    "--result": (parsed, arg, next) => {
      requireValue(arg, next);
      if (next !== "pass" && next !== "fail") fail(`--result must be "pass" or "fail".`);
      parsed.gateResult = next;
      return true;
    },
    "--base-result": (parsed, arg, next) => {
      requireValue(arg, next);
      if (next !== "pass" && next !== "fail") fail(`--base-result must be "pass" or "fail".`);
      parsed.gateBaseResult = next;
      return true;
    },
    "--replace-review-cycle": (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.replaceReviewCycle = parseInt(next, 10);
      return true;
    },
    "--drop-review-cycle": (parsed, arg, next) => {
      requireValue(arg, next);
      parsed.dropReviewCycle = parseInt(next, 10);
      return true;
    },
  };

  function parseLifecycleFlags(args) {
    const parsed = {};
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const next = args[index + 1];
      if (Object.prototype.hasOwnProperty.call(SPECIAL, arg)) {
        SPECIAL[arg](parsed, arg, next);
        index += 1;
      } else if (Object.prototype.hasOwnProperty.call(LIFECYCLE_VALUE_FLAGS, arg)) {
        requireValue(arg, next);
        parsed[LIFECYCLE_VALUE_FLAGS[arg]] = next;
        index += 1;
      } else if (Object.prototype.hasOwnProperty.call(LIFECYCLE_APPEND_FLAGS, arg)) {
        requireValue(arg, next);
        appendValue(parsed, LIFECYCLE_APPEND_FLAGS[arg], next);
        index += 1;
      } else if (Object.prototype.hasOwnProperty.call(LIFECYCLE_BOOL_FLAGS, arg)) {
        parsed[LIFECYCLE_BOOL_FLAGS[arg]] = true;
      } else if (arg === "--plan-update") {
        fail(
          'Unknown flag "--plan-update". ' +
          `Plan fields are updated separately: use \`coord/scripts/gov update-plan <ticket-id> --summary "..."\`, ` +
          `\`--invariant "..."\`, \`--feature-proof "..."\`, \`--repo-gate "..."\`, and \`--review-cycle "..."\` before commit/submit.`
        );
      } else {
        fail(`Unknown flag "${arg}".`);
      }
    }
    return parsed;
  }
  
  function requireValue(flag, value) {
    if (!value) {
      fail(`${flag} requires a value.`);
    }
  }
  
  function appendValue(obj, key, value) {
    if (!obj[key]) {
      obj[key] = [];
    }
    obj[key].push(value);
  }

  return { parseLifecycleFlags, requireValue, appendValue };
};
