# ADR 0015: Agent writing is bounded-context, artefact-handoff and short-lived

- **Status:** Proposed
- **Ticket:** COORD-774, COORD-769, COORD-770, COORD-771, COORD-772, COORD-773
- **Date:** 2026-09
- **Linked scope:** `coord/scripts/token-economics.js` (context-pack, tier policy, plan-waves, dispatch-plan, cost-ledger); `coord/product/TOKEN_ECONOMICS.md`; the dispatch protocol and reference harness from COORD-032; `coord/prompts/*.md`.

## Context

`coord/product/TOKEN_ECONOMICS.md` argues that governance pays for itself: it removes
redundant runs, over-tiered models and conflict churn, while governance overhead stays
flat per change. The five levers built for that argument — cost-ledger (COORD-026),
precheck (COORD-027), context-pack (COORD-028), tier policy (COORD-029) and plan-waves
(COORD-030), composed by dispatch-plan (COORD-031) and wired by COORD-032 — all ship.

The COORD-774 investigation reports that the cost ledger contained only one
`cost.observed` event, a test fixture with one million input tokens and estimated price.
It therefore did not establish savings from these controls.

The ticket's September 2026 measurement summary instead reports matching harness
transcripts to governance journal thread identifiers across five sessions: four on
this engine and one on an adopter website repository, with 6,484 assistant turns and
1,191 journal events. The underlying dataset and reproduction command are not linked
in this proposal. The figures below are reported investigation inputs, not independently
verified measurements or evidence that thread matching establishes exact attribution.

| Observation | Figure |
|---|---|
| Fresh input tokens across five sessions | 12,703 |
| Cache reads across the same sessions | 2,401,319,551 (reported share: 97.0% of input; denominator unverified) |
| Output tokens | 5,859,551 (reported share: 0.23% of all tokens; denominator unverified) |
| Context re-read per turn, one 1,746-turn session | 107k rising to 942k, reset by compaction, then rising again |
| Peak context on a single turn | 967,872 |
| Unique material in that session | approx. 528,000 tokens |
| Input billed for that session | 791,067,189 tokens |
| Amplification of unique material | approx. 1,500x |
| Composition of unique material | tool results 76.1%, tool arguments 13.1%, assistant text 7.1%, human text 2.6% |

The displayed counts alone do not reproduce the reported shares: cache reads divided
by cache reads plus fresh input are approximately 99.9995%, and output divided by
those displayed classes plus output is approximately 0.2434%. Additional token classes
or different denominators may explain the difference, but this proposal has no source
evidence to resolve it. A reproducible accounting breakdown is required before using
these percentages as validated public claims.

The reported amplification motivates testing whether carrying accumulated material
through subsequent turns dominates cost. This proposal treats that as a hypothesis
to measure, rather than a demonstrated savings result.

## Linked Scope

- Governing ticket: COORD-774.
- Implementation tickets: COORD-769 (context budget), COORD-770 (no-explore mode and
  context-request events), COORD-771 (cacheable prefix verification), COORD-772
  (per-phase cost recording), COORD-773 (artefact handoff contract).
- The dispatch path: `dispatchPlan`, `planWaves`, `contextPack`, `tierCommand`, `precheck`.
- The cost path: `recordCost`, `costReport`, the `cost.observed` event.
- The prompts that shape agent behaviour: `coord/prompts/planner.md`, `implementer.md`,
  `reviewer.md`, and the harness contract in `coord/docs/MULTI_AGENT_BURNIN_RUNBOOK.md`.
- Out of scope: model-selection policy beyond the existing tier field, and how the
  harness itself compacts context, which is a client property this engine does not control.

## Decision Criteria

- **Follows the reported evidence.** A lever must attack a term in the proposed cost model, not
  an intuition about model pricing.
- **Evidence-producing.** Each control leaves a record proving it was applied, in the
  journal that already proves the other controls.
- **Falsifiable.** The architecture must predict an outcome a pre-registered experiment
  can refute.
- **No new trust assumptions.** Nothing may rely on an agent's self-report where a
  deterministic record is available.
- **Community-edition safe.** These controls belong in the open-core engine, not behind
  the Enterprise boundary (ADR 0012).

## Options Evaluated

