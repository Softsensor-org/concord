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

## Backfill Query and Volume Safety Checklist

A backfill, generated-data, or derived-data replay job can pass every
output-correctness test and still take production down, because correctness tests
run against small fixtures while production runs against uncontrolled history and
large blob columns. **Output correctness is not enough: the query shape and the
data volume must also be proven.** This checklist is the reviewer-runnable
companion to the `bootstrap_risk` plan fields (COORD-159) and the advisory scan
below.

Run through every item before review/closeout of any job in the
`server_bootstrap_job`, `derived_data_job`, or `production_repair` class. Each
item maps to a `bootstrap_risk` field where one exists, so the answers are
recorded on the plan record, not just asserted in prose.

- [ ] **Row-count estimate.** What is the expected and worst-case row count at
      production scale (not fixture scale)? Record it in
      `bootstrap_risk.resource_envelope.expected_rows`. "A few thousand in dev"
      is not an estimate.
- [ ] **Batch size.** Rows are processed in bounded batches, not all at once.
      Record `bootstrap_risk.resource_envelope.batch_size`. State the batch size
      and why it is safe for the largest expected row.
- [ ] **Streaming / pagination.** Any input whose size is not fully controlled is
      streamed or paginated (keyset/cursor preferred over `OFFSET` for large
      tables). Record `bootstrap_risk.data_access_shape` (e.g. `paginated`,
      `streamed`). A single unpaginated read of uncontrolled history is a
      blocker for the job design, not a style nit.
- [ ] **Blob-column access.** The query selects only the columns it needs. Large
      blob/JSON/payload columns are read only when required, and only within a
      bounded row set. No `SELECT *` over history. Note in the plan how blob
      memory is bounded.
