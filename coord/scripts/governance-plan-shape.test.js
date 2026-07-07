// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createGovernancePlanShape = require("./governance-plan-shape.js");
const lifecycleModule = require("./lifecycle.js");
const { __testing } = require("./governance-test-utils.js");

// COORD-295: behavior tests for the governance PLAN-SHAPE service extracted from
// lifecycle.js into governance-plan-shape.js (lifecycle decomposition slice #4 per
// the COORD-291 boundary contract). The shape builders/parsers/formatters are
// exercised directly through the factory with injected fake deps so the byte-stable
// plan JSON/markdown round-trip invariant is pinned at the unit level; the
// `buildDefaultGovernancePlan` registry-live tests and the `ensurePlanStub`
// canonical-record seam tests reach the fully-wired `__testing` facade so behavior
// is byte-identical to the pre-move home (relocated from lifecycle.test.js).

// A minimal factory build with pure injected deps for the shape-only functions
// (no plan-record IO needed for normalize/parse/format/scaffold).
function buildShape(overrides = {}) {
  const REPO_INTEGRATION_BRANCHES = overrides.REPO_INTEGRATION_BRANCHES || { B: "dev", F: "dev" };
  return createGovernancePlanShape({
    state: { PLAN_PATH: "/plan.md" },
    REPO_INTEGRATION_BRANCHES,
    DEFAULT_INTEGRATION_BRANCH: "dev",
    isRepoBackedCode: (code) => code === "B" || code === "F",
    repoNameForCode: (code) => (code === "X" ? "coord" : code.toLowerCase()),
    toArray: (value) => (Array.isArray(value) ? value : value == null ? [] : [value]),
    readCanonicalTextFile: () => "",
    writeCanonicalTextFile: () => {},
    writeCanonicalJsonFile: () => {},
    ...overrides,
  });
}

// --- DI wiring guard: factory shape + lifecycle composition-root wiring ----------

test("COORD-295 wiring: createGovernancePlanShape returns exactly the nine public functions", () => {
  const shape = buildShape();
  const expected = [
    "scaffoldSelfReviewCycle",
    "buildDefaultGovernancePlan",
    "normalizeGovernancePlanShape",
    "formatGovernancePlanEntry",
    "formatGovernanceReviewProfileEntry",
    "formatGovernanceRepairEntry",
    "parseGovernancePlanEntries",
    "buildScaffoldPlanRecord",
    "ensurePlanStub",
  ];
  assert.deepEqual(Object.keys(shape).sort(), [...expected].sort());
  for (const name of expected) {
    assert.equal(typeof shape[name], "function", `${name} must be a function`);
  }
});

test("COORD-295 wiring: lifecycle.js re-exports the plan-shape helpers through the __testing facade", () => {
  // BRACKET form (COORD-280 facade-scanner safe): the two plan-shape helpers the
  // facade exported before the move keep resolving through the re-destructured
  // factory returns; the rest stay internal exactly as before.
  for (const name of ["buildDefaultGovernancePlan", "ensurePlanStub"]) {
    assert.equal(
      typeof lifecycleModule.__testing[name],
      "function",
      `lifecycle __testing[${name}] resolves`
    );
  }
});

// --- buildDefaultGovernancePlan (relocated from lifecycle.test.js) ---------------

test("buildDefaultGovernancePlan seeds repo-specific closeout defaults", () => {
  // COORD-006: derive the expected integration branch from the live registry
  // instead of hardcoding "dev" — this assertion must hold under ANY repo
  // registry (e.g. acme's "devx"), not only the coord-template default.
  const expectedRepoBaseRef = __testing.paths.REPO_INTEGRATION_BRANCHES.F || "dev";
  assert.deepEqual(__testing.buildDefaultGovernancePlan("F"), {
    expected_closeout: {
      method: "pr",
      base_ref: expectedRepoBaseRef,
      provenance_note: null,
    },
    review_profile: "standard",
    ticket_local_repairs: [],
  });

  // Repo "X" (coord / cross-repo) is registry-independent: always no_pr / main.
  assert.deepEqual(__testing.buildDefaultGovernancePlan("X"), {
    expected_closeout: {
      method: "no_pr",
      base_ref: "main",
      provenance_note: null,
    },
    review_profile: "standard",
    ticket_local_repairs: [],
  });
});

test("buildDefaultGovernancePlan seeds closeout base_ref from REPO_INTEGRATION_BRANCHES (COORD-007)", () => {
  const original = { ...__testing.paths.REPO_INTEGRATION_BRANCHES };
  __testing.paths.REPO_INTEGRATION_BRANCHES = { B: "development", F: "dev" };
  try {
    assert.equal(__testing.buildDefaultGovernancePlan("B").expected_closeout.base_ref, "development");
    assert.equal(__testing.buildDefaultGovernancePlan("F").expected_closeout.base_ref, "dev");
    // Non-repo-backed work stays on "main".
    assert.equal(__testing.buildDefaultGovernancePlan("X").expected_closeout.base_ref, "main");
  } finally {
    __testing.paths.REPO_INTEGRATION_BRANCHES = original;
  }
});

