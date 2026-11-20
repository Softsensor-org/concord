# COORD-976: coord-template governance engine, architecture and simplification audit

- Date: 2026-11-13
- Ticket: COORD-976 (first report). No tickets filed; no repository file changed; no `gov` command run.
- Audited revision: **origin/dev 5fe838d8**, compared with base **f3fd1dd9**. origin/dev moved twice during the run (to 16d86f0c, then to f7c02136). Re-run the measurements against the current head before filing tickets. The measured deltas below are not valid for the new head.
- Method: snapshots extracted read-only with `git archive` / `git show` into the scratchpad (`scratchpad/arch/`). LOC uses the arch-checks `countLoc` rule (non-blank, non-comment lines), the same rule as the prodloc budget. Clone detection hashes 8-line windows after whitespace and comment normalisation, keeps windows with at least 5 alphanumeric lines, and clusters them by file set. Helper-body equality uses brace-matched bodies with whitespace normalised. Every duplication claimed in section 6 was read at both sites, except where the finding says "hash-equal, one site read".
- Not done: no test or gate was run. No mutation of any repository state. Guard file locations were checked against the snapshot.

## 0. Summary

| | |
|---|---|
| Production engine modules (`coord/engine/scripts`, non-test, excluding fixtures) | **350** at 5fe838d8 (346 at f3fd1dd9, **+4**) |
| Production LOC (prodloc rule) | **99,911** (98,351 at f3fd1dd9, **+1,560**, +1.6%) |
| Guards | 103 (T0 58, T1 32, T2 13). Registry proposes 5 merges covering 14 guards (net -9) and lists 5 retirement candidates |
| Shims in `coord/scripts` | 284 registered: 14 permanent, 270 removable (2,635 lines). Only 2 removable shims are still spelled by live `coord/` code |
| Largest single duplication | `examples/demo/coord/scripts`: a diverged second copy of the engine, 274 production modules and 100,033 lines (section 6, F-10) |
| Real require cycles | 3 modules in 2 cycles (`affected-state`/`affected-landing`/`test-policy`) and `cli`/`cli-surface`. All are lazy in at least one direction |
| Cheapest safe reduction | About 560 production LOC from exact-duplicate helpers, the flag table and the policy-adapter skeleton, with no module removed |

## 1. Size

### 1.1 Totals and deltas

| Metric | f3fd1dd9 | 5fe838d8 (audited) | Delta |
|---|---|---|---|
| Non-test `.js` under `coord/engine/scripts` (incl. fixtures) | 350 | 356 | +6 |
| Production modules (excl. `__fixtures__/`, `fixtures/`) | 346 | 350 | +4 |
| Production LOC, prodloc rule | 98,351 | 99,911 | +1,560 |
| Production raw lines | 123,750 | 125,796 | +2,046 |
| Test files (`*.test.js`) | 314 | 323 | +9 |
| All `.js` raw lines (prod + tests + fixtures) | 258,769 | 264,028 | +5,259 |
| `git diff --stat` under `coord/engine/scripts` | | 88 files, +6,169 / -630 | |

The 264k figure in the brief is the all-`.js` raw total at 5fe838d8, which includes tests.

### 1.2 Top 20 production modules by prodloc, with budgets

Budget = `arch-checks.js` highWater value where one exists; otherwise the default `maxLoc` 1200. The prodloc check applies to `coord/engine/scripts/` at severity fail.

| # | Module | prodloc | raw | Budget | Headroom |
|---|---|---|---|---|---|
| 1 | lifecycle.js (composition root) | 2,130 | 2,635 | 2,131 | 1 |
| 2 | governance-context.js | 1,765 | 1,936 | 1,785 | 20 |
| 3 | journal.js | 1,696 | 2,270 | 1,709 | 13 |
| 4 | plan-records.js | 1,540 | 1,807 | 1,540 | 0 |
| 5 | token-economics.js | 1,426 | 1,672 | 1,429 | 3 |
| 6 | coord-upgrade.js | 1,200 | 1,404 | 1,200 (default) | 0 |
| 7 | governance-mcp.js | 1,200 | 1,425 | 1,200 (default) | 0 |
| 8 | governance-session.js | 1,199 | 1,449 | 1,200 (default) | 1 |
| 9 | agent-commands.js | 1,195 | 1,495 | 1,200 (default) | 5 |
| 10 | business-discovery-source-parser.js | 1,194 | 1,539 | 1,200 (default) | 6 |
| 11 | arch-checks.js | 1,156 | 1,828 | 1,200 (default) | 44 |
| 12 | test-runner.js | 1,093 | 1,300 | 1,200 (default) | 107 |
| 13 | business-discovery.js | 1,091 | 1,227 | 1,200 (default) | 109 |
| 14 | worktree-ops.js | 1,039 | 1,249 | 1,200 (default) | 161 |
| 15 | memory-graph.js | 985 | 1,127 | 1,200 (default) | 215 |
| 16 | cli.js | 982 | 1,235 | 1,200 (default) | 218 |
| 17 | memory-classification.js | 969 | 1,216 | 1,200 (default) | 231 |
| 18 | ticket-transitions.js | 943 | 1,163 | 1,200 (default) | 257 |
| 19 | business-context-pack.js | 942 | 1,050 | 1,200 (default) | 258 |
| 20 | prompt-coverage.js | 937 | 1,088 | 1,200 (default) | 263 |

