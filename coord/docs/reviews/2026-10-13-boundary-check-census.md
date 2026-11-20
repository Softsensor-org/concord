# COORD-679 boundary-check census

Read-only implementation census against prompt `coord/prompts/tickets/COORD-679.md` at immutable source commit `9435422dfb326700d70ed2ca5131d3e5481c526b` (`fix: audit coord-ui nested dependencies (#154)`). The prompt and enumerated source files match the preceding inspected source fingerprint `7183da97ae914b81d64307b8ff22e98aaeb3a9aa`; exact hashes are recorded in the report. The census makes no product-code changes; probes used disposable `/tmp` fixtures. Findings were filed through governance as separate related tickets. The prompt requires an exhaustive gate inventory and separation of content assertions from structural checks; a check should not be called defective merely because it validates structure.

## Confirmed findings and policy boundary

| Surface | Exact implementation / observed contract | Classification | Disposition |
|---|---|---|---|
| Ticket prompt generation/coverage | `coord/scripts/prompt-coverage.js:96-132` generates a generic prompt with Acceptance “Ticket scope is implemented”, focused verification recorded, and TODO Likely Files/Verification. `:179-193` accepts an existing mapping/waiver or checks only the default path is a file. `coord/board/board.js:1063-1070` checks prompt existence. | structural-only | Concrete content gap: generated acceptance does not express ticket-specific acceptance; coverage cannot detect generic/placeholder content. Filed `COORD-813` (`PROMPT-CONTENT`) below for generation + coverage contract (including unreadable prompt handling), not two tickets. COORD-350 covers atomic creation/registration, not content. COORD-678 is separate derived-view validation. No matching open ticket found in examined board rows. |
| Start baseline evidence | `coord/scripts/gates/readiness.js:124-130,296-302` requires `^Command:` and `^Outcome:` in test/contract/infra evidence; `coord/board/plan.schema.json:87-90` only requires strings. | structural-only | Empty values such as `Command:` and `Outcome:` satisfy the prefix check. Filed `COORD-814` (`BASELINE-EVIDENCE`) below should require nonempty evidence or an explicit `not-required` contract. COORD-713 concerns stale gate evidence correction, not evidence presence/quality. |
| Public reference scanners | `release/check-public-release.sh:360-388` treats client scanner output as findings but runs it with `\|\| true`; donor scanner checks status. Scanner probes below show underlying utilities can fail and still return clean. | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`) below: fail closed on scanner execution errors and propagate `find`/`grep` failures. COORD-752 tests leak detection, not scanner command failure; COORD-613 fixes README transformed-content checks and is not this. |
| Governance suite inventory | `release/check-public-release.sh:177-270` runs `coord/scripts/test-runner.js --report` and accepts process exit 0. Runner rejects zero discovered tests (`test-runner.js:673`) and prints counts (`:996-1001`), but release check does not assert expected count/skip policy. | structural-only | Filed `COORD-816` (`SUITE-INVENTORY`) below addresses the seeded prompt concern. Do not use a raw count floor across editions; establish tier-specific inventory and permitted skips. COORD-701 addresses Node 22 failures/release attribution, not suite drift. |
| Architecture corpus completeness | `coord/scripts/arch-checks.js:1421-1425` catches `fs.readdirSync` errors and returns; `:1445-1453` catches `fs.readFileSync` errors and substitutes empty source. An absent `--root` reproduces exit 0 with `arch: pass files=0 findings=0`. | structural-only | Filed `COORD-817` (`ARCH-CORPUS-FAIL-CLOSED`): fail for missing/unreadable requested root or in-scope corpus. Preserve and explicitly test any supported empty-root contract. Live duplicate lookup found no matching open ticket before COORD-817 was filed. |
| Lock heartbeat | `coord/scripts/governance-repair.js:207-210` and `coord/board/board.js:847-853` apply 24-hour freshness (`governance-constants.js:12`). | structural-only | Freshness is not proof of live work: non-governance work may not refresh it; stale does not establish dead owner. Exemption from a defect claim: the current check is explicitly freshness, not proof of liveness; no defect is filed until policy defines and evidence demonstrates a missing liveness contract. ADR-0005 governs; do not restore legacy session binding. |

## Disposable failure probes

Commands used temporary PATH shims and empty temporary artifacts; no product files or canonical state were modified.

1. `find` shim exits 7; `bash release/scan-client-refs.sh <empty-temp-artifact>` returned exit 0 with zero stdout/stderr bytes. Thus scan failure can become “no client refs”.
2. `grep` shim exits 7; `bash release/scan-donor-refs.sh <empty-temp-artifact>` returned exit 0 and `✓ donor-ref scan clean (no donor-only paths/docs/framing)`. Thus grep failure can become a clean donor scan.

These are concrete failure-mode reproductions, not a full release qualification. Reproduce both without modifying product files by creating disposable `find`/`grep` shims ahead of the normal `PATH`:

```sh
set -eu
probe=$(mktemp -d)
mkdir -p "$probe/bin" "$probe/artifact"
printf '#!/bin/sh\nexit 7\n' > "$probe/bin/find"
chmod +x "$probe/bin/find"
set +e
client_out=$(PATH="$probe/bin:$PATH" bash release/scan-client-refs.sh "$probe/artifact" 2>"$probe/client.err")
client_status=$?
set -e
printf 'client_status=%s stdout_bytes=%s\n' "$client_status" "${#client_out}"
printf '#!/bin/sh\nexit 7\n' > "$probe/bin/grep"
chmod +x "$probe/bin/grep"
set +e
donor_out=$(PATH="$probe/bin:$PATH" bash release/scan-donor-refs.sh "$probe/artifact" 2>"$probe/donor.err")
donor_status=$?
set -e
printf 'donor_status=%s stdout=%s\n' "$donor_status" "$donor_out"
rm -rf "$probe"
```

On the pinned source, expected observations are client exit 0 with empty stdout and donor exit 0 with its “scan clean” line. This exercises tool failure suppression, not detection of a real leaked reference.

## Existing ownership / exclusions checked

- COORD-677 done: standalone engine-pin release check.
- COORD-678 in progress: derived-view/drift detection; not ticket-specific prompt semantics.
- COORD-687 done: composition/runtime regression; integration coverage at `coord/board/board.test.js:1564,1584`.
- COORD-701 done: Node 22 failures and release gate attribution; does not establish test inventory baseline.
- COORD-705 done: coverage measurement false-green; no duplicate.
- COORD-752 done: client-ref leak detection; no scanner execution-failure case found.
- COORD-802 done: empty package inventory explicitly valid; no duplicate.
- COORD-350: prompt creation/registration atomicity, not generated prompt content.
- COORD-613: README transformed content; not reference scanner failures.
- COORD-713: append-only correction of stale repo gate/verification values; not baseline evidence existence or prompt-body acceptance.

## Finding disposition and limits

The five findings were checked against the live board and filed as separate related tickets: `COORD-813` (PROMPT-CONTENT), `COORD-814` (BASELINE-EVIDENCE), `COORD-815` (SCAN-FAIL-CLOSED), `COORD-816` (SUITE-INVENTORY), `COORD-817` (ARCH-CORPUS-FAIL-CLOSED). They do not block the census or release chain by dependency. COORD-679 remains P2 and changes no gate implementation. Lock-heartbeat freshness is an intentional structural check under ADR-0005 and carries a reasoned exemption.

The missing-root architecture probe demonstrates a concrete corpus failure; unreadable-file behavior is additionally source-inspected and delegated to COORD-817 for portable failure tests. No unsupported chmod/EACCES execution claim is made. This document is an implementation census, not release or deployment qualification.

## Authoritative gate-by-gate inventory with quoted pass conditions

This is the sole authoritative per-gate inventory; earlier grouped inventories were removed to avoid conflicting classifications. “Gate” means an explicit decision point, not every helper called by that decision. Every row uses exactly one class: `content-checked`, `structural-only`, or `not-applicable`. Structural-only rows either explain the intentional exemption or point to a filed follow-up below. The census baseline is immutable commit `9435422dfb326700d70ed2ca5131d3e5481c526b`; COORD-678 execution probes ran separately in `coord/.worktrees/codexa759/COORD-678` and are attributed only to their recorded source hashes/logs. Do not attribute that isolated dirty diff to the baseline checkout. Quoted tokens are source excerpts. Explicit `...` omissions and noted line-break removal abbreviate longer expressions; they do not add conditions.

### Public-release `CHECKS` and release shell gate functions

| Gate / source | Quoted pass condition | Class | Structural disposition |
|---|---|---|---|
| Dispatch, `release/check-public-release.sh:76,84-95` | `CHECKS=(board governance package module_graph template_sync engine_pin public_scan claims bootstrap retired_init demo_runtime public_readme)`; unknown names fail with `exit 2`; empty selection fails with `exit 2`. | not-applicable | The gate-selection contract is command routing; it is not intended to assert artifact content. The selected artifact checks are inventoried below. |
| `board`, `:104-113` | `if out="$(node "$ART/coord/board/board.js" validate 2>&1)"; then` | content-checked | Delegate validates actual artifact state. |
| `engine_pin`, `:116-139` | `if (report.pinned !== true \|\| report.ok !== true) { ... process.exitCode = 1; }` | content-checked | COORD-677 owns this shipped gate; do not refile. |
| `governance`, `:177-279` | `if [ "$status" -eq 0 ]; then ... return 0` | structural-only | Filed `COORD-816` (`SUITE-INVENTORY`): tier-aware expected suite inventory and explicit skip policy; exit-zero alone cannot distinguish legitimate pruning from lost coverage. Do not compare raw counts across editions; COORD-701 is not this acceptance. |
| `package`, `:280-349` | `if report="$(find "$ART" -name package.json ... -print0 ...)"; then` plus per package JSON parse and contained `main`/`bin` checks; `An empty inventory means zero declarations checked, not release readiness.` | content-checked | An empty inventory is explicitly allowed; COORD-802 test `release/check-public-release.test.js:367-379` asserts exit 0 and 0 packages. No package declaration is a valid case. |
| `template_sync`, `:350-359` | `if out="$(cd "$ART" && bash coord/scripts/check-template-sync.sh 2>&1)"; then` | content-checked | Delegate compares source/template content. |
| `public_scan`, `:360-388` secrets | `if ! "$DONOR/release/scan-secrets.sh" "$ART" >/dev/null 2>&1; then fail=1` | content-checked | Scanner exit failure blocks. |
| `public_scan`, `:360-388` client refs | `client="$("$DONOR/release/scan-client-refs.sh" "$ART" \|\| true)"` then `if [ -n "$client" ]; then fail=1` | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`): nonzero scan status with empty output is treated clean; require scanner success separately from zero findings. Reproduced by `find` exit-7 shim in a disposable fixture. |
| `public_scan`, `:360-388` office/binary | `if find "$ART" ... 2>/dev/null \| grep -q .; then fail=1` | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`): `find`/`grep` errors can be hidden by pipeline status; make enumeration errors fail closed. |
| `public_scan`, `:360-388` donor refs | `if ! donorref="$("$DONOR/release/scan-donor-refs.sh" "$ART" 2>&1)"; then fail=1` | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`): caller checks status but scanner internals can swallow grep errors; reproduced with `grep` exit-7 shim. |
| `demo_runtime`, `:390-460` tracked tree | `if [ -z "$tracked" ]; then ... return 1` | content-checked | Empty committed tree is forbidden. |
| `demo_runtime`, `:390-460` starter data | `if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) ...`; checks exact SETUP rows, prompt index keys/paths and prompt file existence, empty PR index | content-checked | Exact publishable starter content checked. Prompt quality is separately structural-only below. |
| `claims`, `:462-478` | `if [ "$status" -eq 0 ]; then ... return 0` | content-checked | Delegated claims checker inspects artifact text. |
| `module_graph`, `:480-507` | `if [ "$status" -eq 0 ]; then ... return 0` | content-checked | Auditor resolves shipped module dependencies against cut. |
| `public_readme`, `:508-585` | `if [ -n "$out" ]; then ... return 1; fi` | content-checked | Script's `out` contains asserted headings/license owner/markers; COORD-613 owns transformed README false-green. |
| `bootstrap`, `:587-597` | `[ ! -f "$ART/concord-bootstrap.js" ]` fails; `node --check` must succeed | structural-only | Presence and syntax are the intentional contract at this gate; executable behavior is checked by install verification below. |
| `retired_init`, `:599-629` | `if [ -e "$ART/init.sh" ]; then ... return 1`; classification must be empty | content-checked | Checks absence and declared non-installability/selection state. |
| Overall gate, `:631-650` | `RESULT[$chk]="FAIL"`; `OVERALL=1`; final `exit $OVERALL` | not-applicable | Aggregate status composes the selected gates; it is not an independent content assertion. Scanner/suite issues are attributed to their component rows, avoiding a duplicate aggregate finding. |

