# ADR 0003: Governed human writes use trusted SSO actors and the coord verb layer

- **Status:** Accepted
- **Ticket:** COORD-417
- **Date:** 2026-06
- **Linked scope:** Human-agent platform T1; identity-v2; human-write transport; coord verb layer; per-repo writer serialization.

## Context

Concord's developer/agent path is already governed through CLI/MCP lifecycle
verbs, owner leases, locks, journal events, plan records, and evidence gates.
The Human-Agent Coordination Platform adds a second population: business users
who should author requirements, approve decisions, and give product feedback
without using git or the CLI.

That creates a security boundary. A hosted web tier cannot be allowed to edit
coord files directly, infer identity from request bodies, or bypass the
single-writer/journal path. At the same time, non-developer humans need durable
attribution and board-scoped roles such as `business-analyst`, `approver`, and
`viewer`.

## Linked Scope

- Linked ticket: COORD-417.
- Governing ticket: COORD-417.
- Affected modules: `coord/scripts/identity-v2.js` and
  `coord/scripts/human-agent-platform.js`.
- Downstream tickets: COORD-418 requirements authoring, COORD-419 product-screen
  feedback bridge, COORD-420 loop orchestration, and COORD-421 hosted control
  plane.

## Decision Criteria

- Human identity must come from trusted SSO/OIDC edge claims, not from a request
  body or browser-provided author field.
- Human writes must become governed verb envelopes that the existing lifecycle
  machinery can journal, authorize, serialize, and seal.
- Mutating requests must serialize through one writer per coord data repo.
- The coord-ui/web tier remains read-only unless it is explicitly acting as a
  transport to the governed write service.
- The first implementation must be testable without live IdP, network, or
  deployment dependencies.

## Options Evaluated

1. **Direct web-tier file mutation.** The hosted UI validates a session and writes
   board/requirements files itself.
2. **Git-authored human changes.** Business users submit changes through git,
   issues, or PRs.
3. **Trusted SSO actor plus governed verb envelope.** The edge authenticates the
   user through OIDC/SSO, maps the claims to a governed actor, authorizes the
   requested action, and emits a verb envelope to the same writer/coord lifecycle
   used by agents.

## Decision

Use option 3: human writes use trusted SSO/OIDC claims mapped into a governed
human actor, then pass through a deny-by-default board-scoped role policy and a
single writer per coord data repo. The transport emits a governed verb envelope;
it does not edit coord files directly.

## Alternatives Rejected

- Direct web-tier file mutation is rejected because it would create a second
  authority path outside journal/lock/seal evidence.
- Git-authored human changes are rejected as the primary path because business
  users are first-class governance participants and may not have git access.
- Treating arbitrary request-body actor fields as identity is rejected because it
  is spoofable.

## Consequences

- The deployment edge must provide trusted OIDC/SSO claims to the write service.
- The public coord-ui remains a read-only cockpit by default; any write-capable
  hosted deployment must route through the governed write service.
- T2-T5 can reuse one human-write contract instead of inventing separate
  authoring, feedback, loop, and deployment mutation paths.
- Real JWT/IdP verification remains a deployment concern for COORD-421; the
  engine contract stays pure and deterministic for local tests.