// --- format / parse / normalize byte-stable round-trip --------------------------

test("formatGovernancePlanEntry <-> parseGovernancePlanEntries round-trips byte-stable", () => {
  const shape = buildShape();
  const governance = {
    expected_closeout: { method: "pr", base_ref: "release/x", provenance_note: "landed via PR #9" },
    review_profile: "bounded_repair",
    ticket_local_repairs: [],
  };
  const planLine = shape.formatGovernancePlanEntry(governance);
  assert.equal(
    planLine,
    "expected_closeout: method=pr; base_ref=release/x; provenance_note=landed via PR #9"
  );
  const profileLine = shape.formatGovernanceReviewProfileEntry(governance);
  assert.equal(profileLine, "review_profile: bounded_repair");

  const parsed = shape.parseGovernancePlanEntries([planLine, profileLine], "F");
  assert.deepEqual(parsed.expected_closeout, governance.expected_closeout);
  assert.equal(parsed.review_profile, "bounded_repair");

  // Re-emit from the parsed shape and confirm the lines are identical (byte-stable).
  assert.equal(shape.formatGovernancePlanEntry(parsed), planLine);
  assert.equal(shape.formatGovernanceReviewProfileEntry(parsed), profileLine);
});

test("formatGovernanceRepairEntry round-trips a ticket_local_repair entry byte-stable", () => {
  const shape = buildShape();
  const entry = { kind: "return_doing", required_question_logged: true, note: "Repair round 2" };
  const line = shape.formatGovernanceRepairEntry(entry);
  assert.equal(
    line,
    "ticket_local_repair: kind=return_doing; required_question_logged=yes; note=Repair round 2"
  );
  const parsed = shape.parseGovernancePlanEntries([line], "X");
  assert.deepEqual(parsed.ticket_local_repairs, [
    { kind: "return_doing", required_question_logged: true, note: "Repair round 2" },
  ]);
  assert.equal(shape.formatGovernanceRepairEntry(parsed.ticket_local_repairs[0]), line);
});

test("normalizeGovernancePlanShape collapses repo-backed defaults and preserves explicit shape", () => {
  const shape = buildShape();
  // A repo-backed plan that only carries the generic defaults normalizes back to the
  // repo-specific default object (no spurious drift).
  const collapsed = shape.normalizeGovernancePlanShape(
    { expected_closeout: { method: "no_pr", base_ref: "main" } },
    "F"
  );
  assert.deepEqual(collapsed, shape.buildDefaultGovernancePlan("F"));

  // An explicit non-default shape is preserved verbatim (after coercion).
  const explicit = shape.normalizeGovernancePlanShape(
    {
      expected_closeout: { method: "pr", base_ref: "release/x", provenance_note: "note" },
      review_profile: "bounded_repair",
      ticket_local_repairs: [{ kind: "return_doing", required_question_logged: true, note: "n" }],
    },
    "F"
  );
  assert.deepEqual(explicit, {
    expected_closeout: { method: "pr", base_ref: "release/x", provenance_note: "note" },
    review_profile: "bounded_repair",
    ticket_local_repairs: [{ kind: "return_doing", required_question_logged: true, note: "n" }],
  });

  // Garbage input falls back to defaults.
  assert.deepEqual(shape.normalizeGovernancePlanShape(null, "X"), shape.buildDefaultGovernancePlan("X"));
});

// --- scaffoldSelfReviewCycle + buildScaffoldPlanRecord --------------------------

test("scaffoldSelfReviewCycle builds a deterministic raw line and structured fields", () => {
  const shape = buildShape();
  const cycle = shape.scaffoldSelfReviewCycle(2, 4, {
    lens: "contract invariants",
    risks: ["mode a", "mode b"],
  });
  assert.equal(cycle.cycle, 2);
  assert.equal(cycle.total, 4);
  assert.deepEqual(cycle.risks, ["mode a", "mode b"]);
  assert.equal(
    cycle.raw,
    "lens=contract invariants; diff=TODO; risks=mode a, mode b; findings=TODO; verification=TODO; verdict=TODO"
  );
  // Empty inputs scaffold TODO placeholders.
  const empty = shape.scaffoldSelfReviewCycle(1, 3);
  assert.deepEqual(empty.risks, ["TODO"]);
  assert.match(empty.raw, /^lens=TODO; diff=TODO; risks=TODO;/);
});

