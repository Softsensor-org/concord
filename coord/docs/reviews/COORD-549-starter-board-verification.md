# COORD-549 fresh-board verification

## Finding and attribution

The original defect was real: before the starter-ladder change, a fresh board
contained `SETUP-001` and a fictional `SAMPLE-001` backend feature with the text
“Example backend ticket. Replace with your first real unit of work.” Commit
`1a5ca721f3b637d50e86ab8dedf31c15c8be0979` (“Ship governed starter adoption
ladder”, 2026-09-23) removed that row and replaced it with SETUP-001..009.
The commit also added the fresh-init row/prompt assertions in
`coord/scripts/coord-cli.test.js`. This is the source change that satisfies the
no-fictional-work policy; no new sample opt-in is needed when the default is
already free of examples.

`coord/scripts/coord-init-starter-board.js` is the single board/prompt source
used by both `coord/scripts/coord-init.js` and Community release clean-board
generation (`release/build-public-release.sh`, step 6). The nine rows all use
Repo X and describe configuration, knowledge, discovery, backlog, gates, ADRs,
requirements, coverage, and readiness work. The registered SETUP prompts carry
assignments and acceptance steps. `coord/product/STARTER_ADOPTION_LADDER.md`
documents these as the intended onboarding ladder and explicitly excludes
sample/product tickets.

## Evidence

- Source under test: donor HEAD `af9b87529a0277549555a2dd785aee77f2287e69`.
- Focused command: `env -u COORD_SESSION_ID node --test coord/scripts/coord-cli.test.js`
  on Node `v25.8.1`; result: 34 passed, 0 failed. Existing exact-ID assertions
  already require SETUP-001..009 and therefore reject an extra SAMPLE row; the
  init test also confirms all nine prompt files are created. No test change was
  needed.
- Community cut command in a clean disposable clone:
  `bash release/build-public-release.sh <temporary-cut-directory>`.
  The cut was generated from donor SHA above as commit
  `254e4755192eae56765b438f34d421b947a9ee43`; `board.js validate` reported 9 tickets. Direct inspection found
  exactly SETUP-001..009, every row in Repo X, all nine SETUP prompts, no
  `SAMPLE-` ID, and no fictional example description. SHA-256:
  - `coord/board/tasks.json`: `a61d57d858afafb2af8d0e09be65ce0843b3361cfcd8cd9fc0c84f7d14d20804`
  - `coord/scripts/coord-init-starter-board.js`: `84580dd500445fa2be237faf449aec004759079916d9aaa47c8fd2f735a9a60f`
  - `coord/prompts/tickets/SETUP-001.md`:
    `3259cf427f2fa3049d8fb640f9d7a0405fda1b6f4fd84b81d63074834947f280`

## Release and package evidence

The first clean release run used Node `v25.8.1` and correctly stopped at the
aggregate governance gate: 3,593 tests, 3,569 pass, 1 fail, 23 skipped. Its sole
failure was `COORD-800 runner joins native coverage to the immutable baseline
source provider` (`coord/scripts/test-runner.test.js:667`), which expected
status 0 but received 2. `test-runner.js:585-613` supports native coverage only
on Node 22.x and 24.x; the COORD-800 fixture does not skip unsupported majors,
while the adjacent COORD-786 native fixture does. This is a separate test/runtime
compatibility issue. The aggregate was not overridden by an isolated rerun.

A fresh full release pipeline
(`release/build-release-artifacts.sh --out-root <temporary-output> --skip-binary`)
on supported Node `v22.19.0` passed all 12/12 Community hygiene checks. The
governance aggregate reported 3,593 tests, 3,573
pass, 0 fail, and 20 skipped. The cut came from donor SHA
`af9b87529a0277549555a2dd785aee77f2287e69`, with cut commit
`15ba56a9630f904c666bde629d553259bd950eb2`; its attestation records
`hygiene_gate=pass` and tree `db0dc0d82b1eee67722b971d69ed2ffec65733d3`.

The supported pipeline staged the Community `create-concord` 0.1.16 package
from that cut (template payload digest
`d4f339e468e4e8973bf5cae7350e0f0e3a7fe9694c3f53830aca0f6352c2ecd4`).
Inspection of the staged `template/` found exactly SETUP-001..009,
all in Repo X, all nine prompts, and no SAMPLE ID or example description. The
board and builder hashes match the cut hashes above. Pre-pack validation then
stopped because `lib/install-plan.js` could not load
`../../coord/project-owned-state.js`; the supported pipeline therefore did not
produce a tarball. This package-composition defect is tracked separately under
COORD-732. Staged template contents verify the board policy, but this is not
packed-artifact or installer execution evidence.

## Actual packed-artifact content verification

On 2026-10-05, the parent independently installed the retained genuine
`create-concord-0.1.16.tgz` into a new disposable prefix using
`npm install --offline --ignore-scripts --no-audit --no-fund --registry http://127.0.0.1:9 <tarball>`.
The tarball SHA-256 is
`a1cb8696bdfe7a1f47b700f811841626193cd23d0d5d802638d73b021e74f90b`.
Its embedded stamp attributes clean donor
`df50fcb802f2a09972a7c67475731ff9321bf668`, Community cut tree
`18063d007b06095a3a546b79ca43bd8544e8afe1`, passing hygiene gate, and
payload digest `4fdfed028096e97887addf0a6ee9d7e829a25fc24b57751598d7db11ae473250`.

Using exact Node v22.8.0, the installed CLI generated a fresh default workspace
plan and applied its reviewed digest
`7d8b797bbad150e9b2ade4419da1a071c80175d76afbc981218fa1af2d653681`.
The executed commands (with the absolute paths retained by the check) were:

```sh
node <offline-prefix>/node_modules/create-concord/bin/create-concord.js <fresh-workspace> --dry-run
node <offline-prefix>/node_modules/create-concord/bin/create-concord.js <fresh-workspace> --apply-plan 7d8b797bbad150e9b2ade4419da1a071c80175d76afbc981218fa1af2d653681
```

The resulting board contained exactly SETUP-001..009, all Repo X, no SAMPLE
ID and no fictional backend description. All nine generated prompt files
matched the packaged canonical builder byte for byte. Their assignments are
configuration, knowledge baseline, source-backed discovery, founding backlog,
real repository gates, ADRs, requirement links, test maturity, and readiness
handoff. These are actual generic adoption tasks consistent with
`coord/product/STARTER_ADOPTION_LADDER.md`.

The reproducible check script is `/tmp/COORD-549-packed-board-check.py`;
command outputs, generated workspace and structured provenance remain under
`/tmp/COORD-549-packed-board-check/`, with the result in `result.json`.
This check intentionally requests no Git initialization and makes no claim
about first governed workflow acceptance. The original build's later syntax
and Git-staging failures remain COORD-732 evidence. Passing board inspection
does not override those failed full-workflow attempts.

The current documentation worktree also passed all 34 donor init tests on
exact Node v22.8.0 (`/tmp/COORD-549-final-worktree-node228.log`). An independent
Luna review checked the actual recorded tarball identity, verification script,
logs and scope distinction, and requested the explicit command forms above.

## Outcome

Donor tests and actual packed installation satisfy the bounded no-example
board/prompt policy. The README now accurately describes SETUP-001..009.
The original behavior fix remains attributed to `1a5ca721`; this ticket adds
documentation and verification only. COORD-732 retains full installer/runtime
and current combined-artifact qualification; COORD-806 retains the Node25
fixture compatibility fix.
