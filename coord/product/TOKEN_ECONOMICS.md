# Token Economics of Coordinated Agent Development

*Design spec of record. How coord reduces the token/$ cost of multi-agent
software development — and proves the reduction in the same governed evidence
trail. Build tickets COORD-026..030 implement the five levers below.*

## Principle

Coord's governance **adds** tokens (plan records, review cycles, evidence
export). It only nets positive if it **removes more than it adds**. It can,
because of one structural fact:

> **Coord already holds the context that agents otherwise re-pay to rediscover.**
> Every ticket declares `files`, `acceptanceCriteria`, `dependsOn`. Every landed
> ticket leaves `feature-proofs` (file:symbol), recorded gates, and invariants in
> the append-only journal. Today each new agent re-greps, re-reads, and
> re-derives all of it from scratch.

The savings come from **closing that loop** (feed governed state back into
dispatch), **spending proportional to risk** (not max rigor on every ticket),
and **measuring** (so optimization is evidence-driven, not guessed). The
governance structure is what *enables* every lever — they are not bolt-ons.

## Cost model — where tokens actually go

Observed in the HOS multi-agent burn-in (≈22 backend tickets, many concurrent
Claude subagents):

| Cost class | Driver | Lever |
|---|---|---|
| **Redundant runs** | Agent spawned for already-satisfied work | #2 precheck |
| **Rediscovery** | Each agent re-greps files, conventions, prior decisions | #3 context-pack |
| **Over-tiering** | Opus + 4 review cycles on mechanical P3 tickets | #4 tier policy |
| **Conflict churn** | Same-file siblings rebase-thrash | #5 plan-waves |
| **Blindness** | No per-ticket cost signal → can't target optimization | #1 cost-ledger |

## The five levers (build order)

### 1. Cost-ledger — measurement foundation (COORD-026)
Record per-ticket / per-agent / per-model token + estimated-$ accounting as
append-only journal events (`cost.observed`), and add a `gov cost` report
(by ticket, by agent, by model, totals). Turns the journal into an
evidence-grade spend ledger. Prerequisite: it both drives and proves levers 2–5.
Sellable Concord surface: "agent spend per change," beside the audit trail.

### 2. Precheck — avoid redundant runs (COORD-027)
`gov precheck <ticket>`: run cheap acceptance-criteria probes (symbol greps,
targeted tests, file existence) — no LLM, or a single small-model call — to
classify a ticket **already-satisfied / partially / not-started** BEFORE
dispatch. Avoids whole agent runs. (HOS evidence: FRESHNESS-001 was already
merged in `main`; only a full agent run revealed it — precheck moves that to
near-zero cost.) Output is advisory + recordable as a plan-record note.

### 3. Context-pack — kill rediscovery, share via prompt cache (COORD-028)
`gov context-pack <ticket>`: assemble the ticket's `files` + relevant spec
excerpts + prior feature-proofs/invariants touching those files into one
deterministic, cache-friendly preamble. Stable shared content (governance docs,
the burn-in recipe, repo conventions) goes in a cacheable prefix so N agents in
a wave share one cached preamble instead of each re-paying discovery. Highest
*recurring* saver.

### 4. Tier policy — spend proportional to risk (COORD-029)
Add a board `tier` (or derive from `Pri`/risk): routes model selection
(Haiku/Sonnet for mechanical, Opus for safety-critical) and **evidence depth**
(lighter feature-proof/review-cycle minimums on low-tier, full rigor on high-tier).
Coord is already provider/tier-agnostic (Codex/Gemini/Claude). Keeps rigor where
it matters; cuts the long tail 3–10×. Doctor enforces the *tier-appropriate*
minimum, not a flat one.

### 5. Plan-waves — eliminate conflict churn (COORD-030)
`gov plan-waves`: compute file-overlap from each ticket's `files` field +
`dependsOn`, emit a conflict-free parallel schedule (wave N = tickets with no
shared files and satisfied deps). Makes "land the cluster lead, then fan out"
mechanical instead of hand-clustered. Also flags repo-`X` tickets as
non-parallelizable (no worktree isolation — see the burn-in runbook).

## Nets-positive argument

- Governance overhead is ~fixed per ticket (plan record + gates).
- Levers 2/4 remove *whole runs* and *whole model tiers* on a large fraction of
  tickets; lever 3 removes recurring discovery on *every* run; lever 5 removes
  conflict-resolution rounds. The removed cost scales with fleet size; the
  governance cost does not. At fleet scale, coord is **cheaper than ungoverned
  agents**, not just safer — and the cost-ledger proves it per change.

## Concord positioning

"The evidence layer pays for itself: it eliminates redundant, over-tiered, and
conflicting agent work — and proves the savings in the same ledger that proves
the controls." Cost telemetry sits beside the audit trail as a
CFO/eng-leadership surface, distinct from runtime-observability tools (which
watch agents behave) and orchestrators (which run them).
