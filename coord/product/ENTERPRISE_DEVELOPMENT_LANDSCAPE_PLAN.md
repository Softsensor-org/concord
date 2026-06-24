# Enterprise Development Landscape Plan

Status: draft
Date: 2026-06-23

## Purpose

Concord should enter the enterprise through the development landscape, not as a
generic enterprise application manager.

The product wedge is:

> Concord is the governed execution layer for agentic software development
> across many repos, services, agents, gates, deploys, and runtime checks.

The enterprise layer expands the repo-local `coord` model into a central
development control plane. It collects evidence from many repo-local Concord
roots, maps that evidence to apps and services, exposes a safe agentic interface,
and enforces policy before agents act through enterprise tool adapters.

## Adoption Thesis

Enterprises will not adopt Concord first as a broad command center over every
system. They will adopt it because they already have engineering teams using
coding agents and they need to make that work:

- coordinated across repos;
- auditable;
- evidence-backed;
- safe around CI, deploy, and runtime systems;
- compatible with existing tools such as GitHub, Jira, CI/CD, observability, and
  security scanners.

The initial buyer does not need Concord to replace Jira, GitHub, ServiceNow,
Datadog, or a service catalog. They need Concord to govern the execution layer
between product intent and verified deployed behavior.

## What Exists Today

The current `coord-template` already provides the edge runtime for one repo or
repo family:

- governed tickets, ownership, worktrees, locks, plan records, and closeout;
- review cycles, PR/landing evidence, gate evidence, and audit journal;
- `coord init`, `coord conformance`, and `coord upgrade`;
- read-only `coord-ui` cockpit views for agents, dispatch, gates, timeline,
  evidence, traceability, runtime, tests, quality, cost, and related state;
- runtime evidence receipt commands:
  - `gov live-mcp-policy`;
  - `gov live-mcp-record`;
  - `gov bootstrap-record`;
  - `gov deploy-record`;
  - `gov deploy-check`;
  - `gov verify`;
  - `gov falsify`;
  - `gov validate-receipt`;
- a governance MCP server with read/check tools available and mutation-capable
  tools gated;
- an enterprise code subtree with collector, rollup, broker, RBAC policy,
  re-hash verifier, conformance bundles, and a deploy scaffold.

These are the right ingredients. What is missing is the development landscape
model that connects many repo-local Concord installs into one enterprise view.

## Target Shape

```text
repo-local Concord roots
  tickets, plans, journals, gates, PRs, deploy receipts, runtime receipts
        |
        v
enterprise collectors
  normalize evidence from many repos and tool systems
        |
        v
development landscape graph
  services, repos, owners, environments, pipelines, dependencies, runbooks
        |
        v
policy broker + adapter layer
  GitHub, Jira, CI/CD, artifact registry, cloud runtime, observability, scanners
        |
        v
agentic development command center
  ask, explain, recommend, plan, dry-run, approve, execute, verify, record
```

The repo-local Concord edge remains the authority for local execution. The
enterprise layer aggregates and governs across edges.

## Core Objects

The enterprise development layer should model these objects explicitly:

| Object | Purpose |
|---|---|
| `Application` | Product/business application grouping one or more services. |
| `Service` | Deployable or operable unit, often mapped to one runtime service. |
| `Repo` | Source repository governed by local Concord or adapter evidence. |
| `Team` | Owning group, escalation path, review authority, approval policy. |
| `Environment` | Dev/staging/prod or named customer/private environments. |
| `Pipeline` | CI/CD pipeline, artifact registry, deploy target, rollback path. |
| `Ticket` | Governed unit of work, usually repo-local but visible centrally. |
| `Agent` | Agent identity/session/owner working under governance. |
| `GateRun` | CI/local test evidence and resource-heavy gate execution. |
| `DeployReceipt` | Proof of what artifact shipped, from which source, to where. |
| `RuntimeVerification` | Proof that deployed behavior actually worked. |
| `Falsification` | Later evidence that disproves a prior closeout. |
| `Incident` | Runtime symptom or failed change linked back to tickets. |
| `Policy` | Rules for who may inspect, approve, execute, and verify. |

## Data Collection

The central layer should collect pointers and normalized summaries first. It
should not centralize raw logs, secrets, source code, or customer data unless a
customer deliberately configures that behavior.

Inputs:

- repo-local `coord/board/tasks.json`;
- repo-local governance journals;
- plan records;
- PR/landing indexes;
- gate artifacts;
- runtime evidence receipts under `coord/evidence/**`;
- CI/CD status;
- artifact registry identity;
- observability query results or pointers;
- security scan outputs such as SARIF, SBOM, dependency findings, and secret
  scan summaries;
- app/service ownership metadata from a service catalog or code-owned registry.

Output:

- central app/service graph;
- central evidence warehouse;
- cross-repo queue and risk summaries;
- agent-facing query and command context;
- policy decisions and receipts.

## Adapter Model

Adapters connect enterprise systems without giving agents raw tool access.

Initial development adapters:

- GitHub/GitLab: repo, branch, PR, review, status checks.
- Jira/Linear/ServiceNow: product ticket references and incident/problem links.
- CI/CD: workflow runs, gate status, artifact build source.
- Artifact registry: image digest/tag/source identity.
- Kubernetes/ECS/Argo/CD: deployed artifact identity and rollout state.
- Observability: bounded health, logs, metrics, traces, SLO status.
- Security scanners: SARIF, SBOM, dependency and secret scan receipts.
- Service catalog: service ownership, runbook, escalation, environment map.