- [ ] **DB pool impact.** The job's connection/cursor usage is declared and
      bounded so it cannot starve the API's pool. Record
      `bootstrap_risk.resource_envelope.db_pool_impact` (e.g. "one read cursor,
      one writer").
- [ ] **Timeout and memory envelope.** Declared maximum wall-clock and memory.
      Record `bootstrap_risk.resource_envelope.timeout_s` and `memory_mb`. The
      job fails fast or degrades safely when it approaches either bound.
- [ ] **Checkpoint interval.** Progress is checkpointed often enough that a crash
      loses at most one interval of work, and a rerun resumes from the
      checkpoint rather than restarting the whole scan. Record
      `bootstrap_risk.checkpoint_strategy` (e.g. "row-id watermark persisted
      every batch") and the interval.
- [ ] **Production-scale query-shape proof.** There is a fixture, synthetic
      large-volume case, `EXPLAIN`/query-plan capture, or load shape that
      demonstrates the query behaves at production scale — index usage, no full
      table scan where one is unsafe, bounded memory. Promote production-derived
      findings into fixtures/tests (see Hard Rules) rather than asserting from a
      one-off prod observation.

If any item cannot be answered, the work is not ready: tighten the job design or
move it to a separate governed job. None of this is a blocking gate by itself —
it is a review aid — but a reviewer should treat an unanswered item as a finding.

### Optional advisory scan (`coord/scripts/backfill-query-advisory.js`)

`scanBackfillQueryText(text)` is an **advisory-only, warning-first** helper that
flags a few *obvious* broad-query shapes in any text/diff/SQL-ish input:

- a bare `SELECT *` projection (`select_star`);
- a blob/payload-style column read inside a backfill/listing/scan path
  (`blob_column_in_scan_path`);
- an unbounded ORM bulk read — `findAll`/`findMany`/`.all(...)` with no nearby
  `limit`/`take`/`first`/pagination token (`unbounded_orm_read`).

It mirrors the COORD-160 advisory contract exactly: every result carries
`blocking: false`, it never fails a gate, never changes an exit code, and never
throws. It is a **heuristic substring/regex matcher, not a SQL or ORM parser**
(an explicit non-goal — see below): it is deliberately conservative and
under-warns to avoid false positives (`count(*)`, qualified `t.*`, and bounded
`findMany({ take })` are not flagged). A derived repo may choose to surface its
findings in its own review tooling, but coord never blocks on it.

**Non-goals (COORD-162):** no full SQL parser, no ORM-specific exhaustive
analyzer, no production database access, and no gate failure by default.

## Plan Record Expectations

Tickets that add or modify startup, migration, seed, backfill, derived-data, or
server bootstrap behavior should record the following fields under the optional
`bootstrap_risk` object on the plan record (schema support landed in COORD-159):

```json
{
  "bootstrap_risk": {
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
    "checkpoint_strategy": "row-id watermark persisted every batch",
    "verification_signal": "job receipt + marker row + metric",
    "rollback_or_disable": "feature flag off by default; job can be rerun from checkpoint",
    "observability_requirements": ["logs", "task status", "metrics", "failure reason"],
    "data_access_shape": "paginated"
  }
}
```

The whole `bootstrap_risk` object and every field inside it are optional and
advisory: plan records that do not touch deployed startup or data-generation work
omit it entirely, and existing plan records remain valid unchanged. `startup_work_class`
accepts one of `local_bootstrap`, `deploy_bootstrap`, `startup_work`,
`server_bootstrap_job`, `derived_data_job`, or `production_repair`. There is no
blocking validation that rejects tickets lacking these fields — advisory
readiness surfacing is tracked separately by COORD-160. Tickets may still mirror
the same information in `critical_invariants`, `feature_proof`,
`requirement_closure`, and self-review risks.

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

## Bootstrap Jobs Executed As Live-MCP Operations (COORD-164)

A server bootstrap job is sometimes *executed* as a live/production MCP
operation — e.g. the historical backfill runs as a one-off ECS task launched
through the production-MCP adapter lane
(`coord/docs/PRODUCTION_MCP_ADAPTER_PLAN.md`). In that case the live-MCP receipt
(COORD-152/153, and the ECS one-off / cleanup receipt from COORD-155) already
carries everything the bootstrap job needs to prove: the task/resource id, the
timeout, the stopped/completed state, a redacted log/metric pointer, the
redaction record, and the cleanup state. Forcing a second, parallel COORD-161
bootstrap receipt would be redundant.

`coord/scripts/bootstrap-via-live-mcp.js` is the bridge. It is **not a third
gate** — it reuses the COORD-153 live-MCP lifecycle gate for
cleanup/redaction/receipt/approval enforcement and adds only a *bootstrap
coverage* check on top.

**When it applies (strict, explicit, opt-in):** ONLY when a ticket's plan record
declares BOTH the COORD-153 `live_mcp` object AND the COORD-159 `bootstrap_risk`
object. That co-presence is the author-authored signal "this bootstrap job runs
as a live-MCP operation". A normal ticket, a bootstrap-only ticket (still needs
its own COORD-161 receipt — never silently satisfied), and a live-mcp-only
ticket are all unaffected.

**The mapping** (`mapLiveMcpReceiptToBootstrapEvidence`) — how a live-MCP receipt
field satisfies each bootstrap evidence requirement:

| Bootstrap requirement | Satisfied by live-MCP receipt field(s) |
|---|---|
| `ecs_one_off_task_record` | `temp_access.resource_id` (or `task_id`) + `temp_access.timeout` + a terminal `temp_access.cleanup_state`/`task_state` (`completed`/`stopped`/`failed`) |
| `observability` | `logs`/`metrics` pointer, or an `evidence[]` line naming a log/metric/dashboard/trace pointer (redacted; never raw logs) |
| `cleanup` | proven complete only: `temp_access.cleanup_state === "completed"` or a populated COORD-152 `cleanup` field (`pending`/`failed`/absent ⇒ unmet) |
| `redaction` | a recorded `redaction` value (no raw production payloads) |
| `promotion` | `promotion` evidence — required only when the live finding changed product behavior (`live_mcp.product_impact` truthy) |

**Enforcement (reuse, not a third gate):** closeout/move-review stays blocked
when cleanup or redaction is missing because the existing COORD-153 gate already
runs on the same `live_mcp` object. The bridge adds only
`bootstrap_via_live_mcp_coverage` (the receipt does not cover a required
bootstrap evidence item) and `bootstrap_via_live_mcp_receipt` (no inline receipt
to field-map — coverage cannot be proven, so it blocks rather than silently
passing). `gov explain` surfaces the per-requirement mapping under
`bootstrap_via_live_mcp`.

**Non-goals (COORD-164):** no broad deploy automation; no raw production
payloads or credentials in git — receipts stay redacted/customer-safe and tests
use synthetic data only.

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
