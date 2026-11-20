# ADR 0005: Agent session identity uses a trusted-actor owner-lease, not session tokens

- **Status:** Accepted
- **Ticket:** COORD-435 (records the GCV-1 identity-convergence decision)
- **Date:** 2026-07
- **Linked scope:** identity-v2; owner-lease registry; single-writer claim path; the `COORD_SESSION_ID`/`CLAUDE_CODE_SESSION_ID` resolution order.

## Context

Many AI agents run against one board, sometimes sharing a checkout. Each must be
attributable to a stable identity so ownership, locks, and journal attribution are
unambiguous. The Claude Code harness injects one identical `CLAUDE_CODE_SESSION_ID`
into every sub-agent of a conversation, so a session token alone collapses N
sub-agents into one identity and churns each other's claims. The GCV-1
identity-convergence work resolved how identity is established; this ADR records
that decision so it is not a silent gap.

## Linked Scope

`coord/scripts/identity-v2.js` (the owner-lease registry and actor resolution),
the `claim`/`start` lifecycle path, and the environment-variable resolution order
documented in `CLAUDE.md` Session Discipline.

## Decision Criteria

- Two agents must never resolve to the same governed identity by accident.
- Identity must be stable across a session's lifetime and attributable in the
  journal.
- A crash or a shared checkout must not silently transfer ownership.
- The mechanism must not depend on a central server (data-light constraint).

## Options Evaluated

1. **Session token only** (`CLAUDE_CODE_SESSION_ID`) — rejected: the harness makes
   it non-unique across sub-agents.
2. **Directory lock only** — insufficient as an *identity*: a lock says "someone
   holds it", not *who*, and cannot be attributed durably in the journal.
3. **Owner-lease registry keyed by a resolvable actor** (chosen) — an explicit
   `COORD_SESSION_ID` overrides the harness token, and the owner-lease registry
   records which actor holds which ticket, serialized through the single-writer
   claim path.

## Decision

Agent identity resolves to a **trusted actor** with `COORD_SESSION_ID` taking
precedence over `CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID`, and ownership is held
via an **owner-lease registry** (`identity-v2.js`) whose read-modify-write is
serialized under `withAgentStateLock` and written atomically (COORD-429). The
`mkdir` runtime lock remains the correctness authority for journal-append
serialization; the lease is the *identity/ownership* layer above it.

## Alternatives Rejected

- Deriving identity purely from git author/committer (unstable for agents; not
  present for non-dev actors).
- A central identity service (violates the data-light, no-server constraint for
  the Community edition).

## Consequences

- Orchestrator topologies MUST export a distinct `COORD_SESSION_ID` per sub-agent.
- The owner-lease registry is now a first-class governed artifact; its write is
  crash-atomic (COORD-429) and its concurrent access is lock-serialized.
- Revisit trigger: if the harness ever guarantees per-sub-agent unique session
  tokens, the `COORD_SESSION_ID` override could be revisited.
