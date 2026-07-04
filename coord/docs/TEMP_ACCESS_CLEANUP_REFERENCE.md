# Temporary-Access / ECS Cleanup Receipt Adapter Reference (Production MCP P4 / COORD-155)

A **generic, reusable reference pattern** for SHORT-LIVED operational access:
one-off ECS debug tasks, temporary security-group ingress, debug ports, elevated
roles, or temporary tokens. coord-template ships the *pattern*; the adopter owns
the real wiring (the actual ECS `RunTask` / `authorize-security-group-ingress` /
assume-role call, the real ARNs, the real revoke command). "AWS ECS debug task"
is only the motivating shape — the pattern is domain-neutral
("temporary elevated access").

- Reference adapter: `coord/scripts/adapters/temp-access-cleanup-reference.js`
- Tests (synthetic only): `coord/scripts/temp-access-cleanup-reference.test.js`

## Non-goals (hard)

- **No broad deploy automation.** This is access lifecycle + cleanup receipts,
  not a deployer.
- **No real AWS calls.** The reference NEVER touches the network. The adopter
  injects the open/cleanup executors; tests inject synthetic ones.
- **No real credentials, account ids, or resource ARNs committed.** Tests use a
  fake all-zero account id and a masked token reference.

## What the pattern models

A temporary-access **grant** opens short-lived access to a named resource and
records:

- **task/resource identifier** — `resource_id`, or any of `task_arn`,
  `task_id`, `security_group_rule_id`, `role`, or `port` (refused if absent, so
  access is always traceable);
- **timeout** — how long the access may legitimately live (required);
- **planned stop/revoke command** — recorded at grant time so cleanup is
  provable, not improvised (required);
- a **masked token reference** — a raw token/secret never enters the evidence.

The **cleanup** resolves to one of three terminal states:

| State | Meaning | Closeout |
|---|---|---|
| `pending` | nothing cleaned up yet | **blocked** |
| `failed` | stop/revoke did not succeed; `failure_reason` recorded | **blocked** |
| `completed` | resource stopped/revoked **with** stop/revoke evidence **and** a cleanup timestamp | **ready** |

A `completed` claim missing either the stop/revoke evidence or the timestamp is
**downgraded to `failed`** — a half-finished cleanup can never masquerade as done.

## How cleanup-pending blocks closeout (reuse, not a parallel gate)

COORD-153 (`coord/scripts/live-mcp-lifecycle.js`) already enforces *"no closeout
while cleanup pending"* for `write_prod`/`destructive` operation classes and for
any ticket that declares `cleanup_required=true`. It reads the
`live_mcp.cleanup` field as cleanup-completion evidence: present ⇒ satisfied,
absent ⇒ blocked.

This adapter **feeds that gate** rather than re-implementing one. It builds a
COORD-152 `write_prod` receipt (via `runtime-evidence.js`) and emits a
ready-to-embed `live_mcp` declaration whose `cleanup` field is:

- **absent while pending** ⇒ COORD-153 blocks closeout;
- **absent when failed** (with the failure surfaced in the receipt) ⇒ blocked;
- **present** (stop/revoke evidence + timestamp) when completed ⇒ closeout
  proceeds.

`cleanup_required` is always `true` on the emitted declaration so the gate is
armed regardless of class.

## Usage

```js
const { recordTempAccess } = require("coord/scripts/adapters/temp-access-cleanup-reference.js");

const { receipt, liveMcpDeclaration, closeoutReady } = recordTempAccess({
  ticket: "COORD-XXX",
  operationClass: "write_prod", // or "destructive"
  grant: {
    access_type: "ecs-debug-task",
    task_arn: "<task arn>",
    timeout: "900s",
    revoke_command: "aws ecs stop-task --task <task>",
  },
  cleanup: {
    state: "completed",
    stop_evidence: "ecs:task STOPPED (exitCode=0)",
    cleaned_at: "2026-06-24T00:12:00.000Z",
  },
  approval: "human:<approver>",
});

// Embed the declaration so COORD-153 enforces cleanup at closeout:
//   gov update-plan COORD-XXX --live-mcp '<JSON.stringify(liveMcpDeclaration)>'
```

The adopter owns the real `openAccess` / `runCleanup` executors and the real
ARNs. coord-template ships only the synthetic, network-free pattern.
