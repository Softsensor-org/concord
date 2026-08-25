# Concord Known Workarounds

Status: temporary operator guidance for verified open defects
Updated: 2026-07-29

Workarounds preserve truth and evidence; they do not waive governance. Remove an
entry when its governing ticket lands and the regression proof passes.

## Blocked ticket with missing/released session or lock — COORD-558

Risk: current `recover` can misclassify blocked-doing and delete valid state;
`resume`, lock release protection, and MCP heartbeat also have exact-match gaps.

Until fixed:

- leave landed-but-uncloseable work accurately blocked rather than superseding it;
- do not run destructive lock release/abandon commands merely to clean the row;
- do not treat `recover` as safe for this exact sequence without first recording
  the board, lock, session, worktree, and landed commit evidence;
- use the documented closeout-blocker relationship when a related engine-fix
  ticket must occupy the same owner's second WIP slot;
- after the repair lands, use explicit recover -> unblock -> finalize and retain
  the original landing provenance.

## Repo-X landing — COORD-512

Risk: `gov land` success does not prove that worktree content reached the
canonical workspace branch.

Until fixed, verify the source commit is present on the canonical base before
recording done. Prefer an explicit reviewed merge followed by the documented
already-landed/no-PR closeout path with exact source and landed SHA evidence.
Never infer landing from the board message alone.

## Retired `init.sh` — COORD-520 / COORD-618

Resolved by retirement: the donor checkout keeps a write-free refusal shim for
old bookmarks, while release cuts and install-surface declarations exclude it.
Use only the artifact-verified npm or SEA channel. Manual copying is recovery,
not a transactional installer, and may omit root assets, modes, integrity
metadata, or future files.

## Cockpit sibling repos — COORD-543

Risk: out-of-bound configured repos can be silently replaced with the engine
root, making git/test counts confidently wrong.

Use repo-native `git status` and configured gate commands for source-of-truth
health. Treat cockpit repo results as untrusted when product repos resolve
outside `PROJECT_ROOT`; do not use them as closeout evidence.

## Context-pack acknowledgement — COORD-571/557

Risk: the writer may accept JSON that the schema and later gates reject.

Before writing, conform exactly to `coord/board/plan.schema.json`: only the
schema-declared keys, arrays where arrays are required, and no convenience
`notes`/runtime-only fields. Immediately rerun the relevant gate/guided-closeout
after the write; a success message from the writer is not sufficient validation.

## Business-context disposition — COORD-554/569

Risk: infrastructure prose may trigger the gate, and the emitted placeholder
does not name the accepted enum.

When the investigation is genuinely not required, record the literal accepted
form `business-context investigation: not-required`. Do not use an owner/status
pair. Record why it is not required in a separate evidence entry without
changing the enum token.

## Requirements import — COORD-525

Risk: bare metadata and unknown enum values are silently ignored/coerced.

Use bullet metadata (`- Key: value`) and only documented enum literals. Inspect
the generated registry fields, not just the reported requirement count. Diff
source IDs/metadata against registry output before using it as traceability
evidence.

## Discovery synthesis — COORD-550

Risk: path classifiers produce high fact noise, miss valid code shapes, and
false-match domain adapters.

Write discovery/synthesis to a scratch directory, review citations manually,
and promote claims selectively. Do not replace canonical knowledge artifacts
with generated output wholesale.

## MCP server — COORD-482

Risk: current stdio framing is not interoperable with standard newline-delimited
MCP clients.

Use only a client explicitly proven against the current framed transport, and
do not claim generic MCP compatibility. Prefer the CLI for governed operations
until the real-client interoperability ticket lands.
