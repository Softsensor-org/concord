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

COORD-635 has since landed the control-plane Git lifecycle correction. X now
uses the control-plane repository for governed worktrees, commits and closeout.
The former scratch-directory contradiction was historical motivation, not a
current unresolved Git-root defect. This ADR addresses the remaining semantic
ambiguity: the same X code still labels coord work, cross-repo coordination and
the unknown-prefix fallback.

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

**Proposed, not yet accepted or implemented.** Recommend option C with `Target`
separate from physical `Repo`: `product_repo`, `control_plane`, and `cross_repo`.
Repo X remains the control-plane home; explicit Target distinguishes an engine
implementation from a cross-repo coordination record. Unknown, malformed,
missing, colliding or inconsistent prefixes fail closed before mutation.

The [reviewed proposal and migration protocol](../reviews/COORD-636-target-semantics-and-migration.md)
specifies the resolver table, board-owned participant/child contract, concrete
manifest encoding and storage, owner/reviewer attestation, rollback protocol,
and implementation acceptance tests. Its recommendations are:

- A cross-repo parent declares at least two distinct physical repositories,
  each typed product_repo or control_plane, with exactly one matching required
  implementation child. No cross-repo child or participant is allowed.
- Parent closeout joins every child's independently verified gates, review and
  landing under that repository's existing policy. One coord commit or one
  fulfilled-by reference cannot stand in for all participants.
- Terminal historical X rows and evidence remain unchanged. An immutable,
  digest-bound sidecar classifies them as historical `legacy_x`; it is not a
  fourth active Target and cannot upgrade old evidence.
- Every open X row needs owner-attested, separately reviewed reclassification
  with expected row digests. Ambiguity refuses routing; no prefix-only migration.
- Apply and rollback are governed, checkpointed operations with exact digest
  preconditions. A rollback cannot overwrite later legitimate work.

Before acceptance, the human decision maker reviews these concrete choices,
including the compatibility manifest, participant schema, attestation roles and
existing per-repo terminal-state policies. Acceptance and implementation remain
separate from COORD-636's design deliverable. No board migration is performed.

## Alternatives Rejected

Option A is rejected: it is the status quo that produced the contradictions and
the silent-fallback hazard. Option B alone is rejected because children without
a first-class participant contract cannot prove that every required repository delivered. Its useful
physical-ownership distinction is retained by keeping Repo separate from Target.
A fourth active planning-only target is unnecessary: planning belongs to its
physical owner unless it actually coordinates required multi-repo delivery.
Heuristic historical reclassification and an unknown-prefix override are rejected
because both would silently change authority or the meaning of old evidence.

## Consequences

- Existing routing remains unchanged while this ADR is Proposed. COORD-635
  already supplies the usable control-plane Git lifecycle; this proposal does
  not block ordinary work on that repaired lifecycle.
- Deciding this changes cross-repository coordination semantics and the behaviour
  of future ticket classes, so it requires review before acceptance rather than
  being settled inside an implementation ticket.
- Migration will need its own execution tickets gated on acceptance.