Observations:
- governance-validation.js is not in the top 20 (810 LOC), but its highWater cap is 1,218. That is 408 lines of unused headroom (F-07).
- Five modules sit within 6 lines of the default ceiling, so one short feature will fail the gate. Two are exactly at 1,200.
- lifecycle.js also has a second, looser budget: `perFile: { "lifecycle.js": 2600 }` at `arch-checks.js:90`.
- `decomposition-proof-gate.js:375` checks `actualAfter > highWater`. The comment at `arch-checks.js:193` says the gate "requires highWater === measured count EXACTLY". The comment is stale.

## 2. Duplication

### 2a. Code clones

Window clustering found 536 hashed clusters in 115 file-sets. Most of the top clusters are dependency-injection import lists that repeat in each factory and composition root, for example `cli.js:62` / `lifecycle.js:2388` and `governance-session.js:25` / `lifecycle.js:587`. Module-header windows (`'use strict'` plus requires) also match, for example `insight-reports.js:1` / `summary-tiers.js:1`. I did not count those as duplication.

Clusters with real logic duplication, verified by reading:

| Cluster | Sites | Verified by |
|---|---|---|
| CLI flag tables vs lifecycle flag tables | `cli.js:834-1012` / `lifecycle-flags.js:34-107` (161 identical keys) | read both (F-04) |
| Terminal-verb handlers | `cli.js:395-421` (close, finish, finish-ticket) | read (F-12) |
| BM25 query preamble, same file | `recall.js:632-637` / `recall.js:681-686` ("identical math to rankDocs") | read |
| Commits-ahead check, same file | `ticket-commands.js:162-172` / `ticket-commands.js:197-207` | read (F-19) |
| Policy adapter skeleton | `a11y-policy.js`, `perf-budget-policy.js`, `sast-policy.js`, `supply-chain-policy.js` (`defaultLookPath`, `detectTool`, `runCli`) | read (F-05) |
| Journal NDJSON readers | `memory-graph.js:459`, `insight-reports.js:88`, `journal-signing.js:219`, `enterprise/org-collector.js:84` | read (F-11) |
| Exact helper bodies | see F-01 | normalised hash equal (section 6) |

### 2b. Overlapping helpers that implement one rule

Checked: the names in the brief. `run-ownership.js` and `integration-base-ref.js` do not exist.

- **Process liveness and staleness.** Three different rules exist. (1) PID-only: `governance-context.js:1631` `isProcessAlive` (EPERM counts as alive). It is used by `integration-authority.js:310` (`if (!isProcessAlive(operation.pid)) return "gone"`) and by `directory-locks.js`. (2) PID plus `/proc/<pid>/stat` start time: `gate-proc-registry.js:197-199` and `gate-proc-registry.js:61-77` `readProcStartTime`. (3) A third `/proc` parse with the same rule: `directory-locks.js:30` `readProcessStartTime`. Staleness by heartbeat TTL is separate: `identity-v2.js:144` `reapStale`, `governance-session.js:52` `heartbeatAgeMsForSession`, `governance-repair.js:277` `isStaleTicketLock`. `computeStaleness` has the same name with different semantics in `enterprise/org-rollup.js:105` and `recall.js:765`. `identity-v2.js` and `governance-session.js` do no PID liveness check at all.
- **Crash harnesses.** `crash-window-child.js` (COORD-950, real SIGKILL at named crash points, 344 lines) is the real-process harness. `integration-authority.test.js` also uses in-process `process.exit(9)` fault hooks. The testing audit found these at `:986` and `:1402`. Two kill mechanisms exist.
- **File-mode.** `file-mode.js:12` `gitFileMode` is the shared rule (COORD-938). Its own comment says it is "used by engine-pin.js", but the only importer is `coord-upgrade.js:53`. `engine-pin.js:41` and `tree-fingerprint.js:105` each carry an identical copy.
- **Base-ref resolution.** No single module. The rule "prefer `origin/<base>` when it resolves" appears in `lifecycle-ticket-admin.js:56` `resolveWorktreeBaseCompareRef`. Other resolvers are `worktree-ops.js:369` `resolveTicketBaseRef`, `landing-resolution.js:70` `resolveLandingBaseRef` (with a stale-ancestor variant), `closeout.js:445` `closeoutPlanBaseRef`, and `control-plane-landing.js:107` `fetchBase`.
- **Git fixture helpers.** 32 files define `function git(`. Nine are production modules, including `landing-corrections.js:19`, `run-manifest.js:74`, `affected-graph.js:57`, `affected-evaluation.js:39`, `test-sharding-executor.js:15` and `prodloc-closeout.js:58`. Only 7 files use the shared COORD-952 `test-git-fixture.js`. `git-ops.js` has 16 importers and is the natural shared runner.
- **Journal readers.** `readJournalEvents` is defined four times (listed in section 2a). Two more readers do the same thing with different output shapes: `decision-extractor.js:84` `indexJournalProvenance` and `governance-context.js:874` `recentJournalEvents` (hard-coded path). `journal.js:340` `readGovernanceEventLog` is the authoritative reader. `journal-signing.js:228-232` and `enterprise/org-collector.js:91-96` skip unparseable lines silently.
- **PR and gh wrappers.** `landing-gh.js:163` and `landing-gh.js:168` define `ghPrListMergedByBase` twice; the second definition wins and the two are identical. `landing-gh.js:302` `runGh` (fails on non-zero status) and `board-push-preflight.js:65` `createDefaultGh` (timeout and `GH_PROMPT_DISABLED`) are two `spawnSync("gh")` wrappers with different failure semantics. `pr-ops.js` uses `landing-gh.js` helpers and has no spawn of its own.