Other `release/*.sh` files are included only where they make an independent publish/verification decision. `build-public-release.sh` is a transformer; its per-step success is not treated as artifact validation when a post-build check exists. `verify-dual-release.sh` compares release identity/build hygiene; `verify-released-install.sh` verifies checksums and executes install contracts; `verify-fresh-clone.sh` is a disposable clone smoke. `publish*.sh` and credential scripts validate arguments/remote publication prerequisites and issue writes; they are outside this census’s *content-bearing artifact gate* interpretation because they do not certify artifact contents and inclusion would widen the prompt’s stated hygiene boundaries into all release operation procedures. Within scope, release helper scanners are enumerated above because their results feed `public_scan`.

### Board `validate*` and doctor surfaces

| Gate / source | Quoted pass condition | Class | Structural disposition |
|---|---|---|---|
| Board aggregate `validateBoard`, `coord/board/board.js:294-438` | `if (!board \|\| typeof board !== "object" \|\| Array.isArray(board)) { fail("coord/board/tasks.json must contain a JSON object."); }`; `if (errors.length > 0) { fail(errors.join("\n")); }` | content-checked | Aggregates schema plus row, reference, lifecycle, and live lock/journal checks below. |
| Required board members, `board.js:299-324` | `if (!Array.isArray(board.sections) \|\| board.sections.length === 0)`; `if (!board.prompt_index \|\| typeof board.prompt_index !== "object" \|\| Array.isArray(board.prompt_index))`; analogous required-object checks for metadata, PR/landing indexes, review findings, and follow-up exceptions | not-applicable | These establish mandatory container shape; row and relation content is checked by the validators below. |
| Sections/rows, `board.js:332-425` | `if (!Array.isArray(board.sections) \|\| board.sections.length === 0)`; `if (!["markdown", "table"].includes(section.kind))`; `if (!Array.isArray(section.rows))`; `if (typeof ticketId !== "string" \|\| !ticketId.trim())`; `if (typeof status !== "string" \|\| !isLegalStatus(status))` | content-checked | Table loop also checks declared columns, duplicate IDs, and active owner for doing rows. Markdown prose semantics remain human-authored and outside the machine contract. |
| Index references, `board.js:611-617` | `` if (!tickets.has(key)) errors.push(`${label} references unknown ticket "${key}".`); `` | content-checked | Verifies each declared reference resolves to an actual ticket. |
| Findings, `board.js:619-663` | `if (!tickets.has(ticketId))`; `if (!Array.isArray(findings))`; `if (!["HIGH", "MED", "LOW"].includes(finding.severity))`; `if (!ORDERED_FINDING_STATUSES.includes(finding.status))`; `if (!Number.isInteger(finding.round) \|\| finding.round < 1)` | content-checked | Also requires nonblank summary and valid deferred/consolidated references. Human judgment of finding resolution is not a machine claim. |
| Waivers, `board.js:665-688` | `if (waiver.code !== "prompt_coverage")`; `if (typeof waiver.reason !== "string" \|\| !waiver.reason.trim())`; `if (!Number.isFinite(Date.parse(waiver.recorded_at \|\| "")))`; `if (typeof waiver.recorded_by !== "string" \|\| !waiver.recorded_by.trim())` | not-applicable | Waiver use is the human-admin exception; machine validates provenance, not the merit of the rationale. |
| Followup exceptions, `board.js:690-727` | `if (!["closeout-blocker", "related-followup"].includes(exception.type))`; `if (!exception.parent \|\| typeof exception.parent !== "string")`; `if (!tickets.has(exception.parent))` | content-checked | Validates the declared relation against actual ticket rows. |
| Landing index, `board.js:729-777` | `if (!Number.isFinite(Date.parse(entry.recorded_at)))`; `if (!Array.isArray(entry.evidence) \|\| entry.evidence.length === 0)`; hash fields must match `/^[0-9a-f]{7,40}$/i` | content-checked | Board checks record shape/field values; lifecycle gate separately resolves actual landing/ancestry evidence. |
| Journal progression, `board.js:491-510` | `if (!boardEntry) { errors.push(...board rollback drift...); continue; }`; terminal regression check `if (shouldEnforceJournalRegression(journalEntry) && boardRank < journalRank)` | content-checked | Compares the latest successful lifecycle status with the canonical board row, for scoped tickets. |
| Locks, `board.js:779-900` | `if (typeof lock[field] !== "string" \|\| !lock[field].trim())`; `if (lock.status !== STATUS.DOING)`; `else if (!ignoreActiveLockErrors && Date.now() - heartbeatAt > STALE_LOCK_MS)`; `else if (!ignoreActiveLockErrors && !fs.existsSync(lock.worktree))` | structural-only | This contract checks required lock shape and heartbeat freshness, not liveness. That is an explicit policy boundary; no missing liveness requirement has been demonstrated, and legacy session binding must not be restored (ADR-0005). No follow-up filed. |
| Prompt index existence, `board.js:1063-1068` | `` if (!fs.existsSync(absolutePath)) { errors.push(`prompt_index for ${ticketId} points to missing file ${promptPath}.`); } `` | structural-only | Filed `COORD-813` (`PROMPT-CONTENT`): file existence does not establish ticket-specific acceptance or readable usable content. |
| Lifecycle closeout, `board.js:1072-1204` | `if (status === STATUS.REVIEW) { ... }`; for example `if (requiresPrIndexGovernance(metadata, ticketId, row) && (!Array.isArray(prRefs) \|\| prRefs.length === 0)) errors.push(...)` and `if (!planRecord) errors.push(...)` | content-checked | The function checks actual status against PR evidence, open findings, canonical plan round, gates/proofs, and landing state. `...` marks omitted conditions in this compact source excerpt. |
| Schema validator, `board.js:1348-1435` | Literal conditions: `if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {`; `if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {`; `if (Object.prototype.hasOwnProperty.call(schema, "type") && !matchesType(schema.type, value)) {`; `if (Array.isArray(schema.anyOf)) {`; `if (Array.isArray(value)) {`; `if (schema.additionalProperties === false) {`. | not-applicable | Schema validator’s contract is structural validity. Content semantics belong to dedicated validators; schema shape is not itself a deficient content claim. |
| Doctor board entry, `doctor-report.js:221` | `if (!options.ticket) { runBoardValidate(); }` | content-checked | Calls the board validator; no new independent assertion. |
| Doctor readiness/ownership/prompt/lock/landing, `doctor-report.js:241-343,678-707` | Literal guards: `if (readiness.cycles.length > 0) {`; `if (isDoingStatus(row.Status)) {`; `if (!board.prompt_index?.[row.ID] && !hasPromptWaiver(board, row.ID)) {`; `if (!canonicalLock) {`; `if (row.Status === STATUS.DONE && requiresLandingGovernance(board, row.ID, row)) {`; final `if (errors.length > 0) {` and success line `console.log("Governance doctor OK: no additional issues found.")`. | content-checked | Cross-checks actual governed state; prompt content exception remains above. |
| Doctor worktrees/provenance, `doctor-report.js:357-447,502-512` | Literal guards: `for (const stale of coordAudit.stale_worktrees) {`; `for (const unknown of coordAudit.unknown_ticket_worktrees) {`; `for (const stale of audit.stale_ticket_worktrees) {`; `if (outOfBand.detected) {`. | content-checked | Live state comparisons; warnings for configured non-repositories remain diagnostics, not pass certificates. |
| Doctor journal/health/diagnostics, `doctor-report.js:523-545,566-620,678-719` | Literal journal branches: `if (!chain.ok) {`; `} else if (chain.preChainCount > 0 && chain.chainedCount === 0) {`; final `if (errors.length > 0) {`; success line `console.log("Governance doctor OK: no additional issues found.")`. | content-checked | Warnings are diagnostic, not gates; their pass/fail is not release readiness. |

