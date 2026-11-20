# ADR 0007: Installer transactions use a target-local write-ahead ledger with on-disk backups, not VCS snapshots

- **Status:** Accepted
- **Ticket:** COORD-475, COORD-618
- **Date:** 2026-07
- **Linked scope:** create-concord/lib/install-plan.js (shared engine), create-concord/bin/create-concord.js, release/sea/sea-entry.js; COORD-618 retires init.sh as an installer

## Context

COORD-475 makes every Concord delivery channel (npm `create-concord` and the
standalone SEA binary) transactional and
no-clobber when installing into an occupied adopter repository. The acceptance
criteria require that a concurrent install, crash, permission failure, or
disk-full condition end in restored prior bytes or an **explicit recovery
result** — never an unexplained partial state. That requires some durable
record of in-flight mutations. The installer runs in hostile conditions: the
target may not be a git repository, may be dirty, may contain untracked secret
files (`.env*`), and the install must never read secret paths, execute adopter
code, or mutate protected product repositories.

## Linked Scope

- Linked ticket: COORD-618.
- Linked ticket: COORD-475.
- Governing ticket: COORD-475.
- `create-concord/lib/install-plan.js` — the single shared planner/applier.
- `create-concord/bin/create-concord.js` and `release/sea/sea-entry.js` — thin
  channel callers. COORD-618 retired the donor-only `init.sh` compatibility shim
  after proving its engine path cannot survive the public-cut strip list; the
  shim now refuses without writes and is absent from release artifacts.
- `release/build-linux-binary.sh` — build-time archive guard.

## Decision Criteria

- Recovery must work on targets that are NOT git repositories (git cannot be assumed).
- The mechanism must never stage/commit adopter files (a `git stash`/commit
  snapshot would ingest untracked secrets into VCS objects — forbidden by the
  ticket's secret-hygiene contract and ADR 0002's canonical/ephemeral split).
- Replaced bytes must be restorable byte-exactly after SIGKILL at any point.
- The record must be inspectable and machine-readable for an explicit recovery
  verb, and must vanish on success (no durable litter beyond the receipt).
- One implementation must serve npm, SEA, and shell channels identically.

## Options Evaluated

- **Target-local write-ahead ledger + on-disk backups (chosen):** before each
  mutation, current bytes are copied into `.concord-install.staging/backups/`
  and an NDJSON ledger entry is appended; apply holds a `.concord-install.lock`
  mutex (O_EXCL). Rollback and `recoverStaleInstall`/`--recover` reverse the
  ledger. Staging is removed on success; forced-replacement backups are
  preserved under `coord/.concord-install-backups/<digest>/` and referenced by
  the receipt.
- **Git-based snapshots (stash/temp commit/worktree):** rejected — requires a
  git target, mutates the adopter's repository state, and would copy untracked
  secret files into git objects.
- **In-memory backups only (pre-COORD-475 behavior):** rejected — restores on
  thrown errors but loses all replaced bytes on a crash/SIGKILL, leaving the
  exact unexplained partial state the ticket forbids.
- **Full pre-install tree copy:** rejected — unbounded cost on large adopter
  repos and still needs a completion marker to be crash-safe.

## Decision

The shared install engine (`create-concord/lib/install-plan.js`, the single
policy implementation for all three channels) implements transactions as: an
exclusive target-local install mutex; a write-ahead NDJSON ledger persisted
with per-file on-disk backups in private staging before any byte is mutated;
phased apply (files → capabilities → ownership → init → onboard → receipt)
with full reverse-ledger rollback on failure; and an explicit
`recoverStaleInstall` (CLI `--recover`) that reverses a crashed run's ledger.
A crashed run intentionally leaves the mutex and staging in place so the next
install fails closed with a recovery instruction instead of proceeding.

## Alternatives Rejected

- VCS-based snapshotting of the adopter workspace (secret ingestion, git-only).
- Best-effort cleanup without a durable ledger (unexplained partial states).
- Per-channel transaction implementations (npm/SEA/shell divergence was the
  root regression class in COORD-449/450/453).

## Consequences

- Crash recovery is possible on any filesystem target, including non-git ones.
- A crashed install leaves `.concord-install.lock` + `.concord-install.staging/`
  behind by design; the explicit `--recover` verb (or `recoverStaleInstall`)
  restores and clears them. Documentation of the refusal message covers this.
- Forced replacements retain their backups after success (receipt-owned
  uninstall information), a deliberate disk-space-for-auditability trade.
- The ledger/staging directory names are reserved inside a target workspace
  and are screened out of payload walks and ownership.
