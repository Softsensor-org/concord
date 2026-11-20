# Concord engine boundary

`coord/engine/` is the template-managed governance engine tree. New
engine-canonical files land here from the day they are created. The tree is
upgraded and synced as one unit; downstream projects must not hand-edit it.

During the COORD-514..516 migration, `coord/paths.js` resolves an engine
relative module from `coord/engine/<path>` or its legacy `coord/<path>`
location. Byte-identical copies resolve to the canonical engine path;
divergent copies are an error. Project configuration and state remain outside
this tree and are supplied through the validated `ProjectContext` seam
defined by ADR 0013.

## Gate configuration migration

COORD-587 makes the gate policy, affected-target map, and affected-target
schema under `engine/gates/` canonical. The legacy `coord/gates/` JSON files
remain byte-identical compatibility copies while existing direct-path callers
are migrated. Engine defaults use `resolveEngineModule()`; caller-supplied
policy and map paths remain supported as project overrides. Remove the legacy
copies only after a later COORD-515 phase verifies that no supported consumer
depends on those paths.

## Engine coverage identity v4

The authoritative coverage runner keeps Node's LCOV line, branch and function
metrics, but first combines each module's raw V8 snapshots with the same
Node runtime's native `TestCoverage` merger and then emits one aggregate LCOV
report. Source-range witnesses only identify findings; they do not replace the
LCOV metrics. The adapter supports Node 22.x and 24.x. Each lane's baseline
provenance must name the exact Node runtime, source commit, `raw-v8-source-range-v1`
identity format and `node-testcoverage-native-v1` aggregation format.

Version 4 binds uncovered branch and function findings to their emitted LCOV
site and the owning V8 source range, including source-slice hashes. Absolute
source offsets make this identity fail closed when bytes are inserted before
an unchanged uncovered site: the site receives a new key and may be reported
as new debt. This is deliberate conservative baseline churn, not a reason to
add an exception or relax the ratchet.

Existing version-3 lane baselines are intentionally refused by the v4 ratchet.
Remeasure each supported lane with the complete suite using
`node coord/scripts/test-runner.js --write-coverage-baseline`, review the exact
source commit, report and new-code findings, then install an approved v4
measurement. A capture command only records what ran; it does not decide that
new or uncovered production code is acceptable. Version 4 also retires the
v3 `unstable_findings` exception envelope; do not carry those entries forward.

The production census and source-integrity fence include both legacy
`coord/scripts/` modules and canonical `coord/engine/scripts/` modules. A
legacy/canonical duplicate path fails closed. New canonical engine helpers
must remain measured and covered by meaningful tests; discovery, engine pin,
and the coverage ratchet must all include them.

## Engine documentation

Reusable operating guides and engine contracts live in `coord/engine/docs/`. Legacy `coord/docs/<guide>` paths are short compatibility redirects; consumers and new links should target the engine copy. Project decisions, evidence, dated reviews, and project-specific design records remain in `coord/docs/`.