### Lifecycle prompt/waiver/plan preconditions and agent command path

| Gate / source | Quoted pass condition | Class | Structural disposition |
|---|---|---|---|
| Prompt generation, `coord/scripts/prompt-coverage.js:123-134` | Literal template lines: `"## Acceptance Criteria"`; `"- Ticket scope is implemented."`; `"- Focused verification is recorded in the governed plan."`; `"## Likely Files"`; `"- TODO: add likely files before start when known."`; `"## Verification"`; `"- TODO: add focused verification command."` | structural-only | Filed `COORD-813` (`PROMPT-CONTENT`) below; no ticket-specific acceptance is generated. |
| Prompt coverage, `prompt-coverage.js:67-74,179-197` | Literal checks: `return fs.statSync(abs).isFile();`; `if (board.prompt_index?.[ticketId]) { return true; }`; `if (hasPromptWaiver(board, ticketId)) { return true; }`; `if (!ticketPromptRelPathExists(relPath)) { return false; }`. | structural-only | Filed `COORD-813` (`PROMPT-CONTENT`) below; existence does not validate contents. A waiver path is authorized human exception (see exemption above). |
| Start transition prompt gate, `ticket-transitions.js:741-746` | `` if (!ensurePromptCoverageOrDiscover(board, ticketId)) { fail(`Ticket ${ticketId} cannot start without prompt coverage or a recorded waiver.`); } `` | structural-only | Filed `COORD-813` (`PROMPT-CONTENT`) above. |
| Prompt preconditions, `ticket-transitions.js:753-761`; `prompt-coverage.js:591-635` | Literal branches: `if (!promptRelPath) {`; `catch {`; `if (preconditions.length === 0) {`; `const report = verifyPromptPreconditions(repoRoot, integrationRef, preconditions);`; `if (!report.ok) {`. | content-checked | Checks declared references against selected base; absence of optional precondition section is intentional/backward compatible (`governance.test.js:1640`). Unreadable prompt behavior is included in `PROMPT-CONTENT`. |
| Start plan preparation, `ticket-transitions.js:771-780`; `governance-plan-shape.js:307-327`; `gates/readiness.js:282-306` | Literal transition calls: `const planPreparation = ensurePlanStub(ticketId, ref.row.Repo, owner);`; `updateCanonicalPlanState(ticketId, buildStartPlanSeedUpdate(ref.row));`; `assertStartPlanReady(ticketId, ref.row);`. Readiness guards: `if (!startupChecklist.includes("completed")) {`; `if (ticketRequiresTraceability(row) && !traceabilityGate.some((value) => ["verified", "closing-gap", "exempt"].includes(value))) {`; `if (!hasCommand \|\| !hasOutcome) {`; `if (gateIssues.length > 0) {`. | structural-only | Filed `COORD-814` (`BASELINE-EVIDENCE`) below: empty prefix values pass. Plan stub itself is allowed initialization, not completion evidence. |
| Plan schema/read/write, `coord/board/board.js:1555-1640`; `coord/board/plan.schema.json:6-21,87-90` | Literal schema excerpts: `"baseline_reproduction": {`; `"type": "array",`; `"items": { "type": "string" }`; reader call: `validateSchema(planSchema, record, path.relative(COORD_DIR, filePath), errors);`. | not-applicable | Container/schema correctness is the contract; schema validates array/string shape, while substantive plan readiness is separately gated above. |
| Waiver state, `board.js:665-688`, and waiver usage in `prompt-coverage.js:179-193` | `if (hasPromptWaiver(board, ticketId)) { return true; }` (line breaks omitted); board checks `if (typeof waiver.reason !== "string" \|\| !waiver.reason.trim())` | not-applicable | Human-authorized exception; reason merits cannot be machine-decided. |
| Transition dependency/review gates, `ticket-transitions.js:335-343,761-780,510-525` | Literal calls: `assertTicketDependenciesReady(ticketId, ref.row, board);`; `assertReviewPlanReady(ticketId, ref.row);`; `assertCommittedReviewState(ticketId, ref.row, lock);`; start calls `assertPromptPreconditionsResolve(ticketId, ref.row, board, { ...options, preconditionRef });` and `assertStartPlanReady(ticketId, ref.row);`. | content-checked | Execution composition is directly represented in transition flow; no second independent assertion inferred from wrappers. |
| Agent command dispatch, `coord/scripts/agent-commands.js:113,139-162` | `assertFactoryDependencies("createAgentCommands", deps, REQUIRED_AGENT_COMMAND_DEPS)`; start/review commands delegate to ticket transitions and lifecycle guards | not-applicable | Dependency wiring assertion is a programming contract, not ticket-content check. Public command wrapper has no separate prompt-content pass condition beyond delegated transition. |

