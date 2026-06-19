# Evidence Export — Control-Mapped Audit Records

## Purpose

Turn Concord's already-governed state into an auditor-ready evidence package,
mapped to the controls regulators ask for. Concord already *records* the evidence
(journal, plan records, board indexes); this tool *packages and maps* it. It
invents no data and **fails closed** — a `done` ticket missing required evidence
is flagged as a gap, never silently omitted. It never mutates governed state.

## Invocation (v1: standalone script)

```sh
# one ticket
node coord/scripts/evidence-export.mjs --ticket COORD-015
# everything landed in a window
node coord/scripts/evidence-export.mjs --scope period --from 2026-06-01 --to 2026-06-30
# one repo's done tickets
node coord/scripts/evidence-export.mjs --scope repo --repo B
# default: all done tickets
node coord/scripts/evidence-export.mjs
```

Options: `--framework eu-ai-act|nist-ai-rmf|all` (default `all`),
`--format json|md` (default `json`), `--coord-dir <path>` (default `coord`),
`--out <path>` (default stdout).

Exit code is non-zero (`3`) when any in-scope ticket has an evidence gap, so CI
can fail closed. A `gov evidence-export` wrapper is a planned follow-up (it must
be added to the governed help/verb-parity surface first).

## Inputs (all existing governed state, read-only)

- `coord/.runtime/governance-events.ndjson` — append-only event log (actor, ts, transition)
- `coord/.runtime/plans/<TICKET>.json` — requirement_closure, feature_proof, repo_gates, self_review_cycles, critical_invariants
- `coord/board/tasks.json` — `landing_index`, `pr_index`, `waiver_index`, `followup_exceptions`, `review_findings`

## Evidence types and presence rules

| Evidence type | Present when |
|---|---|
| `journal_log` | ≥1 journal event for the ticket |
| `requirement_closure` | closure records `Closeout verdict: complete` |
| `feature_proof` | ≥1 proof recorded (n/a for `X`/coord docs tickets) |
| `review_cycles` | ≥ required cycles (4 for code repos, 3 for `X`/coord) |
| `repo_gates` | ≥1 gate `pass` or `not-required` |
| `landing_provenance` | a `landing_index` or `pr_index` entry exists |
| `waivers` | informational (recorded risk acceptance); never a gap |

## Control mapping (data-driven)

Maps live in `coord/product/control-maps/*.json` keyed by evidence type, so new
frameworks (ISO 42001, SOC 2) are added as data — no code change. Shipped:
`eu-ai-act.json`, `nist-ai-rmf.json`. A control is `covered` when none of its
evidence types are absent for the in-scope ticket(s), else `gap`.

## Output

- **JSON** — deterministic (sorted keys, no wall-clock in the payload), with a
  per-ticket evidence section, a per-framework control matrix, a summary, and an
  `integrity.journal_sha256` over the sorted included journal lines (re-running
  over the same range reproduces the same hash).
- **Markdown** (`--format md`) — control-coverage tables + per-ticket summary
  with gap flags.

## Guarantees (tested)

- Complete ticket → all evidence present, controls covered, exit 0.
- Ticket missing closure/proofs/cycles → flagged gap, control `gap`, exit 3.
- Same input → byte-identical output (hash-stable).
- Read-only: board state is never mutated.

## Not in v1 (follow-ups)

- `gov evidence-export` CLI wrapper (verb-parity wiring).
- PDF rendering (markdown/HTML only today).
- `coord-ui` "Export" action on `/traceability` and `/timeline`.
- Additional framework maps (ISO 42001, SOC 2).
