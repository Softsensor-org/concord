"use strict";

// COORD-718: census of every source file that names the plan field
// `independent_reviews`. The raw array is append-only history (superseded,
// corrected and stale-head reviews stay in it), so a reader that counts the raw
// array would report history as current. Every file is classified:
//
//   owner      the engine module that validates and projects the ledger
//   writer     appends through the canonical plan writer or round-trips PLAN.md
//   active     reads through the projection (projectIndependentReviews /
//              resolveIndependentReviews / independentReviewView)
//
// Counts are matching LINES and are pinned, so a new raw reader fails here
// until someone re-reviews it. Mirrors the COORD-822 plan-evidence census.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["coord", "frontend/apps/coord-ui", "release"];
const SKIP_DIRS = new Set(["node_modules", ".worktrees", ".runtime", "__fixtures__", ".next", ".git"]);
const SOURCE_FILE = /\.(?:c|m)?js$|\.tsx?$/;
const TEST_FILE = /\.test\.(?:c|m)?[jt]s$/;
const FIELD_PATTERN = /\bindependent_reviews\b/;
const ACTIVE_MARKER = /\b(?:projectIndependentReviews|resolveIndependentReviews|independentReviewView|loadIndependentReviews)\b/;

const CENSUS = Object.freeze({
  "coord/engine/scripts/independent-reviews.js": { class: "owner", lines: 7, reason: "validates, projects, appends and renders the ledger" },
  "coord/engine/scripts/plan-evidence-supersession.js": { class: "writer", lines: 1, reason: "PLAN.md round-trip of the raw ledger" },
  "coord/engine/scripts/independent-review-command.js": { class: "writer", lines: 1, reason: "confirms the canonical writer kept the appended review" },
  "coord/engine/scripts/governance-readiness.js": { class: "active", lines: 1, reason: "explain readiness key for the projection" },
  "coord/engine/scripts/closeout-summary.js": { class: "active", lines: 5, reason: "passes the raw ledger to the projection and reports its result" },
  "coord/engine/scripts/evidence-export.mjs": { class: "active", lines: 2, reason: "export field and markdown line from the projection" },
});

function scan() {
  const found = new Map();
  const visit = (relativeDir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(relative);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        const lines = fs.readFileSync(path.join(ROOT, relative), "utf8").split("\n").filter((line) => FIELD_PATTERN.test(line)).length;
        if (lines > 0) found.set(relative, lines);
      }
    }
  };
  for (const root of SCAN_ROOTS.filter((candidate) => fs.existsSync(path.join(ROOT, candidate)))) visit(root);
  return found;
}

test("COORD-718: every independent-review reader is classified with its exact line count", () => {
  const found = scan();
  assert.deepEqual([...found.keys()].filter((file) => !CENSUS[file]).sort(), [],
    "new independent_reviews readers must read through the projection and be added to this census");
  for (const [file, entry] of Object.entries(CENSUS)) {
    if (!fs.existsSync(path.join(ROOT, file))) continue;
    assert.equal(found.get(file) || 0, entry.lines, `${file}: independent_reviews line count changed; re-review it (${entry.class}: ${entry.reason})`);
  }
});

test("COORD-718: active readers name the projection", () => {
  for (const [file, entry] of Object.entries(CENSUS)) {
    if (entry.class !== "active" || !fs.existsSync(path.join(ROOT, file))) continue;
    assert.match(fs.readFileSync(path.join(ROOT, file), "utf8"), ACTIVE_MARKER, `${file} is classified active but does not use the projection`);
  }
});

test("COORD-718: cockpit read models load the engine projection rather than the raw field", () => {
  const ui = path.join(ROOT, "frontend", "apps", "coord-ui", "lib");
  if (!fs.existsSync(ui)) return;
  for (const file of ["evidence.ts", "ticket-explain.ts"]) {
    const source = fs.readFileSync(path.join(ui, file), "utf8");
    assert.match(source, /loadIndependentReviews\(/, `${file} reads independent reviews through the engine projection`);
  }
  assert.match(fs.readFileSync(path.join(ui, "active-plan-evidence.ts"), "utf8"), /scripts\/independent-reviews\.js/);
});
