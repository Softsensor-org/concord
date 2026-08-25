# ADR 0010: Install recovery treats its own write-ahead ledger and mutex as untrusted input

- **Status:** Accepted
- **Ticket:** COORD-625, COORD-642, COORD-656, COORD-660
- **Date:** 2026-08
- **Linked scope:** create-concord/lib/install-plan.js (shared engine), create-concord/bin/create-concord.js

## Context

ADR 0007 gave the installer a target-local write-ahead NDJSON ledger, on-disk
backups, and an `O_EXCL` mutex, and an explicit `recoverStaleInstall` verb that
reverses a crashed run's ledger. It recorded how the transaction is DURABLE. It
did not record how far the transaction is TRUSTED, and the implementation
silently assumed both artifacts were trustworthy:

- `replayLedger` joined each recorded path onto the target and acted on it. A
  ledger entry of `../victim.txt` deleted a file outside the workspace —
  reproduced under COORD-625.
- `recoverStaleInstall` unlinked the mutex unconditionally. A lock still held by
  a live installer was removed, destroying the mutual exclusion ADR 0007 relies
  on and letting a second installer run against a half-applied transaction —
  also reproduced.

The trust assumption is wrong for a structural reason, not an incidental one.
The ledger is precisely the artifact a CRASHED install leaves behind, and a
crashed install is the only situation in which recovery ever runs. It is a
plain file in a workspace that may be shared, synced, restored from a backup,
or left behind by a hostile or malfunctioning earlier run. It is therefore an
input the recovery code receives from its environment, not state it holds.

COORD-624's product-repo barrier and COORD-631's container barrier were already
present on the recovery path. Neither constrains WHERE a ledger-driven delete
lands inside or outside the workspace; they guard product repositories and the
workspace container specifically. Their presence is not containment, and this
ADR exists partly to stop that inference being made again.

## Linked Scope

- Linked ticket: COORD-660.
- Linked ticket: COORD-656.
- Linked ticket: COORD-642.
- Linked ticket: COORD-625.
- Governing ticket: COORD-625.
- Amends ADR 0007 (the ledger/mutex mechanism), which remains accepted.
- `create-concord/lib/install-plan.js` — `applyInstallPlan` (writer side),
  `recoverStaleInstall`, `replayLedger`, and the recovery guard helpers.
- `create-concord/bin/create-concord.js` — the `--recover` entrypoint.

## Decision Criteria

- A delete driven by an on-disk record must be held to AT LEAST the containment
  discipline COORD-475 already applies to install destinations. Deletes are more
  dangerous than writes and must not get the weaker standard.
- A ledger that fails validation must mutate NOTHING, rather than mutating up to
  the point of the first bad record.
- Recovery must be able to prove the ledger belongs to the workspace and
  transaction it is recovering, not merely that a ledger file is present.
- A lock file is evidence that an install STARTED, never that one ended.
  Liveness must be probed, and a probe that cannot answer must not be read as
  permission to proceed.
- Legitimate recovery of a genuinely crashed install must still succeed. A
  blanket refusal would satisfy the security requirement and destroy the feature.

## Options Evaluated

- **Validate, authenticate, and probe (chosen).** Canonicalize every ledger and
  backup path against the workspace with `lstat`/`realpath` in a whole-ledger
  pre-pass; bind the ledger to a workspace and a transaction id; probe the lock
  holder's liveness before removing the mutex.
- **Validate each entry as it is replayed.** Rejected: a ledger whose tenth
  record escapes the workspace would already have acted on nine, so the
  containment guarantee would be partial exactly when it matters.
- **Sign the ledger.** Rejected for Community for the same reason ADR 0006
  rejected signing the engine pin: there is no key distribution story, and the
  ledger and any local signing key live in the same workspace, so a signature
  would prove very little more than the ownership binding does.
- **Refuse recovery whenever anything is unusual (blanket fail-closed).**
  Rejected: recovery exists to rescue crashed installs, and a guard that
  refuses them all is not a fix.
