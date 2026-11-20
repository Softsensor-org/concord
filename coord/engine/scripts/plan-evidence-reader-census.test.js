"use strict";

// COORD-822: census of every source file that names a plan-evidence list
// (repo_gates / verification_commands / critical_invariants). Since COORD-713
// and COORD-807 those raw arrays are APPEND-ONLY HISTORY: superseded and
// retracted entries stay in them. A reader that treats the raw array as current
// shows corrected evidence as live. Every file must therefore be classified:
//
//   active     reads through the engine projection (resolvePlanEvidence,
//              renderPlanEvidenceSections, or the cockpit's activePlanEvidence)
//   historical deliberately reads or writes the raw append-only history
//   derived    reads records that an active producer already projected
//   label      names the field without reading plan evidence
//
// Counts are matching LINES and are pinned, so a new raw reader in a new file or
// an extra one in a classified file fails here until someone re-reviews it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["coord", "frontend/apps/coord-ui", "release"];
const SKIP_DIRS = new Set(["node_modules", ".worktrees", ".runtime", "__fixtures__", ".next", ".git"]);
const SOURCE_FILE = /\.(?:c|m)?js$|\.tsx?$/;
const TEST_FILE = /\.test\.(?:c|m)?[jt]s$/;
const FIELD_PATTERN = /\b(?:repo_gates|verification_commands|critical_invariants)\b/;
const ACTIVE_MARKER = /\b(?:resolvePlanEvidence|renderPlanEvidenceSections|activePlanEvidence|loadActivePlanEvidence)\b/;

const active = (lines, reason) => ({ class: "active", lines, reason });
const historical = (lines, reason) => ({ class: "historical", lines, reason });
const derived = (lines, reason, producer) => ({ class: "derived", lines, reason, producer });
const label = (lines, reason) => ({ class: "label", lines, reason });

const CENSUS = Object.freeze({
  "coord/engine/scripts/plan-evidence-supersession.js": historical(21, "owns the projection: validates the ledgers over the raw history and renders history sections"),
  "coord/engine/scripts/plan-records.js": historical(22, "canonical writer and PLAN.md parser: appends to and round-trips the raw history"),
  "coord/engine/scripts/governance-plan-shape.js": historical(3, "scaffold writer for a new plan record"),
  "coord/scripts/governance-test-utils.js": historical(6, "fixture scaffold writer"),
  "coord/engine/scripts/plan-scaffold-text.js": historical(3, "scaffold placeholder text"),

  "coord/board/board.js": active(1, "review-gate presence and PLAN.md render use the projection"),
  "coord/engine/scripts/governance-readiness.js": active(3, "readiness reads current_entries"),
  "coord/engine/scripts/review-plan-readiness.js": active(1, "review readiness"),
  "coord/engine/scripts/requirements-evidence-policy.js": active(2, "requirements evidence classes"),
  "coord/engine/scripts/requirements-stale-impact.js": active(3, "stale-impact evidence"),
  "coord/engine/scripts/requirements-traceability.js": active(4, "traceability evidence"),
  "coord/engine/scripts/adr-validator.js": active(2, "ADR invariant checks"),
  "coord/engine/scripts/bootstrap-advisory.js": active(4, "bootstrap advisory text scan"),
  "coord/engine/scripts/closeout-summary.js": active(6, "closeout summary and evidence trail"),
  "coord/engine/scripts/coverage-maturity.js": active(2, "coverage gate parse"),
  "coord/engine/scripts/decision-extractor.js": active(3, "decision records; history fields are explicit"),
  "coord/engine/scripts/decomposition-proof-gate.js": active(1, "decomposition proof"),
  "coord/engine/scripts/dispatch.mjs": active(5, "projection plus a structural raw-shape check that reads no values"),
  "coord/engine/scripts/evidence-export.mjs": active(5, "evidence exporter"),
  "coord/engine/scripts/gate-plan.js": active(1, "gate plan text"),
  "coord/engine/scripts/evidence-record.js": label(3, "COORD-959 merged evidence-record check: blocker code names repo_gates only; reads no plan-evidence list"),
  "coord/engine/scripts/gates/adr.js": active(1, "ADR gate"),
  "coord/engine/scripts/gates/business-context.js": active(4, "business-context gate"),
  "coord/engine/scripts/decision-context.js": active(1, "COORD-932 decision-context packet view: reads invariants through the active projection"),
  "coord/engine/scripts/gates/review-closeout.js": active(5, "review closeout gate; COORD-959 moved the two repo_gates blocker codes to evidence-record.js"),
  "coord/engine/scripts/guided-closeout.js": active(5, "overlays the projection on the plan before every check"),
  "coord/engine/scripts/testing-infra-audit.js": active(1, "testing-infra audit"),
  "coord/engine/scripts/token-economics.js": active(5, "invariant depth; other lines are policy-minimum labels"),
  "coord/engine/scripts/track-evidence-policy.js": active(3, "track evidence policy"),
  "frontend/apps/coord-ui/lib/evidence.ts": active(3, "cockpit evidence page; remaining lines are a comment and a matrix key"),
  "frontend/apps/coord-ui/lib/ticket-explain.ts": active(1, "ticket explain repo gates; remaining line is a comment"),
  "frontend/apps/coord-ui/lib/plan-evidence.js": active(3, "the cockpit's projection adapter"),

  "coord/engine/scripts/memory-graph.js": derived(1, "reads decision records, already projected", "coord/engine/scripts/decision-extractor.js"),
  "coord/engine/scripts/recall.js": derived(2, "reads decision records, already projected", "coord/engine/scripts/decision-extractor.js"),

  "coord/engine/scripts/questions.js": label(3, "blocker codes and an unrelated output field"),
  "coord/engine/scripts/human-agent-platform.js": label(1, "artifact name"),
  "coord/engine/scripts/lifecycle-help.js": label(1, "help text"),
  "frontend/apps/coord-ui/lib/plan-evidence.d.ts": label(3, "type declaration of the projection shape"),
});

