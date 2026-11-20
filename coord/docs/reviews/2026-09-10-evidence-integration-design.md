# Evidence integration design: pick, start, and doctor

Status: design-only backlog deliverable. No command behavior changes are proposed by this ticket.

## Conformance matrix

| Surface | Current authority | Future integration boundary | Must remain prohibited |
|---|---|---|---|
| `pick` | Board/readiness and advisory ranking | Cheaply annotate candidates with cached evidence and freshness | Claiming completion, remote mutation, or ownership |
| `start` | Governed lifecycle plus refreshed immutable base | Revalidate the selected ticket against that exact base immediately before mutation | Starting from stale evidence, auto-closing, or rewriting ownership |
| `doctor` | Diagnostic local state and journal | Optional, bounded remote discovery with explicit operator opt-in | Arbitrary shell probes, silent network assumptions, or mutation |
| `dispatch` | Precheck classifier | Consume `unknown` distinctly and spawn unless explicitly satisfied | Treating unavailable evidence as absence |
| `orch` | Journal-based merged-but-not-done audit | Cross-link evidence without replacing journal authority | Inferring landing from ticket-shaped text |

## Required cases before implementation

1. Freshness: cached ref absent then remotely present; cached ref present then remotely removed.
2. Evidence: confirmed ancestor, confirmed non-ancestor, unavailable ref, stale tracking ref, and permission failure.
3. Races: evidence changes between pick and start; start must revalidate and bind one immutable base.
4. Offline behavior: pick stays usable; start follows explicit offline policy; doctor remains diagnostic unless opt-in discovery is requested.
5. Identity: commit, ref, lane, owner, and timestamp are recorded; no evidence field becomes an authority substitution.
6. Latency: pick has no network dependency; start fetch is bounded; doctor opt-in has a bounded budget and reports partial results.

## Incremental rollout

1. Instrument read-only reports and compare them with current journal/orch results.
2. Add hermetic fixtures for freshness, permissions, stale refs, races, and offline mode.
3. Gate only start-time revalidation behind an explicit feature flag; keep pick and doctor advisory/diagnostic.
4. Enable by default after no divergence from journal authority and no false-satisfied cases across two review cycles.
5. Retain rollback by disabling the flag; do not migrate or rewrite historical evidence.

## Dependencies and non-goals

COORD-737 (external merge discovery), COORD-738 (isolation), and COORD-685 (shell security) remain separate prerequisites. COORD-739/741/742/743/745 repair the existing seams; this document does not broaden them or introduce a second evidence authority.
