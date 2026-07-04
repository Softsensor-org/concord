# Intelligent Gate Planner Plan

Status: draft plan  
Date: 2026-06-28  
Scope: coord-template gate and testing policy across tracks

## Purpose

Concord should not treat testing as one command, one lane, or one percentage
target. The governed question is:

- what risk does this ticket introduce;
- which track owns the work;
- which files and contracts changed;
- which proof dimensions close the risk;
- when uncertainty requires full fallback.

The target architecture is **minimum sufficient proof with fail-closed
fallback**. Agents should not choose gates by preference. Concord should compute
the gate plan from policy, changed surface, track, risk class, and evidence
requirements, then record a reviewable receipt.

## Current State

The repo already has strong building blocks:

- `coord/product/TESTING_AND_GATES.md` defines risk-based testing dimensions,
  lane policy, affected-target selection, and fail-closed fallback.
- `coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md` defines five tracks:
  marketing, development, devops, product-engineering, and data-analytics.
- `coord/scripts/track-registry.js` resolves ticket prefixes to track,
  gate-proc, default lane, skills, review policy, and operator.
- `coord/scripts/affected-targets.js` selects dependency-affected gate targets
  and falls back to full mode for unknown files, missing maps, empty maps, or
  explicit full override.
- Track-specific gate-procs exist:
  - `content-gate.js` for marketing/content integrity;
  - `infra-gate.js` for devops scaffold checks;
  - `analytics-gate.js` for live-MCP receipt/evidence validation;
  - `data-contract-gate.js` for data-product contracts and data-quality rules.
- Repo gate runners emit lane artifacts for `default`, `full`, and `ci`.
- Live-MCP lifecycle enforcement and bootstrap-via-live-MCP coverage blockers
  are wired when the relevant plan fields are declared.

This is enough for pilot-scale governance. The missing layer is a first-class
runtime planner that turns those pieces into a mandatory, cited gate decision
for each ticket.

## Current Gaps

### 1. No Central Runtime Gate Planner

Track resolution and affected-target selection exist separately. There is no
single command that combines:

- ticket id and track;
- ticket type and priority;
- declared files;
- actual changed files;
- risk tags;
- dependency map;
- operation class;
- bootstrap/live-MCP declarations;
- prior gate failures;
- manual overrides.

The result should be a gate receipt explaining what must run, what can be
skipped, and why.

### 2. Affected-Target Selection Is Implemented But Optional

The selector correctly fails closed, but use depends on maintained maps and
runner integration. A derived project can still default to broad gates or
manual commands because there is no lifecycle requirement to attach a
selector receipt when claiming a slice.

### 3. Bootstrap/Backfill Risk Is Too Advisory

`bootstrap_risk` is schema-supported and documented, but much of the contract
is advisory unless the ticket also declares live-MCP evidence. High-risk
classes like `server_bootstrap_job`, `derived_data_job`, and
`production_repair` should become blocking when declared.

### 4. DevOps Gate Is Scaffold-Level

The current infra gate is useful for the template scaffold, but real
enterprise deployment needs more proof:

- environment diff;
- deploy identity;
- secret reference validation;
- network and IAM/KMS policy checks;
- rollback proof;
- post-land runtime verification;
- deploy artifact to commit identity.

### 5. Track-Aware Review Policy Is Not Uniformly Enforced

Tracks declare required artifacts, but lifecycle validation still mostly
enforces generic repo gates plus special cases for live-MCP and bootstrap via
live-MCP. Marketing, devops, data, and content artifact requirements need a
common enforcement path.

## Risk Model

Gate planning should use explicit risk classes:

| Class | Meaning | Default Behavior |
|---|---|---|
| R0 | Docs/reference-only | light lane allowed with cited rationale |
| R1 | Isolated local code | focused unit/default gate |
| R2 | Shared code, orchestration, state, contracts | full or affected slice plus contract/state proof |
| R3 | Auth, RBAC, data integrity, journal, signing, cross-repo contracts | full gate plus targeted negative tests |
| R4 | Production, live-MCP, deployment, bootstrap/backfill, destructive ops | full gate plus runtime/evidence receipt and human approval where required |

