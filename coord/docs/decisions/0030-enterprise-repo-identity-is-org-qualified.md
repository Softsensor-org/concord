# ADR 0030: Enterprise repo identity is org-qualified (org slug + basename)

- **Status:** Accepted
- **Ticket:** COORD-996 (security follow-up of COORD-954)
- **Date:** 2026-11-16
- **Decision status:** accepted by the human admin on 2026-11-16 (human-admin decision recorded under COORD-1030)

## Context

The Enterprise org collector keys every warehouse table by `repo_id`. Until now `repo_id` was the coord root's basename (`deriveRepoId` returned `path.basename(root)`). Two org roots with the same basename, such as `orgA/platform` and `orgB/platform`, therefore mapped to one id. COORD-954 found that ingest then silently overwrote orgA's repo row, replaced its ticket snapshot and attributed orgB's cost to it (cross-org contamination, fail open). COORD-954 made that fail closed: ingest refuses when a `repo_id` is already bound to a different `coord_dir` (guard `enterprise-warehouse-identity`, error `ENTERPRISE_REPO_ID_COLLISION`). That refusal also blocks legitimate same-basename repos in different orgs.

## Linked Scope

Enterprise org collector `org-collector.js` (`deriveRepoId`, `ingestCoord`, `SqliteSink.migrateLegacyRepoIds`, CLI `--org`); Enterprise `rehash-verifier.js` (mirrored id); the guard `enterprise-warehouse-identity` (`coord/engine/governance-guards.json`); the Enterprise RBAC model document (cross-org section).

## Decision Criteria

The options were compared on the properties that the chosen option (Options Evaluated, option 1) is stated to have: readable ids, deterministic from stored data, distinct orgs kept separate, and no schema change.

## Options Evaluated

1. **Org-qualified ids (chosen).** Readable ids, deterministic from stored data, distinct orgs stay separate, no schema change.

Two other options were evaluated and rejected; they are recorded under Alternatives Rejected.

## Decision

Human-admin decision, 2026-11-16.

The human admin chose **org-qualified repo ids**: `repo_id = "<org>/<basename>"`. Path-derived hashes and a documented basename-uniqueness rule were the other options; both were not chosen.

1. **Org slug source.** The org slug comes from one of two places, in this order:
   - an explicit `--org <slug>` for the roots that follow it on the collector command line (or `{root, org}` entries in the API); or
   - otherwise, the name of the repo root's parent directory (the directory that contains the root's `coord/`), e.g. `/srv/orgA/platform` gives `orga`.

   The parent-directory default makes the id deterministic from data the warehouse already stores (each row's `coord_dir`), so it is also the source for migration. The operator is responsible for the layout; the warehouse stores the resulting ids and `coord_dir`, so a wrong layout is visible in the rollup. An explicit `--org` is the override for any layout that does not match the org.
2. **Validation and normalization.** The slug is lowercased ASCII and must match `^[a-z0-9][a-z0-9_.-]{0,62}$`. Any other value is refused with `ENTERPRISE_ORG_SLUG_INVALID`. Nothing is rewritten beyond lowercasing: spaces, leading dots and non-ASCII are refused, not stripped. The basename is the repo root's basename, which must be nonempty (a root of `/` is refused with `ENTERPRISE_REPO_ID_INVALID`). Basenames are otherwise kept as stored.
3. **Collision rule.** Two different roots that normalize to the same `<org>/<basename>` (for example two checkouts both under an `orgA` directory and both named `platform`) are refused before any write with `ENTERPRISE_REPO_ID_COLLISION`. This is the COORD-954 refusal, kept for residual ambiguity. The same root re-ingested under the same id is idempotent. Distinct orgs with the same basename are separate repos.
4. **Migration of existing warehouse rows.** A legacy row is a `repo_id` with no `/`. The migration (`SqliteSink.migrateLegacyRepoIds`, run at the start of every ingest) maps each legacy id to `<org>/<basename>`, taking the org from that id's stored `coord_dir` (the parent of the repo root) with the same validation as above. Rules:
   - it rewrites `repo_id` in every table that has the column, in one transaction, and verifies each table's row count is unchanged and no legacy id remains;
   - it never merges or drops rows: each row keeps its content and only `repo_id` changes;
   - it is all-or-nothing and refuses with `ENTERPRISE_REPO_ID_MIGRATION_REFUSED` before any write if any legacy id is ambiguous: no repos row vouches for it, the stored `coord_dir` has an invalid or missing org, the stored path's basename differs from the id, or the target id already exists;
   - it is idempotent: a second run finds no legacy ids and does nothing.

   The schema does not change; only values change.
5. **Ingest.** `ingestCoord` migrates first, then applies the collision rule, then writes. A refused ingest changes no table.

## Alternatives Rejected

2. **Path-derived ids (stable hash of the canonical root).** Unique by construction, but ids are opaque, move with the checkout path, and cannot be recovered from the rollup. Rejected by the human admin.
3. **Basename ids with a documented uniqueness requirement.** Keeps the current model but leaves the contamination path open to any operator who reuses a basename. Rejected: COORD-954 showed that the failure is silent cross-org attribution.

## Consequences

- `repo_id` values change for every existing warehouse row (`platform` becomes `orga/platform`). Rollup output, `repos`, `tickets`, `events` and `cost_observations` carry the new ids. Downstream readers that match on a bare basename must match `<org>/<basename>`.
- Rollup and cost attribution stay per org: each org's cost and tickets live under its own id, and org totals are the sum of the per-repo rows.
- The org is not a tenant boundary. Tenant isolation remains the job of `adapter-authz-policy.js`; this ADR only makes repo identity unambiguous.
- The guard `enterprise-warehouse-identity` stays in force for the residual collision case.

## Verification (COORD-996)

- Same-basename repos in different orgs ingest as separate records; re-ingest of an unchanged root is idempotent; a residual same-org collision is refused with no table changed (`org-collector.test.js`).
- Slug derivation, `--org` override and invalid slugs are pinned (`org-collector.test.js`).
- The migration is tested on a fixture warehouse of pre-change rows (`__fixtures__/legacy-warehouse-rows.json`): every row survives with only `repo_id` changed, a second run is a no-op, ingest after migration creates no duplicate, and three ambiguous cases refuse with no write.
- Rollup keeps cost and tickets per org, including same basename in two orgs (`org-rollup.test.js`).

## Open for human-admin acceptance

- Whether the parent-directory default is acceptable as the org source for production layouts, or every production root must pass `--org` explicitly. Resolved at acceptance (human admin, 2026-11-16): the parent-directory default, as Decision item 1 states it (otherwise the name of the repo root's parent directory), with an explicit `--org` overriding it for any layout that does not match the org.

## Approval State

Accepted by the human admin on 2026-11-16 (human-admin decision, given directly in the orchestrator session and recorded under COORD-1030). The Decision section is accepted as written, and the open question above is answered as recorded. Review by agents is not human approval.
