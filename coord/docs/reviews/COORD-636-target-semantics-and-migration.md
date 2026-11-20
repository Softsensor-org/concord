# COORD-636 design draft — proposed semantics and migration

**Status: design proposal only. ADR-0009 remains Proposed; none of the choices below is adopted or implemented.** This draft is for review and human decisions, not a schema change, ticket migration, or authority to edit board rows.

## Current issue and evidence

The current `Repo` value is doing three jobs: selecting a physical Git/repository context, classifying what sort of work the ticket represents, and serving as a fallback for IDs the registry cannot classify. `X` is especially overloaded: it resolves to the coord Git repository, is documented as “cross-repo / coord-only,” hosts engine implementation work, and is also returned for every unconfigured or malformed prefix. COORD-635 is `done` and fixed the Git-root/lifecycle resolution for X. ADR-0009 still describes the older lifecycle ambiguity; that part is stale. The current semantic conflation remains: X is both the coord repository code, a “cross-repo / coord-only” label, an engine-work home, and the fallback for unknown or malformed prefixes.

Current source-backed behavior:

- `coord/project.config.js` reserves X from product `repos`, configures product `ticketPrefixes`, and has `coordTicketPrefix` for coordination IDs.
- `coord/paths.js` builds the prefix map; duplicate prefixes currently use “first config wins.” `allBoardRepoCodes()` contains configured product codes plus X.
- `coord/scripts/repo-registry.js:71-103` returns X for unknown/malformed prefixes, and prefers an explicit board-row `Repo` before that heuristic. `coord/scripts/repo-registry.test.js` encodes `unconfigured -> X` as expected behavior.
- `coord/scripts/feature-proof-resolution.js:260-267` independently repeats the unknown-prefix-to-X fallback for proof lookup.
- `coord/board/tasks.schema.json:228-272` does not validate a ticket row’s Repo against configured codes and has no target field/enum. Existing board validation checks ticket/status structure but does not impose this target contract.
- `coord/scripts/lifecycle-ticket-admin.js:65-84` creates repo-specific split follow-ups, but records them as merely `related`; the parent does not retain a required participant-to-child map. Its help says close the umbrella by naming one fulfilled-by ticket, even when multiple children exist.
- `coord/scripts/control-plane-fulfillment.js:18-44` accepts fulfillment only for Repo X and requires the selected child to share the parent’s Repo, so it cannot prove a B/F (or other distinct-repo) child set.
- `coord/docs/decisions/0009-control-plane-and-cross-repository-work-use-distinct-ticket-targets.md` is Proposed. It prefers `product_repo`, `control_plane`, and `cross_repo`, and rejects omnibus X. Its statements about X resolving to the wrong Git lifecycle are stale after COORD-635; its unresolved semantic assignment, participant representation, closeout, and historical migration questions remain current.

The read-only board snapshot observed on 2026-10-05 has 833 tickets; Repo counts are `{'X': 817, 'B': 1, 'F': 15}`, and X status counts are `{'done': 730, 'superseded': 46, 'todo': 34, 'review': 2, 'doing': 5}`. Source board SHA-256: `cda3be444dc8c64c92e4153913b11f2b61ce46867f1b91d3954a50629559e2fe`. These are planning observations, not a migration manifest or migrated result. Recapture counts and source digests immediately before any future migration.

## Recommended target model

Add one explicit semantic target independent from `Repo`:

| Target | Meaning | `Repo` / source ownership |
| --- | --- | --- |
| `product_repo` | One product repository owns implementation and its repo gates/review/landing. | A configured product code such as B or F. |
| `control_plane` | Coord engine, governance, docs, or control-plane implementation. | X, resolving to the coord Git repository fixed by COORD-635. |
| `cross_repo` | An umbrella that coordinates required work in multiple declared repositories; it is not a multi-repository implementation worktree. | X as the control-plane home of the coordination record only. Product changes must be in child tickets. |
| `legacy_x` (sidecar-only migration classification) | A historical X row whose old meaning/evidence is preserved and deliberately not asserted to be either modern control-plane or cross-repo work. It is never a board Target or valid value for new tickets. | Keep the row’s existing bytes; classify it only in the immutable digest-bound compatibility manifest. |

