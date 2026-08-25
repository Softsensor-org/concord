# COORD-665 live-harness 2x2 evidence (session a662-mso2zgge, thread fd3da49d)

Canonical HEAD 89085dde. Lock: COORD-665 held by claudea662.

## Slot-2 delivery verdict: PAYLOAD IS DELIVERED

Ledger record 118: tool="Bash", actor_resolved=true, actor_owner="claudea662",
action_id="toolu_01LQseAZ47eyJWGFGwffXyoY" (a real tool_use_id), decision="deny",
code="shell_canonical_write". Not "unknown", not "no_write_target".

All 117 payload_unavailable records predate the restart (2026-08-10T19:40-19:42Z),
i.e. the unloaded-wiring session. ZERO payload_unavailable in this session.
Conclusion: the rollback trigger is ABSENT. Do NOT roll back activation.

## Cell 1 - lock + payload, ordinary Bash: PERMITTED

`echo CELL-1-PROBE...; date -u` at 2026-08-11T03:09:06Z returned normally.
No ledger record written, which is expected: decide() allows, and the ledger
write is gated on deny-or-ticket with no ticket resolved on an allow.

## Cell 2 - lock + canonical write: REFUSED, bytes intact

Attempt: printf ... >> coord/GOVERNANCE.md
Refusal: CONCORD DENY [shell_canonical_write] naming the correctly resolved path.
sha256 before == after == 2ac0dc81e894bd69698c2c2db4bddbf00f23720285466876f84819a36a1c1021
board/tasks.json unchanged: 2ef8dcc436200be70f418887fafb2fb9dcbf8b68357f19e1d90dcec34d36a08d
Probe string absent (grep -c = 0); file clean in git status.

## Cell 3 - lock + in-worktree activity: PERMITTED

Append to coord/.worktrees/claudea662/COORD-665/.cell3-probe.txt succeeded.
COORD-645-F2 / COORD-648 accepted limitation preserved.

## Cell 4 - no lock: PERMISSIVE on all three arms

Lock released by the normal submit transition (doing -> review), NOT by unstart.
Verified lock-free first: coord/.runtime/locks/ empty, gov explain lock = None.

- Canonical write, the exact operation refused in cell 2:
  `printf ... >> coord/GOVERNANCE.md` -> EXIT=0, PERMITTED.
  sha256 moved 2ac0dc81... -> d01794e09830775073576bf4def2f21400c2acade9ada5bd272a184178947f49,
  probe string present (grep -c = 1). Barrier fully disengaged.
- Restored with `git checkout --`; sha256 back to the baseline
  2ac0dc81e894bd69698c2c2db4bddbf00f23720285466876f84819a36a1c1021, probe absent.
- Shell redirect to a new canonical-dir path: PERMITTED.
- Destructive shell (`rm -f`) - the operation refused as destructive_shell under
  lock: PERMITTED lock-free.

Ledger behavior: cell 4 produced ZERO records, confirming the ticket's model that
with no lock decide() returns allow/no_active_lock and the ledger write is gated
on deny-or-ticket. Records 119-122 are the accumulated lock-held denials from
cells 2 and 3 (GOVERNANCE.md, the $w false positive, the "Stop" false positive,
and the rm), each with reason text counting "1 governed lock(s) are active".

VERDICT: all four cells demonstrated. The barrier engages precisely at the lock
boundary and disengages entirely outside it.

## GATE EVIDENCE

env -u COORD_SESSION_ID node --test on the four runtime-authority suites:
59 tests, 59 pass, 0 fail.
canonical-derived-authority.test.js: 5 tests, 5 pass, 0 fail.
governance-validation + plan-records + lifecycle: 130 tests, 130 pass, 0 fail.

## DEFECTS FOUND (new, outside COORD-663 scope)

D1. Shell variables are not expanded before path classification. A write to
    "$w/.cell3-probe.txt" was denied with resolved path "<repo>/$w/.cell3-probe.txt".
    Legitimate in-worktree writes are refused whenever the target is held in a
    shell variable. False positive that blocks real work.

D2. Heredoc bodies are tokenized as shell syntax. Writing this very file via
    `cat > <in-worktree path> <<'EOF'` was denied with resolved target
    "<repo>/Stop" - the word "Stop" was lifted out of English prose in the
    heredoc body and treated as a redirect target.

D3. Same root cause, read-only surface: `python3 - "$f" <<'PY'` (a pure read of
    the ledger) was denied as shell_canonical_write with resolved target
    "<repo>/=", apparently from tokenizing the `f=...` assignment.

D4. Ledger record 118 has ticket=null despite exactly one active lock for
    COORD-665, while the refusal reason text does count "1 governed lock(s)".
    Actor attribution resolves; ticket attribution does not.

Net: the barrier fails CLOSED and over-broadly, not open. No canonical byte was
ever at risk. But D1-D3 make ordinary governed work refusable, and D2/D3 refuse
commands that write nothing at all.

## DISPOSITION (human ruling, 2026-08-11)

D1, D2, D3 are COORD-663 ACTIVATION BLOCKERS, not adjacent defects. Activation
made previously dormant false positives operational: the live barrier refuses
read-only commands (D3) and legitimate in-worktree writes (D1). COORD-663
requirement 5 is therefore NOT met. COORD-663 returns to doing with these as
verified blockers.

D4 (ticket attribution null under an active lock) is a non-blocking follow-up.

NONE of D1-D4 are implemented in COORD-665. This child is evidence-only by
construction and carries no implementation scope.

## LIFECYCLE NOTE

Cell 4 is inherently a post-submit / pre-finalize proof: it requires that no
lock be held, and COORD-665 holds the only one. The lock is released by the
normal submit transition, NOT by unstart - once this evidence is committed the
ticket has accrued workspace evidence and unstart should fail closed.
