# Business Discovery Protocol

Status: design contract · Owner: Softsensor · Ticket: COORD-301

Adoption boundary: for what business discovery, context packs, memory, ADRs,
identity, and continuity can do today versus what remains backlog, see
`coord/product/CONTINUITY_CAPABILITY_MATRIX.md`. Policy enforcement status is
summarized in `coord/product/POLICY_ENFORCEMENT_MATRIX.md`.

## Purpose

Business discovery is the governed process for reverse-engineering an existing
repo without turning implementation accidents into business truth.

Concord must help agents discover and preserve business intent before they
refactor, modernize, generalize, or add features. The protocol is domain-neutral:
it can represent an ERP customization, a menu/POS converter, a regulated workflow,
an ecommerce storefront, a data pipeline, or a simple SaaS app without forcing a
domain ontology too early.

The output is a source-backed knowledge structure that later feeds requirements,
memory, context packs, reviews, and tickets. It is not a replacement for human
business ownership.

Business discovery is a **producer** for the **Concord Knowledge Compiler**. It
emits source-backed proposed claims; the claim compiler classifies whether each
claim is `accepted`, `candidate`, `review-required`, `rejected`, `conflicted`,
`superseded`, or `stale` before memory, recall, context packs, requirements,
ADRs, or ticket synthesis consume it.

## Core Principle

> Implementation is evidence, not always intent.

Existing code, data, UI, and configuration can reveal real business behavior,
but they can also contain workarounds, bugs, temporary patches, abandoned flows,
or customer-specific exceptions. Concord records what was observed, classifies
confidence, and asks for decision authority before treating a claim as a rule.

## Relationship To Existing Concord Surfaces

| Surface | Relationship |
| --- | --- |
| Requirements assurance | Business discovery produces candidate source-backed facts, questions, contradictions, and requirement candidates. Requirements assurance decides which become governed PRD/URS/SRS/REQ records. |
| Governed memory | Discovery records are semantic-memory inputs only after compiler gating and promotion. Derived memory indexes remain rebuildable. |
| ADRs and decisions | Discovery can identify decisions needed or decisions already implied by sources; accepted decisions live in ADR/decision records. |
| Tickets | Discovery findings become tickets only through a governed synthesizer. Read-only reviewers do not mutate the board directly. |
| Existing repo adoption | Discovery is the deeper pass after setup/readiness: it explains why the repo behaves the way it does before agents change it. |
| Cockpit/readout surfaces | Cockpits render derived discovery artifacts, context packs, and promotion status. They are read-only and must not execute discovery, synthesize new artifacts, promote records, create tickets, or mutate files. |

The governed memory relationship is deliberately one-way:

```text
business discovery / ticket execution -> source-backed claims -> Concord Knowledge Compiler -> memory / recall / context packs
```

Memory recommends with citations. Governance decides whether a claim becomes a
requirement, ADR, accepted memory record, or ticket. Vectors and summaries are
retrieval/readout views only; they cannot create authority.

## Read-Only Cockpit Contract

Business discovery can feed product cockpits and ticket readouts, but the web/UI
tier is an observer. A cockpit may load existing derived JSON/markdown artifacts
and present:

- discovery runs and source inventory;
- adapter signals, probes, risks, and suggested questions;
- fact confidence and status distribution;
- contradictions and stale/superseded history;
- open questions and pending decisions;
- accepted decisions, waivers, and approval requirements;
- known workarounds, reflections, and preservation harness candidates;
- ticket context-pack refs and behavior-change gate status.

Rules:

- UI/web code must not call discovery scanners, synthesizers, context-pack
  generators, governance promotion commands, or board mutation commands.
- UI/web code must not write `coord/.runtime`, `coord/product`, board files,
  requirements, ADRs, memory, prompts, or rendered artifacts.
- The only mutation path is an explicit CLI/governance workflow outside the
  cockpit. The cockpit can show the exact command or context-pack ref an
  operator may run elsewhere.
- Readouts must preserve uncertainty labels. `observed`, `inferred`,
  `hypothesis`, `contradicted`, `unknown`, stale, superseded, rejected, and
  candidate records are not active policy.
- Context-pack links are pointers for tickets and plans; loading a pack must not
  implicitly approve, promote, schedule, or mutate anything.

