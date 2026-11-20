# Architecture audit

- Schema: coord.architecture-audit v1
- Revision: e6c72afa (origin/dev) merged with COORD-976
- Scope: coord/engine/scripts (excludes *.test.js, __fixtures__/, fixtures/)

## Metrics and ratchet

| Metric | Measured | Ratchet | Headroom | Delta |
| --- | ---: | ---: | ---: | ---: |
| guards | 101 | 101 | 0 | no previous report |
| production_modules | 371 | 371 | 0 | no previous report |
| production_loc | 102485 | 102485 | 0 | no previous report |

Other counts: engine JS files 729, production raw lines 129171, test files 346, fixture files 12.

## Guards

- Registry guards: 101
- Registry proposed merges: 2
- Registry retirement candidates: 4

## Clone detection

- Method: 8-line windows, at least 5 alphanumeric lines, import and destructuring boilerplate ignored, grouped by exact file set.
- Clusters: 99 (allowlisted 94, not allowlisted 5)
- Stale allowlist entries: coord/engine/scripts/closeout-summary.js|coord/engine/scripts/decision-extractor.js|coord/engine/scripts/insight-reports.js|coord/engine/scripts/learned-rule-promotion.js|coord/engine/scripts/prework-pack.js|coord/engine/scripts/summary-tiers.js; coord/engine/scripts/guided-closeout.js|coord/engine/scripts/publishability-check.js; coord/engine/scripts/recall.js; coord/engine/scripts/requirements-linkage-backfill.js|coord/engine/scripts/requirements-sequencing.js|coord/engine/scripts/requirements-surface-conformance.js; coord/engine/scripts/requirements-sequencing.js|coord/engine/scripts/requirements-surface-conformance.js; coord/engine/scripts/sast-policy.js|coord/engine/scripts/supply-chain-policy.js; coord/engine/scripts/test-policy-run.js|coord/engine/scripts/test-policy-schedule.js

## Proposals (not filed; human-admin approval required)

- [guard-merge] Merge adr-requirement, adr-compliance-closure, business-context-status, context-pack-ack into one decision-context record per ticket, validated once at move-review; implemented as the versioned packet in coord/engine/scripts/decision-context.js (COORD-932, expands into adr_refs, decision_required, the business-context invariant and context_pack_ack; proposal still needs human review)
- [guard-merge] Merge tree-mutation-safety, canonical-authority-write, co-located-writer into the integration-authority permission (COORD-915)
- [guard-retirement] Retire guard legacy-entrypoints: Exists only for the COORD-589 shim deprecation window.
- [guard-retirement] Retire guard upgrade-bridge: Bridges v0.1.16 adopters only.
- [guard-retirement] Retire guard wip-cap: Protects attention, not state; integration authority and dependency readiness cover the state risks.
- [guard-retirement] Retire guard adr-path-packet: For ADR metadata-only edits, once a decision-context record exists.
- [clone-cluster] Review duplicated logic across coord/engine/scripts/a11y-policy.js, coord/engine/scripts/mutation-policy.js, coord/engine/scripts/sast-policy.js, coord/engine/scripts/supply-chain-policy.js
- [clone-cluster] Review duplicated logic across coord/engine/scripts/guided-closeout.js, coord/engine/scripts/lifecycle-utils.js, coord/engine/scripts/publishability-check.js
- [clone-cluster] Review duplicated logic across coord/engine/scripts/insight-reports.js, coord/engine/scripts/memory-graph.js
- [clone-cluster] Review duplicated logic across coord/engine/scripts/requirements-linkage-backfill.js, coord/engine/scripts/requirements-surface-conformance.js
- [clone-cluster] Review duplicated logic across coord/engine/scripts/requirements-linkage.js, coord/engine/scripts/requirements-sequencing.js

## Not measured by this command

- overlapping helpers that implement one rule (manual review; see ARCH-AUDIT-2026-11-13.md section 2b)
- redundant verbs and flags (manual review; see section 2c)
- require-graph cycles (manual review; see section 4)
