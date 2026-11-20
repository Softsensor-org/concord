# Governance maintenance — 2026-09-28

User authorization: resolve open governance issues and commit/push the resulting
state. This review covers operational state and documentation debt; it does not
qualify unfinished implementation tickets or authorize a public release.

## Repairs and evidence

- Recovered COORD-550, COORD-579, COORD-768 and COORD-774 with owner-preserving
  `gov recover --human-admin-override`. Preserved their worktrees, branches and
  ticket statuses. Recovered COORD-676 to the current owner session.
- Retired nine September 7–8 drift notes through the supported retirement writer
  after its preview established a newer journal baseline.
- Resolved the original COORD-707/699 question using its existing approved
  append-only landing correction. `gov audit-landings --ticket COORD-699`
  reports merged with remote ancestry; the original record remains preserved.
- Corrected the false COORD-676 dev-base blocker. GOVERNANCE sections 7.1/7.2
  exclude Repo X from product-repository dev policy, and control-plane-paths.js
  defaults to main. Its clean feature branch fast-forwarded from dfc7bc5f to
  44adccd1; its original start evidence remains intact. Coverage implementation
  is still pending, and the ticket is doing.
- `gov resolve-question --dry-run` reported zero unresolved rows after repair.
- `gov doctor` and `gov orch` passed, with zero exception blockers, stale
  questions or merged-but-not-done entries. Their advisory findings are below.
- `gov conform --json` passed with no broken links across 11,135 events;
  `gov verify-engine` reported IN-SYNC. This is chain consistency evidence,
  not a claim of externally trusted historical migration authentication.
- Refreshed TEST_MATURITY through `gov coverage-rollup`: 61/2,284 historical
  review cycles failing and 123 recovery events. Existing coverage artifacts
  report pass, lowest 90.91; this is not an engine coverage measurement.
- Backfilled 34 template-feedback lessons from canonical ticket descriptions;
  the real feedback collector now returns zero missing entries. These lessons
  do not requalify historical implementations.

## Advisory dispositions and retention plan

The donor backend/ and frontend/ directories are not independent Git repositories.
Doctor correctly excludes their worktrees from product-repository auditing.
Do not initialize fake nested repositories or remove valid mappings merely to
silence this diagnostic.

The board freshness warning is the known COORD-755 defect: runtime-cleanup.js
compares board mtime with every journal event timestamp, including events that
do not change the board. The canonical sync committed board, plan, rendered
views and journal together in 13ad18f6, with a clean checkout. COORD-755 remains
open for the causal diagnostic repair; no timestamp touch or blanket reconcile
was used to hide the warning.

Journal retention is at warning level: 11,135 events / 7,033,705 bytes at the
checked head, below critical limits of 25,000 events / 25 MiB. The existing
JOURNAL_RETENTION_POLICY requires planning rotation at this level. Preserve
the live raw chain until a supported segmented reader and rotation writer can
fulfil its contract; no documented rotation verb is presently exposed.

The next retention implementation must archive an immutable segment with its
terminal hash, algorithm, bytes, event count and timestamp range; bind the next
segment to that metadata; preserve historical recall and conformance replay;
and prove conformance, engine integrity, seal and board validation across the
boundary before changing the operational journal. Validate dry-run and rollback
first. Reassess growth before fleet expansion or either critical limit. Current
conformance and engine checks pass; no events were deleted or rewritten, and
no thresholds were raised to suppress the warning.