## Artifact Classes

Business discovery uses one envelope with typed records. All records are
source-cited and versioned.

| Kind | Purpose |
| --- | --- |
| `fact` | A source-backed observation about code, UI, data, configuration, docs, runtime, or process. |
| `business_object` | A domain object or operational entity, such as Invoice, MenuItem, WorkOrder, Patient, Tenant, OptionGroup, TaxRule, or ProductionLine. |
| `field_rule` | A field-level constraint, format, enum, validation, mapping, limit, or derived value. |
| `business_rule` | A policy, invariant, eligibility rule, lifecycle rule, approval rule, exception, or customer-specific behavior. |
| `workflow` | A user/system process with actors, states, handoffs, triggers, approvals, and failure states. |
| `integration_contract` | API, event, import/export, adapter, file, POS, ERP, queue, or external-system contract. |
| `configuration_surface` | Feature flag, tenant setting, ERP/POS/admin configuration, seeded data, or generated metadata that changes behavior. |
| `data_dependency` | Table, view, migration, seed, lookup, report, analytics fact, lineage edge, or row-shape dependency. |
| `ux_behavior` | Screen/form/navigation behavior, role-specific journey, rendered-state expectation, or HITL editing rule. |
| `decision` | Accepted, rejected, pending, or implied decision with options and consequences. |
| `hypothesis` | Plausible but unconfirmed interpretation that needs more evidence or a human answer. |
| `contradiction` | Conflict between sources, code vs docs, frontend vs backend, tests vs runtime, or observed behavior vs intended policy. |
| `question` | Human/business/technical question needed before a claim can govern work. |
| `reflection` | Post-discovery or post-ticket learning about false starts, missing context, reviewer feedback, or repeated risk. |

## Human-Light Ledgers

Discovery must not turn every uncertainty into a human interview. The run emits
three ledgers that preserve continuity while asking humans only high-impact
questions.

| Ledger | Purpose | Promotion behavior |
| --- | --- | --- |
| `question_ledger` | Open questions with owner, priority, impact, source evidence, blocked record ids, and the reason the question is worth asking. | Questions are advisory until answered, deferred, or waived by the owner. |
| `decision_ledger` | Pending or accepted decisions and waivers, including options, evidence, owner, consequences, and waiver scope/revisit condition. | Accepted decisions can promote into ADRs, requirements, or memory through governance. Waivers guide work only inside their explicit scope. |
| `reflection_ledger` | Lessons about assumptions disproved, patterns confirmed/rejected, adapter improvements, and future-run tuning. | Reflections are continuity inputs; they do not become rules without later promotion. |

Rules:

- ask only when a decision would change implementation, ticket synthesis,
  adapter selection, or promotion eligibility;
- cite evidence for every question, decision, waiver, and reflection;
- route questions and decisions to an owner or owning role;
- keep unanswered decisions non-governing;
- preserve waivers with owner, scope, reason, and revisit condition;
- use reflections to improve future discovery runs without silently changing
  business rules or adapter behavior.

## Domain Discovery Adapters

Discovery can activate domain adapters as investigation lenses. Adapters detect
signals, add probes, classify risks, and suggest evidence/questions. They do not
declare truth.

Adapter findings, domain facts, and observed behavior are **semantic-memory
subtypes** once compiled and promoted. Domain knowledge describes objects,
rules, workflows, fields, contracts, configuration, and lineage. Behavioral
knowledge describes observed or intended system behavior. Neither subtype is
procedural memory; learned agent-operating rules still require the governed
procedural-memory promotion path.

Starter adapters:

- generic existing repo;
- POS/menu;
- ERP/configuration;
- manufacturing;
- finance;
- regulated;
- integration/API;
- ecommerce.

Adapter output remains `confidence=observed|inferred` and `status=candidate`
until promoted. A POS/menu signal, for example, can suggest that item/modifier,
tax, price, import/export, or downstream contract rules need review; it cannot
assert that the observed implementation is intended business behavior.

## Evidence Reference

Every record must cite evidence. Summaries are not evidence.