### 2c. Verbs and flags that do the same thing

- `cli.js` `dispatchCommand` (lines 283-758) has 154 case labels. Several pairs and triples share a body or fall through (section 6, F-12).
- Flag parsing has two copies: `cli.js:834-1012` (five tables, 227 entries) and `lifecycle-flags.js:34-125` (four tables, 163 entries). 161 keys have identical mappings. `--depends-on` and `--parent` exist only in `lifecycle-flags.js`.
- `lifecycle-help.js` (983 lines) has no dispatch code. It is help prose. `verb-parity.js` is the existing check that ties it to the dispatch table. No merge is proposed.

## 3. Guards

Source: `coord/engine/governance-guards.json`, 103 guards, all present in `GUARD_REGISTRY.md`.

- **Proposed merges already in the registry**, 5 groups with 14 guards, net **-9**:
  - `adr-requirement`, `adr-compliance-closure`, `business-context-status`, `context-pack-ack`
  - `prodloc-closeout`, `prodloc-budget`
  - `template-sync`, `engine-pin`
  - `repo-gate-record`, `gate-plan-receipt`, `closeout-landing-evidence`
  - `tree-mutation-safety`, `canonical-authority-write`, `co-located-writer`
- **Retirement candidates in the registry**, 5 guards: `legacy-entrypoints`, `upgrade-bridge`, `critical-invariants`, `wip-cap`, `adr-path-packet`. None overlaps a merge group.
- **Overlaps not covered.** 99 overlap pairs are declared in the `overlaps` field. Only 8 of them fall inside the proposed merge groups, so 91 remain. The `overlaps` field is not a merge plan.
- **Guards whose locations are all in one file:** 65 of 103. Most are single-function checks, so this alone is not a merge signal. These same-file pairs are plausible additional merges, pending ADR 0021 review:
  - `sync-unapproved-drift` + `publish-board-refusal` (`sync-provenance.js`)
  - `governance-full-suite` + `coverage-ratchet` (`test-runner.js`)
  - `terminal-ticket-admin` + `lock-normalization` (`lifecycle-ticket-admin.js`)
  - `followup-relation-integrity` + `ticket-id-allocation` (`followups.js`)
  - `review-cycles` + `subagent-supervision` + `requirement-closure` (`gates/review-closeout.js`; `critical-invariants` is already a retirement candidate in the same file)
- **Location references.** Ten guard locations point at repo-root paths outside `coord/engine/scripts` (`release/*.sh`, `release/suite-inventory.js`, `@enterprise/...`). They exist at 5fe838d8. This is not drift.
- **Ownership.** The registry says classification changes (tier, merges, retirements) need human-admin review through a governed ticket that cites ADR 0021. The numbers above are proposals.

## 4. Layering and circular requires

Graph: 352 modules and about 522 static edges, built by regex over `require(...)` and `resolveEngineModule(...)`. Two of the first cycles were string-literal false positives (`verb-parity.js:42` and `coord-upgrade.js:532`), so every cycle below was checked by hand.

Real cycles:
1. `affected-state.js:107` requires `affected-landing.js` lazily, and `affected-landing.js:37` requires `affected-state.js` at top level.
2. `affected-landing.js:130` requires `test-policy.js` lazily, and `test-policy.js:320` requires `affected-landing.js` lazily.
3. `cli.js:734,748,1170` requires `cli-surface.js` lazily, and `cli-surface.js:89` requires `cli.js` lazily.

Surprising directions:
- `command-registry.js:444` (registry requires the composition root `lifecycle.js`, lazily).
- `context-pack-ack-commands.js:91` and `:243` (same, lazily, twice).
- `plan-records.js:26` (data model requires `gates/business-context.js`).
- Five non-root modules require `lifecycle.js`: `command-registry`, `context-pack-ack-commands`, `coord-conformance`, `installer-governance`, `requirements-linkage-backfill`.