- **Treat a stale-looking lock as dead by age (mtime heuristic).** Rejected: a
  slow install on a loaded machine is indistinguishable from a dead one by age,
  and guessing wrong destroys the mutex of a live installer.

## Decision

Install recovery treats the write-ahead ledger, the backups it references, and
the install mutex as UNTRUSTED INPUT, and refuses rather than guesses.

1. **Containment.** Every path a ledger record names is canonicalized against
   the workspace root with `lstat`/`realpath` before recovery acts on it.
   Absolute paths (POSIX, UNC and drive-letter), `..` escapes, symlinked final
   or intermediate components, case-fold aliases of existing entries, and
   references to the transaction's own staging area or mutex are each refused
   and named. Backup references must be plain names resolving inside this
   transaction's backup directory and must be regular files. Validation is a
   whole-ledger PRE-PASS: a ledger that fails any check mutates nothing at all,
   and the replay consumes canonicalized steps rather than ledger text.
2. **Ownership.** The `begin` record carries a transaction id and the canonical
   workspace path, and every later record carries that same id. A ledger lifted
   from another workspace, or a record spliced into a genuine one, is refused.
3. **Liveness.** The mutex records pid, host and transaction. Recovery probes
   the holder: a running holder refuses and the lock survives; `EPERM` from the
   probe proves the process EXISTS and counts as live; and an indeterminate
   result — no recorded owner, a foreign host, an unreadable or non-regular
   lock — fails closed with a message naming the lock and the operator's next
   step.

Refusals carry a single error code so a caller can distinguish "this ledger is
not trustworthy" from "the filesystem broke", and the `--recover` CLI reports
them as an operator decision point rather than a stack trace.

## Alternatives Rejected

- Per-entry validation during replay (partial containment).
- Cryptographic signing of the ledger in Community (no key distribution; the key
  and the ledger share a trust domain).
- Blanket refusal on any anomaly (removes the recovery feature).
- Age/mtime heuristics for lock staleness (cannot distinguish slow from dead).

## Consequences

- A ledger written by an engine older than COORD-625 carries no transaction id
  and will be refused. **No supported released channel produced the
  pre-COORD-625 transactional ledger format.** The released v0.1.8 SEA binary
  existed, but it predated the shared `install-plan.js` recovery engine and had
  no `--recover` flow. Unsupported source-checkout experiments may have old
  ledgers and will be refused explicitly. (This rationale is stronger than
  relying only on `create-concord` being unpublished, and was established by
  human-admin verification of the published v0.1.8 SEA assets and their donor
  commit.)
- **Before the first transactional release the ledger must carry an explicit
  schema version.** The shape today is identified only by implicit field
  detection — the presence of `begin.transaction` / `begin.workspace` / per-record
  `txn`. That is adequate for an unpublished engine and inadequate once a format
  is in the field: after publication, format changes must use **versioned
  migration or versioned refusal**, never implicit field detection. Tracked as a
  release-gating ticket ahead of COORD-617.
- A mutex written by an older engine records no owner and yields an
  indeterminate probe, so recovery fails closed and instructs the operator to
  remove it by hand after confirming no installer is running. This is
  deliberate: the alternative is guessing about deleting a live installer's lock.
- Recovery now refuses a case-fold alias even on case-sensitive filesystems,
  because the recorded name and the on-disk name are not the same name either
  way. Installation already refuses to CREATE such a pair (COORD-475), so a
  genuine ledger cannot contain one.
- The ledger's on-disk shape gained `begin.transaction`, `begin.workspace` and a
  per-record `txn`. The fields are additive.
- Validation costs one pre-pass over the ledger with a bounded `readdir` per path
  segment. Measured on the real donor payload: 1141 records validated and
  replayed in ~0.4s with zero anomalies.

## Implementation Status — 2026-08-05

The Consequences above are the record as written when this decision was accepted
and are deliberately **not** rewritten. This section tracks delivery against them.

> COORD-642 delivered explicit schema-version validation for transaction ledgers.
> This does not close the equivalent install-mutex requirement; mutex format
> detection remains implicit and is tracked separately.

