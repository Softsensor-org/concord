# Engine coverage ratchet

`npm run test:coverage --prefix coord` runs the authoritative serial
`scripts/test-runner.js` with Node's LCOV reporter in each identity-stripped
child. It reports line, branch and function coverage separately and writes a
machine-readable test report. A new uncovered production site fails the gate;
uncovered sites in the measured baseline remain visible as inherited debt.

The measured surface is JavaScript under `coord/scripts/**`. The collector and
its contract tests live under `coord/engine/scripts/` because new engine files
belong in that tree. The **complete** exclusion set, asserted by
`coord/engine/scripts/engine-coverage.test.js`, is:

- `**/*.test.js`
- `**/__fixtures__/**`
- `**/fixtures/**`
- `scripts/governance-test-utils.js`
- `scripts/session-lifecycle-test-utils.js`
- `scripts/business-context-pack-test-fixtures.js`
- `scripts/test-isolation-guard.js`

Every other production script is included in the census. A production script
that the suite never loads is reported as `unobserved` with its source digest;
changing it fails the ratchet even if it remains unloaded. The baselines live
in `coord/engine/scripts/` so packed distributions retain the same ratchet
input. Supported CI runtimes use separate measured files,
`engine-coverage-baseline-node22.json` and
`engine-coverage-baseline-node24.json`; other runtimes use the original
`engine-coverage-baseline.json`. Node's LCOV instrumentation and anonymous
function numbering differ across runtime lines, so comparing one runtime's
findings to another's produces false new-site failures. The runtime-specific
files record their measured Node version, source commit, and timestamp; the
runner refuses a missing or mismatched supported-lane baseline.
The supported lanes use identity version 3, which identifies anonymous
functions by their ordinal on the source line before merging module reports.
This avoids false new findings
when Node renumbers unrelated anonymous functions elsewhere in a file while
still distinguishing two functions on the same line. The original baseline
retains its version 1 identities until it is separately remeasured.
Each LCOV report resolves function hits against that report's own generated
names before anonymous functions are assigned line-local ordinals and merged
across test modules. A report with a conflicting count of anonymous functions
on the same line fails closed; LCOV lacks columns to safely match a partial
same-line function census. Branch identities use the count of *uncovered*
branches per source line. Covered LCOV block keys can vary between aggregate
runs and cannot relabel existing uncovered debt; another uncovered branch on
that line still fails the ratchet. LCOV cannot distinguish a same-count swap
of two branches on one source line. Raw V8 source ranges would be needed for
that finer identity; source-line text changes still create new identities.

Create or update a baseline only after a full aggregate run with
`node coord/scripts/test-runner.js --write-coverage-baseline` on its Node lane,
and review its measurements and uncovered sites before committing it. The
`governance-suite` workflow's manual `capture_coverage_baseline` input runs
that same command on both supported CI lanes and uploads the measured files
and complete run reports. The writer refuses to record a baseline when tests
or isolation checks fail. During the first capture, the built-cut baseline
check is explicitly skipped because its two lane files do not exist yet; it
must pass in the ordinary run after those captured files are committed. This
is a measured starting point, not an arbitrary
percentage floor. Normal runs use their saved lane baseline and fail on newly
uncovered sites. A source line's normalized text identifies line and branch
sites across unrelated line-number shifts.

Node's LCOV branch *census* can also depend on which paths execute: two full
runs with the same test inventory and unchanged code can emit different branch
keys and mark a previously covered site uncovered. A lane baseline may carry
an explicitly reviewed `unstable_findings` list for those exact identities.
The original `findings` array remains the unmodified capture snapshot. The
exception list is never expanded by a normal run; its `unstable_observations`
declare the two reviewed run reports, while `unstable_source_hashes` bind every
listed file to unchanged bytes. The runner checks the observation fields'
shape and source hashes, but does not download the external reports or verify
that the declared list equals their difference; that comparison is a manual
review requirement. It refuses the baseline if an exception file changes.
The ratchet reports the currently uncovered exceptions separately and still
fails for an unlisted finding identity, a changed source identity, or an
increased uncovered multiplicity on the same line. Same-count swaps between
branches on one line remain indistinguishable in LCOV, including inside this
exception list.
This is a measured, temporary exception to a one-run snapshot, with residual
coverage debt tracked in COORD-791. LCOV cannot prove that a listed site stays
covered in every later run; eliminating the exception requires deterministic
tests or stable source-range instrumentation.

The Community builder derives all three packed baselines from the complete donor
baselines by retaining findings and reviewed unstable identities only for files
shipped in that cut. Their
`cut_scope` field identifies this filtering. `totals` and
`production_file_count` remain donor measurement metadata and are informational
only; the runtime ratchet compares `findings` with a fresh measurement and does
not use those aggregate fields.

The report includes a concise `concord-coverage:` line and the full per-file
measurement, new uncovered findings, inherited uncovered count, exclusion
contract and baseline path. Its gate fields are checked by
`gate-artifact-schema.js`. A missing LCOV report, missing baseline or changed
exclusion contract fails closed.

Source-range (identity version 4) branch and function findings carry absolute
byte offsets. When an edit shifts them, the ratchet relocates each new finding
through unchanged source spans to the baseline row measured on the same bytes,
so an edit before or after a finding's range keeps its credit and an edit
inside that range (its owning function, for a branch) loses it. Line findings
relocate from the baseline's `source_commit` blob. A scoped splice of a moved
file's remeasured findings (COORD-864..868) records range offsets measured on a
later commit, so range relocation then anchors on the newest committed version of
the file since `source_commit` whose bytes reproduce every baseline range digest
recorded for it (COORD-881). Existing baselines need no regeneration; a file
whose findings no committed version reproduces keeps the `source_commit` anchor
and fails closed.
