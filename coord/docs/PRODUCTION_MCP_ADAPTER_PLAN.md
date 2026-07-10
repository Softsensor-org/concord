# Production MCP Adapter Plan

> **Status:** design plan. This document defines the governed adapter model for
> MCP-backed access to production, staging, cloud, database, observability, and
> support systems. It is intentionally a separate layer from the normal coord
> lifecycle engine.

---

## 1. Goal

Create a governed adapter layer for MCP-backed production access so agents can
inspect or operate real systems without bypassing coord.

```text
coord core
  tickets, locks, plans, review, gates, journal, evidence

production MCP adapter layer
  tool registry, risk classes, approvals, redaction, receipts, cleanup

external systems
  AWS, databases, app APIs, observability, support tools, production MCP servers
```

Core principle:

> Coord governs intent, authorization, evidence, and closure. Adapters execute
> bounded external operations and return receipts.

This is not a replacement for normal development governance. It is a privileged
operations and live-evidence lane inside governance.

---

## 2. Why this exists

Production MCP access can materially improve product development. In
production-case workflows, live operational systems reveal real cases,
deployment state, customer data shape, feed anomalies, and runtime failures that
static code review or synthetic fixtures may miss.

That advantage creates a different risk surface:

- agents may read sensitive production data;
- production facts may leak into prompts, plans, journals, or screenshots;
- live observations may become undocumented product assumptions;
- MCP tools may mutate production state;
- temporary debug access can remain open;
- audit evidence may be scattered across chat, tool logs, AWS, MCP, and coord.

The answer is not to ban MCP. The answer is to govern it as a first-class
production-access workflow.

---

## 3. Operating model

Add a dedicated coord leg:

```text
LIVE-MCP / PROD-MCP
```

Use this leg for:

- production or staging investigation;
- live case validation;
- AWS / deployment inspection;
- database or API reads;
- observability queries;
- bounded operational actions;
- temporary debug tasks;
- promotion of live observations into fixtures, tests, or specs.

For product teams with live operational systems, keep this in the same project
coord root as the product work, with a separate ticket type, policy, and adapter
contract.

Create a separate coord root only when production MCP becomes a shared
operations platform across multiple products, customers, or operating teams with
different access ownership.

---

## 4. Adapter contract

Each adapter must expose operation metadata before it can be used:

```ts
type OperationClass =
  | "read_safe"
  | "read_sensitive"
  | "write_low"
  | "write_prod"
  | "destructive";

type AdapterOperation = {
  adapter: string;
  operation: string;
  environment: "local" | "staging" | "prod";
  class: OperationClass;
  requiresApproval: boolean;
  allowedScopes: string[];
  redactionPolicy: string;
  cleanupRequired: boolean;
};
```

Each execution must emit a receipt:

```ts
type McpReceipt = {
  ticketId: string;
  adapter: string;
  operation: string;
  environment: "local" | "staging" | "prod";
  class: OperationClass;
  approvedBy?: string;
  scope: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
  result: "success" | "failed" | "denied" | "partial";
  evidencePath?: string;
  redaction: "none" | "masked" | "summary" | "hash";
  cleanupRequired: boolean;
  cleanupReceipt?: string;
};
```

The core governance engine should understand only:

- which adapter and operation class a ticket is allowed to use;
- which approval is required;
- whether a receipt was recorded;
- whether redaction and cleanup requirements are satisfied.

Adapter implementations own:

- how to call the MCP tool;
- how to scope the operation;
- what fields are sensitive;
- how to redact;
- how to prove cleanup;
- how to turn live observations into reproducible fixtures or tests.

---

## 5. Operation classes

| Class | Examples | Rule |
|---|---|---|
| `read_safe` | deployment status, schema, health checks | ticket required |
| `read_sensitive` | production case, customer payload, database query | ticket + scope + redaction |
| `write_low` | create draft issue, add non-prod annotation | ticket + approval |
| `write_prod` | deploy, config change, stop task | human approval + receipt |
| `destructive` | delete data, rotate secrets, revoke access | break-glass only |

Default class is `read_sensitive` unless an operation is explicitly registered
as safer.

---

## 6. LIVE-MCP ticket contract