Lazy requires: 224 indented `require(` lines in 50 production modules, against 1,173 top-level declarations. These are cycle breaks.

Foundation modules do not require upward. The graph found no edge from `journal.js` or `governance-context.js` to `lifecycle`, `cli`, `gates/` or `enterprise/`. `governance-context.js` has fan-in 40 and `governance-constants.js` has 21. Both are expected hubs.

`prodloc-closeout.js:36-41` parses the `arch-checks.js` highWater literal as text with regex. That is brittle coupling to a config layout.

## 5. Shims

- `coord/engine/shim-registry.json`: 284 entries. `kind`: 270 `removable`, 14 `permanent`. The registry's `stable_entrypoints` list has 13 names, so one permanent shim is not listed there. Check this.
- `coord/scripts`: 332 files, of which 284 are registered shims and 48 are tests, fixtures, the README and shell scripts.
- Removable shims' footprint: 270 files, 2,635 lines.
- Reference check, `git grep` over origin/dev at 5fe838d8, for the spelling `coord/scripts/<path>`. Hits in journal, plan, board and manifest data were excluded. Only **2** removable shims are referenced from live code outside `coord/scripts`: `scripts/lifecycle.js` (from `prodloc-closeout.test.js`) and `scripts/test-isolation-guard.js` (from `test-isolation-guard.test.js`). The check does not see relative spellings such as `path.join(COORD, "scripts", ...)`, so the count is a lower bound on references, not a proof that the rest are dead.
- The registry rule is "removable once no live reference spells its legacy path". The shims are shipped to adopters, and COORD-868 defines the deprecation window. Removal is an adopter-facing decision.

## 6. Findings, ranked by reduction per unit of risk

Estimates: LOC is production LOC unless stated. Risk is low, medium or high. Ranking is a judgement. The demo copy (F-10) and the shims (F-09) have the largest reductions, but each needs a human decision first, so they are ranked after the cheap ones.

### F-01. Exact-duplicate helper bodies (rank 1)
- **Evidence.** Normalised bodies are hash-equal across these sites. The function name is the same at every site.
  - `stableStringify`: `closeout-summary.js:85`, `decision-extractor.js:533`, `insight-reports.js:69`, `learned-rule-promotion.js:80`, `prework-pack.js:83`, `summary-tiers.js:74`. One site read (`closeout-summary.js:85-94`).
  - `sha256` pairs: `decision-extractor.js:69` = `journal-chain.js:16`; `independent-reviews.js:42` = `plan-evidence-supersession.js:27`; `requirements-import.js:33` = `requirements-walking-skeleton.js:13`.
  - `sha1`: `code-context.js:87`, `decision-extractor.js:61`, `journal-chain.js:12`, `recall.js:98`.
  - `sha256Hex`: `conformance-attestation.js:57`, `engine-pin.js:34`, `template-sync-discovery.js:126`.
  - `readJsonIfExists`: `requirements-conformance.js:16`, `requirements-sequencing.js:36`, `requirements-stale-impact.js:12`.
  - `readJson`: `runtime-authority-hook.js:142`, `test-policy-run.js:70`, `test-policy-schedule.js:27`; and `guided-closeout.js:33` = `publishability-check.js:21`.
  - `isPlainObject`: `bootstrap-via-live-mcp.js:70`, `business-discovery.js:209`, `identity-v2.js:390`.
  - `normalizePath`: `affected-targets.js:9` = `canonical-derived-authority.js:21`. `toPosix`: `test-runner.js:167` = `template-sync-discovery.js:130`.
- **Simplification.** One `util` module for JSON, digest and path helpers. Each site imports it.
- **Reduction.** About 27 definitions and about 120 lines. 0 modules, 0 guards.
- **Risk.** Low. Pure functions with identical bodies. `stableStringify` feeds digests, so the moved copy must be byte-identical.
- **Ticket (proposed).** "Hoist identical JSON, digest and path helpers into one util module."
- **Acceptance.** Every listed site imports the shared helper. `stableStringify` output is unchanged for the existing fixtures. The arch prodloc total drops by at least 100 lines.

### F-02. `gitFileMode` exists three times, and the shared copy is not shared (rank 2)
- **Evidence.** `file-mode.js:12-14`, `engine-pin.js:41-43`, `tree-fingerprint.js:103-106`. All three return `(mode & 0o100) ? 0o755 : 0o644`. Only `coord-upgrade.js:53` imports `file-mode.js`. `engine-pin.js` never requires it, although its comment says it does.
- **Simplification.** `engine-pin.js` and `tree-fingerprint.js` import `file-mode.js`.
- **Reduction.** About 6 lines. 0 modules.
- **Risk.** Low.
- **Ticket (proposed).** "Make file-mode.js the only gitFileMode; engine-pin and tree-fingerprint import it."
- **Acceptance.** `grep -rn "0o755 : 0o644"` finds one hit. Engine-pin and tree-fingerprint tests pass unchanged.

