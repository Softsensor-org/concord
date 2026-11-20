# ADR 0004: Precision-First Governed Memory Kernel

- **Status:** Accepted
- **Ticket:** COORD-433
- **Date:** 2026-07
- **Linked scope:** COORD-312..COORD-318, business discovery, knowledge claim compiler, memory recall, context packs.

## Context

Concord already treats memory as governed evidence rather than loose chat
history. The authoritative sources are board rows, plan records, journal events,
ADRs, requirements, source files, tests, and runtime receipts. Derived memory
views, summaries, and indexes are useful only when they point back to those
sources.

Business discovery extends that memory surface from delivery history into
business and application knowledge. That raises the risk: if an extractor
promotes plausible but wrong business rules, agents may erase real intent,
customer-specific behavior, or workaround logic while believing they are
following memory.

The first implementation therefore optimizes for precision, not coverage.
Sparse trusted memory is safer than broad low-precision recall.

## Decision Criteria

- Memory claims must be source-backed, cited, and status-aware.
- Extractors may propose claims but must not silently promote truth.
- Confidence must be computed from evidence and review state, not self-reported
  by an LLM.
- Implementation is evidence of observed behavior, not automatic evidence of
  business intent.
- Superseded, stale, conflicted, rejected, private, or inferred claims must not
  appear as active implementation constraints.
- Retrieval should be deterministic first; vectors or semantic indexes are
  retrieval aids only, never authority.
- Human review capacity is a constraint, so low-evidence claims should be
  rejected or quarantined before they reach reviewers.

## Linked Scope

- Linked ticket: COORD-433.
- Governing cleanup/preservation ticket: COORD-433.
- Original design and implementation tickets: COORD-312 through COORD-318.
- Affected surfaces: `coord/docs/MEMORY_ARCHITECTURE.md`,
  `coord/product/BUSINESS_DISCOVERY_PROTOCOL.md`,
  `coord/scripts/knowledge-claim-compiler.js`, business-discovery synthesis,
  business context packs, recall/context-pack consumption, and memory safety
  tests.
- Related decision surface: ADR 0002 for canonical/ephemeral runtime authority
  and ADR 0003 for governed human writes through trusted actors.

## Options Evaluated

### Broad Semantic Memory First

Build a large knowledge graph or vector-backed memory layer that extracts many
business, workflow, architecture, and code facts up front.

Rejected because it creates a high false-authority risk. At cold start, broad
semantic recall tends to surface plausible context before the system can prove
that the claims are intentional, current, non-conflicting, and safe to govern
implementation.

### Precision-First Governed Kernel

Start with a narrow claim compiler that rejects weak claims, computes confidence
from evidence, records conflict/staleness status, and emits only eligible claims
into context packs.

Accepted because it matches Concord's governance model: memory recommends,
governance decides, and every reusable claim remains traceable to sources.

## Decision

Concord Memory and Business Discovery use a **precision-first governed memory
kernel**.

Agents and discovery adapters may propose sparse, source-backed candidate
claims. The promotion path, not the extractor, assigns final status,
confidence, and retrieval eligibility. Business rules derived only from
implementation are represented as observed behavior unless an authoritative
intent source exists.

Phase 0 uses deterministic exact lookup, full-text retrieval, relational links,
status filters, source authority, and conflict/staleness checks. Vector search,
broad graph expansion, and autonomous semantic enrichment are deferred until
they demonstrate measured lift without increasing stale, conflicted, private,
or false-authoritative recall.

## Alternatives Rejected

- **Vector-first memory:** rejected because semantic similarity without
  provenance can surface plausible but stale or false-authoritative claims.
- **Broad graph ontology at Phase 0:** rejected because schema breadth creates
  extractor precision and reviewer-load problems before the kernel proves
  useful.
- **Extractor-authored confidence:** rejected because confidence must be derived
  from evidence, source authority, conflict state, freshness, and review status.
- **Implementation-as-intent:** rejected because current code may represent a
  bug, workaround, temporary tenant exception, or historical accident.