```json
{
  "type": "file|test|git|ticket|plan|journal_event|runtime_receipt|database|ui_screenshot|external_pointer|human_note",
  "path": "backend/src/invoices/approvalPolicy.ts",
  "commit": "abc123",
  "line_start": 42,
  "line_end": 91,
  "event_hash": null,
  "chain_head": null,
  "source_hash": "sha256:...",
  "authority": "implementation|test_proof|approved_policy|accepted_decision|requirement|runtime_observation|review_comment|legacy_note|summary",
  "freshness": "current|stale|unknown",
  "sensitivity": "public|internal|private_pointer_only|sensitive|secret_prohibited",
  "visibility": "public|internal|private_pointer_only|sensitive|secret_prohibited"
}
```

Rules:

- `summary` evidence can help navigation, but cannot prove a claim.
- `secret_prohibited` evidence must not be copied into discovery artifacts.
- Private sources may be represented by pointer, hash, and owner without copying
  the body.
- Runtime/database evidence must be redacted before becoming a shared artifact.

## Confidence And Status

Discovery separates confidence from lifecycle status.

Every record also carries an `authority` decision block. This block is the
machine-readable guardrail that later context packs, reviews, and ticket
synthesizers must consult before using a discovery record to guide
implementation.

### Confidence

| Confidence | Meaning | Can govern tickets? |
| --- | --- | --- |
| `confirmed` | Supported by an authoritative intent source and enforcement/test evidence. | Yes |
| `observed` | Current system behavior is visible, but intent is not proven. | No, unless explicitly accepted |
| `inferred` | Agent deduced a likely rule from patterns or partial evidence. | No |
| `hypothesis` | Plausible interpretation needing investigation. | No |
| `contradicted` | Accepted or observed sources disagree. | No |
| `unknown` | Relevant field/object/process exists but meaning is not known. | No |
| `deprecated` | Previously useful claim is no longer active. | No |
| `waived` | Explicit owner waiver allows limited use despite unresolved confidence. | Only within waiver scope |

### Status

| Status | Meaning |
| --- | --- |
| `scratch` | Captured during exploration; useful for continuity only. |
| `candidate` | Proposed for review or further evidence gathering. |
| `accepted` | Promoted by a human owner or deterministic verifier. |
| `rejected` | Considered and rejected with reason. |
| `superseded` | Replaced by newer knowledge. |
| `stale` | Source changed or freshness expired. |
| `deprecated` | Retained for history but not active. |
| `waived` | Not resolved, but explicitly accepted with owner/revisit condition. |

The safe default is `confidence=observed` and `status=candidate` for code-only
findings.

## Cold-Start Baseline Output

When an existing repo has sparse confirmed knowledge, discovery must still
produce an honest baseline instead of staying silent or inventing authority.
The baseline is a navigation artifact for the next agent, not accepted memory.

The run artifact includes `cold_start_baseline` with:

- `inventory_coverage`: files scanned, repo codes seen, detected languages,
  package managers, adapter signals, scan truncation, high-signal records, and
  coverage gaps;
- `observed_workflows`: workflow and UX records visible from current sources;
- `inferred_rules`: path, adapter, configuration, contract, data, and hypothesis
  signals that may be rules but are not confirmed intent;
- `known_unknowns`: open questions emitted by the run;
- `risky_workaround_candidates`: hypotheses, reflections, and adapter risks
  that might be intentional exceptions, bugs, or temporary patches;
- `required_human_questions`: high-impact questions needed before promotion or
  behavior-changing implementation;
- `initial_preservation_test_candidates`: candidate harness targets that require
  review before becoming tests or implementation constraints.

Rules:

- If no `accepted` + `confirmed` records are present, set
  `sparse_memory=true` and include an authority warning.
- A sparse baseline must not claim confirmed memory. It must separate observed
  context, inferred context, unknowns, and required human questions.
- Context packs generated from sparse cold-start data must surface the sparse
  memory warning and coverage gaps near the top of the pack.
- Preservation candidates from sparse baselines are prompts for review, not
  proof that the current behavior is intended.

### Record Authority

```json
{
  "confidence": "observed",
  "source_authorities": ["implementation"],
  "freshness": "unknown",
  "sensitivity": "internal",
  "can_guide_implementation": false,
  "approval_required": true,
  "reason": "Observed behavior is evidence, not proven business intent."
}
```

