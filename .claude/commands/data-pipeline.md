# Data Pipeline — Run & Certify a Pipeline (data & analytics track)

Run and **certify** a data pipeline for a `DATA-`/`ANALYTICS-` ticket. Built on the reference data-platform model:
stages are **idempotent**, and **certified outputs may only feed certified outputs** — a certified
product can never depend on an uncertified or superseded feed.

**Arguments:** `$ARGUMENTS` — a `DATA-`/`ANALYTICS-` ticket id, optionally a stage to run
(e.g. `DATA-021` or `DATA-021 --stage transform`).

## Phase 1: Get a governed workspace

```bash
coord/scripts/agent do $ARGUMENTS
```

Claims the ticket, starts it on the **data & analytics** track, and binds the governed worktree.
Read the pipeline's control + contract registries (`pipeline.yml` control/contracts,
`lifecycle.yml` retirement) and the canonical `definitions.py` before changing anything.

## Phase 2: Run the pipeline (idempotently)

Run the stage-foldered pipeline. Every stage must be **idempotent** — re-running it produces the
same certified output, never duplicates. Use the canonical definitions/scope guards; do not
hand-roll metric logic.

```bash
# run the pipeline stage(s); each stage is restartable and side-effect-safe
python -m pipeline.run --ticket $ARGUMENTS   # or the project's documented entrypoint
```

## Phase 3: Certify outputs

For each output, confirm it is backed by a current `*.contract.md` and that **every feed it
consumes is itself certified** (certified-only-feeds-certified). Author or refresh the contract via
**`/data-contract`** if needed.

## Phase 4: Run the data-contract gate

```bash
node coord/scripts/data-contract-gate.js $ARGUMENTS
```

This certifies the run and hard-fails on DQ violations. Report:
- **Result:** pass or fail
- **Per-output:** certified or not, and which check failed
- **Lifecycle:** any output that consumes a superseded/retired feed (a hard fail)
- **Artifact path:** where the certification report was written

## Rules

- Stages are **idempotent** — re-running never duplicates or corrupts certified output.
- **Certified-only-feeds-certified**: never let a certified product depend on an uncertified or
  superseded feed; the gate will hard-fail it.
- Use canonical `definitions.py` + scope guards; don't re-implement metric logic per stage.
- Certification is the gate's job (`data-contract-gate.js`) — don't mark outputs certified by hand.