### Authority, architecture and journal conformance

| Gate / source | Quoted pass condition | Class | Structural disposition |
|---|---|---|---|
| Canonical path classification, `coord/scripts/canonical-derived-authority.js:16-52` | `if (file === "coord/PLAN.md") { return { path: file, authority: AUTHORITY_CLASSES.COMPATIBILITY_VIEW, reason: "markdown compatibility view over plan records" }; }`; default `return { path: file, authority: AUTHORITY_CLASSES.UNKNOWN, reason: "not classified by coord authority table" };` | not-applicable | This is a path-to-class lookup, not a content-validity gate. The UNKNOWN result is explicit and consumed by the operation checks. |
| Authority inversion, `coord/scripts/canonical-derived-authority.js:55-103` | `if (kind === "read_write" && source.path && target.path && source.path === target.path && source.authority !== AUTHORITY_CLASSES.AUTHORITY)`; `if (source.authority === AUTHORITY_CLASSES.COMPATIBILITY_VIEW && target.authority === AUTHORITY_CLASSES.AUTHORITY && kind !== "explicit_repair")`; aggregate `ok: !issues.some((issue) => issue.severity === "error")` | content-checked | Checks actual operation/path pairs and canonical-input classes. Warnings do not change `ok`; COORD-678 materialized-view integrity is a separate gate. |
| Architecture analyzers, `coord/scripts/arch-checks.js` | `:348 if (loc > effectiveMaxLoc)`; `:374 if (!shouldCheckProductionModuleLoc(file, cfg)) return [];`; `:382 if (loc <= threshold) return [];`; `:449 if (!isCompositionRootFile(file, cfg)) return [];`; `:453 if (isAllowedCompositionRootWiringLine(entry.text)) continue;`; `:583 if (value > maxComplexity)`; `:627 if (!Array.isArray(rules) \|\| rules.length === 0) return findings;`; `:641 if (importMatches(rule.denyImport, imp.spec))`; `:686 const hash = crypto.createHash("sha1").update(block.map((b) => b.n).join("\n")).digest("hex");`; `:709 if (distinct.length < 2) continue;`; `:900 if (pathRe.test(s.value))`; `:917 if (allow.has(num.value)) continue;`; `:972 if (!config.detectRepeatedStrings) return [];`; `:1002 if (sites.length < minRepeats) continue;`; `:1094 if ((idCount.get(def.name) \|\| 0) > 1) continue;`; `:1097 if ((strCount.get(def.name) \|\| 0) > 0) continue;` | content-checked | Checks configured content properties; explicit non-production, no-rules, allowed wiring, literal allowlist, disabled repeated-string policy, and reference-count exclusions are policy scopes, not missing evidence. |
| Architecture summaries, `coord/scripts/arch-checks.js:1213,1368` | Ratchet `:1233 if (newFailCount > 0 \|\| currentFindings.some(f => f.check === "prodloc" && f.severity === "fail")) result = "fail";`; absolute `:1379 if (failCount > 0) result = "fail"; else if (findings.length > 0) result = "warn"; else result = "pass";` | content-checked | Warning is distinct from no findings and may exit zero; ratchet also enforces absolute production LOC even for inherited findings. Do not describe CLI success as “zero findings.” |
| Architecture corpus completeness, `arch-checks.js:1418-1424,1446-1454` | enumeration `catch { return; }`; source read fallback `catch { return ""; }` | structural-only | Filed `COORD-817` (`ARCH-CORPUS-FAIL-CLOSED`): missing/unreadable scan input can appear clean. Reproduced below; intentional empty-root behavior needs an explicit contract. |
| Journal link/hash/genesis/migration, `coord/scripts/journal.js:1162-1278`; `coord/scripts/conformance-verbs.js:138-152` | `ok: broken.length === 0`; CLI `if (!chain.ok) { fail(...) }` | content-checked | Recomputes chained event links and reports broken records. Pre-chain events remain explicitly unverified under migration policy; signature trust-anchor contract is owned by COORD-681. |
| Pre-chain events, `journal.js:1190-1197` | `if (!chainStarted && !chained) { preChainCount += 1; continue; }` | not-applicable | Legacy prefix is intentionally accepted as unverified under migration policy; it is not represented as a verified current-chain claim. |

