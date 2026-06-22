# Server Bootstrap Job Contract

> Status: design contract. Enforcement is tracked by COORD-158 through
> COORD-164.

This contract governs application work that initializes, repairs, backfills, or
generates data in a deployed environment. It is intentionally separate from the
repo bootstrap contract.

## Why this exists

Repo bootstrap makes a codebase workable for developers and CI. Server bootstrap
work runs near production systems and can affect availability, data integrity,
customer-derived facts, deploy rollout, and incident recovery.

A production analytics incident exposed the failure mode this contract is meant
to prevent: a boot-started background backfill can report a healthy `/readyz`,
consume memory in the API process, be OOM-killed, miss its completion marker,
restart, and repeat the same unsafe work on every deploy or task restart.

The rule is simple:

> Heavy or risky data work must be an explicit governed job, not hidden inside
> application startup.

## Work Classes

| Class | Examples | Allowed in app startup? | Governance requirement |
|---|---|---:|---|
| Local bootstrap | local dev seed data, sample metadata, fixture creation | yes, in dev only | repo docs and local gate evidence |
| Deploy bootstrap | config validation, tiny schema compatibility checks | narrowly | deploy gate plus bounded runtime proof |
| Startup work | synchronous work before `listen`, async work launched from boot | only if tiny and bounded | startup risk section and separate success signal |
| Server bootstrap job | historical backfill, generated fact tables, production seed/admin repair | no | separate job ticket, receipt, rollback, observability |
| Derived-data job | replay, materialized analytics, denormalized search/index generation | no | scheduler/queue/job contract and receipts |
| Production repair | data correction, replay after outage, temporary debug task | no | production-MCP/live-ops ticket plus cleanup evidence |

## Hard Rules

Server bootstrap jobs must satisfy these rules before review/closeout:

- Do not run historical backfills, broad scans, or generated-data population in
  the same process that serves the API.
- Do not use `/readyz`, deploy success, or "server started" as proof that the
  job succeeded.
- Record a claim, lease, or checkpoint before or during the work. A marker
  written only after success is not crash-safe.
- Declare the resource envelope: memory, timeout, expected rows, batch size,
  DB connection impact, and health-check window.
- Stream or paginate any input whose size is not fully controlled.
- Avoid broad blob-column reads in list/backfill queries unless the job explains
  why the blob is needed and how memory is bounded.
- Provide an explicit disable, rollback, or rerun-safety strategy.
- Emit a machine-readable receipt with redacted evidence.
- Ensure the operator can observe logs, task status, metrics, failure reason, and
  cleanup state.
- Promote production-derived findings into fixtures, tests, synthetic cases, or
  specs before they become product truth.

## Startup Work Test

A task may run inside app startup only when all are true:

- it is required before serving traffic;
- it is bounded by a small, known input size;
- it cannot allocate unbounded memory or open unbounded DB cursors;
- it is deterministic and safe to repeat;
- it fails fast or degrades safely;
- it has a success signal that is distinct from server readiness.

If any condition is false, move the work to a separate governed job.

## Plan Record Expectations

Tickets that add or modify startup, migration, seed, backfill, derived-data, or
server bootstrap behavior should record the following fields once COORD-159
lands:

```json
{
  "startup_work_class": "server_bootstrap_job",
  "runs_at_boot": false,
  "shares_app_process": false,
  "resource_envelope": {
    "memory_mb": 1024,
    "timeout_s": 900,
    "expected_rows": 100000,
    "batch_size": 500,
    "db_pool_impact": "one read cursor, one writer"
  },
  "idempotency_strategy": "lease + checkpoint + completion marker",
  "verification_signal": "job receipt + marker row + metric",
  "rollback_or_disable": "feature flag off by default; job can be rerun from checkpoint",
  "observability_requirements": ["logs", "task status", "metrics", "failure reason"],
  "data_access_shape": "paginated"
}
```

Until schema support lands, record the same information in `critical_invariants`,
`feature_proof`, `requirement_closure`, and self-review risks.

## Receipt Shape

Server bootstrap jobs should emit a receipt like:

```json
{
  "ticket_id": "APP-123",
  "environment": "staging",
  "job_id": "analytics-backfill-2026-06-22",
  "work_class": "server_bootstrap_job",
  "started_at": "2026-06-22T14:00:00Z",
  "completed_at": "2026-06-22T14:12:33Z",
  "result": "success",
  "rows_seen": 120000,
  "rows_written": 118942,
  "checkpoints": 240,
  "max_memory_mb": 712,
  "exit_code": 0,
  "marker_evidence": "analytics_backfill_runs row id=...",
  "logs": "redacted log query or task id",
  "metrics": "dashboard/query pointer",
  "cleanup": "not_required",
  "redaction": "summary"
}
```

Runtime receipts may contain operational identifiers. Committed evidence must be
customer-safe and secret-free.

## Relationship To Other Coord Docs

- `gov bootstrap-record <ticket-id>` records this contract as a local receipt:
  job name, execution mode, resource envelope, idempotency, observability,
  disable/rollback path, and runtime evidence. It fails closed for heavy/risky
  `api-startup` execution and marker-after-work idempotency claims.
- `coord/product/BOOTSTRAP_CONTRACT.md` governs repo bootstrap: env loading,
  gate runners, and skeleton layout.
- `coord/product/LOCAL_AUTOMATION_AND_GATES.md` governs local/CI/deploy gates.
  A passing deploy gate proves the code gate ran; it does not prove a server
  bootstrap job completed.
- `coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md` governs live access adapters.
  Production MCP can collect evidence about a server bootstrap job, but the job
  design still must satisfy this contract.
- The deployed-app investigation workflow in
  `coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md` governs the loop from live symptom
  to normal development ticket to deployed verification. Server bootstrap job
  fixes still use the normal development lifecycle, with the extra evidence
  requirements in this file.
- The deployment lane in `coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md` proves that
  the landed source was actually shipped. Server bootstrap job verification
  should not treat "landed" as equivalent to "deployed" or "ran successfully".
- `coord/product/SECURITY_AND_OPERABILITY.md` owns the operator access baseline:
  logs, metrics, task status, cleanup, secret handling, and incident response.

## Anti-Patterns

- `runBackfillOnceOnBoot()` in the API process.
- Success marker written only after the entire scan finishes.
- `/readyz` used as proof of async job completion.
- `SELECT *` or blob-column scans over uncontrolled production history.
- Backfill treated as a footnote to a feature ticket.
- Deploy role can update the service but cannot read logs or task failure state.
- Production facts copied into prompts or evidence without redaction and fixture
  promotion.
