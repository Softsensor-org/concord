# ADR 0009: Control-plane and cross-repository work use distinct ticket targets

- **Status:** Proposed
- **Ticket:** COORD-636
- **Date:** 2026-08
- **Linked scope:** coord/scripts/ticket-commands.js, coord/scripts/worktree-ops.js, coord/scripts/governance-validation.js, coord/board/tasks.schema.json

## Context

The engine currently treats Repo-X as four different things at once:

1. coord-owned implementation work (changes to the governance engine itself),
2. cross-repository coordination,
3. design/planning work with no repository target,
4. the fallback bucket for unknown ticket prefixes.

That ambiguity is independent of the Git-ownership defect and will survive
fixing it. It already produces contradictory behaviour: the engine creates a real
Git worktree for X while `ticket-commands.js` refuses `commit-ticket` for X and
describes X worktrees as "plain scratch directories with no git history", and
`coord/scripts/README.md` tells operators X has no governed worktree at all.

Because X is also the fallback for unrecognised prefixes, unrelated work can
silently acquire control-plane semantics.

## Linked Scope

- COORD-636 — architecture decision and migration plan for ticket targets
- COORD-635 — control-plane Git lifecycle (the target model should be decided
  against a lifecycle that actually works)

## Decision Criteria

1. Every ticket must have exactly one unambiguous target.
2. Unknown prefixes must never silently acquire control-plane semantics.
3. Cross-repository work must produce honest per-repo review evidence, per-repo
   gates and per-repo landing provenance.
4. Hundreds of historical `done` X rows must not be retroactively reinterpreted.
5. The model must be decidable without blocking the Git-ownership correction.

## Options Evaluated

**A. Keep X as an omnibus target.** No migration cost, but preserves every
contradiction above and keeps the unknown-prefix fallback.

**B. X means control-plane only.** Cross-repo work becomes a coordination
ticket with child tickets per repository. Clear, but leaves genuine multi-repo
coordination without a first-class representation unless children are modelled.

**C. Explicit targets: `product_repo`, `control_plane`, `cross_repo`.** X is
resolved to one of these; unknown prefixes fail closed. Cross-repo tickets
declare participant repositories and coordinate repo-specific child delivery.
This is the shape the criteria point to, but the migration of historical rows is
the open question.

## Decision

**Proposed, not yet decided.** The intended direction is option C: three explicit
targets — `product_repo`, `control_plane`, `cross_repo` — with unknown prefixes
failing closed, and cross-repo tickets declaring participating repositories and
delivering through repo-specific children rather than modifying several
repositories from one worktree.

The following remain open and must be resolved before this ADR is Accepted:

- whether X becomes `cross_repo` exclusively with a new explicit control-plane
  target introduced alongside it, or X becomes `control_plane` with a new
  cross-repo target;
- how participant repositories and child-ticket evidence are represented;
- closeout rules for genuine cross-repo work;
- compatibility and migration for historical X tickets, including proof that no
  historical row is silently reinterpreted.

## Alternatives Rejected

Option A is rejected: it is the status quo that produced the contradictions and
the silent-fallback hazard. Option B is retained as a live sub-option within the
open questions rather than rejected outright, since it may be the right answer
once child-ticket modelling is specified.

## Consequences

- Until this is decided, X retains its ambiguity and control-plane tickets should
  not be dispatched against a lifecycle that does not yet work (COORD-635).
- Deciding this changes cross-repository coordination semantics and the behaviour
  of future ticket classes, so it requires review before acceptance rather than
  being settled inside an implementation ticket.
- Migration will need its own execution tickets gated on acceptance.