## Execution component and probe provenance

The prompt calls for execution comparison where composition can safely be exercised because COORD-687 escaped source-only reading. Source quotes above are pinned to `9435422dfb326700d70ed2ca5131d3e5481c526b`; no result from a dirty or parallel COORD-678 worktree is treated as source evidence for that snapshot. Separate COORD-678 execution evidence is explicitly versioned: commit `e812a24ef6c4fc45aedd0deb13f9e3f4b4b82ce2` (child of `e10b4be941699e2770a6618b9c8c0345bf269ade`) ran the four focused detector/doctor modules serially, 86/86 named tests on Node 22 and Node 24; logs `/tmp/coord678-final-doctor22.log` SHA256 `ab2a0838c085d56ccf97eb0a284427cc2f2f0c3fbd33fcfaa4e07ba843af63dd` and `/tmp/coord678-final-doctor24.log` SHA256 `1126c68d08592e62b6f0291b50bc4c0cfe7d254fb47590213f6b25a2cc2085f9`. This demonstrates that particular execution probe only; it is not the COORD-679 test-runner unchanged check or release qualification, and `e812a24` is not an ancestor of the cited `9435422` source baseline. Earlier public-doctor red evidence is `/tmp/coord678-doctor-red.log` SHA256 `248a85b87385806956ae795c109e7c856df294f304db8dcd3cb8382983533203`; it predates the fix and is not paired with post-fix source.

