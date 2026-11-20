"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

// Wave 3 (COORD-069): repo-gate attribution/board-record tests relocated out of
// plan-command.test.js into a module-owned file alongside gates.js. Exercise the
// gate-attribution classifier and board-record entry formatter through their
// owning module API.

const test = require("node:test");
const assert = require("node:assert/strict");
const createGates = require("./gates.js");
const gates = createGates({});
const { createBusinessContextGate } = require("./gates/business-context.js");
const { evidenceRef, stableSupersessionId, stableDispositionId } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));

test("COORD-924: selected gate attribution uses the ticket worktree before repository and workspace fallbacks", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord924-evidence-root-"));
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, "{}");
  const landing = require("./affected-landing.js");
  const originalVerify = landing.verifyLandingEvidence;
  const originalEntry = landing.repoGateEntry;
  const roots = [];
  landing.verifyLandingEvidence = (options) => { roots.push(options.root); return { ok: true }; };
  landing.repoGateEntry = () => "synthetic verified selection";
  try {
    const row = { ID: "B-924", Repo: "B" };
    const cases = [
      [{ ticketRow: () => row, resolveTicketGitContext: () => ({ worktree: "/private/ticket", repoRoot: "/private/repo" }), workspaceRoot: "/private/workspace" }, "/private/ticket"],
      [{ ticketRow: () => row, resolveTicketGitContext: () => ({ repoRoot: "/private/repo" }), workspaceRoot: "/private/workspace" }, "/private/repo"],
      [{ ticketRow: () => row, resolveTicketGitContext: () => null, workspaceRoot: "/private/workspace" }, "/private/workspace"],
      [{ ticketRow: () => row, resolveTicketGitContext: () => ({}) }, path.dirname(COORD_ROOT_DIR)],
      [{ ticketRow: () => null, resolveTicketGitContext: () => { throw new Error("no ticket must not resolve a repository"); }, workspaceRoot: "/private/workspace" }, "/private/workspace"],
      [{}, path.dirname(COORD_ROOT_DIR)],
    ];
    for (const [deps, expected] of cases) {
      let written = null;
      const api = createGates({ ...deps, updatePlanBlock: (ticket, change) => { written = { ticket, change }; } });
      api.addRepoGateCommand("B-924", { selectionManifest: manifestPath, base: "dev" });
      assert.equal(roots.at(-1), expected);
      assert.deepEqual(written, { ticket: "B-924", change: { repoGate: ["synthetic verified selection"] } });
    }
  } finally {
    landing.verifyLandingEvidence = originalVerify;
    landing.repoGateEntry = originalEntry;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("business-context evidence reads active gate and command projections, never historical refs or disposition", () => {
  const oldGate = "business-context: coord/.runtime/context-packs/old.json";
  const newGate = "TODO: replacement pack not reviewed";
  const oldCommand = "business-context approved: historical exception";
  const newCommand = "TODO: current investigation pending";
  const oldGateRef = evidenceRef("repo_gate", 1, oldGate), newGateRef = evidenceRef("repo_gate", 2, newGate);
  const oldCommandRef = evidenceRef("verification_command", 1, oldCommand), newCommandRef = evidenceRef("verification_command", 2, newCommand);
  const relation = (kind, sourceRef, successorRef) => ({ id: stableSupersessionId(sourceRef, successorRef), kind,
    source_ref: sourceRef, successor_ref: successorRef, reason: "Historical disposition is stale.", actor: "fixture",
    timestamp: "2026-10-05T00:00:00.000Z" });
  const read = createBusinessContextGate({}).readBusinessContextEvidence({
    repo_gates: [oldGate, newGate], verification_commands: [oldCommand, newCommand],
    evidence_supersessions: [relation("repo_gate", oldGateRef, newGateRef), relation("verification_command", oldCommandRef, newCommandRef)],
  });
  assert.deepEqual(read.refs, []);
  assert.equal(read.hasContextRef, false);
  assert.equal(read.hasApprovalOrWaiver, false);
  assert.equal(read.hasInvestigationStatus, false);
  assert.deepEqual(createBusinessContextGate({}).readBusinessContextEvidence().refs, [], "missing legacy plan state is an empty evidence projection");
  const active = createBusinessContextGate({}).readBusinessContextEvidence({ feature_proof: ["legacy x.runtime/context-packs/current.json reference"] });
  assert.deepEqual(active.refs, ["coord/.runtime/context-packs/current.json"]);
});

test("COORD-807: a retracted invariant cannot satisfy the ADR requirement or its closeout citation", () => {
  const { createAdrGate } = require("./gates/adr.js");
  const { escapeRegex } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle-utils.js"));
  const gate = createAdrGate({
    COORD_DIR: require("node:path").resolve(__dirname, "..", ".."), path: require("node:path"), escapeRegex,
    validateAdrRegistry: () => ({ summary: { ok: true }, adrs: [{ id: "0001", status: "Accepted" }] }),
  });
  const row = { ID: "IMP-807", Type: "feature", Description: "bounded change" };
  const retract = (plan, index, reason) => {
    const value = plan.critical_invariants[index - 1];
    const sourceRef = evidenceRef("critical_invariant", index, value);
    return { ...plan, evidence_dispositions: [{
      id: stableDispositionId(sourceRef, "retracted"), kind: "critical_invariant", source_ref: sourceRef,
      disposition: "retracted", reason, actor: "codexa756", timestamp: "2026-10-05T19:30:00.000Z",
    }] };
  };

  // An investigation status recorded as an invariant satisfies the requirement
  // only while that invariant is active.
  const investigating = {
    decision_required: { required: true, reason: "changes the approval workflow" },
    critical_invariants: ["decision status: investigating with the platform owner"],
  };
  assert.equal(gate.readAdrDecisionEvidence(investigating).hasInvestigationStatus, true);
  assert.deepEqual(gate.collectAdrRequirementIssues("IMP-807", row, investigating), []);
  const withdrawn = retract(investigating, 1, "No investigation was ever opened.");
  assert.equal(gate.readAdrDecisionEvidence(withdrawn).hasInvestigationStatus, false);
  assert.deepEqual(gate.collectAdrRequirementIssues("IMP-807", row, withdrawn).map((issue) => issue.code), ["adr_required"]);

  // An ADR cited only by a retracted invariant is no longer a reference at all.
  const inlineOnly = { decision_required: { required: true }, critical_invariants: ["follows ADR-0001 for approvals"] };
  assert.deepEqual(gate.deriveDecisionRequiredGuidance("IMP-807", row, inlineOnly).accepted_adr_refs, ["0001"]);
  const inlineWithdrawn = gate.deriveDecisionRequiredGuidance("IMP-807", row, retract(inlineOnly, 1, "Cited the wrong ADR."));
  assert.deepEqual(inlineWithdrawn.adr_refs, []);
  assert.equal(inlineWithdrawn.satisfied, false);

  // Declared references stay; the closeout citation needs active prose.
  const cited = {
    decision_required: { required: true, adr_refs: ["ADR-0001"] },
    critical_invariants: ["ADR-0001 compliance: the approval path follows the accepted decision", "unrelated invariant stays active"],
  };
  assert.deepEqual(gate.readAdrDecisionEvidence(cited).adr_refs, ["ADR-0001", "0001"]);
  assert.deepEqual(gate.collectAdrCloseoutCitationIssues("IMP-807", row, cited), []);
  const uncited = retract(cited, 1, "Compliance was asserted before the work existed.");
  assert.equal(gate.deriveDecisionRequiredGuidance("IMP-807", row, uncited).satisfied, true);
  assert.deepEqual(gate.collectAdrCloseoutCitationIssues("IMP-807", row, uncited).map((issue) => issue.code), ["adr_closeout_citation"]);
});

test("COORD-807 prototype: retracted invariant text cannot satisfy current business-context checks", () => {
  const value = "business-context investigation: not-required; invoice pricing was unaffected";
  const sourceRef = evidenceRef("critical_invariant", 1, value);
  const plan = {
    critical_invariants: [value],
    evidence_dispositions: [{
      id: stableDispositionId(sourceRef, "retracted"),
      kind: "critical_invariant",
      source_ref: sourceRef,
      disposition: "retracted",
      reason: "This disposition was attached to the wrong plan.",
      actor: "codexa756",
      timestamp: "2026-10-05T19:30:00.000Z",
    }],
  };
  const gate = createBusinessContextGate({});
  const evidence = gate.readBusinessContextEvidence(plan);
  assert.equal(evidence.hasInvestigationStatus, false);
  assert.equal(gate.ticketTouchesBusinessContextRisk({ Type: "bug", Description: "bounded fix" }, plan), false);
  assert.equal(gate.ticketTouchesBusinessContextRisk({ Type: "bug", Description: "bounded fix" }, null), false,
    "a missing plan is treated as empty active evidence");
});

test("classifyGateAttribution distinguishes new-on-ticket, pre-existing-on-base, fixed-on-ticket, and clean", () => {
  assert.equal(gates.classifyGateAttribution({ result: "pass" }), "clean");
  assert.equal(gates.classifyGateAttribution({ result: "pass", baseResult: "pass" }), "clean");
  assert.equal(gates.classifyGateAttribution({ result: "pass", baseResult: "fail" }), "fixed-on-ticket");
  assert.equal(gates.classifyGateAttribution({ result: "fail", baseResult: "pass" }), "new-on-ticket");
  assert.equal(gates.classifyGateAttribution({ result: "fail", baseResult: "fail" }), "pre-existing-on-base");
  assert.equal(gates.classifyGateAttribution({ result: "fail" }), "unknown");
  assert.equal(gates.classifyGateAttribution({}), null);
});

test("formatRepoGateEntry encodes attribution and preserves command + note ordering", () => {
  assert.equal(
    gates.formatRepoGateEntry({ commandText: "pnpm test" }),
    "pnpm test"
  );
  assert.equal(
    gates.formatRepoGateEntry({ commandText: "pnpm test", note: "unit suite" }),
    "pnpm test - unit suite"
  );
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "pnpm test",
      result: "fail",
      baseResult: "pass",
      attribution: "new-on-ticket",
      note: "broke the auth suite",
    }),
    "pnpm test [result=fail; base-result=pass; attribution=new-on-ticket] - broke the auth suite"
  );
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "pnpm lint",
      result: "fail",
      baseResult: "fail",
      attribution: "pre-existing-on-base",
    }),
    "pnpm lint [result=fail; base-result=fail; attribution=pre-existing-on-base]"
  );
});