- **Ledger — delivered (COORD-642).** The ledger `begin` record now carries an
  explicit `ledger_schema` (`concord.install/ledger/v1`), and recovery refuses an
  absent, superseded, newer or malformed version distinctly, each with its own
  operator remediation, while a current-version ledger still recovers a genuinely
  crashed install. The newer-version case refuses forward-compatibly rather than
  reporting corruption.
### Superseded status recorded 2026-08-05

Retained **verbatim** as it stood before COORD-656 landed, so the sequence is
legible: the ledger half shipped first and the mutex half was release-blocking in
the interval. Superseded by the current status below; not rewritten.

> - **Mutex — NOT delivered, tracked by COORD-656 (P0, release-blocking).** The
>   install mutex writes a `schema` field that `probeInstallLockLiveness` never
>   reads; it identifies the format by `Number.isInteger(holder.pid)` and
>   attributes an absent pid to "an older engine". That is the same implicit field
>   detection this ADR exists to eliminate, on the artifact this ADR names
>   alongside the ledger.
>
> This ADR must therefore **not** be described as wholly implemented until
> COORD-656 lands. The window closes at first release: after publication, a mutex
> format change would require exactly the implicit-detection migration this
> decision forbids.

### Current status as of 2026-08-06

- **Mutex — delivered (COORD-656), 2026-08-06.** The mutex now declares
  `lock_schema` (`concord.install/mutex/v1`) through a single writer, with what
  the version implies **derived** from that writer, so reader and writer cannot
  drift. `probeInstallLockLiveness` validates the declared version **before any
  other property of the record is believed** — before `host`, before `pid`,
  before probing the holder — and refuses absent, superseded, newer and malformed
  versions distinctly, the newer case forward-compatibly. The former
  `Number.isInteger(holder.pid)` FORMAT test is gone; the same check survives only
  as a *completeness* test inside version validation, because v1 promises a pid.
  Content that is not a readable record at all remains **indeterminate**, as this
  ADR requires — it declares no version to validate.

### Both halves of the trust boundary are now closed

The decision above names the ledger, the backups it references, and the mutex as
one boundary. As of COORD-656 all three are validated rather than inferred, and
**this ADR may now be described as implemented** for the artifacts it names.

The liveness contract is preserved exactly and was proven in both directions on a
valid current-version mutex: a **live** holder still refuses recovery and its lock
**survives**, and a **dead** holder is still **reclaimable** with the workspace
restored. `EPERM` still proves the process exists and counts as live; an
indeterminate probe still fails closed. That preservation is the standing guard
against the blanket fail-closed this ADR rejected by name.

**Not closed, and outside this ADR's scope:** the install receipt
(`coord/.concord-install-receipt.json`) and the engine pin
(`coord/.coord-engine.json`) still write a `schema` their readers do not assert.
Neither is named by this decision, and neither is release-blocking. Note also
that the schema-guard pattern is now **duplicated across the ledger and the
mutex rather than factored**; a third instance is the point at which extracting a
shared helper is worth the cross-surface work.

## Operator Note — recording ADR compliance at closeout

The ADR gate's own remediation hint is wrong (COORD-641, open, P2). It tells you
to run:

    coord/scripts/gov update-plan <ticket> --closure "ADR compliance: ..."

which the closure validator then **rejects**, because a closure line must begin
with one of the recognised prefixes (`Ticket ask:`, `Implemented:`, …). The
mechanism is fine; only the advice is broken. The form that works, and that was
used to close COORD-625:

    coord/scripts/gov update-plan <ticket> --closure "Implemented: ADR compliance: ..."

Use the prefixed form until COORD-641 lands. Do not hand-edit the plan record.

## Revisit Trigger

Revisit if the installer gains a legitimate need to act on paths outside the
workspace root (for example, a multi-workspace transaction), or if a supported
channel begins distributing a signing key, which would make a signed ledger a
real option rather than a theatrical one.
