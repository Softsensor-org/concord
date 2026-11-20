# Governance Engine Decomposition Plan (COORD-369)

Status: design / sequenced plan
Owner: Softsensor
Ticket: COORD-369 (umbrella)
Layer label: `design-proposal`

## Why

Two production bugs this cycle (COORD-370 gate bypass, COORD-371 destructive
`doctor --fix`) both traced to the same root: closeout policy is interleaved
across a few very large modules with **shared mutable state**, so a *local*
change has *non-obvious board-wide* blast radius. Current hotspots (production
LOC):

| Module | LOC | Concern that should be its own seam |
|---|---|---|
| `lifecycle.js` | 4,260 | composition root wiring ~38 factories + some inline verb logic |
| `governance-validation.js` | 2,395 | ~16 per-dimension closeout gates + orchestrators |
| `journal.js` | 2,357 | hash-chain / snapshots / seal / repair (4 author-marked sections) |
| `plan-records.js` | 1,999 | read + write/normalize mixed; `readPlanRecord` writes on read |

The good news: **the seams already exist in the code**, they are just not
isolated. `governance-validation.js` is already 16 cohesive `collect*Issues`
functions; `lifecycle.js` is already a DI hub over `createXxx` factories;
`journal.js` already has 4 marked sections; `plan-records.js` already separates
`read*` from `write*` by name. This plan isolates those seams behind stable
interfaces — it does **not** rewrite logic.

## Non-negotiable safety contract (every phase)

1. **Behavior-preserving.** No change to `gov` CLI behavior, public module
   exports, or the **semantics** of any template-canonical surface. Downstream
   `concord`/`enterprise` see identical behavior; only file layout changes.
2. **Characterization-first.** Before moving code, the existing suites (the
   ~1742-test isolation gate + per-module tests) must be green and must pin the
   seam's behavior; add missing coverage at the seam *before* cutting.
3. **One phase per ticket, independently revertable.** Each phase lands behind a
   green full gate + a manifest re-stamp (`ent-NNN`) + re-pin. New modules are
   added to `TEMPLATE_SYNC_MANIFEST.json`; semantics unchanged.
4. **No new behavior.** Bug fixes that are *enabled* by a cut (e.g. COORD-372)
   are filed and landed separately, not smuggled into the move.
5. **Enforce the win.** A new arch-check caps production-module size so the
   modules cannot silently regrow.

## The interfaces to introduce

- **`GateCheck`** — the closeout-gate contract:
  `(ctx) => Issue[]`, where `ctx = { ticket, planState, board, phase }` and an
  `Issue = { code, severity, message, next_steps }`. Pure: a gate reads context
  and returns issues; it never mutates board/plan/journal.
- **`PlanRecordReader` (pure) vs `PlanRecordStore` (mutations).** Reading returns
  a normalized-in-memory record and **never persists**; persistence is an
  explicit `store.repair(...)` / `store.write(...)` call. This structurally
  removes the COORD-371/372 hazard (read-that-writes).

## Sequenced phases (value- and risk-ordered)

### Phase 1 — Split plan-record read from write (HIGHEST value: kills the bug class)
- Extract a **pure** `plan-record-reader.js` (`read*`, schema parse,
  in-memory normalize — no `fs` writes) from `plan-records.js`.
- Keep mutations (`write*`, `syncPlanRecordFromBlock`, `ensure*ForUpdate`,
  `repair`) in `plan-record-store.js`.
- `readPlanRecord`'s default repair-write becomes an **explicit** `store.repair`;
  reads no longer persist. Closes the COORD-371/372 class by construction.
- Lands COORD-372's fix as part of this cut's verification (idempotent reads).
- **Child: COORD-373 (P1).**

### Phase 2 — Decompose the closeout gates (the coupling the review named)
- 2a: introduce the `GateCheck` interface + a **gate registry/pipeline**, and
  extract the two dimensions that had bugs first — **business-context** and
  **ADR** — into `gates/business-context.js`, `gates/adr.js`. The orchestrators
  (`assertReviewPlanReady`, `assertStartPlanReady`) compose the registry.
  **Child: COORD-374 (P1, depends COORD-373 for the pure reader).**
- 2b: extract the remaining collectors — continuity, requirement-closure,
  self-review, context-pack-ack, feature-proof, readiness(start/submit/review),
  bounded-repair — into `gates/*.js`. `governance-validation.js` ends as a thin
  orchestrator. **Child: COORD-375 (P2, depends COORD-374).**
- Payoff: a bug like COORD-370 is now isolated to one small, independently-tested
  gate module instead of a 2,395-line file.

### Phase 3 — Split the journal along its existing sections
- `journal-chain.js` (ENT-002 hash-chain), `journal-snapshots.js` (COORD-033
  restore points), `journal-seal.js` (COORD-220 single-writer bypass detector),
  `journal-repair.js` (COORD-124 chain repair), behind the existing `createJournal`
  factory interface. **Child: COORD-376 (P2).**

### Phase 4 — Slim `lifecycle.js` to a pure composition root
- Move remaining inline verb logic (`approveTicket`, `rejectTicket`, the
  `signChainTransition` closure, etc.) into the existing factories
  (`createTicketTransitions`, `createCloseout`, `createConformanceVerbs`).
- `lifecycle.js` ends as DI wiring only. **Child: COORD-377 (P2, depends 374/376).**
- Closeout-quality exception recorded by COORD-398: COORD-377 was marked done
  even though the measured lifecycle module did not become the promised pure
  composition root. Any future slimming/decomposition refactor must carry a
  computed `decomposition-proof:` entry with before/after `countLoc`, named
  extracted functions or rationale, target max, and ratcheted budget evidence;
  review readiness now fails closed when that measured proof is missing or stale.

### Phase 5 — Lock the win
- Add an arch-check (`arch-checks.js`) enforcing a **production-module LOC budget**
  (target: no non-test module > 1,200 lines; grandfather + ratchet down).
  **Child: COORD-378 (P3).**

## Dependency graph

```
COORD-373 (plan-record read/write split, P1)
  └─> COORD-374 (gate interface + business-context/ADR gates, P1)
        └─> COORD-375 (remaining gates, P2)
        └─> COORD-377 (slim lifecycle, P2)  [also depends COORD-376]
COORD-376 (journal split, P2)
COORD-378 (LOC-budget arch-check, P3)  [ratchets after the cuts land]
```

## Acceptance (umbrella)

- Each phase lands behavior-preserving (full isolation gate green; semantics of
  canonical surfaces unchanged; manifest re-stamped/re-pinned per phase).
- After Phase 1–4: no closeout dimension's logic spans more than its own module;
  reads cannot write; `lifecycle.js` and `governance-validation.js` are thin
  composers.
- After Phase 5: the LOC budget arch-check fails CI if a module regrows past the
  cap — the coupling cannot silently return.
