# ADR 0022: Sharding executes resolved policy test sets in parallel

- **Status:** Accepted (human-admin direction recorded on COORD-900; acceptance recorded by the human admin 2026-11-12; implementation evidence accumulates under COORD-900)
- **Ticket:** COORD-900
- **Date:** 2026-11-08
- **Linked scope:** COORD-900 sharded execution; COORD-936 stage policy; COORD-910 run manifests; COORD-924 suite selection; `coord/engine/test-policy.json`.

## Linked Scope

COORD-900 sharded execution; COORD-936 stage policy; COORD-910 run manifests; COORD-924 suite selection; `coord/engine/test-policy.json`.

## Context

The governance suite is serial within each process tree because suites share filesystem and runtime state. Large hosts can reduce wall time by running isolated, serial shards concurrently. Sharding must preserve the exact suite set selected by policy, each suite's outcomes, and full-suite coverage ratchets when the resolved plan is full.

The testing policy resolves a fresh suite set for developer, PR, nightly, promotion, and release workflows. Human-admin direction authorizes sharding any resolved set when isolation and exact accounting are available. Sharding must not change that resolved set or turn a partial selection into a full qualification.

## Decision Criteria

- The default runner behavior remains serial; sharding is opt-in.
- Sharding executes only the exact resolved suite set, including selected and mandatory suites. It does not change selection.
- Full plans account for each edition's complete inventory exactly once; partial plans account for exactly their selected-plus-mandatory set. Missing, duplicate, unknown, failed, cancelled, or unreported suites fail closed.
- Per-shard coverage is merged into one whole-suite measurement for full plans, then the authoritative ratchet runs exactly once. Partial plans do not claim whole-suite coverage or run the whole-suite ratchet.
- Every shard and aggregate writes a manifest bound to the candidate and run inputs.
- Any uncertainty blocks the sharded result from qualifying; a serial full run is the fallback.

## Decision

1. `--shards N|auto` is eligible only when the donor policy wrapper supplies an exact resolved test plan. This includes full plans and partial developer/PR selections; conditional nightly skips remain skips and create no run evidence.
2. A sharded run may qualify only through the donor policy wrapper after it proves the assigned suites equal the exact resolved set, all worker reports pass, the source tree is unchanged, and every run manifest is present. Full plans additionally require merged coverage and one passing whole-suite ratchet. Direct runner and cut reports remain provisional until the wrapper validates and binds a receipt.
3. Community and Enterprise cuts must each match their own full release inventory exactly. Partial selected runs are non-release evidence and carry no whole-suite claim.
4. Comparison evidence accumulates from matching serial and sharded runs when both are available; no serial comparison schedule or first-run serial full gate is required. Compare same-tree test identities, outcomes, and coverage findings, with reports and manifests bound by digest.
5. A mismatch blocks qualification and automatically persists a fail-closed suspension through a journaled governance transaction before further sharded use. The comparison command is a post-run transaction and refuses while an integration operation is open.
6. No fixed number of paired runs is a prerequisite to use. Evidence accumulates from real runs and remains available for review.
7. If the resolved plan, inventory, isolation, manifests, comparison inputs, coverage merge, or host state is uncertain, use the unsharded policy run.

## Options Evaluated

- **Shard the exact policy-resolved test set with exact accounting, merged coverage and fail-closed comparison** (chosen; see Decision).
- **Shard every test without the resolver's plan.**
- **Require three paired runs per Node lane before any use.**
- **Treat a successful aggregate exit as sufficient.**
- **Keep full promotion and release suites serial on capable hosts.**

## Alternatives Rejected

- **Shard every test without the resolver's plan:** rejected because it can omit mandatory suites or accidentally broaden/narrow the policy selection.
- **Require three paired runs per Node lane before any use:** rejected by the human-admin decision to start with the stated safeguards and collect comparison evidence as full runs occur.
- **Treat a successful aggregate exit as sufficient:** rejected because it does not prove exact suite accounting, merged coverage, or comparison with serial execution.
- **Keep full promotion and release suites serial on capable hosts:** rejected because it preserves avoidable wall time after the required isolation and aggregation safeguards are in place.

## Consequences

- Selected developer and PR checks retain their policy-resolved scope; sharding can reduce their wall time without turning them into full gates.
- Full nightly, promotion, and release gates may run faster on capable hosts while retaining complete suite coverage and one authoritative ratchet.
- Every result includes per-shard outcomes, exact suite assignments, aggregate coverage where applicable, and manifests so serial comparisons can be reviewed when a matching run exists.
- An incomplete shard report remains provisional. A mismatch causes the donor policy to refuse later shard runs until the governed suspension is resolved.

## Revisit Trigger

Revisit if a serial comparison finds a missed identity, outcome, or coverage finding; if a shard violates isolation or inventory accounting; or if the host cannot reliably run the configured number of isolated shards. Any such finding blocks qualification; operators record a governed suspension and use serial full runs until fixed and re-compared.

## Approval State

The human-admin direction is recorded on COORD-900: shard the exact test set resolved by policy, including adaptive selections, with the safeguards above. Fixture comparisons, receipt binding, and durable automatic suspension are covered by focused tests in this candidate. The full gate and a real same-tree serial comparison remain unrun; comparison evidence is ongoing rather than a prerequisite.
