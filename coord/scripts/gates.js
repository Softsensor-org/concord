"use strict";

// Wave 3 (COORD-069): repo-gate ATTRIBUTION / board-record surface extracted
// from plan-command.js — the `gov add-repo-gate` verb plus the gate-attribution
// classifier and the board-record entry formatter. DI-factory; the plan-block
// mutator (updatePlanBlock) is injected from plan-command.js so the gate entry
// lands in canonical plan state. BOUNDARY: gate-runtime.js (COORD-058) owns gate
// EXECUTION (script/invocation/artifact-dir resolution, package-manager detect,
// clean-checkout gate run); gates.js owns only the attribution + board-record
// entry-formatting surface. The two stay split.

const { defaultFail } = require("./governance-context.js");

module.exports = function createGates(deps = {}) {
  const fail = deps.fail || defaultFail;
  const { updatePlanBlock } = deps;

  function addRepoGateCommand(ticketId, options = {}) {
    if (!ticketId) {
      fail("add-repo-gate requires <ticket-id>.");
    }
    if (options.notRequired) {
      return updatePlanBlock(ticketId, { repoGate: ["not-required"] });
    }
    if (!options.commandText) {
      fail("add-repo-gate requires --command <cmd> or --not-required.");
    }
    if (options.gateBaseResult && !options.gateResult) {
      fail("--base-result requires --result to classify attribution.");
    }
    const attribution = classifyGateAttribution({
      result: options.gateResult,
      baseResult: options.gateBaseResult,
    });
    const entry = formatRepoGateEntry({
      commandText: options.commandText,
      note: options.note,
      result: options.gateResult,
      baseResult: options.gateBaseResult,
      attribution,
      audit: options.audit,
      coverage: options.coverage,
      arch: options.arch,
    });
    return updatePlanBlock(ticketId, { repoGate: [entry] });
  }

  function classifyGateAttribution({ result, baseResult }) {
    if (!result) {
      return null;
    }
    if (result === "pass") {
      return baseResult === "fail" ? "fixed-on-ticket" : "clean";
    }
    if (result === "fail") {
      if (baseResult === "fail") {
        return "pre-existing-on-base";
      }
      if (baseResult === "pass") {
        return "new-on-ticket";
      }
      return "unknown";
    }
    return null;
  }

  function formatRepoGateEntry({ commandText, note, result, baseResult, attribution, audit, coverage, arch }) {
    const annotations = [];
    if (result) {
      annotations.push(`result=${result}`);
    }
    if (baseResult) {
      annotations.push(`base-result=${baseResult}`);
    }
    if (attribution) {
      annotations.push(`attribution=${attribution}`);
    }
    // COORD-076 (QGATE-002): surface the dependency/security audit as a governed
    // gate SIGNAL in the board record. `audit` is the audit-policy summary
    // string ("audit: <result> threshold=<sev> ...") or a {result, threshold}
    // object; either way it lands as a structured `audit=...` annotation so the
    // recorded gate entry shows the audit outcome alongside the test result.
    if (audit) {
      const auditText = typeof audit === "string"
        ? audit.replace(/^audit:\s*/, "").trim()
        : [audit.result, audit.threshold ? `threshold=${audit.threshold}` : null]
            .filter(Boolean)
            .join(" ");
      if (auditText) {
        annotations.push(`audit=${auditText}`);
      }
    }
    // COORD-077 (QGATE-003): surface the test-coverage outcome as a governed
    // gate SIGNAL in the board record. `coverage` is the coverage-policy summary
    // string ("coverage: <result> min=<pct> ...") or a {result, threshold}
    // object; either way it lands as a structured `coverage=...` annotation so
    // the recorded gate entry shows the coverage outcome alongside the test
    // result and audit signal.
    if (coverage) {
      const coverageText = typeof coverage === "string"
        ? coverage.replace(/^coverage:\s*/, "").trim()
        : [coverage.result, coverage.threshold != null ? `min=${coverage.threshold}` : null]
            .filter(Boolean)
            .join(" ");
      if (coverageText) {
        annotations.push(`coverage=${coverageText}`);
      }
    }
    // COORD-078 (QGATE-004): surface the architecture/complexity outcome as a
    // governed gate SIGNAL in the board record. `arch` is the arch-checks
    // summary string ("arch: <result> files=N findings=M ...") or a
    // {result, findings} object; either way it lands as a structured `arch=...`
    // annotation alongside the test/audit/coverage signals. WARNING-FIRST: the
    // arch result is typically `warn` (non-blocking) — recorded, not enforced,
    // unless a check was escalated to fail.
    if (arch) {
      const archText = typeof arch === "string"
        ? arch.replace(/^arch:\s*/, "").trim()
        : [arch.result, arch.findings != null ? `findings=${arch.findings}` : null]
            .filter(Boolean)
            .join(" ");
      if (archText) {
        annotations.push(`arch=${archText}`);
      }
    }
    const suffix = annotations.length > 0 ? ` [${annotations.join("; ")}]` : "";
    const noteText = note ? ` - ${note}` : "";
    return `${commandText}${suffix}${noteText}`;
  }

  return {
    addRepoGateCommand,
    classifyGateAttribution,
    formatRepoGateEntry,
  };
};