Architecture missing-root reproduction against the pinned source:

```sh
node coord/scripts/arch-checks.js classify --root /tmp/coord679-definitely-absent-root-20261012
# observed: exit 0; arch: pass files=0 findings=0 (size=0 complexity=0 imports=0 dup=0 monolith=0 prodloc=0 compositionRoot=0 hardcoding=0 deadcode=0)
```

The transcript `/tmp/coord679-arch-missing-root.json` is text despite its suffix. This is an implementation census probe, not qualification. Reproduce with another fresh absent path. A non-directory root can separately be tested with an empty temporary regular file. Permission-denied tests are not portable when execution is elevated; do not claim a chmod probe if the process can still read as root.

## Separately filed findings and acceptance

### COORD-813: Prompt content

**Problem:** `gov file-ticket --with-prompt` writes a generic acceptance line (`Ticket scope is implemented`) and TODO placeholders, while prompt coverage and board validation accept an existing mapped prompt by file existence alone. A ticket can therefore pass start coverage without ticket-specific acceptance criteria.

**Acceptance:** Add a prompt-content contract for generated and mapped prompts that rejects generic acceptance text and unresolved required placeholders; retain explicit recorded waiver as the only bypass. Add tests for generic generated prompt, specific prompt, malformed/unreadable prompt, and waiver. Keep legitimate optional prompt sections/backward compatibility explicit.

### COORD-814: Start baseline evidence

**Problem:** start readiness checks that evidence lines begin `Command:` and `Outcome:` but permits empty values (`Command:` / `Outcome:`), so presence of labels is mistaken for recorded evidence.

**Acceptance:** Require nonblank command and outcome values for required test/contract/infra baseline rows; provide an explicit typed `not-required` alternative where policy permits; test empty/whitespace values fail and meaningful values pass.

### COORD-815: Public scan fail-closed behavior

**Problem:** release public scan can report clean when scanner execution fails: client invocation suppresses its status with `|| true`; office/binary pipelines do not preserve `find` failure; donor scanner can suppress internal `grep` failure and return clean.

**Acceptance:** Distinguish successful zero findings from scanner failure for each scanner and enumeration step. Propagate nonzero status even with empty stdout; add disposable tests using failing `find`/`grep` shims and retain existing positive leak-detection cases. The release check must fail closed with actionable attribution.