- **Silent memory mutation:** rejected because reusable memory must be proposed,
  verified, promoted, demoted, or superseded through governed paths.

## Adopted Instead

The durable kernel is intentionally small:

| Concept | Purpose |
| --- | --- |
| `candidate_claim` | Extractor-proposed statement awaiting triage. |
| `claim` | Promoted source-backed statement with computed status/confidence. |
| `evidence` | Source file, line range, commit, ticket, PR, journal event, test, schema, controlled doc, or runtime receipt. |
| `subject` | Business object, workflow, field, report, integration, code symbol, or product surface. |
| `decision` | Accepted or rejected product, architecture, or implementation choice with rationale. |
| `conflict` | Unresolved disagreement between claims or between policy and implementation. |
| `context_pack` | Ticket-scoped, cited memory packet for a role. |

Specialized domain records such as workflows, incidents, actors, states,
transitions, integrations, and data assets can appear as claim subtypes or
facets until measured usage proves they deserve first-class schema.

## Claim Triage

The pipeline is:

```text
source evidence
  -> candidate claim
  -> automatic reject / quarantine / review queue
  -> verification and promotion
  -> deterministic retrieval index
  -> role-specific context pack
```

Candidate claims are automatically rejected when they have no citation, cite
only summaries, are pure model interpretation, are outside scope, restate code
mechanics without business value, duplicate accepted memory without new
evidence, include secrets, or cannot identify subject and scope.

Candidate claims are quarantined when they are implementation-only but assert
business intent, conflict with accepted memory without declaring the conflict,
or may become useful only after later evidence appears.

## Computed Confidence

Confidence is derived at promotion time.

| Tier | Meaning |
| --- | --- |
| `proven` | Valid sources, no active conflict, authoritative intent source, and enforcement or test evidence. |
| `strong` | Valid sources, no active conflict, two independent sources, clear scope. |
| `provisional` | Valid source, clear scope, and no active conflict. |
| `observed_only` | Current implementation/runtime/test evidence but no intent source. |
| `stale` | Cited source changed or disappeared. |
| `conflicted` | Active unresolved conflict exists. |

For intended behavior, source authority is ordered as:

```text
approved_policy > accepted_decision > requirement > review_comment > test_proof > implementation
```

For observed behavior, source authority is ordered as:

```text
runtime_receipt > implementation > test_result > summary
```

If policy and implementation disagree, Concord emits a possible conflict or
defect. It must not infer supersession from implementation drift.

## Conflict And Retrieval Policy

- Superseded claims are historical only.
- Stale claims appear only in stale-warning sections.
- Two accepted conflicting claims produce an unresolved conflict block; neither
  is emitted as an active constraint until resolved.
- Accepted claims beat candidate claims, but implementation drift against an
  accepted business rule is treated as a possible defect.
- Specific-over-general precedence requires explicit scope or precedence
  evidence.
- Context-pack conflicts and stale warnings are mandatory sections. Ranking must
  not hide them.

## Evaluation

Recall is not enough. The kernel is evaluated on extraction precision and
context-pack usefulness:

- reviewer-queue acceptance rate;
- promoted-claim precision;
- false-authoritative rate;
- reviewer load;
- auto-reject accuracy;
- citation completeness;
- stale/conflict suppression;
- reviewer-labeled context-pack usefulness;
- avoidable finding coverage;
- irrelevant-context rate;
- repeated failed-approach prevention.

## Consequences

- Phase 0 memory is intentionally sparse.
- Some useful facts are omitted until evidence accumulates.
- Context packs are safer because active constraints are filtered before
  retrieval.
- Existing-repo adoption improves because cold-start packs can label what is
  known, observed, inferred, stale, conflicted, or unknown.
- Graph and vector retrieval remain possible later, but only over promoted
  source-backed knowledge.

## Revisit Trigger

Revisit this decision only when both are true:

1. Extraction precision and reviewer-load targets pass on real or public-safe
   historical replay.
2. Context-pack usefulness shows measurable lift over deterministic exact and
   full-text packs without raising stale, conflicted, private, or
   false-authoritative output.
