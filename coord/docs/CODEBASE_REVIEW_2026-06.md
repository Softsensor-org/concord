# Coord Engine — Codebase Review (2026-06)

Full read-only review of `coord/scripts` (the governance engine), run as 4 parallel
review agents across **correctness**, **architecture**, **security/integrity**, and
**test-quality / recently-landed code**. Findings are de-duplicated and severity-ranked;
`✓✓` marks issues independently flagged by more than one reviewer.

**Status:** findings recorded here for triage. Some are already filed
(COORD-262..265). The rest are to be turned into tickets later. Nothing in this review
mutated the repo.

## Verdict

The engine is functionally strong and well-tested at its core (the single-writer
transaction/lock/chain code is genuinely well-covered, RBAC is clean deny-by-default,
the open-core boundary is intact — `arch-checks` reports `imports=0`). But the review
found **real integrity bugs, a trust-anchor weakness, structural debt, and quality gaps
in the brand-new requirements-assurance code**.

## P1 — Critical (integrity / correctness)

1. **Stale-by-age lock reclaim can evict a *live* holder → two concurrent writers → hash-chain corruption ✓✓.**
   `governance-context.js:207-209`. Staleness is `staleByAge OR staleByDeadOwner`, and the
   lock dir mtime is written once at acquire and never refreshed. A governed mutation that
   runs longer than `GOVERNANCE_EVENT_LOCK_STALE_MS` (~2 min — a large `gov sync` + push, or
   clock skew) can have its runtime lock stolen by a waiter while still running, admitting two
   concurrent journal appenders — the exact corruption the lock exists to prevent.
   *Fix:* only age-reclaim when the PID is actually dead/foreign, or heartbeat the lock mtime
   during long holds. (The double-reclaim arbiter at `:213-236` is sound; this is the live-holder case.)

2. **Misspelled opt-out flag silently breaks recovery.**
   `board-rebuild.js:82`, `agent-commands.js:273/350/505/721/775` set
   `allowRecoverableProvenanceDrift`, but the COORD-220 seal only reads `allowProvenanceDrift`.
   Worst case: `gov rebuild-board` is a *recovery* verb for a drifted board, yet board drift is
   exactly what the seal refuses on → rebuild fails closed precisely when it is needed.
   *Fix:* rename the flag at all five sites to `allowProvenanceDrift`.

3. **Attestation provides integrity but zero *authenticity*.**
   `conformance-attestation.js:293-304`. `verify()` checks the ed25519 signature against the
   public key embedded *in the same artifact*. Anyone can tamper the subject, re-sign with their
   own key, embed it → `signature_valid: true`. For the ENT-007 "central re-hash" trust story
   this is a full bypass.
   *Fix:* verify against a pinned org trust root (configured public key / fingerprint allowlist),
   not the embedded key. (Confirms the previously-noted local-signing/trust-anchoring risk.)

## P2 — Significant

4. **`lifecycle.js` is a 6,115-line god-module ✓✓ and its size gate is toothless.**
   It wires 40+ modules + re-exports a huge `__testing` facade. The `monolith` arch-check budget
   (5000 LOC, set by COORD-094) is exceeded (5,378 code LOC), but the arch gate is **warn-first
   severity** — it never fails, so the file regrew past budget after the single-writer/memory/REQ
   work. Earlier decomposition (COORD-051/091/097/107) worked but was not protected.
   *Fix:* set this file's monolith check to `severity: fail` or ratchet it (fail on growth vs
   baseline), so new work must extract rather than append; continue splitting the composition root.

5. **1,633-key `EXPECTED_TESTING_KEYS` frozen facade is structurally brittle ✓✓.**
   `governance.test.js:20-367` asserts an exact `deepEqual` of every `__testing` export name.
   Every new export forces a manual edit; it has tripped repeatedly and is a merge-conflict magnet.
   *Fix:* assert a required-subset / presence check instead of full frozen equality, or auto-derive.

6. **Seal bypass via journal deletion.** `journal.js:1376-1408`. Hand-edit the board, `rm` the
   journal → the next `gov` re-baselines the tampered state as clean genesis (no drift, no refusal).
   *Fix:* refuse to auto-baseline when governed coordination files exist but the journal is absent
   (require explicit `gov recover`/reconcile).

7. **`repair-chain` can launder content tampering.** `journal.js:1080-1271`. It re-stamps
   `prev_event_hash` over events in current file order without verifying that only *linkage* (not
   event *content*) changed; an edited event body can be re-linked into a chain that passes verify.
   *Fix:* require the before/after event content-hash multiset to be identical (pure re-link only).

8. **COORD-246 baseline-advance can absorb a concurrent genuine hand-edit.** `lifecycle.js:4757`.
   The post-mutation baseline advance re-baselines whatever drift exists at that instant, so a real
   hand-edit landing in the window between the mutation and the advance is silently legitimized.
   *Fix:* scope the advance to the specific paths the just-completed sync rewrote.

