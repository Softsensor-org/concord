# COORD-1046: release-edge gate runners, end-to-end evidence

Scope: execute both promotion-manifest edges against a real candidate commit and preserve each gate's result and duration. This is local evidence only; it does not publish, tag, push, or create a donor branch.

## Candidate and run

- Base: `origin/dev` at `eba12e96`.
- Candidate commit: `436d4504b1eaa820f3da39207c06a554712ce59e`
- Candidate tree: `fa88a09cc89820b8529cce069434dcad5091eec9`
- Runtime: Node `v22.8.0`; gate lane `node22`.
- The candidate includes the runner fixes for per-gate `duration_ms` reporting and structured dependency/refusal results. Duration stays in producer run reports; the promotion-manifest schema is unchanged. A missing dependent artifact remains fail/refused/not-run, never a pass.
- The producers wrote manifests for `main->concordrelease` and `main->enterprise-release`. Both manifests record policy SHA-256 `c8483915ecb7dcbe6c6249704f65938d96a615dde3229afc401d5423f8d509c2` and all gates red.
- Producer commands:
  - `coord/scripts/gov test-policy promotion-manifest --edge 'main->concordrelease' --commit 436d4504b1eaa820f3da39207c06a554712ce59e --out /tmp/COORD-1046-main-concordrelease.json`
  - `coord/scripts/gov test-policy promotion-manifest --edge 'main->enterprise-release' --commit 436d4504b1eaa820f3da39207c06a554712ce59e --out /tmp/COORD-1046-main-enterprise-release.json`
- Community producer: `/tmp/COORD-1046-community-producer.log`; manifest `/tmp/COORD-1046-main-concordrelease.json`.
- Enterprise producer: `/tmp/COORD-1046-enterprise-producer.log`; manifest `/tmp/COORD-1046-main-enterprise-release.json`.
- Preserved build and status reports: `/tmp/COORD-1046-evidence/436d4504b1eaa820f3da39207c06a554712ce59e/`.
- Per-gate step reports: `/tmp/COORD-1046-step-reports/`.

## Gate results

| Promotion edge | Gate | Result | Duration | Evidence |
|---|---|---:|---:|---|
| main → concordrelease | community-cut-build | fail | 1,819,470.657 ms | Community cut build exited 1; governance suite hit its 1,800 s timeout. |
| main → concordrelease | donor-hygiene-scan | fail | 57.141 ms | Not run because the Community cut did not build. |
| main → concordrelease | release-secret-scan | fail | 39.808 ms | Not run because the Community cut did not build. |
| main → concordrelease | dual-release-verify | fail | 170.786 ms | Preflight refused: donor branch `concordrelease` was absent. |
| main → concordrelease | install-canaries-npm-sea | fail | 40.933 ms | Not run because the Community cut did not build. |
| main → enterprise-release | enterprise-cut-build | fail | 1,828,023.898 ms | Enterprise cut build exited 1; governance suite hit its 1,800 s timeout. |
| main → enterprise-release | enterprise-qualification | fail | 213.120 ms | Not run because the Enterprise cut did not build. |
| main → enterprise-release | enterprise-ref-scan | fail | 37.489 ms | Not run because the Community cut did not build. |

Result: 0 of 8 gates passed. Both cut builds failed; dependent scans and qualification did not run. The manifests were produced with every gate marked `fail`; promotion therefore refuses both edges.

## Cut-build findings

The Community build log reports 16 named governance-suite failures and a timeout after 1,800 seconds. The named cases include COORD-855 closeout, COORD-975 guard-merge, COORD-835 packet-bound reconcile, COORD-662 prompt registration, COORD-956 retired-guard checks, COORD-712 process-lane recovery, COORD-852 mutation anchors, COORD-857 mutation sampling, COORD-936 shipped policy, COORD-916 concurrent path runs, COORD-895 branch literals, COORD-955 documentation paths, and release-runner wiring/scan cases. Its runner summary reports 287 passing tests and 3 skipped, while the aggregate marks the module failed; this is not a green suite.

The Enterprise build log reports 20 named governance-suite failures and a timeout after 1,800 seconds. It includes the COORD-855, COORD-975, COORD-835, COORD-662, COORD-956, COORD-712, COORD-852, COORD-857, and COORD-936 cases, along with COORD-924, COORD-066, COORD-702, COORD-645-F3 and the release-runner wiring/scan cases. Its runner summary reports 480 passing tests and 4 skipped, while the aggregate marks the module failed. Other cut hygiene checks in the same build passed, including package checks, module graph, template sync, engine pin, public scan, claims, bootstrap, retired-init, demo runtime and public README.

The direct-impact radius run selected 78 of 443 suites (17.6%) and reported 1,713 passed, 6 failed, 0 skipped. The six failures were two COORD-066 closeout seams, three COORD-855 closeout cases, and one COORD-723 considered-field case. Evidence: `/tmp/COORD-1046-radius.log` and the run log path recorded there. This smaller radius is also red and does not replace the full edge runs.

## Refusal and non-observation record

- The step report records `published-asset install` as refused with `requires published release assets; local-only verification does not publish`. This was observed in cached step-report reinspection only; no live published asset was fetched or installed.
- SEA did not run as a producer gate because the Community cut failed first. Unit tests in the cut logs exercise refusal behavior for registry-dependent SEA work, but that is not evidence of an end-to-end SEA gate run.
- `dual-release-verify` stopped at its missing `concordrelease` donor-branch preflight; it did not verify both release branches.
- No release was published, and no tag, push, or donor branch was created by this local run.

## Earlier run retained for comparison

An earlier end-to-end attempt used `origin/dev` `44747f6772b44ffe2a7ac6cce5283470d329a3a3`. It also had 0 of 8 gates pass: the Community and Enterprise cut builds failed their hygiene suites, and `dual-release-verify` refused because `concordrelease` was absent. That run predates this candidate's runner changes; this historical summary replaces its disposable build cache. The current candidate run above is the evidence for the producer fixes.

## Runner change exercised by this candidate

The runner launches gates in detached process groups, terminates the group at timeout, and spills output to files so grandchildren cannot hold a pipe open past the deadline. It also records each gate's measured duration without changing the manifest schema, and reports prerequisite-dependent gates honestly. Focused `defaultExec` tests passed on Node 22.8.0 and Node 24.22.1. These focused results do not turn the two failed end-to-end cut builds into passes.