### COORD-816: Tier-aware suite inventory

**Problem:** public release governance gate accepts `test-runner.js` exit 0 without asserting edition-specific expected test inventory or explaining skip counts; this allows silent coverage loss to share the same PASS.

**Acceptance:** Define and verify expected suite/module/test inventory and allowed named skips per release tier, based on intentionally shipped files; unexpected missing tests, increased/unnamed skips, or report/inventory mismatch fail with attribution. Demonstrate both valid Community/Enterprise pruning and a removed test/extra skip failure. Avoid one raw count floor shared across editions.

### COORD-817: Architecture corpus fail-closed behavior

**Problem:** `coord/scripts/arch-checks.js` catches `readdirSync` failures by returning an empty directory and converts `readFileSync` failures to empty source. Missing `--root` was reproduced with exit zero and `files=0 findings=0`, so an unavailable corpus can appear clean.

**Acceptance:** Validate that requested root exists and is a readable directory; account for every in-scope traversal/read and fail with path and OS error rather than silently omitting it. Preserve only a documented, tested empty-corpus case if a caller needs it. Cover absent, non-directory, unreadable, and genuinely empty roots separately in absolute and ratchet modes; preserve configured ignores. Re-run against a normal repo and verify configured source inventory. Duplicate search in prompt/board/review files at source baseline `9435422` found no matching architecture corpus-completeness ticket; the subsequent live canonical lookup confirmed no duplicate before COORD-817 was filed. This is distinct from shell `find`/`grep` suppression under `SCAN-FAIL-CLOSED` and COORD-678 derived-view integrity.

### Additional `release/*.sh` check functions in the stated boundary