### F-03. Duplicate `ghPrListMergedByBase` and two gh spawn wrappers (rank 3)
- **Evidence.** `landing-gh.js:163` and `landing-gh.js:168` (identical). `landing-gh.js:302` `runGh` and `board-push-preflight.js:65-71` `createDefaultGh`.
- **Simplification.** Delete the first definition. Let `createDefaultGh` take `runGh`'s spawn, with timeout and env as options. Keep the difference in failure semantics explicit.
- **Reduction.** About 20 lines. 0 modules.
- **Risk.** Low for the delete. Low to medium for the wrapper merge, because `runGh` throws and `createDefaultGh` returns a result.
- **Ticket (proposed).** "Remove duplicate ghPrListMergedByBase and align the two gh spawn wrappers."
- **Acceptance.** One `ghPrListMergedByBase` definition. Board push preflight keeps its timeout and `GH_PROMPT_DISABLED` behaviour, asserted by a test.

### F-07. Stale highWater caps (rank 4)
- **Evidence.** Measured against the `countLoc` rule (section 1.2):
  - `governance-validation.js` cap 1,218, measured 810 (408 unused).
  - `governance-context.js` cap 1,785, measured 1,765 (20).
  - `journal.js` cap 1,709, measured 1,696 (13).
  - `token-economics.js` cap 1,429, measured 1,426 (3).
  - `lifecycle.js` cap 2,131, measured 2,130 (1).
  - Doc drift: `arch-checks.js:193` says "requires highWater === measured" but `decomposition-proof-gate.js:375` checks only `>`.
- **Simplification.** Ratchet each cap to measured. Correct the comment.
- **Reduction.** 445 lines of allowed growth removed. No production LOC changes.
- **Risk.** Low. The policy is down-only, so this follows the existing rule.
- **Ticket (proposed).** "Ratchet prodloc highWater caps to measured LOC; correct the decomposition-proof comment."
- **Acceptance.** Each listed cap equals its measured value. `arch` passes. The comment matches `decomposition-proof-gate.js`.

### F-08. Guard merges and retirements (rank 5)
- **Evidence.** Section 3. Net **-9** from the registry's 5 merges, **-5** from its retirement candidates, and about **-5** from same-file pairs not yet proposed.
- **Simplification.** Accept the registry's merges and retirements. Review the same-file pairs for ADR 0021 coverage. Each merge keeps its refusal codes, so no blocker code disappears silently.
- **Reduction.** Up to **-19 guards** (103 to about 84). Code reduction is small.
- **Risk.** Low technical risk. The change is classification and needs human-admin review under ADR 0021.
- **Ticket (proposed).** "Apply the guard-registry merge and retirement proposals under ADR 0021, with per-merge coverage evidence."
- **Acceptance.** For each merge, `must_still_cover` items map to tests that still pass. Every blocker code emitted before the merge is still emitted, or is listed as retired.

### F-04. Duplicate CLI flag tables (rank 6)
- **Evidence.** `cli.js:834` VALUE_FLAGS, `:926` APPEND_FLAGS, `:941` SCALAR_TEXT_FILE_FIELDS, `:949` BOOL_FLAGS, `:1012` SPECIAL_FLAGS, against `lifecycle-flags.js:34`, `:86`, `:100`, `:107`. 161 keys have identical mappings.
- **Simplification.** Move the tables into one module, `flag-tables.js`. `cli.js` and `lifecycle-flags.js` both import it. The two `lifecycle-flags`-only flags are added to the shared table or stay local.
- **Reduction.** About 90 lines (the `lifecycle-flags.js` tables). 0 modules.
- **Risk.** Low to medium. Flags are the verb surface. `cli-surface.test.js` and the verb-flag-parity test cover the surface.
- **Ticket (proposed).** "Single source for CLI flag tables shared by cli.js and lifecycle-flags."
- **Acceptance.** One definition of each flag. `gov surface` output is unchanged (diff empty). The verb-flag-parity test passes.

### F-17. git() helpers (rank 7)
- **Evidence.** 32 files define `function git(`, 9 of them production (section 2b). Only 7 use `test-git-fixture.js`. `git-ops.js` has 16 importers.
- **Simplification.** Production copies use `git-ops.js`. Test copies use `test-git-fixture.js` (COORD-952), which already sets the hermetic environment.
- **Reduction.** About 40 production lines and about 120 test lines. 0 modules.
- **Risk.** Low to medium. Production copies differ in error handling (`gitTry` vs throwing), so each site needs a check.
- **Ticket (proposed).** "Route git helpers in production and test modules through git-ops and test-git-fixture."
- **Acceptance.** No `function git(` outside those two modules. Each migrated site keeps its error behaviour, asserted by a test.

