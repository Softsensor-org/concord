# Installer behavior and risk boundary

Concord's npm, standalone SEA, and `init.sh` entry points use the same versioned
plan/apply transaction (`concord.install/v1`). Installation is intentionally a
two-step operation:

1. Run with `--dry-run` (or without `--apply-plan` on the npm path) to produce a
   write-free plan and SHA-256 digest.
2. Review that plan and rerun with `--apply-plan <digest>`. Any target or plan
   drift causes a refusal before the affected file is replaced.

The plan lists every payload file as `add`, `identical`, `managed-update`, or
`collision`. A collision is an existing file not proven to be owned by an
earlier Concord install and is never overwritten. Managed updates are accepted
only when the target bytes still match the prior ownership manifest.

Configured product repositories are opaque protected roots. The installer does
not traverse them for payload planning, stage them, or run Git mutations in
them. When product repository paths are supplied, their HEAD and porcelain
status are compared before and after apply. Secret files are not installation
inputs; plans declare an empty secret-read and network manifest.

Apply holds an exclusive local lock, writes through same-directory temporary
files, and records backups before replacement. On failure it restores replaced
bytes and removes installer-created files. The machine receipt records relative
paths, content digests, rollback actions, artifact identity, and verification;
it excludes file contents, credential paths, environment values, and raw command
output.

The installer never initializes Git or creates a baseline commit. Those are
separate operator decisions after installation; no installer path runs
`git add .`, changes a product repository HEAD, or pushes to a remote.

These controls reduce installation risk for the tested artifact and local
environment. They are technical behavior, not a warranty, certification,
security guarantee, or promise that the host operating system or third-party
agent provider enforces controls outside Concord's observable execution path.

## Managed upgrade behavior

`coord upgrade` uses a separate managed-engine transaction after installation:

1. It acquires one target-local lock before release resolution or planning and
   holds it through surface verification, both pins, and receipt publication.
   A live same-host holder and any foreign-host holder are refused. A dead
   same-host holder can be recovered, with the prior holder and decision written
   to a mode-0600 receipt.
2. Automatic plan digests bind the immutable source identity, every managed
   target hash, and the raw upstream-pin identity. Apply revalidates that state
   immediately before its first managed mutation. A developer edit or pin
   change requires a new plan.
3. Before mutation, Concord persists exact bytes, existence, and supported mode
   bits for the managed paths, `engine-pin.json`, `.coord-engine.json`, and the
   success receipt. Writes use same-directory temporary files, file sync, and
   replacement; directory sync is best-effort where the platform supports it.
4. On POSIX, source permission modes are copied and independently verified,
   including mode-only changes. Windows does not enforce POSIX executable bits;
   it preserves the existing mode for updated files and uses a non-executable
   default for additions.
5. An exact-match file retired from the new source manifest is removed only when
   its current bytes match the checksum in the old target manifest. A changed
   retired file is reported as a conflict and is not removed. Board, project
   configuration, and product files are outside this removal rule.
6. A normal failure attempts every restore and records `rolled-back`. If any
   restore cannot complete, backups and a journal remain with
   `incomplete-recovery` evidence for operator action. A killed process is
   detected on the next upgrade; `--check` reports the pending transaction but
   does not mutate it.

Operational lock, transaction, and receipt files live under `coord/.runtime`.
They contain relative paths, digests, state transitions, and sanitized errors,
not entitlement tokens or managed file contents in receipts. Recovery backups
necessarily contain the pre-upgrade bytes and are removed after successful
commit or complete rollback; local filesystem access controls remain the host
operator's responsibility.

These behaviors reduce lost-update and partial-upgrade risk; they do not make
the host risk-free, sandbox an agent, guarantee power-loss semantics on every
filesystem, or replace repository review and operating-system security.