9. **The new `requirements-*` epic has real quality gaps (landing now).**
   - Zero dispatcher-level tests for the 11 `requirements-*` subcommands (`coord-cli.test.js` only
     covers `init`/help) — a wiring typo ships green.
   - The `requirements-*` entries ignore injected `deps` (always bind real cwd/fs → untestable);
     `init/conformance/upgrade/doctor` do thread `deps`. Inconsistent DI seam.
   - `requirements-import.js` double-reads each source (uses `deps.fs` then module `fs`) and has
     **no duplicate-requirement-ID detection** (`buildRegistry` hardcodes empty `links`/`findings`).
   - Bare `JSON.parse(fs.readFileSync())` with no try/catch in `requirements-linkage/traceability/
     evidence-policy/...` → raw stack traces on a malformed board/registry instead of a clean error.
   *Fix:* table-driven dispatch tests; thread `deps`; single read; dup-ID check; wrap JSON parses.

10. **Secret detector misses nested / non-string / high-entropy values ✓✓.**
    `memory-classification.js:115-200` only inspects top-level string fields; a secret nested in a
    recall citation object/array surfaces unredacted. *Fix:* recurse + add an entropy fallback.

11. **Two CLIs overlap.** `gov` and `coord` both expose `doctor` + `conform/conformance` — "which
    CLI?" confusion + divergent-behavior risk. *Fix:* one delegates the shared verbs to the other.

12. **`parseFlags` duplicated ~80 lines across `lifecycle-flags.js` and `cli.js`** — flags can parse
    differently by path. *Fix:* one canonical flag module.

13. **`createJournal(deps={})` destructures ~30 collaborators with no validation** (`journal.js:9-32`)
    → a missing/renamed dep fails late and opaquely deep inside a hash-chain append. *Fix:* validate
    deps at factory entry.

14. **Ordering-fragile near-circular DI** between `closeout.js` and `ticket-transitions.js`
    (`closeout.js:10-19`) — enforced only by wiring order + a comment. *Fix:* extract the shared
    readiness gate into a leaf module.

15. **agent-state lock writes no owner metadata** (`governance-context.js:282`) → a dead holder
    can't be liveness-reclaimed (blocks for the full 60s age window). *Fix:* write lock metadata
    like the other two locks.

16. **Memory history-grounded tests depend on the LIVE journal + magic queries**
    (`decision-extractor.test.js:157`, `recall.test.js` hardcoded `"COORD-159 bootstrap risk"`) →
    can break as history grows. *Fix:* ground against a committed fixture corpus.

17. **`memory-corpus-guard.js` skips a whole memory test class on the stripped cut and has no test
    of its own**; some redaction tests early-`return` green when ENT-012 is absent. *Fix:* unit-test
    the guard; run at least one redaction assertion against a synthetic corpus unconditionally.

## P3 — Lower

- SHA-1 unkeyed chain/leaf hashing (`journal.js:35-37,70`) vs SHA-256 attestation — chain
  tamper-evidence relies on the git-tracked copy + signed head, not hash strength. Move to SHA-256.
- Attestation has no nonce/instance-id/expiry (`conformance-attestation.js:202-256`) → replayable.
- `nextTicketId` (`followups.js:94-106`) reserves only against live board rows, ignoring the
  journal → historical ID reuse if a row is ever removed (the COORD-198/225 class).
- `detectGovernanceProvenanceDrift` hard-fails (bricks all `gov`) if the latest snapshot artifact
  was pruned (`journal.js:401-406,580`) — COORD-105/108 make snapshots prunable. Fall back to re-baseline.
- Release secret scan skips binaries (`check-public-release.sh:175-183`, `grep -rIlE`) — a credential
  in a binary blob can ship.
- Dead `requiresPrIndexGovernance` (`lifecycle.js:2507`); gate-result-shaping duplication across
  `analytics/content/infra` gates.
- One real `t.skip` to confirm: `deploy-gate-contract.test.js:81`.

## Already filed (this review's earlier pass)

- **COORD-262 (P1):** rollback snapshot omits `prompts/` + `rendered/` → failed txn leaves
  un-rolled-back drift that then trips the seal and blocks the engine.
- **COORD-263 (P2):** terminal verbs don't reap the session → co-located guard false-blocks
  back-to-back single-agent work for the 4h heartbeat window.
- **COORD-264 (P2):** COORD-223 idempotency-on-retry is dormant — no real verb passes an `idempotencyKey`.
- **COORD-265 (P2):** `gov doctor` calls `runBoardSync` (mutates) — violates its own "doctor detects,
  never mutates" rule (COORD-243); the source of recurring working-tree drift.

## Genuinely solid (confirmed)

- RBAC deny-by-default + fail-safe redaction (`enterprise-rbac-policy.js`).
- The lock double-reclaim arbiter (atomic rename + inode check, `governance-context.js:213-236`).
- `repair-chain` fails closed (re-verifies before commit).
- The journal is git-tracked — an external review anchor that materially mitigates the
  SHA-1 / laundering / re-baseline risks **if reviewers actually diff the journal**.
- The single-writer epic's own tests (`file-ticket.test.js`, `concurrent-burnin.test.js`) are
  fully sandboxed and assert deterministic invariants — the quality bar for the rest of the suite.
