# Journal Append Sequencer Plan

## Problem Statement

The governance journal is a line-oriented append-only log where each event stores
`prev_event_hash` for the prior stored event. That gives the current journal one
canonical total order and makes reorder/tamper visible during chain verification.

The scaling problem is that total order is currently produced by a coarse local
runtime lock. If two governed mutations append from different views of the
chain head, the second event can point at a stale predecessor and the chain
cross-links. `gov repair-chain` can restamp links after the fact, but repair is
a break-glass recovery path. It should not be the normal concurrency story.

The goal is to make crossed `prev_event_hash` links impossible by construction
while preserving Concord's current audit shape: a deterministic journal, board
rebuildability, seal checks, and conformance attestation over the journal chain
head.

## Design Goals

- Preserve the current single ordered journal as the compatibility authority
  during migration.
- Make append ordering explicit and centralized, not an accidental side effect
  of whichever process writes first.
- Keep `gov conform`, `gov explain`, `gov recent`, `gov recover`, and
  attestation verification compatible.
- Allow future throughput improvements for independent ticket streams without
  weakening audit ordering.
- Keep repair-chain available only as a legacy or break-glass path.
- Avoid a required remote service for Community installs.

## Non-Goals

- No live journal migration in this spike.
- No runtime change to `coord/scripts/journal.js`.
- No removal of the existing runtime lock in the first implementation phase.
- No replacement of the conformance attestation model.
- No attempt to make derived views authoritative.

## Current Model

```text
governed mutation
  -> runtime lock
  -> mutate board/plans/prompts/rendered artifacts
  -> append one journal event with prev_event_hash = current head
  -> release lock
```

This is simple and correct while there is one effective writer. The weak point
is that multiple processes can still observe or write coordination state around
the same time, especially as repo-X work becomes more parallel. The lock is a
protection mechanism, not an append protocol.

## Options

### Option A: Single Append Sequencer

Introduce a local append sequencer as the only component allowed to advance the
journal head.

```text
worker process
  -> creates append request
  -> sequencer assigns sequence number
  -> sequencer stamps prev_event_hash from its own latest head
  -> sequencer writes the journal line atomically
  -> sequencer returns event_hash and sequence number
```

Pros:

- Minimal conceptual change from the current total-order journal.
- Preserves all existing readers and conformance semantics.
- Makes chain-head authority explicit.
- Easy to test: every appended event must have `seq = prior seq + 1`.
- Fits Community installs as a file-backed local queue.

Cons:

- Still serializes the final journal append.
- Requires crash recovery for pending append requests.
- Does not by itself remove board-store contention.

### Option B: Per-Surface Sharded Chains With Checkpoints

Partition append streams by surface, such as ticket ID, board store shard,
continuity cadence, or repo surface. Each shard has its own `prev_event_hash`;
a checkpoint record periodically commits the vector of shard heads into a
central chain.

```text
ticket stream COORD-359: e1 -> e2 -> e3
ticket stream COORD-360: f1 -> f2
checkpoint: { COORD-359: h3, COORD-360: hf2 } -> central chain
```

Pros:

- Independent streams can append without contending on one event head.
- Natural fit for a future transactional board store.
- Useful when high-volume continuity/runtime evidence dwarfs lifecycle events.

Cons:

- Much more complex retrieval and audit semantics.
- Existing tooling assumes a single ordered NDJSON journal.
- Cross-ticket ordering becomes partial-order plus checkpoint order.
- Conformance must verify both shard chains and checkpoint inclusion.
- Repair and migration are riskier.

### Option C: Hybrid Sequencer Now, Shards Later

Keep the public journal as one sequenced compatibility log, but define append
requests with a future `stream_id` and `surface_refs`. The local sequencer
orders all requests today. Later, high-volume streams can move to shard chains
that emit checkpoint events into the central sequenced log.

Pros:

- Fixes the current cross-link failure mode first.
- Keeps existing chain verification and attestation intact.
- Creates a clean migration seam for sharding without forcing it now.
- Aligns with the transactional board store plan: row-level board concurrency
  can improve independently while journal ordering remains one explicit commit
  stream.

Cons:

- Requires discipline to treat sharding as a later measured optimization.
- Sequencer throughput remains the short serial section.

## Recommendation

Implement **Option C**.

Phase 1 should add a single local append sequencer and keep the canonical journal
as one total-order chain. This turns the final append into an intentional commit
queue, similar to a merge queue for governance events. It keeps the serial
section small while allowing ticket work, board preparation, test execution, and
review to remain parallel.

Sharded chains should remain a later high-scale backend. They should be enabled
only when measurements show that the sequencer append section, not board-store
or test execution, is the bottleneck.

## Target Architecture

### Append Request

A governed mutation produces an append request instead of writing directly:

```json
{
  "request_id": "JREQ-20260628-000001",
  "ticket": "COORD-359",
  "command": "submit",
  "identity": {
    "agent_id": "a239",
    "owner": "codexa239"
  },
  "surface_refs": [
    "coord/board/tasks.json",
    "coord/.runtime/plans/COORD-359.json"
  ],
  "payload": {
    "before_status": "doing",
    "after_status": "review",
    "details": {}
  },
  "idempotency_key": "gov:submit:COORD-359"
}
```

The request is not an audit event yet. It is a pending write intent.

### Sequencer State

The sequencer owns a small durable state file:

```json
{
  "version": 1,
  "next_seq": 2033,
  "journal_head": "sha1:...",
  "last_event_hash": "sha1:...",
  "last_request_id": "JREQ-20260628-000000"
}
```

Only the sequencer updates this file. A stale writer cannot advance
`journal_head` directly.

### Sequenced Event

The stored journal line keeps existing fields and adds optional sequence
metadata:

```json
{
  "ts": "2026-06-28T06:20:00.000Z",
  "seq": 2033,
  "stream_id": "global",
  "command": "submit",
  "ticket": "COORD-359",
  "prev_event_hash": "sha1:previous",
  "append_request_id": "JREQ-20260628-000001",
  "idempotency_key": "gov:submit:COORD-359"
}
```

Legacy readers can ignore `seq`, `stream_id`, and `append_request_id`. New
validators can enforce monotonic sequence ordering when those fields exist.

## Ordering Semantics

The compatibility journal remains a total order:

- `seq` is strictly increasing for sequenced events.
- `prev_event_hash` must equal the hash of the immediately prior stored event.
- duplicate `append_request_id` or duplicate `idempotency_key` must be treated as
  idempotent replay or fail-closed, never as a second event.
- event timestamps are informational; sequence order is authoritative.
- board state is interpreted by latest valid event order, not filesystem mtime.

For future sharded streams:

- a shard event is ordered within its shard by `shard_seq`;
- a central checkpoint event commits `{ stream_id -> stream_head }`;
- cross-shard ordering is only guaranteed at checkpoint boundaries unless a
  transaction explicitly declares cross-stream dependencies.

## Chain-Head Authority

Authoritative head advances in this order:

1. Sequencer verifies current on-disk journal head.
2. Sequencer stamps `prev_event_hash`.
3. Sequencer appends the canonical journal line with atomic write discipline.
4. Sequencer recomputes and stores the new head.
5. Conformance reads the stored journal and verifies from the journal, not from
   sequencer state alone.

The sequencer state is an operational cache and recovery aid. The journal
remains the audit source of truth.

## Conformance and Attestation Compatibility

Current conformance attestation signs a digest that includes the journal chain
head. That model should remain unchanged in phase 1:

- `gov conform` verifies the single chain exactly as today.
- if `seq` exists, `gov conform` additionally verifies strict monotonic sequence
  fields and unique append request IDs.
- attestation continues to bind `journal_chain_head`.
- older attestations remain valid for pre-sequencer chain heads.

Future sharded mode must not replace the central chain-head signature. It should
add a checkpoint digest:

```json
{
  "journal_chain_head": "sha1:central-head",
  "checkpoint_root": "sha256:merkle-root-of-stream-heads",
  "stream_heads": {
    "ticket:COORD-359": "sha1:...",
    "ticket:COORD-360": "sha1:..."
  }
}
```

The central chain remains the signed anchor that auditors can verify with one
artifact.

## Crash Recovery

The sequencer needs a request queue with three states:

```text
pending -> committed -> acknowledged
pending -> rejected
```

Recovery rules:

- pending request with no matching journal event: retry or reject safely.
- committed request with matching `append_request_id` in journal: mark
  acknowledged.
- committed request whose journal line exists but sequencer state is stale:
  rebuild sequencer state from the journal head.
- request payload whose governed filesystem snapshot no longer matches: reject
  and require normal reconcile.

The queue should be gitignored runtime state. The journal line is the durable
audit record once committed.

## Repair-Chain Compatibility

`repair-chain` remains a break-glass path with stronger labeling:

- pre-sequencer events can be repaired under current rules.
- sequenced events with valid `seq` should normally never need restamping.
- repairing sequenced events must record that sequence metadata was preserved.
- if repair changes the order of sequenced events, it must fail closed unless a
  human-admin break-glass flag records a new checkpoint/attestation event.

This prevents repair from silently laundering ordering mistakes.

## Migration Plan

### Phase 0: Design and Tests

- Land this plan.
- Add fixtures that describe crossed-link failure, sequenced append success, and
  duplicate request idempotency.

### Phase 1: Sequencer Facade, No Behavior Change

- Add `JournalAppender` or `JournalSequencer` facade.
- Route current direct append calls through the facade while still holding the
  existing runtime lock.
- Add `seq` and `append_request_id` to new events.
- Keep existing journal verification as the primary check.

### Phase 2: Pending Request Queue

- Add a local request queue under `coord/.runtime/journal-queue/`.
- Make append idempotency explicit.
- Add recovery command/report for orphaned pending requests.

### Phase 3: Narrow the Critical Section

- Let mutation preparation happen outside the append critical section.
- Keep the sequencer as the only writer for final journal lines.
- Pair with transactional board store row versions so board and journal commit
  can be verified as one logical mutation.

### Phase 4: Optional Stream Shards

- Add stream IDs for high-volume, low-cross-dependency event families.
- Keep central checkpoint events in the compatibility journal.
- Add conformance verification for shard head inclusion.

## Validation Contract

New validation should prove:

- `prev_event_hash` links remain valid.
- `seq` is contiguous and strictly increasing for sequenced events.
- `append_request_id` is unique.
- `idempotency_key` duplicates do not create multiple semantic events.
- sequencer state can be rebuilt from the journal.
- conformance attestation over `journal_chain_head` is unchanged.
- future checkpoint events bind all declared shard heads.

## Security and Audit Considerations

- The sequencer is an ordering authority, not a trust bypass. It must not accept
  requests that skip existing governance mutation checks.
- Direct journal writes remain out-of-band drift and must fail the seal.
- Pending append requests are not audit truth until committed to the journal.
- Sequence numbers are convenience/order checks; the hash chain remains the
  tamper-evident integrity primitive.
- Signed attestations continue to anchor the final chain head.

## Follow-Up Tickets

- Add a `JournalSequencer` facade around existing appends while preserving the
  current runtime lock.
- Add sequence metadata validation to journal verification.
- Add pending append queue and duplicate request idempotency tests.
- Add sequencer recovery report to `gov doctor`.
- Revisit sharded chains only after transactional board writes and affected-gate
  selection are measured under multi-agent burn-in.

## Rollback

If phase 1 causes issues:

- disable sequencer metadata emission in config;
- keep reading existing journal lines as today;
- rebuild sequencer state from the current journal head later;
- keep already-emitted `seq` fields as ignored metadata for legacy readers.

No rollback path should require rewriting the live journal.

