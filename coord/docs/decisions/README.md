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

## Convention

- One file per decision: `NNNN-short-kebab-title.md`, where `NNNN` is a
  zero-padded sequence number (`0001`, `0002`, …).
- Start each record with a short status block:
  - **Status:** Proposed | Accepted | Deferred | Superseded (by `NNNN`)
  - **Ticket:** the governing ticket id, when there is one
  - **Date:** roughly when the decision was made
- Then the body, in this order where applicable:
  **Context → Option(s) Evaluated → Decision → Adopted Instead → Rationale →
  Consequences → Revisit Trigger** (the Revisit Trigger is required for any
  `Deferred` record).
- Keep records append-only in spirit: supersede with a new record rather than
  rewriting history; mark the old one `Superseded`.
- Numbers are never reused, even if a record is superseded.

This index also seeds the procedural-memory-promotion target from COORD-145:
when a decision establishes a recurring agent convention, the durable home for
that convention is a record here (and, if it changes agent *behavior*, the
corresponding procedural surface).

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](./0001-resource-aware-multi-agent-test-architecture.md) | Resource-Aware Multi-Agent Test Architecture | Deferred |