test("COORD-076: formatRepoGateEntry records the dependency-audit signal as an annotation", () => {
  // String summary (the audit-policy.js summary line) is normalized.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      audit: "audit: warn threshold=high total=1 (critical=0 high=0 moderate=1 low=0 info=0) blocking=0",
    }),
    "bash scripts/gate.sh full [result=pass; audit=warn threshold=high total=1 (critical=0 high=0 moderate=1 low=0 info=0) blocking=0]"
  );
  // Object form is accepted too.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "gate:full",
      audit: { result: "fail", threshold: "high" },
    }),
    "gate:full [audit=fail threshold=high]"
  );
  // Absent audit leaves the entry unchanged (backward compatible).
  assert.equal(
    gates.formatRepoGateEntry({ commandText: "gate:full", result: "pass" }),
    "gate:full [result=pass]"
  );
});

test("COORD-077: formatRepoGateEntry records the test-coverage signal as an annotation", () => {
  // String summary (the coverage-policy.js summary line) is normalized.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      coverage: "coverage: pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91",
    }),
    "bash scripts/gate.sh full [result=pass; coverage=pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91]"
  );
  // Object form is accepted too.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "gate:full",
      coverage: { result: "fail", threshold: 80 },
    }),
    "gate:full [coverage=fail min=80]"
  );
  // Audit and coverage coexist as ordered annotations.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "gate:full",
      result: "pass",
      audit: "audit: pass threshold=high",
      coverage: "coverage: pass min=80 (lines=90.00 branches=90.00 functions=90.00) lowest=90.00",
    }),
    "gate:full [result=pass; audit=pass threshold=high; coverage=pass min=80 (lines=90.00 branches=90.00 functions=90.00) lowest=90.00]"
  );
});