A live-MCP ticket must declare:

- purpose;
- production question being answered;
- system and environment;
- adapter and operation;
- operation class;
- exact data scope;
- approval owner;
- allowed output shape;
- redaction rule;
- cleanup rule;
- fixture / test / spec promotion requirement;
- closeout evidence.

Example row shape:

```json
{
  "ID": "LIVE-MCP-001",
  "Type": "live-mcp",
  "Environment": "prod",
  "Adapter": "example-prod-db",
  "Operation Class": "read_sensitive",
  "Scope": "tenant=example, workspace=current, record=sample-001",
  "Approved By": "human-admin",
  "Cleanup Required": "no",
  "Promote To Fixture": "yes"
}
```

---

## 7. Workflow

1. **Request** — an agent or human opens a `LIVE-MCP` ticket with purpose, scope,
   environment, adapter, and operation class.
2. **Approve** — governance checks whether the operation class requires approval.
   `read_sensitive`, `write_prod`, and `destructive` cannot proceed without the
   required authorization.
3. **Execute** — the adapter performs the bounded MCP call. Missing or broad
   scope is rejected.
4. **Redact** — the adapter writes only approved evidence: summary, masked
   output, hashes, or compact JSON.
5. **Receipt** — the adapter emits a receipt into coord runtime / evidence.
6. **Promote** — if live data influenced product behavior, the finding becomes a
   fixture, regression test, synthetic case, or documented rule.
7. **Cleanup** — temporary access, debug ports, ECS tasks, security-group
   ingress, tokens, and elevated roles are closed and recorded.
8. **Closeout** — the ticket cannot close until receipt, evidence, and cleanup
   are complete.

---

## 8. Deployed-app problem-solving workflow

Production MCP is not only for one-off evidence collection. It is the governed
path for moving from "we need to understand the deployed app" back into normal
development.

Use this workflow when an agent is investigating staging/production behavior,
server bootstrap job status, customer-case shape, logs, metrics, deployment
state, or runtime failures:

```text
observe deployed symptom
  -> open or attach LIVE-MCP ticket
  -> scope the production question and allowed data
  -> run bounded adapter operation
  -> emit redacted receipt
  -> classify the finding
  -> open/attach normal development ticket
  -> fix through the existing gov lifecycle
  -> deploy through the deployment lane
  -> assert deployed identity equals landed source
  -> verify deployed behavior with a second bounded receipt
  -> close both tracks with linked evidence
```

The handoff matters:

- A `LIVE-MCP` ticket can discover or verify a problem, but it does not replace
  the normal development lifecycle for code changes.
- A development ticket can implement the fix, but it does not by itself prove
  the deployed symptom is resolved.
- Deployment is a separate lane between land and runtime verification. It proves
  what artifact was shipped, where it was shipped, and whether the running
  artifact corresponds to the landed commit. It is not the same as development
  review, and it is not the same as live behavior verification.
- Deployed verification is a separate receipt when the claim depends on the live
  environment.
- If the issue involves a server bootstrap job, the development ticket must also
  satisfy `coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md`.

Finding classification should be explicit:

| Finding class | Next step |
|---|---|
| code defect | open/attach a normal repo-backed dev ticket |
| server bootstrap/backfill defect | open/attach a dev ticket with server-bootstrap evidence requirements |
| data anomaly | promote to fixture/synthetic case/spec before changing product behavior |
| operational failure | record cleanup/rollback/action receipt and open follow-up if product work is needed |
| inconclusive | close the live ticket as inconclusive with receipt and next diagnostic scope |

Closeout for this workflow requires linked evidence:

- the live-MCP receipt that proved the deployed symptom or question;
- the development ticket / PR / landing evidence, when a code change was needed;
- the deployment receipt proving the landed source was shipped to the target
  environment;
- the deployed verification receipt, when the closeout claim depends on the
  deployed environment;
- fixture/test/spec promotion evidence for any live-derived product rule;
- cleanup evidence for temporary access, tasks, ports, credentials, or elevated
  roles.

## Deployment lane

The deployment lane is distinct from both development governance and production
MCP investigation:

```text
development lane
  plan -> code -> gate -> review -> land

deployment lane
  select landed commit -> build/publish artifact -> deploy -> emit deploy receipt
  -> assert running artifact identity

production-MCP / verification lane
  inspect live system -> emit runtime receipt -> prove or falsify deployed claim
```

The deployment lane should produce a deploy receipt containing at minimum:

- ticket or release identifier;
- target environment;
- landed commit SHA;
- build source SHA;
- artifact/image identifier;
- task definition / release object / deployment id;
- deployed-at timestamp;
- rollout status;
- identity assertion result: running artifact maps back to the landed commit;
- operator or automation identity;
- rollback pointer or previous artifact.

Deployment evidence answers "did the intended bytes ship?" Runtime verification
answers "does the deployed system exhibit the intended behavior?" A ticket may
need both.

---

## 9. Governance rules

- No production MCP call without a ticket.
- No broad production data queries.
- No raw secrets in plans, journals, prompts, or evidence.
- No write operation without explicit human approval.
- No destructive operation except break-glass.
- No ticket closeout while cleanup is pending.
- No live production observation becomes product truth until converted into a
  fixture, test, synthetic case, or spec.
- No deployment claim is accepted without a deploy receipt that ties the running
  artifact back to the landed commit or release source.
- No deployed-app fix is considered proven solely by a local/unit/CI gate when
  the claimed outcome depends on a deployed environment.
- All receipts must be source-linked and auditable.

---

## 10. Evidence storage

Suggested runtime layout:

```text
coord/.runtime/mcp-receipts/
  LIVE-MCP-001/
    receipt.json
    evidence.redacted.json
    cleanup.json

coord/evidence/live-mcp/
  LIVE-MCP-001.md
```

Runtime receipts may contain operational detail. Committed evidence must be
redacted and customer-safe.

---

## 11. Initial adapter set

Start with three adapter families:

1. **Read-only production case adapter**
   - query narrow live/staging case data;
   - require client/date/driver/VRID filters;
   - redact sensitive fields;
   - emit compact JSON evidence.

2. **AWS ECS debug-task adapter**
   - launch a short-lived one-off task;
   - record task ARN;
   - enforce timeout;
   - verify task stopped;
   - record security-group cleanup.

3. **Observability adapter**
   - read logs, metrics, or traces;
   - restrict by service, time window, request id, or case id;
   - summarize errors without dumping raw logs.

---

## 12. UI requirements

Add a read-only coord-ui surface:

```text
/live-mcp
```

It should show:

- open live-MCP tickets;
- adapter used;
- environment;
- operation class;
- approval status;
- evidence status;
- cleanup status;
- fixture / test / spec promotion status;
- redaction warnings.

Viewer role should see redacted summaries only. Operator/admin can see
operational detail according to the existing coord-ui access model.

---

## 13. Phased delivery

Implemented public-safe core:

- `coord/scripts/runtime-evidence.js` defines operation classes, evidence
  classes, receipt validation, deploy identity assertion, bootstrap-job
  validation, runtime verification, and closure falsification.
- `gov live-mcp-policy`, `gov live-mcp-record`, `gov bootstrap-record`,
  `gov deploy-record`, `gov deploy-check`, `gov verify`, `gov falsify`, and
  `gov validate-receipt` provide the CLI surface.
- `coord/scripts/governance-mcp.js` exposes the same surface to MCP clients;
  receipt-writing tools remain mutation-gated until the MCP identity boundary
  supports safe writes.
- Real production calls remain adapter-owned. Coord validates and records the
  resulting evidence; it does not embed customer credentials or production
  connector logic.

