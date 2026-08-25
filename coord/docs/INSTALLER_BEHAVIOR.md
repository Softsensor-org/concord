# Installer behavior and risk boundary

Concord has two transactional installation entry points: the npm
`create-concord` package and the standalone SEA binary. Both use the same
versioned plan/apply transaction (`concord.install/v1`). The donor checkout's
`init.sh` is retired, performs no writes, and is removed from release cuts; it is
not an installation channel. Installation is intentionally a two-step operation:

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

The installer never initializes Git or creates a baseline commit by default.

Git ownership is per directory (ADR-0008). The **workspace container is never a
Git repository** — not by default and not with consent; requesting container
initialization by name (`--git-scope workspace`) is refused, naming the reason,
before anything is written. **Product repositories are independent siblings**
the installer never initializes. The only directory any bootstrap consent can
reach is the optional independent control-plane repository at
`<workspace>/coord`, and every Git subprocess is pinned to it with
`git -C <workspace>/coord`.

That confinement is enforced with the same two layers COORD-624 established for
product repositories: an in-process `fs` write barrier over `<workspace>/.git`
that fails closed on any write (including a transient one), plus a
`.git`-presence / HEAD / branch / refs / index / config witness sampled after
every install phase and around the git bootstrap — because `git init` is a
spawned process an in-process hook structurally cannot observe, and a
final-state comparison alone cannot distinguish "never touched" from "touched
and put back". The container's absence of Git state is asserted positively
after install, upgrade, recovery and removal, and recorded in the receipt.

Control-plane Git bootstrap (COORD-477, retargeted by COORD-631) is a set of
four separately named, separately consented actions, each previewed in the
plan's `git_actions` section before any mutation so one consent can never imply
another:

- `--git-init` — run `git init` in `coord/` when it is outside Git. This
  creates an unborn repository and nothing else; no commit is made without the
  separate commit consent. A `coord/` inside an unrelated ancestor repository
  is refused before anything is written (`--git-allow-nested-root` is the
  explicit override for a deliberately nested control-plane repository; an
  existing container repository is never adopted, relocated or removed —
  migration is an explicit, reviewed, human action).
- `--git-ignore-block` — write a managed, sentinel-delimited block into
  `coord/.gitignore` recording the sibling product repositories observed at
  install time and ignoring common secret-file patterns. Siblings are recorded
  as evidence rather than as ignore patterns, because they are outside this
  repository and no rule is what keeps them out. This block is defense in depth
  for `git status` readability only; it is never the safety boundary.
- `--git-stage` — stage exactly the manifest-derived file allowlist listed in
  the plan, translated to coord-relative paths (`git add -- <path>...`). No
  installer path ever runs `git add .`, `git add -A`, or any other recursive
  staging shortcut. Workspace container assets (`.claude/`, `AGENTS.md`,
  `package.json`, the root `.gitignore`) are outside `coord/`, so they are
  excluded by construction and listed in the plan as
  `stage.excluded_workspace_assets`.
- `--git-baseline-commit` — create the initial baseline commit (requires the
  separate `--git-stage` consent). Commits run with `--no-verify
  --no-gpg-sign`; Git identity, credential helpers, remotes, hooks, and
  product-repository configuration are never read into the plan or modified. A
  failed commit (for example, missing identity) never rolls back the installed
  files — it leaves the reviewable `bootstrap-pending` state that
  `coord/scripts/gov doctor` explains with exact next steps, and strict
  journal/derived-artifact diagnostics resume automatically after the first
  committed baseline.

No installer path changes a product repository HEAD or pushes to a remote;
protected product repositories are re-verified (HEAD, branch, refs, dirty-state
fingerprint and a metadata-only tree inventory) around the git bootstrap phase
as well as around apply. The workspace container is re-verified the same way and
is asserted to remain a non-repository.

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
