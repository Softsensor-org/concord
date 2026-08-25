# Concord Preservation Harness Candidates

Status: curated regression backlog
Updated: 2026-07-29

These scenarios preserve externally meaningful behavior and field incidents.
They are candidates until a governing test ticket or existing ticket adopts
them. Unit tests remain useful, but each sequence below must cross the real
public boundary named in the scenario.

## PH-001 — Blocked ticket recovery after session and lock loss

Sequence:

1. Start a ticket and record real plan/landing evidence.
2. Block it with a reason.
3. Release/expire the bound session and remove only the canonical ticket lock.
4. Run recover.
5. Exercise forced claim as well and assert neither path can report success
   with `lock: null`.
6. Assert recovery recreates a valid lock or fails closed without deleting
   other valid ownership evidence.
7. Resume/claim, unblock, move to review, and finalize.

Preserves: status-role semantics, monotonic recovery, ownership, evidence, and
the complete external-adoption field incident. Governing work: COORD-558.

## PH-001A — Fresh rebind cannot orphan active tickets

Bind a session that owns plain-doing and blocked-doing fixtures, then request a
fresh rebind. The operation must refuse without mutation or transfer every
owned ticket and lock atomically to the successor. It must never mark the old
session released while leaving active tickets without a usable context.

Preserves: owner/session continuity. Governing work: COORD-558.

## PH-002 — Lock release protects blocked-doing

Attempt ordinary lock release on plain doing and blocked-doing. Both must refuse
without the same explicit administrative force/authority. Review/done locks
remain removable according to policy.

Preserves: active-work lock protection. Governing work: COORD-558 scope.

## PH-003 — MCP heartbeat retains blocked ownership

Expose one blocked-doing ticket as the active MCP session ticket. The heartbeat
loop must select it, preserve its blocked status, and refresh its valid lock.

Preserves: long-running blocked work cannot become stale merely because the MCP
adapter exact-matches plain doing. Governing work: COORD-558 scope.

## PH-004 — Repo-X land means content landed

Create a docs ticket in a Repo-X worktree with a unique marker and commit. Run
the public landing command. On success, assert the marker exists on the
canonical base and both source/landed SHAs are journaled. On conflict, assert
the board remains review and no partial canonical files are left.

Preserves: done/landed equivalence. Governing work: COORD-512.

## PH-005 — Every emitted remediation is executable

For every gate/doctor/lifecycle error carrying `Next:` or a command example:

1. Parse it through the real CLI parser.
2. Assert the command and flags exist.
3. Assert enum/JSON examples validate.
4. Arrange the triggering fixture and prove the remediation satisfies or
   advances the original condition.

Include gate-plan `selected_gates[].command` in this contract: each emitted
track/affected command must resolve through the actual public executable. The
COORD-590 baseline caught `coord gate-proc test` being emitted while the product
CLI rejected `gate-proc` as unknown.

Preserves: discoverability and operational correctness. Governing work:
COORD-572 and COORD-569.

## PH-006 — Standard MCP client handshake

Use an official/current client transport to spawn the real governance MCP
server. Complete initialize, initialized notification, tools/list, and one
read-only tool call. Assert newline-delimited JSON-RPC, split/coalesced input
handling, stdout purity, stderr logging, and clean shutdown.

Preserves: ecosystem interoperability. Governing work: COORD-482.

## PH-007 — Public artifact cold start

Build the exact public cut in a temporary directory, enumerate every path
executed by its documented install entrypoints, and run a smoke scaffold from
the artifact. Assert no entrypoint references an excluded donor-only path.

Preserves: installability of shipped bytes. Governing work: COORD-520.

## PH-008 — Post-transform manifest and engine pin

After every confidentiality scrub/render step, run template sync and engine-pin
verification inside the final artifact. Assert all transformed tracked files
are re-stamped and an unmodified fresh cut reports in-sync.

Preserves: integrity checks start truthful on day zero.

## PH-009 — Cockpit never substitutes a repo

Configure one in-bound repo, one approved sibling repo, and one forbidden path.
Assert the read model uses each resolved allowed path exactly once and reports
the forbidden path as unavailable with its reason. It must never display git or
test data from `PROJECT_ROOT` under another repo's name.

Preserves: operator truth and confinement. Governing work: COORD-543.

## PH-010 — Plan ack writer/schema/gate parity

Generate valid and invalid `context_pack_ack` objects from the canonical schema.
For every case, writer acceptance, runtime validator, board/schema validation,
guided closeout, and gate disposition must agree. Unexpected keys and wrong
types fail at write time with JSON paths.

Preserves: one plan contract. Governing work: COORD-571/557.

## PH-011 — Requirements import is loss-aware

Feed bullet metadata, bare metadata, unknown kind/risk/priority literals,
duplicates, and mixed valid/invalid requirements through the real CLI. Assert
lossless registry output for valid data and explicit non-zero/error findings for
anything that would be ignored or coerced.

Preserves: traceability meaning, not just record counts. Governing work:
COORD-525.

## PH-012 — Discovery precision fixtures

Maintain small fixtures for root-level Express routes, CRA `.js` components,
workers/cron workflows, ORM schemas, and unrelated keyword-heavy governance
docs. Measure per-kind precision/recall and assert unrelated domain adapters do
not become confirmed evidence.

Preserves: arbitrary existing-repo adoption. Governing work: COORD-550 and
children.

## PH-013 — Crash-safe governed mutation

Inject termination before first governed write, between canonical writes,
after external PR merge, during journal append, and after journal success before
client acknowledgement. Retry with the same idempotency key and assert a
consistent board/snapshot/journal, at most one logical success, and explicit
external-side-effect recovery guidance.

Preserves: the strong existing transaction envelope in `journal.js`.

## PH-014 — CI exercises the release contract

On a clean clone and PR commit, run the serial governance suite, board validate,
conform, gate lane, template sync, engine verification, dependency audit, public
artifact build, and install smoke. Assert the workflow reports the exact commit
and artifact it certified.

Preserves: assurance without operator memory. Governing work: COORD-560.

## PH-015 — Test entrypoint is location- and role-independent

Invoke the one canonical test command from the workspace root, `coord/`, a
Repo-X linked worktree, and a fresh public cut. It must normalize its root,
unset ambient identity, redirect every mutation authority path to an isolated
sandbox, discover the same suites, and produce the same verdict without touching
the live board/journal/session state.

Preserves: tests remain executable inside the governance workflow they protect.
Governing work: COORD-480.