| Phase | Ticket | Outcome |
|---|---|---|
| P0 | COORD-151 | Policy, live-MCP ticket contract, and adapter boundary documented in governed docs. |
| P1 | COORD-152 | Adapter registry, operation classes, receipt schema, and validation helpers. |
| P2 | COORD-153 | Governance lifecycle checks for approval, redaction, receipt, cleanup, and promotion blockers. Implemented: `coord/scripts/live-mcp-lifecycle.js` enforces these at move-review/closeout for tickets that declare a `live_mcp` plan object (turned on by `gov update-plan --live-mcp '<json>'`); reuses `OPERATION_CLASSES` + `validateLiveMcpReceipt` from runtime-evidence.js. Default-off for non-live-mcp tickets. See GOVERNANCE.md §10.9. |
| P3 | COORD-154 | Read-only live-case adapter reference implementation. Implemented: `coord/scripts/adapters/live-case-adapter-reference.js` (require client+date+entity filters, reject broad dumps, redact sensitive fields, emit compact JSON evidence + a COORD-152 `read_sensitive` receipt validated via `validateLiveMcpReceipt` so it satisfies COORD-153) plus `coord/scripts/adapters/live-case-fixture-promotion.js` (live→synthetic fixture/regression promotion). Generic/adapter-owned; no committed customer data, credentials, or real endpoints. See `coord/docs/LIVE_CASE_ADAPTER_REFERENCE.md`. |
| P4 | COORD-155 | AWS ECS / temporary access cleanup receipt adapter pattern. Implemented: `coord/scripts/adapters/temp-access-cleanup-reference.js` models short-lived operational access (one-off ECS debug tasks, temporary security-group ingress, debug ports, elevated roles, temporary tokens). The cleanup receipt records task/resource id, timeout, planned stop/revoke command, stop/revoke evidence, cleanup timestamp, and failure state, built on the COORD-152 `write_prod` receipt writer. Cleanup-pending/failed leaves `live_mcp.cleanup` absent so the existing COORD-153 cleanup gate blocks closeout (reuse, not a parallel gate); a proven `completed` cleanup (stop/revoke evidence + timestamp) unblocks it. Generic/adapter-owned; no real AWS calls, credentials, account ids, or ARNs. See `coord/docs/TEMP_ACCESS_CLEANUP_REFERENCE.md`. |
| P6 (bootstrap bridge) | COORD-164 | Server-bootstrap-job ↔ live-MCP receipt bridge. Implemented: `coord/scripts/bootstrap-via-live-mcp.js` defines how a live-MCP receipt (task/resource id, timeout, stopped/completed state, log/metric pointer, redaction, cleanup state — incl. the COORD-155 ECS one-off / cleanup receipt) SATISFIES a server bootstrap job's observability / ECS-one-off-task / cleanup / fixture-test-spec-promotion evidence. Fires ONLY when a plan declares BOTH `live_mcp` and `bootstrap_risk`; reuses the COORD-153 gate for cleanup/redaction enforcement and adds only a bootstrap-coverage blocker (NOT a third gate). Cleanup-pending / missing-redaction / no-inline-receipt block closeout; a bootstrap job without a covering receipt is never silently satisfied. See `coord/product/SERVER_BOOTSTRAP_JOB_CONTRACT.md` §"Bootstrap Jobs Executed As Live-MCP Operations". |
| P5 | COORD-156 | coord-ui `/live-mcp` and evidence-export integration. |
| P6 | COORD-157 | Enterprise hardening: RBAC per operation, SIEM export, adapter signing/versioning, break-glass. |
| P7 | COORD-165 | Governed deployed-app investigation workflow from live evidence to dev fix to deployed verification. |
| P8 | COORD-167 | Deployment lane and deploy receipt contract. |
| P9 | COORD-168 | Deployed artifact identity assertion: running image/artifact equals landed source. |
| P10 | COORD-169 | `gov verify` post-deploy runtime verification phase. |
| P11 | COORD-170 | Closure evidence classes and retroactive verdict falsification. |

---

## 14. Success criteria

This is working when:

- every production MCP action maps to a ticket;
- every action has a receipt;
- sensitive output is redacted by default;
- write and destructive actions require approval;
- temporary access cleanup is provable;
- live findings become tests, fixtures, synthetic cases, or specs;
- deployments can prove the running artifact matches the landed source;
- deployed-app issues can be traced from live symptom to dev ticket to deployed
  verification receipt;
- later runtime evidence can falsify a prior closure without erasing history;
- a reviewer can reconstruct what happened without reading chat history.

---

## 15. Positioning

Production MCP is not a shortcut around governance. It is a privileged
evidence-gathering and operations lane inside governance.

This becomes a Concord product story:

> Concord governs not only code-writing agents, but agents that safely inspect
> and operate real systems.
