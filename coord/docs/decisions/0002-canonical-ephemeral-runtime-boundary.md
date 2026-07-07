# ADR 0002: Canonical/Ephemeral Runtime Boundary

- **Status:** Accepted
- **Ticket:** COORD-394
- **Date:** 2026-06

## Context

Concord supports fleets of agents working in isolated git worktrees. That model
only scales if the worktree is treated as an implementation sandbox, not as an
authority writer for the shared governance state. The authoritative board,
journal, plan records, and snapshots must remain owned by the integration tree,
where a single governed writer can serialize mutations and preserve the
hash-chain and closeout evidence.

Prior work made worktree-per-agent the default and added a merge-queue state
surface for contending land/finalize operations. COORD-394 makes the boundary
physical: a linked worktree can read governance context and run tests, but it
cannot directly mutate canonical authority state.

## Linked Scope

- Governing ticket: COORD-394.
- Depends on: COORD-388 and COORD-389.
- Affected surfaces: runtime role detection, governance mutation lock, coord
  worktree runtime creation, and multi-agent topology guidance.

## Decision Criteria

- Canonical state must have exactly one authoritative writer.
- Agent worktrees must stay useful for implementation and tests.
- Test sandboxes must not be mistaken for unsafe production worktrees.
- The failure mode for ambiguous authority must be refusal with remediation, not
  silent canonical mutation.

## Options Evaluated

### Policy-Only Boundary

Document that agents should not write canonical state from linked worktrees and
rely on operators to follow the workflow.

### Physical Runtime Role Boundary

Detect linked git worktrees using `.git` metadata and an explicit runtime role
marker. Refuse canonical-authority mutations from an ephemeral role when the
authoritative journal/snapshot/plan paths point at the live checkout. Allow
test/runtime sandboxes that redirect authority paths outside the checkout.

## Decision

Adopt the physical runtime role boundary.

Linked worktrees are `ephemeral_worktree` role. The integration checkout is
`canonical_integration_tree`. Worktree-local `coord/.runtime/runtime-role.json`
records the ephemeral role and states that the runtime is non-authoritative until
landed.

## Alternatives Rejected

The policy-only boundary is rejected. It leaves the exact collision class that
the multi-agent architecture is meant to eliminate: a fast agent can mutate
board/journal/plan state from the wrong checkout and make the canonical chain
look authoritative even though integration was not serialized.

## Adopted Instead

- Detect the checkout role from `.git` shape and the runtime role marker.
- Refuse governance runtime mutations from an ephemeral role when authority
  paths are live under the checkout.
- Permit sandboxed tests that redirect journal/snapshot/plan authority outside
  the checkout.
- Continue to use normal governed land/finalize from the integration tree as the
  canonical mutation path.

## Rationale

This preserves Concord's verification architecture while allowing high
parallelism. Agents can still develop and test in isolated worktrees, but the
shared board, journal, plan records, and snapshots are only mutated by the
canonical integration tree or the serialized queue path.

## Consequences

- A linked worktree that attempts a canonical governance mutation receives a
  fail-closed error with remediation.
- Worktree-local runtime files are explicit scratch/ephemeral artifacts and are
  gitignored.
- Operators must run final canonical lifecycle mutations from the integration
  tree, or route the work through the merge-queue/orchestrator path.
- Tests that need mutation behavior must sandbox authority paths outside the
  checkout.

## Revisit Trigger

Revisit if Concord later introduces a remote coordination service with its own
transactional authority store. Until then, the local integration tree remains the
single canonical writer.

## Waiver Policy

No general waiver. A test may bypass the boundary only by redirecting authority
paths to a sandbox outside the checkout. Production/workflow code must not pass
an override to mutate canonical state from an ephemeral worktree.