| Gate / source | Quoted pass condition | Class | Disposition |
|---|---|---|---|
| Dual-cut Community hygiene, `release/verify-dual-release.sh:50-58` | `grep -q "hygiene gate PASS" "$OUT_ROOT/community.log" \|\| fail ...`; identity verifier must exit zero; enterprise directory must be absent | content-checked | Validates recorded hygiene result, release identity and tier boundary. |
| Dual-cut Enterprise, `:62-70` | `grep -q "hygiene gate PASS" "$OUT_ROOT/enterprise.log"`; `node "$HERE/verify-release-identity.js" "$ENTERPRISE_OUT"`; `[ -d "$ENTERPRISE_OUT/coord/scripts/enterprise" ]` (each refuses through `fail` on the following line) | content-checked | Validates identity and required tier content. |
| Fresh-clone, `release/verify-fresh-clone.sh:35-48` | committed-only clone runs `node coord/board/board.js validate --committed-artifacts` and `node coord/scripts/governance.js conform`; either nonzero stops under `set -e` | content-checked | Behavior/chain content checked without ignored runtime state. |
| Released-install checksums, `release/verify-released-install.sh:9-15` | `test -f "$PROVENANCE"`; `( cd "$ASSETS" && sha256sum -c SHA256SUMS )` | content-checked | Presence is prerequisite; checksum compares actual downloaded bytes. |
| Documented commands, `:23-36` | `if (report.summary.failed \|\| report.summary.skipped) process.exit(2)` | content-checked | Executes documented downloaded commands and rejects skip. |
| Installed npm/SEA, `:38-91` | extracts nonempty plan digest; applies plan; requires `test -f .../coord/scripts/governance.js`; board validate; control-plane test | content-checked | Validates actual installed behavior. |
| Client scanner internal enumeration, `release/scan-client-refs.sh:13-36` | `done < <(find "$ROOT" ... 2>/dev/null \|\| true)` and `done < <(grep -rIlE ... 2>/dev/null \| grep -vE ... \|\| true)`; final `[ "$found" = 0 ]` | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`): upstream failures become empty scans and final clean exit. |
| Donor scanner internals, `release/scan-donor-refs.sh:51-64` | `HITS="$(grep -rInE "$PATTERN" "$ART" --exclude-dir=.git 2>/dev/null \|\| true)"`; empty `HITS` prints “scan clean” and `exit 0` | structural-only | Filed `COORD-815` (`SCAN-FAIL-CLOSED`); `grep` failure indistinguishable from no match. |
| Secret scanner wrapper, `release/scan-secrets.sh:17-22` | requires node command then `exec node "$SCRIPT_DIR/secret-scan.js" "$ROOT" "$ALLOWLIST"` | content-checked | Execution status propagates; scanner implementation reads text and binaries. |

## Spot-check record and ticket status

Literal excerpts were checked against the working tree with `sed`/`nl` for `check-public-release.sh`, `board.js`, `doctor-report.js`, `ticket-transitions.js`, `prompt-coverage.js`, `verify-dual-release.sh`, `verify-fresh-clone.sh`, `verify-released-install.sh`, `scan-client-refs.sh`, `scan-donor-refs.sh`, and `scan-secrets.sh`. This is a source quote spot-check, not a full aggregate test rerun; the task is read-only and the canonical qualification window is active.

Every structural-only defect row now identifies a separately filed ticket; intentionally structural checks include an explicit reasoned exemption. Existing scope retained: COORD-677 engine-pin checks, COORD-678 derived-view integrity, COORD-705 coverage measurement, and COORD-802 empty inventory. Census completion does not assert that those findings are fixed.


## Source fingerprint and gate-symbol mapping

The following SHA-256 hashes were recomputed from Git blobs at the immutable census baseline `9435422dfb326700d70ed2ca5131d3e5481c526b`:

- `coord/board/board.js`: `e3b7b09aeb1e5a3345cce3f4fda8ed77bb6bc69b0fbb57629906f81cc010220a`
- `coord/board/plan.schema.json`: `c588a38d9b8f223677dfd61a0aab269347e4b2687a4656dbb2c1c4bdd70eb01e`
- `coord/scripts/doctor-report.js`: `9a462b3ee2da525b0cd76432e76c559c710c0923447d55390c0db1725cdbbfdc`
- `coord/scripts/doctor-recovery.js`: `983ade76883ed62bb52c76ffb8413b6b8056b841e20b78864cc603cc3d22cf49`
- `coord/scripts/ticket-transitions.js`: `8e21653f4023094a89075a6600d7122a7b630a2fbdbf5e4beaefb538920a8fea`
- `coord/scripts/agent-commands.js`: `f36f2958d98764b1a843e4587d540a175bcc81acfc3aef52f1eac9f976f15b0f`
- `coord/scripts/lifecycle.js`: `c5fd1db8fb6d5d6a0a5bb0ea39c4699f51248c220c111b0de6b3adf3b00cadd9`
- `coord/scripts/governance-plan-shape.js`: `cd9b279f8357dd4e75c63dd24d47f970dd80606c4d28e4acb54b2f1090fa3206`
- `coord/scripts/canonical-derived-authority.js`: `8563012d16c7b6fc62bf97c5151234c30c2517c679eaf3437732579145709780`
- `coord/scripts/journal.js`: `cdd96670ce9480656aa8ef4879b96ff4bded2f6271a840b32408020fa2ff5bea`
- `coord/scripts/conformance-verbs.js`: `c80997dcb90db72204aa3126f28c7a7e38b83b3846e83a1f63b5fbc8847a5e5c`
- `coord/scripts/arch-checks.js`: `2a26f3cea74beda1bc0fd3499c70a2de61a0882d9230cb62a9ae907aeb96ef5c`
- `coord/scripts/prompt-coverage.js`: `386b34e6b6a64709d7d0d6bfd40491c3d0abc5e43deb6134637a74304a83682b`
- `coord/scripts/gates/readiness.js`: `025dda98cca46a61c086c65783e13fa968fa98745526c2274d21dacd64f1e09b`
- `release/build-public-release.sh`: `df5fe2ca0a8d175b6e99998743046e4f3e9a8629ee32aa6a8cf911e558026df0`
- `release/check-public-release.sh`: `74f06927b9993f0a153dc293307ea9e75f31891dba2de6d965a4550aecbac0fa`
- `release/verify-dual-release.sh`: `7d689429d6bb3f2081d2f72b133dab519f4c7c6d88305d004965ff6bb4b33fb2`
- `release/verify-fresh-clone.sh`: `7120127f0ac693599ab43e4ad69a467deafd1b0e85bde5a3485a852aea98f04a`
- `release/verify-released-install.sh`: `07da111552dfc570df2bf8737545a049d4104b01bf7525996d92adb43b11ad40`
- `release/scan-secrets.sh`: `c7940ffa71c129bdb28b86ca14ef5a042e81212bd1c7f10cddedf88109e9ef19`
- `release/scan-client-refs.sh`: `97efcfda8a8812de3c24cd30adb40b00ad2b568cb8ce2492a4028378598d184b`
- `release/scan-donor-refs.sh`: `aa98d67c53dc444ca829a67336928c4f2666da81ac5136b1b7d832eed6d585fe`

The mechanically extracted board validators map to table rows as follows: `validateBoardState` → board aggregate/doctor; `validateBoard` → board aggregate; `validateJournalBackedBoardProgression` → journal progression; `validateIndex` → index references; `validateFindings` → review findings; `validateWaiverIndex` → waiver state; `validateFollowupExceptions` → follow-up exceptions; `validateLandingIndex` → landing index; `validateLocks` → lock contract; `validatePromptFiles` → prompt index existence; `validateLifecycleGates` → lifecycle closeout; `validateSchema` → schema-shape exemption. The examined transition guard `assertTicketDependenciesReady` delegates to transition dependency/review gates. Doctor's board, readiness, worktree/provenance, and journal checks delegate to the listed board/lifecycle/journal rows; no second independent gate was counted where wrapper only reports a delegated result. The authority inversion aggregate is the literal `ok: !issues.some((issue) => issue.severity === "error")`; path classification itself returns an explicit UNKNOWN class and is a lookup contract, not a content certificate. Architecture analyzer and both summary modes are quoted individually above. Journal conformance rows cite `ensureGovernanceJournalBaseline`, `verifyGovernanceChain`, and `assertLaunderingContentBreak`; signature/trust-anchor enforcement remains owned by COORD-681.

Five independently scoped findings were filed, with IDs mapped at each corresponding structural-only row. No source gate was modified.


## Unchanged baseline execution evidence

The complete baseline runner was executed in an independent Git clone at `9435422dfb326700d70ed2ca5131d3e5481c526b`, on Node 22.8.0 with COORD_SESSION_ID absent. No product changes were applied to the clone. Report: `/tmp/coord679-baseline-943-report.json`; transcript: `/tmp/coord679-baseline-943-tests.log`.

It discovered 4,337 tests: 4,331 passed, 0 assertion failures, 1 cancelled by its 45-second deadline, 5 skipped. The sole unsuccessful case was the COORD-712 three-process lifecycle test (45,006 ms). There were no governed-tree or coverage-source violations. This is a failing aggregate baseline, not a passing qualification result; it must remain visible in review and cannot be counted as success. The same timing failure also occurred in the separately tested COORD-678 branch; that comparison does not establish the cause.