Rules:

- `inferred`, `hypothesis`, `contradicted`, `unknown`, and `deprecated` records
  must not guide implementation without an accepted owner approval or waiver.
- `candidate`, `scratch`, `stale`, `superseded`, `rejected`, and `deprecated`
  records must not guide implementation.
- Implementation-only evidence can show current behavior, but it does not prove
  intended policy.
- A `waived` record can guide implementation only within the waiver scope and
  must preserve the waiver owner/revisit condition in the promoted artifact.

## Authority Model

Authority depends on the question.

For intended business behavior:

```text
approved_policy > accepted_decision > requirement > human_review_comment > test_proof > implementation > summary
```

For observed system behavior:

```text
runtime_observation > implementation > test_result > summary
```

If policy and implementation disagree, discovery records a contradiction or
possible defect. It does not silently promote implementation to policy.

## Relationship Model

Records may link to each other through typed relationships.

| Relationship | Meaning |
| --- | --- |
| `has_property` | object -> field rule |
| `constrained_by` | object/field/workflow -> business rule |
| `enforced_by` | rule -> code/test/config/runtime evidence |
| `participates_in` | object/actor/system -> workflow |
| `maps_to` | canonical concept -> adapter/export/import field |
| `configured_by` | behavior -> configuration surface |
| `depends_on` | rule/workflow/data -> dependency |
| `conflicts_with` | record -> record |
| `supersedes` | newer record -> older record |
| `raises_question` | record -> question |
| `decided_by` | record -> decision |
| `promotes_to` | discovery record -> requirement/memory/ADR/ticket |

Relationships are evidence pointers, not proof by themselves.

## History And Supersession

Discovery must preserve history:

- never overwrite an accepted record in place without `supersedes`;
- record `effective_from`, `effective_to`, and `applies_when` when known;
- mark stale records when a source hash changes;
- keep rejected hypotheses and failed interpretations when they prevent repeated
  bad advice;
- record contradictions until resolved, not just the winning answer.

## Discovery Run Envelope

Derived discovery artifacts should use this top-level shape:

```json
{
  "kind": "concord.business_discovery.run",
  "schema_version": 1,
  "project": {
    "name": "example",
    "scope": "existing-repo",
    "repos": ["backend", "frontend"]
  },
  "generated_at_utc": "2026-06-27T00:00:00.000Z",
  "generator": {
    "name": "business-discovery",
    "version": "0.1.0",
    "command": "coord discovery run --json"
  },
  "sources": [],
  "records": [],
  "relationships": [],
  "contradictions": [],
  "questions": [],
  "question_ledger": [],
  "decision_ledger": [],
  "reflection_ledger": [],
  "promotion_candidates": [],
  "adapter_signals": []
}
```

Artifacts under `coord/.runtime/discovery/` are derived and rebuildable. Accepted
knowledge must be promoted through governed docs, requirements, ADRs, or memory
records rather than silently mutating the derived run.

## Record Shape

```json
{
  "id": "BD-REC-000001",
  "kind": "business_rule",
  "subject": "Invoice",
  "predicate": "requires_approval_before_posting",
  "object": "amount > customer.approval_threshold",
  "statement": "Invoices above the customer-specific approval threshold appear to require manager approval before posting.",
  "scope": {
    "repos": ["backend", "frontend"],
    "bounded_context": "billing",
    "tenants": [],
    "applies_when": "customer.approval_policy = 'threshold_based'"
  },
  "confidence": "observed",
  "status": "candidate",
  "classification": "internal",
  "evidence": [],
  "authority": {
    "confidence": "observed",
    "source_authorities": ["implementation"],
    "freshness": "unknown",
    "sensitivity": "internal",
    "can_guide_implementation": false,
    "approval_required": true,
    "reason": "Observed behavior is evidence, not proven business intent."
  },
  "relationships": [],
  "history": {
    "effective_from": null,
    "effective_to": null,
    "supersedes": [],
    "superseded_by": null,
    "source_hashes": []
  },
  "review": {
    "owner": "business-domain-owner",
    "review_required": true,
    "reason": "implementation-only claim asserts possible intent"
  }
}
```

## Promotion Rules

Discovery can propose; governance promotes.