### F-05. Policy-adapter skeleton repeated in five adapters (rank 8)
- **Evidence.** `defaultLookPath` has the same body in `a11y-policy.js:109`, `perf-budget-policy.js:84`, `sast-policy.js:95` and `supply-chain-policy.js:104`. `detectTool` has the same shape in `a11y-policy.js:145`, `mutation-policy.js:119`, `perf-budget-policy.js:130`, `sast-policy.js:114` and `supply-chain-policy.js:139`, with different env var names and tool order. `runCli` argv dispatch is in `a11y-policy.js:685`, `sast-policy.js:478` and `supply-chain-policy.js:608`. Read: `defaultLookPath` at 4 sites, `detectTool` at 2 sites, and `sast-policy.js:114-124` against `a11y-policy.js:145-160`.
- **Simplification.** One `external-tool-adapter.js` base for `lookPath`, `resolveBin`, `detectTool` (driven by a table of tool names and env vars) and `runCli`. Each adapter keeps its parsing and policy.
- **Reduction.** About 120-160 lines. Net modules 0 (one new base module).
- **Risk.** Medium. Five adapters and their tests change.
- **Ticket (proposed).** "Extract the shared external-tool adapter skeleton from the five quality policy modules."
- **Acceptance.** Each adapter's tests pass unchanged. `defaultLookPath` exists once. `detectTool` is table-driven.

### F-11. Journal NDJSON readers (rank 9)
- **Evidence.** Section 2b. The readers differ in output shape and in error handling.
- **Simplification.** One `readNdjsonRecords(path)` that returns `{line, record, index}` and skips only blank lines. Each caller maps the result. Chain verification in `journal.js` keeps its own strict reader. A silent skip must never reach the verifier.
- **Reduction.** About 45 lines. 0 modules.
- **Risk.** Medium. The silent skip in `journal-signing.js:228-232` is appropriate for display and wrong for verification.
- **Ticket (proposed).** "One NDJSON record reader for read-only journal consumers; the chain verifier stays strict."
- **Acceptance.** The verifier is unchanged and has a test that a torn line fails. The other consumers' output is unchanged on the existing fixtures.

### F-12. Terminal and alias verbs duplicated in cli.js (rank 10)
- **Evidence.** `cli.js:395` close, `:404` finish, `:421` finish-ticket. Each calls `runTerminalLifecycle` with the same handler, and only the label string differs. `:439-441` repair and return-doing have the same body. `:449-452` unstart and unstart-ticket have the same body. `:436-438` reopen falls through to reopen-ticket. `:443-448` start falls through to start-ticket. `:299-300` counts falls through to board-state. `:306-307` recommend falls through to next-ticket. `:309-310` run-ticket-cycle falls through to ticket-cycle.
- **Simplification.** An alias table maps alias to canonical verb. The journal label is still the name the user typed, so the audit trail does not change.
- **Reduction.** About 35 lines of `cli.js`. 0 modules, 0 guards.
- **Risk.** Medium. Verb surface, generated `surface` output and journal labels are visible to agents and adopters.
- **Ticket (proposed).** "Collapse alias verbs in the dispatch table; keep journal labels."
- **Acceptance.** Every verb still dispatches, and `gov surface` lists the same verbs. Journal events for `close`, `finish` and `finish-ticket` keep their labels.

### F-14. Lazy-require cycles and upward edges (rank 11)
- **Evidence.** Section 4: `affected-state` / `affected-landing` / `test-policy`, `cli` / `cli-surface`, and the three lazy requires of `lifecycle.js` from `command-registry.js:444` and `context-pack-ack-commands.js:91,243`.
- **Simplification.** Pass the callbacks in through the existing `deps` objects: `compareFullRun` into `affected-state`, `landingGateFor` into `test-policy`, `collectReviewPlanReadinessIssues` into `command-registry`, `lifecycle` commands into `context-pack-ack-commands`. `affected-state.js:107` already does this in part.
- **Reduction.** About 10 lines changed. 0 modules. Three cycles and four upward requires removed.
- **Risk.** Low to medium.
- **Ticket (proposed).** "Break the affected-state/landing/test-policy cycle and the cli/cli-surface cycle through injected deps."
- **Acceptance.** Madge-style check (or the section 4 script) shows no cycle among these modules. Tests pass.

### F-10. examples/demo is a diverged second copy of the engine (rank 12, decision needed)
- **Evidence.** `examples/demo/coord/scripts/` holds 529 `.js` files: 274 production modules, 100,033 production lines, plus about 78k test lines. It differs from the engine: `lifecycle.js` 2,925 lines vs 2,634 (`coord/engine/scripts/lifecycle.js`), `cli.js` 1,042 vs 1,234, `journal.js` 2,253 vs 2,269. The release script documents it as a "curated, read-only" exception (`release/build-public-release.sh:589-595`, COORD-138). `coord/engine/scripts/test-isolation-guard.test.js:146` runs the demo copy.
- **Simplification.** Generate the demo's `scripts/` from the engine at package time, or keep it curated and add a drift check that names each intentional difference.
- **Reduction.** Up to 274 modules and 100,033 production lines in the repo. Not counted in the engine totals in section 1.
- **Risk.** Medium to high. It is a shipped artifact and a standalone demo. The demo test depends on its own copy.
- **Ticket (proposed).** "Decide whether examples/demo/coord/scripts is generated or curated; enforce the decision with a drift check."
- **Acceptance.** The decision is recorded in GOVERNANCE.md. If generated, the demo tree is produced by the release build and CI fails on a diff. If curated, each divergence is listed and checked.