This is the “other split” left open by ADR-0009: Repo X names the control-plane repository/home, while `Target` states the kind of work. X alone no longer means cross_repo, control_plane, or an unknown-prefix default. Product Repo codes continue to name the physical product repository; target values make their work class explicit. Cross-repo parents may use the control plane to keep their coordination record, but they cannot use that worktree to implement changes in participants’ repositories.

`legacy_x` is deliberately outside the three active target kinds and exists only as a classification in an immutable, governed sidecar migration manifest keyed by ticket ID and original row digest. This preserves all historical board-row bytes and prevents legacy classification from entering ordinary routing or creation APIs. The manifest is read-only compatibility metadata; it cannot satisfy a modern closeout gate. Do not model legacy rows as a fourth active target.

### Target assignment and prefix contract

- Every newly filed ticket has exactly one explicit `Target` and a valid physical Repo context. New product tickets require `Target=product_repo` plus a configured product Repo code. `Target=control_plane` requires Repo X. `Target=cross_repo` requires Repo X and at least two distinct physical repository participants, each explicitly typed product_repo or control_plane. Inconsistent combinations refuse before writes.
- Product prefixes configured in `project.config.js` map to exactly one product Repo code. Duplicate normalized prefixes become a configuration error, replacing first-config-wins.
- `coordTicketPrefix` remains a recognized ID namespace, but it does not distinguish control-plane from cross-repo work. New tickets in that namespace require an explicit `--target`; this avoids treating every COORD ID as one semantic kind.
- Any prefix that is neither a configured product prefix nor the configured coordination prefix fails closed. It must not be routed to X, even if the caller omits Repo. Do not permit arbitrary explicit Repo values to bypass prefix validation. If human admins need a one-off prefix, register it through reviewed project configuration before filing.
- Ticket IDs must match the existing ticket-ID grammar. Missing, malformed, unknown, and conflicting mappings produce an actionable refusal before board, journal, prompt, plan, or rendered-output changes.
- Existing rows with an explicit target use that target. A historical row’s Repo/ID heuristic must never override a recorded target.

### Resolver decision table

All behavior in this table is proposed, not current implementation.

| Input | Proposed result |
| --- | --- |
| Configured product prefix, matching product Repo and explicit product_repo | Resolve to that product repository only. |
| Coordination prefix, Repo X and explicit control_plane | Resolve to the coord Git repository. |
| Coordination prefix, Repo X and explicit cross_repo | Resolve the coordination record to coord; require a valid participant/child index before execution. |
| Missing target on a new ticket, including a recognized prefix | Refuse before mutation; report valid targets for that namespace. |
| Missing, malformed or unknown prefix, even with explicit Repo/Target | Refuse; registering a prefix is a separate reviewed configuration change. |
| Prefix/Repo/Target conflict or duplicate normalized configured prefixes | Refuse; no first-entry winner or explicit-Repo override. |
| Historical terminal X row with exact immutable compatibility digest | Historical read only; do not infer an active target or reuse old proof as modern cross-repo evidence. |
| Historical open X row with no approved migration entry, or a stale digest | Refuse active routing until reviewed reclassification. |

## Cross-repo parent and child evidence

A `cross_repo` ticket is a coordination parent. Recommendation: it declares at least two distinct physical repository identities as participants. A participant is explicitly typed `product_repo` or `control_plane`; this allows a coordinated change spanning the control plane and a product repository without inventing a mixed-repository worktree. Every participant has exactly one required implementation child with the matching target and physical Repo. A `cross_repo` umbrella cannot be a child or participant, so nested umbrellas and cycles are invalid. Store this relation in a canonical, board-owned structured index with schema validation and governed mutation/audit events. Do not put it only in a rebuildable runtime plan record, description prose, or a related-ticket edge: the index must remain authoritative when plans are regenerated and must be joinable to each participant child. Proposed shape:

```json
{
  "target": "cross_repo",
  "participants": [
    { "target": "product_repo", "repo": "B", "child_ticket": "MSRV-901" },
    { "target": "control_plane", "repo": "X", "child_ticket": "COORD-902" }
  ]
}
```

Each child is a normal independently governed implementation ticket with the participant’s declared Target and matching Repo, a repo-specific prompt/scope, required gates, review evidence, and a landing record verifiable in that repository. Existing `split-ticket` may be evolved to create/record these obligations, but its current `related` edge alone is not a completion contract.

Parent closeout must recompute, under the governed transaction, that (1) the declared participants contain at least two distinct physical repository identities, with no aliases or duplicate repos; (2) each has exactly one existing implementation child, and the child target/Repo match; (3) no participant child is itself a cross_repo umbrella, which prevents nested umbrellas and cycles; (4) no required child is todo, doing, review, failed, or superseded without an accepted replacement; (5) each child satisfies the existing policy for its own repo’s gates, review, and landing provenance; and (6) the parent evidence references each independently verified child landing. Missing, duplicate, wrong-repo, extra/unmapped, stale, or unverifiable evidence refuses closeout atomically. A prose list of PRs, one fulfilled-by child, or one control-plane commit cannot satisfy multiple participants.

A repo’s existing landing policy remains authoritative: the design must not silently require remote ancestry where a configured flow allows local-only evidence, nor lower any existing gate. Each child’s commit and landing evidence are verified against that child’s repository root and policy. The parent records an aggregate pointer and status; it does not synthesize or upgrade child evidence. A one-participant coordination need is represented as a product_repo or control_plane ticket, not cross_repo; this keeps cross_repo closure meaningful as an all-participant join.

Partial delivery leaves the parent open/deferred with the missing participant set visible. Dropping/changing a participant requires a governed change with reason and review, invalidates any prior parent closeout assessment, and cannot silently convert an incomplete parent to done. If a child is superseded, its replacement must be explicitly linked to the same participant and independently pass that repo’s closeout; the old evidence remains historical.

## Backwards-compatible migration plan

Migration is a separate, decision-gated implementation ticket. It is staged and reversible; this design authorizes no direct edits.

1. **Freeze the before-state.** Capture exact board row IDs/status/Repo and hashes, ticket count by Repo/status, `landing_index`/`pr_index` and associated plan/review evidence digests, plus the engine/config revision. Require a clean, stable governance snapshot. This is the comparison source for dry-run and post-migration proof.
2. **Preserve completed and retired X rows byte-for-byte.** Every X row already `done` or `superseded` stays exactly as it is in the board and its associated evidence stores. Do not add Target, rewrite Repo, status, description, dependencies, prompt/plan/review records, PR refs, landing index, commit IDs, or provenance. Record each row as `legacy_x` only in the immutable sidecar migration manifest keyed by ticket ID and original row digest; never infer modern target from descriptions, prefix, commit location, or one/multiple proof paths. In particular, retain historical `control_plane_verification: local_only` as-is; it is not remote ancestry and cannot satisfy a new cross-repo child requirement. The compatibility manifest is an explicit exception map for historical reads, not a source of routing or new closeout evidence.
3. **Classify open X rows through an owner-reviewed manifest.** Generate a manifest entry for every open X row with current row digest, proposed Target/Repo, evidence references, rationale, and named owner/reviewer attestation. The owner confirms actual acceptance scope and participants; prefix and Repo history inform review but never auto-classify. The manifest must account for every open X row. Ambiguous/unreviewed rows remain refused and cannot be routed or mutated after cutover. A single product-repo task may move to `product_repo` plus that configured Repo only after owner confirmation and valid ID-prefix mapping.
4. **Map existing product rows.** Configured non-X rows can be assigned `product_repo` from their existing Repo code, preserving all existing evidence. Any row whose Repo is absent/unconfigured or whose prefix conflicts with its Repo is an exception requiring human resolution, not fallback.
5. **Dry-run, compare, apply.** A read-only migration report lists every proposed classification and refusal, with explicit counts/digests. Require zero unaccounted rows; exact equality of every `landing_index`/`pr_index`/review/plan evidence digest before and after; zero changes to terminal X rows, with the legacy classification stored only in the separate manifest; and an audit event linking old/new values and source row digests for each open-row classification. Apply through governed transactions only, in bounded batches with checkpoint and rollback evidence. No direct JSON edits.
6. **Cut over in stages.** First ship read paths that understand explicit targets and the read-only legacy sidecar manifest. Then require explicit target on new ticket creation and reject unknown prefixes, with no per-command unknown-prefix override. Then enable target-specific worktree/readiness/closeout behavior. Enable cross-repo parent completion only after the board-owned participant index, child evidence, and all-participant closeout gate are implemented and qualified. Delete old fallback only after all callers and migration exceptions are covered.
7. **Prove parity and fail-closed behavior.** Run board/schema and full lifecycle validation on an immutable migrated fixture, plus a dry-run against the current canonical snapshot. Show no historical proof disappears, changes repo root, or changes assurance class; no open X row remains ambiguously routable; and no unknown prefix acquires a target.

