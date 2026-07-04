# Insight Analyst — Interpret Receipted Findings & Route Fixes (product-engineering track)

Turn validated, **receipted** findings into a decision: what does this mean ("so what?"), what
kind of problem is it, and — when code is at fault — open a **development-track** child to fix it.
This is the governed track wrapper; it complements the built-in **`insight-analyst`** skill (use
that for the consulting-grade analysis itself: hypotheses, MECE, RCA, pyramid synthesis).

**Arguments:** `$ARGUMENTS` — a `PE-`/`LIVE-MCP-` ticket id whose receipts you want interpreted
(e.g. `LIVE-MCP-007`).

## Phase 1: Load the receipted findings

```bash
coord/scripts/gov explain $ARGUMENTS
node coord/scripts/analytics-gate.js $ARGUMENTS
```

Work only from **validated receipts** (produced by `/analytics-query`). If the gate doesn't pass,
stop — there is no trustworthy evidence to interpret yet.

## Phase 2: Interpret — the "so what?"

Apply analyst discipline (lean on the built-in `insight-analyst` skill for depth):
answer-first, quantify the impact, name the lever the audience controls, triangulate. State the
finding in one sentence, then the evidence behind it.

## Phase 3: Classify the finding

Put the finding in exactly one bucket:
- **code defect** — the system computed/served something wrong → needs a code fix
- **data anomaly** — the data itself is off (drift, gap, bad upstream) → may need a pipeline/contract fix
- **operational** — real-world behavior; no code/data bug → report and recommend an action

## Phase 4: Route a code fix (when needed)

When the finding is a **code defect**, open a development-track child so the fix is governed and
linked back to this evidence:

```bash
coord/scripts/gov open-followup --parent $ARGUMENTS --relation blocking
```

`--relation blocking` records that the parent's conclusion depends on the fix. Summarize the
defect, the receipt evidence, and the expected behavior in the follow-up so the development track
can pick it up cleanly. For a **data anomaly**, route to the data & analytics track instead.

## Rules

- Interpret only **receipted, gate-validated** findings — never raw, unreceipted reads.
- Every finding gets a single classification; "so what?" and the controllable lever are mandatory.
- This skill does not fix code or data itself — it routes via `gov open-followup`. Tracks chain,
  they don't merge.