| Promotion target | Required before promotion |
| --- | --- |
| Requirement | Stable id, authoritative source or human acceptance, acceptance criteria or gap note. |
| Memory claim | Evidence citations, confidence/status classification, no active contradiction, permission classification. |
| ADR/decision | Decision question, options, chosen answer or pending owner, consequences, source context. |
| Ticket | Clear outcome, risk, dependencies, verification path, and source-backed rationale. |
| Question | Owner or role, why it matters, blocking/non-blocking status, source pointers. |

Promotion must preserve the source record id and evidence refs so later context
packs can cite why the item exists.

Promotion into memory must also preserve the compiler outcome. `accepted`
claims can become active memory when the target process accepts them.
`candidate` and `review-required` claims may appear as advisory context with
their uncertainty labels. `conflicted`, `superseded`, `stale`, `rejected`, and
secret-tainted claims must not enter active context packs.

## Synthesis Readout Shape

The synthesizer emits a read-only cockpit model inside the synthesis artifact:

```json
{
  "read_only_contract": {
    "ui_tier": "read_only",
    "discovery_execution_allowed": false,
    "file_mutation_allowed": false,
    "mutation_path": "Run discovery, synthesis, context-pack generation, and promotions through explicit governed CLI commands; cockpit/readout surfaces only render existing derived artifacts."
  },
  "cockpit_readout": {
    "kind": "concord.business_discovery.cockpit_readout",
    "schema_version": 1,
    "discovery_runs": [],
    "adapter_signals": [],
    "fact_confidence": {
      "by_confidence": {},
      "by_status": {},
      "facts": []
    },
    "contradictions": [],
    "open_questions": [],
    "decisions": [],
    "workarounds": [],
    "preservation_candidates": [],
    "ticket_context_packs": {
      "command": "coord/scripts/coord business-context-pack --ticket <ticket-id> --input coord/.runtime/discovery/synthesis.json --scope <scope> --json",
      "default_json_ref": "coord/.runtime/context-packs/<ticket-id>.json",
      "default_markdown_ref": "coord/.runtime/context-packs/<ticket-id>.md"
    }
  }
}
```

This model is a derived readout, not a command surface. It exists so a UI can
show business discovery state without needing to know how to execute discovery
or governance workflows.

## Preservation Harness Candidates

Business discovery may propose preservation harnesses from discovered rules,
contracts, workflows, defects, workarounds, configuration surfaces, and data
dependencies. These are candidate guardrails, not implementation tests.

Candidate harness types include:

- golden fixtures for uncertain but high-value examples;
- validators for business rules and field rules;
- workflow simulations for user/system process behavior;
- schema, lineage, or row-shape checks for data dependencies;
- adapter contract checks for imports, exports, APIs, events, and integrations;
- regression reproductions for contradictions, defects, and known workarounds.

Rules:

- candidates must cite the source discovery record and evidence;
- candidates default to `status=candidate` and `approval_required=true`;
- the synthesizer must not silently create implementation tests, validators, or
  fixtures;
- a governed ticket must approve, scope, and implement any candidate harness;
- uncertain, inferred, unknown, or contradicted discoveries may propose
  candidates, but they must not become active preservation tests until the
  underlying business question is resolved, approved, or explicitly waived.

## What Agents Must Not Do

- Do not infer business intent from implementation alone.
- Do not treat frontend field limits, backend validators, tests, or migrations as
  mutually consistent without checking for drift.
- Do not hide contradictions to make the plan look cleaner.
- Do not collapse tenant/customer-specific exceptions into global rules.
- Do not store secrets or private customer data in public artifacts.
- Do not mutate tickets, requirements, ADRs, or memory from a reviewer pass; a
  governed synthesizer must accept changes.

## Initial Derived Paths

Recommended paths for implementation:

| Artifact | Path | Mutability |
| --- | --- | --- |
| Discovery run | `coord/.runtime/discovery/run.json` | derived |
| Discovery synthesis | `coord/.runtime/discovery/synthesis.json` | derived |
| Discovery synthesis docs | `coord/.runtime/discovery/docs/*.md` | derived drafts |
| Discovery index | `coord/.runtime/discovery/index.json` | derived |
| Accepted promoted records | `coord/product/BUSINESS_DISCOVERY_PROTOCOL.md` or domain docs | governed |
| Discovery schema | `coord/product/business-discovery.schema.json` | governed template contract |

