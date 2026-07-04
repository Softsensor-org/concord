# ADR 0001: Resource-Aware Multi-Agent Test Architecture (deferred — deliberately not built)

- **Status:** Deferred (conscious deferral, not a silent gap)
- **Ticket:** COORD-095 (type:spike, P3) — tracks this deferral as a recorded decision
- **Depends on / supersedes context:** COORD-092 (adopted instead, with lane-control)
- **Date:** 2026-06

## Context

During the multi-agent contention discussion we observed a real operational
problem: when several governed agents run heavy gate lanes (`full` / `ci`) on a
shared, memory-constrained host, the runtime children those lanes spawn — vite
dev-servers, chromium/playwright browser workers, node test workers — contend
for RAM. On clean exit they tear down; on crash or OOM-kill they orphan and
accumulate until the host exhausts memory and cascades into more OOM kills.
Duplicate heavy-gate work across overlapping commits/waves is the
cost-amplifier that makes this worse.

The question was whether to build a scheduler that *coordinates* heavy gate work
across agents (so contention is avoided structurally and heavy results can be
shared), or to keep gates independent and only *contain* the runtime damage.

## Linked Scope

- Governing ticket: COORD-095.
- Adopted containment ticket: COORD-092.
- Affected surfaces: gate lanes, multi-agent dispatch, gate runtime process
  cleanup, and landing evidence policy.

## Decision Criteria

- Landing evidence must remain tied to the exact commit being certified.
- The solution must avoid new shared mutable scheduling state unless the
  measured benefit justifies the added failure modes.
- Contention handling should prefer false failure/re-run over false pass.

## Options Evaluated

### Resource-Aware Dispatch + Shared Test Evidence Broker

A coordinated-scheduling architecture with these components:

- **Resource classes per gate** — tag each gate/lane with the resource profile it
  needs (cpu / memory / browser-worker / etc.).
- **Host-capacity profiles** — describe what a given host can run concurrently.
- **Gate leases / semaphores** — distributed locks for scarce workers
  (playwright / vite / browser / heavy node-test pools) so agents acquire a lease
  before spawning a heavy child.
- **Shared WAVE-evidence broker** — a store that lets one agent's heavy gate
  result be *reused* by another agent/commit in the same wave, to avoid
  re-running identical heavy work.
- **Environment / resource-contention failure classification** — distinguish a
  real test regression from a failure caused by host contention (so contention
  failures don't get scored as product failures).
- **Concurrency metadata in gate artifacts** — record lease/host/wave provenance
  alongside each gate verdict.

## Decision

**This architecture is deliberately NOT built.**

## Alternatives Rejected

The resource-aware dispatch and shared test evidence broker were rejected for
this phase. Their validity rules are the hard part: a reused heavy-gate result
could certify the wrong commit if the equivalence policy is incomplete.

## Adopted Instead

Two cheaper, auditable mechanisms cover the real risk without a scheduler or
shared mutable evidence:

1. **Lane-control** — the resource-heavy steps live only in the `full` / `ci`
   lanes; the `default` lane stays the lean local check. There is no scheduler:
   heavy lanes are chosen deliberately and simply should not be run concurrently
   on a memory-constrained host. See the lane vocabulary and `full`/`ci`-only
   gating in [`coord/product/TESTING_AND_GATES.md`](../../product/TESTING_AND_GATES.md)
   (Gate Lane Policy) and the executable gating at `[repo]/scripts/gate.sh`
   (heavy steps run only when `LANE` is `full` or `ci`).
2. **COORD-092 — gate process-orphan containment + provenance-scoped reaper.**
   Gate-spawned heavy children are launched in a tracked process group and
   recorded under `coord/.runtime/` with their owning ticket + `gate_run_id`; a
   `trap EXIT` tears them down so a clean run never leaks, and a
   provenance-scoped reaper (surfaced in `gov doctor`) kills only PIDs coord
   recorded as gate-spawned whose owning gate/lock/ticket is gone — scoped
   strictly by recorded PID + `gate_run_id` with a PID-reuse guard, never by
   process-name heuristic. See the spawn-side containment in
   `backend/scripts/gate.sh` / `frontend/scripts/gate.sh` (COORD-092 block) and
   the reaper logic in `coord/scripts/gate-proc-registry.js`.

Together these contain the *damage* (orphaned processes / OOM cascades) and keep
heavy work proportionate (lane choice), without coordinating *when* agents run or
*sharing* heavy results.

## Rationale

- **Shared-evidence validity is the dangerous part.** The broker's value depends
  on rules for when one wave's heavy result is reusable for a different commit.
  Get those rules even slightly wrong and governance vouches for a regression —
  it certifies commit X as green using evidence produced against a different
  tree. **False confidence is strictly worse than false failure:** a false
  failure costs a re-run; a false pass ships a regression with a governance
  stamp on it.
- **A distributed scheduler adds failure modes the rest of the system does not
  have.** Leases/semaphores bring deadlock, starvation, and stale-lease recovery,
  plus new shared mutable `.runtime` state — in a system whose core value is
  auditable simplicity (a hash-chained journal, single canonical board, gates
  that reproduce from a recorded command).
- The actual observed pain — orphaned heavy processes exhausting RAM — is fully
  addressed by COORD-092 containment + lane discipline, which add no scheduler
  and no shared evidence.

## Consequences

- Duplicate heavy-gate work across overlapping commits/waves is **not**
  deduplicated; the same heavy lane may run more than once across agents. This is
  accepted as the cost of keeping each gate result an independent, auditable
  check of its own commit.
- Operators must not run heavy lanes concurrently on a memory-constrained host;
  this is documented lane discipline, not an enforced scheduler.
- There is no automatic environment-vs-product failure classifier; a
  contention-caused failure is treated like any other gate failure (re-run on a
  capable host), erring toward false failure rather than false pass.
- The capability gap is **recorded, not silent**: this ADR and COORD-095 (status
  `deferred`) are the durable trail.

## Revisit Trigger

Promote this out of `deferred` only when **both** hold:

1. Duplicate heavy-gate cost is a **measured** bottleneck (not a hypothesized
   one) — there is evidence that re-running identical heavy work is a real,
   quantified drag.
2. The **wave-evidence-validity rules are specified and property-tested first** —
   precisely *what makes one wave result reusable for commit X* is written down
   and proven by property tests **before** any broker is built.

Hard invariant that survives any future promotion: **landing evidence must always
remain a clean gate on the exact landing commit.** No reuse rule may let a
landing be certified by evidence produced against a different tree.