- **A. Cheaper models for cheap work (tier policy alone).** Already shipped. Output is
  reported as a small share of tokens, but model prices also apply to cached input.
  Token shares alone do not establish the savings available from changing model tier.
- **B. Longer-lived agents with richer memory.** Give one agent durable memory and let it
  run. This can increase repeated context: a long thread carries everything it has
  accumulated into every turn, and the reported growth is monotonic until something
  forcibly resets it.
- **C. Shorter context per unit of work: bounded packs, short-lived agents, artefact
  handoff.** Attacks all three multiplicands — material carried, turns per agent, and the
  fraction of history each turn re-reads.
- **D. Rely on harness compaction.** Compaction reportedly fired in the cited session, cutting
  context from 942k to 101k. But it is a client behaviour, it arrives only after the cost
  has been paid, and it is not available as a governed control.

## Decision

The proposed model treats carried context and turn count as cost drivers alongside
the model's token prices. Option C is proposed for reducing repeated context:

1. **Bounded context.** A ticket body is assembled to a declared budget for its tier, and
   the budget and resulting size are recorded (COORD-769).
2. **No unplanned exploration.** An implementer works from its pack; anything outside it
   is requested, and the request is journalled so packs improve from evidence rather than
   opinion (COORD-770). Tool results reportedly account for 76% of unique material, so an unplanned search
   is not a small act: its output is re-read on every subsequent turn.
3. **A verified cacheable prefix.** The stable prefix shared across a wave is hashed at
   dispatch and reported back, so prefix drift — which silently converts cheap cache reads
   into full-price input on every turn of every agent — is detectable (COORD-771).
4. **Costs recorded per phase, routinely.** Plan, implement and review costs land in the
   ledger as a by-product of the dispatch loop rather than an optional operator step
   (COORD-772). A ledger holding a fixture proves nothing.
5. **Handoff through artefacts.** A reviewer receives the diff, the declared invariants
   and the plan record — not the repository and not the conversation (COORD-773).
   Conversation handoff is what makes context grow; artefact handoff keeps it flat.

Agents are therefore short-lived by design: one ticket, one agent, terminated at its
gate, with the next stage reading a two-kilobyte plan record instead of inheriting a
five-hundred-kilobyte transcript.

## Alternatives Rejected

- **Option B (long-lived agents with memory)** optimises the wrong term. Memory that
  lives in the conversation is the cost. Memory that lives in artefacts and is retrieved
  in bounded slices is the decision above.
- **Option D (rely on compaction)** is not a control: it is not ours, it is not recorded,
  and it acts after the spend.
- **Publishing a savings claim now.** The reported measurement motivates an experiment;
  it does not show these controls reduce cost. Any savings percentage ships only after the experiment below
  returns a number, and a negative result is published too.

## Consequences

- **Accepted cost.** Packs must be good enough to work from, or COORD-770 produces a
  stream of context requests — which is itself the signal that a pack is inadequate, and
  is why those events are journalled.
- **Re-established context.** Short-lived agents re-establish some context per ticket; the
  wave-level cached prefix is what stops that being re-paid at full price.
- **Testable prediction.** For a ticket with roughly 30k of relevant material, four
  short-lived agents at about 12 turns each averaging 25k carried context cost on the
  order of 1.2M tokens, against tens of millions on the reported long-thread profile.
  This is a prediction of the model, not a result.
- **Pre-registered experiment.** Eight tickets, stratified trivial / medium / complex, two
  arms: an agent with the ticket description only, versus an agent with a generated
  context pack. Same model, same acceptance rubric, tokens recorded through the ledger,
  cache reads reported separately from fresh input so prompt caching is not credited to
  this engine. Threshold: at least a 30% reduction in total input tokens at equal or
  better rubric score. Stop condition: if the packed arm mainly shifts cost into more
  turns, or raises rubric failure, the lever is not sold and the result is published.
- **Dependency.** COORD-650 records that governed subagents cannot execute `gov` commands
  under harness auto-mode. Until that is resolved, the short-lived-agent topology is
  operable by an orchestrator but not self-service for a subagent.
- **Related.** ADR 0004 (precision-first governed memory kernel) covers what memory may
  assert; this record covers how much of it is carried, and when.
