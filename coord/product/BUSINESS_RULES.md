# Concord Business Rules

Status: canonical baseline
Updated: 2026-07-29

Rules marked **accepted** are already grounded in governance policy, requirements,
or an accepted ADR. Rules marked **proposed hardening** describe a verified gap
and are not claimed as implemented.

## Authority and state

### BR-001 — One canonical writer (**accepted**)

Shared board, plan, journal, snapshot, and derived-view mutations are serialized
through the canonical integration tree. Linked worktrees are implementation
sandboxes, not authority writers. Source: ADR 0002.

### BR-002 — Canonical before derived (**accepted**)

Governance commands mutate canonical state first and regenerate derived views.
Rendered views and synthesis outputs are never hand-edited as authority. Source:
`coord/DIRECTORY.md` and `coord/product/ARCHITECTURE.md`.

### BR-003 — Legal lifecycle only (**accepted**)

Tickets follow the transitions in `coord/GOVERNANCE.md` Section 4. Blocked work
must transition through explicit `unblock` before review. Supersede is not a
substitute for closing landed work.

### BR-004 — Done means landed (**accepted; enforcement gap COORD-512**)

A done ticket has reviewed work on the canonical base plus recorded landing
evidence. A board transition cannot manufacture landing truth.

## Ownership, locks, and recovery

### BR-005 — One owner and protected context (**accepted**)

Every doing-form ticket has one active owner and a complete canonical lock.
Session identity supports continuity but is not ownership authority.

### BR-006 — Status classification is role-specific (**proposed hardening; COORD-558**)

Ownership, lock protection, heartbeat, and recovery treat blocked-doing as an
active doing-form. Advancement to review does not. Implement named predicates
for semantic roles instead of replacing every equality check with one broad
predicate.

### BR-007 — Recovery is monotonic (**proposed hardening; COORD-558**)

A recovery attempt must reduce or preserve the invariant-violation set. It must
not delete the last valid lock/lease evidence because a legal status was
misclassified. When safe repair is impossible, fail closed with the exact next
governed action.

### BR-008 — Session release preserves active work (**proposed hardening; COORD-558**)

A fresh rebind or session release must refuse while it owns active tickets, or
transfer them atomically to a valid successor context.

## Evidence and closeout

### BR-009 — Evidence is tree-specific (**accepted**)

A gate or feature proof certifies only the commit/tree it inspected. Shared or
reused evidence needs an explicit equivalence rule; otherwise rerun.

### BR-010 — Closeout is source-backed (**accepted**)

Review cycles, requirement closure, gate results, feature proofs, and landing
provenance are durable artifacts. Chat narration alone is not closeout evidence.

### BR-011 — External side effects are reconciled (**accepted**)

If a PR merge or other external side effect succeeds but the local mutation
fails, the journal records it and retry is idempotent. Do not roll back history
by pretending the side effect did not occur.

## Contracts and operator surfaces

### BR-012 — One machine contract, many renderings (**proposed hardening; COORD-572**)

Command names, aliases, flags, JSON fields, accepted enums, help, MCP schemas,
and emitted remediation derive from one machine-readable contract. Every
printed `Next:` action must parse and satisfy the condition that emitted it.

### BR-013 — Invalid input fails at the writer (**proposed hardening; COORD-571/525**)

Writers validate against the canonical schema before persistence. Unknown enum
values, malformed metadata, and unexpected object keys are rejected or reported
explicitly; they are not silently coerced into defaults.

### BR-014 — Operator views never substitute truth (**proposed hardening; COORD-543**)

When a configured repository is outside an approved path boundary, the cockpit
reports it unavailable/out-of-scope. It never substitutes the engine root or
another plausible directory.

## Knowledge and decisions

### BR-015 — Observation is not intent (**accepted**)

Implementation and generated discovery records are observations. They become
governed business constraints only through cited promotion with sufficient
source authority. Source: ADR 0004.

### BR-016 — Precision before coverage (**accepted**)

Stale, conflicted, rejected, private, weak, or purely inferred claims are not
retrieval-eligible as active implementation constraints.

### BR-017 — Decisions remain explicit (**accepted**)

Architecture/product choices use ADRs or governed decision objects with status,
rationale, linked scope, consequences, and revisit conditions. Deferred choices
remain visible rather than becoming accidental implementation defaults.

## Release and install

### BR-018 — Verify the built artifact (**proposed hardening; COORD-520/560**)

Release validation runs against the final transformed artifact, not only the
donor tree. Every executable install path must exist in the cut, and every
integrity pin/manifest must match the cut after scrubbing.

### BR-019 — Public claims match shipped behavior (**accepted**)

Documentation, package metadata, binaries, install commands, and cockpit
security posture describe only capabilities present in the verified artifact.

## Human writes

### BR-020 — Trusted actor through governed verbs (**accepted**)

Human mutations derive identity from trusted SSO/OIDC edge claims, apply a
deny-by-default board-scoped role policy, and enter through the same serialized
governed verb layer. The web tier does not directly edit coord files. Source:
ADR 0003.