test("COORD-078: formatRepoGateEntry records the architecture/complexity signal as an annotation", () => {
  // String summary (the arch-checks.js summary line) is normalized.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "bash scripts/gate.sh full",
      result: "pass",
      arch: "arch: warn files=42 findings=3 (size=1 complexity=2 imports=0 dup=0 monolith=0)",
    }),
    "bash scripts/gate.sh full [result=pass; arch=warn files=42 findings=3 (size=1 complexity=2 imports=0 dup=0 monolith=0)]"
  );
  // Object form is accepted too.
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "gate:full",
      arch: { result: "warn", findings: 3 },
    }),
    "gate:full [arch=warn findings=3]"
  );
  // All four gate signals coexist as ordered annotations (audit, coverage, arch).
  assert.equal(
    gates.formatRepoGateEntry({
      commandText: "gate:full",
      result: "pass",
      audit: "audit: pass threshold=high",
      coverage: "coverage: pass min=80",
      arch: "arch: warn files=42 findings=1 (size=1 complexity=0 imports=0 dup=0 monolith=0)",
    }),
    "gate:full [result=pass; audit=pass threshold=high; coverage=pass min=80; arch=warn files=42 findings=1 (size=1 complexity=0 imports=0 dup=0 monolith=0)]"
  );
  // Absent arch leaves the entry unchanged (backward compatible).
  assert.equal(
    gates.formatRepoGateEntry({ commandText: "gate:full", result: "pass" }),
    "gate:full [result=pass]"
  );
});
