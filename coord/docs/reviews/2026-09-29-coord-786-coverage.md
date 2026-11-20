# COORD-786 engine coverage review

## Clean-main reproduction

The pinned baseline was measured in commit `3dafd169` at
`2026-09-29T15:09:49.131Z`. It records 19,624 uncovered findings, but no Node
runtime provenance. Clean `main` commit `254e6d0a` ran the authoritative suite
in [governance-suite run 36629078875](https://github.com/Softsensor-org/coord-template/actions/runs/36629078875):

| Node lane | Tests | Test failures | New findings against pinned baseline |
| --- | ---: | ---: | ---: |
| 22.8 | 3,641 | 0 | 592 |
| 24 | 3,641 | 0 | 421 |

The FE-002 merge test report in
[run 36627133430](https://github.com/Softsensor-org/coord-template/actions/runs/36627133430)
had 3,640 tests and 0 test failures on both lanes, with 611 and 405 new
coverage findings respectively. The clean-main failure proves the frontend PR
did not introduce the engine coverage gate failure.

For clean main, 520 of the Node 22.8 new findings and 348 of the Node 24 new
findings are in production files whose source did not change after `3dafd169`.
The remaining 72 and 73 are in changed files; only 31 on each lane point to
added or changed source lines. Those 31 fall in four files:

| File | Added or changed line findings | Guard exercised by COORD-786 tests |
| --- | --- | --- |
| `scripts/auto-mode-containment.js` | 22, 24, 37-39, 47, 52 (two branches), 72 | Broken or unreadable paths deny writes; literal secret pattern is applied. |
| `scripts/business-discovery.js` | 86, 88, 955-958, 964-967 | Unresolved or unreadable destination and output-parent swap refuse writes. |
| `scripts/requirements-import.js` | branch at 89 | Valid explicit enum metadata survives import. |
| `scripts/runtime-cleanup.js` | 29, 30, 33, 112-113, 127-129, 133-135 | Invalid or absent remote count, pruned digest, and corrupt journal are checked. |

The site inventory comes from the uploaded JSON reports, keyed by the
collector's `file` and `message` fields, joined to `git diff --unified=0
3dafd169..254e6d0a -- coord/scripts`. A line in a changed file can retain its
old source text and still change execution after surrounding edits; the table
is a review queue, not a claim that every finding is a newly written statement.

## Measurement fault and repair

The original `functions` site key includes Node's global `anonymous_N` name.
In unchanged `scripts/agent-commands.js`, the old baseline and Node 24 run
both have 508 uncovered findings, yet nine anonymous function identities are
replaced by nine others. Line and branch instrumentation also differs between
Node 22.8 and Node 24. For example, the old baseline marks
`scripts/test-runner.js` unobserved; the Node 22.8 run measures it and flags
143 uncovered sites, while the Node 24 run still marks it unobserved.

COORD-786 uses a measured baseline for each supported Node lane and binds it
to the source commit, measured runtime, and identity version. Identity version
2 uses source-line-local ordinals for anonymous functions. A synthetic LCOV
test proves renumbering an unchanged anonymous function does not create debt
and making a covered same-line function uncovered still fails. The existing
real new-branch regression also remains red.

The first exact-lane baseline capture will run the full serial aggregate suite
with `--write-coverage-baseline`. It will explicitly skip the packed-cut check
only while the two lane files do not exist. Ordinary CI must execute that
check after the captured files are committed. The capture run reports, file
hashes, residual findings, and normal Node 22.8/24 CI verdict must be added
here before closeout.

## First capture refused and residual-site review

[Capture run 36637870391](https://github.com/Softsensor-org/coord-template/actions/runs/36637870391)
ran commit `dc4f065b70a38310bd5fa6a59ae00074f4944fe4` on Node 22.8.0 and
Node 24. Both lanes executed 3,665 tests: 3,659 passed, two failed, and four
were skipped. The baseline writer correctly refused to write either file. The
failed tests are independent of the COORD-786 collector changes:

- `doctor-recovery.test.js:389` still expects a worktree wildcard in
  `intended_files`. Commit `ee849569` intentionally moved that value to
  `scaffold_placeholders.intended_files` and left `intended_files` empty.
- `scaffold.test.js:837` copies a transient `coord/.agent-state.lock` symlink
  from the live checkout into its hand-built bundle. The installer correctly
  rejects the unsafe symlink. A two-file reproduction runs
  `feature-proof-reachability.test.js` first: its unsandboxed board identity
  read calls `ensureAgentFiles`, which publishes the live symlink. The test
  isolation guard does not currently intercept `fs.symlinkSync`.

The failed reports still contain complete measured findings. Against source
lines added or changed since `3dafd169`, Node 22.8 has 30 uncovered sites and
Node 24 has 16. The earlier 31-site queue in four files fell to seven and ten
respectively after the focused guard tests. Remaining paths are:

| Source | Node 22.8 | Node 24 | Attribution |
| --- | ---: | ---: | --- |
| `auto-mode-containment.js` | 4 | 4 | The root-exhaustion guard at line 24 requires filesystem fault injection. Protected-read and empty-network branches at lines 52 and 72 gained meaningful tests after this failed run and must be remeasured. |
| `business-discovery.js` | 1 | 1 | Line 88 is the terminal root-exhaustion guard; ordinary paths have an existing root ancestor. |
| `requirements-linkage-backfill.js` | 6 | 6 | Added in a separate landed ticket: root-exhaustion branch 232, protected-directory branch 265, and governed-mutation catch at 325-328. Review alongside its owning source change. |
| `runtime-cleanup.js` | 2 | 5 | Lines 112-113 depend on the live default runtime and a behind remote; the three extra Node 24 sites at 127-129 handle inconsistent or uninitialized snapshot evidence. |
| `test-runner.js` | 17 | 0 | Node 22.8 observes the runner when its contract tests import it, but the outer aggregate writer is not child-instrumented. Node 24 marks the same file unobserved. The positive full-suite writer path cannot be exercised by a focused child test. |

These are a review queue, not a refreshed baseline acceptance. The repaired
suite must run on a new frozen source commit; its exact lane reports will
determine the final exception rationale and follow-up links.

## Superseded identity-v2 capture and normal-run diagnosis

[Identity-v2 capture run 36648428343](https://github.com/Softsensor-org/coord-template/actions/runs/36648428343)
ran exact source commit `14c7a8c02d04cd099ddf2f9ba5aba9743271964d`.
Both authoritative Node jobs and the board, architecture, template-sync, and
engine-pin jobs passed. Each lane ran 3,670 tests: 3,667 passed, none failed,
and three skipped. Neither lane reported a governed-tree isolation violation.
The downloaded baseline `findings`, `totals`, exclusion list, and production
file count exactly match its own uploaded run report; both reports and
baselines record the same source SHA. The earlier successful
[capture 36644866107](https://github.com/Softsensor-org/coord-template/actions/runs/36644866107)
at `967205707c73da17d82fe12a6cb9741b5928a6ef` preceded the composition-root
diff-buffer fix. [Capture 36646748931](https://github.com/Softsensor-org/coord-template/actions/runs/36646748931)
at `70827de1a1e9e7cc78f50807461f802635f587c9` found one uncovered
COORD-786-owned default-roots branch at `arch-checks.js:1511`; a focused
large-artifact regression now covers it in both lanes. Those two captures are
historical evidence, not the committed baselines.

| Artifact | Runtime | Production files | Uncovered findings | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `engine-coverage-baseline-node22.json` | v22.8.0 | 269 | 18,953 | `51fc58bb094bee9bfac0b7df494f9f7df61b3fd2193ef6dffa97e7c4a7c16ae2` |
| `engine-coverage-baseline-node24.json` | v24.21.0 | 269 | 18,815 | `9f648d1eeac198bd4bbceccb03986ea0f5694efc9e8a7b67256835cfe8fa5cfd` |

Both files use identity version 2 and retain the exact seven-entry exclusion
contract. Compared with added or changed `coord/scripts` source lines since
`3dafd169`, 27 Node 22.8 and 13 Node 24 findings remain:

| Source and site | Node 22.8 | Node 24 | Review |
| --- | ---: | ---: | --- |
| `auto-mode-containment.js:24`, `business-discovery.js:88` | 2 | 2 | Terminal filesystem-root exhaustion guards require `lstat`/`exists` fault injection; an ordinary path always has an existing root ancestor. The output refusal and unreadable-path behavior have focused tests. |
| `requirements-linkage-backfill.js:232,265,325-328` | 6 | 6 | Landed separately after the original pinned baseline. Root exhaustion is defensive; protected-directory output and governed-mutation failure are meaningful coverage follow-ups for the backfill owner. |
| `runtime-cleanup.js:112-113,127-129` | 2 | 5 | Lines 112-113 depend on the installed default runtime and a verifiably behind remote; `remoteBehindReason` is tested with injected Git outcomes. Node 24 additionally marks the defensive inconsistent-snapshot branches at 127-129 uncovered. |
| `test-runner.js:504,507-508,611,722-750` | 17 | 0 | Node 22 observes the runner through imported contract tests, but the outer full-suite writer runs outside child LCOV instrumentation. Node 24 marks the runner unobserved. The negative writer guard and runtime-provenance selector have focused tests; a positive full-suite write cannot run as a focused child test. |

These measured sites were provisionally dispositioned as inherited starting
debt for the two lane baselines. COORD-791 (P2/X, depends on COORD-786)
tracks guarded-path tests and runner instrumentation without weakening the
ratchet. The backfill paths belong to the separately landed COORD-565 change;
their main apply/revert and symlink/hardlink guards are already tested, while
the six residual sites above are defensive/error outcomes. Any later newly
uncovered site must still fail the ratchet, including a deliberately uncovered
branch in either lane. However, the subsequent ordinary
[run 36650003371](https://github.com/Softsensor-org/coord-template/actions/runs/36650003371)
failed coverage in both lanes on unchanged source while all 3,670 tests still
passed or skipped and no isolation violation occurred. Node 22.8 reported 96
new findings (95 branches, one function); Node 24 reported 118 (107 branches,
four functions, seven lines). The old collector ranked uncovered BRDA sites
among all branch keys on a line, so covered-key churn relabeled inherited
uncovered sites. It also merged Node-generated anonymous function names from
separate module reports before normalizing them: local LCOV for the same
`business-discovery.js:205` callback calls it `anonymous_12` in one report and
`anonymous_11` in another. These become two false function sites when merged.
The seven Node 24 line findings are genuinely variable defensive-path
coverage on unchanged code; focused tests now exercise the unknown-agent and
worktree-pruning paths deterministically.

Identity version 3 ranks only uncovered branches on each source line and
normalizes anonymous callbacks per LCOV report before merging modules. A
conflicting count of same-line callbacks across reports refuses measurement.
Synthetic tests show that covered-key churn does not relabel inherited debt,
another uncovered branch still fails, and two real same-line callbacks remain
distinct. The two identity-v2 JSON files above are historical evidence and
must be replaced by measured version-3 artifacts and a passing ordinary run
before closeout.

The architecture ratchet passes after the capture-source changes. Its two
new advisory `duplication` findings are intentional mirror regions in
`examples/demo/coord/scripts/arch-checks.js` at lines 167 (16 lines) and 195
(35 lines), copied byte-for-byte from canonical `coord/scripts/arch-checks.js`.
The demo test copy is also byte-identical. The composition-root guard remains
enabled and reports zero findings; these warnings do not indicate demo drift.

## Measured identity-v3 lane baselines

[Capture run 36652456945](https://github.com/Softsensor-org/coord-template/actions/runs/36652456945)
passed every job at exact source commit
`7fce236c0dfe38a5f17f940d55239426295081a5`. Each authoritative lane
ran 3,678 tests: 3,674 passed, none failed, and four skipped (including the
explicit first-capture packed-cut deferral). No governed-tree isolation
violation or anonymous-function census conflict occurred. The downloaded
baseline findings, totals, exclusions, file count, source SHA, and Node
version exactly match each lane's full uploaded report.

| Committed artifact | Runtime | Production files | Uncovered findings | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `engine-coverage-baseline-node22.json` | v22.8.0 | 269 | 18,904 | `f70a9f5f0be06bfab286a53796f5f07b94974a525105fa5f5a85f8e076c4a9b5` |
| `engine-coverage-baseline-node24.json` | v24.21.0 | 269 | 18,815 | `5c342e6e9474f6701ba384b5d284f0956d29b7853edba12f87626fd2553dcb39` |

Both files use identity version 3 and the exact seven-entry exclusion
contract. Against changed source lines since `3dafd169`, 27 Node 22.8 and
10 Node 24 uncovered sites remain. Ten are shared: the terminal root guards
in `auto-mode-containment.js:24` and `business-discovery.js:88`, six
COORD-565 backfill defensive/error sites at `requirements-linkage-backfill.js`
lines 232, 265 and 325-328, and the installed-default-runtime/behind-remote
path at `runtime-cleanup.js:112-113`. The other 17 Node 22.8 sites are
`test-runner.js` writer/provenance paths at lines 504, 507-508, 611 and
722-750; the outer aggregate process is not child-instrumented. These are
explicit inherited starting debt under COORD-791, not new coverage thresholds
or exclusions. Focused tests cover reachable adjacent paths. A synthetic
same-line second uncovered branch still fails the version-3 ratchet, as does
a new production branch measured through Node LCOV. The first ordinary hosted
verdict is analyzed below.

## Ordinary identity-v3 failure and bounded LCOV variance

[Ordinary run 36653997114](https://github.com/Softsensor-org/coord-template/actions/runs/36653997114)
tested committed baselines at `26826a00f3145246daf817b8ef09334b2978309b`.
Board validation, architecture ratchets, and template sync/engine pin passed.
Both Node 22.8.0 and Node 24.21.0 ran 3,678 tests, 3,675 passed, zero failed,
and three skipped; the packed-cut test passed. Both authoritative suites failed
only coverage. Node 22.8 reported 47 new uncovered sites (37 branches, nine
lines, one function); Node 24 reported 42 (25 branches, 17 lines). No coverage
collector error or governed-tree isolation violation occurred.

The `7fce236c..26826a00` diff changes only the two baseline JSON files,
`TEMPLATE_SYNC_MANIFEST.json`, `engine-pin.json`, and this review document.
`coord/scripts` has identical Git tree object `a70849d781c03455c1b6fd4a6d6f04d405ca4e9a`
at both commits. Capture and ordinary reports have identical Node runtime,
seven-module execution order, environment, command list, and per-module test
counts, except the packed-cut test changes from explicit capture skip to pass.
Nevertheless, the measured branch census changed 26,054 to 26,069 in Node
22.8 and 25,974 to 25,966 in Node 24. `business-context-pack.js` alone changes
+8 and -8 respectively; `gates/review-closeout.js` changes -6 and +6.
Node's LCOV emits path-dependent branch keys for these suites, so a single-run
snapshot cannot distinguish every later newly unhit path from path-dependent
instrumentation. The reports themselves are immutable evidence:

| Lane | Capture report SHA-256, run 36652456945 | Ordinary report SHA-256, run 36653997114 |
| --- | --- | --- |
| Node 22.8.0 | `336a4e26b12caacb812c7c76223a5dd238468a0e9cfb20271eeba32f69fd04b1` | `d06a64c03005cdebac8484fca9c4d82bcdf61ed41c50dcfeb423cf7a5507397b` |
| Node 24.21.0 | `fa5c19d7db5e658698c87ea1ae045d3f26c03367f2b4f321ee87a634100e3129` | `1644c6e522edb7721611463d0678ecbf9eb8781ca4951709a5991f552e00d0fc` |

The repair keeps each captured `findings` array byte-for-byte measured. A
separate finite `unstable_findings` list may allow only identities observed
uncovered in the ordinary same-code run and still absent from the next exact
capture. Each entry names its source file and source-text identity; per-file
SHA-256 locks the exception to unchanged source bytes. The lane baseline
declares both run IDs, SHAs, runtimes and report hashes. Those observation
fields are reviewer-checked references, not independently verified by the
runtime; the final review must compare the downloaded reports to the list.
The ratchet reports the number of currently uncovered listed sites separately
and fails for an unlisted identity, changed exception source file, or
additional uncovered branch on the same line. A same-count swap between two
branches on one line remains indistinguishable in LCOV. COORD-791 owns the
remaining deterministic test or stable
source-range instrumentation work; the listed exception is not proof that a
listed path remains covered in every future run. A new full capture and an
ordinary hosted run are required before acceptance.

## Fresh capture and reviewed exception candidates

[Capture run 36656081387](https://github.com/Softsensor-org/coord-template/actions/runs/36656081387)
passed board, architecture, sync/pin, and both full Node lanes at exact
comparator source commit `89f23054b880e56218ddc07da7fbd75f6525c66d`.
Each lane ran 3,680 tests: 3,677 passed, zero failed and three skipped. The
downloaded baseline `findings` arrays exactly equal their uploaded run report
measurements; each has 269 production files, identity version 3, and the
seven-entry exclusion contract. No collector or isolation error occurred.

| Lane | Measured snapshot findings | Capture report SHA-256 | Reviewed historical-site exceptions |
| --- | ---: | --- | ---: |
| Node 22.8.0 | 18,918 | `54fe9e87293af0808f3522c650f5ee6bbd437862f38ecf0c85d27a6715c42c0c` | 45 in 17 unchanged files |
| Node 24.21.0 | 18,819 | `687665914d2b366084d60e7b1bcee7a563d97e18c93dbd506c6056a4f0386277` | 54 in 18 unchanged files |

The exception candidates are the exact `file`+`value` union of uncovered
findings in the prior capture 36652456945 and ordinary run 36653997114,
minus findings in the fresh capture. Their identity-list SHA-256 values are
`e56d6ef759ec218b4fad05bbc01dc49f4261a0d630215d054f789540515778ca`
for Node 22.8 and
`ad4b7e00142c5ebec416b455312b0aa50773d49270ec1c0d07aa4f3aca0efc99`
for Node 24. The only production source files changed among these three
commits are collector/runner implementation files, and the candidate list
excludes `scripts/test-runner.js` entirely: 12 old Node 22.8 identities and
one old Node 24 unobserved-file digest. The remaining candidates have exact
current-file SHA-256 entries in `unstable_source_hashes`; changing any one
file makes CI refuse the exception. The baseline retains the fresh capture
snapshot unmodified and declares all three run references. The two formal
`unstable_observations` entries name the fresh capture and old ordinary run;
`unstable_prior_capture` records the third prior capture for reviewer
reconciliation. These fields are external review references, not runtime
verification of GitHub artifacts. The changed runner's paths remain
ratchet-gated. The ordinary hosted verdict is below.

## Second ordinary run and disposition

[Ordinary run 36657493060](https://github.com/Softsensor-org/coord-template/actions/runs/36657493060)
tested the assembled files at exact commit
`2d31e8d033a9cb6528dfd9b90f7f0848eb85c754`. Board validation,
architecture ratchets, and template sync/engine pin passed. Both lanes ran
3,680 tests with three skipped. Node 22.8 had 3,677 passes and zero test
failures; Node 24 had 3,676 passes and one test failure. Both coverage
ratchets failed. The uploaded report SHA-256 values are
`da1ffe287552705aad0822af9bb84184478ed8d52202b26fd71d021705e4a630`
(Node 22.8) and
`97123f070b98664dd870746c6878a73444bc392a78d53169e90242a5f9623f7b`
(Node 24).

| Lane | New uncovered beyond reviewed list | Currently uncovered listed sites | Branch census capture to ordinary |
| --- | ---: | ---: | ---: |
| Node 22.8 | 25 in eight files | 10 | 26,089 to 26,091 |
| Node 24 | 2 in two files | 29 | 25,972 to 25,966 |

The 25 Node 22.8 findings are in unchanged source:
`arch-checks.js` (1), `control-plane-push.js` (1), `coord-upgrade.js` (1),
`engine-pin.js` (2), `enterprise/org-collector.js` (2),
`runtime-cleanup.js` (3), `upgrade-lock.js` (6), and `worktree-ops.js` (9).
Node 24 adds branches at `lifecycle-repox-closeout.js:52` and
`workspace-container-witness.js:146`. Neither lane has a new uncovered
`test-runner.js` finding. The code files are unchanged between the fresh
capture and this ordinary commit, yet fresh uncovered paths emerge beyond
the three-run list. Expanding that list again would not establish a stable
bound or preserve the intended zero-new-uncovered guarantee. Node's
path-dependent LCOV branch census and the test execution variance need a
separate stable-identity or deterministic-coverage repair before these
baselines can be accepted. The committed files are experimental evidence,
not a passing CI baseline, and COORD-786 must not land while this gate fails.

Node 24's one test failure is
`COORD-624: SEA refuses to install inside a product repository, exactly like npm`.
The refusal and exit-code assertions passed; `snapshotTree(repo)` before and
after differed only by an empty `.git/objects/maintenance.lock` file created
by Git's own auto-maintenance. The product `service.js` and all non-transient
entries were unchanged. This fixture should exclude that transient internal
Git lock from its no-write comparison while continuing to assert installer
refusal and preservation of product files. It is independent of the coverage
ratchet and needs its own test-only follow-up.

## V4 native-aggregation capture attempt

[Capture run 36874992344](https://github.com/Softsensor-org/coord-template/actions/runs/36874992344)
used source commit `0f2965fb722f0cab129c650c15b81bcd25428344`, after the
native raw-V8 aggregation and range-witness changes. Board validation,
architecture ratchets, and template sync/engine pin passed. The Node 24.21.0
suite completed with 3,714 tests (3,710 passed, zero failed, four skipped),
but coverage aggregation failed closed with
`native coverage aggregation: invalid raw source-range offsets`. Its uploaded
report SHA-256 is
`f9813e7b55eb9b92ba5ffa9eeacb29fae08e17746649676c5920ecef0e0484e9`.
The report records no coverage measurement, no source-fence violations, and
the baseline artifact upload was skipped. The original diagnostic identifies
only the range-validation class; that run did not retain raw V8 snapshots, so
it does not identify the file or range. This is not a measured v4 snapshot and
cannot be used for migration or acceptance. The next diagnostic run preserves
the exact per-module LCOV and raw snapshots only when coverage fails, alongside
the runtime, workspace, and source commit. Existing v3 findings and capture
history above remain unchanged. At this update, the Node 22.8 lane from the
same run is still executing; no result is inferred for it.

## V4 diagnostic reproduction and bounded scope correction

[Diagnostic capture run 36879487010](https://github.com/Softsensor-org/coord-template/actions/runs/36879487010)
used source commit `c020cc46d2433948cfeee6a20fd846c3f3e82371`. Its Node 24.21.0
lane completed 3,716 tests (3,712 passed, zero failed, four skipped), then
failed closed at merged native witnesses on
`frontend/apps/coord-ui/lib/board.ts`: the top-level anonymous-function range
ended at offset 6,782 while the on-disk TypeScript source was 6,676 UTF-16
units. The runner retained the per-module LCOV and raw V8 evidence under its
temporary diagnostic directory. The downloaded report SHA-256 is
`a806559611389d5e25bd444f90afa89cb3511d604a643a40775e648e936ca466`.

A serial local Node 24.21.0 reproduction at the same source commit completed
the same 3,716 tests with 3,712 passes, no test failures, and four skips. Its
coverage report SHA-256 is
`771b5a6cba5073cc670aa5cc5a45ed604ae66e9550d74f786aeca407510b0d3e`. A
previously cited supplementary scan (input root and manifest unavailable)
reports 56 invalid ranges across seven TypeScript files outside the measured
production-source census. These
files are loaded by UI tests using Node's `--experimental-strip-types` and
`coord/scripts/__fixtures__/typescript-ui-loader.mjs`; their V8 ranges refer
to transformed source, so checking those ranges against original TS bytes is
not valid. The scan output is `/tmp/coord786-v8-range-scan-final.json` with
SHA-256 `8b65de5bab2aa5df4097a9acf01937b4946d6f03324268de4067fa36cbf6a09a`.
The initial local reproduction pointed `RUNNER_TEMP` at a nonexistent path;
diagnostic retention consequently failed with `ENOENT` and the runner removed
the original raw directories. The runner now creates the requested root and,
if copying fails, preserves and reports the original raw paths instead.

A fresh scan is bound to the hosted Node 24 artifact and exact c020 Git tree.
Its input manifest is
/tmp/coord786-diagnostic-c020-node24-raw/coord-coverage-raw-IeHHlQ/manifest.json
(SHA-256 34c9384f2a38ea5d3fa21faca716ae996405255444e775b0876a874e60ce931f),
Node v24.21.0, source commit c020cc46d2433948cfeee6a20fd846c3f3e82371, tree
0913ae8706fca4887a4a678703d18ea81879000e. The scan report is
/tmp/coord786-hosted-c020-invalid-range-scan.json (SHA-256
f6b5f3b68bd6404292ecdc935ff91e4af1a55e8c2e6c29a3a8d2c0d818307f9d): it
examined 1,634 raw snapshots and 18,665 workspace source records, found 56
ranges extending past source EOF across seven frontend TypeScript files, and
found none in the 275-file production JavaScript census. This is consistent
with those TypeScript files being loaded through Node's --experimental-strip-types
and coord/scripts/__fixtures__/typescript-ui-loader.mjs. The raw offsets show a
source-mapping mismatch with the on-disk TypeScript bytes; they do not
establish the exact transformed source text. Four transient test-helper URLs
were absent from the c020 Git tree and skipped; they are outside the production
census. The ordered raw-input path/source digest is
de1afc0b1cebb9bab0e60c4766cd1237dbb0ee455b9a359537a26e71ea187854.

The bounded correction passes the exact production-file census already used
by the source-change fence into witness construction. LCOV replay and native
aggregation still include every module/file; only raw-source witness
validation skips files outside that explicit census. Paths are validated
against the workspace, and every observed production file still needs a
witness when `measure()` runs. No Concord production-census exclusion policy
changed; the Node child arguments explicitly change the raw reporter's default
exclusions. There is no general relaxation of range bounds. Focused Node 22.8
and 24.21 tests cover
the donor and packed path layouts, transformed out-of-census TS-like data,
rejection of malformed in-census ranges, and the existing opposite-arm
branch identity checks. At the time of the initial failure investigation,
this correction had not yet been established by a full-run capture; the final
capture and migration result are recorded below.

A separate bounded Node 22.8 performance probe used 30 sampled file URLs from
the retained raw artifact and its 423 native include patterns, with each URL
repeated twice. A per-`TestCoverage`-instance URL decision cache reduced that
probe from 568.718 ms to 245.082 ms with identical filter booleans. The worker caches
only the first result from the instance's bound native filter; separate
coverage instances cannot share decisions, so their include options and
working directories remain independent. This is an optimization of repeated
native filter calls, not a claim about the cause of hosted lane duration or a
change to the file set, LCOV counters, or branch identity.

## Native coverage inclusion correction and v4 migration

The Node 24.21.0 capture at `bf98c0ae30f6666edbde2d432df03c332f62a755`
completed 3,719 tests (3,715 passed, zero failed, four skipped) and emitted a
v4 measurement, but its production census still listed `coord/scripts/test-runner.js`
as unobserved. A bounded native CLI fixture confirmed Node's default coverage
exclude pattern drops this production file because its basename starts with
`test-`; explicitly excluding `**/*.test.js` retains the production runner and
excludes test files, matching the engine production census. The authoritative
runner now shares that explicit argument with the regression fixture. No
Concord production-census exclusion policy or baseline entry was changed.

Focused verification of the runner argument and witness guards at pushed
commit 156a3914 passed on Node 22.8.0 and Node 24.21.0:
`engine-coverage.test.js` 26/26 and
`test-runner.test.js` 38 passed, zero failed, one expected unsupported-runtime
skip on each runtime. The fixture verifies native LCOV contains
`coord/scripts/test-runner.js` and omits a `.test.js` fixture. Additional
negative cases cover missing raw witnesses, function/branch census mismatches,
missing and non-file witness paths, an unavailable native coverage filter, and
the aggregator's required witness-census argument.
The native report also includes a `test/inside.js` suite and its fixture helper;
the production measurement totals stay identical when those out-of-census
records are removed, and remain unchanged when an in-tree `scripts/__fixtures__`
record is added. This confirms the existing production census and fixture
exclusion contract remains the measurement boundary.
After capture dispatch, a direct negative assertion for the wrapper's missing
witness-census argument was added; the updated engine test passes 27/27 on both
supported runtimes. The running capture remains bound to immutable source
156a3914 and does not include this follow-up assertion.
The final hosted capture at immutable source `156a3914fa4ac83a07c6cd1b70c7a3d1193bebb4`
completed successfully on Node 22.8.0 and Node 24.21.0 (run
[36887511305](https://github.com/Softsensor-org/coord-template/actions/runs/36887511305)).
Each lane ran 3,722 tests: 3,718 passed, zero failed, and four skipped. Both
reported the same 275-file production census, the same declared exclusions,
and the same three pre-existing unobserved legacy files (their exact paths
are retained only in the governed plan evidence). The production runner was
observed in both lanes. Node 22.8 totals were lines 99,480/88,208, branches
25,367/19,036, and functions 6,344/5,543. Node 24.21 totals were lines
99,480/88,207, branches 25,409/19,024, and functions 6,344/5,543.

The lane baselines were installed from the exact reports without rewriting
findings: Node 22.8 baseline SHA-256
`bd397381328d19fd0a9cde697526392c30c8b4a761944d8a78ad260456a3487b`, and
Node 24.21 baseline SHA-256
`c5a640c9d4ffdda213e7c37d005d77d7861852313c799a6d250e2b60ea1167b5`.
Both record source commit `156a3914fa4ac83a07c6cd1b70c7a3d1193bebb4`, identity
format `raw-v8-source-range-v1`, 275 production files, and findings/totals
byte-for-byte equal to their lane measurement. The v3 baseline identity is
incompatible with v4 and was replaced only through these reviewed full-lane
captures; v3 finding identities were not mapped or silently relabeled. The
follow-up missing-census assertion and this evidence update were added after
the immutable capture; production source is unchanged, and the focused engine
test now passes 27/27 on each supported runtime. Baseline source provenance
therefore remains 156a by design.

The capture does not claim every defensive coverage error path is exercised.
The successful top-level qualification run proves the orchestration success
path; new helper and runner error-handling branches remain measured debt and
receive no synthetic coverage credit. Ordinary CI on the final commit is still
required to validate the installed baselines and follow-up test.