Escalation rules should be deterministic. Examples:

- auth/RBAC touched -> security and permission tests;
- journal/hash/signing touched -> conformance, recovery, and seal tests;
- board schema touched -> board validation, sync/rebuild, migration tests;
- deployment/bootstrap touched -> runtime receipt and rollback proof;
- live-MCP touched -> operation-class, scope, redaction, approval, cleanup;
- dependency/lockfile touched -> audit or supply-chain gate;
- unknown changed file -> full fallback.

## Target Architecture

Add a `gate-plan` layer:

```text
ticket + track + declared files + actual diff + risk tags + dependency map
  -> selected gates
  -> skipped gates with reasons
  -> fallback mode if uncertain
  -> required evidence by track
  -> receipt stored in plan record
```

The planner should be deterministic and side-effect-light. It should not run the
gates at first; it should produce the plan and receipt. Execution can stay with
existing `gov gate`, repo `scripts/gate.sh`, and gate-procs.

Example receipt:

```yaml
ticket: DATA-042
track: data-analytics
risk_class: R3
mode: slice
changed_files:
  - pipelines/revenue/monthly.sql
selected_gates:
  - data-contract
  - affected target: monthly-revenue-contract
  - row-count reconciliation
skipped_gates:
  - frontend e2e: no UI surface changed
  - live-mcp receipt: no production operation declared
fallback_reason: null
required_evidence:
  - contract registry
  - DQ report
  - reconciliation proof
```

Uncertain case:

```yaml
ticket: FE-122
track: development
risk_class: R2
mode: full
fallback_reason: unknown changed file not present in affected-target map
selected_gates:
  - frontend/scripts/gate.sh full
skipped_gates: []
```

## Track Policy

### Development

Default proof:

- focused unit/default gate for local changes;
- full lane for shared infra, contracts, state, permission, or multi-repo work;
- affected-target slice only when the map covers every changed file.

Escalate for:

- auth/RBAC;
- lifecycle/state;
- journal/board/signing;
- API contracts;
- dependency changes;
- code-quality/architecture debt growth.

### Marketing / Content

Default proof:

- HTML validity;
- local link/reference checks;
- SEO/social metadata;
- sitemap membership when sitemap exists;
- preview URL or explicit skip reason.

Escalate for:

- public release pages;
- regulated claims;
- brand-critical pages;
- generated HTML changes;
- SEO-sensitive redirects or canonical URL changes.

### DevOps / Infra

Default proof:

- config parses;
- security headers/policy present;
- deploy workflow invokes canonical gate contract;
- deploy smoke evidence or explicit non-runtime scope.

Escalate for:

- secret references;
- environment variables;
- identity/IAM/KMS;
- network policy;
- deploy automation;
- rollback or production cutover.

### Product Engineering / Live-MCP

Default proof:

- declared adapter and operation;
- operation class;
- bounded scope;
- approval when required;
- redaction;
- receipt;
- cleanup if required.

Escalate for:

- sensitive reads;
- write operations;
- production mutations;
- temporary access;
- destructive operations;
- promotion of live observations into tests/specs.

### Data / Analytics

Default proof:

- data contract;
- required columns;
- grain/key checks;
- reconciliation;
- row-count proof where declared;
- certified-only dependencies;
- no superseded inputs into certified outputs.

Escalate for:

- derived-data jobs;
- backfills;
- production repair;
- materialized fact tables;
- external pulls;
- finance/customer-facing metrics.

### Bootstrap / Backfill Overlay

When `bootstrap_risk.startup_work_class` is one of:

- `server_bootstrap_job`;
- `derived_data_job`;
- `production_repair`;

then closeout should require:

