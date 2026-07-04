# Known Issues

Softsensor Concord is at an early, honest pilot stage (**v0.1.0**). This document
lists the issues adopters are most likely to hit, each with a clear **Status** and a
**Workaround / Fix**. Most of the historically painful items have already landed
fixes; a couple remain mitigated with documented guidance.

Status markers:

- **Fixed (v0.1.0, COORD-xxx)** — resolved in the shipped code; no manual workaround needed.
- **Mitigated** — a safe, supported path exists; follow the guidance below.
- **Live (workaround)** — not yet fully resolved; use the workaround.

---

## 1. Multi-agent topology — sub-agents collapsing onto one session

**Status: Fixed (v0.1.0, COORD-015)**

When running the *one orchestrator conversation spawning N Claude sub-agents*
topology, every sub-agent used to collapse onto a single governance session and
churn each other's claims. The Claude Code harness injects one identical
`CLAUDE_CODE_SESSION_ID` into every sub-agent of a conversation, and
`CLAUDE_SESSION_ID` cannot override it (the harness sets it equal to
`CLAUDE_CODE_SESSION_ID`, which is checked first).

This is fixed via the authoritative **`COORD_SESSION_ID`** anchor, which overrides
both harness variables on the fingerprint and binding paths. Each sub-agent exports
a distinct `COORD_SESSION_ID` before any `gov` call and claims a distinct registered
handle.

Codex and Gemini provider threads isolate natively and do not need this override.

See [`coord/docs/MULTI_AGENT_TOPOLOGIES.md`](coord/docs/MULTI_AGENT_TOPOLOGIES.md)
for the full topology matrix and per-provider identity rules.

---

## 2. Recording multiple self-review cycles

**Status: Mitigated**

When recording multiple self-review cycles on a ticket, prefer the batch path:

```
gov set-review-cycles <ticket> --review-cycle "<cycle 1>" --review-cycle "<cycle 2>" ...
```

`set-review-cycles` replaces all recorded cycles at once, which avoids the
surprises that come from repeated single appends. Use it instead of issuing several
single-cycle calls in a row.

---

## 3. Provider session drift, same-owner handoff, and identity collisions

**Status: Mitigated**

Session identity is anchored on `COORD_SESSION_ID` (see item 1), with an additional
runtime fingerprint derived from `/proc/self/stat` on POSIX hosts so that
distinct processes do not collide even when env-var fingerprints are absent.

If your provider session drifts or you need to hand work off:

- **Same-owner handoff** (resuming your own in-flight ticket from a new session):
  `gov resume <ticket>` rebinds the governed ticket lock into the current claimed
  session.
- **Identity collisions** (two agents fighting over one handle): `gov agent-rebind --fresh`
  releases the current binding and claims a new unclaimed handle. This is the
  canonical escape hatch; it fails closed if the provider handle pool is exhausted.

**Ownership can no longer silently drift.** As of the registration/binding guard,
a governed *mutation* (`commit`, `update-plan`, `move-review`, `finalize`,
`heartbeat`, `add-repo-gate`, …) refuses to proceed unless the acting session is
**both** a registered agent **and** the bound owner of the ticket. Previously,
work committed by an unregistered/unbound session could not be attributed during
reconciliation and the ticket reverted to `todo`/`unassigned`; that failure mode
is now closed. The remediation message points you at the exact register → bind →
resume/rebind sequence. See
[`coord/docs/MULTI_AGENT_TOPOLOGIES.md`](coord/docs/MULTI_AGENT_TOPOLOGIES.md)
(*Operating model — mandatory registration + binding*).

---

## 4. `gov start` branching from a stale base

**Status: Fixed (v0.1.0, COORD-125)**

`gov start` previously branched from whatever the local base ref happened to be,
which could be stale. It now freshens from `origin/<base>` before branching, using a
configurable base ref with the following precedence (highest first):

1. per-repo `startBaseRef`
2. top-level `defaultStartBaseRef`
3. per-repo `integrationBranch`

These keys live in [`coord/project.config.js`](coord/project.config.js). When the
remote is unreachable, `gov start` falls back gracefully to the local base. You no
longer need to run a manual `git fetch && git rebase` after `gov start`.

---

## 5. Architecture / quality gate could not distinguish new from pre-existing findings

**Status: Fixed (v0.1.0, COORD-126)**

The architecture / quality gate was strictly binary: it could not tell findings that
were *introduced on the current ticket* apart from findings that already existed on
the base branch, so adopters inheriting a non-pristine codebase could be blocked by
pre-existing debt.

An opt-in **ratchet** mode is now available. In ratchet mode the gate fails only on
**new** findings (those not present at the baseline) and reports pre-existing
findings as informational. Enable it per invocation with `--ratchet`
(optionally pinning the comparison point with `--baseline <ref>`), or persistently
via `archGate: "ratchet"` in the gate config. The default remains the absolute
budget, so existing behavior is unchanged unless you opt in.

The ratchet implementation lives in
[`coord/scripts/arch-checks.js`](coord/scripts/arch-checks.js).

---

## 6. Concurrent governed agents against one shared checkout

**Status: Mitigated**

Running multiple governed agents — those calling `gov start` / `gov commit` /
`gov finalize` — concurrently against **one shared checkout** corrupts the
hash-chained governance journal (crossed `prev_event_hash` links) and causes the
agents to fight over the working tree.

**Guidance:** run governed agents **one at a time per checkout**, or give each agent
its **own git worktree and a separate `coord/.runtime`** so their journals and
working trees never overlap.

**Recovery:** if the chain has already been crossed, re-link it with an auditable,
on-chain repair marker:

```
gov repair-chain --confirm --reason "<why the chain needed repair>"
```

Without `--confirm`, `repair-chain` is a read-only dry-run.

---

## 7. Sandboxed sub-agents cannot push to a remote

**Status: Mitigated (by design)**

A sub-agent running in a sandboxed or policy-restricted environment cannot
`git push` / `gh pr create` to an external remote: outbound egress is blocked by
the sandbox (DNS + exfiltration policy). This is **correct security behavior**,
not a bug — sandboxed workers should not publish unsupervised.

**Guidance — implement-locally / orchestrator-publishes:** the sub-agent does all
the work, commits to a **local topic branch**, runs the full local verification
bar, and reports the branch name and commit SHA. The **orchestrator (or a human)**
then performs the single approved remote push / PR / merge and closeout
(`move-review` / `finalize`, or `finalize --already-landed` once merged). See
[`coord/docs/MULTI_AGENT_TOPOLOGIES.md`](coord/docs/MULTI_AGENT_TOPOLOGIES.md)
(*Implement-locally / orchestrator-publishes*) for the full pattern.

---

## Reporting new issues

If you hit something not listed here, please open an issue. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute fixes and learnings, and the
[README](README.md) for the full skill and governance reference.
