# ADR 0019: Phase cost observations reuse the governed cost ledger

- **Status:** Accepted
- **Ticket:** COORD-772
- **Date:** 2026-10-22
- **Linked scope:** dispatch phase boundaries, record-cost, cost reports and explain advisories.

## Context

The existing cost.observed event and gov record-cost/cost surfaces can record cost, but routine dispatch and closeout do not reliably supply phase evidence. Missing observations prevent meaningful evaluation of token-economics changes. An invented estimate or zero would conceal missing data.

## Linked Scope

- Governing ticket: COORD-772.
- Existing dispatch adapters, cost observation journal, cost reporting and ticket explain.
- No new billing service, second ledger, budget enforcement or implementation approval is implied by this decision alone.

## Decision Criteria

Keep one authoritative observation path, explicit provenance, retry-safe accounting, phase attribution and honest unknown values. Missing cost must not block an otherwise valid ticket closeout.

## Options Evaluated

1. Integrate the existing cost writer at plan, implement and review phase boundaries.
2. Maintain a separate automatic cost ledger.
3. Estimate all usage from transcript size or treat missing observations as zero.
4. Make cost completeness a mandatory landing gate.

## Decision

Use option 1. Dispatch adapters submit actual provider-reported usage or explicitly attributed measured inputs through the existing governed cost observation path. Record ticket, agent, model, phase and measurement provenance. Preserve the distinction between measured token usage and monetary cost computed from a documented rate; unavailable inputs or prices remain unknown.

Define a stable observation identity from the dispatch execution, phase and attempt so identical retry/recovery delivery is idempotent and conflicting reuse is refused. Distinct actual attempts remain separate observations. If a provider reports cumulative usage, do not double-count it as both cumulative and per-phase usage. Do not fabricate phase splits when the provider supplies only a combined total.

Collect evidence at phase completion and recover available evidence after interruption. Missing or incomplete observations appear as advisories in gov explain and remain distinct from measured zero. Existing gov cost reports aggregate the observations by ticket, agent, model and phase. No missing-cost blocking gate is added.

## Alternatives Rejected

A second ledger introduces disagreement and duplicated recovery. Transcript-length estimates cannot be represented as measured provider usage. Zero for missing data creates false savings. A mandatory gate would make provider telemetry availability an unrelated delivery blocker.

## Consequences

Some runs will remain partly unknown. Reports must expose measurement coverage and provenance rather than imply complete totals. Adapter integration and idempotency require production-path tests for retries, distinct attempts, interruption, missing telemetry and cumulative counters. No raw prompts, responses, secrets or transcripts are needed in cost observations.

## Revisit Trigger

Revisit before introducing a mandatory cost gate, a new ledger, pricing automation, or an adapter whose usage cannot be attributed without double-counting.