The migration’s audit report should state exact candidate/source digest, counts per target and status, IDs refused for human review, and digests of the preserved historical landing/proof sets. Recalculate counts at execution time rather than treating the 833-row snapshot above as permanent.

### Proposed storage, attestation and rollback contract

Use a board-owned `ticket_target_index` for active participant contracts, keyed by parent ID, with schema version, revision, participants, and the declared child for each participant. A participant identity contains its configured repo code, target, and a stable project-config repository identifier; normalized physical roots must also be distinct in the active workspace. The migration must introduce that stable repository identifier rather than treat an absolute machine path as portable identity. A governed compare-and-swap revision update records actor, reason and previous/new contract digests. Replacements preserve prior revisions in the journal and invalidate stale parent assessments.

Proposed compatibility artifacts live under `coord/board/migrations/target-v1/<migration-id>/`: an immutable original `board.snapshot.json`, `legacy-x.json`, and a reviewed `open-rows.json`. The migration ID binds the original board SHA-256 and engine/config revision. A second migration creates a new ID; it never overwrites an earlier manifest. Every terminal X entry binds the ID, original status/Repo, canonical row SHA-256 and exact associated plan/review/PR/landing digests. The exact source board bytes remain in the immutable snapshot. Canonical row encoding recursively sorts object keys by JavaScript string ordering, preserves array order, emits compact JSON without a trailing newline and hashes its UTF-8 bytes with SHA-256; every implementation must use shared test vectors. This is an explicit encoding contract, not an appeal to unspecified JSON formatting.

For each open row, a named current owner attests the actual scope and a separate reviewer approves the proposed Target/Repo/participants, with timestamp, reason, source row digest and authority identity recorded through governance. Unassigned or unavailable-owner cases go to the human admin for explicit disposition; the migration cannot fabricate an owner or use a prefix heuristic as attestation. The committed artifact is approval evidence, while the journal binds the actual apply operation and actor.

Apply requires exclusive governed mutation ownership and exact expected input digests. Each bounded batch records before/after row digests, immutable evidence-set digests, checkpoint and transaction result. Retry of the same batch is idempotent. Rollback restores only rows whose current digest still equals the migration-produced digest and records the inverse transaction; if later legitimate work changed a row, refuse automatic rollback and require reviewed forward repair. Never reset the board or replay an old whole-file snapshot over newer work. Derived files are rebuilt from the resulting canonical board. Acceptance requires zero changes to terminal X row encodings and historical evidence bytes, complete row accounting, no unrecorded partial batch, and no upgraded assurance class.

