# Concord Decision Log

Status: canonical index of accepted and consciously deferred decisions
Updated: 2026-07-29

The full rationale and consequences live in `coord/docs/decisions/`. This file
is a concise product-facing index and does not replace the ADRs.

## Decisions

### ADR 0001 — Resource-aware multi-agent test architecture

- Status: Deferred; deliberately not built.
- Decision: do not add a shared gate scheduler or evidence broker yet.
- Adopted instead: lane discipline plus provenance-scoped child-process
  containment/reaping.
- Revisit when duplicate heavy work or contention justifies the validity and
  distributed-state complexity.
- Source: `coord/docs/decisions/0001-resource-aware-multi-agent-test-architecture.md`.

### ADR 0002 — Canonical/ephemeral runtime boundary

- Status: Accepted.
- Decision: the integration tree is the single authority writer; linked
  worktrees are non-authoritative implementation contexts.
- Consequence: canonical governance mutations from ephemeral worktrees fail
  closed unless tests redirect all authority paths to a sandbox.
- Source: `coord/docs/decisions/0002-canonical-ephemeral-runtime-boundary.md`.

### ADR 0003 — Governed human writes

- Status: Accepted.
- Decision: trusted SSO/OIDC claims map to governed human actors; authorized
  mutations enter through the serialized coord verb layer.
- Consequence: the cockpit remains read-only by default and web tiers do not
  edit coord files directly.
- Source: `coord/docs/decisions/0003-governed-human-writes-use-trusted-sso-actors-and-the-coord-verb-layer.md`.

### ADR 0004 — Precision-first governed memory kernel

- Status: Accepted.
- Decision: deterministic, cited, status-aware knowledge promotion precedes
  vector-first or broad semantic memory.
- Consequence: extractors propose candidates; implementation is observation,
  not automatic business intent; weak/conflicted/stale claims are quarantined.
- Source: `coord/docs/decisions/0004-precision-first-governed-memory-kernel.md`.

### ADR 0005 — Owner lease over directory/session tokens

- Status: Accepted.
- Decision: durable trusted-actor owner leases are the authority model; session
  tokens and directory locks are not identity authority.
- Consequence: sessions provide liveness/continuity, while ticket ownership and
  collision recovery remain owner-authoritative.
- Source: `coord/docs/decisions/0005-agent-session-identity-uses-owner-lease-over-directory-locks.md`.

### ADR 0006 — Community engine-pin without signing

- Status: Accepted.
- Decision: Community verifies engine drift against a frozen local pin without
  claiming cryptographic authenticity; signing remains a separate trust layer.
- Consequence: pin/manifest consistency must be re-established after every
  intentional build transformation.
- Source: `coord/docs/decisions/0006-engine-pin-verifies-drift-without-signing-in-community.md`.

## Decision hygiene

- New entries require an accepted/deferred ADR or governed decision object.
- Rejected or superseded choices remain in their source record; this index
  summarizes the active decision state only.
- The code-review recommendations in `CODE_REVIEW_BASELINE.md` are not accepted
  architecture decisions unless an ADR is listed here.