### F-09. Removable shims (rank 13, decision needed)
- **Evidence.** Section 5: 270 removable files, 2,635 lines. Two still referenced by live code (`prodloc-closeout.test.js` and `test-isolation-guard.test.js`). The rest appear only in journal, plan, board and manifest data.
- **Simplification.** Point the two live references at the engine path. Then retire removable shims in batches after the COORD-868 window closes.
- **Reduction.** 270 files, 2,635 lines. Two guards (`legacy-entrypoints`, `upgrade-bridge`) lose their reason to exist once the window closes (section 3).
- **Risk.** High for adopters, because the shims are shipped and adopter paths change.
- **Ticket (proposed).** "Redirect the two live shim references; retire removable shims in batches after the adopter window."
- **Acceptance.** Zero `coord/scripts/<path>` spellings in live code. Upgrade bridge test passes. Each batch is listed in the registry before removal.

### F-06. Process liveness rule split (rank 14)
- **Evidence.** Section 2b. `integration-authority.js:310` uses PID-only. `gate-proc-registry.js:197-199` uses PID plus start time. `directory-locks.js:30` is a third `/proc` parser.
- **Simplification.** One `process-identity.js` with `isSameProcess(pid, startTime)`. Make `directory-locks` and `gate-proc-registry` use it. Let `integration-authority` use start time too, falling back to PID-only when `/proc` is unavailable.
- **Reduction.** About 25 lines. 0 modules.
- **Risk.** Medium to high. A reused PID would now count as dead, so a lock could be reclaimed earlier. Reclaiming a lock that is still live is the failure mode to test for.
- **Ticket (proposed).** "One process-identity check (PID plus start time) for every lock and lease liveness decision."
- **Acceptance.** A test where the PID is reused with a different start time reclaims the lock. A test with `/proc` unavailable keeps the current PID-only behaviour.

### F-15. Base-ref resolution spread over six modules (rank 15)
- **Evidence.** Section 2b. Plus `ticket-commands.js:162` and `:197` repeat the commits-ahead check.
- **Simplification.** One `resolveBaseRef({repoRoot, base, explicit, mode})` with explicit modes for ticket, landing and worktree. Characterisation tests first.
- **Reduction.** About 35 lines. 0 modules.
- **Risk.** High. Landing and stale-base correctness depend on these rules.
- **Ticket (proposed).** "Characterisation tests for base-ref resolution, then one resolver."
- **Acceptance.** Characterisation tests for the six call sites pass before and after the change.

### F-19. Same-file repeats (rank 16)
- **Evidence.** `recall.js:632` / `:681`, `ticket-commands.js:162` / `:197` (both read).
- **Simplification.** Extract the shared preamble and the ahead-count into a local helper.
- **Reduction.** About 20 lines. 0 modules.
- **Risk.** Low.
- **Ticket (proposed).** "Extract the repeated BM25 preamble and commits-ahead check within their modules."
- **Acceptance.** Recall ranking output is unchanged on the existing fixtures.

### F-16. Two kill mechanisms in tests (rank 17)
- **Evidence.** `crash-window-child.js` (real SIGKILL) and `integration-authority.test.js` (`process.exit(9)` fault hooks).
- **Simplification.** Keep the real-process harness as the default. Move the in-process cases to it where the fault point is reachable.
- **Reduction.** Test lines only. 0 modules.
- **Risk.** Low. Low priority.
- **Ticket (proposed).** "Use the real-process crash harness for integration-authority kill windows."
- **Acceptance.** Each kill window in `integration-authority.test.js` has a `crash-window-child` scenario, or the exception is recorded.

### F-18. Staleness naming (rank 18, no reduction)
- **Evidence.** `computeStaleness` in `enterprise/org-rollup.js:105` (time) and `recall.js:765` (chain head) have the same name and different semantics.
- **Simplification.** Rename one.
- **Reduction.** None.
- **Risk.** Low.
- **Ticket (proposed).** "Rename one of the two computeStaleness helpers."
- **Acceptance.** No name collision across `enterprise/` and `recall.js`.

### Not findings
- The DI import lists that dominate the clone windows (`lifecycle.js:110-115` and similar). They are the cost of the factory pattern. Reducing them means changing the composition-root design, which is out of scope here.
- `lifecycle-help.js`. No dispatch duplicate. Its prose is checked by `verb-parity.js`.

## 7. Summary table