## Minimum implementation follow-up and acceptance tests

COORD-636 should create separate tickets, all blocked on ADR acceptance, for: (a) target schema/config/resolver and CLI/MCP creation surfaces; (b) governed legacy/open-row migration with dry-run and rollback; (c) cross-repo participant/child declarations, closeout aggregation, and per-repo evidence gates; and (d) documentation/help and downstream config migration. Avoid implementing these under the design ticket.

Minimum tests for those follow-ups:

1. Resolver table: configured B/F prefixes resolve only to their configured repo; coordination prefix without a target refuses; explicit control_plane/cross_repo targets resolve unambiguously; malformed/missing/unknown prefixes refuse. Include normalized duplicate-prefix config and an unknown `Repo` row; neither may fall back to X.
2. Creation boundary: file-ticket, follow-up, and public CLI/MCP reject missing/inconsistent targets and unknown prefixes with no board/journal/prompt/render changes; valid target+Repo combinations persist and round-trip.
3. Board/schema migration: valid active targets pass; invalid target/Repo combinations fail; sidecar `legacy_x` classification is valid only for the exact pre-migration terminal row digest, never for open rows or new tickets; all rows are accounted for in dry-run.
4. Historical invariance: compare pre/post IDs, target/Repo/status, landing/PR/review/plan evidence and hashes for every old done/superseded X row. A historical local-only landing remains local-only and cannot satisfy a new cross-repo parent.
5. Open migration: test explicit product_repo, control_plane, and cross_repo classification; ambiguous/unmapped rows refuse; rerun is idempotent; interrupted batches resume/rollback without duplicated or partial classification events.
6. Cross-repo closeout: product-only and mixed control_plane/product_repo fixtures with independent gates, reviews, and landing commits; success only when every participant child independently satisfies its target’s repo policy. Mutations removing a child, aliasing physical repos, swapping a Repo/Target, duplicating a participant, nesting a cross_repo umbrella or creating a cycle, substituting an unlanded/stale child, downgrading a gate, or marking one child superseded must be killed by the production parent closeout gate. Assert refusal leaves canonical bytes unchanged.
7. Preserve control-plane path: control_plane target uses the coord Git root/lifecycle fixed by COORD-635; cross_repo parent evidence never treats that one root as the source of product child landings.

## Recommended decisions and acceptance boundary

The design recommendation is to adopt the model above: Repo names the physical repository context; Target independently names product_repo, control_plane, or cross_repo. Use an immutable digest-bound sidecar for historical terminal X rows, a board-owned structured participant/child index for cross_repo obligations, at least two distinct physical repository participants, each typed product_repo or control_plane, no cross_repo child/participant, and no unknown-prefix override. Require owner-reviewed manifest entries for every open X row. Existing per-repository landing policy remains authoritative. These choices directly address the current fallback and fulfillment defects while keeping old evidence byte-stable and ensuring a cross_repo parent represents more than a one-repository task.

Before ADR acceptance, human reviewers must explicitly approve or revise these recommendations: (1) Repo/Target separation and exact active target names; (2) the sidecar manifest’s location, immutability, digest format, and read-only use; (3) the board-owned participant index’s schema and governed mutation/replacement procedure; (4) the minimum of two distinct physical repository identities and the allowed participant target types (recommended: product_repo and control_plane, never cross_repo); (5) mandatory Target for COORD IDs and strict rejection of unknown prefixes without CLI override; (6) owner/reviewer roles and attestation format for open-row classification; and (7) which existing child terminal statuses satisfy each repository’s own landing policy. The recommended answer to each is stated above; these are approval decisions, not unresolved design work to be deferred to implementers.

ADR-0009 remains Proposed until those decisions, the migration proof protocol, and separately gated implementation tickets are reviewed. Human acceptance of the ADR would authorize detailed implementation planning only; it would not itself authorize or prove any board migration, schema change, source implementation, or production target-routing behavior.
