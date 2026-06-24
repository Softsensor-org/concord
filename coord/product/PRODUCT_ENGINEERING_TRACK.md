# Product-Engineering Track — Governed Production-MCP Analytics & Problem-Solving

Status: **implemented (pilot)** · Part of the [Multi-Track Governance Profile](MULTI_TRACK_GOVERNANCE_PROFILE.md).
Adopts the operating model in [`../docs/PRODUCTION_MCP_ADAPTER_PLAN.md`](../docs/PRODUCTION_MCP_ADAPTER_PLAN.md).

## What this track is

The **product-engineering** track governs work that touches **production through MCP** to investigate,
analyze, and solve real problems against the live system — distinct from writing code (development),
shipping infra (devops), or building data products (data & analytics). Its defining axis is
**production access**, so its gate is **evidence integrity**, not a test suite.

| | product-engineering | development |
|---|---|---|
| Capability surface | live production MCP / data access | repo write |
| Gate | `evidence` — operation-class + receipt + redaction (`analytics-gate.js`) | `test` — `testCommand` |
| RBAC posture | most sensitive (operation classes, approval, redaction) | standard |
| Operator | product engineer / analyst | engineer / coding agent |
| Output | redacted receipt + classified finding | merged code |

Ticket prefixes: `PE-`, `LIVE-MCP-` (see the `tracks` block in `coord/project.config.js`).

## The gate: evidence, not tests

`coord/scripts/analytics-gate.js` (COORD-187) is the engine's first **evidence-only gate path**. It does
not run a test suite — it validates the ticket's live-MCP receipt set via
`runtime-evidence.js` `validateLiveMcpReceipt`:

- at least one receipt exists for the ticket;
- each receipt satisfies its **operation class** policy (`OPERATION_CLASSES`): redaction present where
  required, approval present where required, cleanup proven where required, scope bounded, evidence attached.

```
node coord/scripts/analytics-gate.js <PE-ticket> --json
```

Receipts are recorded through the existing CLI (GCV-1 O3: the long-lived MCP server is read-only, so
recording is a CLI action in a live session):

```
coord/scripts/gov live-mcp-record <ticket> --class read_sensitive --adapter <adapter> \
  --operation <op> --scope "<bounded scope>" --redaction masked_pii --approval <approver> \
  --evidence "<query>" --evidence "<result summary>"
```

## Operation classes (from `runtime-evidence.js`)

| Class | Approval | Redaction | Cleanup |
|---|---|---|---|
| `read_safe` | ticket | recommended | no |
| `read_sensitive` | human | **required** | no |
| `write_low` | human | recommended | no |
| `write_prod` | human | **required** | **yes** |
| `destructive` | human_admin | **required** | **yes** |

Default posture for analytics/investigation is `read_safe` / `read_sensitive`.

## Review policy (documented posture — COORD-185)

The track's `reviewPolicy` (in the `tracks` config + `track-registry.js`) sets the bar; for the pilot it
is **documented posture** (convention + review), to be hardened to engine-enforced RBAC per
[`release/ENTERPRISE_RBAC_MODEL.md`](release/ENTERPRISE_RBAC_MODEL.md) before non-engineers self-serve.

| Track | Approvers | Required evidence |
|---|---|---|
| product-engineering | 1 | valid live-MCP receipt(s) (operation-class satisfied + redaction) |

Operation-class → RBAC mapping (documented): `read_*` map to operator/maintainer reads;
`write_prod`/`destructive` require admin-level approval and are out of scope for the analytics use case.

## Handoff to development (COORD-190)

The track does **not** fix code itself. When an investigation finds a code defect, it spawns a
development-track child via the existing follow-up mechanism — no engine change needed, because the child
ticket's prefix resolves its track automatically (`track-registry.js`):

```
coord/scripts/gov open-followup --parent <PE-ticket> --relation blocking
# -> child DEV-/FE- ticket resolves to the development track (test gate); evidence linked at closeout
```

Relations (`followups.js`): `blocking` (child must complete first), `related` (parallel),
`closeout-blocker` (child may stay open but blocks parent close).

## Skills (`.claude/commands/`, COORD-188)
- `/live-mcp-policy` — show operation-class policy + scope/approval for the ticket (read-only).
- `/analytics-query` — run a bounded production-MCP read, record a redacted receipt, validate it.
- `/insight-analyst` — interpret findings ("so what?"), classify (code defect / data anomaly / operational),
  open the development-track handoff when a fix is needed.

## Future: data analytics
The same machinery generalizes to governed read-only data sessions. Larger pipeline/certified-product work
belongs in the sibling [Data & Analytics track](DATA_ANALYTICS_TRACK.md); a live-MCP read here can feed a
pipeline there (the tracks chain via `gov open-followup`).
