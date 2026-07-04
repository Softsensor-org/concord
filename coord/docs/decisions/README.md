# Decision Records (ADRs)

This directory holds **Architecture / Architectural Decision Records** — durable,
numbered notes that capture a significant decision: the context, the options
considered, what was decided, what was adopted instead, the rationale, the
consequences, and (when the decision is a deferral) the explicit trigger that
would reopen it.

These records exist so that *conscious deferrals and rejected designs are not
silent gaps*. A decision to deliberately **not** build something is just as
worth recording as a decision to build it — otherwise the option gets
re-proposed and re-litigated, or worse, the gap looks like an oversight.

Not every operational or human decision is an ADR. Continuity Phase 1 also
allows lightweight **decision objects** for choices that need warm-start
visibility but do not yet change architecture, security, data authority, memory
authority, or operator policy. Those objects live in governed source artifacts
such as plan records, questions, ticket-local context, or future continuity
records and are extracted as derived advisory records by
`coord/scripts/decision-extractor.js`.

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, where `NNNN` is a
  zero-padded sequence number (`0001`, `0002`, …).
- Start each record with a short status block:
  - **Status:** Proposed | Accepted | Deferred | Rejected | Superseded (by `NNNN`)
  - **Ticket:** the governing ticket id, when there is one
  - **Date:** roughly when the decision was made
- Then the body, in this order where applicable:
  **Context → Linked Scope → Decision Criteria → Option(s) Evaluated →
  Decision → Alternatives Rejected → Adopted Instead → Rationale →
  Consequences → Revisit Trigger → Waiver Policy** (the Revisit Trigger is
  required for any `Deferred` record).
- Keep records append-only in spirit: supersede with a new record rather than
  rewriting history; mark the old one `Superseded`.
- Numbers are never reused, even if a record is superseded.
- Validate the registry with:

  ```bash
  coord/scripts/coord adr-validate --json
  ```

- Use the governed `gov adr` surface for ADR mutations:

  ```bash
  coord/scripts/gov adr list
  coord/scripts/gov adr show 0001
  coord/scripts/gov adr check
  coord/scripts/gov adr new --title "Decision title" --ticket COORD-123
  coord/scripts/gov adr link COORD-123 0002
  coord/scripts/gov adr supersede 0001 --by 0002
  ```

  `list`, `show`, and `check` are read-only. `new`, `link`, and `supersede`
  run through the governed mutation/journal path and re-validate the ADR
  registry before returning. This is a decision-record surface only; it is not a
  free-form agent-memory write path.

- Generate the read-only ADR cockpit/readout with:

  ```bash
  coord/scripts/coord adr-validate --cockpit --json
  coord/scripts/coord adr-validate --cockpit --demo --json
  ```

  The cockpit readout is derived data. It surfaces the ADR index, status
  coverage, affected repos/modules, linked tickets and requirements,
  supersession chains, revisit triggers, and non-terminal decision-required
  tickets that are missing an accepted ADR. It renders copyable governed
  commands for fixes, but it must not mutate ADR files, board rows, plan
  records, runtime state, or generated artifacts. `--demo` includes public-safe
  fixture cases for accepted, deferred, superseded, and missing-ADR states.

This index also seeds the procedural-memory-promotion target from COORD-145:
when a decision establishes a recurring agent convention, the durable home for
that convention is a record here (and, if it changes agent *behavior*, the
corresponding procedural surface).

## Where ADRs Sit In Coord

ADRs are the durable decision layer between requirements and tickets:

```text
URS / PRD / SRS / business discovery
  -> ADR when a high-impact choice is required
  -> epics / tickets
  -> implementation evidence and closeout
```

Requirements describe what the system must achieve. ADRs record why a major
approach was chosen, rejected, deferred, or superseded. Tickets execute the
chosen path. Ordinary implementation tickets do not need an ADR when they are
only applying an already accepted pattern.

## Recall And Context-Pack Consumption

Accepted ADRs are indexed by `gov recall` and therefore appear in prework packs
through the existing `relevant_prior_work` section. Business context packs also
include ticket-relevant ADR sections:

- `adrs` contains accepted, non-superseded decisions that match the ticket id,
  linked tickets, requirements, scope text, touched files, or decision body.
- `adr_history` contains relevant rejected, deferred, proposed, or superseded
  ADRs. These records explain prior alternatives and conscious deferrals, but
  do not govern implementation.

Each ADR item carries a citation back to the ADR markdown file and surfaces the
decision, rejected alternatives, consequences, and revisit trigger when present.
Superseded ADRs must remain history-only; the replacing accepted ADR is the
active guidance.

## When An ADR Is Required

Create an ADR before or during ticket planning when any of these are true:

- the decision changes architecture, deployment topology, security boundary,
  data model, memory/knowledge authority, or agent operating protocol;
- the decision affects multiple repos, tracks, teams, tenants, or future ticket
  classes;
- multiple plausible options exist and the rejected alternatives are likely to
  be re-proposed later;
