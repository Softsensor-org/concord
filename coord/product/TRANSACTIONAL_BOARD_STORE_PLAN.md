# Transactional Board Store Plan

## Problem Statement

`coord/board/tasks.json` is currently the canonical board state. All ticket
create/update operations rewrite the whole board behind the coarse governance
runtime lock. That is simple and auditable, but it creates a structural ceiling:

- unrelated ticket rows contend on the same file and lock;
- ticket ID allocation is `read board -> find max -> write board`;
- two agents can produce mixed uncommitted `tasks.json` state even when the
  governed board mutation itself was lock-protected;
- every future concurrency feature remains bounded by the single board file.

The journal must remain the audit log and recovery substrate. The board store
should become a transactional projection with per-record concurrency, stable ID
allocation, and compatibility shims for existing scripts.

## Design Goals

- Preserve the existing governance journal as the source of audit truth.
- Make independent ticket row updates independent at the storage layer.
- Make ticket ID collisions structurally impossible.
- Keep `board.js validate`, rendered views, `gov counts`, `gov plan-waves`, and
  evidence export compatible during migration.
- Allow old checkouts to keep reading `coord/board/tasks.json` during a staged
  transition.
- Fail closed when store generations diverge or indexes are stale.

## Non-Goals

- No runtime migration in this spike.
- No removal of `coord/board/tasks.json` in phase 1.
- No weakening of journal hash-chain, prompt coverage, plan evidence, or closeout
  gates.
- No hidden remote service requirement for Community installs.

## Options

### Option A: Per-Ticket JSON Shards

Layout:

```text
coord/board/
  index.json
  tasks.json              # compatibility projection
  tickets/
    COORD-001.json
    COORD-002.json
  sequences/
    COORD.json
```

Pros:

- Git-friendly diffs; one ticket row per file.
- Low dependency burden.
- Easy recovery from journal events.
- Existing rendered artifacts can still be regenerated from the shard set.

Cons:

- Needs careful atomic rename/write discipline per file.
- Cross-ticket updates still need a small transaction envelope.
- ID allocation needs a separate sequence file and compare-and-swap.

### Option B: Embedded SQLite Store

Layout:

```text
coord/board/board.sqlite
coord/board/tasks.json    # compatibility projection
```

Core tables:

```sql
tickets(id primary key, repo, type, pri, status, owner, description, depends_on, row_json, version)
ticket_sequences(prefix primary key, next_number, version)
board_events(event_hash primary key, ticket_id, command, applied_at)
store_meta(key primary key, value)
```

Pros:

- Real transactions and uniqueness constraints.
- ID allocation is a single atomic update.
- Row-level conflict detection is straightforward.
- Better fit for future central/enterprise service mode.

Cons:

- Binary file is less reviewable in git.
- SQLite availability and runtime version must be pinned.
- Migrations and corruption recovery need stronger tooling.

### Recommendation

Use **per-ticket JSON shards first**, with a storage adapter boundary that can
later support SQLite. Shards solve the immediate multi-agent/git workflow pain
without forcing a binary database into Community. SQLite can become the
Enterprise or high-scale backend once the adapter contract is proven.

## Target Architecture

Introduce a `BoardStore` adapter:

```text
readBoard()
writeTicket(id, patch, expected_version)
createTicket(prefix, row)
reserveTicketId(prefix)
listTickets(filter)
transaction(fn)
exportCompatibilityBoard()
rebuildFromJournal()
validate()
```

The adapter owns storage mechanics. Governance commands still own policy:
prompt coverage, locks, lifecycle transitions, evidence checks, and journal
events.

## ID Sequencer

Ticket ID allocation moves from "scan all rows for max" to a sequence record:

```json
{
  "prefix": "COORD",
  "next_number": 362,
  "version": 17,
  "updated_by_event_hash": "..."
}
```

Allocation protocol:

1. Read sequence record under the board transaction.
2. Reserve current `next_number`.
3. Write `next_number + 1` with compare-and-swap on `version`.
4. Create the ticket shard with `id` uniqueness enforced.
5. Append the normal governance journal event.

If any step fails, the operation fails closed and does not publish a partial
ticket.

## Compatibility Model

During migration, `coord/board/tasks.json` remains a generated compatibility
projection:

```text
ticket shards + index -> tasks.json -> rendered/TASKS.md
```

Rules:

- New writes go through `BoardStore`.
- `tasks.json` is read-compatible but not write-authoritative once the store is
  enabled.
- `board.js validate` validates both the projection and the backing store.
- Doctor flags direct edits to `tasks.json` when store mode is active.
- `gov sync` regenerates `tasks.json`, rendered board views, and prompt index
  from the store.

## Migration Phases

### Phase 0: Adapter Read Facade

- Add `BoardStore` with a JSON-file backend that still reads/writes the existing
  `tasks.json`.
- No behavior change.
- Tests prove existing commands use the adapter.

### Phase 1: Shard Projection

- Add `coord/board/tickets/*.json` and `coord/board/index.json`.
- Generate shards from current `tasks.json`.
- Keep `tasks.json` as compatibility projection.
- Add doctor checks for projection drift.

### Phase 2: Transactional Writes

- Move create/update lifecycle commands to write ticket shards transactionally.
- Add row versions and sequence records.
- Keep the coarse governance lock while validating correctness.

### Phase 3: Narrower Locks

- Replace the global board write lock for independent ticket-row updates with
  per-ticket transaction locks plus sequence locks for create operations.
- Keep global lock for migrations, journal repair, sync, and compatibility
  projection rebuild.

### Phase 4: Optional SQLite Backend

- Add a SQLite adapter behind the same `BoardStore` contract.
- Gate it behind explicit config and migration tooling.
- Keep JSON shard backend as the default Community path.

## Recovery and Rebuild

Recovery order remains:

1. Verify journal hash chain.
2. Read latest board store generation.
3. Replay terminal lifecycle events by ticket.
4. Rebuild missing or stale ticket shards.
5. Regenerate `tasks.json` projection and rendered views.
6. Emit a doctor report for conflicts requiring human reconciliation.

The journal remains the durable evidence record. The board store is a
transactional operational projection, not a replacement for the journal.

## Validation Contract

`board.js validate` should check:

- every ticket shard has a unique ID;
- `index.json` lists exactly the shard IDs;
- sequence `next_number` is greater than every existing numeric suffix for that
  prefix;
- `tasks.json` projection matches the shard set in store mode;
- row versions are monotonically increasing for mutated shards;
- terminal ticket state agrees with the latest journal terminal event unless a
  recorded reconcile explains the divergence.

## Implementation Follow-Ups

- Add `BoardStore` adapter facade over current `tasks.json`.
- Add shard schema and index validator.
- Add shard export/import command.
- Add sequence allocator with collision tests.
- Move `file-ticket` and `open-followup` to the sequence allocator.
- Move lifecycle row updates to `writeTicket(...expected_version)`.
- Add doctor projection-drift repair.
- Add optional SQLite backend spike after JSON shards are proven.

## Rollback

Every phase must preserve a rollback path:

- disable store mode in config;
- regenerate `tasks.json` from the last known-good journal/store snapshot;
- continue using the existing single-file board path;
- keep shard/SQLite files as non-authoritative evidence until a later repair.

## Acceptance Test Shape

- Two parallel ticket updates to different IDs do not contend at the row layer.
- Two create operations with the same prefix cannot allocate the same ID.
- A stale `expected_version` write fails closed.
- Rebuilding from journal recreates shards and projection deterministically.
- Old read-only consumers can still read `coord/board/tasks.json`.