test("buildScaffoldPlanRecord yields a stable repo-backed record shape (4 review cycles)", () => {
  const shape = buildShape();
  const record = shape.buildScaffoldPlanRecord("IMP-900", "F", "claudea188");
  assert.equal(record.schema_version, 1);
  assert.equal(record.ticket_id, "IMP-900");
  assert.deepEqual(record.startup_checklist, ["TODO: completed"]);
  assert.deepEqual(record.scaffold_placeholders, {
    intended_files: ["f/.worktrees/claudea188/IMP-900/*"],
  });
  assert.deepEqual(record.intended_files, ["f/.worktrees/claudea188/IMP-900/*"]);
  // Repo-backed -> 4 self-review cycles; coord-only -> 3.
  assert.equal(record.self_review_cycles.length, 4);
  assert.equal(shape.buildScaffoldPlanRecord("IMP-901", "X", "claudea188").self_review_cycles.length, 3);
  assert.deepEqual(record.governance, shape.buildDefaultGovernancePlan("F"));
});

// --- ensurePlanStub (relocated from lifecycle.test.js) --------------------------

test("ensurePlanStub does not overwrite an existing canonical record from a stale markdown stub", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-ensure-plan-stub-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });

  fs.writeFileSync(planPath, `## DEBT-021 — 2026-03-25T22:13:17.979Z

- Startup checklist:
  - TODO: completed
- Traceability gate:
  - TODO: verified | closing-gap | exempt
`, "utf8");

  const recordPath = path.join(recordsDir, "DEBT-021.json");
  fs.writeFileSync(recordPath, JSON.stringify({
    schema_version: 1,
    ticket_id: "DEBT-021",
    markdown_heading: "## DEBT-021 — 2026-03-25T22:13:17.979Z",
    startup_checklist: ["completed"],
    traceability_gate: ["closing-gap"],
    review_round: 1,
    baseline_reproduction: ["Command: not-required", "Outcome: canonical record already normalized"],
    prior_findings: [],
    intended_files: ["coord/.worktrees/codexa02/DEBT-021/*"],
    change_summary: ["Retire markdown parser enforcement."],
    verification_commands: ["node coord/scripts/governance.test.js"],
    critical_invariants: ["Canonical record must win over stale markdown."],
    requirement_closure: ["Ticket ask: preserve canonical record", "Implemented: preserve canonical record", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    repo_gates: ["not-required"],
    self_review_cycles: [],
    rollback_strategy: ["revert"],
    security_surface: "no",
    synced_from_markdown_at: "2026-03-25T22:13:17.983Z",
  }, null, 2), "utf8");

  const planBefore = fs.readFileSync(planPath, "utf8");
  const recordBefore = fs.readFileSync(recordPath, "utf8");

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.ensurePlanStub("DEBT-021", "X", "codexa02");
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }

  assert.equal(fs.readFileSync(planPath, "utf8"), planBefore);
  assert.equal(fs.readFileSync(recordPath, "utf8"), recordBefore);
});

test("ensurePlanStub seeds a canonical scaffold record before rendering compatibility markdown", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ebmr-governance-scaffold-record-"));
  const planPath = path.join(tempDir, "PLAN.md");
  const recordsDir = path.join(tempDir, "plans");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(planPath, "", "utf8");

  const originalPlanPath = __testing.paths.PLAN_PATH;
  const originalRecordsDir = __testing.paths.PLAN_RECORDS_DIR;
  __testing.paths.PLAN_PATH = planPath;
  __testing.paths.PLAN_RECORDS_DIR = recordsDir;
  try {
    __testing.ensurePlanStub("DEBT-043", "X", "codexa00");

    const record = __testing.readPlanRecord("DEBT-043", { recordsDir });
    const planRaw = fs.readFileSync(planPath, "utf8");

    assert.equal(record.ticket_id, "DEBT-043");
    assert.deepEqual(record.startup_checklist, ["TODO: completed"]);
    assert.deepEqual(record.traceability_gate, ["TODO: verified | closing-gap | exempt"]);
    assert.deepEqual(record.scaffold_placeholders, {
      intended_files: ["coord/.worktrees/codexa00/DEBT-043/*"],
    });
    assert.deepEqual(record.intended_files, ["coord/.worktrees/codexa00/DEBT-043/*"]);
    assert.equal(record.self_review_cycles.length, 3);
    assert.match(record.self_review_cycles[0].raw, /lens=TODO contract\/state invariants/);
    assert.match(planRaw, /## DEBT-043 — /);
    assert.match(planRaw, /coord\/\.worktrees\/codexa00\/DEBT-043/);
    assert.match(planRaw, /TODO: describe the intended change\./);
  } finally {
    __testing.paths.PLAN_PATH = originalPlanPath;
    __testing.paths.PLAN_RECORDS_DIR = originalRecordsDir;
  }
});
