# QUESTIONS.md Rotation Protocol

This doc defines how to rotate `coord/QUESTIONS.md` so the governance Q&A log stays scannable and the governance drift classification rule (GOV-026) can apply to a clean baseline.

## When to rotate

Rotate when any of the following is true:

- the canonical `coord/QUESTIONS.md` exceeds approximately 500 rows
- unresolved drift-note rows dominate the log and drown out real blockers
- the table schema in `coord/QUESTIONS.md` has drifted (malformed rows, non-standard columns, mixed headers)
- a governance policy change alters how questions are recorded and the existing log needs to be frozen before the change applies retroactively

Rotation is an operator action, not a governed mutation. It should happen outside of any active `doing` ticket, coordinated with the orchestrator.

## Enforced table schema

After rotation, `coord/QUESTIONS.md` must start with this exact header:

```markdown
# Agent Q&A Log

Async communication channel for blockers, decisions, and handoff questions.

## Format

| Date | From | To | Question | Answer | Resolved |
|------|------|----|----------|--------|----------|
```

Every row appended after the header must:

- be a valid Markdown table row with exactly the six columns above in that order
- use ISO calendar date in the `Date` column (`YYYY-MM-DD`)
- list a governance handle (for example `claudea11`, `codexa37`, `orchestrator`, `governance`) in `From` and `To`
- set `Resolved` to `yes` or `no`

The `## Instructions` marker must remain below the table and must stay intact — `coord/scripts/gov` uses it as the row insertion anchor (`appendQuestionRowText`).

## Rotation steps

1. Confirm the board is quiet: `coord/scripts/gov orch` passes, no governance mutations are in flight.
2. Pick a rotation timestamp: `YYYY-MM-DDTHHMMZ` in UTC.
3. Create `coord/history/` if it does not exist.
4. Copy the current log to the archive:
   ```bash
   mkdir -p coord/history
   cp coord/QUESTIONS.md coord/history/QUESTIONS-<rotation-timestamp>.md
   ```
5. Rewrite `coord/QUESTIONS.md` with only the enforced schema header (see above) and no rows.
6. Run `coord/scripts/gov doctor` to confirm the rewrite did not introduce blocking drift.
7. Let the next governed mutation pick up the new baseline via the normal drift snapshot flow.

Archives in `coord/history/` are append-only. Do not edit them after rotation — they are the durable record of pre-rotation questions. If stakeholders need to reference a past row, link to the archive, do not copy the row back into `coord/QUESTIONS.md`.

## Interaction with the GOV-026 classification rule

`classifyGovernanceProvenanceDrift` in `coord/scripts/governance.js` treats drift on `coord/QUESTIONS.md`, `coord/PLAN.md`, and `coord/board/plans/*.json` as `acknowledgedWriter` drift and suppresses the QUESTIONS.md drift-question for those paths. The classification applies to new entries from its release forward. Rotate before applying the classification rule retroactively to any historical log so the archived rows stay frozen with the semantics under which they were written.
