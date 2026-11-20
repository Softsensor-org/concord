# SEO Governance Contract

Use Coord as the workflow and evidence layer for SEO execution.

Rules:

1. No SEO action from audit data starts until the latest source export is
   checked and registered.
2. Every URL-level finding gets a lifecycle row.
3. Live fixes move indexing findings to `monitoring`; they do not close the
   finding until recrawl/export evidence or an expected-excluded decision exists.
4. Raw exports stay outside coord and are referenced by path.
5. Platform writes require before evidence, command/mutation evidence, read-back,
   live verification, and rollback notes.
6. Theme/runtime code changes belong to the product/theme repo ticket model.
7. Expected utility URLs are classified before content work is proposed.
8. Tickets declare required capabilities and forbidden actions.

Status values:

- `new`
- `triaged`
- `action-planned`
- `admin-updated`
- `theme-updated`
- `verified-live`
- `submitted-to-search-console`
- `monitoring`
- `indexed`
- `closed-expected-excluded`
- `deferred`