function countFieldLines(text) {
  return text.split("\n").filter((line) => FIELD_PATTERN.test(line)).length;
}

function scanSources() {
  const found = new Map();
  const visit = (relativeDir) => {
    const absoluteDir = path.join(ROOT, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(relative);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        const lines = countFieldLines(fs.readFileSync(path.join(ROOT, relative), "utf8"));
        if (lines > 0) found.set(relative, lines);
      }
    }
  };
  for (const root of SCAN_ROOTS.filter((candidate) => fs.existsSync(path.join(ROOT, candidate)))) visit(root);
  return found;
}

test("COORD-822: the census scanner counts any raw plan-evidence field read", () => {
  assert.equal(countFieldLines("const gates = plan.repo_gates;\nconst x = 1;\nplan[\"critical_invariants\"].length"), 2);
  assert.equal(countFieldLines("min_critical_invariants flat_critical_invariants repoGates"), 0, "derived names are not field reads");
});

test("COORD-822: every plan-evidence reader is classified with its exact line count", () => {
  const found = scanSources();
  const unclassified = [...found.keys()].filter((file) => !CENSUS[file]).sort();
  assert.deepEqual(unclassified, [], "new plan-evidence readers must use the active projection and be added to the census");
  for (const [file, entry] of Object.entries(CENSUS)) {
    const scanned = SCAN_ROOTS.some((root) => file.startsWith(`${root}/`) && fs.existsSync(path.join(ROOT, root)));
    if (!scanned) continue;
    assert.equal(found.get(file) || 0, entry.lines, `${file}: plan-evidence line count changed; re-review it (${entry.class}: ${entry.reason})`);
  }
});

test("COORD-822: active readers name the projection and derived readers name an active producer", () => {
  for (const [file, entry] of Object.entries(CENSUS)) {
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    if (entry.class === "active") {
      assert.match(fs.readFileSync(absolute, "utf8"), ACTIVE_MARKER, `${file} is classified active but does not use the projection`);
    }
    if (entry.class === "derived") {
      assert.equal(CENSUS[entry.producer]?.class, "active", `${file} must name an active producer`);
    }
  }
});