- a deferral is intentional and the gap should not look like an oversight;
- the decision changes how requirements, URS/SRS artifacts, gates, reviews,
  context packs, or generated knowledge are interpreted;
- the decision accepts a material risk, waiver, or temporary constraint.

## When An ADR Is Optional

An ADR is optional when a ticket:

- follows an existing accepted ADR or documented pattern;
- is a local bug fix with no broader policy, data, security, or workflow
  consequence;
- only updates copy, tests, docs, or UI details without changing decision
  authority;
- records its tradeoff sufficiently in the ticket plan's requirement closure and
  self-review cycles.

If in doubt, create a short proposed ADR or record the reason for not creating
one in the ticket plan.

## Lightweight Decision Objects

Use a decision object when the choice is operational, human-owned, or
time-bound and the main need is continuity rather than durable architecture
policy. Examples include a rollout owner, a scoped approval, a cadence follow-up
choice, a temporary product call, or a human decision that should appear in the
next warm-start.

Decision objects use schema version `continuity-decision-object/v1` and carry:

| Field | Meaning |
| --- | --- |
| `id` | Stable decision id, unique within its source scope. |
| `status` | `open`, `proposed`, `pending`, `needs_decision`, `resolved`, `accepted`, `rejected`, `deferred`, or `superseded`. |
| `type` | Decision class such as `operational`, `human`, `product`, `cadence`, `memory`, or `adr_candidate`. |
| `subject` | Short noun phrase naming the decision. |
| `question` | The decision question being answered or still pending. |
| `why_now` | Why the decision is needed now instead of later. |
| `options` | Options considered, with optional ids and tradeoffs. |
| `recommendation` | Current recommended answer, if any. |
| `owner` | Person, role, team, or process expected to decide. |
| `needed_by` | Date, ticket, cadence, or milestone that needs the answer. |
| `resolution` | Answer, deciding actor/time, durability flag, and promotion target when resolved. |
| `sources` | Governed source refs, files, commands, tickets, ADRs, or evidence. |
| `supersession` | Superseded or superseding decision ids and reason. |
| `linked` | Scoped `tickets` and `cadences` affected by the decision. |

Open decision objects must appear in warm-start readouts for their linked
ticket or cadence scope. They are advisory for ordinary work. An unresolved
decision may block only the scoped risky work that depends on it; it must not
freeze unrelated tickets.

Resolved decision objects can become promotion candidates when their
`resolution.durable` flag is true or `resolution.promote_to` includes a target
such as `memory` or `adr`. Promotion still uses the governed path for the target
artifact: an ADR for architecture/policy choices, the memory compiler for memory
claims, requirements updates for requirements, and tickets for implementation
work.

## Status Model

| Status | Meaning |
| --- | --- |
| `Proposed` | A decision is under review. It can inform planning but must not be treated as settled. |
| `Accepted` | The chosen option governs future tickets until superseded. |
| `Deferred` | A conscious decision not to decide/build now; must include a revisit trigger. |
| `Rejected` | A considered option was declined; useful to prevent repeated debate. |
| `Superseded` | A newer ADR replaces this one; keep the old record for history. |

## Required Links

Each ADR should link as applicable:

- URS/PRD/SRS/REQ ids or source docs;
- business discovery records or context-pack refs;
- governing epics and tickets;
- affected repos, modules, schemas, APIs, workflows, or UI surfaces;
- tests/gates/evidence that will prove the decision is followed;
- superseding or superseded ADR ids.

## Minimal Template

```markdown
# ADR NNNN: <short title>

- **Status:** Proposed | Accepted | Deferred | Rejected | Superseded
- **Ticket:** <governing ticket id>
- **Date:** YYYY-MM
- **Linked scope:** <requirements, epics, tickets, repos, modules>

## Context

## Linked Scope

## Decision Criteria

## Options Evaluated

## Decision

## Alternatives Rejected

## Consequences

## Revisit Trigger

Required for Deferred and recommended for Accepted decisions with known risk.

## Waiver Policy

State who can waive the decision, under what condition, and what evidence must
be recorded.
```

## Waiver Policy

Waivers must be explicit and ticket-scoped. A waiver can let one ticket proceed
without following an ADR, but it does not change the ADR. If the waiver becomes
repeated or permanent, write a new ADR that supersedes the old one.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture (deferred — deliberately not built) | Deferred |
| [0002](./0002-canonical-ephemeral-runtime-boundary.md) | Canonical/Ephemeral Runtime Boundary | Accepted |
| [0003](./0003-governed-human-writes-use-trusted-sso-actors-and-the-coord-verb-layer.md) | Governed human writes use trusted SSO actors and the coord verb layer | Accepted |
| [0004](./0004-precision-first-governed-memory-kernel.md) | Precision-First Governed Memory Kernel | Accepted |
| [0005](./0005-agent-session-identity-uses-owner-lease-over-directory-locks.md) | Agent session identity uses a trusted-actor owner-lease, not session tokens | Accepted |
| [0006](./0006-engine-pin-verifies-drift-without-signing-in-community.md) | Engine-pin verifies drift without cryptographic signing in Community | Accepted |