- resource envelope;
- bounded query/data-access shape;
- idempotency or checkpoint strategy;
- runtime success signal distinct from readiness;
- rollback or disable path;
- observability evidence;
- row-count or output proof where applicable.

## Required Artifacts

Add or formalize these artifacts:

```text
coord/gates/catalog.json
coord/gates/risk-policy.json
coord/gates/escalation-rules.json
coord/gates/affected-targets.json
coord/gates/track-evidence-policy.json
```

For the template, keep them small and conservative. Missing maps or unknown
surfaces must select full fallback.

## Proposed Command Surface

```bash
coord/scripts/gov gate-plan <ticket-id> --json
coord/scripts/gov gate-plan <ticket-id> --write
coord/scripts/gov gate-plan <ticket-id> --full
coord/scripts/gov gate-plan <ticket-id> --track <track>
```

The dry-run form emits a plan. The `--write` form records the receipt into the
ticket plan record. It should not execute gates initially.

Later:

```bash
coord/scripts/gov gate-run <ticket-id>
```

can execute the selected commands, but Phase 1 should focus on planning and
review evidence.

## Lifecycle Integration

Before `move-review`, Concord should require:

- a gate-plan receipt for non-light tickets;
- selected gate commands recorded under repo gates;
- all high-risk required artifacts present;
- full fallback when dependency map is missing or ambiguous;
- explicit waiver or human-admin override for unusual cases.

Before `mark-done` / `finalize`, Concord should require:

- landing evidence;
- gate result evidence;
- runtime/deploy evidence when the gate-plan says runtime proof is required;
- no unresolved high-risk gate-plan warnings.

## Implementation Phases

### Phase 1: Gate-Plan Receipt

- Add `gate-plan` command.
- Resolve ticket -> track.
- Load declared files from plan record.
- Accept actual changed files as input or derive from git when possible.
- Apply basic risk class.
- Run affected-target selector when a map exists.
- Emit receipt with selected/skipped/fallback reason.
- Add tests for deterministic output and full fallback.

### Phase 2: Lifecycle Warning

- Warn at move-review when a ticket lacks a gate-plan receipt.
- Do not block all tickets yet.
- Block only when a ticket claims affected-target slice without selector receipt.

### Phase 3: Track Evidence Enforcement

- Add track-specific required evidence policy.
- Enforce content, infra, data-contract, live-MCP, and bootstrap artifacts
  through one common validator.

### Phase 4: High-Risk Blocking

- Make R3/R4 gate-plan absence blocking.
- Make declared high-risk bootstrap/backfill requirements blocking.
- Require full fallback for unknown surfaces.

### Phase 5: Enterprise Hardening

- Add deploy identity checks.
- Add secret-reference and KMS/IAM/network-policy checks.
- Add post-land runtime verification receipts.
- Add cockpit view for gate plans, skipped gates, fallback reasons, and
  residual risks.

## Acceptance Criteria

- Gate selection is deterministic for the same inputs.
- Unknown files or missing dependency maps select full fallback.
- Agents cannot record a slice without the selector receipt.
- Every skipped gate has an explicit reason.
- High-risk tickets cannot close without required evidence.
- Track-specific artifact requirements are enforced through one validator.
- Existing low-risk docs/reference tickets remain low-friction.
- Current `default/full/ci` lane vocabulary remains unchanged.

## Risk Justification

This architecture reduces both defect risk and operational risk.

Running everything on every ticket gives high coverage but creates resource
contention, slow feedback, and incentives to bypass or under-record gates. Letting
agents choose tests manually is worse: it makes evidence non-repeatable and
unreviewable.

The intelligent gate planner is the middle path:

- policy chooses the proof, not agent preference;
- low-risk work stays fast;
- high-risk work escalates automatically;
- uncertainty fails closed to full validation;
- all omissions are explicit and auditable.

The enterprise framing is:

> Concord runs the minimum sufficient verification for the ticket's risk class,
> and escalates automatically when the impacted surface is uncertain or
> high-risk.

