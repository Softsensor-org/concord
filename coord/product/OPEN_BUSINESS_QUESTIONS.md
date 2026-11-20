# Concord Open Business Questions

Status: curated decision queue
Updated: 2026-07-29

These are product/operating decisions, not raw extractor questions. Each needs a
human owner and, when implementation follows, a governed ticket or ADR.

## OBQ-001 — What is the supported install channel for the next public release?

- Why open: npm scaffolder availability, source cuts, and standalone
  binaries currently describe overlapping paths, and at least one public path
  is internally broken.
- Decision needed: primary channel, fallback channel, supported platforms, and
  artifact-level acceptance proof.
- Related work: COORD-520, COORD-481 and release verification tickets.

## OBQ-002 — What workspace boundary should the cockpit support?

- Why open: the documented repo family can be sibling-based, while the cockpit
  confinement model accepts only descendants of `PROJECT_ROOT` and silently
  substitutes today.
- Decision needed: explicit allowlist for sibling repos, one broader project
  root, or visible refusal for out-of-scope repos.
- Related work: COORD-543.

## OBQ-003 — Which governance surfaces are the stable public API?

- Why open: raw `gov`, neutral agent facade, MCP, command aliases, JSON fields,
  and remediation strings currently drift.
- Decision needed: canonical machine schema and compatibility/deprecation
  policy for commands, flags, fields, enums, and transport.
- Related work: COORD-572 and COORD-482.

## OBQ-004 — What discovery precision is sufficient for automatic gate impact?

- Why open: current discovery produces mostly generic facts and false adapter
  signals, but business-context findings can influence closeout obligations.
- Decision needed: confidence threshold, source-authority threshold,
  diff-intersection rule, and which classes remain advisory only.
- Related work: COORD-550, COORD-554, COORD-569.

## OBQ-005 — Which knowledge artifacts are curated authority versus generated views?

- Why open: synthesis writes the same filenames used for durable product
  knowledge, yet precision-first memory requires reviewed promotion.
- Decision needed: separate generated path, merge/promotion workflow, ownership,
  and cockpit labels for authority/status/freshness.
- Related work: COORD-510, COORD-523, COORD-540, COORD-550.

## OBQ-006 — What is the blocked-work/WIP operating policy?

- Why open: blocked tickets retain ownership, but closeout-blocker exceptions,
  session release, resume, heartbeat, and recovery are not one coherent
  operator contract.
- Decision needed: WIP accounting, allowed concurrent blocker work, lease
  retention, heartbeat/staleness behavior, and transfer/rebind semantics.
- Related work: COORD-558.

## OBQ-007 — What minimum CI assurance is required before public release?

- Why open: the repository contains extensive tests and gates, but active CI
  does not run most of them.
- Decision needed: required PR lane, release lane, dependency policy, artifact
  smoke tests, and failure/waiver ownership.
- Related work: COORD-560 and the serial-test-entrypoint dependency it names.

## OBQ-008 — When should the deferred shared test architecture be revisited?

- Why open: ADR 0001 accepts duplicate heavy work and manual lane discipline.
- Decision needed: measurable thresholds for contention, duplicated gate cost,
  host scale, or false-failure rate that justify a scheduler/evidence broker.
- Related decision: ADR 0001 and its deferred ticket.

## Resolved by existing decisions

- Canonical versus ephemeral writers: ADR 0002.
- Human write identity/transport boundary: ADR 0003.
- Memory precision and promotion model: ADR 0004.
- Owner-lease authority: ADR 0005.
- Community engine-pin trust claim: ADR 0006.
