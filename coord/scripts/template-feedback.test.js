"use strict";

// B6 first cut: template-feedback governance-repair tests relocated out of the
// governance.test.js monolith into a module-owned file. They exercise the
// B5-extracted governance-repair helpers via the governance __testing surface.
// The remaining governance.test.js split continues incrementally (COORD-053).

const test = require("node:test");
const assert = require("node:assert");
const { __testing } = require("./governance.js");
const { DEFAULT_PATHS } = require("./governance-context.js");

// COORD-071: the coord/X ticket-id prefix is config-driven (project.config.js
// `coordTicketPrefix`). Build fixture ticket ids from the active prefix so
// these tests pass under BOTH legs of the config matrix (default "COORD" and
// the non-default fixture's prefix).
const CP = DEFAULT_PATHS.coordTicketPrefix || "COORD";

test("parseTemplateFeedbackRowsFromText extracts real rows and ticket references", () => {
  const rows = __testing.parseTemplateFeedbackRowsFromText(`# Template Feedback

## Governance

| Date | Finding | Severity | Status |
|------|---------|----------|--------|
| | | | |
| 2026-05-01 | ${CP}-006 added --review-round for stuck review gates | High | Backfilled |

## Skills

| Date | Skill | Change | Rationale |
|------|-------|--------|-----------|
| 2026-05-01 | /next | ${CP}-005 replaced gov whoami copy with gov agentid | Prevent stale aliases |

## Template Structure

| Date | Finding | Recommendation |
|------|---------|----------------|
| 2026-05-01 | ${CP}-007 found per-repo base-ref drift | Add registry |
`);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.section), ["governance", "skills", "template_structure"]);
  assert.deepEqual(rows[0].ticket_refs, [`${CP}-006`]);
  assert.deepEqual(rows[2].ticket_refs, [`${CP}-007`]);
});

test("collectTemplateFeedbackAlerts reports matching done coord tickets without feedback rows", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: `${CP}-100`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance session lock drift.",
          },
          {
            ID: `${CP}-101`,
            Repo: "X",
            Status: "done",
            Type: "docs",
            Description: "Project-local wording cleanup.",
          },
          {
            ID: "WEB-100",
            Repo: "F",
            Status: "done",
            Type: "feature",
            Description: "Frontend governance text.",
          },
        ],
      },
    ],
  };
  const events = [
    {
      ticket: `${CP}-100`,
      after_status: "done",
      ts: "2026-04-25T00:00:00.000Z",
    },
  ];

  const alerts = __testing.collectTemplateFeedbackAlerts(board, events, {
    now: new Date("2026-05-06T00:00:00.000Z"),
    feedbackRows: [],
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ticket, `${CP}-100`);
  assert.equal(alerts[0].age_days, 11);
  assert.equal(alerts[0].stale, true);
  assert.match(__testing.formatTemplateFeedbackAlerts(alerts)[0], /Template feedback alerts: 1/);
});

test("collectStaleTemplateFeedbackErrors honors feedback rows and project-local waivers", () => {
  const board = {
    sections: [
      {
        rows: [
          {
            ID: `${CP}-100`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance session lock drift.",
          },
          {
            ID: `${CP}-101`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance CLI typo.",
          },
          {
            ID: `${CP}-102`,
            Repo: "X",
            Status: "done",
            Type: "bug",
            Description: "Fix governance local-only edge.",
          },
        ],
      },
    ],
  };
  const events = [`${CP}-100`, `${CP}-101`, `${CP}-102`].map((ticket) => ({
    ticket,
    after_status: "done",
    ts: "2026-04-25T00:00:00.000Z",
  }));
  const feedbackRows = __testing.parseTemplateFeedbackRowsFromText(`
## Governance
| Date | Finding | Severity | Status |
|------|---------|----------|--------|
| 2026-05-01 | ${CP}-101 fixed template-worthy bug | High | Backfilled |
| 2026-05-01 | ${CP}-102 local-only | Low | human-admin project-local waiver |
`);

  const errors = __testing.collectStaleTemplateFeedbackErrors(board, events, {
    now: new Date("2026-05-06T00:00:00.000Z"),
    feedbackRows,
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`${CP}-100`));
});