Every adapter operation must be classified:

| Class | Examples | Default policy |
|---|---|---|
| `read_safe` | PR status, CI status, service health summary | ticket-scoped receipt |
| `read_sensitive` | logs, customer-impacting case data | approval + redaction |
| `write_low` | create issue, draft PR, comment, create proposal | human approval when policy requires |
| `write_prod` | restart service, change config, trigger rollback | approval + rollback + receipt + verification |
| `destructive` | delete data, rotate live key, irreversible ops | human-admin approval + break-glass path |

The first productized adapters should be read-heavy and receipt-oriented. Write
paths should come after RBAC/SSO/KMS and approval workflows are proven.

## Safe Agentic Interface

The enterprise agent interface should follow this ladder:

```text
observe -> explain -> recommend -> plan -> dry-run -> approve -> execute -> verify -> record
```

Agents should be able to answer:

- Which services have active agent work?
- Which PRs are blocked by CI?
- Which tickets landed but were not deployed?
- Which deployed changes lack runtime verification?
- Which closures were later falsified?
- Which services are affected by a CVE?
- Which repos have repeated gate contention or high agent-test cost?
- Which apps have risky boot-time jobs or missing rollback evidence?
- Which changes touched auth/security-critical code without the right review?

Agents should not directly mutate enterprise systems. Mutating requests go
through the broker and produce receipts.

## UI Direction

The enterprise UI should become a development command center:

- app/service map;
- repo and pipeline health;
- active agents and active tickets;
- queue and dependency blockers;
- PR and review state;
- CI/gate state and resource contention;
- deployment identity and rollout state;
- runtime verification and falsified closures;
- risky bootstrap/backfill jobs;
- security findings and policy exceptions;
- approval queue;
- evidence export.

The UI should stay read-only until the broker, identity, and approval path can
enforce write safety.

## Adoption Path

### Phase 1: Repo-Family Pilot

Scope:

- one product team;
- 2-5 repos;
- local Concord installed;
- read-only UI;
- no production write access;
- one or two real agent-assisted delivery workflows.

Goal:

- prove multi-agent coordination;
- capture plan/test/review/PR evidence;
- record deploy and runtime verification receipts where available;
- produce an enterprise readiness gap report.

### Phase 2: Development Landscape Graph

Add:

- service/repo/team/environment registry;
- collector from each repo-local Concord root;
- GitHub/Jira/CI read adapters;
- central rollup of active work, PRs, gates, deploy receipts, and runtime
  verification.

Goal:

- give engineering leads and platform teams a cross-repo command center.

### Phase 3: Policy-Governed Adapters

Add:

- adapter registry;
- operation classes;
- approval requirements;
- redaction requirements;
- receipt validation;
- dry-run support;
- read-sensitive and write-low workflows.

Goal:

- make agents useful across development systems without giving them raw access.

### Phase 4: Enterprise Controls

Add:

- SSO/OIDC/SAML;
- RBAC/ABAC;
- KMS/HSM-backed signing;
- SIEM export;
- tenant isolation;
- hardened central deployment;
- live broker enforcement for writes.

Goal:

- satisfy procurement and security requirements for broader rollout.

## Pilot Package

The services-led adoption package should be simple:

```text
Concord Agentic Development Pilot
Duration: 2-3 weeks
Scope: one repo family, one real workflow, read-only command center
Output: governed delivery run + evidence pack + enterprise readiness roadmap
```

Deliverables:

- workflow map;
- Concord install;
- repo/app ownership map;
- governed ticket run;
- PR/gate/deploy/runtime evidence report;
- UI walkthrough;
- security and enterprise gap assessment;
- next-step implementation backlog.

## Success Metrics

Adoption is working if the pilot can show:

- fewer agent collisions;
- clear owner/agent/worktree accountability;
- every meaningful change has plan, gate, review, PR, and landing evidence;
- deployment claims have deploy receipts;
- runtime claims have runtime verification;
- bad closures can be falsified and traced;
- platform leads can see active agent work across repos;
- security can inspect evidence without reading chat history.

## Non-Goals

For the development-landscape wedge, Concord should not:

- replace Jira, Linear, GitHub, ServiceNow, Datadog, or a service catalog;
- become the raw data lake for all enterprise telemetry;
- expose unrestricted production mutation through agents;
- require hosted Concord before repo-local value is proven;
- claim enterprise-ready SSO/RBAC/KMS posture before those controls are live;
- centralize source-code edits away from repo-local governance.

## Near-Term Ticket Map

| Ticket | Outcome |
|---|---|
| COORD-171 | App/service/repo registry for the development landscape. |
| COORD-172 | Enterprise collector that ingests repo-local Concord evidence. |
| COORD-173 | GitHub/GitLab/Jira read adapters for development state. |
| COORD-174 | CI/CD, artifact, deployment, and runtime receipt ingestion. |
| COORD-175 | Development command-center UI views over app/repo/agent/gate/deploy state. |
| COORD-176 | Agentic query interface over the landscape graph and evidence warehouse. |
| COORD-177 | Policy broker for safe development actions and adapter operation classes. |
| COORD-178 | Services-led pilot package and adoption runbook. |
| COORD-179 | Semantic development memory over decisions, tickets, files, and incidents. |
| COORD-180 | Enterprise hardening path for SSO/RBAC/KMS/SIEM and tenant isolation. |