| Rank | Finding | Modules | Production LOC | Guards | Risk | Ticket title (proposed) |
|---|---|---|---|---|---|---|
| 1 | F-01 exact helper clones | 0 | ~120 | 0 | Low | Hoist identical JSON, digest and path helpers |
| 2 | F-02 gitFileMode triplicate | 0 | ~6 | 0 | Low | One gitFileMode, imported by engine-pin and tree-fingerprint |
| 3 | F-03 gh duplicates | 0 | ~20 | 0 | Low | Remove duplicate ghPrListMergedByBase; align gh wrappers |
| 4 | F-07 stale highWater caps | 0 | 0 (445 headroom) | 0 | Low | Ratchet prodloc caps to measured LOC |
| 5 | F-08 guard merges and retirements | 0 | small | **-19** | Low (governance) | Apply guard merges and retirements under ADR 0021 |
| 6 | F-04 CLI flag tables | 0 | ~90 | 0 | Low-Med | Single source for CLI flag tables |
| 7 | F-17 git() helpers | 0 | ~40 prod, ~120 test | 0 | Low-Med | Route git helpers through git-ops and test-git-fixture |
| 8 | F-05 policy adapter skeleton | 0 (+1 base) | ~140 | 0 | Medium | Shared external-tool adapter skeleton |
| 9 | F-11 NDJSON readers | 0 | ~45 | 0 | Medium | One read-only NDJSON reader; verifier stays strict |
| 10 | F-12 alias verbs | 0 | ~35 | 0 | Medium | Collapse alias verbs; keep journal labels |
| 11 | F-14 lazy cycles and upward requires | 0 | ~10 | 0 | Low-Med | Break three cycles through injected deps |
| 12 | F-10 examples/demo copy | 274 (not in engine count) | 100,033 | 0 | Med-High, decision | Generated or curated demo; enforce with drift check |
| 13 | F-09 removable shims | 270 files | 2,635 | -2 (after window) | High (adopters), decision | Redirect two live refs; retire in batches |
| 14 | F-06 liveness split | 0 | ~25 | 0 | Med-High | One process-identity check |
| 15 | F-15 base-ref resolution | 0 | ~35 | 0 | High | Characterisation tests, then one resolver |
| 16 | F-19 same-file repeats | 0 | ~20 | 0 | Low | Extract repeated preamble and ahead-count |
| 17 | F-16 kill mechanisms | 0 | test only | 0 | Low | Real-process harness for kill windows |
| 18 | F-18 staleness naming | 0 | 0 | 0 | Low | Rename one computeStaleness |

Cheap-and-safe subtotal (ranks 1-11): about **560 production LOC**, **0 modules**, **-19 guards** (guards only once the governance ticket lands).

## 8. Recommended ratchet values for COORD-976

Measured at 5fe838d8. Ratchets move down only, under the existing no-grandfather policy.

| Ratchet | Current | Recommended cap now | Notes |
|---|---|---|---|
| Guards (registry count) | 103 | **103** until F-08 lands, then **84** | Never up without an ADR |
| Production modules (`coord/engine/scripts`, excl. fixtures) | 350 | **350** | Net-zero rule: a new module needs a retired one |
| Production LOC total (prodloc rule) | 99,911 | **99,911** | Lowers with F-01, F-03, F-04, F-05 |
| `lifecycle.js` highWater | 2,131 | **2,130** | Matches measured |
| `governance-context.js` highWater | 1,785 | **1,765** | |
| `journal.js` highWater | 1,709 | **1,696** | |
| `plan-records.js` highWater | 1,540 | **1,540** | Already at measured |
| `token-economics.js` highWater | 1,429 | **1,426** | |
| `governance-validation.js` highWater | 1,218 | **810** | Largest unused headroom |
| `coord-upgrade.js`, `governance-mcp.js` | default 1,200 | explicit **1,200** | At the ceiling; set explicit so a one-line change shows |
| Registered shims (`shim-registry.json`) | 284 (270 removable) | **284** | No new shims |
| Demo copy modules (`examples/demo/coord/scripts`) | 274 | **274** | Freeze until F-10 decision |
| Non-test `.js` total under `coord/engine/scripts` (incl. fixtures) | 356 | **356** | Net-zero rule |

## 9. Limits

- Clone and helper detection used normalised hashes over 8-line windows. Results are candidates. Each cluster in section 6 was read at its sites. The 27-definition count in F-01 is hash-verified and sampled by reading, not read in full.
- The require graph is regex-based. It misses `require` calls built from variables, and it counts `require` text inside string literals unless filtered. Section 4 lists the edges after manual checks.
- Guard overlaps and merge candidates are from the registry and file locations. They were not checked against ADR 0021's coverage rules or against the guards' tests.
- Shim reference counts are lower bounds (section 5).
- No gate or test was run. Behaviour changes proposed in F-05, F-06, F-11 and F-12 need their tests run before merge.
- origin/dev moved during the run (5fe838d8, then 16d86f0c, then f7c02136). All figures are for 5fe838d8. Re-measure at the head before filing.
