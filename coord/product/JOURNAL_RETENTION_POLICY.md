# Journal Retention Policy

Concord's governance journal is the canonical operational memory for board
mutations, lifecycle transitions, recovery markers, and conformance evidence. It
must stay append-only and verifiable, but it cannot grow without an operating
policy.

## Goals

- Preserve the tamper-evident chain across rotation.
- Keep recall and evaluation reproducible by pinning tests to frozen fixtures.
- Surface journal growth before it becomes an operator surprise.
- Keep rotation/compaction deliberate; a read-only health check must never
  rewrite the journal.

## Health Thresholds

`gov doctor` reports journal retention health using these default thresholds:

| Level | Event Count | Bytes | Meaning |
| --- | ---: | ---: | --- |
| warning | 5,000 | 5 MiB | Plan a rotation and ensure frozen recall fixtures are current. |
| critical | 25,000 | 25 MiB | Rotation is required before scaling the fleet further. |

A broken hash chain remains a hard integrity failure independent of size.

## Rotation Contract

Rotation is an operator-controlled maintenance action, not an automatic doctor
repair. A valid rotation must:

1. Close the active segment with its last event hash, hash algorithm, byte size,
   event count, and timestamp range.
2. Write an immutable archived segment under a retention-controlled archive
   location.
3. Start the next live segment with a rotation marker that records the previous
   segment's terminal hash and metadata.
4. Re-run conformance, engine verification, seal verification, and board
   validation after rotation.
5. Leave enough raw journal data, frozen fixtures, and segment metadata to
   reproduce recall/eval benchmarks.

Rotation is invalid if it drops events, rewrites event payloads, changes the hash
algorithm without an explicit migration marker, or makes a historical
conformance attestation unverifiable.

## Compaction Contract

Compaction may create derived snapshots for faster reads, but snapshots are never
authority. A compacted snapshot must cite:

- source segment ids,
- source segment terminal hashes,
- the event range covered,
- the snapshot generator version,
- the board/plan state hash produced by replay.

The raw segment remains the evidence source. If a snapshot and raw replay
disagree, raw replay wins and the snapshot is stale.

## Recall And Eval Fixtures

Recall and memory tests must not depend on the live journal's moving rankings.
When a recall/eval behavior is asserted, the test must pin to a frozen fixture or
a fixture manifest that includes source segment hashes. Live-journal health can
warn about fixture staleness, but correctness tests should remain reproducible as
the operational journal grows.

## Doctor Behavior

Doctor is read-only. It may warn or fail based on journal health, but it must not
rotate, compact, delete, or rewrite journal data. Any future rotation command must
be dry-run by default, require explicit confirmation, and emit its own governed
receipt.
