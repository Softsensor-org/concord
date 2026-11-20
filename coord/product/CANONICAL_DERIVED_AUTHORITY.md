# Canonical vs Derived Authority

Status: enforced for new checker surfaces; source-of-truth policy for coord state.

## Rule

Canonical state may produce compatibility views, rendered views, indexes, and
evidence receipts. Those derived artifacts may not overwrite canonical state
unless an explicit governed repair or promotion command says so.

## Authority Table

| Surface | Class | Authority |
|---|---|---|
| `coord/board/tasks.json` | authority | Canonical ticket board and indices. |
| `coord/.runtime/plans/<ticket>.json` | authority | Canonical ticket plan record. |
| `coord/.runtime/governance-events.ndjson` | authority | Hash-chained governance journal. |
| signed attestations and snapshots | authority | Checkpointed evidence over canonical state. |
| `coord/PLAN.md` | compatibility view | Markdown compatibility view over plan records. |
| `coord/rendered/*` | derived rebuildable view | Generated board/timeline/user-facing summaries. |
| context packs | derived rebuildable view | Advisory retrieval artifact until explicitly promoted. |
| `coord/memory/*` | generated index | Rebuildable memory/search/index materialization. |
| `coord/evidence/*` | ephemeral evidence | Receipts/artifacts cited by plan/journal; retention is policy-specific. |
| `coord/gates/*` | authority | Gate policy/configuration sources. |
| `coord/product/*`, `coord/docs/*` | authority | Authored product and governance documentation. |

## Forbidden Inversions

- A read path must not write as a side effect.
- `coord/PLAN.md` must not overwrite a richer runtime plan record except through
  explicit governed repair.
- `coord/rendered/*` must not be treated as canonical board input.
- context packs and memory summaries must not be cited as implementation
  authority unless the underlying source is cited.
- ephemeral evidence should not be committed unless a retention policy requires
  it.

## Check Command

```bash
coord/scripts/coord authority-check --canonical-input coord/rendered/TASKS.md
coord/scripts/coord authority-check --operation '{"kind":"sync","source":"coord/PLAN.md","target":"coord/.runtime/plans/COORD-379.json"}'
```

The command is read-only and fails on authority inversions. Warnings identify
evidence-retention issues that need a policy decision rather than automatic
mutation.