## Minimal Definition Of Done For Discovery Runs

A future `coord discovery run` should be considered useful only when it emits:

- source inventory;
- object/field/workflow/configuration candidates;
- evidence refs for every claim;
- confidence/status classification;
- contradictions and open questions;
- human-light question, decision, and reflection ledgers with evidence and
  owners where applicable;
- promotion candidates with target type and required reviewer;
- no secret-prohibited literals;
- deterministic output for identical inputs.

The current product CLI command is:

```bash
coord/scripts/coord business-discovery --json
coord/scripts/coord business-discovery --json --output coord/.runtime/discovery/run.json
coord/scripts/coord business-discovery --write-default
```

The command is read-only by default. It writes only when `--output` or
`--write-default` is explicit, and that output is a derived artifact.

The synthesis command consumes a discovery run and builds context graph plus
draft promoted documents:

```bash
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --json
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --json --output coord/.runtime/discovery/synthesis.json
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --output-dir coord/.runtime/discovery/docs
coord/scripts/coord business-discovery-synthesize --write-default
```

The synthesizer drafts:

- `BUSINESS_CONTEXT.md`
- `WORKFLOW_INVENTORY.md`
- `DOWNSTREAM_CONTRACTS.md`
- `BUSINESS_RULES.md`
- `KNOWN_WORKAROUNDS.md`
- `DECISION_LOG.md`
- `PRESERVATION_HARNESS_CANDIDATES.md`
- `OPEN_BUSINESS_QUESTIONS.md`

These documents are context-pack inputs and review aids. They are not accepted
policy, requirements, ADRs, or memory until promoted through governance.

Ticket-specific packs are generated from synthesis artifacts:

```bash
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --scope "invoice posting" --json
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --touched-file backend/src/invoices/post.ts --output coord/.runtime/context-packs/COORD-123.json --output-md coord/.runtime/context-packs/COORD-123.md
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --write-default
```

The pack selects only relevant cited facts, workflows, field rules, contracts,
workarounds, contradictions, open questions, and approval/promotion cues. It
stores lightweight refs to `coord/.runtime/context-packs/<ticket>.json` and
`.md` in the artifact itself so plans/tickets can point at the pack without
loading the full discovery graph.

Each context pack includes `read_only_contract` and `ticket_context` fields for
cockpit/readout consumers. `ticket_context` groups the relevant discovery run,
adapter signals, fact-confidence summary, contradictions, open questions,
decisions, workarounds, preservation candidates, proposed ticket
recommendations, and selected record refs for the ticket. It is still derived
context only; it does not approve behavior changes or mutate ticket state.

## Business-Context Gate

Behavior-changing tickets that touch business rules, schema meaning, workflows,
reports, downstream contracts, integrations, workarounds, or high-risk domains
must not move to review with business context left implicit. Before closeout,
their plan must include at least one of:

- a business-context pack reference, e.g.
  `business-context: coord/.runtime/context-packs/<ticket>.json`;
- an explicit owner approval or waiver, e.g.
  `business-context approval: <owner/reason>` or
  `business-context waiver: <owner/scope/revisit>`;
- an investigation status, e.g.
  `business-context investigation: <owner/status/question>`.

The gate is fail-closed only for risk-signaled behavior changes. It is not meant
to block ordinary docs, mechanical cleanup, or tickets that do not touch business
meaning.

Context packs expose a machine-readable `gate.behavior_change_gate` summary:

```json
{
  "gate": {
    "behavior_change_gate": {
      "has_business_context_refs": true,
      "has_approval_or_waiver": false,
      "has_investigation_status": true,
      "unresolved_uncertain_count": 2,
      "proposed_ticket_recommendation_count": 2,
      "status": "investigation_required"
    }
  }
}
```

`inferred`, `unknown`, `hypothesis`, `contradicted`, `stale`, and
implementation-only `observed` findings are not active backlog. When a context
pack produces `proposed_ticket_recommendations`, those findings must be filed as
`proposed` tickets for human triage before they can become schedulable `todo`
work. This preserves the central rule:

> Implementation is evidence, not always intent.
