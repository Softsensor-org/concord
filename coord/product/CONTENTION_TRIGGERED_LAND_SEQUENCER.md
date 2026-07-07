# Contention-Triggered Land Sequencer

Status: design spike  
Owner: Softsensor  
Ticket: COORD-353

## Purpose

Concord should keep optimistic parallel work as the default, but serialize the
final land/test step when independently green changes overlap. The sequencer is
a narrow merge queue: it activates only on contention and tests the actual
combined result before promotion.

This adopts the useful part of large-company land queues without turning every
ticket into a global queue.

## Design Principle

Large teams do not serialize work. They serialize integration at the smallest
point where combined-state correctness matters.

For Concord:

- disjoint tickets keep using the normal `submit` / `finalize` / `land` flow;
- overlapping tickets enter a sequenced integration group;
- the sequencer applies one candidate at a time to the current integration
  baseline, runs the affected-target gate, and records a receipt before the
  ticket can be promoted;
- uncertainty falls back to the full gate.

## Activation Trigger

The sequencer activates for a set of in-flight or review-ready tickets when any
of these are true:

| Trigger | Source | Action |
| --- | --- | --- |
| Declared file overlap | `plan-waves` ticket file surfaces | sequence overlapping tickets |
| Changed file overlap | git diff from ticket branch/worktree | sequence overlapping tickets |
| Dependency edge | `Depends On` or orchestrator grouping | sequence dependent ticket after prerequisite |
| Shared global coord state | board, journal, runtime, prompt index, rendered artifacts | sequence and require single-writer closeout |
| Risk class | data migration, deploy, bootstrap, live-MCP, security, irreversible operation | sequence or force full gate |
| Unknown surface | missing files, stale prompt, unknown diff, missing dependency map | sequence and force full gate |

Non-overlapping tickets are explicitly outside the sequencer.

## Queue Model

The sequencer owns an integration group, not the whole repo.

```text
open -> queued -> preparing -> testing -> ready_to_promote -> promoted
                    |             |
                    |             +-> failed_gate -> repair_required
                    +-> stale_base -> rebase_required
```

Queue item fields:

```json
{
  "ticket": "COORD-123",
  "repo": "B",
  "source_ref": "agent/a01/COORD-123",
  "base_ref": "origin/dev",
  "overlap_group": "sha256:<files-and-ticket-set>",
  "declared_files": ["src/a.ts"],
  "changed_files": ["src/a.ts"],
  "gate_mode": "slice|full",
  "selected_targets": [],
  "status": "queued"
}
```

The queue order is deterministic:

1. explicit dependency order;
2. priority tier;
3. ticket id;
4. enqueue timestamp only as a final tie-breaker.

## Sequencer Responsibilities

The sequencer performs only the final integration proof. It does not replace
agent work, review, feature proofs, or normal governance lifecycle evidence.

For each queued item:

1. Refresh the current integration baseline.
2. Apply or simulate the ticket branch on top of that baseline.
3. Recompute changed files and overlap set.
4. Run `coord affected-targets` from COORD-352 against the combined result.
5. If affected-target selection returns `mode=full`, run the full gate.
6. If it returns `mode=slice`, run the selected targets and record skipped
   targets.
7. Record a sequencer receipt in the journal.
8. Allow promotion only if the receipt is passing and cites the tested combined
   baseline.

## Gate Strategy

The sequencer uses affected-target selection as an optimization, never as a
weaker gate.

| Condition | Gate |
| --- | --- |
| Known changed files and current dependency map | affected-target slice |
| Unknown changed file | full |
| Missing dependency map | full |
| Global coordination state | full or state-specific gate |
| Prior sequenced item changed the same module | recompute affected targets |
| Gate runner failure | block promotion |

The sequencer receipt must include:

- base commit tested;
- candidate commit/ref;
- changed files;
- affected-target mode and reason;
- selected commands;
- skipped targets;
- full-fallback reason if applicable;
- pass/fail result;
- journal chain head at receipt time.

## Lifecycle Integration

Normal optimistic path:

```text
agent work -> gov submit -> review -> gov finalize/land
```

Sequenced path:

```text
agent work
  -> gov submit
  -> overlap detected
  -> enqueue integration group
  -> sequencer tests actual merged result
  -> receipt recorded
  -> gov finalize/land checks receipt
```

`gov explain <ticket>` should eventually show:

- whether the ticket is in a sequenced overlap group;
- queue position;
- required gate mode;
- latest sequencer receipt;
- promotion blocker if the receipt is stale, missing, or failing.

## Journal And Integrity

The journal remains the authority for sequencing evidence. The sequencer should
append events rather than mutating prior events:

- `sequencer.enqueued`
- `sequencer.started`
- `sequencer.gate_result`
- `sequencer.promotable`
- `sequencer.blocked`

Each event cites the previous chain head. This preserves Concord's
tamper-evident audit model and prevents concurrent append cross-linking from
becoming the normal integration path.

## Failure Semantics

| Failure | Result |
| --- | --- |
| Rebase conflict | `repair_required`; ticket returns to owner |
| Affected-target map stale | rerun full gate or block until map updated |
| Gate failure | block promotion; record failed receipt |
| Queue item source changed | mark receipt stale; re-enqueue |
| Sequencer interrupted | resume from journaled queue state |
| Receipt missing at finalize | fail closed |

## Relationship To COORD-351 And COORD-352

COORD-351 increases parallel work by allowing safe repo-X code/doc surfaces to
share waves. COORD-352 reduces validation cost by selecting affected gate
targets. COORD-353 defines where those two optimizations must stop: when
changes overlap, the final combined result needs a sequenced integration proof.

## Non-Goals

- Do not serialize all merges.
- Do not replace human review.
- Do not weaken full-gate or CI policy.
- Do not make rendered artifacts authoritative.
- Do not bypass `gov submit`, `gov finalize`, `gov land`, feature proofs, or
  journal conformance.

## Recommended Implementation Slices

1. Add a read-only `gov sequencer-plan` that groups review-ready tickets by
   overlap and emits queue candidates.
2. Add a local receipt schema and validation helper.
3. Add finalize/land preflight that requires a fresh passing receipt only for
   tickets in active overlap groups.
4. Add optional automation to run the sequencer for one group.
5. Add cockpit visibility for overlap group, queue state, and latest receipt.
